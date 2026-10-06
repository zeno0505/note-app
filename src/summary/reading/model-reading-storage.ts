import {createHash} from 'node:crypto';
import {mkdir,lstat,realpath,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createLocalSummaryCache} from '../storage';
import {publicInputHash,validateModelAnswer,MODEL_HARNESS_VERSION,SECTION_IDS,type PublicReadingPack,type ModelAnswer,type HarnessRecord,type HarnessLedger} from './model-harness';
export const MODEL_LEDGER_LIMIT=128,MODEL_PROJECT_LIMIT=64;
export interface MinimalUsage extends Record<string,unknown> {inputTokens?:number;cacheCreationInputTokens?:number;cacheReadInputTokens?:number;outputTokens?:number;reportedTurns?:number}
interface Run {project:string;inputHash:string;runId:string;attempts:number;status:HarnessRecord['status'];at:string;errors:string[];receipts:{provider:string;runtimeMs:number;usage:MinimalUsage}[]}
interface Ledger {runs:Run[];requests:{project:string;inputHash:string;status:string;at:string}[]}
export interface LatestModelReading {
  project:string;inputHash:string;sourceSha:string;version:string;provider:string;generatedAt:string;
  answer:ModelAnswer;sources:{id:string;path:string;lineStart:number;lineEnd:number;sha256:string}[];
  validation:{schema:'passed';facts:'passed';semantic:'not-reviewed'|'reviewed-with-scope-note';note:string};
  attempts:number;usage:MinimalUsage;runtimeMs:number;
}
export type LatestModelReadingView={state:'empty'|'unavailable';message:string}|{state:'ready'|'stale';message:string;latest:LatestModelReading};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const copy=<T>(x:T):T=>structuredClone(x);
const validHash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validTime=(x:unknown)=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const validProject=(x:unknown)=>typeof x==='string'&&x.length>0&&x.length<256&&!/[\x00-\x1f]/.test(x);
function bound<T>(x:T,bytes:number){if(Buffer.byteLength(JSON.stringify(x))>bytes)throw Error('Model storage bound exceeded');return copy(x);}
const ledgerCodec={parse(value:unknown){const x=value as Ledger;
  if(!x||!Array.isArray(x.runs)||!Array.isArray(x.requests)||x.runs.length>MODEL_LEDGER_LIMIT||x.requests.length>MODEL_PROJECT_LIMIT||new Set(x.runs.map(r=>r.inputHash)).size!==x.runs.length||new Set(x.requests.map(r=>r.project)).size!==x.requests.length)throw Error('Invalid model ledger');
  for(const r of x.runs)if(!validProject(r.project)||!validHash(r.inputHash)||typeof r.runId!=='string'||r.runId.length>128||![1,2].includes(r.attempts)||!['running','model','fallback','cancelled'].includes(r.status)||!validTime(r.at)||!Array.isArray(r.errors)||r.errors.length>12||r.errors.some(e=>typeof e!=='string'||e.length>240)||!Array.isArray(r.receipts)||r.receipts.length>2)throw Error('Invalid model run');
  for(const r of x.requests)if(!validProject(r.project)||!validHash(r.inputHash)||!validTime(r.at)||typeof r.status!=='string'||r.status.length>40)throw Error('Invalid model request');return bound(x,131072);
}};
const latestCodec={parse(value:unknown){const x=value as LatestModelReading;
  if(!x||!validProject(x.project)||!validHash(x.inputHash)||!/^[a-f0-9]{40}$/.test(x.sourceSha)||x.version!==MODEL_HARNESS_VERSION||!validTime(x.generatedAt)||!x.answer||x.answer.project!==x.project||x.answer.inputHash!==x.inputHash||x.answer.version!==x.version||![1,2].includes(x.attempts)||x.answer.attempt!==x.attempts||!Array.isArray(x.answer.sections)||x.answer.sections.length!==4||!Array.isArray(x.sources)||x.sources.length>12||!x.validation||x.validation.schema!=='passed'||x.validation.facts!=='passed'||!['not-reviewed','reviewed-with-scope-note'].includes(x.validation.semantic)||typeof x.validation.note!=='string'||x.validation.note.length>1000)throw Error('Invalid latest model reading');
  if(typeof x.provider!=='string'||x.provider.length>80||!Number.isFinite(x.runtimeMs)||x.runtimeMs<0||new Set(x.answer.sections.map(s=>s.id)).size!==4)throw Error('Invalid model metadata');
  for(const source of x.sources)if(!/^S\d+$/.test(source.id)||!validHash(source.sha256)||typeof source.path!=='string'||source.path.includes('..')||source.path.length>256||!Number.isSafeInteger(source.lineStart)||source.lineStart<1||!Number.isSafeInteger(source.lineEnd)||source.lineEnd<source.lineStart)throw Error('Invalid model source');
  for(const s of x.answer.sections)if(!SECTION_IDS.includes(s.id)||typeof s.text!=='string'||s.text.length<8||s.text.length>1800||!Array.isArray(s.facts)||!Array.isArray(s.sourceIds)||s.sourceIds.some(id=>!x.sources.some(source=>source.id===id)))throw Error('Invalid model section');return bound(x,32768);
}};
function minimalUsage(value:Record<string,unknown>):MinimalUsage {
  const usage=value.usage as Record<string,unknown>|undefined,result:MinimalUsage={};
  for(const [key,target] of [['input_tokens','inputTokens'],['cache_creation_input_tokens','cacheCreationInputTokens'],['cache_read_input_tokens','cacheReadInputTokens'],['output_tokens','outputTokens']] as const){const n=usage?.[key]??value[target];if(typeof n==='number'&&Number.isFinite(n)&&n>=0)result[target]=n;}
  const turns=value.num_turns??value.reportedTurns;if(typeof turns==='number'&&Number.isSafeInteger(turns)&&turns>=0)result.reportedTurns=turns;return result;
}
/** One body per project; finite no-replay records never expire into another paid call. */
export function createModelReadingStorage(directory:string,now=()=>new Date().toISOString()){
  if(!path.isAbsolute(directory)||path.normalize(directory)!==directory)throw Error('Canonical model storage directory required');
  async function safe(subdirectory:string,create:boolean){
    if(create)await mkdir(directory,{recursive:true,mode:0o700});
    for(const current of [directory,path.join(directory,subdirectory)]){
      if(create&&current!==directory)await mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(current)!==current||(process.platform!=='win32'&&((s.mode&0o077)!==0||s.uid!==process.geteuid?.())))throw Error('Unsafe model storage directory');
    }return path.join(directory,subdirectory);
  }
  async function readLedger(create=true){const cache=createLocalSummaryCache({directory:await safe('ledger',create),codec:ledgerCodec});return {cache,record:await cache.read()};}
  async function latestCache(project:string,create:boolean){if(!validProject(project))throw Error('Invalid model project');return createLocalSummaryCache({directory:await safe('latest-'+digest(project),create),codec:latestCodec});}
  async function getLatest(project:string){try{return await (await latestCache(project,false)).read();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
  async function lock(){await safe('ledger',true);const file=path.join(directory,'.model-slot.lock'),handle=await open(file,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,at:now()}));await handle.close();return async()=>{await unlink(file);};}
  const storage={
    async readLatest(project:string,currentInputHash?:string):Promise<LatestModelReadingView>{try{
      const latest=await getLatest(project);if(!latest)return {state:'empty',message:'저장된 모델 요약이 없습니다. 이 화면은 모델을 호출하지 않습니다.'};
      const {record}=await readLedger(false),request=record?.payload.requests.find(r=>r.project===project);
      const stale=(currentInputHash!==undefined&&currentInputHash!==latest.payload.inputHash)||!!request&&(request.inputHash!==latest.payload.inputHash||['fallback','cancelled','blocked-capacity'].includes(request.status));
      return {state:stale?'stale':'ready',message:stale?'이전 정상 모델 요약입니다. 입력 변경·실패·취소 후 현재 근거로 재확인되지 않았습니다.':'프로젝트별 최신 성공 모델 요약입니다. 지정된 공개 입력 범위의 저장 결과입니다.',latest:latest.payload};
    }catch{return {state:'unavailable',message:'모델 요약 저장소를 확인하지 못했습니다. 기존 파일과 이력을 변경하지 않습니다.'};}},
    ledger(pack:PublicReadingPack):HarnessLedger {
      const inputHash=publicInputHash(pack);return {lock,
        async get(key):Promise<HarnessRecord|undefined>{if(key!==inputHash)throw Error('Reading ledger input mismatch');const {record}=await readLedger(),run=record?.payload.runs.find(r=>r.inputHash===key);if(!run)return;
          const latest=await getLatest(pack.project);
          if(latest?.payload.inputHash===key&&latest.payload.answer.runId===run.runId&&!validateModelAnswer(latest.payload.answer,{runId:run.runId,project:pack.project,inputHash,version:MODEL_HARNESS_VERSION,attempt:run.attempts as 1|2},pack).length)return {inputHash:key,runId:run.runId,attempts:run.attempts,status:'model',answer:latest.payload.answer,errors:[],receipts:copy(run.receipts)};
          return {inputHash:key,runId:run.runId,attempts:run.attempts,status:run.status==='model'?'fallback':run.status,errors:run.status==='model'?['Older successful input is reserved; only latest body retained, no replay']:run.errors,receipts:copy(run.receipts)};
        },
        async put(value,signal){if(value.inputHash!==inputHash||![1,2].includes(value.attempts))throw Error('Invalid model reservation');const {cache,record}=await readLedger(),payload=copy(record?.payload??{runs:[],requests:[]});const previous=payload.runs.find(r=>r.inputHash===inputHash),at=now();
          if(!payload.requests.some(r=>r.project===pack.project)&&payload.requests.length>=MODEL_PROJECT_LIMIT)throw Error('Model project capacity reached; no call');payload.requests=payload.requests.filter(r=>r.project!==pack.project);
          if(!previous&&payload.runs.length>=MODEL_LEDGER_LIMIT){payload.requests.push({project:pack.project,inputHash,status:'blocked-capacity',at});await cache.write(payload,record?.revision??null);throw Error('Model no-replay ledger full; no new model call');}
          const runId=value.answer?.runId??value.runId??previous?.runId;if(!runId||runId.length>128)throw Error('Run identity required');
          if(previous&&(previous.status!=='running'||previous.runId!==runId||previous.attempts!==value.attempts)&&value.status==='model')throw Error('Retired or changed model run cannot publish');
          const receipts=value.receipts.slice(0,2).map(r=>({provider:r.provider.slice(0,80),runtimeMs:r.runtimeMs,usage:minimalUsage(r.usage)}));
          const run:Run={project:pack.project,inputHash,runId,attempts:value.attempts,status:value.status,at,errors:value.errors.slice(0,12).map(e=>e.slice(0,240)),receipts};
          if(value.status==='model'){
            if(!previous||!value.answer||validateModelAnswer(value.answer,{runId,project:pack.project,inputHash,version:MODEL_HARNESS_VERSION,attempt:value.attempts as 1|2},pack).length)throw Error('Unreserved or invalid latest model answer');
            const target=await latestCache(pack.project,true),old=await target.read(),receipt=receipts.at(-1);
            await target.write({project:pack.project,inputHash,sourceSha:pack.sourceSha,version:MODEL_HARNESS_VERSION,provider:receipt?.provider??'unobserved',generatedAt:at,answer:copy(value.answer),sources:pack.sources.map(({excerpt:_excerpt,...source})=>source),validation:{schema:'passed',facts:'passed',semantic:'not-reviewed',note:'JSON 형식과 필수 근거 검사가 통과했습니다. 한국어 문맥의 진실성은 별도 검수가 필요합니다.'},attempts:value.attempts,usage:receipt?.usage??{},runtimeMs:receipt?.runtimeMs??0},old?.revision??null,signal);
          }
          payload.runs=payload.runs.filter(r=>r.inputHash!==inputHash);payload.runs.push(run);payload.requests.push({project:pack.project,inputHash,status:value.status,at});await cache.write(payload,record?.revision??null,signal);
        },
      };
    },
    async importSuccessfulPublicResult(pack:PublicReadingPack,value:HarnessRecord,semanticNote:string,generatedAt?:string){
      const ledger=storage.ledger(pack),unlock=await ledger.lock();try{
        const saved=await ledger.get(value.inputHash);if(!saved){if(value.status!=='model'||!value.answer)throw Error('Only validated successful legacy result may migrate');await ledger.put({...value,status:'running',answer:undefined,runId:value.answer.runId,receipts:[]});await ledger.put({...value,runId:value.answer.runId});}
        const target=await latestCache(pack.project,false),latest=await target.read();if(!latest||latest.payload.inputHash!==value.inputHash)throw Error('Migration latest identity mismatch');
        if(generatedAt&&!validTime(generatedAt))throw Error('Invalid observed generation time');
        if(latest.payload.validation.semantic!=='reviewed-with-scope-note'||generatedAt&&latest.payload.generatedAt!==generatedAt)await target.write({...latest.payload,generatedAt:generatedAt??latest.payload.generatedAt,validation:{schema:'passed',facts:'passed',semantic:'reviewed-with-scope-note',note:semanticNote.slice(0,1000)}},latest.revision);
      }finally{await unlock();}
    },
  };return storage;
}
