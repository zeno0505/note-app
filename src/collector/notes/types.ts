/** Main-process-only inputs. Never accept these paths directly from renderer IPC. */
export interface NoteWorktree {
  worktreeId: string;
  hostId: string;
  /** Path from an already verified collector record; existence is checked again. */
  worktreePath: string;
  /** Exact registered path, relative to the selected scope, when several DAGs exist. */
  selectedDagRelativePath?: string;
  /** Trusted main-only explicit read registration; creates no docs/note link. */
  registeredScopeId?: string;
  /** User-confirmed scope; still requires the actual designated symlink. */
  selectedScopeId?:string;
}

export interface AllowedNoteScope {
  scopeId: string;
  hostId: string;
  /** Explicit actual vault root, not a selected project scope or inferred parent. */
  vaultRootPath: string;
  /** Explicit narrow project directory, strictly below vaultRootPath. */
  scopePath: string;
  /** Explicit registrations only. No globbing, directory enumeration or parent search. */
  dagRelativePaths: readonly string[];
}

export interface NoteMappingRequest {
  localHostId: string;
  worktrees: readonly NoteWorktree[];
  scopes: readonly AllowedNoteScope[];
  signal?: AbortSignal;
  /** Whole-request deadline. Default 5 seconds, maximum 30 seconds. */
  timeoutMs?: number;
  requireNoteSymlink?:boolean;
}

export type SafeFsErrorCode =
  | 'ENOENT' | 'ENOTDIR' | 'EACCES' | 'EPERM' | 'ELOOP'
  | 'ENAMETOOLONG' | 'EIO' | 'EMFILE' | 'ENFILE' | 'UNKNOWN';

export type MappingReason =
  | 'remote-host' | 'no-allowed-scope' | 'ambiguous-scope'
  | 'vault-unavailable' | 'vault-not-directory'
  | 'scope-unavailable' | 'scope-not-directory' | 'scope-is-vault-root' | 'scope-outside-vault'
  | 'worktree-unavailable' | 'worktree-not-directory'
  | 'docs-unavailable' | 'docs-not-directory' | 'docs-outside-worktree'
  | 'note-not-symlink' | 'note-missing' | 'note-broken-link' | 'note-unavailable' | 'note-not-directory'
  | 'vault-root-note' | 'note-outside-scope'
  | 'dag-not-registered' | 'ambiguous-dag' | 'dag-unavailable' | 'dag-not-file'
  | 'dag-outside-scope' | 'dag-outside-note' | 'invalid-dag-selection'
  | 'aborted' | 'timeout' | 'operation-limit' | 'path-changed';

export type MappingStage = 'host' | 'vault' | 'scope' | 'worktree' | 'docs' | 'note' | 'dag';

export interface MappingProblem {
  reason: MappingReason;
  stage: MappingStage;
  /** Allowlisted system code only: never raw error messages or stack traces. */
  errorCode?: SafeFsErrorCode;
}

export interface ResolvedNoteMapping {
  state: 'resolved';
  worktreeId: string;
  hostId: string;
  scopeId: string;
  canonicalWorktreePath: string;
  canonicalNotePath: string;
  canonicalDagPath: string;
  dagId: string;
  registration?: 'explicit-read-only';
}

export interface UnresolvedNoteMapping extends MappingProblem {
  state: 'unresolved';
  worktreeId: string;
  hostId: string;
}

export type NoteMapping = ResolvedNoteMapping | UnresolvedNoteMapping;

export interface CanonicalDagMapping {
  dagId: string;
  hostId: string;
  canonicalDagPath: string;
  worktreeIds: string[];
}

export interface NoteMappingResult {
  /** complete means every mapping resolved, not complete discovery of a vault. */
  status: 'complete' | 'partial' | 'invalid-request';
  mappings: NoteMapping[];
  dags: CanonicalDagMapping[];
  scopeIssues: (MappingProblem & { scopeId: string; hostId: string })[];
  /** Invalid input is rejected before any filesystem operation. */
  inputError?: 'invalid-input' | 'input-limit' | 'duplicate-identity';
  filesystemOperations: number;
}
