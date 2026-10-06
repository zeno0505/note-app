import { describe, expect, it } from 'vitest';
import {
  createSnapshotStore, createOrcaSnapshotStore, DEFAULT_REFRESH_INTERVAL_MS,
  type SnapshotClock, type SnapshotLoadResult, type SnapshotError,
} from '../../src/collector/snapshot';
import type { OrcaCoverage, OrcaObservation, OrcaResult } from '../../src/collector/orca';

const EPOCH = Date.parse('2026-10-02T12:00:00.000Z');
class TestClock implements SnapshotClock {
  time = EPOCH;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  async advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const entry = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      this.time = entry[1].at;
      this.timers.delete(entry[0]);
      entry[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
  iso() { return new Date(this.time).toISOString(); }
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Value = { records: { id: string; lastOutputAt: number | null }[] };
type Coverage = { state: 'complete' | 'partial' | 'unknown'; totalCount: number | null; omittedHostIds: string[] | null };
type Result = SnapshotLoadResult<Value, Coverage, SnapshotError>;
function success(clock: TestClock, patch: Partial<Extract<Result, { kind: 'success' }>> = {}): Result {
  return {
    kind: 'success', runtimeId: 'runtime-one', observedAt: clock.iso(), sourceHash: 'sha256:first',
    value: { records: [{ id: 'same-instance', lastOutputAt: EPOCH - 999_999 }] },
    coverage: { state: 'complete', totalCount: 1, omittedHostIds: [] }, ...patch,
  };
}
const failure: Result = { kind: 'failure', error: { kind: 'unavailable', message: 'Synthetic collector unavailable.' } };
function setup(extra: Partial<Parameters<typeof createSnapshotStore<Value, Coverage, SnapshotError>>[0]> = {}) {
  const clock = new TestClock();
  const calls: { at: number; reason: string; signal: AbortSignal }[] = [];
  const store = createSnapshotStore<Value, Coverage, SnapshotError>({
    clock, load: async context => { calls.push({ at: clock.now(), ...context }); return success(clock); }, ...extra,
  });
  return { clock, calls, store };
}

describe('opt-in read-only background and foreground-return schedule', () => {
  const policy = {backgroundIntervalMs: 300_000, resumeDelayMs: 5_000};
  it('starts while background, polls at five minutes, and emits a main-owned five-second countdown', async () => {
    const x=setup({...policy,active:false}); await x.store.start(); expect(x.calls).toHaveLength(1);
    expect(x.store.getState().nextPollAt).toBe(new Date(EPOCH+300_000).toISOString());
    await x.clock.advance(299_999);expect(x.calls).toHaveLength(1);await x.clock.advance(1);expect(x.calls).toHaveLength(2);
    const counts:number[]=[];x.store.subscribe(s=>counts.push(s.resumeCountdownSeconds));x.store.setActivity({active:true});
    await x.clock.advance(4999);expect(x.calls).toHaveLength(2);expect(counts.slice(0,5)).toEqual([5,4,3,2,1]);
    await x.clock.advance(1);expect(x.calls.map(c=>c.reason)).toEqual(['initial','poll','resume']);
    expect(x.store.getState().nextPollAt).toBe(new Date(x.clock.now()+20_000).toISOString());
    x.store.dispose();expect(x.clock.timers.size).toBe(0);
  });
  it('clears a return countdown on blur/hide and does not accumulate repeated focus events', async () => {
    const x=setup(policy);await x.store.start();x.store.setActivity({active:false});x.store.setActivity({active:true});
    await x.clock.advance(2000);const due=x.store.getState().nextPollAt;x.store.setActivity({active:true,visible:true});expect(x.store.getState().nextPollAt).toBe(due);
    x.store.setActivity({visible:false});expect(x.store.getState().resumeCountdownSeconds).toBe(0);
    await x.clock.advance(5000);expect(x.calls).toHaveLength(1);
    x.store.setActivity({visible:true});await x.clock.advance(5000);expect(x.calls).toHaveLength(2);
    x.store.dispose();expect(x.clock.timers.size).toBe(0);
  });
  it('manual refresh immediately replaces countdown and cannot leave a delayed duplicate', async () => {
    const x=setup(policy);await x.store.start();x.store.setActivity({active:false});x.store.setActivity({active:true});await x.clock.advance(2000);
    await x.store.refresh();expect(x.calls.map(c=>c.reason)).toEqual(['initial','manual']);expect(x.store.getState().resumeCountdownSeconds).toBe(0);
    await x.clock.advance(5000);expect(x.calls).toHaveLength(2);await x.clock.advance(15000);expect(x.calls).toHaveLength(3);
  });
  it('does not abort a read on blur; manual/resume/poll join one pending flight', async () => {
    const clock=new TestClock(),pending=deferred<Result>();let count=0;let signal!:AbortSignal;
    const store=createSnapshotStore<Value,Coverage,SnapshotError>({...policy,clock,load:async context=>{count++;signal=context.signal;return pending.promise;}});
    const first=store.start();store.setActivity({active:false});expect(signal.aborted).toBe(false);
    store.setActivity({active:true});await clock.advance(5000);expect(count).toBe(1);
    const manual=store.refresh(),repeat=store.refresh();expect(manual).toBe(first);expect(repeat).toBe(first);
    pending.resolve(success(clock));await first;expect(count).toBe(1);expect(store.getState().nextPollAt).toBe(new Date(clock.now()+20_000).toISOString());
    store.dispose();expect(clock.timers.size).toBe(0);
  });
  it('retains return countdown when an earlier flight finishes before its deadline', async () => {
    const clock=new TestClock(),pending=deferred<Result>();let count=0;
    const store=createSnapshotStore<Value,Coverage,SnapshotError>({...policy,clock,load:async()=>++count===1?pending.promise:success(clock)});
    const first=store.start();store.setActivity({active:false});store.setActivity({active:true});await clock.advance(2000);
    pending.resolve(success(clock));await first;expect(store.getState().resumeCountdownSeconds).toBe(3);
    await clock.advance(3000);expect(count).toBe(2);expect(store.getState().lastAttempt?.reason).toBe('resume');
  });
  it('keeps last-good data and the next scheduled retry after failure in background', async () => {
    const clock=new TestClock();let count=0;
    const store=createSnapshotStore<Value,Coverage,SnapshotError>({...policy,clock,load:async()=>++count===1?success(clock):failure});
    await store.start();const before=store.getState();store.setActivity({active:false});await clock.advance(300_000);
    expect(store.getState()).toMatchObject({value:before.value,observedAt:before.observedAt,freshness:'stale',
      lastAttempt:{outcome:'error'},nextPollAt:new Date(clock.now()+300_000).toISOString()});
    store.dispose();expect(clock.timers.size).toBe(0);
  });
  it('stops/disposes countdown and rejects late collection after disconnect, including reconnect', async () => {
    const clock=new TestClock(),pending=deferred<Result>();let count=0;let signal!:AbortSignal;
    const store=createSnapshotStore<Value,Coverage,SnapshotError>({...policy,clock,load:async context=>{count++;signal=context.signal;return count===1?pending.promise:success(clock,{runtimeId:'new-runtime'});}});
    const old=store.start();store.setActivity({active:false});store.setActivity({active:true});store.stop();expect(signal.aborted).toBe(true);
    expect(store.getState()).toMatchObject({started:false,nextPollAt:null,resumeCountdownSeconds:0});expect(clock.timers.size).toBe(0);
    const next=store.start();pending.resolve(success(clock,{runtimeId:'old-runtime'}));await old;await next;
    expect(store.getState().runtimeId).toBe('new-runtime');expect(count).toBe(2);
    store.dispose();await clock.advance(3_600_000);expect(count).toBe(2);expect(clock.timers.size).toBe(0);
  });
  it('after sleep runs one overdue poll and schedules from completion, without catch-up bursts', async () => {
    const x=setup({...policy,active:false});await x.store.start();x.clock.time+=3_600_000;
    // Resume the event loop at the new wall time, rather than simulating an hour of awake ticks.
    const overdue=[...x.clock.timers].filter(([,t])=>t.at<=x.clock.now());for(const [id] of overdue)x.clock.timers.delete(id);
    for(const [,t] of overdue)t.callback();await flush();expect(x.calls).toHaveLength(2);
    expect(x.store.getState().nextPollAt).toBe(new Date(x.clock.now()+300_000).toISOString());
    await x.clock.advance(299_999);expect(x.calls).toHaveLength(2);x.store.dispose();
  });
  it('merges manual refresh with a pending periodic poll and cancels countdown immediately in the view', async () => {
    const clock=new TestClock(),pending=deferred<Result>();let count=0;
    const store=createSnapshotStore<Value,Coverage,SnapshotError>({...policy,clock,load:async()=>++count===1?success(clock):pending.promise});
    await store.start();await clock.advance(20_000);expect(count).toBe(2);
    store.setActivity({active:false});store.setActivity({active:true});const published:number[]=[];store.subscribe(s=>published.push(s.resumeCountdownSeconds));
    const manual=store.refresh(),repeat=store.refresh();expect(manual).toBe(repeat);expect(count).toBe(2);expect(published).toEqual([0]);
    pending.resolve(success(clock));await manual;await clock.advance(5000);expect(count).toBe(2);store.dispose();
  });
  it('does not leak a countdown tick if a state consumer disconnects during its callback', async () => {
    const x=setup(policy);await x.store.start();x.store.setActivity({active:false});x.store.setActivity({active:true});
    x.store.subscribe(s=>{if(s.resumeCountdownSeconds===4)x.store.stop();});await x.clock.advance(1000);
    expect(x.clock.timers.size).toBe(0);await x.clock.advance(600_000);expect(x.calls).toHaveLength(1);
  });
});

describe('snapshot polling and lifetime', () => {
  it('does not collect or allocate a timer merely on construction', () => {
    const { store, calls, clock } = setup();
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(20_000);
    expect(calls).toEqual([]);
    expect(clock.timers.size).toBe(0);
    expect(store.getState()).toMatchObject({ status: 'unknown', value: null, coverage: null, freshness: 'unknown', lastAttempt: null, lastSuccessAt: null });
  });
  it('starts once immediately and polls at exactly 20 seconds after each settled attempt', async () => {
    const { store, calls, clock } = setup();
    await store.start(); await store.start();
    expect(calls.map(call => call.at - EPOCH)).toEqual([0]);
    expect(store.getState().nextPollAt).toBe(new Date(EPOCH + 20_000).toISOString());
    await clock.advance(19_999);
    expect(calls).toHaveLength(1);
    await clock.advance(1); await clock.advance(20_000);
    expect(calls.map(call => call.at - EPOCH)).toEqual([0, 20_000, 40_000]);
    expect(calls.map(call => call.reason)).toEqual(['initial', 'poll', 'poll']);
    store.dispose();
  });
  it.each([15_000, 30_000])('accepts the exact supported %i ms interval', async intervalMs => {
    const { store, calls, clock } = setup({ intervalMs });
    await store.start(); await clock.advance(intervalMs - 1);
    expect(calls).toHaveLength(1);
    await clock.advance(1); expect(calls).toHaveLength(2); store.dispose();
  });
  it.each([0, -1, 14_999, 30_001, 20_000.5, NaN, Infinity])('rejects unsupported interval %s', intervalMs => {
    expect(() => setup({ intervalMs })).toThrow(RangeError);
  });
  it.each([0, -1, 0.5, 2_147_483_648, NaN, Infinity])('rejects invalid stale threshold %s', staleAfterMs => {
    expect(() => setup({ staleAfterMs })).toThrow(RangeError);
  });
  it.each(['visible', 'active'] as const)('pauses %s=false with zero timers and resumes immediately', async field => {
    const { store, calls, clock } = setup();
    await store.start(); await clock.advance(5_000);
    store.setActivity({ [field]: false });
    expect(clock.timers.size).toBe(0);
    await clock.advance(65_000);
    expect(calls).toHaveLength(1);
    expect(store.getState().freshness).toBe('stale');
    store.setActivity({ [field]: true }); await flush();
    expect(calls.map(call => call.at - EPOCH)).toEqual([0, 70_000]);
    expect(calls[1].reason).toBe('resume');
    expect(store.getState()).toMatchObject({ freshness: 'current', observedAt: clock.iso(), lastSuccessAt: clock.iso() });
    await clock.advance(20_000); expect(calls).toHaveLength(3); store.dispose();
  });
  it('requires both activity flags, supports initially hidden start, and ignores redundant resume', async () => {
    const { store, clock, calls } = setup({ visible: false, active: false });
    await store.start(); expect(calls).toHaveLength(0);
    store.setActivity({ visible: true }); await clock.advance(30_000); expect(calls).toHaveLength(0);
    store.setActivity({ active: true }); await flush(); expect(calls).toHaveLength(1);
    store.setActivity({ active: true, visible: true }); await flush(); expect(calls).toHaveLength(1);
    store.dispose();
  });
  it('allows an explicit manual refresh while hidden without creating a polling timer', async () => {
    const { store, clock, calls } = setup({ visible: false });
    await store.refresh(); await clock.advance(60_000);
    expect(calls.map(call => call.reason)).toEqual(['manual']);
    expect(clock.timers.size).toBe(0); store.dispose();
  });
  it('coalesces rapid manual clicks with an active poll and does not run overlapping loaders', async () => {
    const clock = new TestClock();
    const pending = deferred<Result>();
    let loads = 0;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => ++loads === 1 ? success(clock) : pending.promise });
    await store.start(); await clock.advance(20_000);
    const first = store.refresh();
    for (let i = 0; i < 20; i++) expect(store.refresh()).toBe(first);
    await clock.advance(100_000);
    expect(loads).toBe(2); expect(clock.timers.size).toBe(0);
    pending.resolve(success(clock)); await first;
    expect(store.getState().nextPollAt).toBe(new Date(clock.now() + 20_000).toISOString());
    expect(store.getState().lastAttempt?.reason).toBe('poll'); store.dispose();
  });
  it('a manual refresh just before a poll resets its deadline without duplicate loading', async () => {
    const { store, calls, clock } = setup();
    await store.start(); await clock.advance(19_999); await store.refresh();
    await clock.advance(1); expect(calls).toHaveLength(2);
    await clock.advance(19_999); expect(calls).toHaveLength(3); store.dispose();
  });
  it('waits for cancelled loader settlement on rapid hide/resume and discards its late success', async () => {
    const clock = new TestClock();
    const old = deferred<Result>();
    const resumed = deferred<Result>();
    const signals: AbortSignal[] = [];
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: ({ signal }) => {
      signals.push(signal); return signals.length === 1 ? old.promise : resumed.promise;
    } });
    const first = store.start();
    store.setActivity({ visible: false }); expect(signals[0].aborted).toBe(true);
    store.setActivity({ visible: true }); store.setActivity({ visible: true });
    const manual = store.refresh(); expect(store.refresh()).toBe(manual);
    await clock.advance(90_000); expect(signals).toHaveLength(1);
    old.resolve(success(clock, { runtimeId: 'cancelled-runtime' })); await first; await flush();
    expect(signals).toHaveLength(2); expect(store.getState().status).toBe('unknown');
    resumed.resolve(success(clock, { runtimeId: 'resumed-runtime' })); await manual;
    expect(store.getState().runtimeId).toBe('resumed-runtime');
    expect(store.getState().revision).toBe(1); store.dispose();
  });
  it('clears a queued resume when hidden again before cancellation settles', async () => {
    const clock = new TestClock(); const pending = deferred<Result>(); let loads = 0;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => { loads++; return pending.promise; } });
    const start = store.start(); store.setActivity({ visible: false }); store.setActivity({ visible: true }); store.setActivity({ visible: false });
    pending.resolve(success(clock)); await start; await clock.advance(60_000);
    expect(loads).toBe(1); expect(store.getState().status).toBe('unknown'); expect(clock.timers.size).toBe(0); store.dispose();
  });
  it('cancel preserves success, reports cancellation, and schedules only a future poll', async () => {
    const clock = new TestClock(); const pending = deferred<Result>(); let calls = 0; let signal!: AbortSignal;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async context => {
      signal = context.signal; return ++calls === 1 ? success(clock) : pending.promise;
    } });
    await store.start(); const refresh = store.refresh(); store.cancel();
    expect(signal.aborted).toBe(true); expect(store.getState()).toMatchObject({ status: 'observed', freshness: 'stale', lastAttempt: { outcome: 'cancelled' } });
    pending.resolve(success(clock, { runtimeId: 'ignored' })); await refresh;
    expect(calls).toBe(2); expect(store.getState().runtimeId).toBe('runtime-one'); expect(clock.timers.size).toBe(1); store.dispose();
  });
  it('dispose aborts, removes timers/subscribers, and ignores success arriving after disposal', async () => {
    const clock = new TestClock(); const pending = deferred<Result>(); let signal!: AbortSignal; let events = 0;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: context => { signal = context.signal; return pending.promise; } });
    store.subscribe(() => events++); const starting = store.start(); store.dispose();
    const terminalState = store.getState(); const terminalEvents = events;
    expect(signal.aborted).toBe(true); expect(terminalState).toMatchObject({ disposed: true, refreshing: false, freshness: 'unknown' });
    pending.resolve(success(clock)); await starting; await clock.advance(60_000);
    await store.refresh(); await store.start(); store.setActivity({ visible: true }); store.cancel(); store.dispose();
    expect(store.getState()).toEqual(terminalState); expect(events).toBe(terminalEvents); expect(clock.timers.size).toBe(0);
  });
  it('post-disposal start and refresh settle even while an ignored cancellation remains unresolved', async () => {
    const clock = new TestClock(); const pending = deferred<Result>();
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: () => pending.promise });
    const starting = store.start(); store.dispose(); let starts = 0;
    void store.start().then(() => starts++); void store.refresh().then(() => starts++);
    await flush(); expect(starts).toBe(2);
    pending.resolve(success(clock)); await starting;
  });
  it('notifies subscribers exactly at freshness expiry while a poll remains unresolved', async () => {
    const clock = new TestClock(); const pending = deferred<Result>(); let calls = 0;
    const events: { at: number; freshness: string; refreshing: boolean }[] = [];
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => ++calls === 1 ? success(clock) : pending.promise });
    store.subscribe(state => events.push({ at: clock.now(), freshness: state.freshness, refreshing: state.refreshing }));
    await store.start(); await clock.advance(20_000);
    expect(events.at(-1)).toEqual({ at: EPOCH + 20_000, freshness: 'current', refreshing: true });
    expect(clock.timers.size).toBe(1); // Only freshness expiry; no overlap/catch-up polling.
    await clock.advance(19_999); const beforeExpiry = events.length;
    await clock.advance(1);
    expect(events).toHaveLength(beforeExpiry + 1);
    expect(events.at(-1)).toEqual({ at: EPOCH + 40_000, freshness: 'stale', refreshing: true });
    expect(clock.timers.size).toBe(0);
    await clock.advance(120_000); expect(events).toHaveLength(beforeExpiry + 1); expect(calls).toBe(2);
    store.dispose(); pending.resolve(success(clock)); await flush();
  });
  it('reschedules freshness expiry for a newer success without notifying at the old deadline', async () => {
    const clock = new TestClock(); const pending = deferred<Result>(); let calls = 0;
    const staleEvents: number[] = [];
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => ++calls <= 2 ? success(clock) : pending.promise });
    store.subscribe(state => { if (state.freshness === 'stale') staleEvents.push(clock.now()); });
    await store.start(); await clock.advance(20_000); // New observation extends expiry to60s.
    expect(clock.timers.size).toBe(2);
    await clock.advance(20_000); expect(staleEvents).toEqual([]); expect(calls).toBe(3);
    await clock.advance(19_999); expect(staleEvents).toEqual([]);
    await clock.advance(1); expect(staleEvents).toEqual([EPOCH + 60_000]);
    store.dispose(); pending.resolve(success(clock)); await flush();
  });
  it.each(['visible', 'active'] as const)('clears freshness notifications while %s=false and refreshes on resume', async field => {
    const { store, calls, clock } = setup(); let events = 0;
    store.subscribe(() => events++); await store.start();
    expect(clock.timers.size).toBe(2); store.setActivity({ [field]: false });
    const pausedEvents = events; expect(clock.timers.size).toBe(0);
    await clock.advance(90_000); expect(events).toBe(pausedEvents); expect(calls).toHaveLength(1);
    store.setActivity({ [field]: true }); await flush();
    expect(store.getState().freshness).toBe('current'); expect(clock.timers.size).toBe(2);
    store.dispose(); const disposedEvents = events; await clock.advance(120_000);
    expect(events).toBe(disposedEvents); expect(clock.timers.size).toBe(0);
  });
  it('a freshness listener can dispose reentrantly without leaving an expiry timer', async () => {
    const clock = new TestClock(); const pending = deferred<Result>(); let calls = 0;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => ++calls === 1 ? success(clock) : pending.promise });
    store.subscribe(state => { if (state.freshness === 'stale') store.dispose(); });
    await store.start(); await clock.advance(40_000);
    expect(store.getState().disposed).toBe(true); expect(clock.timers.size).toBe(0);
    pending.resolve(success(clock)); await flush(); expect(clock.timers.size).toBe(0);
  });
  it('reflective activity subscribers and repeated setters are true no-ops', async () => {
    const { store, clock } = setup(); let events = 0;
    store.subscribe(state => { events++; store.setActivity({ visible: state.visible, active: state.active }); });
    await store.start(); const afterStart = events;
    store.setActivity({}); store.setActivity({ active: true, visible: true }); expect(events).toBe(afterStart);
    store.setActivity({ visible: false }); expect(events).toBe(afterStart + 1);
    for (let i = 0; i < 10; i++) store.setActivity({ visible: false });
    expect(events).toBe(afterStart + 1); expect(clock.timers.size).toBe(0); store.dispose();
  });
  it('repeated paused updates preserve an explicitly queued hidden manual refresh', async () => {
    const clock = new TestClock(); const pending = deferred<Result>(); let calls = 0;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => ++calls === 2 ? pending.promise : success(clock) });
    await store.start(); const originalRefresh = store.refresh(); store.setActivity({ visible: false });
    const hiddenManual = store.refresh(); let completed = false; void hiddenManual.then(() => { completed = true; });
    store.setActivity({ visible: false }); store.setActivity({ active: false }); store.setActivity({ active: false, visible: false });
    await flush(); expect(completed).toBe(false); expect(calls).toBe(2);
    pending.resolve(success(clock, { runtimeId: 'discarded-runtime' })); await originalRefresh; await hiddenManual;
    expect(calls).toBe(3); expect(store.getState()).toMatchObject({ visible: false, active: false, runtimeId: 'runtime-one', lastAttempt: { reason: 'manual', outcome: 'success' } });
    expect(clock.timers.size).toBe(0); store.dispose();
  });
  it('reentrant repeated cancellation is bounded and does not invoke an already cancelled loader', async () => {
    const { store, calls, clock } = setup(); let events = 0;
    store.subscribe(() => { events++; store.cancel(); });
    await store.start();
    expect(events).toBe(3); expect(calls).toHaveLength(0); expect(store.getState().lastAttempt?.outcome).toBe('cancelled');
    const afterCancellation = events; store.cancel(); store.cancel();
    expect(events).toBe(afterCancellation); expect(clock.timers.size).toBe(1); store.dispose();
  });
  it('a subscriber may dispose at attempt start without invoking the loader', async () => {
    const { store, calls, clock } = setup(); store.subscribe(() => store.dispose());
    await store.start(); expect(calls).toHaveLength(0); expect(clock.timers.size).toBe(0);
  });
});

describe('snapshot observations, retention and identity', () => {
  it('first failure remains unknown and cannot fabricate an empty observation', async () => {
    const { store } = setup({ load: async () => failure });
    await store.start();
    expect(store.getState()).toMatchObject({ status: 'unknown', value: null, coverage: null, observedAt: null, lastSuccessAt: null, freshness: 'unknown', lastAttempt: { outcome: 'error', error: { kind: 'unavailable' } } });
    store.dispose();
  });
  it('retains a genuinely observed empty result as stale after failure', async () => {
    const clock = new TestClock(); let fail = false;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => fail ? failure : success(clock, {
      value: { records: [] }, coverage: { state: 'complete', totalCount: 0, omittedHostIds: [] },
    }) });
    await store.start(); const original = store.getState(); fail = true;
    await clock.advance(5_000); await store.refresh();
    expect(store.getState()).toMatchObject({ status: 'observed', value: { records: [] }, coverage: { state: 'complete', totalCount: 0 }, freshness: 'stale', observedAt: original.observedAt, lastSuccessAt: original.lastSuccessAt });
    store.dispose();
  });
  it.each(['partial', 'unknown'] as const)('retains %s coverage without turning it into empty/complete on failure', async state => {
    const clock = new TestClock(); let failed = false;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => failed ? failure : success(clock, {
      coverage: { state, totalCount: null, omittedHostIds: state === 'partial' ? ['unobserved-host'] : null },
    }) });
    await store.start(); const original = store.getState(); failed = true;
    await clock.advance(7_000); await store.refresh(); const after = store.getState();
    expect(after.coverage).toEqual(original.coverage); expect(after.value).toEqual(original.value);
    expect(after.observedAt).toBe(original.observedAt); expect(after.lastSuccessAt).toBe(original.lastSuccessAt);
    expect(after.freshness).toBe('stale'); expect(after.lastAttempt?.attemptedAt).toBe(clock.iso()); store.dispose();
  });
  it('distinguishes attempt start, completion and successful source observation time', async () => {
    const clock = new TestClock(); const pending = deferred<Result>();
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: () => pending.promise });
    const starting = store.start(); const observation = success(clock);
    await clock.advance(4_000);
    expect(store.getState().lastAttempt).toMatchObject({ attemptedAt: new Date(EPOCH).toISOString(), completedAt: null, outcome: 'pending' });
    pending.resolve(observation); await starting;
    expect(store.getState()).toMatchObject({ observedAt: new Date(EPOCH).toISOString(), lastSuccessAt: clock.iso(), lastAttempt: { attemptedAt: new Date(EPOCH).toISOString(), completedAt: clock.iso(), outcome: 'success' } }); store.dispose();
  });
  it('keeps explicit source-stale success and ages current data without hidden timers', async () => {
    const clock = new TestClock(); let stale = true;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, visible: false, load: async () => success(clock, { freshness: stale ? 'stale' : 'current' }) });
    await store.refresh(); expect(store.getState().freshness).toBe('stale'); stale = false;
    await store.refresh(); await clock.advance(39_999); expect(store.getState().freshness).toBe('current');
    await clock.advance(1); expect(store.getState().freshness).toBe('stale'); expect(clock.timers.size).toBe(0); store.dispose();
  });
  it('replaces all identities on a successful runtime restart, including reused record IDs', async () => {
    const clock = new TestClock(); let restarted = false;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => success(clock, {
      runtimeId: restarted ? 'runtime-two' : 'runtime-one',
      value: { records: restarted ? [{ id: 'same-instance', lastOutputAt: null }] : [{ id: 'old-only', lastOutputAt: null }, { id: 'same-instance', lastOutputAt: EPOCH }] },
    }) });
    await store.start(); restarted = true; await clock.advance(2_000); await store.refresh();
    expect(store.getState()).toMatchObject({ runtimeId: 'runtime-two', value: { records: [{ id: 'same-instance', lastOutputAt: null }] }, revision: 2, runtimeChange: { previousRuntimeId: 'runtime-one', currentRuntimeId: 'runtime-two', observedAt: clock.iso() } }); store.dispose();
  });
  it('keeps runtime_changed as an explicit error without replacing or merging old data', async () => {
    const clock = new TestClock(); let restarted = false;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => restarted
      ? { kind: 'failure', error: { kind: 'runtime_changed', message: 'Runtime changed during collection.' } } : success(clock) });
    await store.start(); const original = store.getState(); restarted = true; await store.refresh();
    expect(store.getState()).toMatchObject({ runtimeId: 'runtime-one', runtimeChange: null, value: original.value, revision: 1, freshness: 'stale', lastAttempt: { outcome: 'error', error: { kind: 'runtime_changed' } } }); store.dispose();
  });
  it('unchanged requires the cached hash/runtime and updates coverage/time without a value revision', async () => {
    const clock = new TestClock(); let unchanged = false;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => unchanged ? {
      kind: 'unchanged', runtimeId: 'runtime-one', sourceHash: 'sha256:first', observedAt: clock.iso(),
      coverage: { state: 'partial', totalCount: null, omittedHostIds: ['host-two'] },
    } : success(clock) });
    await store.start(); const original = store.getState(); unchanged = true; await clock.advance(6_000); await store.refresh();
    expect(store.getState()).toMatchObject({ value: original.value, revision: 1, observedAt: clock.iso(), lastSuccessAt: clock.iso(), coverage: { state: 'partial', totalCount: null }, lastAttempt: { outcome: 'unchanged' } }); store.dispose();
  });
  it.each(['no-cache', 'changed-hash', 'changed-runtime'] as const)('rejects invalid unchanged assertion: %s', async scenario => {
    const clock = new TestClock(); let unchanged = scenario === 'no-cache';
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => unchanged ? {
      kind: 'unchanged', runtimeId: scenario === 'changed-runtime' ? 'runtime-two' : 'runtime-one',
      sourceHash: scenario === 'changed-hash' ? 'sha256:other' : 'sha256:first', observedAt: clock.iso(),
      coverage: { state: 'complete', totalCount: 0, omittedHostIds: [] },
    } : success(clock) });
    await store.start(); unchanged = true; await store.refresh();
    expect(store.getState().lastAttempt).toMatchObject({ outcome: 'error', error: { kind: 'invalid_result' } });
    expect(store.getState().revision).toBe(scenario === 'no-cache' ? 0 : 1); store.dispose();
  });
  it('does not interpret lastOutputAt as heartbeat or reset it to refresh time', async () => {
    const { store, clock } = setup(); await store.start(); await clock.advance(20_000);
    expect(store.getState().value?.records[0].lastOutputAt).toBe(EPOCH - 999_999);
    expect(JSON.stringify(store.getState())).not.toContain('heartbeat'); store.dispose();
  });
  it('detaches loader input, every state read and every subscriber result', async () => {
    const clock = new TestClock(); const input = success(clock) as Extract<Result, { kind: 'success' }>;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => input });
    store.subscribe(state => { if (state.value) (state.value as Value).records[0].id = 'listener-mutation'; });
    let later = '';
    store.subscribe(state => { if (state.value) later = state.value.records[0].id; });
    await store.start(); input.value.records[0].id = 'loader-mutation';
    const state = store.getState(); (state.value as Value).records[0].id = 'consumer-mutation';
    (state.coverage as Coverage).omittedHostIds?.push('mutation');
    expect(later).toBe('same-instance'); expect(store.getState().value?.records[0].id).toBe('same-instance');
    expect(store.getState().coverage?.omittedHostIds).toEqual([]);
    expect(Object.getPrototypeOf(state)).toBe(Object.prototype); expect(Object.isFrozen(state)).toBe(false);
    expect(() => JSON.stringify(state)).not.toThrow(); store.dispose();
  });
  it('isolates throwing subscribers and supports unsubscribe', async () => {
    const { store, clock, calls } = setup(); let events = 0;
    store.subscribe(() => { throw new Error('Synthetic view failure'); }); const unsubscribe = store.subscribe(() => events++);
    await store.start(); expect(events).toBeGreaterThan(0); const prior = events; unsubscribe();
    await clock.advance(20_000); expect(calls).toHaveLength(2); expect(events).toBe(prior); store.dispose();
  });
  it('sanitizes unexpected rejection without exposing private thrown content', async () => {
    const { store } = setup({ load: async () => { throw new Error('PRIVATE_SYNTHETIC_CANARY'); } });
    await store.start(); expect(store.getState().lastAttempt).toMatchObject({ outcome: 'error', error: { kind: 'load_failed' } });
    expect(JSON.stringify(store.getState())).not.toContain('PRIVATE_SYNTHETIC_CANARY'); store.dispose();
  });
  it.each(['future', 'invalid-time', 'noncanonical-time', 'missing-runtime', 'nonplain', 'cycle', 'undefined-value'] as const)('rejects %s result without replacing retained data', async scenario => {
    const clock = new TestClock(); let invalid = false;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => {
      const result = success(clock) as Extract<Result, { kind: 'success' }>;
      if (!invalid) return result;
      if (scenario === 'future') result.observedAt = new Date(clock.now() + 1).toISOString();
      if (scenario === 'invalid-time') result.observedAt = 'not a time';
      if (scenario === 'noncanonical-time') result.observedAt = '2026-10-02';
      if (scenario === 'missing-runtime') result.runtimeId = '';
      if (scenario === 'nonplain') result.value = new Map() as never;
      if (scenario === 'cycle') (result.value as unknown as { cyclic: unknown }).cyclic = result.value;
      if (scenario === 'undefined-value') result.value = undefined as never;
      return result;
    } });
    await store.start(); invalid = true; await store.refresh();
    expect(store.getState()).toMatchObject({ revision: 1, freshness: 'stale', lastAttempt: { error: { kind: 'invalid_result' } } }); store.dispose();
  });
  it('rejects backwards source time in the same runtime', async () => {
    const clock = new TestClock(); let older = false;
    const store = createSnapshotStore<Value, Coverage, SnapshotError>({ clock, load: async () => success(clock, { observedAt: new Date(older ? EPOCH - 1 : EPOCH).toISOString() }) });
    await store.start(); older = true; await store.refresh();
    expect(store.getState()).toMatchObject({ revision: 1, observedAt: new Date(EPOCH).toISOString(), lastAttempt: { error: { kind: 'invalid_result' } } }); store.dispose();
  });
});

function orcaObservation(clock: TestClock): OrcaObservation {
  const complete: OrcaCoverage = { state: 'complete', returnedCount: 0, totalCount: 0, truncated: false, hostIds: [], omittedHostIds: [] };
  return {
    runtimeId: 'orca-one', observedAt: clock.iso(),
    status: { appRunning: true, runtimeReachable: true, runtimeState: 'ready', connectionState: 'connected', graphState: 'ready' },
    projects: { records: [], coverage: { ...complete, state: 'unknown', totalCount: null, truncated: null, hostIds: null, omittedHostIds: null } },
    worktrees: { records: [], coverage: complete }, processes: { records: [], coverage: complete },
    joined: [], unmatchedProcesses: [], complete: false,
  };
}
describe('Orca adapter snapshot boundary', () => {
  it('preserves unknown project completeness and passes AbortSignal through unchanged', async () => {
    const clock = new TestClock(); let signal: AbortSignal | undefined;
    const observation = orcaObservation(clock);
    const store = createOrcaSnapshotStore({ clock, load: async options => { signal = options.signal; return { ok: true, value: observation }; } });
    await store.start(); expect(signal).toBeInstanceOf(AbortSignal);
    expect(store.getState()).toMatchObject({ status: 'observed', sourceHash: null, coverage: { state: 'unknown', complete: false, projects: { state: 'unknown', totalCount: null }, worktrees: { state: 'complete', totalCount: 0 } }, value: observation }); store.dispose();
  });
  it('preserves partial host metadata, then retains all scopes on a query failure', async () => {
    const clock = new TestClock(); const observation = orcaObservation(clock); let fail = false;
    observation.worktrees.coverage = { state: 'partial', returnedCount: 0, totalCount: null, truncated: true, hostIds: ['observed-host'], omittedHostIds: ['omitted-host'] };
    const store = createOrcaSnapshotStore({ clock, load: async (): Promise<OrcaResult<OrcaObservation>> => fail ? {
      ok: false, error: { kind: 'runtime_changed', message: 'Runtime changed during collection.', query: 'processes', runtimeId: null },
    } : { ok: true, value: observation } });
    await store.start(); const initial = store.getState(); fail = true; await clock.advance(2_000); await store.refresh();
    expect(store.getState()).toMatchObject({ value: initial.value, coverage: initial.coverage, lastSuccessAt: initial.lastSuccessAt, freshness: 'stale', lastAttempt: { error: { kind: 'runtime_changed', query: 'processes', runtimeId: null } } });
    expect(store.getState().coverage).toMatchObject({ state: 'partial', projects: { state: 'unknown' }, worktrees: { truncated: true, omittedHostIds: ['omitted-host'] } }); store.dispose();
  });
});
