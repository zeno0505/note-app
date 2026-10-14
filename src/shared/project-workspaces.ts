/** Current Orca observation metadata only. A selection grants no filesystem or execution access. */
export interface ProjectWorkspaceOption {
  optionId:string;
  fingerprint:string;
  hostId:string;
  worktreeId:string;
  path:string;
  branch:string|null;
  repository:{key:string;id:string;hostId:string;projectId:string|null;label:string};
}
export interface ProjectWorkspaceOptions {
  state:'ready'|'unavailable';
  reason:'disconnected'|'refreshing'|'stale'|'unavailable'|null;
  observedAt:string|null;
  options:ProjectWorkspaceOption[];
  /** Eligible observations excluded by the response count/byte bound. */
  omittedCount:number;
}
export interface ResolveProjectWorkspaceRequest {optionId:string;expectedFingerprint:string}
export interface ProjectWorkspaceBridge {
  getProjectWorkspaceOptions():Promise<ProjectWorkspaceOptions>;
  resolveProjectWorkspace(request:ResolveProjectWorkspaceRequest):Promise<ProjectWorkspaceOption>;
}
export const PROJECT_WORKSPACE_LIMITS=Object.freeze({options:128,observations:1000,responseBytes:256*1024,id:4096,path:4096,branch:256,label:512});
function invalid():never {throw Error('현재 Orca 작업공간 목록에서 다시 선택해 주세요.');}

/** No paths, repository IDs or caller-provided verification flags are accepted. */
export function parseResolveProjectWorkspaceRequest(value:unknown):ResolveProjectWorkspaceRequest {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const names=Reflect.ownKeys(value);
  if(names.length!==2||!Object.hasOwn(value,'optionId')||!Object.hasOwn(value,'expectedFingerprint'))invalid();
  const id=Object.getOwnPropertyDescriptor(value,'optionId'),fingerprint=Object.getOwnPropertyDescriptor(value,'expectedFingerprint');
  if(!id||!('value' in id)||typeof id.value!=='string'||!/^project-workspace-[0-9a-f]{64}$/u.test(id.value)
    ||!fingerprint||!('value' in fingerprint)||typeof fingerprint.value!=='string'||!/^[0-9a-f]{64}$/u.test(fingerprint.value))invalid();
  return {optionId:id.value,expectedFingerprint:fingerprint.value};
}
