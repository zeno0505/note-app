import { describe, expect, it } from 'vitest';
import { buildContextPack, type ContextPack, type ContextRecord } from '../../src/summary/context';
import { ASPECTS, bindSummaryContext, createSummaryStore, MAX_RESPONSE_BYTES, parseSummaryResponse, parseSummaryStoreState, restoreSummaryStoreFromLocalCache, type SummaryResponse } from '../../src/summary/claims';

const at = '2026-10-02T12:00:00.000Z';
const later = '2026-10-02T13:00:00.000Z';
const hash = (char: string) => `sha256:${char.repeat(64)}`;
function record(sourceId: string, char: string, observedAt = at): ContextRecord {
  return { sourceId, sourceHash: hash(char), observedAt, text: `Source ${sourceId} says work is running.`, declaredStatus: 'running', dependencies: [] };
}
function context(records = [record('a', 'a'), record('b', 'b')], complete = true): ContextPack {
  return buildContextPack({ schemaVersion: 1, scopeId: 'feature-1', records,
    coverage: { complete, totalCount: complete ? records.length : null, unknowns: complete ? [] : ['Not all sources observed'] },
    previousSources: [], priorApprovedSummary: null, limits: { maxBytes: 32768, maxApproxTokens: 32768, maxRecords: 256 } });
}
function response(pack = context()): SummaryResponse {
  return { schemaVersion: 1, ...bindSummaryContext(pack), generatedAt: pack.records.some(r => r.observedAt === later) ? later : at,
    claims: ASPECTS.map((aspect, index) => {
      const source = pack.records[index < 3 ? 0 : 1] ?? pack.records[0];
      return { claimId: aspect, aspect, kind: aspect === 'next' ? 'inference' : 'fact', text: source.text,
        intent: aspect === 'next' ? 'proposal' : 'informational',
        citations: [{ sourceId: source.sourceId, sourceHash: source.sourceHash, observedAt: source.observedAt, quote: source.text }],
        assertions: [{ type: 'declared-status', sourceId: source.sourceId, status: 'running' }] };
    }) };
}
function approvedStore() {
  const pack = context(); const store = createSummaryStore(pack);
  const ticket = store.beginUpdate()!;
  expect(store.acceptResponse(ticket, response(pack))).toBe(true);
  const state = store.snapshot();
  expect(store.approve({ kind: 'user-summary-approval', incarnation: store.snapshot().incarnation, scopeId: pack.scopeId, candidateHash: state.candidate!.candidateHash,
    expectedVersion: state.version, approvalId: 'user-event-1', approvedAt: at })).toBe(true);
  return { store, pack };
}

describe('bounded summary response contract', () => {
  it('copies and freezes candidate data with exact included source provenance', () => {
    const input = response(); const candidate = parseSummaryResponse(input, context());
    expect(candidate.status).toBe('candidate');
    expect(Object.isFrozen(candidate.claims[0].citations)).toBe(true);
    input.claims[0].text = 'Changed by caller';
    expect(candidate.claims[0].text).not.toBe(input.claims[0].text);
    expect(parseSummaryResponse(JSON.stringify(response()), context())).toEqual(candidate);
  });
  it.each(['scopeId', 'schemaHash', 'packHash'] as const)('rejects a mismatched %s', field => {
    const input = response(); input[field] = field === 'scopeId' ? 'other' : hash('f');
    expect(() => parseSummaryResponse(input, context())).toThrow();
  });
  it.each(['sourceId', 'sourceHash', 'observedAt', 'quote'] as const)('rejects mismatched citation %s', field => {
    const input = response(); input.claims[0].citations[0][field] = ({ sourceId: 'outside', sourceHash: hash('f'), observedAt: later, quote: 'Never stated' })[field];
    expect(() => parseSummaryResponse(input, context())).toThrow();
  });
  it('rejects excluded source text even when its ID/hash is in manifest', () => {
    const pack = buildContextPack({ schemaVersion: 1, scopeId: 'feature-1', records: [record('a', 'a'), record('b', 'b')],
      coverage: { complete: true, totalCount: 2, unknowns: [] }, previousSources: [], priorApprovedSummary: null,
      limits: { maxBytes: 32768, maxApproxTokens: 32768, maxRecords: 1 } });
    const input = response(context()); Object.assign(input, bindSummaryContext(pack));
    expect(pack.sources).toHaveLength(2); expect(pack.records).toHaveLength(1);
    expect(() => parseSummaryResponse(input, pack)).toThrow(/included source/);
  });
  it('rejects approval fields, unsupported semantic assertions and paraphrased facts', () => {
    expect(() => parseSummaryResponse({ ...response(), approved: true }, context())).toThrow();
    const input = response(); input.claims[0].assertions[0].type = 'tested' as never;
    expect(() => parseSummaryResponse(input, context())).toThrow();
    input.claims[0].assertions = []; input.claims[0].text = 'Everything has been deployed';
    expect(() => parseSummaryResponse(input, context())).toThrow(/verbatim/);
    input.claims[0].kind = 'inference';
    // Free-text inference is only a candidate; schema cannot prove or reject every semantic lie.
    expect(parseSummaryResponse(input, context()).status).toBe('candidate');
  });
  it('rejects promoted status, next-step approval and evidence-free inference', () => {
    const input = response(); input.claims[0].assertions[0].status = 'done';
    expect(() => parseSummaryResponse(input, context())).toThrow(/status assertion/);
    const next = response(); next.claims[4].intent = 'informational';
    expect(() => parseSummaryResponse(next, context())).toThrow(/proposals/);
    const empty = response(); empty.claims[4].citations = [];
    expect(() => parseSummaryResponse(empty, context())).toThrow(/requires evidence/);
  });
  it('accepts explicitly unknown unsupported fields without fake provenance', () => {
    const input = response(); input.claims[5] = { ...input.claims[5], kind: 'unknown', text: 'Blockers are not established', citations: [], assertions: [] };
    expect(parseSummaryResponse(input, context()).claims[5].kind).toBe('unknown');
  });
  it('enforces sizes, exact keys, timestamps, unique IDs, dense arrays and inert object fields', () => {
    expect(() => parseSummaryResponse(' '.repeat(MAX_RESPONSE_BYTES + 1), context())).toThrow(/budget/);
    expect(() => parseSummaryResponse('{', context())).toThrow(/JSON/);
    const huge = response(); huge.claims[0].text = 'a'.repeat(4097);
    expect(() => parseSummaryResponse(huge, context())).toThrow(/oversized/);
    const duplicate = response(); duplicate.claims[1].claimId = duplicate.claims[0].claimId;
    expect(() => parseSummaryResponse(duplicate, context())).toThrow(/distinct/);
    const invalidTime = response(); invalidTime.generatedAt = '2026-02-30T12:00:00.000Z';
    expect(() => parseSummaryResponse(invalidTime, context())).toThrow(/time/);
    const getter = response(); let invoked = false;
    Object.defineProperty(getter, 'claims', { get() { invoked = true; return []; } });
    expect(() => parseSummaryResponse(getter, context())).toThrow(/Accessors/); expect(invoked).toBe(false);
    const sparse = response(); delete sparse.claims[0];
    expect(() => parseSummaryResponse(sparse, context())).toThrow(/array/);
    const extra = response(); Object.defineProperty(extra, 'hidden', { value: true });
    expect(() => parseSummaryResponse(extra, context())).toThrow(/fields/);
  });
  it('rejects a tampered context pack before accepting its citations', () => {
    const pack = context(); pack.records[0].text = 'tampered';
    expect(() => bindSummaryContext(pack)).toThrow(/hash mismatch/);
  });
});

describe('in-memory approved summary and incremental update contract', () => {
  it('requires separate explicit approval of the current candidate and version', () => {
    const pack = context(); const store = createSummaryStore(pack);
    expect(store.acceptResponse(store.beginUpdate()!, response(pack))).toBe(true);
    expect(store.snapshot().approved).toBeNull();
    const state = store.snapshot();
    const event = { kind: 'user-summary-approval' as const, incarnation: store.snapshot().incarnation, scopeId: pack.scopeId, candidateHash: state.candidate!.candidateHash,
      expectedVersion: state.version, approvalId: 'approval-1', approvedAt: at };
    expect(store.approve({ ...event, expectedVersion: 0 })).toBe(false);
    expect(store.approve(event)).toBe(true);
    expect(store.approve(event)).toBe(false);
  });
  it('preserves prior approval on failure and marks only changed claims stale', () => {
    const { store } = approvedStore(); const approved = store.snapshot().approved;
    const changed = context([record('a', 'c', later), record('b', 'b')]);
    expect(store.updateContext(changed)).toEqual({ changed: true, affectedClaimIds: ['goal', 'implemented', 'remaining'] });
    const state = store.snapshot();
    expect(state.approved).toEqual(approved);
    expect(state.approvedClaims.map(c => c.freshness)).toEqual(['stale', 'stale', 'stale', 'current', 'current', 'current']);
    expect(store.failRequest(store.beginUpdate()!, 'backend unavailable')).toBe(true);
    expect(store.snapshot().approved).toEqual(approved);
    const ticket = store.beginUpdate()!;
    expect(store.acceptResponse(ticket, { ...response(changed), approved: true })).toBe(false);
    expect(store.snapshot().approved).toEqual(approved);
  });
  it('keeps deleted and unobserved-source claims as unknown without dropping approved text', () => {
    for (const complete of [true, false]) {
      const { store } = approvedStore(); const approved = store.snapshot().approved;
      store.updateContext(context([record('a', 'a')], complete));
      expect(store.snapshot().approved).toEqual(approved);
      expect(store.snapshot().approvedClaims.slice(3).every(c => c.freshness === 'unknown')).toBe(true);
    }
  });
  it('hash-no-change observation update is a no-op, with detached immutable snapshots', () => {
    const { store } = approvedStore(); const before = store.snapshot();
    expect(store.updateContext(context([record('a', 'a', later), record('b', 'b', later)]))).toEqual({ changed: false, affectedClaimIds: [] });
    expect(store.snapshot()).toEqual(before); expect(store.beginUpdate()).toBeNull();
    expect(() => { before.approved!.summary.claims[0].text = 'mutated'; }).toThrow();
  });
  it('accepts only affected claim replacements, retaining unaffected data and prior approval', () => {
    const { store } = approvedStore(); const before = store.snapshot();
    const changed = context([record('a', 'c', later), record('b', 'b', later)]);
    store.updateContext(changed);
    const full = response(changed); expect(store.acceptResponse(store.beginUpdate()!, full)).toBe(false);
    const delta = response(changed); delta.claims = delta.claims.slice(0, 3);
    expect(store.acceptResponse(store.beginUpdate()!, delta)).toBe(true);
    expect(store.snapshot().candidate!.claims.slice(3)).toEqual(before.candidate!.claims.slice(3));
    expect(store.snapshot().approved).toEqual(before.approved);
    expect(store.beginUpdate()).toBeNull();
  });
  it('rejects missing initial aspects and changed delta aspects', () => {
    const pack = context(); const store = createSummaryStore(pack); const partial = response(pack); partial.claims.pop();
    expect(store.acceptResponse(store.beginUpdate()!, partial)).toBe(false);
    const { store: existing } = approvedStore(); const changed = context([record('a', 'c'), record('b', 'b')]);
    existing.updateContext(changed); const delta = response(changed); delta.claims = delta.claims.slice(0, 3); delta.claims[0].aspect = 'current';
    expect(existing.acceptResponse(existing.beginUpdate()!, delta)).toBe(false);
  });
  it('prevents late requests from winning concurrent requests or source-version changes', () => {
    const pack = context(); const store = createSummaryStore(pack);
    const first = store.beginUpdate()!; const second = store.beginUpdate()!;
    expect(store.acceptResponse(first, response(pack))).toBe(false);
    expect(store.failRequest(first, 'old failure')).toBe(false);
    expect(store.acceptResponse(second, response(pack))).toBe(true);
    const changed = context([record('a', 'c'), record('b', 'b')]); store.updateContext(changed);
    const staleTicket = store.beginUpdate()!;
    store.updateContext(context([record('a', 'd'), record('b', 'b')]));
    expect(store.acceptResponse(staleTicket, response(changed))).toBe(false);
    expect(store.snapshot().candidate!.packHash).toBe(pack.packHash);
  });
  it('does not repeatedly request unchanged unknown claims after accepting them', () => {
    const pack = context(); const store = createSummaryStore(pack); const input = response(pack);
    input.claims[5] = { ...input.claims[5], kind: 'unknown', text: 'Not known', citations: [], assertions: [] };
    expect(store.acceptResponse(store.beginUpdate()!, input)).toBe(true);
    expect(store.beginUpdate()).toBeNull();
  });
  it('invalidates same-hash extracted status, dependency or text changes', () => {
    for (const change of ['text', 'declaredStatus', 'dependencies'] as const) {
      const { store } = approvedStore(); const a = record('a', 'a');
      if (change === 'text') a.text = 'New extraction with the same upstream hash';
      if (change === 'declaredStatus') a.declaredStatus = 'done';
      if (change === 'dependencies') a.dependencies = [{ sourceId: 'b', declaredStatus: 'running' }];
      const changed = context([a, record('b', 'b')]);
      expect(store.updateContext(changed)).toEqual({ changed: true, affectedClaimIds: ['goal', 'implemented', 'remaining'] });
      expect(store.snapshot().approvedClaims[0].freshness).toBe('stale');
      expect(store.beginUpdate()!.claimIds).toEqual(['goal', 'implemented', 'remaining']);
    }
  });
  it('refreshes all scope aspects on source additions or coverage loss', () => {
    for (const changed of [context([record('a', 'a'), record('b', 'b'), record('c', 'c')]), context(undefined, false)]) {
      const { store } = approvedStore();
      expect(store.updateContext(changed).affectedClaimIds).toEqual([...ASPECTS]);
      expect(store.beginUpdate()!.claimIds).toEqual([...ASPECTS]);
      expect(store.snapshot().approvedClaims.every(c => c.freshness !== 'current')).toBe(true);
      const state = store.snapshot();
      expect(store.approve({ kind: 'user-summary-approval', incarnation: store.snapshot().incarnation, scopeId: 'feature-1', candidateHash: state.candidate!.candidateHash,
        expectedVersion: state.version, approvalId: 'stale-event', approvedAt: later })).toBe(false);
    }
  });
  it('rejects impossible response and approval chronology', () => {
    const pack = context([record('a', 'a', later), record('b', 'b', later)]);
    const input = response(pack); input.generatedAt = at;
    expect(() => parseSummaryResponse(input, pack)).toThrow(/predates/);
    const store = createSummaryStore(pack);
    expect(store.acceptResponse(store.beginUpdate()!, response(pack))).toBe(true);
    const state = store.snapshot();
    expect(() => store.approve({ kind: 'user-summary-approval', incarnation: store.snapshot().incarnation, scopeId: pack.scopeId, candidateHash: state.candidate!.candidateHash,
      expectedVersion: state.version, approvalId: 'early-event', approvedAt: at })).toThrow(/predates/);
    expect(store.snapshot().approved).toBeNull();
  });

  it('does not hide evidence behind budget exclusion during incremental refresh', () => {
    const { store } = approvedStore();
    const truncated = buildContextPack({ schemaVersion: 1, scopeId: 'feature-1', records: [record('a', 'c'), record('b', 'b')],
      coverage: { complete: true, totalCount: 2, unknowns: [] }, previousSources: [], priorApprovedSummary: null,
      limits: { maxBytes: 32768, maxApproxTokens: 32768, maxRecords: 1 } });
    expect(store.updateContext(truncated).affectedClaimIds).toEqual([...ASPECTS]);
    expect(store.snapshot().candidateClaims.slice(3).every(c => c.freshness === 'unknown')).toBe(true);
    const input = response(truncated);
    input.claims = input.claims.map((c, index) => index < 3 ? c : { ...c, kind: 'unknown', text: 'Evidence not included', citations: [], assertions: [] });
    expect(store.acceptResponse(store.beginUpdate()!, input)).toBe(true);
    const b = record('b', 'b'); b.text = 'Changed extraction, unchanged upstream hash';
    store.updateContext(context([record('a', 'c'), b]));
    expect(store.beginUpdate()!.claimIds).toEqual(['current', 'next', 'blockers']);
    expect(store.snapshot().candidateClaims.slice(3).every(c => c.freshness === 'unknown')).toBe(true);
  });

  it('replaces historical approval only after a separately approved refreshed candidate', () => {
    const { store } = approvedStore(); const oldApproval = store.snapshot().approved;
    const changed = context([record('a', 'c', later), record('b', 'b')]); store.updateContext(changed);
    const delta = response(changed); delta.claims = delta.claims.slice(0, 3);
    expect(store.acceptResponse(store.beginUpdate()!, delta)).toBe(true);
    expect(store.snapshot().approved).toEqual(oldApproval);
    const state = store.snapshot();
    expect(store.approve({ kind: 'user-summary-approval', incarnation: store.snapshot().incarnation, scopeId: 'feature-1', candidateHash: state.candidate!.candidateHash,
      expectedVersion: state.version, approvalId: 'user-event-2', approvedAt: later })).toBe(true);
    expect(store.snapshot().approved!.approvalId).toBe('user-event-2');
    expect(store.snapshot().approvedClaims.every(c => c.freshness === 'current')).toBe(true);
  });

});


describe('explicit local summary persistence', () => {
  it('retains exact per-claim bases across incremental merge and restart', () => {
    const { store, pack } = approvedStore();
    const next = context([record('a', 'c', later), record('b', 'b', later)]);
    store.updateContext(next);
    const delta = response(next); delta.claims = delta.claims.slice(0, 3);
    expect(store.acceptResponse(store.beginUpdate()!, delta)).toBe(true);
    const state = store.exportState();
    expect(state.candidateBases.find(b => b.claimId === 'current')!.packHash).toBe(pack.packHash);
    expect(state.candidateBases.find(b => b.claimId === 'goal')!.packHash).toBe(next.packHash);
    const restored = restoreSummaryStoreFromLocalCache(JSON.parse(JSON.stringify(state)), next);
    expect(restored.snapshot().candidate).toEqual(store.snapshot().candidate);
    expect(restored.snapshot().approved).toEqual(store.snapshot().approved);
    expect(restored.snapshot().candidateClaims.every(c => c.freshness === 'current')).toBe(true);
    expect(restored.snapshot().approvedClaims.slice(0, 3).every(c => c.freshness === 'stale')).toBe(true);
    expect(restored.snapshot().candidate!.claims[3].citations[0].observedAt).toBe(at);
    expect(restored.exportState().candidateBases).toEqual(state.candidateBases);
  });
  it('invalidates old tickets and rejects bad chronology, extra approval fields and accessors', () => {
    const { store, pack } = approvedStore();
    const changed = context([record('a', 'c', later), record('b', 'b')]); store.updateContext(changed);
    const ticket = store.beginUpdate()!; expect(ticket).not.toBeNull(); const state = store.exportState();
    const restored = restoreSummaryStoreFromLocalCache(state, changed); expect(restored.beginUpdate()).not.toBeNull();
    expect(restored.acceptResponse(ticket, response(changed))).toBe(false);
    expect(restored.failRequest(ticket, 'old request')).toBe(false);
    expect(restored.approve({ kind: 'user-summary-approval', incarnation: store.snapshot().incarnation, scopeId: pack.scopeId, candidateHash: state.candidate!.candidateHash, expectedVersion: state.version, approvalId: 'old-version', approvedAt: later })).toBe(false);
    const bad = structuredClone(state); bad.approved!.approvedAt = '2026-10-01T00:00:00.000Z';
    expect(() => parseSummaryStoreState(bad)).toThrow(/predates/);
    expect(() => parseSummaryStoreState({ ...state, executionApproved: true })).toThrow();
    let invoked = false; const accessor = structuredClone(state);
    Object.defineProperty(accessor.packs[0].records[0], 'text', { get() { invoked = true; return 'fake'; } });
    expect(() => parseSummaryStoreState(accessor)).toThrow(/accessors/); expect(invoked).toBe(false);
  });
});

it('rejects merged response chronology before changing candidate or evidence bases', () => {
  const early = '2026-10-02T10:00:00.000Z'; const middle = '2026-10-02T11:00:00.000Z';
  const initial = context([record('a', 'a', early), record('b', 'b', at)]);
  const store = createSummaryStore(initial); expect(store.acceptResponse(store.beginUpdate()!, response(initial))).toBe(true);
  const good = store.exportState();
  const changed = context([record('a', 'c', early), record('b', 'b', at)]); store.updateContext(changed);
  const delta = response(changed); delta.generatedAt = middle; delta.claims = delta.claims.slice(0, 3);
  expect(store.acceptResponse(store.beginUpdate()!, delta)).toBe(false);
  expect(store.exportState().candidate).toEqual(good.candidate);
  expect(store.exportState().candidateBases).toEqual(good.candidateBases);
});

it('rejects tickets and approval events from another restore of the identical saved revision', () => {
  const { store, pack } = approvedStore(); const saved = store.exportState();
  const one = restoreSummaryStoreFromLocalCache(saved, pack);
  const two = restoreSummaryStoreFromLocalCache(saved, pack);
  const first = one.snapshot(); const second = two.snapshot();
  expect(first.version).toBe(second.version); expect(first.incarnation).not.toBe(second.incarnation);
  expect(two.approve({ kind: 'user-summary-approval', incarnation: first.incarnation, scopeId: pack.scopeId, candidateHash: first.candidate!.candidateHash,
    expectedVersion: first.version, approvalId: 'cross-incarnation', approvedAt: at })).toBe(false);
  const changed = context([record('a', 'c', later), record('b', 'b')]); one.updateContext(changed); two.updateContext(changed);
  const oldTicket = one.beginUpdate()!; const ownTicket = two.beginUpdate()!;
  expect(oldTicket.requestId).toBe(ownTicket.requestId); expect(oldTicket.version).toBe(ownTicket.version);
  const delta = response(changed); delta.claims = delta.claims.slice(0, 3);
  expect(two.acceptResponse(oldTicket, delta)).toBe(false);
  expect(two.failRequest(oldTicket, 'other instance')).toBe(false);
  expect(two.acceptResponse(ownTicket, delta)).toBe(true);
});
