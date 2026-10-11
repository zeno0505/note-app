import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import manifest from '../../fixtures/manifest.json';
import atlasDag from '../../fixtures/sources/atlas-dag.json';
import beaconDag from '../../fixtures/sources/beacon-dag.json';
import {
  createDemoSnapshot,
  createEmptySnapshot,
  createFailureSnapshot,
  createPartialSnapshot,
  createSummaryBackend,
  FixtureValidationError,
  parseFixtureSnapshot,
  retainLastGoodSnapshot,
} from '../../src/domain';
import type { WorkspaceSnapshot } from '../../src/domain';

function corrupt(change: (snapshot: WorkspaceSnapshot) => void): WorkspaceSnapshot {
  const snapshot = createDemoSnapshot();
  change(snapshot);
  return snapshot;
}

describe('synthetic fixture provenance', () => {
  it('validates every supported scenario', () => {
    expect(createDemoSnapshot().workstreams).toHaveLength(3);
    expect(createFailureSnapshot().freshness).toBe('stale');
    expect(createEmptySnapshot().workstreams).toEqual([]);
    expect(createPartialSnapshot().coverage.totalCount).toBeNull();
  });

  it('matches every source and scenario hash to exact checked-in bytes', () => {
    for (const entry of [...manifest.sources, ...manifest.scenarios]) {
      const bytes = readFileSync(fileURLToPath(new URL(`../../${entry.path}`, import.meta.url)));
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(entry.hash);
    }
    for (const stream of createDemoSnapshot().workstreams) {
      for (const source of stream.sources) {
        expect(manifest.sources.find((entry) => entry.path === source.locator)?.hash).toBe(source.hash);
      }
    }
  });

  it('admits no sensitive payload fields in source or normalized fixtures', () => {
    const forbiddenKeys = /^(prompt|preview|conversation|conversationBody|messages|secret|secrets|token|password|apiKey)$/i;
    function check(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(check); return; }
      if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          expect(key).not.toMatch(forbiddenKeys);
          check(nested);
        }
      }
    }
    for (const entry of [...manifest.sources, ...manifest.scenarios]) {
      check(JSON.parse(readFileSync(fileURLToPath(new URL(`../../${entry.path}`, import.meta.url)), 'utf8')));
    }
  });

  it('returns detached objects for each factory call', () => {
    const a = createDemoSnapshot();
    a.workstreams[0]!.summary.next[0]!.text = 'changed only in this caller';
    expect(createDemoSnapshot().workstreams[0]!.summary.next[0]!.text).not.toContain('changed only');
  });
});

describe('independent observations and workstream identity', () => {
  it('keeps connected agent done separate from the running DAG', () => {
    const stream = createDemoSnapshot().workstreams[0]!;
    expect(stream.worktrees[0]).toMatchObject({ isArchived: false, isSelected: false, terminalConnected: true, agentState: 'done' });
    expect(stream.dagState).toBe('running');
  });

  it('includes an active agent without a connected terminal', () => {
    expect(createDemoSnapshot().workstreams[1]!.worktrees[0]).toMatchObject({ terminalConnected: false, agentState: 'working' });
  });

  it('deduplicates one canonical DAG but does not merge by repository', () => {
    const [atlas, beacon] = createDemoSnapshot().workstreams;
    expect(atlas!.worktrees).toHaveLength(2);
    expect(atlas!.worktrees[0]!.repositoryId).toBe(beacon!.worktrees[0]!.repositoryId);
    expect(atlas!.canonicalDagPath).not.toBe(beacon!.canonicalDagPath);
  });

  it('keeps missing note/DAG mappings unknown rather than completed or empty', () => {
    const missing = createDemoSnapshot().workstreams[2]!;
    expect(missing.noteMapping).toMatchObject({ status: 'missing', notePath: null });
    expect(missing.dagState).toBe('unknown');
    expect(missing.summary.implemented[0]!.kind).toBe('unknown');
    expect(missing.summary.remaining[0]!.text).toContain('알 수 없습니다');
  });

  it('records declared done separately from tests and deployment', () => {
    expect(atlasDag.tasks[0]).toMatchObject({ declaredStatus: 'done', tested: 'unknown', deployed: 'unknown' });
  });

  it('does not equate dependency readiness with priority or execution approval', () => {
    expect(beaconDag.tasks[0]).toMatchObject({ depsReady: true, priority: null, executionApproval: 'unknown' });
    for (const stream of createDemoSnapshot().workstreams) {
      expect(stream.summary.next[0]).toMatchObject({ kind: 'inference', approval: 'not-requested', reviewedAt: null });
      expect(stream.summary.next[0]!.text).not.toMatch(/^다음 제안:/);
      expect(stream.summary.next[0]!.text).not.toContain('fixture');
    }
  });

  it('uses human-readable Korean activity descriptions while preserving precise source states', () => {
    for (const stream of createDemoSnapshot().workstreams.slice(0, 2)) {
      expect(stream.summary.current[0]!.text).not.toMatch(/\b(done|running|working|pending)\b/);
    }
    expect(createDemoSnapshot().workstreams[0]!.dagState).toBe('running');
    expect(createDemoSnapshot().workstreams[1]!.worktrees[0]!.agentState).toBe('working');
  });
});

describe('last-good freshness and partial coverage', () => {
  it('retains all workstreams, provenance and observation time after failed refresh', () => {
    const before = createDemoSnapshot();
    const failure = createFailureSnapshot();
    expect(failure.observedAt).toBe(before.observedAt);
    expect(failure.workstreams.map((stream) => stream.id)).toEqual(before.workstreams.map((stream) => stream.id));
    expect(failure.coverage.totalCount).toBe(4);
    expect(failure.lastAttempt).toMatchObject({ outcome: 'error', observedAt: '2026-10-02T09:05:00.000Z' });
    for (const [index, stream] of failure.workstreams.entries()) {
      expect(stream.sources).toEqual(before.workstreams[index]!.sources);
      expect(stream.goal.freshness).toBe('stale');
      expect(Object.values(stream.summary).flat().every((claim) => claim.freshness === 'stale')).toBe(true);
    }
  });

  it('retains the caller last-good snapshot without mutating it', () => {
    const previous = createDemoSnapshot();
    const stale = retainLastGoodSnapshot(previous, '2026-10-02T09:05:00.000Z', 'Synthetic permission failure');
    expect(stale.freshness).toBe('stale');
    expect(stale.workstreams[0]!.goal.text).toBe(previous.workstreams[0]!.goal.text);
    expect(previous.freshness).toBe('current');
    expect(previous.workstreams[0]!.goal.freshness).toBe('current');
  });

  it('can retain a genuinely observed empty snapshot, visibly stale after a later failure', () => {
    const stale = retainLastGoodSnapshot(createEmptySnapshot(), '2026-10-02T09:05:00.000Z', 'Synthetic refresh failure');
    expect(stale).toMatchObject({ freshness: 'stale', coverage: { totalCount: 0 }, lastAttempt: { outcome: 'error' } });
    expect(stale.observedAt).toBe('2026-10-02T09:00:00.000Z');
  });

  it('preserves unknown counts, truncation and omitted hosts', () => {
    expect(createPartialSnapshot().coverage).toEqual({ complete: false, truncated: true, totalCount: null, omittedHostIds: ['synthetic-unobserved-host'] });
  });
});

describe('strict fixture boundary', () => {
  it('rejects extra payload fields rather than silently stripping private content', () => {
    const bad = { ...createDemoSnapshot(), prompt: 'unexpected' };
    expect(() => parseFixtureSnapshot(bad)).toThrow('unsupported field');
  });

  it('rejects unknown schemas and real collection mode', () => {
    expect(() => parseFixtureSnapshot({ ...createDemoSnapshot(), schemaVersion: 2 })).toThrow(FixtureValidationError);
    expect(() => parseFixtureSnapshot({ ...createDemoSnapshot(), mode: 'live' })).toThrow(FixtureValidationError);
  });

  it('rejects nonobjects and invalid timestamps', () => {
    for (const value of [null, [], 'snapshot', 0, new Date()]) {
      expect(() => parseFixtureSnapshot(value)).toThrow(FixtureValidationError);
    }
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.observedAt = '2026-02-30T09:00:00.000Z'; }))).toThrow('valid canonical UTC');
  });

  it('rejects unresolved or changed source references', () => {
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.goal.sources[0]!.sourceId = 'missing-source'; }))).toThrow('does not resolve');
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.goal.sources[0]!.sourceHash = `sha256:${'0'.repeat(64)}`; }))).toThrow('source changed');
  });

  it('rejects non-synthetic paths and arbitrary source locators', () => {
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.canonicalDagPath = '/real/project/dag.yaml'; }))).toThrow('synthetic paths');
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.sources[0]!.locator = 'https://example.com/source'; }))).toThrow('bounded synthetic');
  });

  it('rejects duplicate DAG identities, worktrees and claims', () => {
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[1]!.canonicalDagPath = s.workstreams[0]!.canonicalDagPath; }))).toThrow('duplicate');
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[1]!.worktrees[0]!.id = s.workstreams[0]!.worktrees[0]!.id; }))).toThrow('duplicate');
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.summary.next[0]!.id = s.workstreams[0]!.goal.id; }))).toThrow('duplicate');
  });

  it('rejects a failed first query fabricated as a zero result', () => {
    const empty = createEmptySnapshot();
    empty.freshness = 'stale';
    empty.lastAttempt = { observedAt: empty.observedAt, outcome: 'error', reason: 'No usable observation exists' };
    expect(() => parseFixtureSnapshot(empty)).toThrow('failed first observation');
  });

  it('rejects failures labeled current and partial coverage labeled complete', () => {
    const failed = createFailureSnapshot();
    failed.freshness = 'current';
    expect(() => parseFixtureSnapshot(failed)).toThrow('stale snapshot');
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.coverage.truncated = true; }))).toThrow('incomplete coverage');
  });

  it('rejects false-zero, fractional, negative and unknown complete counts', () => {
    for (const total of [0, -1, 1.2, Number.NaN, null]) {
      expect(() => parseFixtureSnapshot(corrupt((s) => { s.coverage.totalCount = total; }))).toThrow(FixtureValidationError);
    }
  });

  it('rejects a stale snapshot containing a current claim', () => {
    const failed = createFailureSnapshot();
    failed.workstreams[0]!.goal.freshness = 'current';
    expect(() => parseFixtureSnapshot(failed)).toThrow('current claims');
  });

  it('rejects contradicted connectivity but permits connection without observed agent state', () => {
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.worktrees[0]!.terminalCount = 0; }))).toThrow('contradict');
    expect(createDemoSnapshot().workstreams[2]!.worktrees[0]).toMatchObject({ terminalConnected: true, agentState: 'unknown' });
  });

  it('requires source provenance, explicit unknown answers and explicit review time for approvals', () => {
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.goal.sources = []; }))).toThrow('requires source provenance');
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.summary.blockers = []; }))).toThrow('explicit unknown');
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.goal.approval = 'approved'; }))).toThrow('explicit review time');
  });

  it('enforces array and text bounds', () => {
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams[0]!.goal.text = 'x'.repeat(801); }))).toThrow('at most 800');
    expect(() => parseFixtureSnapshot(corrupt((s) => { s.workstreams = Array(1001).fill(s.workstreams[0]); }))).toThrow('at most 1000');
  });
});

describe('summary backend remains local and inert', () => {
  it('defaults to disabled and never transmits a summary request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must not be used'));
    try {
      const backend = createSummaryBackend();
      expect(backend.mode).toBe('disabled');
      expect(await backend.summarize({ snapshot: createDemoSnapshot(), workstreamId: 'atlas-search' })).toMatchObject({ state: 'disabled' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it('returns only the manual fixture claims with provenance unchanged', async () => {
    const snapshot = createDemoSnapshot();
    const result = await createSummaryBackend('manual-fixture').summarize({ snapshot, workstreamId: 'atlas-search' });
    expect(result).toEqual({ state: 'manual-fixture', workstreamId: 'atlas-search', goal: snapshot.workstreams[0]!.goal, summary: snapshot.workstreams[0]!.summary });
    if (result.state === 'manual-fixture') {
      result.goal.text = 'caller-owned output';
      expect(snapshot.workstreams[0]!.goal.text).not.toBe('caller-owned output');
    }
  });

  it('preserves stale evidence and refuses missing workstreams or unsupported backend modes', async () => {
    const backend = createSummaryBackend('manual-fixture');
    const stale = await backend.summarize({ snapshot: createFailureSnapshot(), workstreamId: 'atlas-search' });
    expect(stale).toMatchObject({ state: 'manual-fixture', goal: { freshness: 'stale' } });
    expect(await backend.summarize({ snapshot: createDemoSnapshot(), workstreamId: 'does-not-exist' })).toMatchObject({ state: 'unavailable' });
    expect(() => createSummaryBackend('remote' as 'disabled')).toThrow('Unsupported');
  });
});
