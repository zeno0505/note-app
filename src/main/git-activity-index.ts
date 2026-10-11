import {createHash} from 'node:crypto';
import {
  GIT_ACTIVITY_RESOLVER_CONTRACT,
  type GitActivityReference,
} from '../summary/reading/git-activity-metadata';
import {copyBoundedCacheData} from '../summary/storage/data';
import type {SummaryCacheRecord} from '../summary/storage';

export const GIT_ACTIVITY_INDEX_LIMITS = Object.freeze({
  projects:128, references:8192, records:8192, batch:128,
  referenceBytes:256, payloadBytes:3*1024*1024, pendingRequests:32,
});

/** Host-owned bindings. authorityKey includes identity and grant revision, never just a path. */
export interface GitActivityIndexInput {
  readonly projectId:string;
  readonly authorityKey:string;
  readonly objectRevision:string;
  readonly declaredReferences:readonly string[];
}
export interface GitActivityCoverage {
  checked:number;
  total:number;
  resolved:number;
  /** Includes unsupported declarations; unsupported is a subset of unresolved. */
  unresolved:number;
  unsupported:number;
  pending:number;
  state:'complete'|'partial'|'unavailable';
}
export interface GitActivityIndexObservation {
  records:GitActivityReference[];
  coverage:GitActivityCoverage;
}
export interface GitActivityIndexProject {
  projectId:string;
  authorityKey:string;
  objectRevision:string;
  resolverContract:string;
  declaredSetHash:string;
  declaredReferences:string[];
  /** An exact deterministic prefix of declaredReferences, including unresolved results. */
  records:GitActivityReference[];
}
export interface GitActivityIndexPayload {schemaVersion:1;projects:GitActivityIndexProject[]}
export interface GitActivityIndexPersistence {
  read(signal?:AbortSignal):Promise<SummaryCacheRecord<GitActivityIndexPayload>|null>;
  write(payload:GitActivityIndexPayload,expectedRevision:number|null,signal?:AbortSignal):Promise<SummaryCacheRecord<GitActivityIndexPayload>>;
}
export interface GitActivityIndexOptions {
  persistence?:GitActivityIndexPersistence;
  resolveBatch:(projectId:string,references:readonly string[],signal:AbortSignal,input:GitActivityIndexInput)=>Promise<GitActivityReference[]>;
  /** Must recheck current identity/grants and the object revision against this immutable input. */
  validateAuthority:(input:GitActivityIndexInput,signal:AbortSignal)=>boolean|Promise<boolean>;
  operationTimeoutMs?:number;
}

const invalid=():never=>{throw Error('Invalid Git activity index');};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
function fields(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))return invalid();
  return value as Record<string,unknown>;
}
function boundedString(value:unknown,maximum:number):value is string {
  return typeof value==='string'&&value.length>0&&value.length<=maximum&&Buffer.byteLength(value)<=maximum&&!/[\x00-\x1f\x7f]/.test(value);
}
function reference(value:unknown):value is string {
  // Non-hex declarations remain exact inert metadata so unsupported coverage is visible.
  return boundedString(value,GIT_ACTIVITY_INDEX_LIMITS.referenceBytes);
}
function sortedReferences(value:unknown):string[] {
  if(!Array.isArray(value)||value.length>GIT_ACTIVITY_INDEX_LIMITS.references||value.some(item=>!reference(item)))return invalid();
  return [...new Set(value as string[])].sort(compare);
}
/** SHA-256 of the exact case-sensitive sorted unique declared set, with unambiguous encoding. */
export function gitActivityDeclaredSetHash(references:readonly string[]):string {
  const detached=copyBoundedCacheData(references,GIT_ACTIVITY_INDEX_LIMITS.payloadBytes);
  return 'sha256:'+createHash('sha256').update(JSON.stringify(sortedReferences(detached))).digest('hex');
}
function parseInput(value:unknown):GitActivityIndexInput {
  const raw=fields(copyBoundedCacheData(value,GIT_ACTIVITY_INDEX_LIMITS.payloadBytes),['projectId','authorityKey','objectRevision','declaredReferences']);
  if(!boundedString(raw.projectId,256)||!boundedString(raw.authorityKey,16_384)||!boundedString(raw.objectRevision,1024))return invalid();
  return Object.freeze({projectId:raw.projectId,authorityKey:raw.authorityKey,objectRevision:raw.objectRevision,
    declaredReferences:Object.freeze(sortedReferences(raw.declaredReferences))});
}
function parseReference(value:unknown):GitActivityReference {
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const raw=value as Record<string,unknown>;
  if(!reference(raw.declaredReference))return invalid();
  if(raw.status==='resolved') {
    fields(raw,['declaredReference','status','fullSha','at']);
    if(!/^[a-f0-9]{4,40}$/i.test(raw.declaredReference)||typeof raw.fullSha!=='string'||!/^[a-f0-9]{40}$/.test(raw.fullSha)||
      !raw.fullSha.startsWith(raw.declaredReference.toLowerCase())||typeof raw.at!=='string'||!Number.isFinite(Date.parse(raw.at))||
      new Date(raw.at).toISOString()!==raw.at)return invalid();
    return {declaredReference:raw.declaredReference,status:'resolved',fullSha:raw.fullSha,at:raw.at};
  }
  fields(raw,['declaredReference','status']);
  if(!['ambiguous','missing','noncommit','unsupported'].includes(raw.status as string))return invalid();
  return {declaredReference:raw.declaredReference,status:raw.status as GitActivityReference['status']};
}
export const gitActivityIndexCodec={parse(value:unknown):GitActivityIndexPayload {
  const raw=fields(copyBoundedCacheData(value,GIT_ACTIVITY_INDEX_LIMITS.payloadBytes),['schemaVersion','projects']);
  if(raw.schemaVersion!==1||!Array.isArray(raw.projects)||raw.projects.length>GIT_ACTIVITY_INDEX_LIMITS.projects)return invalid();
  let references=0,records=0;
  const projects=raw.projects.map(value=>{
    const item=fields(value,['projectId','authorityKey','objectRevision','resolverContract','declaredSetHash','declaredReferences','records']);
    if(!boundedString(item.projectId,256)||!boundedString(item.authorityKey,16_384)||!boundedString(item.objectRevision,1024)||
      !boundedString(item.resolverContract,128)||!Array.isArray(item.records))return invalid();
    const declaredReferences=sortedReferences(item.declaredReferences);
    if(JSON.stringify(declaredReferences)!==JSON.stringify(item.declaredReferences)||
      item.declaredSetHash!==gitActivityDeclaredSetHash(declaredReferences)||item.records.length>declaredReferences.length)return invalid();
    const checked=item.records.map(parseReference);
    if(checked.some((row,index)=>row.declaredReference!==declaredReferences[index]))return invalid();
    references+=declaredReferences.length;records+=checked.length;
    if(references>GIT_ACTIVITY_INDEX_LIMITS.references||records>GIT_ACTIVITY_INDEX_LIMITS.records)return invalid();
    return {projectId:item.projectId,authorityKey:item.authorityKey,objectRevision:item.objectRevision,
      resolverContract:item.resolverContract,declaredSetHash:item.declaredSetHash as string,declaredReferences,records:checked};
  });
  if(new Set(projects.map(project=>project.projectId)).size!==projects.length)return invalid();
  return {schemaVersion:1,projects};
}};

function observation(input:GitActivityIndexInput,records:readonly GitActivityReference[],unavailable=false):GitActivityIndexObservation {
  const rows=unavailable?[]:records.map(row=>({...row}));
  const total=input.declaredReferences.length,checked=rows.length,resolved=rows.filter(row=>row.status==='resolved').length;
  return {records:rows,coverage:{checked,total,resolved,unresolved:checked-resolved,
    unsupported:rows.filter(row=>row.status==='unsupported').length,pending:total-checked,
    state:unavailable?'unavailable':checked===total&&resolved===total?'complete':'partial'}};
}
function binding(input:GitActivityIndexInput):GitActivityIndexProject {
  return {projectId:input.projectId,authorityKey:input.authorityKey,objectRevision:input.objectRevision,
    resolverContract:GIT_ACTIVITY_RESOLVER_CONTRACT,declaredSetHash:gitActivityDeclaredSetHash(input.declaredReferences),
    declaredReferences:[...input.declaredReferences],records:[]};
}
function matches(project:GitActivityIndexProject,input:GitActivityIndexInput):boolean {
  return project.authorityKey===input.authorityKey&&project.objectRevision===input.objectRevision&&
    project.resolverContract===GIT_ACTIVITY_RESOLVER_CONTRACT&&project.declaredSetHash===gitActivityDeclaredSetHash(input.declaredReferences)&&
    JSON.stringify(project.declaredReferences)===JSON.stringify(input.declaredReferences);
}

/**
 * Main-owned, caller-driven metadata only. A single queue serializes all projects and lifecycle
 * changes; no polling, timestamps, automatic retries, branch lookup, or implicit Git authority.
 * Every observation rereads durable state. A failed write never publishes unpersisted progress.
 */
export function createGitActivityIndex(options:GitActivityIndexOptions) {
  const timeoutMs=options.operationTimeoutMs??10_000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)throw Error('Invalid Git activity index timeout');
  let tail:Promise<unknown>=Promise.resolve(),disposed=false,failed=false,pending=0;
  const requests=new Set<{projectId:string;controller:AbortController}>();
  const invalidations=new Map<string,Promise<boolean>>();

  // A timed-out dependency may still be alive. Retire the instance so it cannot start a
  // second metadata lookup or write in parallel with a dependency that ignored cancellation.
  function bounded<T>(operation:()=>Promise<T>|T,controller:AbortController):Promise<T> {
    if(controller.signal.aborted||disposed||failed)return Promise.reject(Error('Git activity index unavailable'));
    return new Promise((resolve,reject)=>{
      let settled=false;
      const timer=setTimeout(()=>{if(settled)return;settled=true;failed=true;controller.abort();reject(Error('Git activity index deadline'));},timeoutMs);
      Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error('Cancelled Git activity index');return operation();}).then(value=>{
        if(settled)return;settled=true;clearTimeout(timer);
        if(controller.signal.aborted||disposed||failed)reject(Error('Cancelled Git activity index'));else resolve(value);
      },error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
    });
  }
  async function authority(input:GitActivityIndexInput,controller:AbortController):Promise<void> {
    if(!await bounded(()=>options.validateAuthority(input,controller.signal),controller))throw Error('Git activity authority unavailable');
  }
  async function read(controller:AbortController) {
    if(!options.persistence)throw Error('Git activity persistence unavailable');
    const record=await bounded(()=>options.persistence!.read(controller.signal),controller);
    if(record&&(!Number.isSafeInteger(record.revision)||record.revision<1||record.revision>=Number.MAX_SAFE_INTEGER))return invalid();
    return {revision:record?.revision??null,payload:record?gitActivityIndexCodec.parse(record.payload):{schemaVersion:1 as const,projects:[] as GitActivityIndexProject[]}};
  }
  async function persist(payload:GitActivityIndexPayload,revision:number|null,controller:AbortController):Promise<void> {
    const checked=gitActivityIndexCodec.parse(payload);
    const saved=await bounded(()=>options.persistence!.write(checked,revision,controller.signal),controller);
    if(saved.revision!==(revision??0)+1||JSON.stringify(gitActivityIndexCodec.parse(saved.payload))!==JSON.stringify(checked))throw Error('Git activity write unverified');
  }
  function enqueue<T>(operation:()=>Promise<T>):Promise<T> {
    pending++;
    const next=tail.then(operation).finally(()=>{pending--;});
    tail=next.catch(()=>{});
    return next;
  }
  function inspect(value:GitActivityIndexInput,signal:AbortSignal|undefined,advance:boolean):Promise<GitActivityIndexObservation> {
    // Clone, validate and freeze synchronously so queued operations cannot observe mutation.
    const input=parseInput(value),empty=()=>observation(input,[],true);
    if(disposed||failed||signal?.aborted||pending>=GIT_ACTIVITY_INDEX_LIMITS.pendingRequests||!options.persistence)return Promise.resolve(empty());
    const controller=new AbortController(),request={projectId:input.projectId,controller};
    requests.add(request);
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    let cancel:()=>void=()=>{};
    const cancelled=new Promise<GitActivityIndexObservation>(resolve=>{cancel=()=>resolve(empty());controller.signal.addEventListener('abort',cancel,{once:true});});
    const operation=enqueue(async()=>{
      try {
        await authority(input,controller);
        const current=await read(controller);
        await authority(input,controller);
        const prior=current.payload.projects.find(project=>project.projectId===input.projectId);
        const project=prior&&matches(prior,input)?prior:binding(input);
        if(!advance) {
          await authority(input,controller);
          return observation(input,project.records);
        }
        // Reject capacity/byte overflow before starting metadata reads for a new binding.
        gitActivityIndexCodec.parse({schemaVersion:1,projects:[...current.payload.projects.filter(item=>item.projectId!==input.projectId),project]});
        const references=Object.freeze(project.declaredReferences.slice(project.records.length,project.records.length+GIT_ACTIVITY_INDEX_LIMITS.batch));
        if(references.length) {
          await authority(input,controller);
          const raw=await bounded(()=>options.resolveBatch(input.projectId,references,controller.signal,input),controller);
          await authority(input,controller);
          const detached=copyBoundedCacheData(raw,GIT_ACTIVITY_INDEX_LIMITS.payloadBytes);
          if(!Array.isArray(detached)||detached.length!==references.length)return invalid();
          const rows=detached.map(parseReference),byReference=new Map(rows.map(row=>[row.declaredReference,row]));
          if(byReference.size!==references.length||references.some(ref=>!byReference.has(ref)))return invalid();
          project.records.push(...references.map(ref=>byReference.get(ref)!));
        }
        if(project!==prior||references.length) {
          const projects=current.payload.projects.filter(item=>item.projectId!==input.projectId);
          projects.push(project);projects.sort((a,b)=>compare(a.projectId,b.projectId));
          await authority(input,controller);
          await persist({schemaVersion:1,projects},current.revision,controller);
        }
        await authority(input,controller);
        return observation(input,project.records);
      } catch {return empty();}
      finally {requests.delete(request);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',cancel);}
    });
    // Cancellation returns promptly, but the serialized tail remains occupied until the
    // underlying operation settles (or its deadline retires this whole instance).
    return Promise.race([operation,cancelled]);
  }
  function invalidate(projectId:string):Promise<boolean> {
    if(!boundedString(projectId,256))return Promise.resolve(false);
    for(const request of requests)if(request.projectId===projectId)request.controller.abort();
    const existing=invalidations.get(projectId);if(existing)return existing;
    if(invalidations.size>=GIT_ACTIVITY_INDEX_LIMITS.projects){failed=true;for(const request of requests)request.controller.abort();return Promise.resolve(false);}
    // Lifecycle removal cannot be dropped merely because the ordinary queue is full.
    const removal=enqueue(async()=>{
      if(disposed||failed||!options.persistence)return false;
      const controller=new AbortController();
      try {
        const current=await read(controller),projects=current.payload.projects.filter(project=>project.projectId!==projectId);
        if(projects.length!==current.payload.projects.length)await persist({schemaVersion:1,projects},current.revision,controller);
        return true;
      } catch {failed=true;return false;}
    }).finally(()=>{invalidations.delete(projectId);});
    invalidations.set(projectId,removal);return removal;
  }
  return {
    observe:(input:GitActivityIndexInput,signal?:AbortSignal)=>inspect(input,signal,true),
    peek:(input:GitActivityIndexInput,signal?:AbortSignal)=>inspect(input,signal,false),
    invalidate,
    // Persistent revocation belongs to the authority service. A subsequent explicit grant
    // with a new authority revision may use this index without restarting the application.
    revoke:invalidate,
    dispose(){disposed=true;for(const request of requests)request.controller.abort();},
    settle:()=>tail,
  };
}
