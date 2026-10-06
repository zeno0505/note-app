import { describe, it, expect } from 'vitest';
import fixture from '../../fixtures/orca-terminal/nonmodel-1.4.221.json';
import { createNonmodelContractSession, createNonmodelFrameCollector, decodeOrcaNonmodelResult,
  NONMODEL_LIMITS, type NonmodelBinding, type NonmodelOperation } from '../../src/summary/workflow/orca-nonmodel';
import { SUMMARY_TRANSPORT_GATE } from '../../src/summary/workflow/transport';
const cases = fixture.cases;
const raw = (index: number) => JSON.stringify(cases[index].envelope);
const decode = (index: number) => decodeOrcaNonmodelResult(cases[index].operation as NonmodelOperation, raw(index), fixture.version, cases[index].exitCode);
const send = decode(1); if (send.kind !== 'send') throw new Error('Invalid test fixture');
const binding: NonmodelBinding = { ownerId: 'fictional-owner', ticketId: 'fictional-ticket', runId: 'fictional-run',
  runtimeId: send.runtimeId, handle: send.handle, incarnation: send.incarnation };
const session = () => createNonmodelContractSession(binding.ownerId, binding);
function altered(index: number, change: (envelope: any) => void) { const value = JSON.parse(raw(index)); change(value); return JSON.stringify(value); }
function read(s: ReturnType<typeof session>, index: number, data = raw(index), actual = binding) {
  s.planRead(binding); return s.acceptRead(actual, data, fixture.version, cases[index].exitCode);
}
describe('observed 1.4.221 nonmodel envelopes, offline only', () => {
  it.each(cases.map((entry, index) => ({operation: entry.operation, index})))('decodes observed $operation case $index', ({index}) => {
    expect(decode(index).kind).toBe(cases[index].exitCode === 1 ? 'error' : cases[index].operation);
  });
  it('keeps input acceptance, unknown exit and PTY close distinct from AI completion', () => {
    expect(send).toMatchObject({delivery: 'unsupported', replayed: false});
    expect(decode(4)).toMatchObject({kind: 'error', code: 'timeout'});
    expect(decode(10)).toMatchObject({kind: 'wait-exit', exitCode: -1, exitCause: 'stop_unverified'});
    expect(decode(11)).toMatchObject({kind: 'close', ptyKilled: true});
    expect(SUMMARY_TRANSPORT_GATE).toMatchObject({state: 'blocked', automaticRetry: false, idleMeansCompletion: false});
  });
  it.each([
    (e: any) => { e.result.send.prompt.stages.push('turn_started'); },
    (e: any) => { e.result.send.prompt.provider = 'claude'; },
    (e: any) => { e.result.send.prompt.completed = true; },
    (e: any) => { e.result.mutation.requestId = '00000000-0000-4000-8000-000000000999'; },
    (e: any) => { e.result.mutation.replayed = true; },
    (e: any) => { e._meta.newField = true; },
    (e: any) => { e.ok = 'true'; },
  ])('rejects unobserved fields, stages and conflicting receipts', change => {
    expect(() => decodeOrcaNonmodelResult('send', altered(1, change), fixture.version, 0)).toThrow();
  });
  it('rejects unknown versions, CLI exit mismatch, malformed or oversized wire data', () => {
    expect(() => decodeOrcaNonmodelResult('send', raw(1), '1.4.222', 0)).toThrow(/version/);
    expect(() => decodeOrcaNonmodelResult('send', raw(1), fixture.version, 1)).toThrow(/mismatch/);
    expect(() => decodeOrcaNonmodelResult('read', '{}', fixture.version, 0)).toThrow();
    expect(() => decodeOrcaNonmodelResult('read', 'x'.repeat(NONMODEL_LIMITS.envelopeBytes+1), fixture.version, 0)).toThrow(/budget/);
    expect(() => decodeOrcaNonmodelResult('read', altered(0, e => { e.result.terminal.returnedLineCount++; }), fixture.version, 0)).toThrow(/lines/);
    expect(() => decodeOrcaNonmodelResult('read', altered(0, e => { e.result.terminal.nextCursor = 7; }), fixture.version, 0)).toThrow();
  });
});
describe('owned offline request/runtime/incarnation/cursor contracts', () => {
  it('consumes actual-shaped baseline/read receipts but never correlates output with an AI response', () => {
    const s = session(); read(s, 0); expect(s.snapshot().nextCursor).toBe('7');
    s.planSend(binding, 'fictional input'); s.acceptSend(binding, raw(1), fixture.version, 0);
    expect(read(s, 2).requestCorrelation).toBe('unverified'); read(s, 3);
    expect(s.snapshot()).toMatchObject({accepted: true, requestId: send.requestId, nextCursor: '9',
      automaticRetry: false, turnStarted: false, semanticCompletion: false, remoteCancellationVerified: false});
    expect(() => s.planSend(binding, 'fictional input')).toThrow(/resend/);
  });
  it.each(['ownerId','ticketId','runId','runtimeId','handle','incarnation'] as const)('retires on changed %s, including outstanding reads', key => {
    const s = session(); s.planRead(binding);
    expect(() => s.acceptRead({...binding, [key]: 'foreign'}, raw(0), fixture.version, 0)).toThrow(/changed/);
    expect(s.snapshot().active).toBe(false); expect(() => s.planRead(binding)).toThrow(/retired/);
  });
  it.each([
    (e: any) => { e._meta.runtimeId = '00000000-0000-4000-8000-000000000999'; },
    (e: any) => { e.result.terminal.handle = 'term_00000000-0000-4000-8000-000000000999'; },
    (e: any) => { e.result.terminal.nextCursor = '0'; e.result.terminal.latestCursor = '0'; e.result.terminal.tail = []; e.result.terminal.returnedLineCount = 0; },
    (e: any) => { e.result.terminal.oldestCursor = '8'; },
    (e: any) => { e.result.terminal.source = 'screen'; },
    (e: any) => { e.result.terminal.truncated = true; },
    (e: any) => { e.result.terminal.limited = true; },
    (e: any) => { e.result.terminal.nextCursor = '7'; },
  ])('retires rather than reset cursor or promote history after runtime/source/gap changes', change => {
    const s = session(); read(s, 0);
    expect(() => read(s, 2, altered(2, change))).toThrow(); expect(s.snapshot().active).toBe(false);
  });
  it('requires explicit ownership and detaches identity; reads need fresh caller incarnation attestation', () => {
    expect(() => createNonmodelContractSession('other-owner', binding)).toThrow(/ownership/);
    const mutable = {...binding}; const s = createNonmodelContractSession(binding.ownerId, mutable); mutable.incarnation = 'changed';
    expect(s.snapshot().binding.incarnation).toBe(binding.incarnation);
    // The wire read has no incarnation; passing only wire.runtimeId never satisfies this identity boundary.
    s.planRead(binding); expect(() => s.acceptRead({runtimeId: binding.runtimeId} as NonmodelBinding, raw(0), fixture.version, 0)).toThrow();
  });
  it('rejects duplicate/stale reads, retired sessions and ambiguous send resubmission', () => {
    const s = session(); expect(() => s.acceptRead(binding, raw(0), fixture.version, 0)).toThrow(/Unbound/);
    read(s, 0); expect(() => read(s, 0)).toThrow(/Reused/); expect(s.snapshot().active).toBe(false);
    const ambiguous = session(); ambiguous.planSend(binding, 'fictional input');
    expect(() => ambiguous.acceptSend(binding, '{}', fixture.version, 1)).toThrow(/no resend/);
    expect(() => ambiguous.planSend(binding, 'fictional input')).toThrow(/retired/);
    const cancelled = session(); cancelled.planRead(binding); cancelled.invalidate();
    expect(() => cancelled.acceptRead(binding, raw(0), fixture.version, 0)).toThrow(/retired/);
  });
  it('bounds multibyte payloads and cumulative output without pretending line cursors are bytes', () => {
    expect(() => session().planSend(binding, '가'.repeat(6000))).toThrow(/bounded/);
    const s = session();
    for(let i=0;i<4;i++) read(s, 0, altered(0, e => {
      e.id = `00000000-0000-4000-8000-${String(100+i).padStart(12,'0')}`;
      e.result.terminal.tail = ['a'.repeat(32768)]; e.result.terminal.returnedLineCount = 1;
      e.result.terminal.nextCursor = String(i+1); e.result.terminal.latestCursor = String(i+1);
    }));
    expect(s.snapshot().outputBytes).toBe(NONMODEL_LIMITS.outputBytes);
    expect(() => read(s, 2, altered(2, e => {e.result.terminal.nextCursor = '5';e.result.terminal.latestCursor = '5';}))).toThrow(/budget/);
    expect(s.snapshot().active).toBe(false);
  });
});
const frame = (requestId: string, sequence: number, body: string, done: boolean) => JSON.stringify({protocol:'note-app-nonmodel-frame-v1',requestId,sequence,body,done});
describe('application-authored nonmodel framing, never Orca or AI semantics', () => {
  it('completes only the exact request sequence and final frame', () => {
    const c = createNonmodelFrameCollector('request-A'); c.consume(frame('request-A',0,'공개 ',false)); expect(c.result()).toBeNull();
    c.consume(frame('request-A',1,'자료',true)); expect(c.result()).toBe('공개 자료');
  });
  it.each([frame('request-B',0,'wrong',true),frame('request-A',1,'late',true),'fixture-echo',raw(2)])('rejects foreign, out-of-order or raw terminal output', line => {
    const c = createNonmodelFrameCollector('request-A'); expect(() => c.consume(line)).toThrow(); expect(c.result()).toBeNull();
  });
  it('rejects duplicate/trailing frames and invalidation without retaining apparent completion', () => {
    const c = createNonmodelFrameCollector('request-A'); const line = frame('request-A',0,'result',true); c.consume(line);
    expect(() => c.consume(line)).toThrow(); expect(c.result()).toBeNull();
    const cancelled = createNonmodelFrameCollector('request-A'); cancelled.invalidate();
    expect(() => cancelled.consume(line)).toThrow(); expect(cancelled.result()).toBeNull();
  });
  it('bounds per-frame and cumulative bytes and rejects unknown semantic fields', () => {
    const c = createNonmodelFrameCollector('request-A'); expect(() => c.consume(frame('request-A',0,'가'.repeat(6000),true))).toThrow();
    const unknown = createNonmodelFrameCollector('request-A'); expect(() => unknown.consume(JSON.stringify({...JSON.parse(frame('request-A',0,'x',true)),turn_started:true}))).toThrow();
    const total = createNonmodelFrameCollector('request-A'); for(let i=0;i<13;i++) total.consume(frame('request-A',i,'x'.repeat(10000),false));
    expect(() => total.consume(frame('request-A',13,'x'.repeat(2000),true))).toThrow(); expect(total.result()).toBeNull();
  });
});
