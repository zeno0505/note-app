export type DagFailureKind = 'invalid_request' | 'busy' | 'cancelled' | 'timeout' | 'source_unavailable' | 'source_changed' | 'source_limit' | 'command_failed' | 'output_limit' | 'invalid_schema' | 'document_shape_invalid' | 'cleanup_unverified';
export interface DagError { kind: DagFailureKind; message: string }
export interface DagTask {
  id: string; title: string | null;
  /** Declared vocabulary, not inferred agent/runtime state. */
  status: string | null;
  dependencies: { id: string; scope: 'internal' | 'external' }[];
  e2e: { state: 'undeclared' | 'declared'; required: boolean | null; coveredBy: string[] | null; coverage: 'undeclared' | 'not-required' | 'unmet' | 'references-declared' | 'malformed' };
  /** Declaration only; no git/evidence verification is performed. */
  commitReferences: string[];
  /** Optional declarations we could not interpret; never equivalent to no references. */
  commitReferencesUnsupported?: number;
  commitVerification: 'not-performed';
}
export interface DagCoverage {
  tasksTotal: number; declared: number; required: number;
  uncoveredDone: string[]; uncoveredOpen: string[]; malformed: string[];
}
export interface DagReadModel {
  dagId: string; sourceHash: string; sourceMtimeMs: number; observedAt: string;
  doneStatus: string; tasks: DagTask[]; statusCounts: { status: string | null; count: number }[];
  coverage: DagCoverage; verifiedFacts: never[];
}
export type DagReadResult = { ok: true; value: DagReadModel; unchanged: boolean } | { ok: false; error: DagError };
export interface DagRegistration {
  dagId: string;
  /** Canonical explicit file from the realpath note mapper. No discovery/globs. */
  canonicalDagPath: string;
}
export interface DagReaderOptions {
  /** Trusted main-side executable/script configuration. Never renderer input. */
  pythonPath: string; queryScriptPath: string;
  registrations: readonly DagRegistration[];
  doneStatus?: string; timeoutMs?: number; maxOutputBytes?: number; maxSourceBytes?: number;
  /** Candidate discovery additionally requires the existing phases/tasks document shape. */
  requireDocumentShape?: boolean;
}

export interface DagReaderRecovery {cause: 'cancelled'|'timeout'|'cleanup_unverified'; cleanup: 'pending'|'verified'|'unverified'; retired:boolean; generation:number}
export interface DagReader {read(dagId:string,request?:{signal?:AbortSignal}):Promise<DagReadResult>; recoveryState?():DagReaderRecovery|null; recover?():boolean}
