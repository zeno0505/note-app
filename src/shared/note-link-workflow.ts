/** Renderer-safe requests contain opaque selections only; filesystem authority stays in main. */
export interface NoteLinkPreviewRequest { worktreeId: string; scopeId: string }
export interface NoteLinkConfirmRequest { proposalId: string; confirmationToken: string }
export interface NoteLinkProposal {
  proposalId: string;
  confirmationToken: string;
  expiresAt: string;
  worktreeId: string;
  scopeId: string;
  status: 'changes' | 'noop' | 'conflict';
  paths: {
    worktree: string; vault: string; scope: string; docs: string; note: string;
    gitDirectory: string; commonGitDirectory: string; exclude: string;
    temporaryExclude: string;
  };
  changes: { createDocsDirectory: boolean; createNoteSymlink: boolean; appendLocalExclude: boolean };
  exclude: {
    rule: '/docs/note';
    appendText: string;
    beforeSha256: string;
    afterSha256: string;
    beforeBytes: number;
    afterBytes: number;
  };
  sharedExclude: { worktreePaths: string[]; scopeDescription: string };
  conflicts: string[];
  warnings: string[];
}
export type NoteLinkFailureCode =
  | 'invalid-request' | 'selection-unavailable' | 'remote-host' | 'invalid-scope'
  | 'git-authority' | 'git-failed' | 'git-output-limit' | 'filesystem-unavailable'
  | 'unsafe-path' | 'conflict' | 'stale-preview' | 'expired-preview' | 'unknown-preview'
  | 'confirmation-mismatch' | 'cancelled' | 'timeout' | 'busy' | 'write-failed';
export interface NoteLinkRejection {
  status: 'rejected'; code: NoteLinkFailureCode; message: string;
}
export type NoteLinkPreviewResult = { status: 'ready'; proposal: NoteLinkProposal } | NoteLinkRejection;
export interface NoteLinkConfirmResult {
  status: 'applied' | 'noop' | 'rejected' | 'rolled-back' | 'partial';
  code?: NoteLinkFailureCode;
  message: string;
  proposalId?: string;
  /** Actual verified state when known. Null means a pending OS operation or unsafe observation. */
  actual: { docsCreated: boolean | null; noteLinked: boolean | null; excludeUpdated: boolean | null };
  recovery: string[];
  cancellationRequested: boolean;
}
