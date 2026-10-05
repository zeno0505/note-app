import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import corpus from '../../fixtures/summary-quality/korean-review-cases.json';
import {
  createFixtureTerminalSession, decodeRealOrcaTerminalResult, FIXTURE_TERMINAL_LIMITS,
  planFixtureTerminalCreate, type FixtureObservation, type FixtureTerminalBinding,
} from '../../src/summary/workflow/fixture-terminal';
import { buildContextPack, type ContextRecord } from '../../src/summary/context';
import { ASPECTS, bindSummaryContext, createSummaryStore, parseSummaryResponse, type SummaryResponse } from '../../src/summary/claims';
import { SUMMARY_TRANSPORT_GATE } from '../../src/summary/workflow/transport';

const binding: FixtureTerminalBinding = {
  ownerId: 'fixture-owner', ticketId: 'fixture-ticket', runId: 'fixture-run',
  runtimeId: 'fixture-runtime', terminalHandle: 'fixture-terminal', incarnation: 'fixture-incarnation',
};
const session = () => createFixtureTerminalSession({ kind: 'fixture-only', ownedBy: binding.ownerId, binding });
const observation = (eventId: string, type: 'accepted' | 'submitted' | 'turn-start' | 'tui-idle'): FixtureObservation => ({ kind: 'fixture-only', eventId, binding, type });
const ambiguous = (): FixtureObservation => ({ kind: 'fixture-only', eventId: 'ambiguous', binding,
  type: 'submission-unknown', returnedRetryRequestId: 'fixture-returned-request' });
function read(s: ReturnType<typeof session>, id: string, text: string) {
  const plan = s.planRead(binding, s.snapshot().cursor, 1);
  const event: FixtureObservation = { kind: 'fixture-only', eventId: id, binding, type: 'read',
    readSequence: plan.sequence, cursor: plan.cursor, nextCursor: plan.cursor + 1, returnedUnits: 1, text };
  return { plan, event };
}

describe('fixture-only terminal groundwork, never a real Orca result decoder', () => {
  it('keeps every real result blocked, including apparently successful generic envelopes', () => {
    for (const result of [null, {}, [], 'opaque fixture result', 42]) {
      expect(() => decodeRealOrcaTerminalResult({ id: 'fixture-envelope', ok: true, result, _meta: { runtimeId: 'fixture-runtime' } })).toThrow(/UNIMPLEMENTED/);
    }
    expect(SUMMARY_TRANSPORT_GATE).toMatchObject({ state: 'blocked', automaticRetry: false, idleMeansCompletion: false });
  });
  it.each(['claude', 'codex'] as const)('plans only historically known create argv for %s without running it', command => {
    expect(planFixtureTerminalCreate({ kind: 'fixture-only', worktreeSelector: 'fixture-worktree', command })).toEqual([
      'terminal', 'create', '--worktree', 'fixture-worktree', '--command', command, '--json',
    ]);
    expect(() => planFixtureTerminalCreate({ kind: 'fixture-only', worktreeSelector: 'w', command: 'sh' as never })).toThrow();
  });
  it('requires an explicit simulated owner and detaches the binding', () => {
    expect(() => createFixtureTerminalSession({ kind: 'fixture-only', ownedBy: 'foreign-owner', binding })).toThrow(/ownership/);
    const mutable = { ...binding };
    const s = createFixtureTerminalSession({ kind: 'fixture-only', ownedBy: mutable.ownerId, binding: mutable });
    mutable.runtimeId = 'restarted';
    expect(s.snapshot().binding.runtimeId).toBe(binding.runtimeId);
    expect(Object.isFrozen(s.snapshot().binding)).toBe(true);
  });
  it.each(Object.keys(binding) as (keyof FixtureTerminalBinding)[])('rejects foreign/stale %s on every operation and event', key => {
    const s = session();
    const other = { ...binding, [key]: 'foreign' };
    expect(() => s.planSend(other, 'prompt')).toThrow(/mismatch/);
    expect(() => s.planRead(other, 0, 1)).toThrow(/mismatch/);
    expect(() => s.planWait(other, 100)).toThrow(/mismatch/);
    expect(() => s.observe({ ...observation('event', 'accepted'), binding: other })).toThrow(/mismatch/);
    expect(() => s.readFixtureOutput(other)).toThrow(/mismatch/);
    expect(() => s.invalidate(other)).toThrow(/mismatch/);
    s.planSend(binding, 'prompt'); s.observe(ambiguous());
    expect(() => s.planExplicitRetry(other, 'fixture-returned-request', 'prompt')).toThrow(/mismatch/);
  });
  it('separates send planning, acceptance, submission, turn start and idle', () => {
    const s = session();
    expect(s.planSend(binding, '검토할 가상 자료', 2)).toEqual(['terminal', 'send', '--terminal', binding.terminalHandle,
      '--text', '검토할 가상 자료', '--enter', '--wait-submit', '2', '--json']);
    expect(s.snapshot()).toMatchObject({ accepted: false, submitted: false, turnStarted: false });
    expect(() => s.observe(observation('early-submission', 'submitted'))).toThrow(/acceptance/);
    s.observe(observation('accepted', 'accepted'));
    expect(s.snapshot()).toMatchObject({ accepted: true, submitted: false, turnStarted: false });
    expect(() => s.observe(observation('early-start', 'turn-start'))).toThrow(/submission/);
    s.observe(observation('submitted', 'submitted'));
    expect(s.snapshot()).toMatchObject({ submitted: true, turnStarted: false });
    s.observe(observation('started', 'turn-start'));
    expect(s.planWait(binding, 100)).toEqual(['terminal', 'wait', '--terminal', binding.terminalHandle,
      '--for', 'tui-idle', '--timeout-ms', '100', '--json']);
    s.observe(observation('idle', 'tui-idle'));
    expect(s.snapshot()).toMatchObject({ turnStarted: true, idleObserved: true, semanticCompletion: false });
    expect(s.readFixtureOutput(binding)).toBe('');
  });
  it('retains ambiguous submission without any automatic retry and binds the explicit retry exactly', () => {
    const s = session(); s.planSend(binding, 'same prompt', 3); s.observe(ambiguous());
    expect(s.snapshot()).toMatchObject({ submissionUnknown: true, retryPlanned: false, accepted: false, submitted: false });
    expect(() => s.planSend(binding, 'same prompt')).toThrow(/blind/);
    expect(() => s.planExplicitRetry(binding, 'new-request', 'same prompt')).toThrow(/same returned ID/);
    expect(() => s.planExplicitRetry(binding, 'fixture-returned-request', 'changed prompt')).toThrow(/same returned ID/);
    expect(s.planExplicitRetry(binding, 'fixture-returned-request', 'same prompt')).toEqual([
      'terminal', 'send', '--terminal', binding.terminalHandle, '--text', 'same prompt', '--enter',
      '--wait-submit', '3', '--retry-request', 'fixture-returned-request', '--json',
    ]);
    expect(() => s.planExplicitRetry(binding, 'fixture-returned-request', 'same prompt')).toThrow(/no blind retry/);
    expect(() => s.observe({ ...ambiguous(), eventId: 'changed-request', returnedRetryRequestId: 'other' } as FixtureObservation)).toThrow(/identity changed/);
    expect(s.snapshot()).toMatchObject({ submitted: false, turnStarted: false, semanticCompletion: false });
  });
  it('does not allow retries without an ambiguous returned ID or after confirmed submission', () => {
    const s = session(); s.planSend(binding, 'prompt');
    expect(() => s.planExplicitRetry(binding, 'made-up', 'prompt')).toThrow();
    s.observe(ambiguous()); s.observe(observation('accepted', 'accepted')); s.observe(observation('submitted', 'submitted'));
    expect(() => s.planExplicitRetry(binding, 'fixture-returned-request', 'prompt')).toThrow();
  });
  it('deduplicates exact events without repeated output and rejects conflicting event identities', () => {
    const s = session(); s.planSend(binding, 'prompt');
    const accepted = observation('accepted', 'accepted');
    expect(s.observe(accepted)).toBe('recorded'); expect(s.observe(accepted)).toBe('duplicate');
    expect(() => s.observe({ ...accepted, type: 'tui-idle' })).toThrow(/Conflicting duplicate/);
    const { event } = read(s, 'read-1', '가상 결과');
    expect(s.observe(event)).toBe('recorded'); expect(s.observe(event)).toBe('duplicate');
    expect(s.readFixtureOutput(binding)).toBe('가상 결과');
    expect(s.snapshot()).toMatchObject({ outputBytes: Buffer.byteLength('가상 결과'), eventCount: 2, semanticCompletion: false });
  });
  it('binds reads to the pending sequence, cursor, units, and bounded next cursor', () => {
    const s = session(); const { plan, event } = read(s, 'read', 'x');
    expect(plan.argv).toEqual(['terminal', 'read', '--terminal', binding.terminalHandle, '--cursor', '0', '--limit', '1', '--json']);
    expect(() => s.planRead(binding, 0, 1)).toThrow(/pending/);
    for (const patch of [{ readSequence: 0 }, { cursor: 1 }, { nextCursor: -1 }, { nextCursor: 0 }, { nextCursor: Number.MAX_SAFE_INTEGER + 1 }, { returnedUnits: 2 }]) {
      expect(() => s.observe({ ...event, ...patch } as FixtureObservation)).toThrow();
    }
    s.observe(event);
    expect(() => s.planRead(binding, 0, 1)).toThrow(/cursor mismatch/);
    expect(s.snapshot().cursor).toBe(1);
  });
  it('bounds UTF-8 payloads, read bytes, cumulative output, numeric limits and event retention', () => {
    const s = session();
    expect(() => s.planSend(binding, '한'.repeat(Math.ceil(FIXTURE_TERMINAL_LIMITS.payloadBytes / 3)))).toThrow(/text/);
    expect(() => s.planRead(binding, 0, FIXTURE_TERMINAL_LIMITS.readUnits + 1)).toThrow(/integer/);
    expect(() => s.planWait(binding, FIXTURE_TERMINAL_LIMITS.waitMs + 1)).toThrow(/integer/);
    expect(() => s.planSend(binding, 'prompt', FIXTURE_TERMINAL_LIMITS.waitSubmitSeconds + 1)).toThrow(/integer/);
    const first = read(s, 'over-read', '한'.repeat(Math.ceil(FIXTURE_TERMINAL_LIMITS.readBytes / 3)));
    expect(() => s.observe(first.event)).toThrow(/read byte budget/);
    s.observe({ ...first.event, text: 'a'.repeat(FIXTURE_TERMINAL_LIMITS.readBytes) } as FixtureObservation);
    for (let i = 1; i < 4; i++) s.observe(read(s, `read-${i}`, 'a'.repeat(FIXTURE_TERMINAL_LIMITS.readBytes)).event);
    expect(s.snapshot().outputBytes).toBe(FIXTURE_TERMINAL_LIMITS.outputBytes);
    expect(() => s.observe(read(s, 'over-total', 'x').event)).toThrow(/output byte budget/);
    const empty = session();
    for (let i = 0; i < FIXTURE_TERMINAL_LIMITS.events; i++) empty.observe(observation(`idle-${i}`, 'tui-idle'));
    expect(() => empty.observe(observation('over-events', 'tui-idle'))).toThrow(/event budget/);
    expect(() => empty.planRead(binding, 0, 1)).toThrow(/event budget/);
  });
  it('invalidates locally, rejects late events and never claims remote cancellation', () => {
    const s = session(); s.planSend(binding, 'prompt'); const late = read(s, 'late', 'late candidate');
    s.invalidate(binding);
    expect(s.snapshot()).toMatchObject({ active: false, semanticCompletion: false, remoteCancellationVerified: false });
    expect(() => s.observe(late.event)).toThrow(/invalidated/);
    expect(() => s.planSend(binding, 'prompt')).toThrow(/invalidated/);
    expect(() => s.planExplicitRetry(binding, 'id', 'prompt')).toThrow(/invalidated/);
  });
});

function qualityPack(records = corpus.records) {
  return buildContextPack({ schemaVersion: 1, scopeId: corpus.scopeId,
    records: records.map(record => ({ ...record, sourceHash: `sha256:${createHash('sha256').update(record.text).digest('hex')}`, dependencies: [] })),
    coverage: { complete: false, totalCount: null, unknowns: ['제공된 가상 근거 밖의 전체 프로젝트 범위는 미확인입니다.'] },
    previousSources: [], priorApprovedSummary: null, limits: { maxBytes: 32768, maxApproxTokens: 32768, maxRecords: 16 } });
}
function qualityResponse(testCase: { omitAspects: readonly string[]; edits: readonly { aspect: string; text?: string; intent?: string; citationSourceHash?: string }[] }): SummaryResponse {
  const pack = qualityPack();
  const claims = corpus.referenceClaims.filter(claim => !testCase.omitAspects.includes(claim.aspect)).map(claim => {
    const source = pack.records.find(record => record.sourceId === claim.sourceId)!;
    const edit = testCase.edits.find(edit => edit.aspect === claim.aspect);
    return { claimId: claim.aspect, aspect: claim.aspect, kind: claim.kind, text: edit?.text ?? claim.text,
      intent: edit?.intent ?? (claim.aspect === 'next' ? 'proposal' : 'informational'),
      citations: [{ sourceId: source.sourceId, sourceHash: edit?.citationSourceHash ?? source.sourceHash, observedAt: source.observedAt, quote: source.text }],
      assertions: [] };
  });
  return { schemaVersion: 1, ...bindSummaryContext(pack), generatedAt: corpus.generatedAt, claims } as SummaryResponse;
}

describe('authored Korean quality review fixtures, NOT actual model evaluation', () => {
  it('declares its fictional origin, all six dimensions and independent human-review expectations', () => {
    expect(corpus.fixtureKind).toBe('authored-fictional-korean-review-corpus'); expect(corpus.modelRun).toBe(false);
    expect(corpus.reviewRubric.aspects).toEqual([...ASPECTS]);
    expect(corpus.referenceClaims.map(claim => claim.aspect)).toEqual([...ASPECTS]);
    expect(corpus.cases.filter(testCase => testCase.category === 'omission').flatMap(testCase => testCase.omitAspects)).toEqual([...ASPECTS]);
    expect(new Set(corpus.cases.map(testCase => testCase.id)).size).toBe(corpus.cases.length);
    expect(new Set(corpus.cases.map(testCase => testCase.category))).toEqual(new Set(['reference', 'omission', 'unsupported-wording', 'stale-evidence', 'proposal-promotion', 'verbosity']));
    for (const testCase of corpus.cases) expect(testCase.reviewReason.length).toBeGreaterThan(20);
  });
  it.each(corpus.cases)('$id: checks structural expectations separately from the authored review label', testCase => {
    const pack = qualityPack(); const response = qualityResponse(testCase);
    if (testCase.expectedParser === 'reject') expect(() => parseSummaryResponse(response, pack)).toThrow();
    else expect(parseSummaryResponse(response, pack).status).toBe('candidate');
    const store = createSummaryStore(pack);
    expect(store.acceptResponse(store.beginUpdate()!, response)).toBe(testCase.expectedInitialStore === 'accept');
    expect(store.snapshot().approved).toBeNull();
    // This checks the corpus's declared expectation, NOT semantic truth of model prose.
    expect(testCase.expectedReview).toBe(testCase.category === 'reference' ? 'acceptable-reference' : 'reject');
  });
  it('exposes semantic negatives that valid citations and schema cannot reject', () => {
    const negatives = corpus.cases.filter(testCase => testCase.expectedReview === 'reject' && testCase.expectedInitialStore === 'accept');
    expect(negatives.length).toBeGreaterThanOrEqual(6);
    expect(negatives.map(testCase => testCase.id)).toEqual(expect.arrayContaining([
      'done-promoted-to-tested', 'done-promoted-to-deployed', 'terminal-promoted-to-active',
      'old-running-declared-current', 'proposal-promoted-in-wording', 'verbose-repetition',
    ]));
  });
  it('marks changed evidence stale without rewriting or automatically approving the reference', () => {
    const store = createSummaryStore(qualityPack());
    expect(store.acceptResponse(store.beginUpdate()!, qualityResponse(corpus.cases[0]))).toBe(true);
    const original = store.snapshot().candidate;
    const changed = corpus.records.map(record => record.sourceId === 'fictional-implemented'
      ? { ...record, text: '목록 화면의 선언 상태가 pending으로 변경됐습니다.', declaredStatus: 'pending' as ContextRecord['declaredStatus'] } : record);
    store.updateContext(qualityPack(changed));
    expect(store.snapshot().candidate).toEqual(original);
    expect(store.snapshot().candidateClaims.find(view => view.claim.aspect === 'implemented')?.freshness).toBe('stale');
    expect(store.snapshot().approved).toBeNull();
  });
});
