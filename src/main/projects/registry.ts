import {createHash} from 'node:crypto';
import path from 'node:path';
import type {LiveDagView,LiveWorkstreamView,ProjectLifecycleView} from '../../shared/live';
import type {ResolvedNoteMapping} from '../../collector/notes';
import {copyBoundedCacheData} from '../../summary/storage/data';
import type {SummaryCacheRecord} from '../../summary/storage';

export interface RegisteredProject {
 id:string;hostId:string;scopeId:string;dagId:string;canonicalNotePath:string;canonicalDagPath:string;
 worktrees:{id:string;path:string}[];status:'active'|'completed';changedAt:string;
 observation:null|{workstream:LiveWorkstreamView;dag:LiveDagView|null};
 history:{at:string;status:'active'|'completed';summary:NonNullable<LiveWorkstreamView['readingSummary']>|null}[];
}
export interface ProjectRegistryPayload {schemaVersion:1;projects:RegisteredProject[]}
export interface ProjectPersistence {read():Promise<SummaryCacheRecord<ProjectRegistryPayload>|null>;write(payload:ProjectRegistryPayload,revision:number|null,signal?:AbortSignal):Promise<SummaryCacheRecord<ProjectRegistryPayload>>}
export const projectId=(hostId:string,dagId:string)=>`project-${createHash('sha256').update(JSON.stringify([hostId,dagId])).digest('hex')}`;
const absolute=(v:unknown):v is string=>typeof v==='string'&&v.length<=4096&&path.isAbsolute(v)&&path.normalize(v)===v&&!/[\u0000-\u001f\u007f]/u.test(v);
const text=(v:unknown,max=1024):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const time=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const fail=():never=>{throw new Error('프로젝트 등록 상태를 확인하지 못했습니다. 기존 파일은 보존했습니다.');};
export const projectRegistryCodec={parse(input:unknown):ProjectRegistryPayload {
 const v=copyBoundedCacheData(input,4*1024*1024) as ProjectRegistryPayload;
 if(!v||Object.keys(v).sort().join(',')!=='projects,schemaVersion'||v.schemaVersion!==1||!Array.isArray(v.projects)||v.projects.length>64)fail();
 for(const p of v.projects){
  if(!p||Object.keys(p).sort().join(',')!=='canonicalDagPath,canonicalNotePath,changedAt,dagId,history,hostId,id,observation,scopeId,status,worktrees'||!text(p.hostId)||!text(p.scopeId)||!text(p.dagId)||p.id!==projectId(p.hostId,p.dagId)||!absolute(p.canonicalNotePath)||!absolute(p.canonicalDagPath)||!p.canonicalDagPath.startsWith(p.canonicalNotePath+path.sep)||!['active','completed'].includes(p.status)||!time(p.changedAt)||!Array.isArray(p.worktrees)||p.worktrees.length>32||!Array.isArray(p.history)||p.history.length>12)fail();
  if(p.worktrees.some(w=>!w||Object.keys(w).sort().join(',')!=='id,path'||!text(w.id,4096)||!absolute(w.path))||new Set(p.worktrees.map(w=>w.path)).size!==p.worktrees.length)fail();
  if(p.observation!==null&&(!p.observation||Object.keys(p.observation).sort().join(',')!=='dag,workstream'||p.observation.workstream?.id!==p.id||p.observation.workstream.noteMapping?.dagId!==p.dagId||typeof p.observation.workstream.title!=='string'||(p.observation.dag!==null&&p.observation.dag?.dagId!==p.dagId)))fail();
  if(p.history.some(h=>!h||Object.keys(h).sort().join(',')!=='at,status,summary'||!time(h.at)||!['active','completed'].includes(h.status)||(h.summary!==null&&(h.summary?.workstreamId!==p.id||h.summary.kind!=='rules-only'||!Array.isArray(h.summary.sections)))))fail();
 }
 if(new Set(v.projects.map(p=>p.id)).size!==v.projects.length)fail();return structuredClone(v);
}};
/** Only app-owned persistence. Discovery never changes a user's completion decision. */
export function createProjectRegistry(options:{persistence?:ProjectPersistence;now?:()=>number}={}) {
 let payload:ProjectRegistryPayload={schemaVersion:1,projects:[]},revision:number|null=null,loaded=false;let loading:Promise<void>|null=null;
 let tail:Promise<unknown>=Promise.resolve();const now=()=>new Date((options.now??Date.now)()).toISOString();
 function transaction<T>(action:(draft:ProjectRegistryPayload)=>T,signal?:AbortSignal):Promise<T>{
  const next=tail.then(async()=>{if(!loaded)throw new Error('프로젝트 등록 상태가 준비되지 않았습니다.');if(signal?.aborted)throw new Error('프로젝트 상태 저장 취소');const draft=structuredClone(payload),value=action(draft);const parsed=projectRegistryCodec.parse(draft);
   if(JSON.stringify(parsed)!==JSON.stringify(payload)){if(options.persistence){const saved=await options.persistence.write(parsed,revision,signal);revision=saved.revision;}if(signal?.aborted&&!options.persistence)throw new Error('프로젝트 상태 저장 취소');payload=parsed;}return value;});tail=next.catch(()=>{});return next;
 }
 return {
  async load(){if(loaded)return;if(!loading)loading=(async()=>{const old=await options.persistence?.read();if(old){payload=projectRegistryCodec.parse(old.payload);revision=old.revision;}loaded=true;})();await loading;},
  records:()=>structuredClone(payload.projects),
  async discover(mappings:ResolvedNoteMapping[],signal?:AbortSignal){return transaction(draft=>{
   for(const m of mappings){const id=projectId(m.hostId,m.dagId);let p=draft.projects.find(p=>p.id===id);
    if(!p){if(draft.projects.length>=64)throw new Error('프로젝트 등록 상한에 도달했습니다.');p={id,hostId:m.hostId,scopeId:m.scopeId,dagId:m.dagId,canonicalNotePath:m.canonicalNotePath,canonicalDagPath:m.canonicalDagPath,worktrees:[],status:'active',changedAt:now(),observation:null,history:[{at:now(),status:'active',summary:null}]};draft.projects.push(p);}
    if(p.canonicalDagPath!==m.canonicalDagPath||p.canonicalNotePath!==m.canonicalNotePath)throw new Error('프로젝트 연결 식별자가 변경되었습니다.');
    if(!p.worktrees.some(w=>w.path===m.canonicalWorktreePath)){if(p.worktrees.length>=32)throw new Error('워크트리 연결 상한에 도달했습니다.');p.worktrees.push({id:m.worktreeId,path:m.canonicalWorktreePath});}
   }
  },signal);},
  async capture(workstreams:LiveWorkstreamView[],dags:LiveDagView[],manual:boolean,signal?:AbortSignal){return transaction(draft=>{
   for(const view of workstreams){const p=draft.projects.find(p=>p.id===view.id);if(!p||p.status==='completed'&&!manual)continue;
    const prior=p.observation?.workstream.readingSummary;const summary=view.readingSummary??null;
    if(summary&&summary.fingerprint!==prior?.fingerprint){p.history.push({at:now(),status:p.status,summary:structuredClone(summary)});p.history=p.history.slice(-12);}
    p.observation={workstream:structuredClone(view),dag:structuredClone(dags.find(d=>d.dagId===p.dagId)??null)};
   }
  },signal);},
  async setStatus(request:unknown){if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!=='expectedStatus,projectId,status')throw new Error('프로젝트 전환 요청을 확인해 주세요.');
   const r=request as {projectId:string;status:'active'|'completed';expectedStatus:'active'|'completed'};
   if(!text(r.projectId)||!['active','completed'].includes(r.status)||!['active','completed'].includes(r.expectedStatus))throw new Error('프로젝트 전환 요청을 확인해 주세요.');
   return transaction(draft=>{const p=draft.projects.find(p=>p.id===r.projectId);if(!p||p.status!==r.expectedStatus)throw new Error('프로젝트 상태가 변경되었습니다. 다시 확인해 주세요.');
    if(p.status!==r.status){p.status=r.status;p.changedAt=now();p.history.push({at:now(),status:p.status,summary:p.observation?.workstream.readingSummary??null});p.history=p.history.slice(-12);}
   });},
  settle:()=>tail,
 };
}
export type ProjectRegistry=ReturnType<typeof createProjectRegistry>;
export function lifecycleView(p:RegisteredProject,view:LiveWorkstreamView,present:boolean):ProjectLifecycleView {
 return {status:p.status,changedAt:p.changedAt,sourceState:view.noteMapping.state==='resolved'?'available':'unavailable',worktreeState:present?'present':'missing',history:structuredClone(p.history)};
}
