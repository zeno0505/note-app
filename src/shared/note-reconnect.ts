export interface NoteReconnectProposal {
  proposalId:string;workstreamId:string;directory:string;linkPath:string;
  previousTarget:string|null;replacement:boolean;dag:'present'|'absent';expiresAt:number;
}
export interface NoteReconnectBridge {
  selectNoteReconnect(request:{workstreamId:string}):Promise<NoteReconnectProposal|null>;
  cancelNoteReconnect(request:{proposalId:string}):Promise<void>;
  confirmNoteReconnect(request:{proposalId:string;linkChangeConfirmed:true}):Promise<{backupPath:string|null}>;
}
