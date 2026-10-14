import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {copyBoundedCacheData} from '../summary/storage/data';
import type {SummaryCacheRecord} from '../summary/storage';
import {
  PROJECT_DOCUMENT_ROOT_LIMITS,parseProjectDocumentProjectId,parseProjectDocumentRootKind,
  parseConfirmProjectDocumentRootRequest,parseCancelProjectDocumentRootRequest,parseRevokeProjectDocumentRootRequest,
} from '../shared/project-document-roots';
import type {ProjectDocumentRootKind,ProjectDocumentRootProposal,ProjectDocumentRootsView} from '../shared/project-document-roots';

/** Main-owned grant. Never accept this structure, identity, or a path from renderer input. */
export interface ProjectDocumentRoot {
  id:string;projectId:string;path:string;kind:ProjectDocumentRootKind;
  identity:string;ancestors:string;binding:string;
}
export interface ProjectDocumentRootsPayload {schemaVersion:1;roots:ProjectDocumentRoot[]}
export interface ProjectDocumentRootsPersistence {
  read(signal?:AbortSignal):Promise<SummaryCacheRecord<ProjectDocumentRootsPayload>|null>;
  write(payload:ProjectDocumentRootsPayload,revision:number|null,signal?:AbortSignal):Promise<SummaryCacheRecord<ProjectDocumentRootsPayload>>;
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=PROJECT_DOCUMENT_ROOT_LIMITS.path&&path.isAbsolute(value)&&path.normalize(value)===value&&value!==path.parse(value).root&&!/[\u0000-\u001f\u007f]/u.test(value);
const uuid=/^document-root-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const physical=/^\d+:\d+$/u;
const hash=/^[0-9a-f]{64}$/u;
const invalid=():never=>{throw Error('프로젝트 문서 읽기 권한 저장 형식을 확인하지 못했습니다. 기존 파일은 보존했습니다.');};
const stopped=(signal?:AbortSignal)=>{if(signal?.aborted)throw Error('문서 폴더 확인이 취소되었습니다.');};
export const projectDocumentRootsCodec={parse(input:unknown):ProjectDocumentRootsPayload {
  const value=copyBoundedCacheData(input,1024*1024) as ProjectDocumentRootsPayload;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='roots,schemaVersion'||value.schemaVersion!==1||!Array.isArray(value.roots)||value.roots.length>PROJECT_DOCUMENT_ROOT_LIMITS.roots)invalid();
  const ids=new Set<string>(),paths=new Set<string>(),counts=new Map<string,number>();
  for(const root of value.roots){
    if(!root||typeof root!=='object'||Object.keys(root).sort().join(',')!=='ancestors,binding,id,identity,kind,path,projectId'||typeof root.id!=='string'||!uuid.test(root.id)||ids.has(root.id)||!absolute(root.path)||typeof root.identity!=='string'||!physical.test(root.identity)||typeof root.ancestors!=='string'||!hash.test(root.ancestors)||typeof root.binding!=='string'||!hash.test(root.binding))invalid();
    parseProjectDocumentProjectId(root.projectId);parseProjectDocumentRootKind(root.kind);
    const key=JSON.stringify([root.projectId,root.path]),count=(counts.get(root.projectId)??0)+1;
    if(paths.has(key)||count>PROJECT_DOCUMENT_ROOT_LIMITS.rootsPerProject)invalid();
    ids.add(root.id);paths.add(key);counts.set(root.projectId,count);
  }
  return structuredClone(value);
}};

/** Inspect every component without following symlinks. Includes ancestor identity so moving an
 * unchanged root inode beneath a replaced parent never silently preserves the old grant. */
async function inspectDirectory(directory:string,signal?:AbortSignal):Promise<{path:string;identity:string;ancestors:string}> {
  if(!absolute(directory))throw Error('문서 폴더 경로를 확인할 수 없습니다.');
  let cursor=path.parse(directory).root;const identities:string[]=[];
  for(const component of ['',...directory.slice(cursor.length).split(path.sep)]){
    stopped(signal);if(component)cursor=path.join(cursor,component);
    const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('문서 폴더 경로가 변경되었습니다. 다시 선택해 주세요.');
    identities.push(`${stat.dev}:${stat.ino}`);
  }
  stopped(signal);if(await realpath(directory)!==directory)throw Error('문서 폴더 경로가 변경되었습니다. 다시 선택해 주세요.');
  return {path:directory,identity:identities[identities.length-1],ancestors:digest(JSON.stringify(identities))};
}
async function selectedDirectory(selectedPath:string) {
  if(!absolute(selectedPath))throw Error('문서 폴더 경로를 확인할 수 없습니다.');
  // Only a native picker may supply an alias. Show its canonical destination before approval.
  const canonical=await realpath(selectedPath),first=await inspectDirectory(canonical),after=await inspectDirectory(canonical);
  if(first.identity!==after.identity||first.ancestors!==after.ancestors)throw Error('선택한 문서 폴더가 변경되었습니다.');
  return first;
}

/** Separate, explicit project document grants. No initial vault grants, scans, source writes,
 * model calls, or inferred folder relationships. Persist only after a native proposal is confirmed. */
export function createProjectDocumentRoots(options:{
  persistence?:ProjectDocumentRootsPersistence;unavailable?:boolean;now?:()=>number;
  isProjectAvailable:(projectId:string)=>boolean|Promise<boolean>;
  projectIdentity?:(projectId:string)=>string|null|Promise<string|null>;
  /** Main-owned scope policy, e.g. excludes whole vault/worktree roots and their ancestors. */
  isDirectoryAllowed?:(projectId:string,canonicalPath:string)=>boolean|Promise<boolean>;
}) {
  let roots:ProjectDocumentRoot[]=[],revision:number|null=null,loaded=false,loading:Promise<void>|null=null,busy=false,generation=0;
  let blocked=options.unavailable===true||!options.persistence;
  let proposal:(ProjectDocumentRootProposal&{identity:string;ancestors:string;binding:string;generation:number;revision:number|null})|null=null;
  const now=options.now??Date.now;
  async function binding(projectId:string):Promise<string|null> {
    try{if(!await options.isProjectAvailable(projectId))return null;const identity=options.projectIdentity?await options.projectIdentity(projectId):projectId;
      return typeof identity==='string'&&identity.length>0&&identity.length<=16384?digest(JSON.stringify([projectId,identity])):null;
    }catch{return null;}
  }
  async function directoryAllowed(projectId:string,canonicalPath:string):Promise<boolean> {
    try{return options.isDirectoryAllowed?await options.isDirectoryAllowed(projectId,canonicalPath)===true:true;}catch{return false;}
  }
  async function load():Promise<void> {
    if(loaded)return;
    if(!loading)loading=(async()=>{try{
      if(!blocked){const saved=await options.persistence!.read();if(saved){
        if(!Number.isSafeInteger(saved.revision)||saved.revision<1||saved.revision>=Number.MAX_SAFE_INTEGER)throw Error('Invalid document permission revision');
        roots=projectDocumentRootsCodec.parse(saved.payload).roots;revision=saved.revision;
      }}
    }catch{blocked=true;roots=[];revision=null;}finally{loaded=true;}})();
    await loading;
  }
  async function valid(root:ProjectDocumentRoot,signal?:AbortSignal):Promise<boolean> {
    stopped(signal);try{
      if(!await directoryAllowed(root.projectId,root.path))return false;
      const current=await inspectDirectory(root.path,signal);
      if(current.identity!==root.identity||current.ancestors!==root.ancestors)return false;
      const allowed=await directoryAllowed(root.projectId,root.path);stopped(signal);return allowed;
    }catch(error){stopped(signal);return false;}
  }
  async function view(project: string):Promise<ProjectDocumentRootsView> {
    const projectId=parseProjectDocumentProjectId(project);await load();const current=blocked?null:await binding(projectId);
    const base={projectId,revision,editable:!blocked&&current!==null};
    if(blocked)return {...base,roots:[],error:'문서 읽기 권한 저장 위치를 확인하지 못했습니다. 기존 파일은 보존했습니다.'};
    return {...base,...(!current?{error:'현재 프로젝트 연결을 확인할 수 없습니다.'}:{}),roots:await Promise.all(roots.filter(root=>root.projectId===projectId).map(async root=>({id:root.id,projectId,path:root.path,kind:root.kind,available:current===root.binding&&await valid(root)})))};
  }
  async function prepare(project:string,nativeSelectedPath:string,selectedKind:ProjectDocumentRootKind):Promise<ProjectDocumentRootProposal> {
    const projectId=parseProjectDocumentProjectId(project),kind=parseProjectDocumentRootKind(selectedKind);await load();
    if(busy||blocked)throw Error('문서 읽기 권한 저장 위치를 사용할 수 없습니다.');
    proposal=null;const version=++generation,current=await binding(projectId);
    if(!current)throw Error('현재 프로젝트 연결을 확인할 수 없습니다.');
    const chosen=await selectedDirectory(nativeSelectedPath);
    const after=await binding(projectId);
    if(!await directoryAllowed(projectId,chosen.path))throw Error('전체 저장소 또는 볼트 대신 이 프로젝트의 문서·검수 폴더를 선택해 주세요.');
    if(version!==generation||busy||current!==after)throw Error('문서 폴더 선택이 취소되었거나 프로젝트가 변경되었습니다.');
    if(!roots.some(root=>root.projectId===projectId&&root.path===chosen.path)&&(roots.length>=PROJECT_DOCUMENT_ROOT_LIMITS.roots||roots.filter(root=>root.projectId===projectId).length>=PROJECT_DOCUMENT_ROOT_LIMITS.rootsPerProject))throw Error('이 프로젝트에 연결할 수 있는 문서 폴더 수에 도달했습니다. 기존 연결을 해제한 뒤 추가해 주세요.');
    proposal={projectId,proposalId:'document-root-proposal-'+randomUUID(),path:chosen.path,kind,expiresAt:now()+PROJECT_DOCUMENT_ROOT_LIMITS.proposalLifetimeMs,identity:chosen.identity,ancestors:chosen.ancestors,binding:current,generation:version,revision};
    return {projectId,proposalId:proposal.proposalId,path:proposal.path,kind,expiresAt:proposal.expiresAt};
  }
  function cancel(value:unknown):void {
    const request=parseCancelProjectDocumentRootRequest(value);
    if(proposal?.projectId===request.projectId&&proposal.proposalId===request.proposalId){proposal=null;generation++;}
  }
  function invalidate():void {proposal=null;generation++;}
  async function save(next:ProjectDocumentRoot[]):Promise<void> {
    if(!options.persistence||blocked||busy)throw Error('문서 읽기 권한 저장을 사용할 수 없습니다.');
    const expected=projectDocumentRootsCodec.parse({schemaVersion:1,roots:next});
    busy=true;
    try{const saved=await options.persistence.write(expected,revision);
      if(saved.revision!==(revision??0)+1||JSON.stringify(projectDocumentRootsCodec.parse(saved.payload))!==JSON.stringify(expected))throw Error('문서 읽기 권한 저장 결과를 확인할 수 없습니다.');
      roots=expected.roots;revision=saved.revision;invalidate();
    }catch(error){
      // A failed write may already have committed. Never continue with uncertain read authority.
      blocked=true;invalidate();throw error;
    }finally{busy=false;}
  }
  async function confirm(value:unknown):Promise<ProjectDocumentRootsView> {
    const request=parseConfirmProjectDocumentRootRequest(value);await load();const selected=proposal;
    const fresh=()=>!busy&&!blocked&&proposal===selected&&!!selected&&selected.projectId===request.projectId&&selected.proposalId===request.proposalId&&selected.generation===generation&&selected.revision===revision&&selected.expiresAt>now();
    if(!fresh()||!selected)throw Error('문서 폴더 확인이 만료되었거나 변경되었습니다.');
    const current=await binding(request.projectId);
    const checked=await inspectDirectory(selected.path);
    const after=await binding(request.projectId);
    if(!await directoryAllowed(request.projectId,selected.path))throw Error('현재 프로젝트에서 허용되지 않는 문서 폴더입니다. 다시 선택해 주세요.');
    if(!fresh()||current!==selected.binding||current!==after||checked.identity!==selected.identity||checked.ancestors!==selected.ancestors)throw Error('문서 폴더 또는 프로젝트 연결이 변경되었습니다. 다시 선택해 주세요.');
    const prior=roots.find(root=>root.projectId===request.projectId&&root.path===selected.path);
    if(prior&&prior.kind===selected.kind&&prior.identity===selected.identity&&prior.ancestors===selected.ancestors&&prior.binding===selected.binding){invalidate();return view(request.projectId);}
    if(!fresh())throw Error('문서 폴더 확인이 취소되었거나 만료되었습니다.');
    const root:ProjectDocumentRoot={id:'document-root-'+randomUUID(),projectId:request.projectId,path:selected.path,kind:selected.kind,identity:selected.identity,ancestors:selected.ancestors,binding:selected.binding};
    await save([...roots.filter(item=>item!==prior),root]);return view(request.projectId);
  }
  async function revoke(value:unknown):Promise<ProjectDocumentRootsView> {
    const request=parseRevokeProjectDocumentRootRequest(value);await load();
    if(request.expectedRevision!==revision||!roots.some(root=>root.projectId===request.projectId&&root.id===request.rootId))throw Error('문서 읽기 권한이 변경되었습니다. 다시 확인해 주세요.');
    await save(roots.filter(root=>root.id!==request.rootId));return view(request.projectId);
  }
  async function rootsFor(project:string,signal?:AbortSignal):Promise<ProjectDocumentRoot[]> {
    const projectId=parseProjectDocumentProjectId(project);await load();stopped(signal);if(blocked)return [];
    const current=await binding(projectId),version=generation,result:ProjectDocumentRoot[]=[];
    if(!current)return [];
    for(const root of roots.filter(item=>item.projectId===projectId&&item.binding===current)){if(await valid(root,signal))result.push(structuredClone(root));}
    const after=await binding(projectId);stopped(signal);return !blocked&&version===generation&&current===after?result:[];
  }
  async function revalidate(root:ProjectDocumentRoot,signal?:AbortSignal):Promise<boolean> {
    await load();stopped(signal);if(blocked)return false;
    const stored=roots.find(item=>item.id===root.id);
    if(!stored||JSON.stringify(stored)!==JSON.stringify(root))return false;
    const version=generation,current=await binding(stored.projectId);
    if(current!==stored.binding||!await valid(stored,signal))return false;
    const after=await binding(stored.projectId);stopped(signal);
    return !blocked&&version===generation&&current===after;
  }
  return {load,view,prepare,confirm,cancel,revoke,rootsFor,revalidate,invalidate};
}
