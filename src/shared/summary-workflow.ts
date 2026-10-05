import type { ClaimView } from '../summary/claims';
import type { AgentBudgetDecision, AgentProvider } from '../summary/budget';
import type { CodeBurnResult } from '../summary/budget/codeburn';

/** Narrow IPC data only. No paths, prompt overrides, approval events or manifests. */
export type SummaryProviderChoice = 'auto' | AgentProvider;
export interface SummaryPrepareRequest { workstreamId: string; taskIds: string[]; provider: SummaryProviderChoice }
export interface SummaryTicketRequest { ticketId: string }
export interface SummaryRunRequest extends SummaryTicketRequest { provider: SummaryProviderChoice }
export interface SummaryReviewRequest extends SummaryTicketRequest { candidateHash: string }
export interface SummaryContextRecordView {
  sourceId: string;
  taskId: string | null;
  selection: 'selected-task' | 'direct-dependency' | 'goal-document' | 'document' | 'inbox';
  change?: 'new' | 'changed' | 'unchanged';
  excerpt?: { byteStart: number; byteEnd: number; lineStart: number; lineEnd: number };
  title: string | null;
  declaredStatus: string | null;
  e2eCoverage: string | null;
  commitReferences: string[];
  dependencies: { sourceId: string; declaredStatus: string }[];
  observedAt: string;
  /** Exact bounded artifact supplied as untrusted context; never a source-file body. */
  suppliedText: string;
}
export interface SummaryContextPreview {
  selectedTaskCount: number;
  recordCount: number;
  bytes: number;
  inputBytes: number;
  approximateTokens: number;
  maxResponseBytes: number;
  accountingMethod: 'utf8-byte-proxy-not-model-tokenizer';
  truncated: boolean;
  records: SummaryContextRecordView[];
  exclusions: {sourceId: string; reason: string}[];
  unknowns: string[];
  unresolvedDependencyIds: string[];
  checkpoint?: 'saved-summary' | 'new-baseline';
  absentSourceIds?: string[];
}
export type SummaryWorkflowState = 'preparing' | 'prepared' | 'blocked' | 'submitting' | 'submitted' | 'waiting' | 'candidate' | 'approving' | 'approved' | 'rejected' | 'error' | 'cancelled';
export type SummaryPersistenceState = 'not-saved' | 'restored' | 'saving-candidate' | 'candidate-saved' | 'saving-approval' | 'approval-saved' | 'rejection-saved' | 'failed' | 'commit-unknown' | 'committed-after-cancel';
export interface SummaryWorkflowView {
  ticketId: string;
  /** Main-issued monotonic observation order within this ticket, shared by events and RPCs. */
  sequence: number;
  workstreamId: string;
  taskIds: string[];
  state: SummaryWorkflowState;
  message: string;
  providerChoice: SummaryProviderChoice;
  selectedProvider: AgentProvider | null;
  transport: 'blocked' | 'synthetic-test-only';
  executionAuthorized: false;
  preview: SummaryContextPreview | null;
  budget: AgentBudgetDecision | null;
  /** Independently projected observations, never evidence of agent availability or a comparable cap. */
  codeburn: CodeBurnResult[];
  candidateHash: string | null;
  approvedCandidateHash: string | null;
  candidateClaims: ClaimView[];
  approvedClaims: ClaimView[];
  approvedAt: string | null;
  persistence: { state: SummaryPersistenceState; revision: number | null; message: string };
  canRun: boolean;
  canApprove: boolean;
  canReject: boolean;
  canCancel: boolean;
}
export interface SummaryWorkflowBridge {
  prepareSummary(request: SummaryPrepareRequest): Promise<SummaryWorkflowView>;
  runSummary(request: SummaryRunRequest): Promise<SummaryWorkflowView>;
  readSummary(request: SummaryTicketRequest): Promise<SummaryWorkflowView>;
  approveSummary(request: SummaryReviewRequest): Promise<SummaryWorkflowView>;
  rejectSummary(request: SummaryReviewRequest): Promise<SummaryWorkflowView>;
  cancelSummary(request: SummaryTicketRequest): Promise<SummaryWorkflowView>;
  onSummary(listener: (view: SummaryWorkflowView) => void): () => void;
}
