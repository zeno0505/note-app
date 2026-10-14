import {constants} from 'node:fs';
import path from 'node:path';
import {lstat,realpath,open,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {DagTask} from '../../facts/dag-read-model/types';
import type {RegisteredExcerptContext} from '../context/registered';
export interface ProjectModelSelection {purpose:'recent'|'custom';taskIds?:string[]}
export interface TaskActivity {taskId:string;kind:'code'|'discussion'|'verification';at:string;source:string;timeBasis:'git-commit-time'|'declared-record-time';sourceHash:string;declaredReference?:string;fullSha?:string}
export interface ActivityCoverage {state:'complete'|'partial'|'unavailable';total:number;checked:number;resolved:number;unresolved:number;unsupported:number;pending:number}
export const RECENT_SOURCE_ERRORS=['request_cancelled','request_busy','collection_refreshing','current_source_unavailable','current_dag_unavailable','dag_busy','dag_cleanup_unverified','dag_timeout','dag_command_failed','dag_invalid_schema','dag_other_failure','project_mapping_unavailable','read_permission_or_mapping_changed','source_changed','source_validation_failed'] as const;
export type RecentSourceError=typeof RECENT_SOURCE_ERRORS[number];
export interface RecentSummaryTasks {state:'ready'|'unknown'|'unavailable';taskIds:string[];activities:TaskActivity[];coverage:'bounded-records';omittedReferences:number;message:string;activityCoverage?:ActivityCoverage;sourceError?:RecentSourceError}
export const RECENT_ACTIVITY_POLICY='last-three-exact-task-activities-v1';
export const ACTIVITY_REFERENCE_LIMIT=128;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
export function activityTime(value:string):number|null {
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);if(!m)return null;
 const year=+m[1],month=+m[2],day=+m[3],hour=+m[4],minute=+m[5],second=+m[6];
 if(year<1970||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59||(m[8]!=='Z'&&(+m[10]>23||+m[11]>59)))return null;
 const result=Date.parse(value);return Number.isFinite(result)?result:null;
}
async function assertLocalGitStore(repository:string){
 const repo=await realpath(repository);if(repo!==repository)throw Error('Repository moved');const git=path.join(repo,'.git');
 // Worktrees with an external object store need their own explicit authority contract.
 for(const directory of [git,path.join(git,'objects'),path.join(git,'objects','pack'),path.join(git,'objects','info')]){const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)throw Error('External Git storage excluded');}
 for(const excluded of ['commondir','config.worktree','objects/info/alternates','objects/info/http-alternates'])try{await lstat(path.join(git,excluded));throw Error('External Git storage excluded');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const configHandle=await open(path.join(git,'config'),constants.O_RDONLY|constants.O_NOFOLLOW);let config='';try{const stat=await configHandle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw Error('Unsafe Git config');const bytes=Buffer.alloc(65537),read=await configHandle.read(bytes,0,bytes.length,0);if(read.bytesRead>65536)throw Error('Git config limit');config=bytes.subarray(0,read.bytesRead).toString('utf8');}finally{await configHandle.close();}if(/^\s*\[\s*include(?:If)?\b/im.test(config)||/promisor\s*=|partialclone\s*=|worktreeconfig\s*=/i.test(config))throw Error('External Git configuration excluded');
 const packs=await readdir(path.join(git,'objects','pack'));if(packs.length>256)throw Error('Git storage limit');for(const entry of packs){const stat=await lstat(path.join(git,'objects','pack',entry));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Unsafe Git object pack');}
 return git;
}
export function parseModelSelection(value:unknown):ProjectModelSelection {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid summary selection');
 const v=value as Record<string,unknown>;
 if(v.purpose==='recent'&&Object.keys(v).join(',')==='purpose')return {purpose:'recent'};
 if(v.purpose!=='custom'||Object.keys(v).sort().join(',')!=='purpose,taskIds'||!Array.isArray(v.taskIds)||!v.taskIds.length||v.taskIds.length>20||v.taskIds.some(x=>typeof x!=='string'||x.length>128||!x.length)||new Set(v.taskIds).size!==v.taskIds.length)throw Error('Select 1–20 exact tasks');
 return {purpose:'custom',taskIds:[...(v.taskIds as string[])].sort()};
}
/** Only an explicit task link plus an explicit timestamp qualify. Filesystem timestamps and polling never enter this function. */
export function selectRecentTaskActivities(tasks:readonly DagTask[],events:readonly TaskActivity[],now=Date.now(),omittedReferences=0):RecentSummaryTasks {
 const ids=new Set(tasks.map(t=>t.id)),latest=new Map<string,TaskActivity>();
 for(const event of events){const ms=activityTime(event.at);if(!ids.has(event.taskId)||ms===null||ms>now||ms<0||!['code','discussion','verification'].includes(event.kind)||!['git-commit-time','declared-record-time'].includes(event.timeBasis)||!event.source||!/^([a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(event.sourceHash))continue;const prior=latest.get(event.taskId);if(!prior||Date.parse(prior.at)<ms||(prior.at===event.at&&event.source<prior.source))latest.set(event.taskId,{...event});}
 const activities=[...latest.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.taskId.localeCompare(b.taskId)).slice(0,3);
 return {state:activities.length?'ready':'unknown',taskIds:activities.map(e=>e.taskId),activities,coverage:'bounded-records',omittedReferences,message:activities.length?'태스크에 명시 연결된 코드·논의·검증 기록의 시각 순서입니다. 기록 범위 밖 활동은 알 수 없습니다.':'시각이 있는 태스크별 활동 기록이 없습니다. 작업을 직접 선택해 주세요.'};
}
/** Timestamped records are declarations, not independent verification of discussion/test execution. */
export function registeredTaskActivities(context:RegisteredExcerptContext|undefined,tasks:readonly DagTask[]):TaskActivity[]{
 const ids=new Set(tasks.map(t=>t.id)),out:TaskActivity[]=[];
 for(const excerpt of context?.excerpts??[]){let value:unknown;try{value=JSON.parse(excerpt.text);}catch{continue;}
  if(!value||typeof value!=='object'||Array.isArray(value))continue;const v=value as Record<string,unknown>;
  if(v.contract!=='task-activity-v1'||!Array.isArray(v.activities)||v.activities.length>128)continue;
  const provenance=context?.provenance.find(p=>p.excerptId===excerpt.id);if(!provenance)continue;
  for(const row of v.activities){if(!row||typeof row!=='object'||Array.isArray(row))continue;const e=row as Record<string,unknown>;
   if(typeof e.taskId!=='string'||!ids.has(e.taskId)||!['discussion','verification'].includes(String(e.kind))||typeof e.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(e.at))continue;
   out.push({taskId:e.taskId,kind:e.kind as 'discussion'|'verification',at:e.at,source:provenance.registration.relativePath+':'+provenance.lineStart,timeBasis:'declared-record-time',sourceHash:excerpt.sourceHash});
  }
 }
 return out;
}
export async function readTaskCommitActivities(tasks:readonly DagTask[],repository:string,signal:AbortSignal,read?:(refs:string[])=>Promise<string>):Promise<{events:TaskActivity[];omitted:number}>{
 const references=[...new Set(tasks.flatMap(t=>t.commitReferences).filter(ref=>/^[a-f0-9]{40}$/i.test(ref)))].sort();
 const refs=references.slice(0,ACTIVITY_REFERENCE_LIMIT),omitted=Math.max(0,references.length-refs.length);if(!refs.length)return {events:[],omitted};
 const git=read?null:await assertLocalGitStore(repository);
 for(const ref of read?[]:refs){const loose=path.join(git!,'objects',ref.slice(0,2));try{const stat=await lstat(loose);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Unsafe loose objects');const file=await lstat(path.join(loose,ref.slice(2)));if(file.isSymbolicLink()||!file.isFile()||file.nlink!==1)throw Error('Unsafe loose object');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 const output=await (read?read(refs):new Promise<string>((resolve,reject)=>{execFile('git',['--git-dir='+git,'--work-tree='+repository,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','--no-pager','show','--no-patch','--no-show-signature','--format=%H%x00%cI',...refs],{cwd:repository,encoding:'utf8',timeout:5000,maxBuffer:65536,signal,env:{PATH:process.env.PATH,LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_NO_REPLACE_OBJECTS:'1'}},(error,stdout)=>error?reject(Error('Task commit timestamps unavailable')):resolve(stdout));}));
 if(signal.aborted)throw Error('Cancelled activity read');
 const events:TaskActivity[]=[];for(const line of output.split('\n')){const [sha,at,...rest]=line.trim().split('\0');if(rest.length||!refs.includes(sha)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(at??''))continue;
  for(const task of tasks)if(task.commitReferences.includes(sha))events.push({taskId:task.id,kind:'code',at,source:'git:'+sha,timeBasis:'git-commit-time',sourceHash:digest(line)});
 }
 return {events,omitted};
}
