import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import type {SummaryCacheRecord} from '../summary/storage';
import {copyBoundedCacheData} from '../summary/storage/data';
import {inspectGitActivityMetadata,parseGitActivityDescriptor,validateGitActivityDescriptor,type GitActivityDescriptor} from '../summary/reading/git-activity-metadata';
import {GIT_METADATA_READ_LIMITS,GIT_METADATA_READ_PURPOSE,parseGitMetadataWorkstreamId,
  parseConfirmGitMetadataReadScopeRequest,parseCancelGitMetadataReadScopeRequest,parseRevokeGitMetadataReadScopeRequest,
  type GitMetadataReadProposal,type GitMetadataReadState} from '../shared/git-metadata-grants';

export interface GitMetadataRegisteredProject {worktree:string;projectIdentity:string}
/** The host must prove explicit authority for this exact worktree and every exact common path.
 * Configuration membership and a note/vault grant alone are not proof. Never renderer supplied. */
export interface ExistingGitMetadataReadAuthority {
  worktree:string;
  approvedCommonPaths:readonly string[];
  revision:number;
  validate:(signal?:AbortSignal)=>Promise<boolean>;
}
export interface GitMetadataReadAuthority {
  descriptor:GitActivityDescriptor;
  revision:number;
  identity:string;
  /** Call at each metadata-query boundary and immediately before publishing its result. */
  validate:(signal?:AbortSignal)=>Promise<boolean>;
}
interface Grant {
  grantId:string;workstreamId:string;projectBinding:string;revision:number;
  purpose:typeof GIT_METADATA_READ_PURPOSE;state:'granted'|'revoked';
  descriptor:GitActivityDescriptor|null;worktreeAncestors:string|null;commonAncestors:string|null;
}
export interface GitMetadataReadGrantsPayload {schemaVersion:1;grants:Grant[]}
export interface GitMetadataReadGrantsPersistence {
  read(signal?:AbortSignal):Promise<SummaryCacheRecord<GitMetadataReadGrantsPayload>|null>;
  write(payload:GitMetadataReadGrantsPayload,revision:number|null,signal?:AbortSignal):Promise<SummaryCacheRecord<GitMetadataReadGrantsPayload>>;
}
interface DirectoryStamp {path:string;identity:string;ancestors:string}
interface Project extends GitMetadataRegisteredProject {binding:string}
interface Recovery {workstreamId:string;previous:Grant[];priorRevision:number|null;attempted:Grant[];kind:'rollback'|'revoke'}
interface Proposal extends GitMetadataReadProposal {
  project:Project;worktreeStamp:DirectoryStamp;commonStamp:DirectoryStamp;
  generation:number;revision:number|null;controller:AbortController;confirming:boolean;
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const validRevision=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=1&&(value as number)<Number.MAX_SAFE_INTEGER;
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=GIT_METADATA_READ_LIMITS.path&&path.isAbsolute(value)&&path.normalize(value)===value&&value!==path.parse(value).root&&!/[\u0000-\u001f\u007f]/u.test(value);
const stopped=(signal?:AbortSignal):void=>{if(signal?.aborted)throw Error('Git 메타데이터 확인이 취소되었습니다.');};
const invalid=():never=>{throw Error('Git 메타데이터 읽기 권한 저장 형식을 확인하지 못했습니다. 기존 파일은 보존했습니다.');};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const newId=()=>'git-metadata-grant-'+randomUUID();
export const gitMetadataReadGrantsCodec={parse(input:unknown):GitMetadataReadGrantsPayload {
  const value=copyBoundedCacheData(input,1024*1024) as GitMetadataReadGrantsPayload;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='grants,schemaVersion'||value.schemaVersion!==1||!Array.isArray(value.grants)||value.grants.length>GIT_METADATA_READ_LIMITS.grants)invalid();
  const ids=new Set<string>(),projects=new Set<string>();
  for(const grant of value.grants){
    if(!grant||typeof grant!=='object'||Object.keys(grant).sort().join(',')!=='commonAncestors,descriptor,grantId,projectBinding,purpose,revision,state,workstreamId,worktreeAncestors'||
      typeof grant.grantId!=='string'||!/^git-metadata-grant-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(grant.grantId)||
      ids.has(grant.grantId)||!hash(grant.projectBinding)||!validRevision(grant.revision)||grant.purpose!==GIT_METADATA_READ_PURPOSE)invalid();
    parseGitMetadataWorkstreamId(grant.workstreamId);if(projects.has(grant.workstreamId))invalid();
    if(grant.state==='granted'){
      if(!hash(grant.worktreeAncestors)||!hash(grant.commonAncestors)||!grant.descriptor)invalid();
      grant.descriptor=parseGitActivityDescriptor(grant.descriptor);
    }else if(grant.state!=='revoked'||grant.descriptor!==null||grant.worktreeAncestors!==null||grant.commonAncestors!==null)invalid();
    ids.add(grant.grantId);projects.add(grant.workstreamId);
  }
  return structuredClone(value);
}};

/** Stat directory identities only. This helper never opens .git pointers/config/objects. */
async function inspectDirectory(directory:string,signal?:AbortSignal):Promise<DirectoryStamp> {
  if(!absolute(directory))throw Error('Git 메타데이터 폴더 경로를 확인할 수 없습니다.');
  let cursor=path.parse(directory).root;const identities:string[]=[];
  for(const component of ['',...directory.slice(cursor.length).split(path.sep)]){
    stopped(signal);if(component)cursor=path.join(cursor,component);
    const stat=await lstat(cursor);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Git 메타데이터 폴더 경로가 변경되었습니다. 다시 선택해 주세요.');
    identities.push(`${stat.dev}:${stat.ino}`);
  }
  stopped(signal);if(await realpath(directory)!==directory)throw Error('Git 메타데이터 폴더 경로가 변경되었습니다.');stopped(signal);
  return {path:directory,identity:identities[identities.length-1],ancestors:digest(JSON.stringify(identities))};
}
async function selectedDirectory(selected:string):Promise<DirectoryStamp> {
  if(!absolute(selected))throw Error('공유 Git 폴더를 선택해 주세요.');
  const canonical=await realpath(selected),first=await inspectDirectory(canonical),after=await inspectDirectory(canonical);
  if(!same(first,after))throw Error('선택한 Git 폴더가 변경되었습니다.');return first;
}
function identityMatches(stamp:DirectoryStamp,identity:{path:string;dev:number;ino:number}):boolean {
  return stamp.path===identity.path&&stamp.identity===`${identity.dev}:${identity.ino}`;
}

/** Main-owned, durable metadata-only grants. No arbitrary file-read method is exposed. */
export function createGitMetadataReadGrants(options:{
  persistence?:GitMetadataReadGrantsPersistence;unavailable?:boolean;now?:()=>number;
  resolveProject:(workstreamId:string)=>GitMetadataRegisteredProject|null|Promise<GitMetadataRegisteredProject|null>;
  existingAuthority?:(workstreamId:string,project:GitMetadataRegisteredProject,signal?:AbortSignal)=>ExistingGitMetadataReadAuthority|null|Promise<ExistingGitMetadataReadAuthority|null>;
  onInvalidate?:(workstreamId?:string)=>void;
}) {
  let grants:Grant[]=[],revision:number|null=null,loaded=false,loading:Promise<void>|null=null;
  let blocked=options.unavailable===true||!options.persistence,disposed=false,generation=0,writing=false;
  let proposal:Proposal|null=null,writeTail:Promise<unknown>=Promise.resolve();
  let recovery:Recovery|null=null;
  const denied=new Set<string>(),now=options.now??Date.now;
  function notify(workstreamId?:string):void {try{options.onInvalidate?.(workstreamId);}catch{/* Authority is already retired even if a notification consumer fails. */}}
  function retire(workstreamId?:string):void {generation++;proposal?.controller.abort();proposal=null;notify(workstreamId);}
  function invalidate():void {retire();}
  function dispose():void {disposed=true;retire();}
  async function load():Promise<void> {
    if(loaded)return;
    if(!loading)loading=(async()=>{try{
      if(!blocked){const saved=await options.persistence!.read();if(saved){
        if(!validRevision(saved.revision))invalid();const parsed=gitMetadataReadGrantsCodec.parse(saved.payload);
        if(parsed.grants.some(grant=>grant.revision>saved.revision))invalid();grants=parsed.grants;revision=saved.revision;
      }}
    }catch{blocked=true;grants=[];revision=null;retire();}finally{loaded=true;}})();
    await loading;
  }
  async function project(workstreamId:string):Promise<Project|null> {
    try{const value=await options.resolveProject(workstreamId);
      if(!value||!absolute(value.worktree)||typeof value.projectIdentity!=='string'||!value.projectIdentity.length||value.projectIdentity.length>16_384)return null;
      return {worktree:value.worktree,projectIdentity:value.projectIdentity,binding:digest(JSON.stringify([workstreamId,value.worktree,value.projectIdentity]))};
    }catch{return null;}
  }
  function active(version:number,signal?:AbortSignal):boolean {stopped(signal);return !blocked&&!disposed&&!writing&&version===generation;}
  async function validateStored(grant:Grant,version:number,signal?:AbortSignal):Promise<boolean> {
    stopped(signal);if(!active(version,signal)||denied.has(grant.workstreamId)||grant.state!=='granted'||!grant.descriptor||!grants.includes(grant))return false;
    try{
      const current=await project(grant.workstreamId);if(!current||current.binding!==grant.projectBinding||current.worktree!==grant.descriptor.worktree)return false;
      const tree=await inspectDirectory(current.worktree,signal),common=await inspectDirectory(grant.descriptor.commonDirectory,signal);
      if(!active(version,signal)||!identityMatches(tree,grant.descriptor.identities.worktree)||!identityMatches(common,grant.descriptor.identities.commonDirectory)||tree.ancestors!==grant.worktreeAncestors||common.ancestors!==grant.commonAncestors)return false;
      await validateGitActivityDescriptor(grant.descriptor,signal??new AbortController().signal);
      const after=await project(grant.workstreamId);
      return active(version,signal)&&!denied.has(grant.workstreamId)&&grants.includes(grant)&&current.binding===after?.binding;
    }catch{stopped(signal);return false;}
  }
  async function resolve(workstream:string,signal?:AbortSignal):Promise<GitMetadataReadAuthority|null> {
    const workstreamId=parseGitMetadataWorkstreamId(workstream);await load();stopped(signal);
    const version=generation;if(!active(version,signal)||denied.has(workstreamId))return null;
    const stored=grants.find(grant=>grant.workstreamId===workstreamId);
    if(stored){
      if(!await validateStored(stored,version,signal)||!stored.descriptor)return null;
      const descriptor=structuredClone(stored.descriptor),identity=digest(JSON.stringify(['explicit',stored]));
      return {descriptor,revision:stored.revision,identity,validate:async(nextSignal)=>{
        if(!same(descriptor,stored.descriptor))return false;
        return validateStored(stored,version,nextSignal??signal);
      }};
    }
    if(!options.existingAuthority)return null;
    try{
      const current=await project(workstreamId);if(!current||!active(version,signal))return null;
      const source=await options.existingAuthority(workstreamId,{worktree:current.worktree,projectIdentity:current.projectIdentity},signal);
      if(!source||source.worktree!==current.worktree||!validRevision(source.revision)||!Array.isArray(source.approvedCommonPaths)||!source.approvedCommonPaths.length||source.approvedCommonPaths.length>16||source.approvedCommonPaths.some(item=>!absolute(item))||typeof source.validate!=='function')return null;
      const commonPaths=[...new Set(source.approvedCommonPaths)].sort(),sourceRevision=source.revision;
      if(!await source.validate(signal)||!active(version,signal))return null;
      const tree=await inspectDirectory(current.worktree,signal);
      const descriptor=await inspectGitActivityMetadata(current.worktree,commonPaths,signal??new AbortController().signal);
      if(!commonPaths.includes(descriptor.commonDirectory)||!identityMatches(tree,descriptor.identities.worktree))return null;
      const common=await inspectDirectory(descriptor.commonDirectory,signal);
      const authorityIdentity=digest(JSON.stringify(['existing',workstreamId,current.binding,sourceRevision,tree,common,descriptor]));
      const captured=structuredClone(descriptor);
      async function validate(nextSignal:AbortSignal|undefined=signal):Promise<boolean> {
        if(!active(version,nextSignal)||denied.has(workstreamId)||grants.some(grant=>grant.workstreamId===workstreamId)||!same(descriptor,captured))return false;
        try{
          const before=await project(workstreamId);if(before?.binding!==current!.binding||source!.revision!==sourceRevision||!await source!.validate(nextSignal))return false;
          if(!same(tree,await inspectDirectory(current!.worktree,nextSignal))||!same(common,await inspectDirectory(descriptor.commonDirectory,nextSignal))||!active(version,nextSignal))return false;
          await validateGitActivityDescriptor(descriptor,nextSignal??new AbortController().signal);
          const after=await project(workstreamId),allowed=await source!.validate(nextSignal);
          return allowed&&before.binding===after?.binding&&active(version,nextSignal)&&!denied.has(workstreamId)&&!grants.some(grant=>grant.workstreamId===workstreamId);
        }catch{stopped(nextSignal);return false;}
      }
      if(!await validate(signal))return null;
      return {descriptor,revision:sourceRevision,identity:authorityIdentity,validate};
    }catch{stopped(signal);return null;}
  }
  async function view(workstream:string):Promise<GitMetadataReadState> {
    const workstreamId=parseGitMetadataWorkstreamId(workstream);await load();const version=generation,current=await project(workstreamId);
    const resolved=blocked||disposed?null:await resolve(workstreamId),authority=version===generation&&!blocked&&!disposed?resolved:null;
    const stored=grants.find(grant=>grant.workstreamId===workstreamId);
    const descriptor=authority?.descriptor??stored?.descriptor??null;
    const unavailable=blocked||disposed||!current||!!stored&&stored.state==='granted'&&!authority;
    const recoveryRequired=recovery?.workstreamId===workstreamId;
    return {workstreamId,revision,editable:!blocked&&!disposed&&!!current,revocable:!disposed&&(recoveryRequired||!blocked&&(stored?.state==='granted'||!!authority)),recoveryRequired,
      state:authority?'granted':unavailable?'unavailable':'ungranted',worktree:current?.worktree??descriptor?.worktree??null,
      commonDirectory:descriptor?.commonDirectory??null,gitDirectory:descriptor?.gitDirectory??null,identity:authority?.identity??(stored?.state==='granted'?digest(JSON.stringify(['explicit',stored])):null),purpose:GIT_METADATA_READ_PURPOSE,
      ...(unavailable?{error:recoveryRequired?'읽기 권한이 저장됐을 수 있습니다. 현재 메타데이터 읽기는 중단됐습니다. 저장 위치가 복구되면 읽기 허용 철회를 다시 눌러 완료한 뒤 앱을 다시 실행해 주세요.':blocked?'Git 메타데이터 권한 저장 위치를 확인하지 못했습니다. 기존 파일은 보존했습니다.':'프로젝트 또는 Git 폴더 연결이 변경되었습니다. 읽기 범위를 다시 확인해 주세요.'}:{})};
  }
  async function prepare(workstream:string,nativeChosenCommonDirectory:string):Promise<GitMetadataReadProposal> {
    const workstreamId=parseGitMetadataWorkstreamId(workstream);await load();
    if(blocked||disposed||writing)throw Error('Git 메타데이터 권한 저장 위치를 사용할 수 없습니다.');
    retire(workstreamId);const version=generation,current=await project(workstreamId);
    if(!current)throw Error('현재 프로젝트 연결을 확인할 수 없습니다.');
    const worktreeStamp=await inspectDirectory(current.worktree),commonStamp=await selectedDirectory(nativeChosenCommonDirectory);
    const after=await project(workstreamId);
    if(!active(version)||current.binding!==after?.binding)throw Error('Git 폴더 선택이 취소되었거나 프로젝트가 변경되었습니다.');
    if(!grants.some(grant=>grant.workstreamId===workstreamId)&&grants.length>=GIT_METADATA_READ_LIMITS.grants)throw Error('Git 메타데이터 권한 저장 한도에 도달했습니다.');
    const result:GitMetadataReadProposal={workstreamId,proposalId:'git-metadata-proposal-'+randomUUID(),worktree:current.worktree,commonDirectory:commonStamp.path,purpose:GIT_METADATA_READ_PURPOSE,expiresAt:now()+GIT_METADATA_READ_LIMITS.proposalLifetimeMs};
    proposal={...result,project:current,worktreeStamp,commonStamp,generation:version,revision,controller:new AbortController(),confirming:false};
    return {...result};
  }
  function cancel(input:unknown):void {
    const request=parseCancelGitMetadataReadScopeRequest(input);
    if(proposal?.proposalId===request.proposalId)retire(proposal.workstreamId);
  }
  function enqueue<T>(operation:()=>Promise<T>):Promise<T> {
    const work=writeTail.then(operation);writeTail=work.catch(()=>undefined);return work;
  }
  async function write(next:Grant[],signal?:AbortSignal):Promise<void> {
    if(blocked||disposed||!options.persistence)throw Error('Git 메타데이터 권한 저장을 사용할 수 없습니다.');
    const expected=gitMetadataReadGrantsCodec.parse({schemaVersion:1,grants:next});
    try{
      const saved=await options.persistence.write(expected,revision,signal);
      if(saved.revision!==(revision??0)+1||!same(gitMetadataReadGrantsCodec.parse(saved.payload),expected))throw Error('Git 메타데이터 권한 저장 결과를 확인할 수 없습니다.');
      grants=expected.grants;revision=saved.revision;
    }catch(error){blocked=true;retire();throw error;}
  }
  /** Internal cleanup is allowed after cancellation/disposal. A write rejection is not evidence
   * of rollback: the private cache may have committed before its cleanup failed. Never overwrite
   * an unrelated revision, and verify rollback by a fresh read even when that write also rejects. */
  async function restorePrevious(previous:Grant[],priorRevision:number|null,attempted:Grant[]):Promise<boolean> {
    if(!options.persistence)return false;
    const beforePayload=gitMetadataReadGrantsCodec.parse({schemaVersion:1,grants:previous});
    const attemptedPayload=gitMetadataReadGrantsCodec.parse({schemaVersion:1,grants:attempted});
    try{
      const saved=await options.persistence.read();
      if(!saved){if(priorRevision!==null||previous.length)return false;grants=[];revision=null;return true;}
      if(!validRevision(saved.revision))return false;
      const parsed=gitMetadataReadGrantsCodec.parse(saved.payload);
      if((saved.revision===priorRevision||saved.revision===(priorRevision??0)+2)&&same(parsed,beforePayload)){grants=parsed.grants;revision=saved.revision;return true;}
      if(saved.revision!==(priorRevision??0)+1||!same(parsed,attemptedPayload))return false;
      try{await options.persistence.write(beforePayload,saved.revision);}catch{/* Commit outcome is established by the following read. */}
      const restored=await options.persistence.read();
      if(!restored||restored.revision!==saved.revision+1||!same(gitMetadataReadGrantsCodec.parse(restored.payload),beforePayload))return false;
      grants=beforePayload.grants;revision=restored.revision;return true;
    }catch{return false;}
  }
  function requireRecovery(workstreamId:string,previous:Grant[],priorRevision:number|null,attempted:Grant[],kind:Recovery['kind']):never {
    recovery={workstreamId,previous:structuredClone(previous),priorRevision,attempted:structuredClone(attempted),kind};blocked=true;retire(workstreamId);
    throw Error('Git 읽기 권한이 저장됐을 수 있습니다. 저장 위치 복구 후 읽기 허용 철회를 다시 완료하기 전에는 앱을 다시 실행하지 마세요.');
  }
  async function finishRevocation(pending:Recovery):Promise<boolean> {
    if(!options.persistence)return false;
    try{
      const previous=gitMetadataReadGrantsCodec.parse({schemaVersion:1,grants:pending.previous}),attempted=gitMetadataReadGrantsCodec.parse({schemaVersion:1,grants:pending.attempted});
      let saved=await options.persistence.read();
      const unchanged=saved? saved.revision===pending.priorRevision&&same(gitMetadataReadGrantsCodec.parse(saved.payload),previous):pending.priorRevision===null&&!pending.previous.length;
      if(unchanged){try{await options.persistence.write(attempted,pending.priorRevision);}catch{/* Verify the actual commit outcome below. */}saved=await options.persistence.read();}
      if(!saved||saved.revision!==(pending.priorRevision??0)+1||!same(gitMetadataReadGrantsCodec.parse(saved.payload),attempted))return false;
      grants=attempted.grants;revision=saved.revision;return true;
    }catch{return false;}
  }
  async function confirm(input:unknown):Promise<GitMetadataReadState> {
    const request=parseConfirmGitMetadataReadScopeRequest(input);await load();const selected=proposal;
    const fresh=()=>!!selected&&selected.proposalId===request.proposalId&&proposal===selected&&!blocked&&!disposed&&selected.generation===generation&&selected.revision===revision&&selected.expiresAt>now()&&!selected.controller.signal.aborted;
    if(!fresh()||!selected||selected.confirming)throw Error('Git 메타데이터 읽기 확인이 만료되었거나 변경되었습니다.');
    selected.confirming=true;
    try{
      const signal=selected.controller.signal,current=await project(selected.workstreamId);
      if(!fresh()||current?.binding!==selected.project.binding)throw Error('프로젝트 연결이 변경되었습니다. 다시 선택해 주세요.');
      const tree=await inspectDirectory(selected.worktree,signal),common=await inspectDirectory(selected.commonDirectory,signal);
      if(!fresh()||!same(tree,selected.worktreeStamp)||!same(common,selected.commonStamp))throw Error('선택한 Git 폴더가 변경되었습니다.');
      // The explicit confirmation above is the first point that authorizes Git metadata reads.
      const descriptor=await inspectGitActivityMetadata(selected.worktree,[selected.commonDirectory],signal);
      if(descriptor.worktree!==selected.worktree||descriptor.commonDirectory!==selected.commonDirectory||!identityMatches(tree,descriptor.identities.worktree)||!identityMatches(common,descriptor.identities.commonDirectory))throw Error('선택한 공유 Git 폴더가 이 프로젝트와 일치하지 않습니다.');
      await validateGitActivityDescriptor(descriptor,signal);
      if(!fresh()||(await project(selected.workstreamId))?.binding!==selected.project.binding||!same(tree,await inspectDirectory(selected.worktree,signal))||!same(common,await inspectDirectory(selected.commonDirectory,signal))||!fresh())throw Error('Git 메타데이터 읽기 확인이 취소되었거나 변경되었습니다.');
      return await enqueue(async()=>{
        if(!fresh())throw Error('Git 메타데이터 읽기 확인이 취소되었거나 변경되었습니다.');
        writing=true;const previous=structuredClone(grants),priorRevision=revision;
        try{
          const grant:Grant={grantId:newId(),workstreamId:selected.workstreamId,projectBinding:selected.project.binding,revision:(revision??0)+1,purpose:GIT_METADATA_READ_PURPOSE,state:'granted',descriptor,worktreeAncestors:tree.ancestors,commonAncestors:common.ancestors};
          const attempted=[...grants.filter(item=>item.workstreamId!==selected.workstreamId),grant];
          try{await write(attempted,signal);}catch(error){
            if(!await restorePrevious(previous,priorRevision,attempted))requireRecovery(selected.workstreamId,previous,priorRevision,attempted,'rollback');
            throw error;
          }
          const cancelledAfterCommit=()=>proposal!==selected||selected.generation!==generation||signal.aborted||selected.expiresAt<=now()||disposed;
          // A persistence adapter may finish after cancellation. Compensate before admitting reads.
          if(cancelledAfterCommit()){
            if(!await restorePrevious(previous,priorRevision,attempted))requireRecovery(selected.workstreamId,previous,priorRevision,attempted,'rollback');
            throw Error('Git 메타데이터 읽기 확인이 취소되었습니다.');
          }
          denied.delete(selected.workstreamId);writing=false;
          const state=await view(selected.workstreamId);
          writing=true;
          // Keep the proposal cancellable through the final asynchronous state/revalidation read.
          if(cancelledAfterCommit()){
            if(!await restorePrevious(previous,priorRevision,attempted))requireRecovery(selected.workstreamId,previous,priorRevision,attempted,'rollback');
            throw Error('Git 메타데이터 읽기 확인이 취소되었습니다.');
          }
          retire(selected.workstreamId);return state;
        }finally{writing=false;}
      });
    }catch(error){if(proposal===selected)retire(selected.workstreamId);throw error;}
  }
  async function revoke(input:unknown):Promise<GitMetadataReadState> {
    const request=parseRevokeGitMetadataReadScopeRequest(input);await load();
    if(disposed||request.expectedRevision!==revision||blocked&&recovery?.workstreamId!==request.workstreamId)throw Error('Git 메타데이터 권한이 변경되었습니다. 다시 확인해 주세요.');
    if(recovery){
      const pending=recovery;if(pending.workstreamId!==request.workstreamId)throw Error('복구할 Git 메타데이터 프로젝트를 다시 확인해 주세요.');
      denied.add(request.workstreamId);retire(request.workstreamId);
      await enqueue(async()=>{
        if(recovery!==pending)throw Error('Git 메타데이터 권한 복구 상태가 변경되었습니다. 다시 확인해 주세요.');
        writing=true;
        try{
          if(pending.kind==='revoke'){
            if(!await finishRevocation(pending))requireRecovery(pending.workstreamId,pending.previous,pending.priorRevision,pending.attempted,pending.kind);
            recovery=null;blocked=false;return;
          }
          if(!await restorePrevious(pending.previous,pending.priorRevision,pending.attempted))requireRecovery(pending.workstreamId,pending.previous,pending.priorRevision,pending.attempted,pending.kind);
          const previous=structuredClone(grants),priorRevision=revision,projectBinding=pending.attempted.find(grant=>grant.workstreamId===pending.workstreamId)!.projectBinding;
          const tombstone:Grant={grantId:newId(),workstreamId:pending.workstreamId,projectBinding,revision:(revision??0)+1,purpose:GIT_METADATA_READ_PURPOSE,state:'revoked',descriptor:null,worktreeAncestors:null,commonAncestors:null};
          const attempted=[...grants.filter(grant=>grant.workstreamId!==pending.workstreamId),tombstone];
          blocked=false;
          try{await write(attempted);}catch{requireRecovery(pending.workstreamId,previous,priorRevision,attempted,'revoke');}
          recovery=null;
        }finally{writing=false;}
      });
      return view(request.workstreamId);
    }
    const stored=grants.find(grant=>grant.workstreamId===request.workstreamId),current=await project(request.workstreamId);
    if(request.expectedRevision!==revision||(!current&&!stored))throw Error('현재 프로젝트의 Git 메타데이터 권한을 확인할 수 없습니다.');
    if(!stored&&grants.length>=GIT_METADATA_READ_LIMITS.grants)throw Error('Git 메타데이터 권한 저장 한도에 도달했습니다.');
    denied.add(request.workstreamId);retire(request.workstreamId);
    await enqueue(async()=>{
      writing=true;
      const previous=structuredClone(grants),priorRevision=revision;
      try{const tombstone:Grant={grantId:newId(),workstreamId:request.workstreamId,projectBinding:current?.binding??stored!.projectBinding,revision:(revision??0)+1,purpose:GIT_METADATA_READ_PURPOSE,state:'revoked',descriptor:null,worktreeAncestors:null,commonAncestors:null};
        const attempted=[...grants.filter(grant=>grant.workstreamId!==request.workstreamId),tombstone];
        try{await write(attempted);}catch{requireRecovery(request.workstreamId,previous,priorRevision,attempted,'revoke');}
      }finally{writing=false;}
    });
    return view(request.workstreamId);
  }
  function hasUnresolvedRecovery():boolean {return recovery!==null;}
  async function settle():Promise<void> {
    await loading;await writeTail;
    if(hasUnresolvedRecovery())throw Error('Git 읽기 권한 복구가 완료되지 않았습니다. 읽기 허용 철회를 완료한 뒤 앱을 종료해 주세요.');
  }
  return {load,view,prepare,confirm,cancel,revoke,resolve,invalidate,dispose,settle,hasUnresolvedRecovery};
}
