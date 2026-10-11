export interface ReadRootView {id:string;path:string;kind:'project'|'vault';available:boolean}
export interface ReadRootsView {roots:ReadRootView[];revision:number|null;editable:boolean;error?:string}
export interface ReadRootProposal {proposalId:string;path:string;expiresAt:number}
export interface ReadRootsBridge {
  getReadRoots():Promise<ReadRootsView>;
  selectReadRoot():Promise<ReadRootProposal|null>;
  confirmReadRoot(request:{proposalId:string;readOnlyConfirmed:true}):Promise<ReadRootsView>;
  cancelReadRoot(request:{proposalId:string}):Promise<void>;
  revokeReadRoot(request:{rootId:string;expectedRevision:number|null;confirmed:true}):Promise<ReadRootsView>;
}
