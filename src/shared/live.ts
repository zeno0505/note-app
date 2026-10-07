import type { DagTask } from '../facts/dag-read-model/types';
import type { CodeBurnResult } from '../summary/budget/codeburn';
import type { ClaimView } from '../summary/claims';
import type { ReadingSummary } from './reading-summary';

/** Detached display projection. No arbitrary file, command, prompt or model IPC. */
export interface LiveConfigurationView {
  state: 'unconfigured' | 'ready' | 'invalid';
  message: string;
  orcaExecutable: string | null;
  codeburnExecutable: string | null;
  noteScopeCount: number;
  dagQueryConfigured: boolean;
  summaryTransport: 'blocked';
}
export interface LiveSummaryView {
  state: 'unavailable' | 'empty' | 'restored' | 'error';
  reason: string;
  revision: number | null;
  candidateClaims: ClaimView[];
  approvedClaims: ClaimView[];
  approvedAt: string | null;
  context: null | { selectedTaskCount: number; recordCount: number; bytes: number; truncated: boolean; unknowns: string[] };
}
export interface LiveDagTaskView extends DagTask {
  /** Display-only truncation. Context selection uses the original verified read model. */
  displayOmissions: { dependencies: number; commitReferences: number; e2eReferences: number };
}
export interface LiveDagView {
  readerRecovery?:import('../facts/dag-read-model/types').DagReaderRecovery|null;
  dagId: string;
  sourceHash?: string | null;
  doneStatus?: string | null;
  state: 'ready' | 'unavailable' | 'error';
  reason: string | null;
  observedAt: string | null;
  unchanged: boolean;
  taskCount: number | null;
  displayedTaskCount: number;
  tasks: LiveDagTaskView[];
  statusCounts: {status: string | null; count: number}[];
  statusCountTotal: number | null;
  statusCountsOmitted: number;
  summary: LiveSummaryView;
}
export interface ProjectLifecycleView {
  status:'active'|'completed';changedAt:string;sourceState:'available'|'unavailable'|'not-checked';worktreeState:'present'|'missing';
  history:{at:string;status:'active'|'completed';summary:ReadingSummary|null}[];
}
export interface LiveWorkstreamView {
  id: string;
  title: string;
  projectName: string | null;
  repository?:{key:string;id:string|null;hostId:string|null;projectId:string|null;label:string};
  observation?:{worktree:'observed'|'not-observed'|'unknown';sidebarActivity:boolean|null;selected:boolean|null;workspaceStatus:'in-progress'|'in-review'|'completed'|'unknown'};
  branch: string | null;
  archived: boolean | null;
  terminalConnected: boolean | null;
  terminalCount: number | null;
  agentState: 'done' | 'unknown';
  projectMapping: string;
  noteMapping: { state: 'resolved' | 'unresolved'; reason: string | null; dagId: string | null; registration?: 'explicit-read-only'; context?: { state:'verified'|'retained'; noteRootPath:string; dagPath:string } };
  readingSummary?: ReadingSummary;
  project?:ProjectLifecycleView;
  documentLinks?:{id:string;role:'inbox'|'discussion'|'design';label:string}[];
  connectionOptions?:{id:string;label:string}[];
}
export interface LiveWorkspaceView {
  mode: 'live-read-only';
  connection: 'disconnected' | 'connected';
  configuration: LiveConfigurationView;
  refreshing: boolean;
  polling: {activity: 'stopped' | 'foreground' | 'background'; nextRefreshAt: string | null; countdownSeconds: number};
  observedAt: string | null;
  freshness: 'unknown' | 'current' | 'stale';
  lastError: string | null;
  coverage: null | {projects: 'complete' | 'partial' | 'unknown'; worktrees: 'complete' | 'partial' | 'unknown'; processes: 'complete' | 'partial' | 'unknown'; totalWorktrees: number | null};
  workstreams: LiveWorkstreamView[];
  dags: LiveDagView[];
  codeburn: { state: 'unconfigured' | 'idle' | 'observed'; results: CodeBurnResult[] };
}
