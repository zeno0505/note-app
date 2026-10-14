/** Explicit document catalogue grants, independent from general note/vault read permissions. */
export type ProjectDocumentRootKind = 'docs' | 'review';
export interface ProjectDocumentRootView {
  id:string;projectId:string;path:string;kind:ProjectDocumentRootKind;available:boolean;
}
export interface ProjectDocumentRootsView {
  projectId:string;revision:number|null;editable:boolean;roots:ProjectDocumentRootView[];error?:string;
}
export interface ProjectDocumentRootProposal {
  projectId:string;proposalId:string;path:string;kind:ProjectDocumentRootKind;expiresAt:number;
}
export interface ProjectDocumentRootsBridge {
  getProjectDocumentRoots(request:{projectId:string}):Promise<ProjectDocumentRootsView>;
  selectProjectDocumentRoot(request:{projectId:string;kind:ProjectDocumentRootKind}):Promise<ProjectDocumentRootProposal|null>;
  confirmProjectDocumentRoot(request:{projectId:string;proposalId:string;readOnlyConfirmed:true}):Promise<ProjectDocumentRootsView>;
  cancelProjectDocumentRoot(request:{projectId:string;proposalId:string}):Promise<void>;
  revokeProjectDocumentRoot(request:{projectId:string;rootId:string;expectedRevision:number|null;confirmed:true}):Promise<ProjectDocumentRootsView>;
}

export const PROJECT_DOCUMENT_ROOT_LIMITS=Object.freeze({roots:128,rootsPerProject:7,projectId:1024,path:4096,proposalLifetimeMs:120000});
function fail():never {throw Error('프로젝트 문서 폴더 요청을 다시 확인해 주세요.');}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length)fail();
  const output:Record<string,unknown>={};
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value' in descriptor))fail();output[key]=descriptor.value;}
  return output;
}
export function parseProjectDocumentProjectId(value:unknown):string {
  if(typeof value!=='string'||!value.length||value.length>PROJECT_DOCUMENT_ROOT_LIMITS.projectId||/[\u0000-\u001f\u007f]/u.test(value))fail();
  return value;
}
export function parseProjectDocumentRootKind(value:unknown):ProjectDocumentRootKind {if(value!=='docs'&&value!=='review')fail();return value;}
function opaqueId(value:unknown,prefix:string):string {
  if(typeof value!=='string'||!new RegExp('^'+prefix+'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$','u').test(value))fail();return value;
}
export function parseGetProjectDocumentRootsRequest(value:unknown):{projectId:string} {
  const v=fields(value,['projectId']);return {projectId:parseProjectDocumentProjectId(v.projectId)};
}
export function parseSelectProjectDocumentRootRequest(value:unknown):{projectId:string;kind:ProjectDocumentRootKind} {
  const v=fields(value,['projectId','kind']);return {projectId:parseProjectDocumentProjectId(v.projectId),kind:parseProjectDocumentRootKind(v.kind)};
}
export function parseConfirmProjectDocumentRootRequest(value:unknown):{projectId:string;proposalId:string;readOnlyConfirmed:true} {
  const v=fields(value,['projectId','proposalId','readOnlyConfirmed']);if(v.readOnlyConfirmed!==true)fail();
  return {projectId:parseProjectDocumentProjectId(v.projectId),proposalId:opaqueId(v.proposalId,'document-root-proposal-'),readOnlyConfirmed:true};
}
export function parseCancelProjectDocumentRootRequest(value:unknown):{projectId:string;proposalId:string} {
  const v=fields(value,['projectId','proposalId']);return {projectId:parseProjectDocumentProjectId(v.projectId),proposalId:opaqueId(v.proposalId,'document-root-proposal-')};
}
export function parseRevokeProjectDocumentRootRequest(value:unknown):{projectId:string;rootId:string;expectedRevision:number|null;confirmed:true} {
  const v=fields(value,['projectId','rootId','expectedRevision','confirmed']);
  if(v.confirmed!==true||(v.expectedRevision!==null&&(!Number.isSafeInteger(v.expectedRevision)||(v.expectedRevision as number)<1||(v.expectedRevision as number)>=Number.MAX_SAFE_INTEGER)))fail();
  return {projectId:parseProjectDocumentProjectId(v.projectId),rootId:opaqueId(v.rootId,'document-root-'),expectedRevision:v.expectedRevision as number|null,confirmed:true};
}
