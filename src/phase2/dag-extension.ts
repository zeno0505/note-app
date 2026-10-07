import type {DagTask} from '../facts/dag-read-model/types';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fail=():never=>{throw Error('Invalid versioned DAG extension');};
const text=(v:unknown,max=4096):string|null=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)?v:null;
/** v1 remains unchanged. Only a versioned pinned transport may disclose the extra fields. */
export function projectDagExtensions(raw:Record<string,unknown>,tasks:DagTask[]):{readContractVersion?:2;policies?:Record<string,unknown>[]} {
 if(raw.readContractVersion===undefined)return {};
 if(raw.readContractVersion!==2||!Array.isArray(raw.details)||!Array.isArray(raw.phases)||!Array.isArray(raw.policies)||raw.details.length!==tasks.length||raw.phases.length>1000||raw.policies.length>200)return fail();
 const byId=new Map(tasks.map(t=>[t.id,t])),seen=new Set<string>();
 for(const item of raw.details){
  if(!object(item)||typeof item.id!=='string'||!byId.has(item.id)||seen.has(item.id))return fail();seen.add(item.id);const task=byId.get(item.id)!;
  let omissions=0;
  const scalar=(v:unknown)=>{if(v==null)return null;const result=text(v);if(result===null)omissions++;return result;};
  const list=(v:unknown)=>{if(v==null)return [];const values=Array.isArray(v)?v:[v];const accepted:string[]=[];for(const entry of values){const value=text(entry);if(value!==null&&accepted.length<40)accepted.push(value);else omissions++;}return accepted;};
  task.rawType=scalar(item.type);
  task.details={description:scalar(item.description),acceptanceCriteria:list(item.acceptance_criteria),targetFiles:list(item.target_files),discussion:list(item.discussion),design:list(item.design),omissions};
 }
 const assigned=new Set<string>();
 for(const phase of raw.phases){
  if(!object(phase)||!Number.isSafeInteger(phase.index)||(phase.index as number)<0||!Array.isArray(phase.taskIds)||phase.taskIds.length>10000)return fail();
  for(const id of phase.taskIds){if(typeof id!=='string'||!byId.has(id)||assigned.has(id))return fail();assigned.add(id);byId.get(id)!.phase={id:text(phase.id,256),title:text(phase.title,1024),index:phase.index as number};}
 }
 if(assigned.size!==tasks.length)return fail();
 // bounded detached raw declarations; mapping is a separate explicit interpretation contract
 const policies=raw.policies.map(p=>{if(!object(p)||JSON.stringify(p).length>32768)return fail();return JSON.parse(JSON.stringify(p)) as Record<string,unknown>;});
 if(JSON.stringify(policies).length>262144)return fail();
 return {readContractVersion:2,policies};
}
