/** Internal, allowlisted observations; not the full Orca public wire schema. */
export type OrcaQuery = 'status' | 'projects' | 'worktrees' | 'processes';
export type OrcaFailureKind =
  | 'forbidden_query' | 'busy' | 'cancelled' | 'timeout' | 'output_limit'
  | 'unavailable' | 'access_denied' | 'spawn_failed' | 'command_failed'
  | 'invalid_json' | 'invalid_schema' | 'remote_error'
  | 'runtime_unidentified' | 'runtime_changed' | 'ambiguous_identity' | 'cleanup_unverified';
export interface OrcaFailure {
  kind: OrcaFailureKind;
  query: OrcaQuery | null;
  /** Safe constant diagnostic. Never stdout, stderr, remote messages, or paths. */
  message: string;
  runtimeId: string | null;
}
export type OrcaResult<T> = { ok: true; value: T } | { ok: false; error: OrcaFailure };
export interface OrcaCoverage {
  state: 'complete' | 'partial' | 'unknown';
  returnedCount: number;
  totalCount: number | null;
  truncated: boolean | null;
  hostIds: string[] | null;
  omittedHostIds: string[] | null;
}
export interface OrcaResponse<T> { runtimeId: string | null; data: T }
export interface OrcaStatus {
  appRunning: boolean | null;
  runtimeReachable: boolean | null;
  runtimeState: 'ready' | 'unknown';
  connectionState: 'connected' | 'unknown';
  graphState: 'ready' | 'unknown';
}
export interface OrcaProject {
  id: string;
  displayName: string | null;
  sourceRepoIds: string[] | null;
}
export interface OrcaIdentity {
  hostId: string | null;
  instanceId: string | null;
  /** Orca's optional identity key is retained as evidence, not used as a join key. */
  sourceKey: string | null;
}
export interface OrcaWorktree {
  id: string;
  identity: OrcaIdentity;
  repoId: string | null;
  projectId: string | null;
  path: string | null;
  branch: string | null;
  displayName: string | null;
  isArchived: boolean | null;
  isMainWorktree: boolean | null;
}
export interface OrcaAgent {
  paneKey: string | null;
  /** Only `done` has been observed; other strings are deliberately unknown. */
  state: 'done' | 'unknown';
  interrupted: boolean | null;
  stateStartedAt: number | null;
  updatedAt: number | null;
}
export interface OrcaProcessObservation {
  worktreeId: string;
  identity: OrcaIdentity;
  repoId: string | null;
  isArchived: boolean | null;
  /** Orca's isActive flag; not normalized into selection, agent, or DAG state. */
  isActive: boolean | null;
  activityStatus: 'active' | 'inactive' | 'unknown';
  liveTerminalCount: number | null;
  hasAttachedPty: boolean | null;
  /** Output timestamp, never a heartbeat. */
  lastOutputAt: number | null;
  agents: OrcaAgent[] | null;
}
export interface OrcaList<T> { records: T[]; coverage: OrcaCoverage }
export interface OrcaQueryData {
  status: OrcaStatus;
  projects: OrcaList<OrcaProject>;
  worktrees: OrcaList<OrcaWorktree>;
  processes: OrcaList<OrcaProcessObservation>;
}
export interface OrcaJoinedWorktree {
  /** JSON tuple [runtimeId, hostId, instanceId], or null when unknown. */
  key: string | null;
  worktree: OrcaWorktree;
  project: OrcaProject | null;
  projectMapping: 'matched' | 'missing-project-id' | 'project-not-observed';
  process: OrcaProcessObservation | null;
  processMapping: 'matched' | 'identity-unavailable' | 'not-observed';
}
export interface OrcaObservation {
  runtimeId: string;
  observedAt: string;
  status: OrcaStatus;
  projects: OrcaList<OrcaProject>;
  worktrees: OrcaList<OrcaWorktree>;
  processes: OrcaList<OrcaProcessObservation>;
  joined: OrcaJoinedWorktree[];
  unmatchedProcesses: OrcaProcessObservation[];
  /** Any incomplete/unknown list keeps the combined observation incomplete. */
  complete: boolean;
}
export interface OrcaReadOptions { signal?: AbortSignal }
export interface OrcaAdapterOptions {
  /** Trusted main-process configuration only; never renderer/request data. */
  executablePath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
