import type { LiveWorkspaceView, LiveWorkstreamView } from '../shared/live';
import type { CodeBurnQuery, CodeBurnResult, CodeBurnStatus } from '../summary/budget/codeburn';
import type { AgentProvider } from '../summary/budget';

/** Pure display contracts. This module does not discover files, accounts, or processes. */
export type ResourceFreshness = 'current' | 'stale' | 'unknown';
export type ResourceCoverage = 'complete' | 'partial' | 'unknown';
export interface ResourceProvenance {
  source: string;
  observedAt: number | null;
  lastSuccess: number | null;
  freshness: ResourceFreshness;
  coverage: ResourceCoverage;
}
export interface ResourceCapability {
  state: 'supported' | 'unsupported';
  reason: string;
}
export interface ResourceCapabilities {
  providerUsage: ResourceCapability;
  providerQuota: ResourceCapability;
  multiAccount: ResourceCapability;
  repositoryUsage: ResourceCapability;
  processMemory: ResourceCapability;
  systemMemory: ResourceCapability;
}

/** Describes our adapter, not whether another product might offer an undocumented API. */
export function currentResourceCapabilities(): ResourceCapabilities {
  return {
    providerUsage: { state: 'supported', reason: 'Existing CodeBurn status exposes provider-wide approximate cost and calls; token counts and period boundaries are absent.' },
    providerQuota: { state: 'supported', reason: 'Existing CodeBurn quota exposes provider windows with unknown account identity.' },
    multiAccount: { state: 'unsupported', reason: 'The current collector has no account/profile identity or approved account-specific interface. UsageScope external export/API/CLI was not established; private credentials and caches are not an integration.' },
    repositoryUsage: { state: 'unsupported', reason: 'Current CodeBurn status is provider-wide. A documented branch payload is only a candidate until an authorized collector verifies its identity, scope and coverage.' },
    processMemory: { state: 'unsupported', reason: 'Current Orca observations do not expose OS PID, process start time, RSS, or verified process-to-worktree linkage.' },
    systemMemory: { state: 'unsupported', reason: 'No authorized system memory pressure or swap observation is supplied by the current adapter.' },
  };
}

export interface QuotaWindow {
  windowRef: string;
  label: string;
  usedPct: number | null;
  resetsAt: string | number | null;
  resetTimeFormat: 'unverified' | 'epoch-ms';
}
export interface AccountQuotaObservation extends ResourceProvenance {
  provider: AgentProvider;
  /** Opaque, non-secret references from a verified adapter, never credentials. */
  accountRef: string | null;
  profileRef: string | null;
  quotaData: 'available' | 'unavailable' | 'unknown';
  error: string | null;
  lastAttemptAt?: number | null;
  windows: readonly QuotaWindow[];
}
export interface AccountQuotaView extends ResourceProvenance {
  accountRef: string;
  profileRef: string | null;
  identity: 'verified-reference' | 'legacy-account-unknown';
  quotaData: AccountQuotaObservation['quotaData'];
  error: string | null;
  lastAttemptAt: number | null;
  windows: QuotaWindow[];
  agentAvailability: 'unknown';
}
export interface QuotaView {
  providers: { provider: AgentProvider; accounts: AccountQuotaView[] }[];
  accountCoverage: ResourceCoverage;
  aggregation: 'none';
  reason: string;
}

const providers: readonly AgentProvider[] = ['claude', 'codex'];
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown): number | null => nonnegative(value) ? value : null;
const reference = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim().length > 0;
const unique = (values: readonly string[]) => [...new Set(values.filter(reference))];

/** Explicit observations only; percentages are deliberately never summed or averaged. */
export function projectAccountQuota(observations: readonly AccountQuotaObservation[], accountCoverage: ResourceCoverage = 'unknown'): QuotaView {
  return {
    providers: providers.map(provider => {
      const byAccount = new Map<string, AccountQuotaView>();
      for (const observation of observations.filter(item => item.provider === provider)) {
        const accountRef = reference(observation.accountRef) ? observation.accountRef : `legacy-account-unknown:${provider}`;
        const key = JSON.stringify([observation.source, accountRef, observation.profileRef]);
        const prior = byAccount.get(key);
        const observedAt = timestamp(observation.observedAt);
        const lastAttemptAt = timestamp(observation.lastAttemptAt ?? observation.observedAt);
        if (prior && (prior.lastAttemptAt ?? -1) > (lastAttemptAt ?? -1)) continue;
        const windows = observation.windows.map(window => ({
          windowRef: window.windowRef, label: window.label,
          usedPct: nonnegative(window.usedPct) ? window.usedPct : null,
          resetsAt: window.resetsAt, resetTimeFormat: window.resetTimeFormat,
        }));
        const lastSuccess = timestamp(observation.lastSuccess);
        const freshness = observedAt === null ? 'unknown'
          : observation.error !== null || observation.quotaData !== 'available' ? lastSuccess === null ? 'unknown' : 'stale'
            : observation.freshness;
        byAccount.set(key, {
          accountRef, profileRef: reference(observation.profileRef) ? observation.profileRef : null,
          identity: reference(observation.accountRef) ? 'verified-reference' : 'legacy-account-unknown',
          source: observation.source, observedAt, lastSuccess, lastAttemptAt, freshness,
          coverage: observation.coverage, quotaData: observation.quotaData, error: observation.error,
          windows, agentAvailability: 'unknown',
        });
      }
      return { provider, accounts: [...byAccount.values()] };
    }),
    accountCoverage, aggregation: 'none',
    reason: 'Each account/profile/window is independent. The observed accounts do not establish coverage of all accounts, project consumption, or execution permission.',
  };
}

export interface ProviderUsagePeriod extends ResourceProvenance {
  provider: AgentProvider;
  period: 'today' | 'month';
  window: null;
  calendarBasis: 'unknown';
  scope: 'provider-aggregate';
  currency: string;
  cost: number | null;
  calls: number | null;
  savings: number | null;
  tokens: null;
  approximate: true;
  records: 'reported' | 'no-records' | 'unknown';
  /** Null is a graph gap, including stale/error/no-records observations. */
  chartCost: number | null;
  error: string | null;
}
export interface ResourceUsageView {
  providerPeriods: ProviderUsagePeriod[];
  providerObservations: (ResourceProvenance & { provider: AgentProvider; state: 'observed' | 'failed' | 'unknown'; error: string | null; lastAttemptAt: number | null })[];
  projectTokens: null;
  repositoryUsage: 'unsupported';
  billingAmount: null;
  reason: string;
}

function resultQuery(result: CodeBurnResult): CodeBurnQuery | null {
  return result.ok ? result.value.kind === 'quota' ? 'quota' : `${result.value.provider}-status` : result.error.query;
}
function resultTime(result: CodeBurnResult): number { return timestamp(result.ok ? result.value.observedAt : result.observedAt) ?? -1; }
function latestResults(results: readonly CodeBurnResult[], query: CodeBurnQuery) {
  const matching = results.filter(result => resultQuery(result) === query);
  const successful = matching.filter(result => result.ok).sort((a, b) => resultTime(b) - resultTime(a))[0];
  const failure = matching.filter(result => !result.ok).sort((a, b) => resultTime(b) - resultTime(a))[0];
  return { successful, failure: failure && (!successful || resultTime(failure) >= resultTime(successful)) ? failure : undefined };
}

export function projectCodeBurnResources(results: readonly CodeBurnResult[], freshness: ResourceFreshness = 'unknown'): { quota: QuotaView; usage: ResourceUsageView } {
  const quotaResults = latestResults(results, 'quota');
  const quotaSuccess = quotaResults.successful?.ok && quotaResults.successful.value.kind === 'quota' ? quotaResults.successful.value : null;
  const quotaError = quotaResults.failure && !quotaResults.failure.ok ? quotaResults.failure.error.kind : null;
  const accounts: AccountQuotaObservation[] = providers.map(provider => {
    const value = quotaSuccess?.providers.find(item => item.provider === provider);
    return {
      provider, accountRef: null, profileRef: null, source: 'codeburn-cli:quota',
      observedAt: quotaSuccess?.observedAt ?? null,
      lastAttemptAt: quotaResults.failure ? timestamp(resultTime(quotaResults.failure)) : quotaSuccess?.observedAt ?? null,
      lastSuccess: value?.quotaData === 'available' ? quotaSuccess?.observedAt ?? null : null,
      freshness: quotaSuccess ? quotaError ? 'stale' : freshness : 'unknown',
      coverage: 'unknown', quotaData: value?.quotaData ?? 'unknown',
      error: quotaError ?? (value?.error === 'none' ? null : value?.error ?? 'not-observed'),
      windows: value?.windows.map((window, index) => ({ ...window, windowRef: `legacy-window:${provider}:${index}` })) ?? [],
    };
  });
  const providerPeriods: ProviderUsagePeriod[] = [];
  const providerObservations: ResourceUsageView['providerObservations'] = [];
  for (const provider of providers) {
    const { successful, failure } = latestResults(results, `${provider}-status`);
    const status: CodeBurnStatus | null = successful?.ok && successful.value.kind === 'status' ? successful.value : null;
    providerObservations.push({
      provider, state: failure ? 'failed' : status ? 'observed' : 'unknown',
      error: failure && !failure.ok ? failure.error.kind : null, source: `codeburn-cli:${provider}-status`,
      observedAt: status?.observedAt ?? null, lastSuccess: status?.observedAt ?? null,
      lastAttemptAt: failure ? timestamp(resultTime(failure)) : status?.observedAt ?? null,
      freshness: status ? failure ? 'stale' : freshness : 'unknown', coverage: 'unknown',
    });
    if (!status) continue;
    const state: ResourceFreshness = failure ? 'stale' : freshness;
    for (const period of status.periods) {
      const records = status.hasUsage === false || period.hasUsage === false ? 'no-records'
        : period.hasUsage === true || status.hasUsage === true ? 'reported' : 'unknown';
      const cost = records === 'no-records' || !nonnegative(period.cost) ? null : period.cost;
      providerPeriods.push({
        provider, period: period.label, window: null, calendarBasis: 'unknown', scope: 'provider-aggregate',
        source: `codeburn-cli:${provider}-status`, observedAt: status.observedAt, lastSuccess: status.observedAt,
        freshness: state, coverage: 'unknown', currency: status.currency, cost,
        calls: records === 'no-records' || !nonnegative(period.calls) ? null : period.calls,
        savings: records === 'no-records' || !nonnegative(period.savings) ? null : period.savings,
        tokens: null, approximate: true, records,
        chartCost: state === 'current' && records === 'reported' ? cost : null,
        error: failure && !failure.ok ? failure.error.kind : null,
      });
    }
  }
  return {
    quota: projectAccountQuota(accounts),
    usage: {
      providerPeriods, providerObservations, projectTokens: null, repositoryUsage: 'unsupported', billingAmount: null,
      reason: 'Provider-wide recorded estimates are not project/repository usage, token counts, or bills. Today/month can overlap; period boundaries and timezone are unknown. Missing records are not zero.',
    },
  };
}

export interface TaskLinkageObservation {
  state: 'linked' | 'unlinked' | 'unknown';
  taskIds: readonly string[];
  evidence: string | null;
}
export interface WorkstreamResourceView extends ResourceProvenance {
  workstreamId: string;
  title: string;
  tier: 'registered-project' | 'repository-unregistered' | 'repository-unknown';
  repository: { key: string; id: string; hostId: string; label: string; evidence: 'observed-orca-repository-id' } | null;
  /** A display reference, not an asserted canonical checkout path or session ID. */
  checkoutRef: string;
  projectId: string | null;
  taskLinkage: { state: TaskLinkageObservation['state']; taskIds: string[]; reason: string };
  activity: 'observed-activity' | 'no-observed-activity' | 'unknown';
  memoryBytes: null;
  historicalTokens: null;
  reason: string;
}

export function projectWorkstreamResources(
  workstreams: readonly LiveWorkstreamView[],
  provenance: Pick<ResourceProvenance, 'observedAt' | 'freshness' | 'coverage'>,
  taskLinkage: Readonly<Record<string, TaskLinkageObservation>> = {},
): WorkstreamResourceView[] {
  return workstreams.map(workstream => {
    const source = workstream.repository;
    const repository = source && reference(source.key) && reference(source.hostId) && reference(source.id)
      ? { key: source.key, id: source.id, hostId: source.hostId, label: source.label, evidence: 'observed-orca-repository-id' as const } : null;
    const registered = !!workstream.project || (workstream.noteMapping.state === 'resolved' && reference(workstream.noteMapping.dagId));
    const explicitLink = Object.hasOwn(taskLinkage, workstream.id) ? taskLinkage[workstream.id] : undefined;
    const ids = unique(explicitLink?.taskIds ?? []);
    const linkState = reference(explicitLink?.evidence) && (explicitLink?.state === 'unlinked' && ids.length === 0 || explicitLink?.state === 'linked' && ids.length > 0)
      ? explicitLink!.state : 'unknown';
    const retained = workstream.project?.worktreeState === 'missing' || workstream.observation?.worktree === 'not-observed';
    return {
      workstreamId: workstream.id, title: workstream.title,
      tier: registered ? 'registered-project' : repository ? 'repository-unregistered' : 'repository-unknown',
      repository, checkoutRef: workstream.id, projectId: registered ? workstream.id : null,
      taskLinkage: { state: linkState, taskIds: linkState === 'linked' ? ids : [], reason: linkState === 'unknown'
        ? 'No verified task linkage observation. A missing DAG task ID does not establish an untracked task.' : explicitLink!.evidence! },
      activity: retained || workstream.observation?.worktree !== 'observed' ? 'unknown'
        : workstream.observation.sidebarActivity === true ? 'observed-activity'
          : workstream.observation.sidebarActivity === false ? 'no-observed-activity' : 'unknown',
      source: 'orca-live-workstream', observedAt: timestamp(provenance.observedAt), lastSuccess: timestamp(provenance.observedAt),
      freshness: retained ? 'stale' : provenance.freshness, coverage: provenance.coverage,
      memoryBytes: null, historicalTokens: null,
      reason: repository ? 'Repository identity follows the observed host/repository IDs; checkout references remain separate. Sidebar activity is not a process count.'
        : 'Repository identity is unverified. Names, branch labels and similarly named remotes do not establish identity.',
    };
  });
}

export interface ProcessMemoryObservation {
  hostId: string | null;
  pid: number | null;
  /** Epoch milliseconds, supplied by an authorized process observation. */
  startTime: number | null;
  observedAt: number | null;
  rssBytes: number | null;
  state: 'running' | 'exited' | 'unknown';
  workstreamIds: readonly string[];
  linkage: 'verified' | 'unknown';
  source: string;
}
export interface MemoryProcessView {
  identity: string | null;
  hostId: string | null;
  pid: number | null;
  startTime: number | null;
  observedAt: number | null;
  rssBytes: number | null;
  state: ProcessMemoryObservation['state'] | 'superseded';
  ownership: 'exclusive' | 'shared' | 'unattributed';
  workstreamIds: string[];
  sources: string[];
  reason: string | null;
}
export interface MemoryBucket {
  workstreamId: string | null;
  observedBytes: number | null;
  processCount: number;
  unknownProcessCount: number;
}
export interface MemoryView extends ResourceProvenance {
  capability: ResourceCapability;
  metric: 'rss-bytes';
  processes: MemoryProcessView[];
  exclusive: MemoryBucket[];
  shared: MemoryBucket;
  unattributed: MemoryBucket;
  observedBytes: number | null;
  /** Whole-machine physical usage is not the sum of process RSS. */
  physicalMemoryBytes: null;
  pressure: { state: 'normal' | 'warning' | 'critical' | 'unknown'; observedAt: number | null; source: string; freshness: ResourceFreshness };
  reason: string;
}
export interface MemoryProjectionOptions extends ResourceProvenance {
  capability: ResourceCapability;
  pressure?: MemoryView['pressure'];
}

/** No discovery or process access. Deduplicate only explicitly supplied PID lifetimes. */
export function projectMemoryObservations(observations: readonly ProcessMemoryObservation[], options: MemoryProjectionOptions): MemoryView {
  const processes: MemoryProcessView[] = [];
  const groups = new Map<string, ProcessMemoryObservation[]>();
  if (options.capability.state === 'supported') for (const observation of observations) {
    const valid = reference(observation.hostId) && Number.isSafeInteger(observation.pid) && observation.pid! > 0
      && timestamp(observation.startTime) !== null && timestamp(observation.observedAt) !== null
      && observation.startTime! <= observation.observedAt!;
    if (!valid) {
      processes.push({ identity: null, hostId: observation.hostId, pid: observation.pid, startTime: timestamp(observation.startTime),
        observedAt: timestamp(observation.observedAt), rssBytes: null, state: 'unknown', ownership: 'unattributed',
        workstreamIds: [], sources: [observation.source], reason: 'Missing or invalid host/PID/startTime observation; safe deduplication is unavailable.' });
      continue;
    }
    const identity = JSON.stringify([observation.hostId, observation.pid, observation.startTime]);
    const values = groups.get(identity) ?? [];
    values.push(observation); groups.set(identity, values);
  }
  for (const [identity, values] of groups) {
    const observedAt = Math.max(...values.map(value => value.observedAt!));
    const latest = values.filter(value => value.observedAt === observedAt);
    const value = latest[0];
    const states = new Set(latest.map(item => item.state));
    const samples = new Set(latest.map(item => nonnegative(item.rssBytes) && Number.isSafeInteger(item.rssBytes) ? item.rssBytes : null));
    const state = states.size === 1 ? value.state : 'unknown';
    const workstreamIds = unique(latest.filter(item => item.linkage === 'verified').flatMap(item => [...item.workstreamIds]));
    const completeLinkage = latest.every(item => item.linkage === 'verified');
    const ownership = !completeLinkage || !workstreamIds.length ? 'unattributed' : workstreamIds.length === 1 ? 'exclusive' : 'shared';
    processes.push({ identity, hostId: value.hostId, pid: value.pid, startTime: value.startTime, observedAt,
      rssBytes: state === 'running' && samples.size === 1 ? [...samples][0] : null, state, ownership,
      workstreamIds, sources: unique(latest.map(item => item.source)),
      reason: states.size > 1 || samples.size > 1 ? 'Conflicting simultaneous process observations; usage is unknown.' : null });
  }
  // PID reuse must neither merge lifetimes nor count a replaced lifetime as current.
  for (const process of processes.filter(item => item.identity !== null)) {
    const samePid = processes.filter(item => item.identity !== null && item.hostId === process.hostId && item.pid === process.pid);
    const newest = Math.max(...samePid.map(item => item.observedAt!));
    if (process.observedAt! < newest) { process.state = 'superseded'; process.rssBytes = null; process.reason = 'A newer observation reports another lifetime for this PID.'; }
    else if (samePid.filter(item => item.observedAt === newest).length > 1) {
      process.state = 'unknown'; process.rssBytes = null; process.reason = 'Conflicting process lifetimes at the same observation time.';
    }
  }
  const current = processes.filter(process => process.state !== 'exited' && process.state !== 'superseded');
  const complete = options.coverage === 'complete' && current.every(process => process.identity !== null && process.state === 'running' && process.rssBytes !== null && process.ownership !== 'unattributed')
    && Number.isSafeInteger(current.reduce((sum, process) => sum + (process.rssBytes ?? 0), 0));
  const emptyKnown = options.capability.state === 'supported' && complete;
  const bucket = (rows: MemoryProcessView[], workstreamId: string | null): MemoryBucket => {
    const measured = rows.filter(process => process.rssBytes !== null);
    const sum = measured.reduce((total, process) => total + process.rssBytes!, 0);
    return { workstreamId, observedBytes: (measured.length || emptyKnown && !rows.length) && Number.isSafeInteger(sum) ? sum : null,
      processCount: rows.length, unknownProcessCount: rows.filter(process => process.rssBytes === null).length };
  };
  const total = bucket(current, null);
  return {
    source: options.source, observedAt: options.capability.state === 'supported' ? timestamp(options.observedAt) : null,
    lastSuccess: options.capability.state === 'supported' ? timestamp(options.lastSuccess) : null,
    freshness: options.capability.state === 'supported' && timestamp(options.observedAt) !== null ? options.freshness : 'unknown',
    coverage: options.capability.state === 'supported' ? options.coverage === 'complete' && !complete ? 'partial' : options.coverage : 'unknown',
    capability: { ...options.capability }, metric: 'rss-bytes', processes,
    exclusive: unique(current.filter(process => process.ownership === 'exclusive').flatMap(process => process.workstreamIds))
      .map(id => bucket(current.filter(process => process.ownership === 'exclusive' && process.workstreamIds[0] === id), id)),
    shared: bucket(current.filter(process => process.ownership === 'shared'), null),
    unattributed: bucket(current.filter(process => process.ownership === 'unattributed'), null), observedBytes: total.observedBytes,
    physicalMemoryBytes: null,
    pressure: options.pressure ? { ...options.pressure, observedAt: timestamp(options.pressure.observedAt),
      freshness: timestamp(options.pressure.observedAt) === null ? 'unknown' : options.pressure.freshness }
      : { state: 'unknown', source: 'not-observed', observedAt: null, freshness: 'unknown' },
    reason: 'RSS covers only supplied observations. Shared PIDs are counted once globally, never allocated to each project; physical shared pages between different PIDs cannot be deduplicated from RSS. Missing observations are not zero.',
  };
}

export interface ResourceProjectionInput {
  workstreams: readonly LiveWorkstreamView[];
  codeburn: readonly CodeBurnResult[];
  observedAt: string | number | null;
  freshness: ResourceFreshness;
  coverage: LiveWorkspaceView['coverage'];
  taskLinkage?: Readonly<Record<string, TaskLinkageObservation>>;
}
export function projectResources(input: ResourceProjectionInput) {
  const capabilities = currentResourceCapabilities();
  const observedAt = typeof input.observedAt === 'string' ? timestamp(Date.parse(input.observedAt)) : timestamp(input.observedAt);
  return {
    capabilities, ...projectCodeBurnResources(input.codeburn, input.freshness),
    workstreams: projectWorkstreamResources(input.workstreams, { observedAt, freshness: input.freshness, coverage: input.coverage?.worktrees ?? 'unknown' }, input.taskLinkage),
    memory: projectMemoryObservations([], { capability: capabilities.processMemory, source: 'orca-live-adapter', observedAt: null, lastSuccess: null, freshness: 'unknown', coverage: 'unknown' }),
  };
}
