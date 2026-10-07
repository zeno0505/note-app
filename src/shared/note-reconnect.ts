export type DagCandidateExclusionReason='document_shape_invalid'|'invalid_schema'|'source_limit'|'query_failed'|'source_unavailable'|'source_changed'|'output_limit'|'unsafe_file';
export interface DagCandidateExclusion {relativePath:string;reason:DagCandidateExclusionReason}
export interface NoteReconnectProposal {
  proposalId:string;workstreamId:string;directory:string;linkPath:string;
  previousTarget:string|null;replacement:boolean;dag:'present'|'absent';expiresAt:number;
  candidates:{id:string;relativePath:string;taskCount:number}[];excludedCount:number;excluded:DagCandidateExclusion[];
}
export interface NoteReconnectBridge {
  selectNoteReconnect(request:{workstreamId:string}):Promise<NoteReconnectProposal|null>;
  cancelNoteReconnect(request:{proposalId:string}):Promise<void>;
  confirmNoteReconnect(request:{proposalId:string;candidateId:string|null;linkChangeConfirmed:true}):Promise<{backupPath:string|null;workstreamId?:string}>;
}
