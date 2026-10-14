/** Local Git identity/time lookup only. This is neither a file-read grant nor AI transmission consent. */
export const GIT_METADATA_READ_PURPOSE = 'local-commit-identity-time' as const;
export const GIT_METADATA_READ_LIMITS = Object.freeze({grants:128,proposals:1,workstreamId:1024,path:4096,proposalLifetimeMs:120_000});

export interface GitMetadataReadState {
  workstreamId:string;
  revision:number|null;
  editable:boolean;
  revocable:boolean;
  /** A permission write may have committed; only explicit recovery/revocation is available. */
  recoveryRequired:boolean;
  state:'ungranted'|'granted'|'unavailable';
  worktree:string|null;
  commonDirectory:string|null;
  gitDirectory:string|null;
  /** Opaque binding for display/consent invalidation. Never a general filesystem capability. */
  identity:string|null;
  purpose:typeof GIT_METADATA_READ_PURPOSE;
  error?:string;
}
export interface GitMetadataReadProposal {
  workstreamId:string;
  proposalId:string;
  worktree:string;
  commonDirectory:string;
  purpose:typeof GIT_METADATA_READ_PURPOSE;
  expiresAt:number;
}
export interface GitMetadataReadBridge {
  getGitMetadataReadState(request:{workstreamId:string}):Promise<GitMetadataReadState>;
  selectGitMetadataReadScope(request:{workstreamId:string}):Promise<GitMetadataReadProposal|null>;
  confirmGitMetadataReadScope(request:{proposalId:string;metadataReadConfirmed:true}):Promise<GitMetadataReadState>;
  cancelGitMetadataReadScope(request:{proposalId:string}):Promise<void>;
  revokeGitMetadataReadScope(request:{workstreamId:string;expectedRevision:number|null}):Promise<GitMetadataReadState>;
}

function invalid():never {throw Error('Git 메타데이터 읽기 요청을 다시 확인해 주세요.');}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length)invalid();
  const result:Record<string,unknown>={};
  for(const key of keys){const field=Object.getOwnPropertyDescriptor(value,key);if(!field||!('value' in field))invalid();result[key]=field.value;}
  return result;
}
export function parseGitMetadataWorkstreamId(value:unknown):string {
  if(typeof value!=='string'||!value.length||value.length>GIT_METADATA_READ_LIMITS.workstreamId||/[\u0000-\u001f\u007f]/u.test(value))invalid();
  return value;
}
function proposalId(value:unknown):string {
  if(typeof value!=='string'||!/^git-metadata-proposal-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))invalid();
  return value;
}
export function parseGetGitMetadataReadStateRequest(value:unknown):{workstreamId:string} {
  const request=fields(value,['workstreamId']);return {workstreamId:parseGitMetadataWorkstreamId(request.workstreamId)};
}
export function parseSelectGitMetadataReadScopeRequest(value:unknown):{workstreamId:string} {
  return parseGetGitMetadataReadStateRequest(value);
}
export function parseConfirmGitMetadataReadScopeRequest(value:unknown):{proposalId:string;metadataReadConfirmed:true} {
  const request=fields(value,['proposalId','metadataReadConfirmed']);if(request.metadataReadConfirmed!==true)invalid();
  return {proposalId:proposalId(request.proposalId),metadataReadConfirmed:true};
}
export function parseCancelGitMetadataReadScopeRequest(value:unknown):{proposalId:string} {
  const request=fields(value,['proposalId']);return {proposalId:proposalId(request.proposalId)};
}
export function parseRevokeGitMetadataReadScopeRequest(value:unknown):{workstreamId:string;expectedRevision:number|null} {
  const request=fields(value,['workstreamId','expectedRevision']);
  if(request.expectedRevision!==null&&(!Number.isSafeInteger(request.expectedRevision)||(request.expectedRevision as number)<1||(request.expectedRevision as number)>=Number.MAX_SAFE_INTEGER))invalid();
  return {workstreamId:parseGitMetadataWorkstreamId(request.workstreamId),expectedRevision:request.expectedRevision as number|null};
}
