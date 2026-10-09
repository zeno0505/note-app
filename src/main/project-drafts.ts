import {randomUUID} from 'node:crypto';
import {PROJECT_DRAFT_LIMITS,parseProjectDraft,parseSaveProjectDraftRequest,type ProjectDraft} from '../shared/project-draft';
import {copyBoundedCacheData} from '../summary/storage/data';
import type {SummaryCacheRecord} from '../summary/storage';

export interface ProjectDraftPayload {schemaVersion:1;drafts:ProjectDraft[]}
export interface ProjectDraftPersistence {
  read(signal?:AbortSignal):Promise<SummaryCacheRecord<ProjectDraftPayload>|null>;
  write(payload:ProjectDraftPayload,expectedRevision:number|null,signal?:AbortSignal):Promise<SummaryCacheRecord<ProjectDraftPayload>>;
}
export const projectDraftCodec={parse(value:unknown):ProjectDraftPayload {
  // Leave envelope overhead below the underlying four-MiB cache limit.
  const v=copyBoundedCacheData(value,3*1024*1024) as ProjectDraftPayload;
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='drafts,schemaVersion'||v.schemaVersion!==1||!Array.isArray(v.drafts)||v.drafts.length>PROJECT_DRAFT_LIMITS.drafts)throw Error('프로젝트 초안 저장 형식을 확인할 수 없습니다. 기존 파일은 보존했습니다.');
  const drafts=v.drafts.map(parseProjectDraft);
  if(new Set(drafts.map(draft=>draft.id)).size!==drafts.length)throw Error('중복된 프로젝트 초안 식별자입니다.');
  return {schemaVersion:1,drafts};
}};

/** A private app-owned cache only. All paths/URLs in the input remain inert metadata. */
export function createProjectDraftStore(persistence?:ProjectDraftPersistence,now:()=>number=Date.now) {
  let tail:Promise<unknown>=Promise.resolve(),timedOut=false,pending=0;
  function bounded<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    const controller=new AbortController();
    return new Promise((resolve,reject)=>{
      let settled=false;
      const timer=setTimeout(()=>{settled=true;timedOut=true;controller.abort();reject(Error('프로젝트 초안 저장소 응답을 확인하지 못했습니다. 앱을 다시 열어 저장 상태를 확인해 주세요.'));},5000);
      Promise.resolve().then(()=>operation(controller.signal)).then(value=>{if(!settled){settled=true;clearTimeout(timer);resolve(value);}},error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});
    });
  }
  function transaction<T>(operation:(storage:ProjectDraftPersistence)=>Promise<T>):Promise<T> {
    if(pending>=32)return Promise.reject(Error('프로젝트 초안 저장 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'));
    pending++;
    const next=tail.then(()=>{if(!persistence||timedOut)throw Error('프로젝트 초안 저장소를 사용할 수 없습니다.');return operation(persistence);}).finally(()=>{pending--;});
    tail=next.catch(()=>{});return next;
  }
  async function read(storage:ProjectDraftPersistence) {
    const record=await bounded(signal=>storage.read(signal));
    return {revision:record?.revision??null,payload:record?projectDraftCodec.parse(record.payload):{schemaVersion:1 as const,drafts:[] as ProjectDraft[]}};
  }
  return {
    list():Promise<ProjectDraft[]> {return transaction(async storage=>{
      const current=await read(storage);
      return current.payload.drafts.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    });},
    save(value:unknown):Promise<ProjectDraft> {
      // Parse/detach before the first await so queued writes cannot observe renderer mutation.
      const request=parseSaveProjectDraftRequest(value);
      return transaction(async storage=>{
        const current=await read(storage),payload=current.payload;
        const prior=request.id===null?undefined:payload.drafts.find(draft=>draft.id===request.id);
        if(request.id!==null&&(!prior||prior.revision!==request.expectedRevision))throw Error('프로젝트 초안이 변경되었습니다. 목록을 다시 불러온 뒤 확인해 주세요.');
        if(!prior&&payload.drafts.length>=PROJECT_DRAFT_LIMITS.drafts)throw Error('저장할 수 있는 프로젝트 초안 수에 도달했습니다.');
        const draft=parseProjectDraft({id:prior?.id??'project-draft-'+randomUUID(),revision:(prior?.revision??0)+1,updatedAt:new Date(now()).toISOString(),input:request.input});
        const index=prior?payload.drafts.findIndex(item=>item.id===prior.id):-1;
        if(index<0)payload.drafts.push(draft);else payload.drafts[index]=draft;
        const checked=projectDraftCodec.parse(payload);
        await bounded(signal=>storage.write(checked,current.revision,signal));
        return structuredClone(draft);
      });
    },
    settle:()=>tail,
  };
}
