import { isOrcaQuery } from './commands';
import { failure } from './errors';
import type {
  OrcaAgent, OrcaCoverage, OrcaIdentity, OrcaList, OrcaProcessObservation,
  OrcaProject, OrcaQuery, OrcaQueryData, OrcaResponse, OrcaResult, OrcaStatus, OrcaWorktree,
} from './types';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('schema');
  return value as RecordValue;
}
function nested(parent: RecordValue, key: string): RecordValue | null {
  return parent[key] == null ? null : record(parent[key]);
}
function text(parent: RecordValue, key: string, max = 4096): string | null {
  const value = parent[key];
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('schema');
  return value;
}
// Observed Orca lists can contain an empty branch. Its precise cause is unknown.
// Normalize it to unavailable rather than inferring a branch. This exception is
// deliberately branch-only: IDs, paths and other known strings stay strict.
function branch(row: RecordValue): string | null {
  return row.branch === '' ? null : text(row, 'branch');
}
function requiredText(parent: RecordValue, key: string): string {
  const value = text(parent, key);
  if (value === null) throw new Error('schema');
  return value;
}
function bool(parent: RecordValue, key: string): boolean | null {
  const value = parent[key];
  if (value == null) return null;
  if (typeof value !== 'boolean') throw new Error('schema');
  return value;
}
function integer(parent: RecordValue, key: string): number | null {
  const value = parent[key];
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('schema');
  return value as number;
}
function timestamp(parent: RecordValue, key: string): number | null {
  const value = integer(parent, key);
  if (value !== null && value > 8_640_000_000_000_000) throw new Error('schema');
  return value;
}
function list(value: unknown, max = 1000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('schema');
  return value;
}
function strings(parent: RecordValue, key: string, max = 1000): string[] | null {
  if (parent[key] == null) return null;
  const values = list(parent[key], max).map(value => requiredText({ value }, 'value'));
  if (new Set(values).size !== values.length) throw new Error('schema');
  return values;
}
function sameOrNull(a: string | null, b: string | null): string | null {
  if (a !== null && b !== null && a !== b) throw new Error('schema');
  return a ?? b;
}
function identity(row: RecordValue, process = false): OrcaIdentity {
  const observed = nested(row, 'identity');
  return {
    hostId: sameOrNull(text(row, 'hostId'), observed ? text(observed, 'executionHostId') : null),
    instanceId: sameOrNull(text(row, process ? 'worktreeInstanceId' : 'instanceId'), observed ? text(observed, 'instanceId') : null),
    sourceKey: observed ? text(observed, 'key') : null,
  };
}
function coverage(value: RecordValue, returnedCount: number): OrcaCoverage {
  const scope = nested(value, 'hostScope');
  const hostIds = scope ? strings(scope, 'hostIds') : null;
  const omittedHostIds = scope ? strings(scope, 'omittedHostIds') : null;
  const totalCount = integer(value, 'totalCount');
  const truncated = bool(value, 'truncated');
  if (totalCount !== null && totalCount < returnedCount) throw new Error('schema');
  if (hostIds && omittedHostIds?.some(host => hostIds.includes(host))) throw new Error('schema');
  const partial = truncated === true || (omittedHostIds?.length ?? 0) > 0 || (totalCount !== null && totalCount > returnedCount);
  const complete = truncated === false && totalCount === returnedCount && hostIds !== null && omittedHostIds !== null;
  return { state: partial ? 'partial' : complete ? 'complete' : 'unknown', returnedCount, totalCount, truncated, hostIds, omittedHostIds };
}
function validateHosts<T extends { identity: OrcaIdentity }>(rows: T[], scope: OrcaCoverage): void {
  for (const row of rows) {
    const host = row.identity.hostId;
    if (host !== null && (scope.omittedHostIds?.includes(host) || (scope.hostIds && !scope.hostIds.includes(host)))) throw new Error('schema');
  }
}
function project(row: RecordValue): OrcaProject {
  const provider=nested(row,'providerIdentity');
  const providerIdentity=provider?.provider==='github'?{provider:'github' as const,owner:requiredText(provider,'owner'),repo:requiredText(provider,'repo')}:undefined;
  return { id: requiredText(row, 'id'), displayName: text(row, 'displayName', 512), sourceRepoIds: strings(row, 'sourceRepoIds', 10_000),...(providerIdentity?{providerIdentity}:{}) };
}
function worktree(row: RecordValue): OrcaWorktree {
  return {
    id: requiredText(row, 'id'), identity: identity(row), repoId: text(row, 'repoId'), projectId: text(row, 'projectId'),
    path: text(row, 'path'), branch: branch(row), displayName: text(row, 'displayName', 512),
    isArchived: bool(row, 'isArchived'), isMainWorktree: bool(row, 'isMainWorktree'),
    ...(row.workspaceStatus!==undefined?{workspaceStatus:['in-progress','in-review','completed'].includes(String(row.workspaceStatus))?row.workspaceStatus as 'in-progress'|'in-review'|'completed':'unknown' as const}:{}),
  };
}
function agent(row: RecordValue): OrcaAgent {
  const state = text(row, 'state', 128);
  return {
    paneKey: text(row, 'paneKey'), state: state === 'done' ? 'done' : 'unknown', interrupted: bool(row, 'interrupted'),
    stateStartedAt: timestamp(row, 'stateStartedAt'), updatedAt: timestamp(row, 'updatedAt'),
  };
}
function processObservation(row: RecordValue): OrcaProcessObservation {
  const status = text(row, 'status', 128);
  return {
    worktreeId: requiredText(row, 'worktreeId'), identity: identity(row, true), repoId: text(row, 'repoId'),
    isArchived: bool(row, 'isArchived'), isActive: bool(row, 'isActive'),
    ...(row.hasHostSidebarActivity!==undefined?{hasHostSidebarActivity:bool(row,'hasHostSidebarActivity')}:{}),
    activityStatus: status === 'active' || status === 'inactive' ? status : 'unknown',
    liveTerminalCount: integer(row, 'liveTerminalCount'), hasAttachedPty: bool(row, 'hasAttachedPty'),
    lastOutputAt: timestamp(row, 'lastOutputAt'),
    agents: row.agents == null ? null : list(row.agents).map(value => agent(record(value))),
  };
}
function status(value: RecordValue): OrcaStatus {
  const app = nested(value, 'app');
  const runtime = nested(value, 'runtime');
  const graph = nested(value, 'graph');
  return {
    appRunning: app ? bool(app, 'running') : null,
    runtimeReachable: runtime ? bool(runtime, 'reachable') : null,
    runtimeState: runtime && text(runtime, 'state', 128) === 'ready' ? 'ready' : 'unknown',
    connectionState: runtime && text(runtime, 'connectionState', 128) === 'connected' ? 'connected' : 'unknown',
    graphState: graph && text(graph, 'state', 128) === 'ready' ? 'ready' : 'unknown',
  };
}
function projectList(value: RecordValue): OrcaList<OrcaProject> {
  const records = list(value.projects, 10_000).map(value => project(record(value)));
  if (new Set(records.map(row => row.id)).size !== records.length) throw new Error('schema');
  return { records, coverage: coverage(value, records.length) };
}
function worktreeList(value: RecordValue): OrcaList<OrcaWorktree> {
  const records = list(value.worktrees).map(value => worktree(record(value)));
  const scope = coverage(value, records.length);
  validateHosts(records, scope);
  return { records, coverage: scope };
}
function processList(value: RecordValue): OrcaList<OrcaProcessObservation> {
  const records = list(value.worktrees).map(value => processObservation(record(value)));
  const scope = coverage(value, records.length);
  validateHosts(records, scope);
  return { records, coverage: scope };
}

/** Parse and immediately project. No raw response, unknown field, or remote error text escapes. */
export function parseOrcaResponse<Q extends OrcaQuery>(query: Q, json: string): OrcaResult<OrcaResponse<OrcaQueryData[Q]>> {
  if (!isOrcaQuery(query)) return failure('forbidden_query', null);
  // Independent parser calls are bounded as well as spawned reads.
  if (typeof json !== 'string') return failure('invalid_json', query);
  if (Buffer.byteLength(json, 'utf8') > 8 * 1024 * 1024) return failure('output_limit', query);
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return failure('invalid_json', query); }
  let runtimeId: string | null = null;
  try {
    const envelope = record(parsed);
    const meta = nested(envelope, '_meta');
    runtimeId = meta ? text(meta, 'runtimeId') : null;
    if (typeof envelope.ok !== 'boolean') throw new Error('schema');
    if (!envelope.ok) {
      const error = record(envelope.error);
      // Deliberately do not read message, data, nextSteps, or unknown error strings.
      return failure(error.code === 'runtime_access_denied' ? 'access_denied' : 'remote_error', query, runtimeId);
    }
    const value = record(envelope.result);
    let data: OrcaQueryData[OrcaQuery];
    switch (query) {
      case 'status': {
        const runtime = nested(value, 'runtime');
        runtimeId = sameOrNull(runtimeId, runtime ? text(runtime, 'runtimeId') : null);
        data = status(value);
        break;
      }
      case 'projects': data = projectList(value); break;
      case 'worktrees': data = worktreeList(value); break;
      case 'processes': data = processList(value); break;
    }
    return { ok: true, value: { runtimeId, data: data! as OrcaQueryData[Q] } };
  } catch {
    return failure('invalid_schema', query, runtimeId);
  } finally {
    // Release references; JavaScript does not promise secure memory erasure.
    parsed = undefined;
  }
}
