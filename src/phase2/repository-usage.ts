import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { finalizeQueryGroup } from '../collector/orca/process-group';
import type { CodeBurnFailure, CodeBurnOptions } from '../summary/budget/codeburn';
import type { ResourceFreshness } from './resources';

/** Verified against getagentseal/codeburn v0.9.25; this is not a version probe. */
export const REPOSITORY_USAGE_SOURCE = 'codeburn-cli:spend:branch-json' as const;
export type RepositoryUsagePeriod = 'today' | 'month';
export interface RepositoryTokenSplit {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface RepositoryBranchCoverage {
  branchKnownCost: number;
  branchUnknownCost: number;
  noBranchDataCost: number;
  noBranchDataSessions: number;
  noBranchDataProviders: string[];
  /** Project scope counts branch-bearing sessions; report scope includes no-branch sessions. */
  distinctSessions: number;
}
export interface RepositoryUsageSession {
  sessionId: string;
  provider: string;
  workingDirectory: string | null;
  isSidechain: boolean | null;
  cost: number;
  calls: number;
  tokens: RepositoryTokenSplit;
  firstActive: string | null;
  lastActive: string | null;
}
export interface RepositoryUsageBranch {
  branch: string | null;
  cost: number;
  calls: number;
  sessions: number;
  tokens: RepositoryTokenSplit;
  firstActive: string | null;
  lastActive: string | null;
  worktrees: { path: string; sessions: number; cost: number }[];
  sessionRows: RepositoryUsageSession[];
}
export interface RepositoryUsageProject {
  codeburnProjectId: string;
  label: string;
  /** Source-reported evidence only, never an authorization or a matching key. */
  originKey: string | null;
  totalCost: number;
  coverageEvidence: RepositoryBranchCoverage;
  branches: RepositoryUsageBranch[];
}
export interface RepositoryUsageObservation {
  source: typeof REPOSITORY_USAGE_SOURCE;
  contract: 'codeburn-0.9.25-branch-json';
  query: RepositoryUsagePeriod;
  observedAt: number;
  period: { label: string; start: string; end: string; calendarBasis: 'source-local-timezone-unknown'; endInclusive: true };
  currency: 'USD';
  approximate: true;
  /** Parsing success establishes transport completeness, not completeness of local usage sources. */
  coverage: 'unknown';
  projects: RepositoryUsageProject[];
  totals: RepositoryBranchCoverage;
}
export type RepositoryUsageResult =
  | { ok: true; value: RepositoryUsageObservation; diagnostics?: { stderrReported: true } }
  | { ok: false; observedAt: number; error: { kind: CodeBurnFailure; query: RepositoryUsagePeriod | null }; diagnostics?: { stderrReported: true } };

const commands = Object.freeze({
  today: Object.freeze(['spend', '--format', 'branch-json', '--period', 'today', '--provider', 'all']),
  month: Object.freeze(['spend', '--format', 'branch-json', '--period', 'month', '--provider', 'all']),
});
const tokenKeys = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
const isQuery = (value: unknown): value is RepositoryUsagePeriod => typeof value === 'string' && Object.hasOwn(commands, value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => number(value) && Number.isSafeInteger(value);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const iso = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
/** Session timestamps are provider-recorded ISO values, not necessarily Date.toISOString output. */
const activeTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)) return false;
  return iso(`${value.slice(0, 10)}T00:00:00.000Z`) && Number.isFinite(Date.parse(value));
};
const fail = (kind: CodeBurnFailure, query: RepositoryUsagePeriod | null, observedAt = Date.now()): RepositoryUsageResult =>
  ({ ok: false, observedAt, error: { kind, query } });

function tokens(value: unknown): RepositoryTokenSplit | null {
  if (!record(value) || !tokenKeys.every(key => integer(value[key]))) return null;
  return Object.fromEntries(tokenKeys.map(key => [key, value[key]])) as unknown as RepositoryTokenSplit;
}
function coverage(value: unknown): RepositoryBranchCoverage | null {
  if (!record(value) || !number(value.branchKnownCost) || !number(value.branchUnknownCost) || !number(value.noBranchDataCost)
    || !integer(value.noBranchDataSessions) || !integer(value.distinctSessions) || !Array.isArray(value.noBranchDataProviders)
    || value.noBranchDataProviders.length > 128 || !value.noBranchDataProviders.every(item => text(item, 120))
    || new Set(value.noBranchDataProviders).size !== value.noBranchDataProviders.length) return null;
  return { branchKnownCost: value.branchKnownCost, branchUnknownCost: value.branchUnknownCost,
    noBranchDataCost: value.noBranchDataCost, noBranchDataSessions: value.noBranchDataSessions,
    noBranchDataProviders: [...value.noBranchDataProviders], distinctSessions: value.distinctSessions };
}
function activeRange(value: Record<string, unknown>): boolean {
  return (value.firstActive === null || activeTimestamp(value.firstActive)) && (value.lastActive === null || activeTimestamp(value.lastActive))
    && ((value.firstActive === null && value.lastActive === null)
      || (typeof value.firstActive === 'string' && typeof value.lastActive === 'string' && Date.parse(value.firstActive) <= Date.parse(value.lastActive)));
}
const sameCost = (a: number, b: number): boolean => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1, a, b) * 1e-8;
function sumTokens(values: readonly RepositoryTokenSplit[]): RepositoryTokenSplit | null {
  const total = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const value of values) for (const key of tokenKeys) {
    total[key] += value[key];
    if (!integer(total[key])) return null;
  }
  return total;
}

/** Strict known-field decoder; extra fields, transcript titles and model labels are not projected. */
export function decodeRepositoryUsage(query: RepositoryUsagePeriod, input: unknown, observedAt: number): RepositoryUsageResult {
  if (!isQuery(query)) return fail('forbidden-query', null, observedAt);
  const invalid = () => fail('invalid-schema', query, observedAt);
  if (!integer(observedAt) || !record(input) || !record(input.period) || !text(input.period.label, 160)
    || !iso(input.period.start) || !iso(input.period.end) || input.period.start > input.period.end
    || !Array.isArray(input.projects) || input.projects.length > 1000) return invalid();
  const totals = coverage(input.totals);
  if (!totals) return invalid();
  const projects: RepositoryUsageProject[] = [];
  const projectIds = new Set<string>();
  let rowCount = 0;
  for (const raw of input.projects) {
    if (!record(raw) || !text(raw.id) || !text(raw.label, 512) || projectIds.has(raw.id) || !number(raw.totalCost)
      || (raw.originKey !== undefined && raw.originKey !== null && !text(raw.originKey))
      || !Array.isArray(raw.branches) || raw.branches.length > 2000) return invalid();
    projectIds.add(raw.id);
    const evidence = coverage(raw.coverage);
    if (!evidence) return invalid();
    const branches: RepositoryUsageBranch[] = [];
    const branchNames = new Set<string | null>();
    const distinctSessions = new Set<string>();
    for (const rawBranch of raw.branches) {
      if (++rowCount > 20_000 || !record(rawBranch) || rawBranch.projectId !== raw.id || rawBranch.projectLabel !== raw.label
        || !(rawBranch.branch === null || text(rawBranch.branch, 512)) || branchNames.has(rawBranch.branch)
        || !number(rawBranch.cost) || !integer(rawBranch.calls) || !integer(rawBranch.sessions) || !activeRange(rawBranch)
        || !Array.isArray(rawBranch.worktrees) || rawBranch.worktrees.length > 5000
        || !Array.isArray(rawBranch.sessionRows) || rawBranch.sessionRows.length > 10_000) return invalid();
      branchNames.add(rawBranch.branch);
      const branchTokens = tokens(rawBranch.tokens);
      if (!branchTokens) return invalid();
      const worktrees: RepositoryUsageBranch['worktrees'] = [];
      const paths = new Set<string>();
      for (const worktree of rawBranch.worktrees) {
        if (++rowCount > 20_000 || !record(worktree) || !text(worktree.path) || paths.has(worktree.path)
          || !integer(worktree.sessions) || !number(worktree.cost)) return invalid();
        paths.add(worktree.path);
        worktrees.push({ path: worktree.path, sessions: worktree.sessions, cost: worktree.cost });
      }
      const sessionRows: RepositoryUsageSession[] = [];
      const sessionKeys = new Set<string>();
      const worktreeTotals = new Map<string, { sessions: number; cost: number }>();
      for (const session of rawBranch.sessionRows) {
        if (++rowCount > 20_000 || !record(session) || !text(session.sessionId, 512) || !text(session.provider, 120)
          || (session.workingDirectory !== undefined && !text(session.workingDirectory))
          || (session.isSidechain !== undefined && typeof session.isSidechain !== 'boolean')
          || !number(session.cost) || !integer(session.calls) || !activeRange(session)
          || !Array.isArray(session.models) || session.models.length > 256 || !session.models.every(item => text(item, 512))) return invalid();
        const split = tokens(session.tokens);
        const key = JSON.stringify([session.provider, session.sessionId]);
        if (!split || sessionKeys.has(key)) return invalid();
        sessionKeys.add(key); distinctSessions.add(key);
        if (typeof session.workingDirectory === 'string') {
          const total = worktreeTotals.get(session.workingDirectory) ?? { sessions: 0, cost: 0 };
          total.sessions++; total.cost += session.cost;
          worktreeTotals.set(session.workingDirectory, total);
        }
        sessionRows.push({ sessionId: session.sessionId, provider: session.provider,
          workingDirectory: session.workingDirectory as string | undefined ?? null,
          isSidechain: session.isSidechain as boolean | undefined ?? null,
          cost: session.cost, calls: session.calls, tokens: split,
          firstActive: session.firstActive as string | null, lastActive: session.lastActive as string | null });
      }
      const summed = sumTokens(sessionRows.map(session => session.tokens));
      if (!summed || !tokenKeys.every(key => summed[key] === branchTokens[key]) || rawBranch.sessions !== sessionRows.length
        || !sameCost(rawBranch.cost, sessionRows.reduce((sum, session) => sum + session.cost, 0))
        || rawBranch.calls !== sessionRows.reduce((sum, session) => sum + session.calls, 0)) return invalid();
      for (const worktree of worktrees) {
        const total = worktreeTotals.get(worktree.path);
        if (!total || worktree.sessions !== total.sessions || !sameCost(worktree.cost, total.cost)) return invalid();
      }
      if (sessionRows.some(session => session.workingDirectory !== null && !paths.has(session.workingDirectory))) return invalid();
      branches.push({ branch: rawBranch.branch, cost: rawBranch.cost, calls: rawBranch.calls, sessions: rawBranch.sessions,
        tokens: branchTokens, firstActive: rawBranch.firstActive as string | null, lastActive: rawBranch.lastActive as string | null,
        worktrees, sessionRows });
    }
    if (evidence.distinctSessions !== distinctSessions.size
      || !sameCost(evidence.branchKnownCost, branches.filter(branch => branch.branch !== null).reduce((sum, branch) => sum + branch.cost, 0))
      || !sameCost(evidence.branchUnknownCost, branches.filter(branch => branch.branch === null).reduce((sum, branch) => sum + branch.cost, 0))
      || !sameCost(raw.totalCost, evidence.branchKnownCost + evidence.branchUnknownCost + evidence.noBranchDataCost)) return invalid();
    projects.push({ codeburnProjectId: raw.id, label: raw.label, originKey: raw.originKey as string | null | undefined ?? null,
      totalCost: raw.totalCost, coverageEvidence: evidence, branches });
  }
  for (const key of ['branchKnownCost', 'branchUnknownCost', 'noBranchDataCost'] as const)
    if (!sameCost(totals[key], projects.reduce((sum, project) => sum + project.coverageEvidence[key], 0))) return invalid();
  if (totals.noBranchDataSessions !== projects.reduce((sum, project) => sum + project.coverageEvidence.noBranchDataSessions, 0)) return invalid();
  return { ok: true, value: { source: REPOSITORY_USAGE_SOURCE, contract: 'codeburn-0.9.25-branch-json', query, observedAt,
    period: { label: input.period.label, start: input.period.start, end: input.period.end,
      calendarBasis: 'source-local-timezone-unknown', endInclusive: true }, currency: 'USD', approximate: true,
    coverage: 'unknown', projects, totals } };
}

export interface ObservedRepositoryCheckout {
  workstreamId: string;
  hostId: string;
  repositoryId: string | null;
  repositoryKey: string | null;
  /** Already observed local path. No realpath, Git lookup, directory traversal, or basename matching is performed. */
  checkoutPath: string;
  registeredProjectId: string | null;
}
export interface RepositoryUsageContext { localHostId: string; checkouts: readonly ObservedRepositoryCheckout[] }
export interface RepositoryUsageMatch {
  state: 'matched' | 'unknown' | 'conflict';
  tier: 'registered-project' | 'repository-unregistered' | 'repository-unknown';
  evidence: 'exact-observed-local-checkout-path' | null;
  repository: { key: string; id: string; hostId: string } | null;
  /** Paths and workstream IDs remain separate even when the repository identity is shared. */
  checkouts: ObservedRepositoryCheckout[];
  workstreamIds: string[];
  reason: string;
}
export interface RepositoryUsageProjectView extends Omit<RepositoryUsageProject, 'branches'> {
  match: RepositoryUsageMatch;
  currency: 'USD';
  approximate: true;
  /** Branch-bearing recorded population only, never inferred from cost or quota. */
  branchTokens: RepositoryTokenSplit | null;
  /** Null when any sessions lack branch metadata, or no branch records exist. */
  tokens: RepositoryTokenSplit | null;
  chartCost: number | null;
  branches: (Omit<RepositoryUsageBranch, 'sessionRows'> & { sessionRows: (RepositoryUsageSession & {
    match: RepositoryUsageMatch;
    taskLinkage: { state: 'unknown'; taskIds: []; reason: string };
    accountRef: null;
  })[] })[];
}
export interface RepositoryUsageView {
  source: typeof REPOSITORY_USAGE_SOURCE;
  state: 'observed' | 'failed' | 'unknown';
  query: RepositoryUsagePeriod | null;
  observedAt: number | null;
  lastAttemptAt: number | null;
  lastSuccess: number | null;
  freshness: ResourceFreshness;
  coverage: 'unknown';
  period: RepositoryUsageObservation['period'] | null;
  projects: RepositoryUsageProjectView[];
  totals: RepositoryBranchCoverage | null;
  error: CodeBurnFailure | null;
  reason: string;
}

function matchCheckout(path: string | null, context: RepositoryUsageContext | null, index: ReadonlyMap<string, readonly ObservedRepositoryCheckout[]>): RepositoryUsageMatch {
  const unknown = (reason: string, state: 'unknown' | 'conflict' = 'unknown'): RepositoryUsageMatch => ({
    state, tier: 'repository-unknown', evidence: null, repository: null, checkouts: [], workstreamIds: [], reason,
  });
  // Do not normalize '..', symlinks, case, basenames, remote names or source originKey into identity.
  if (!path || !isAbsolute(path) || path.split(/[\\/]/u).some(part => part === '.' || part === '..'))
    return unknown('No absolute historical checkout path is available; project labels are not repository identity.');
  if (!context || !text(context.localHostId, 512) || context.checkouts.length > 10_000)
    return unknown('No bounded, verified local-host checkout context is available.');
  const matches = index.get(path) ?? [];
  if (!matches.length) return unknown('The historical path is not an already observed local checkout; no directory search or remote-only match was attempted.');
  if (matches.some(checkout => !text(checkout.workstreamId, 512) || !text(checkout.repositoryId, 512) || !text(checkout.repositoryKey, 1024)))
    return unknown('The matching local checkout has no verified repository identity; non-Git and unobserved repositories remain unknown.');
  const identities = new Set(matches.map(checkout => JSON.stringify([checkout.hostId, checkout.repositoryId, checkout.repositoryKey])));
  if (identities.size !== 1) return unknown('Conflicting observed repository identities share this local checkout path.', 'conflict');
  const first = matches[0];
  const checkouts = [...new Map(matches.map(checkout => [checkout.workstreamId, {
    workstreamId: checkout.workstreamId, hostId: checkout.hostId, repositoryId: checkout.repositoryId,
    repositoryKey: checkout.repositoryKey, checkoutPath: checkout.checkoutPath,
    registeredProjectId: text(checkout.registeredProjectId, 512) ? checkout.registeredProjectId : null,
  }])).values()];
  return { state: 'matched', tier: checkouts.some(checkout => checkout.registeredProjectId !== null) ? 'registered-project' : 'repository-unregistered',
    evidence: 'exact-observed-local-checkout-path', repository: { key: first.repositoryKey!, id: first.repositoryId!, hostId: first.hostId },
    checkouts, workstreamIds: checkouts.map(checkout => checkout.workstreamId),
    reason: 'Exact historical path matches an observed checkout on the collector host; this is path correspondence, not proof of unchanged historical ownership.' };
}

/** Pure detached view. A failed refresh may retain a supplied same-query last success as stale. */
export function projectRepositoryUsage(
  result: RepositoryUsageResult | null,
  context: RepositoryUsageContext | null,
  freshness: ResourceFreshness = 'unknown',
  lastSuccessful?: RepositoryUsageObservation,
): RepositoryUsageView {
  const prior = result && !result.ok && lastSuccessful?.query === result.error.query && lastSuccessful.observedAt <= result.observedAt ? lastSuccessful : null;
  const observation = result?.ok ? result.value : prior;
  const state = result === null ? 'unknown' : result.ok ? 'observed' : 'failed';
  const currentFreshness = observation ? state === 'failed' ? 'stale' : freshness : 'unknown';
  const checkoutIndex = new Map<string, ObservedRepositoryCheckout[]>();
  if (context && text(context.localHostId, 512) && context.checkouts.length <= 10_000) {
    for (const checkout of context.checkouts) if (checkout.hostId === context.localHostId) {
      const checkouts = checkoutIndex.get(checkout.checkoutPath) ?? [];
      checkouts.push(checkout); checkoutIndex.set(checkout.checkoutPath, checkouts);
    }
  }
  return {
    source: REPOSITORY_USAGE_SOURCE, state, query: result?.ok ? result.value.query : result?.error.query ?? null,
    observedAt: observation?.observedAt ?? null, lastAttemptAt: result?.ok ? result.value.observedAt : result?.observedAt ?? null,
    lastSuccess: observation?.observedAt ?? null, freshness: currentFreshness, coverage: 'unknown',
    period: observation ? { ...observation.period } : null,
    projects: observation?.projects.map(project => {
      const branchTokens = project.branches.length ? sumTokens(project.branches.map(branch => branch.tokens)) : null;
      return { ...project, coverageEvidence: { ...project.coverageEvidence, noBranchDataProviders: [...project.coverageEvidence.noBranchDataProviders] },
        match: matchCheckout(project.codeburnProjectId, context, checkoutIndex), currency: 'USD', approximate: true,
        branchTokens, tokens: project.coverageEvidence.noBranchDataSessions === 0 && project.coverageEvidence.noBranchDataCost === 0 ? branchTokens && { ...branchTokens } : null,
        chartCost: currentFreshness === 'current' ? project.totalCost : null,
        branches: project.branches.map(branch => ({ ...branch, tokens: { ...branch.tokens }, worktrees: branch.worktrees.map(worktree => ({ ...worktree })),
          sessionRows: branch.sessionRows.map(session => ({ ...session, tokens: { ...session.tokens }, match: matchCheckout(session.workingDirectory, context, checkoutIndex),
            accountRef: null, taskLinkage: { state: 'unknown', taskIds: [],
              reason: 'The branch report supplies no DAG task linkage. A missing task ID is not evidence of an untracked task.' } })) })),
      };
    }) ?? [],
    totals: observation ? { ...observation.totals, noBranchDataProviders: [...observation.totals.noBranchDataProviders] } : null,
    error: result && !result.ok ? result.error.kind : null,
    reason: 'Recorded historical usage only. Coverage of all accounts and source files is unknown. No-branch sessions lack token and checkout detail. Costs are USD estimates, not bills or quota; missing projects are not zero. Origin keys never merge local checkouts.',
  };
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw new Error('Invalid repository usage collector limit.');
  return selected;
}

/** Main process only. Fixed reporting argv; no renderer-controlled path, shell, cwd, environment, or cache access. */
export function createRepositoryUsageReader(options: CodeBurnOptions): {
  read(query: RepositoryUsagePeriod, request?: { signal?: AbortSignal }): Promise<RepositoryUsageResult>;
} {
  if (!options || typeof options.executablePath !== 'string' || !isAbsolute(options.executablePath)
    || /[\u0000-\u001f\u007f]/u.test(options.executablePath)) throw new Error('CodeBurn executable must be a trusted absolute path.');
  const executable = options.executablePath;
  const timeoutMs = limit(options.timeoutMs, 5000, 60_000);
  const maxOutputBytes = limit(options.maxOutputBytes, 512 * 1024, 2 * 1024 * 1024);
  let busy = false;
  let cleanupUnverified = false;
  return {
    async read(query, request = {}) {
      if (!isQuery(query)) return fail('forbidden-query', null);
      if (cleanupUnverified) return fail('cleanup-unverified', query);
      if (busy) return fail('busy', query);
      if (request.signal?.aborted) return fail('cancelled', query);
      busy = true;
      try {
        return await new Promise<RepositoryUsageResult>(resolve => {
          let chunks: Buffer[] = [];
          let bytes = 0;
          let stderrReported = false;
          let stopped: CodeBurnFailure | null = null;
          let settled = false;
          let cleanup: Promise<boolean> | null = null;
          let child;
          try {
            child = spawn(executable, [...commands[query]], { shell: false, windowsHide: true,
              detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
          } catch { resolve(fail('spawn-failed', query)); return; }
          const wipe = (): void => { for (const chunk of chunks) chunk.fill(0); chunks = []; };
          const finish = (result: RepositoryUsageResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onAbort);
            wipe();
            resolve(stderrReported ? { ...result, diagnostics: { stderrReported: true } } : result);
          };
          const startCleanup = (): Promise<boolean> => {
            if (cleanup) return cleanup;
            cleanup = finalizeQueryGroup(child).catch(() => false);
            void cleanup.then(verified => {
              if (!verified) {
                cleanupUnverified = true;
                child.stdout.destroy(); child.stderr.destroy();
                finish(fail('cleanup-unverified', query));
              }
            });
            return cleanup;
          };
          const stop = (kind: CodeBurnFailure): void => {
            if (stopped || settled) return;
            stopped = kind;
            wipe(); child.stdout.destroy(); child.stderr.destroy();
            void startCleanup();
          };
          const timer = setTimeout(() => stop('timeout'), timeoutMs);
          const onAbort = (): void => stop('cancelled');
          request.signal?.addEventListener('abort', onAbort, { once: true });
          if (request.signal?.aborted) onAbort();
          const receive = (chunk: Buffer, retain: boolean): void => {
            if (stopped || settled) return;
            if (!retain && chunk.byteLength) stderrReported = true;
            bytes += chunk.byteLength;
            if (bytes > maxOutputBytes) { stop('output-limit'); return; }
            if (retain) chunks.push(Buffer.from(chunk));
          };
          child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
          child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
          child.stdout.on('error', () => stop('command-failed'));
          child.stderr.on('error', () => stop('command-failed'));
          child.once('error', (error: NodeJS.ErrnoException) => {
            stop(error.code === 'ENOENT' ? 'unavailable' : error.code === 'EACCES' || error.code === 'EPERM' ? 'access-denied' : 'spawn-failed');
          });
          child.once('exit', () => { void startCleanup(); });
          child.once('close', async (code, signal) => {
            clearTimeout(timer);
            const verified = await startCleanup();
            if (settled || !verified) return;
            if (stopped) { finish(fail(stopped, query)); return; }
            if (code !== 0 || signal !== null) { finish(fail('command-failed', query)); return; }
            const buffer = Buffer.concat(chunks);
            wipe();
            let result: RepositoryUsageResult;
            try { result = decodeRepositoryUsage(query, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)), Date.now()); }
            catch { result = fail('invalid-json', query); }
            finally { buffer.fill(0); }
            finish(result);
          });
        });
      } finally { busy = false; }
    },
  };
}
