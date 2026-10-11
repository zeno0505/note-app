import { describe, expect, it } from 'vitest';
import type { LiveWorkstreamView } from '../../src/shared/live';
import type { CodeBurnResult } from '../../src/summary/budget/codeburn';
import {
  currentResourceCapabilities, projectAccountQuota, projectCodeBurnResources, projectMemoryObservations,
  projectResources, projectWorkstreamResources,
  type AccountQuotaObservation, type MemoryProjectionOptions, type ProcessMemoryObservation,
} from '../../src/phase2/resources';
import { DEFAULT_DISPATCH_ADVISORY_POLICY, evaluateDispatchRecommendation } from '../../src/phase2/recommendations';

const now = 10_000;
const quota = (usedPct = 25, observedAt = now): CodeBurnResult => ({ ok: true, value: {
  kind: 'quota', provenance: 'codeburn-cli', observedAt, providers: [{ provider: 'codex', quotaData: 'available',
    agentAvailability: 'unknown', error: 'none', windows: [{ label: 'five-hour', usedPct, resetsAt: 'raw-reset', resetTimeFormat: 'unverified' }] }],
} });
const status = (observedAt = now, hasUsage: boolean | null = true): CodeBurnResult => ({ ok: true, value: {
  kind: 'status', provider: 'codex', provenance: 'codeburn-cli', observedAt, currency: 'USD', hasUsage, calendarBasis: 'unknown',
  periods: [{ label: 'today', cost: 2, calls: 3, savings: 1, approximate: true, window: null, hasUsage },
    { label: 'month', cost: 20, calls: 30, savings: 10, approximate: true, window: null, hasUsage }],
} });
const account = (accountRef = 'account-a', overrides: Partial<AccountQuotaObservation> = {}): AccountQuotaObservation => ({
  provider: 'codex', accountRef, profileRef: null, source: 'explicit-fixture', observedAt: now, lastSuccess: now,
  freshness: 'current', coverage: 'complete', quotaData: 'available', error: null,
  windows: [{ windowRef: 'five-hour', label: 'five-hour', usedPct: 30, resetsAt: null, resetTimeFormat: 'unverified' }],
  ...overrides,
});
const workstream = (id = 'work-a', overrides: Partial<LiveWorkstreamView> = {}): LiveWorkstreamView => ({
  id, title: id, projectName: 'same-name', repository: { key: 'host/repo-a', id: 'repo-a', hostId: 'host', projectId: null, label: 'same-remote' },
  branch: 'main', archived: false, terminalConnected: null, terminalCount: null, agentState: 'unknown', projectMapping: 'matched',
  observation: { worktree: 'observed', sidebarActivity: true, selected: false, workspaceStatus: 'in-progress' },
  noteMapping: { state: 'unresolved', reason: 'missing-note', dagId: null }, ...overrides,
});
const provenance = { observedAt: now, freshness: 'current' as const, coverage: 'complete' as const };
const process = (overrides: Partial<ProcessMemoryObservation> = {}): ProcessMemoryObservation => ({
  hostId: 'host', pid: 100, startTime: 1000, observedAt: now, rssBytes: 2048, state: 'running',
  workstreamIds: ['work-a'], linkage: 'verified', source: 'explicit-memory-fixture', ...overrides,
});
const memoryOptions = (overrides: Partial<MemoryProjectionOptions> = {}): MemoryProjectionOptions => ({
  ...provenance, source: 'explicit-memory-fixture', lastSuccess: now,
  capability: { state: 'supported', reason: 'Only explicitly supplied fixture observations.' }, ...overrides,
});
const normalMemory = () => projectMemoryObservations([], memoryOptions({
  pressure: { state: 'normal', observedAt: now, freshness: 'current', source: 'explicit-os-fixture' },
}));
const clearReview = { id: 'task-a', kind: 'review' as const, state: 'clear' as const, source: 'policy-fixture', observedAt: now,
  freshness: 'current' as const, reason: 'The selected task review was explicitly observed complete.' };

describe('Phase 2 resource capabilities and current adapter', () => {
  it('does not promote a data contract to live collection support', () => {
    const capabilities = currentResourceCapabilities();
    expect(capabilities.providerQuota.state).toBe('supported');
    for (const name of ['multiAccount', 'repositoryUsage', 'processMemory', 'systemMemory'] as const) {
      expect(capabilities[name].state).toBe('unsupported');
      expect(capabilities[name].reason.length).toBeGreaterThan(20);
    }
    expect(capabilities.multiAccount.reason).toContain('not established');
    capabilities.processMemory.state = 'supported';
    expect(currentResourceCapabilities().processMemory.state).toBe('unsupported');
  });

  it('projects current views without inventing sessions, tokens, memory or account coverage', () => {
    const result = projectResources({ workstreams: [workstream()], codeburn: [quota(), status()],
      observedAt: '2026-10-07T00:00:00Z', freshness: 'current', coverage: null });
    expect(result.quota.accountCoverage).toBe('unknown');
    expect(result.usage).toMatchObject({ projectTokens: null, repositoryUsage: 'unsupported', billingAmount: null });
    expect(result.memory).toMatchObject({ capability: { state: 'unsupported' }, observedBytes: null, physicalMemoryBytes: null });
    expect(result.workstreams[0]).toMatchObject({ historicalTokens: null, memoryBytes: null, coverage: 'unknown' });
    expect(result.workstreams[0].observedAt).toBe(Date.parse('2026-10-07T00:00:00Z'));
  });

  it('keeps missing collection unknown instead of zero', () => {
    const result = projectResources({ workstreams: [], codeburn: [], observedAt: 'not-a-time', freshness: 'unknown', coverage: null });
    expect(result.usage.providerPeriods).toEqual([]);
    expect(result.usage.providerObservations.every(item => item.state === 'unknown' && item.lastSuccess === null)).toBe(true);
    expect(result.quota.providers.every(item => item.accounts.every(row => row.quotaData === 'unknown' && row.observedAt === null))).toBe(true);
    expect(result.memory.shared.observedBytes).toBeNull();
    expect(result.memory.unattributed.observedBytes).toBeNull();
  });
});

describe('Phase 2 account/window and usage axes', () => {
  it('migrates provider-only quota into an explicitly unknown legacy account', () => {
    const result = projectCodeBurnResources([quota()], 'current');
    expect(result.quota.providers.find(item => item.provider === 'codex')!.accounts[0]).toMatchObject({
      accountRef: 'legacy-account-unknown:codex', identity: 'legacy-account-unknown', profileRef: null,
      observedAt: now, lastSuccess: now, agentAvailability: 'unknown', windows: [{ usedPct: 25, resetsAt: 'raw-reset', resetTimeFormat: 'unverified' }],
    });
    expect(result.quota.aggregation).toBe('none');
  });

  it('preserves two accounts per provider and their windows without summing percentages', () => {
    const result = projectAccountQuota([account('codex-a'), account('codex-b'),
      account('claude-a', { provider: 'claude' }), account('claude-b', { provider: 'claude' })], 'partial');
    expect(result.providers.map(provider => provider.accounts.length)).toEqual([2, 2]);
    expect(result.accountCoverage).toBe('partial');
    expect(result.aggregation).toBe('none');
    expect(result).not.toHaveProperty('usedPct');
    expect(result.providers[0]).not.toHaveProperty('total');
    expect(result.providers[0]).not.toHaveProperty('average');
  });

  it('preserves profile identity, per-account failures and stale last success', () => {
    const result = projectAccountQuota([account('same', { profileRef: 'one' }),
      account('same', { profileRef: 'two', observedAt: 9000, lastSuccess: 8000, lastAttemptAt: now, freshness: 'stale', error: 'access-denied' })]);
    expect(result.providers[1].accounts).toHaveLength(2);
    expect(result.providers[1].accounts[1]).toMatchObject({ profileRef: 'two', freshness: 'stale', lastSuccess: 8000, lastAttemptAt: now, error: 'access-denied' });
  });

  it('selects newest account observation rather than input order', () => {
    const result = projectAccountQuota([account('same', { observedAt: 9000, lastAttemptAt: now, error: 'timeout', freshness: 'stale' }),
      account('same', { observedAt: 8000 })]);
    expect(result.providers[1].accounts).toHaveLength(1);
    expect(result.providers[1].accounts[0].error).toBe('timeout');
  });

  it('cannot mark failed account data current merely because the surrounding poll is current', () => {
    const result = projectAccountQuota([account('failed', { error: 'timeout', freshness: 'current' }),
      account('unobserved', { quotaData: 'unknown', lastSuccess: null, freshness: 'current' })]);
    expect(result.providers[1].accounts.map(item => item.freshness)).toEqual(['stale', 'unknown']);
  });

  it('retains quota fact time separately from a more recent failed attempt', () => {
    const results: CodeBurnResult[] = [quota(25, 9000), { ok: false, observedAt: now, error: { query: 'quota', kind: 'timeout' } }];
    const account = projectCodeBurnResources(results, 'current').quota.providers[1].accounts[0];
    expect(account).toMatchObject({ observedAt: 9000, lastSuccess: 9000, lastAttemptAt: now, freshness: 'stale', error: 'timeout', windows: [{ usedPct: 25 }] });
  });

  it('does not let an old failed query make a newer success stale or contaminate another query', () => {
    const result = projectCodeBurnResources([{ ok: false, observedAt: 500, error: { query: 'quota', kind: 'timeout' } }, quota(), status(),
      { ok: false, observedAt: now + 1, error: { query: 'claude-status', kind: 'unavailable' } }], 'current');
    expect(result.quota.providers[1].accounts[0]).toMatchObject({ freshness: 'current', error: null });
    expect(result.usage.providerPeriods[0].freshness).toBe('current');
    expect(result.usage.providerObservations[0]).toMatchObject({ provider: 'claude', state: 'failed', lastSuccess: null, error: 'unavailable' });
  });

  it('shows missing usage records as gaps and never actual zero', () => {
    const result = projectCodeBurnResources([status(now, false)], 'current').usage.providerPeriods;
    expect(result).toHaveLength(2);
    for (const period of result) expect(period).toMatchObject({ records: 'no-records', cost: null, chartCost: null, calls: null, tokens: null });
  });

  it.each(['stale', 'unknown'] as const)('does not chart %s observations as zero/current usage', freshness => {
    const periods = projectCodeBurnResources([status()], freshness).usage.providerPeriods;
    expect(periods[0]).toMatchObject({ cost: 2, chartCost: null, freshness });
  });

  it('preserves reported provider estimates but does not infer boundaries, tokens or project usage', () => {
    const result = projectCodeBurnResources([status()], 'current');
    expect(result.usage.providerPeriods.map(period => period.chartCost)).toEqual([2, 20]);
    expect(result.usage.providerPeriods[0]).toMatchObject({ scope: 'provider-aggregate', tokens: null, window: null, calendarBasis: 'unknown', approximate: true });
    expect(result.usage).not.toHaveProperty('totalCost');
    expect(result.usage.reason).toContain('overlap');
  });

  it('keeps unknown collection flags out of charts even when a numeric report exists', () => {
    const result = projectCodeBurnResources([status(now, null)], 'current').usage.providerPeriods[0];
    expect(result).toMatchObject({ cost: 2, chartCost: null, records: 'unknown' });
  });

  it('deduplicates overlapping snapshots instead of accumulating period aggregates', () => {
    const result = projectCodeBurnResources([status(), status(9000), status()], 'current');
    expect(result.usage.providerPeriods).toHaveLength(2);
    expect(result.usage.providerPeriods[0].cost).toBe(2);
  });

  it('detaches projections and converts invalid numerical quota fields to unknown', () => {
    const original = account();
    original.windows = [{ ...original.windows[0], usedPct: NaN }];
    const result = projectAccountQuota([original]);
    expect(result.providers[1].accounts[0].windows[0].usedPct).toBeNull();
    result.providers[1].accounts[0].windows[0].label = 'changed';
    expect(original.windows[0].label).toBe('five-hour');
  });
});

describe('Phase 2 project/repository attribution and independent task linkage', () => {
  it('preserves all three attribution tiers', () => {
    const rows = projectWorkstreamResources([
      workstream('registered', { noteMapping: { state: 'resolved', dagId: 'dag-a', reason: null } }),
      workstream('unregistered'), workstream('unknown', { repository: undefined }),
    ], provenance);
    expect(rows.map(row => row.tier)).toEqual(['registered-project', 'repository-unregistered', 'repository-unknown']);
    expect(rows.every(row => row.taskLinkage.state === 'unknown')).toBe(true);
  });

  it('retains a registered project when its current worktree or note source is missing', () => {
    const row = projectWorkstreamResources([workstream('registered', { project: { status: 'active', changedAt: '2026-10-07',
      sourceState: 'unavailable', worktreeState: 'missing', history: [] } })], provenance)[0];
    expect(row).toMatchObject({ tier: 'registered-project', freshness: 'stale', activity: 'unknown', taskLinkage: { state: 'unknown' } });
  });

  it('does not merge same labels/remotes or separate worktrees under one repository', () => {
    const rows = projectWorkstreamResources([workstream('checkout-a'), workstream('checkout-b'),
      workstream('different-repo', { repository: { key: 'host/repo-b', id: 'repo-b', hostId: 'host', projectId: null, label: 'same-remote' } })], provenance);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.checkoutRef)).toEqual(['checkout-a', 'checkout-b', 'different-repo']);
    expect(rows.map(row => row.repository?.key)).toEqual(['host/repo-a', 'host/repo-a', 'host/repo-b']);
  });

  it('does not accept display keys, folder names or remote project IDs as repository proof', () => {
    const row = projectWorkstreamResources([workstream('unverified', { repository: {
      key: 'display-only', id: null, hostId: null, projectId: 'github:owner/same-name', label: 'same-name',
    } })], provenance)[0];
    expect(row).toMatchObject({ tier: 'repository-unknown', repository: null });
  });

  it('requires evidence before calling a known project task untracked', () => {
    const source = [workstream('registered', { noteMapping: { state: 'resolved', dagId: 'dag-a', reason: null } })];
    expect(projectWorkstreamResources(source, provenance, { registered: { state: 'unlinked', taskIds: [], evidence: null } })[0].taskLinkage.state).toBe('unknown');
    const row = projectWorkstreamResources(source, provenance, { registered: { state: 'unlinked', taskIds: [], evidence: 'Explicit task-to-DAG comparison: no linkage.' } })[0];
    expect(row).toMatchObject({ tier: 'registered-project', taskLinkage: { state: 'unlinked' } });
  });

  it('handles explicit linkage without conflating it with repository registration', () => {
    const row = projectWorkstreamResources([workstream('unregistered')], provenance, {
      unregistered: { state: 'linked', taskIds: ['TASK-1', 'TASK-1'], evidence: 'Verified external task relationship.' },
    })[0];
    expect(row).toMatchObject({ tier: 'repository-unregistered', taskLinkage: { state: 'linked', taskIds: ['TASK-1'] } });
  });
});

describe('Phase 2 explicit memory observations', () => {
  it('does not use supplied data when collection capability is unsupported', () => {
    const result = projectMemoryObservations([process()], memoryOptions({ capability: currentResourceCapabilities().processMemory }));
    expect(result).toMatchObject({ processes: [], observedBytes: null, observedAt: null, lastSuccess: null, coverage: 'unknown', freshness: 'unknown' });
  });

  it('deduplicates shared PID lifetime and keeps exclusive/shared/unattributed buckets disjoint', () => {
    const result = projectMemoryObservations([process(), process({ workstreamIds: ['work-b'] }),
      process({ pid: 200, rssBytes: 1024, workstreamIds: ['work-c'] }),
      process({ pid: 300, rssBytes: 512, workstreamIds: [], linkage: 'unknown' })], memoryOptions());
    expect(result.processes).toHaveLength(3);
    expect(result.shared).toMatchObject({ observedBytes: 2048, processCount: 1 });
    expect(result.exclusive).toEqual([{ workstreamId: 'work-c', observedBytes: 1024, processCount: 1, unknownProcessCount: 0 }]);
    expect(result.unattributed).toMatchObject({ observedBytes: 512, processCount: 1 });
    expect(result.observedBytes).toBe(3584);
    expect(result.physicalMemoryBytes).toBeNull();
  });

  it('uses host plus PID plus start time and never merges host-local PIDs', () => {
    const result = projectMemoryObservations([process(), process({ hostId: 'other-host', rssBytes: 4096 })], memoryOptions());
    expect(result.processes).toHaveLength(2);
    expect(result.observedBytes).toBe(6144);
  });

  it('does not count a recycled PID lifetime as still current', () => {
    const result = projectMemoryObservations([process({ observedAt: 5000 }), process({ startTime: 6000, rssBytes: 4096 })], memoryOptions());
    expect(result.processes.map(item => item.state)).toEqual(['superseded', 'running']);
    expect(result.observedBytes).toBe(4096);
  });

  it('chooses the latest supplied state including exits and ownership changes', () => {
    const result = projectMemoryObservations([process({ observedAt: 5000, workstreamIds: ['old-owner'] }),
      process({ workstreamIds: ['new-owner'], rssBytes: 4096 }), process({ pid: 200, state: 'exited' })], memoryOptions());
    expect(result.exclusive).toEqual([{ workstreamId: 'new-owner', observedBytes: 4096, processCount: 1, unknownProcessCount: 0 }]);
    expect(result.observedBytes).toBe(4096);
  });

  it('never counts a process whose start time is absent', () => {
    const result = projectMemoryObservations([process({ startTime: null })], memoryOptions());
    expect(result).toMatchObject({ observedBytes: null, coverage: 'partial', unattributed: { observedBytes: null, unknownProcessCount: 1 } });
    expect(result.processes[0].reason).toContain('deduplication');
  });

  it.each([null, NaN, Infinity, -1, 1.5])('does not convert invalid/missing RSS (%s) to zero', rssBytes => {
    const result = projectMemoryObservations([process({ rssBytes })], memoryOptions());
    expect(result.observedBytes).toBeNull();
    expect(result.exclusive[0].unknownProcessCount).toBe(1);
    expect(result.coverage).toBe('partial');
  });

  it('reports conflicting simultaneous RSS and PID-lifetime observations as unknown', () => {
    const rss = projectMemoryObservations([process(), process({ rssBytes: 4096 })], memoryOptions());
    expect(rss.observedBytes).toBeNull();
    expect(rss.processes[0].reason).toContain('Conflicting');
    const lifetime = projectMemoryObservations([process(), process({ startTime: 2000 })], memoryOptions());
    expect(lifetime.observedBytes).toBeNull();
    expect(lifetime.processes.every(item => item.state === 'unknown')).toBe(true);
  });

  it('distinguishes an explicit complete empty observation from partial/no observation', () => {
    expect(projectMemoryObservations([], memoryOptions()).observedBytes).toBe(0);
    expect(projectMemoryObservations([], memoryOptions({ coverage: 'partial' })).observedBytes).toBeNull();
    expect(projectMemoryObservations([], memoryOptions({ coverage: 'unknown' })).observedBytes).toBeNull();
  });

  it('does not inflate physical memory or invent a pressure state from huge RSS', () => {
    const result = projectMemoryObservations([process({ rssBytes: 1_000_000_000_000 })], memoryOptions());
    expect(result.physicalMemoryBytes).toBeNull();
    expect(result.pressure.state).toBe('unknown');
  });

  it('keeps unsafe total arithmetic and invalid pressure timestamps unknown', () => {
    const result = projectMemoryObservations([process({ rssBytes: Number.MAX_SAFE_INTEGER }), process({ pid: 200, rssBytes: 1 })], memoryOptions({
      pressure: { state: 'normal', source: 'explicit-os-fixture', observedAt: NaN, freshness: 'current' },
    }));
    expect(result.observedBytes).toBeNull();
    expect(result.coverage).toBe('partial');
    expect(result.pressure).toMatchObject({ observedAt: null, freshness: 'unknown' });
  });

  it('leaves supplied observations immutable', () => {
    const original = process();
    const saved = structuredClone(original);
    const result = projectMemoryObservations([original], memoryOptions());
    result.processes[0].workstreamIds.push('other');
    expect(original).toEqual(saved);
  });
});

describe('Phase 2 advisory dispatch recommendations', () => {
  it('keeps absent/stale observations unknown with no execution permission', () => {
    const resources = projectResources({ workstreams: [], codeburn: [], observedAt: null, freshness: 'unknown', coverage: null });
    const result = evaluateDispatchRecommendation(resources);
    expect(result).toMatchObject({ state: 'insufficient-observation', executionAuthorized: false, enforcement: 'none', executor: 'orca', observationCost: 'projection-only-no-collection' });
    expect(result.reasons.some(reason => reason.code === 'memory-unknown')).toBe(true);
  });

  it('scopes exhausted quota advice to an observed account/window and preserves identity uncertainty', () => {
    const resources = projectCodeBurnResources([quota(100)], 'current');
    const result = evaluateDispatchRecommendation({ quota: resources.quota, memory: normalMemory(), reviewSignals: [clearReview] });
    expect(result.state).toBe('hold-advised');
    expect(result.reasons.find(reason => reason.code === 'quota-exhausted')?.detail).toContain('legacy-account-unknown:codex');
    expect(result.reasons.some(reason => reason.code === 'quota-unknown')).toBe(true);
    expect(result.executionAuthorized).toBe(false);
  });

  it('does not turn stale exhaustion into a current hold claim', () => {
    const resources = projectCodeBurnResources([quota(110)], 'stale');
    const result = evaluateDispatchRecommendation({ quota: resources.quota, memory: normalMemory(), reviewSignals: [clearReview] });
    expect(result.state).toBe('insufficient-observation');
    expect(result.reasons.some(reason => reason.code === 'quota-exhausted')).toBe(false);
    expect(result.reasons.some(reason => reason.code === 'quota-stale')).toBe(true);
  });

  it('uses explicit OS pressure rather than an arbitrary memory threshold', () => {
    const memory = projectMemoryObservations([], memoryOptions({ pressure: {
      state: 'critical', observedAt: now, freshness: 'current', source: 'explicit-os-pressure',
    } }));
    const result = evaluateDispatchRecommendation({ quota: projectAccountQuota([account()]), memory, reviewSignals: [clearReview] });
    expect(result.state).toBe('hold-advised');
    expect(result.reasons.find(reason => reason.code === 'memory-pressure')).toMatchObject({ source: 'explicit-os-pressure', observedAt: now });
  });

  it('holds for explicitly pending review evidence without changing a task lifecycle', () => {
    const signal = { ...clearReview, state: 'pending' as const, reason: 'A policy-required verification has not passed.', kind: 'verification' as const };
    const saved = structuredClone(signal);
    const result = evaluateDispatchRecommendation({ quota: projectAccountQuota([account()]), memory: normalMemory(), reviewSignals: [signal], acknowledged: true });
    expect(result).toMatchObject({ state: 'hold-advised', acknowledged: true, executionAuthorized: false });
    expect(signal).toEqual(saved);
  });

  it('does not call a stale review or mere link an established pending review', () => {
    const result = evaluateDispatchRecommendation({ quota: projectAccountQuota([account()]), memory: normalMemory(),
      reviewSignals: [{ ...clearReview, state: 'pending', freshness: 'stale' }, { ...clearReview, reason: '' }] });
    expect(result.state).toBe('insufficient-observation');
    expect(result.reasons.filter(reason => reason.code === 'signal-pending')).toEqual([]);
  });

  it('never authorizes execution even with complete fresh observations and no hold reason', () => {
    const quota = projectAccountQuota([account(), account('claude-a', { provider: 'claude' })], 'complete');
    const result = evaluateDispatchRecommendation({ quota, memory: normalMemory(), reviewSignals: [clearReview], acknowledged: true });
    expect(result).toMatchObject({ state: 'no-observed-hold', executionAuthorized: false, enforcement: 'none' });
    expect(result.message).toContain('not execution permission');
  });

  it('records explicit advisory policy identity without converting override to permission', () => {
    const policy = { ...DEFAULT_DISPATCH_ADVISORY_POLICY, id: 'user-policy', version: '2', holdForPending: [] };
    const result = evaluateDispatchRecommendation({ quota: projectAccountQuota([account()]), memory: normalMemory(),
      policy, reviewSignals: [{ ...clearReview, state: 'pending' }], acknowledged: true });
    expect(result.policy).toMatchObject({ id: 'user-policy', version: '2' });
    expect(result.reasons.some(reason => reason.code === 'signal-pending')).toBe(false);
    expect(result.executionAuthorized).toBe(false);
  });
});
