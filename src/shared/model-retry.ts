export interface ModelRetryProposal {ticketId:string;workstreamId:string;inputHash:string;originalRunId:string;expiresAt:number}
export interface ModelRetryView {available:boolean;used:boolean;inputHash:string|null}
export interface ModelRetryBridge {
 prepareModelRetry(request:{workstreamId:string}):Promise<ModelRetryProposal>;
 cancelModelRetry(request:{ticketId:string}):Promise<void>;
 runModelRetry(request:{ticketId:string;transferConfirmed:true;oneCallConfirmed:true}):Promise<import('../main/project-model').ProjectModelView>;
}
