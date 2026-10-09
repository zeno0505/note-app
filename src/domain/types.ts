/** Phase 1 display contract. Fixtures are not a supported real Orca schema. */
export type Freshness = 'current' | 'stale';
export type ClaimKind = 'fact' | 'inference' | 'unknown';
export type ClaimApproval = 'not-requested' | 'approved' | 'rejected';
export type AgentState = 'working' | 'done' | 'idle' | 'unknown';
export type DagState = 'pending' | 'running' | 'done' | 'unknown';

export interface SourceRecord {
  id: string;
  kind: 'dag-fixture' | 'orca-fixture' | 'manual-fixture';
  /** A fixture-relative locator, never an arbitrary readable file path. */
  locator: string;
  hash: string;
  observedAt: string;
}

export interface SummaryClaim {
  id: string;
  text: string;
  kind: ClaimKind;
  sources: Array<{ sourceId: string; sourceHash: string }>;
  observedAt: string;
  reviewedAt: string | null;
  freshness: Freshness;
  approval: ClaimApproval;
  evidence: 'source-declaration' | 'manual-description' | 'none';
}

export interface WorktreeObservation {
  id: string;
  title: string;
  repositoryId: string;
  isArchived: boolean;
  /** Selection, terminal connectivity, agent work and DAG work are independent. */
  isSelected: boolean;
  terminalConnected: boolean | null;
  terminalCount: number | null;
  agentState: AgentState;
  agentObservedAt: string | null;
  /** Output timestamp is not an execution heartbeat. */
  lastOutputAt: string | null;
}

export interface Workstream {
  id: string;
  title: string;
  goal: SummaryClaim;
  summary: {
    implemented: SummaryClaim[];
    remaining: SummaryClaim[];
    current: SummaryClaim[];
    next: SummaryClaim[];
    blockers: SummaryClaim[];
  };
  /** Synthetic identity only; realpath resolution belongs to a future adapter. */
  canonicalDagPath: string | null;
  dagState: DagState;
  worktrees: WorktreeObservation[];
  noteMapping: {
    status: 'mapped' | 'missing' | 'ambiguous';
    notePath: string | null;
    reason: string | null;
  };
  sources: SourceRecord[];
}

export interface WorkspaceSnapshot {
  schemaVersion: 1;
  mode: 'synthetic-fixture';
  /** Time of the last usable observation, not the current clock. */
  observedAt: string;
  freshness: Freshness;
  lastAttempt: {
    observedAt: string;
    outcome: 'success' | 'error';
    reason: string | null;
  };
  coverage: {
    complete: boolean;
    truncated: boolean;
    /** Unknown is null; only a successful complete empty response supports zero. */
    totalCount: number | null;
    omittedHostIds: string[];
  };
  workstreams: Workstream[];
}

/** Declared work completion never supplies testing or deployment evidence. */
export interface TaskStatusFact {
  declaredStatus: 'pending' | 'running' | 'done' | 'blocked' | 'unknown';
  tested: 'unknown' | 'reported-pass' | 'reported-fail';
  deployed: 'unknown' | 'reported-deployed' | 'reported-not-deployed';
  depsReady: boolean | null;
  priority: number | null;
  executionApproval: 'unknown' | 'approved' | 'denied';
}
