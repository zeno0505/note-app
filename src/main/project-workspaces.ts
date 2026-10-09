import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {PROJECT_WORKSPACE_LIMITS,parseResolveProjectWorkspaceRequest,type ProjectWorkspaceOption,type ProjectWorkspaceOptions} from '../shared/project-workspaces';

/** Main-owned current rows, never lifecycle history or renderer-entered draft paths. */
export interface ObservedProjectWorkspace {
  worktreeId:string;hostId:string|null;instanceId:string|null;path:string|null;branch:string|null;archived:boolean|null;
  repository:{readonly key:string;readonly id:string|null;readonly hostId:string|null;readonly projectId:string|null;readonly label:string};
}
export interface ProjectWorkspaceSnapshot {
  connected:boolean;disposed:boolean;refreshing:boolean;freshness:'current'|'stale'|'unknown';
  localHostId:string|null;runtimeId:string|null;revision:number;observedAt:string|null;
  currentWorktrees:readonly ObservedProjectWorkspace[];
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function text(value:unknown,limit:number):value is string {
  return typeof value==='string'&&value.trim().length>0&&value.length<=limit&&!/[\u0000-\u001f\u007f]/u.test(value);
}

/** Synchronous and observation-only: no reads, subprocesses, registry writes or model work.
 * IDs and fingerprints expire on every accepted snapshot, including same-content refreshes.
 * Returned paths are exact observed metadata, not a canonicalization or access grant.
 */
export function createProjectWorkspaceSelector(readSnapshot:()=>ProjectWorkspaceSnapshot) {
  const incarnation=randomUUID();
  function getProjectWorkspaceOptions():ProjectWorkspaceOptions {
    const snapshot=readSnapshot();
    const observedAt=snapshot.observedAt&&snapshot.observedAt.length<=32&&Number.isFinite(Date.parse(snapshot.observedAt))
      &&new Date(snapshot.observedAt).toISOString()===snapshot.observedAt?snapshot.observedAt:null;
    const unavailable=(reason:ProjectWorkspaceOptions['reason']):ProjectWorkspaceOptions=>({state:'unavailable',reason,observedAt,options:[],omittedCount:0});
    if(snapshot.disposed||!snapshot.connected)return unavailable('disconnected');
    if(snapshot.refreshing)return unavailable('refreshing');
    if(snapshot.freshness!=='current')return unavailable('stale');
    if(!text(snapshot.localHostId,PROJECT_WORKSPACE_LIMITS.id)||!text(snapshot.runtimeId,PROJECT_WORKSPACE_LIMITS.id)
      ||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<1||!observedAt
      ||snapshot.currentWorktrees.length>PROJECT_WORKSPACE_LIMITS.observations)return unavailable('unavailable');
    // Count before filtering. An archived/foreign duplicate must not make a raw ID safe.
    const ids=new Map<string,number>(),paths=new Map<string,number>(),instances=new Map<string,number>();
    const count=(map:Map<string,number>,key:string)=>map.set(key,(map.get(key)??0)+1);
    for(const row of snapshot.currentWorktrees){
      count(ids,row.worktreeId);
      if(row.path!==null)count(paths,JSON.stringify([row.hostId,row.path]));
      if(row.instanceId!==null)count(instances,JSON.stringify([row.hostId,row.instanceId]));
    }
    const result:ProjectWorkspaceOptions={state:'ready',reason:null,observedAt,options:[],omittedCount:0};
    // Reserve response envelope overhead; selected metadata itself is never truncated.
    let bytes=1024;
    for(const row of snapshot.currentWorktrees){
      const repository=row.repository;
      if(row.hostId!==snapshot.localHostId||row.archived!==false||!text(row.worktreeId,PROJECT_WORKSPACE_LIMITS.id)
        ||!text(row.instanceId,PROJECT_WORKSPACE_LIMITS.id)||!text(row.path,PROJECT_WORKSPACE_LIMITS.path)||!path.isAbsolute(row.path)
        ||row.branch!==null&&!text(row.branch,PROJECT_WORKSPACE_LIMITS.branch)||!text(repository.id,PROJECT_WORKSPACE_LIMITS.id)
        ||repository.hostId!==row.hostId||repository.key!==JSON.stringify([row.hostId,repository.id])
        ||repository.projectId!==null&&!text(repository.projectId,PROJECT_WORKSPACE_LIMITS.id)
        ||!text(repository.label,PROJECT_WORKSPACE_LIMITS.label)
        ||ids.get(row.worktreeId)!==1||paths.get(JSON.stringify([row.hostId,row.path]))!==1||instances.get(JSON.stringify([row.hostId,row.instanceId]))!==1)continue;
      const fingerprint=digest(JSON.stringify([incarnation,snapshot.runtimeId,snapshot.revision,snapshot.observedAt,
        row.hostId,row.instanceId,row.worktreeId,row.path,row.branch,repository.key,repository.id,repository.projectId]));
      const option:ProjectWorkspaceOption={optionId:'project-workspace-'+digest(JSON.stringify([incarnation,fingerprint])),fingerprint,
        hostId:row.hostId,worktreeId:row.worktreeId,path:row.path,branch:row.branch,
        repository:{key:repository.key,id:repository.id,hostId:row.hostId,projectId:repository.projectId,label:repository.label}};
      const size=Buffer.byteLength(JSON.stringify(option),'utf8')+1;
      if(result.options.length>=PROJECT_WORKSPACE_LIMITS.options||bytes+size>PROJECT_WORKSPACE_LIMITS.responseBytes){result.omittedCount++;continue;}
      result.options.push(option);bytes+=size;
    }
    return result;
  }
  return {
    getProjectWorkspaceOptions,
    resolveProjectWorkspace(request:unknown):ProjectWorkspaceOption {
      const selection=parseResolveProjectWorkspaceRequest(request),current=getProjectWorkspaceOptions();
      const matches=current.options.filter(option=>option.optionId===selection.optionId&&option.fingerprint===selection.expectedFingerprint);
      if(current.state!=='ready'||matches.length!==1)throw Error('Orca 작업공간 관찰이 변경되었거나 확인할 수 없습니다. 목록을 새로 불러와 선택해 주세요.');
      return structuredClone(matches[0]);
    },
  };
}
