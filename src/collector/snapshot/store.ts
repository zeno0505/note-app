import type {
  RefreshReason, SnapshotAttempt, SnapshotClock, SnapshotError,
  SnapshotLoadResult, SnapshotState, SnapshotStore, SnapshotStoreError, SnapshotStoreOptions,
} from './types';

export const DEFAULT_REFRESH_INTERVAL_MS = 20_000;
export const MIN_REFRESH_INTERVAL_MS = 15_000;
export const MAX_REFRESH_INTERVAL_MS = 30_000;
const systemClock: SnapshotClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const errors: Record<SnapshotStoreError['kind'], SnapshotStoreError> = {
  load_failed: { kind: 'load_failed', message: 'The observation loader failed.' },
  invalid_result: { kind: 'invalid_result', message: 'The observation loader returned an invalid result.' },
  cancelled: { kind: 'cancelled', message: 'The observation was cancelled.' },
};
/** Require a serializable plain tree. No prototypes, functions, Maps or shared mutable input references. */
function copyPlain<T>(value: T): T {
  const seen = new Set<object>();
  function check(node: unknown): void {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number' && Number.isFinite(node)) return;
    if (typeof node !== 'object' || seen.has(node)) throw new Error('Invalid plain value.');
    const prototype = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && prototype !== Object.prototype && prototype !== null) throw new Error('Invalid plain value.');
    seen.add(node);
    for (const item of Object.values(node)) check(item);
    seen.delete(node);
  }
  check(value);
  return structuredClone(value);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * Trusted collector/main-process orchestration only. No Electron, renderer, filesystem, shell,
 * network, DAG parsing or hashing dependencies. Loader owns validation, bounds and termination.
 */
export function createSnapshotStore<T, C, E extends SnapshotError>(
  options: SnapshotStoreOptions<T, C, E>,
): SnapshotStore<T, C, E> {
  const clock = options.clock ?? systemClock;
  const intervalMs = options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_REFRESH_INTERVAL_MS || intervalMs > MAX_REFRESH_INTERVAL_MS) {
    throw new RangeError('Active refresh interval must be between 15000 and 30000 milliseconds.');
  }
  const staleAfterMs = options.staleAfterMs ?? intervalMs * 2;
  if (!Number.isInteger(staleAfterMs) || staleAfterMs <= 0 || staleAfterMs > 2_147_483_647) {
    throw new RangeError('Stale threshold must be a positive, supported timer interval.');
  }
  type State = SnapshotState<T, C, E>;
  type Pending = ReturnType<typeof deferred<State>> & { reason: RefreshReason };
  type Flight = Pending & { controller: AbortController; valid: boolean; attempt: SnapshotAttempt<E> };
  let started = false;
  let disposed = false;
  let active = options.active ?? true;
  let visible = options.visible ?? true;
  let timer: { handle: unknown; at: number } | null = null;
  let freshnessTimer: { handle: unknown; at: number } | null = null;
  let flight: Flight | null = null;
  let queued: Pending | null = null;
  let attemptId = 0;
  let lastAttempt: SnapshotAttempt<E> | null = null;
  let retained: {
    value: T; coverage: C; runtimeId: string; sourceHash: string | null;
    observedAt: string; lastSuccessAt: string; sourceStale: boolean;
  } | null = null;
  let failedSinceSuccess = false;
  let revision = 0;
  let runtimeChange: State['runtimeChange'] = null;
  const listeners = new Set<(state: State) => void>();
  const nowIso = () => new Date(clock.now()).toISOString();
  const enabled = () => started && active && visible && !disposed;
  const getState = (): State => {
    const stale = retained !== null && (failedSinceSuccess || retained.sourceStale || disposed
      || clock.now() - Date.parse(retained.observedAt) >= staleAfterMs);
    // Each read/listener gets detached plain objects, suitable for IPC/Vue without frozen prototypes.
    return copyPlain({
      status: retained === null ? 'unknown' : 'observed',
      value: retained?.value ?? null,
      coverage: retained?.coverage ?? null,
      runtimeId: retained?.runtimeId ?? null,
      sourceHash: retained?.sourceHash ?? null,
      observedAt: retained?.observedAt ?? null,
      lastSuccessAt: retained?.lastSuccessAt ?? null,
      lastAttempt,
      freshness: retained === null ? 'unknown' : stale ? 'stale' : 'current',
      revision, runtimeChange, started, active, visible,
      refreshing: flight !== null && !disposed,
      disposed,
      nextPollAt: timer === null ? null : new Date(timer.at).toISOString(),
    }) as State;
  };
  const syncFreshnessTimer = () => {
    const at = retained === null ? null : Date.parse(retained.observedAt) + staleAfterMs;
    const needsExpiry = enabled() && retained !== null && !retained.sourceStale && !failedSinceSuccess
      && at !== null && at > clock.now();
    if (freshnessTimer !== null && (!needsExpiry || freshnessTimer.at !== at)) {
      clock.clearTimeout(freshnessTimer.handle);
      freshnessTimer = null;
    }
    if (needsExpiry && freshnessTimer === null) {
      freshnessTimer = { at: at!, handle: clock.setTimeout(() => {
        freshnessTimer = null;
        // One age transition notification, independent of a slow/pending collection.
        // This never loads and is not rearmed once the retained observation is stale.
        if (enabled()) publish();
      }, at! - clock.now()) };
    }
  };
  const publish = () => {
    syncFreshnessTimer();
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      // A view callback must not break collection, timers, or delivery to other subscribers.
      try { listener(getState()); } catch { /* Consumer handles its own rendering errors. */ }
    }
  };
  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer.handle);
    timer = null;
  };
  const arm = () => {
    clearTimer();
    if (!enabled() || flight !== null) return;
    const at = clock.now() + intervalMs;
    timer = { at, handle: clock.setTimeout(() => {
      timer = null;
      if (enabled()) void request('poll');
    }, intervalMs) };
  };
  const finishError = (current: Flight, error: E | SnapshotStoreError) => {
    failedSinceSuccess = true;
    lastAttempt = { ...current.attempt, completedAt: nowIso(), outcome: 'error', error };
  };
  const accept = (current: Flight, result: SnapshotLoadResult<T, C, E>) => {
    if (result.kind === 'failure') {
      if (!result.error || typeof result.error.kind !== 'string' || typeof result.error.message !== 'string') throw new Error('Invalid failure.');
      finishError(current, copyPlain(result.error));
      return;
    }
    if ((result.kind !== 'success' && result.kind !== 'unchanged')
      || typeof result.runtimeId !== 'string' || result.runtimeId.length === 0
      || typeof result.observedAt !== 'string' || !Number.isFinite(Date.parse(result.observedAt))
      || new Date(result.observedAt).toISOString() !== result.observedAt
      || Date.parse(result.observedAt) > clock.now()
      || (result.freshness !== undefined && result.freshness !== 'current' && result.freshness !== 'stale')
      || (result.sourceHash != null && (typeof result.sourceHash !== 'string' || result.sourceHash.length === 0))) {
      throw new Error('Invalid observation metadata.');
    }
    // An old result within one runtime cannot freshen or replace a newer source observation.
    if (retained?.runtimeId === result.runtimeId && Date.parse(result.observedAt) < Date.parse(retained.observedAt)) {
      throw new Error('Observation time moved backwards.');
    }
    if (result.kind === 'unchanged' && (retained === null || typeof result.sourceHash !== 'string'
      || retained.sourceHash !== result.sourceHash || retained.runtimeId !== result.runtimeId)) {
      throw new Error('Unchanged observation does not identify the retained value.');
    }
    const value = result.kind === 'success' ? copyPlain(result.value) : retained!.value;
    const coverage = copyPlain(result.coverage);
    const completedAt = nowIso();
    const previousRuntimeId = retained?.runtimeId;
    if (previousRuntimeId && previousRuntimeId !== result.runtimeId) {
      runtimeChange = { previousRuntimeId, currentRuntimeId: result.runtimeId, observedAt: result.observedAt };
    }
    retained = {
      value, coverage, runtimeId: result.runtimeId, sourceHash: result.sourceHash ?? null,
      observedAt: result.observedAt, lastSuccessAt: completedAt, sourceStale: result.freshness === 'stale',
    };
    if (result.kind === 'success') revision++;
    failedSinceSuccess = false;
    lastAttempt = { ...current.attempt, completedAt, outcome: result.kind === 'success' ? 'success' : 'unchanged', error: null };
  };
  const execute = async (current: Flight) => {
    try {
      if (!current.valid || disposed) return;
      const result = await options.load({ signal: current.controller.signal, reason: current.reason });
      if (!current.valid || disposed) return;
      try { accept(current, result); } catch { finishError(current, errors.invalid_result); }
    } catch {
      if (current.valid && !disposed) finishError(current, errors.load_failed);
    } finally {
      if (flight === current) flight = null;
      const next = queued;
      queued = null;
      if (!disposed && next !== null && (next.reason === 'manual' || enabled())) {
        const promise = request(next.reason);
        void promise.then(next.resolve);
      } else {
        arm();
        if (!disposed) publish();
        next?.resolve(getState());
      }
      current.resolve(getState());
    }
  };
  function request(reason: RefreshReason): Promise<State> {
    if (disposed) return Promise.resolve(getState());
    if (flight !== null) {
      if (flight.valid) return flight.promise;
      if (queued === null) queued = { ...deferred<State>(), reason };
      else if (reason === 'manual') queued.reason = 'manual';
      return queued.promise;
    }
    clearTimer();
    const attempt: SnapshotAttempt<E> = {
      id: ++attemptId, reason, attemptedAt: nowIso(), completedAt: null, outcome: 'pending', error: null,
    };
    const current: Flight = { ...deferred<State>(), reason, controller: new AbortController(), valid: true, attempt };
    lastAttempt = attempt;
    flight = current;
    publish();
    void execute(current);
    return current.promise;
  }
  const cancelFlight = () => {
    if (flight === null || !flight.valid) return;
    flight.valid = false;
    failedSinceSuccess = true;
    lastAttempt = { ...flight.attempt, completedAt: nowIso(), outcome: 'cancelled', error: errors.cancelled };
    flight.controller.abort();
  };
  const clearQueued = () => {
    const pending = queued;
    queued = null;
    pending?.resolve(getState());
  };
  return {
    getState,
    start() {
      if (disposed) return Promise.resolve(getState());
      if (started) return flight?.promise ?? Promise.resolve(getState());
      started = true;
      if (enabled()) return request('initial');
      publish();
      return Promise.resolve(getState());
    },
    refresh() {
      if (!disposed) started = true;
      return request('manual');
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setActivity(activity) {
      if (disposed) return;
      const nextActive = activity.active ?? active;
      const nextVisible = activity.visible ?? visible;
      if (nextActive === active && nextVisible === visible) return;
      const wasEnabled = enabled();
      active = nextActive;
      visible = nextVisible;
      if (wasEnabled && !enabled()) {
        clearTimer();
        cancelFlight();
        clearQueued();
      } else if (!wasEnabled && enabled()) {
        void request('resume');
      }
      // Remaining paused must not cancel an explicitly requested hidden manual refresh.
      // This also delivers changed flags when a resume is queued behind cancellation.
      publish();
    },
    cancel() {
      if (disposed || ((!flight || !flight.valid) && queued === null)) return;
      clearTimer();
      cancelFlight();
      clearQueued();
      arm();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      cancelFlight();
      clearQueued();
      publish();
      listeners.clear();
    },
  };
}
