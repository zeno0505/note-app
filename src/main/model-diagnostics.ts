import {mkdir,lstat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createLocalSummaryCache} from '../summary/storage';
export const DIAGNOSTIC_LIMIT=200,DIAGNOSTIC_DAYS=30;
export const DIAGNOSTIC_STAGES=['source-check','input-check','reservation','authentication','model-call','result-check','publish','complete'] as const;
export const DIAGNOSTIC_CODES=['request_started','request_succeeded','request_cancelled','duplicate_joined','request_busy','current_source_unavailable','collection_refreshing','current_dag_unavailable','dag_cleanup_unverified','dag_timeout','dag_command_failed','dag_invalid_schema','dag_other_failure','project_mapping_unavailable','read_permission_or_mapping_changed','source_changed','source_validation_failed','sensitive_input_blocked','input_limit_exceeded','input_validation_failed','reservation_unavailable','storage_unavailable','authentication_unavailable','subscription_login_required','model_launch_requested','model_started','model_start_failed','model_request_failed','model_output_limit','model_result_invalid','model_deadline_or_cancelled','saved_input_reused','diagnostics_unavailable','interrupted_unknown'] as const;
export type DiagnosticStage=typeof DIAGNOSTIC_STAGES[number];
export type DiagnosticCode=typeof DIAGNOSTIC_CODES[number];
export type ModelCallState='not-started'|'launch-requested'|'started'|'unknown';
export interface ModelDiagnostic {correlationId:string;projectId:string;at:string;stage:DiagnosticStage;code:DiagnosticCode;modelCall:ModelCallState;buildSha:string|null;attempt:number|null}
export interface ModelDiagnosticView {available:boolean;location:string;retention:{days:number;maxRecords:number};records:ModelDiagnostic[]}
export class ModelDiagnosticError extends Error {constructor(readonly code:DiagnosticCode){super(code);}}
export const diagnosticProject=(id:string)=>createHash('sha256').update(id).digest('hex');
export const diagnosticCorrelation=()=>randomUUID();
export function diagnosticCode(error:unknown,stage:DiagnosticStage):DiagnosticCode {
 if(error instanceof ModelDiagnosticError)return error.code;
 // Exact internal constants only. Never serialize arbitrary Error.message/stack/code.
 const message=error instanceof Error?error.message:'';
 const known:Record<string,DiagnosticCode>={'Sensitive input blocked':'sensitive_input_blocked','Paragraph requires bounded selection':'input_limit_exceeded','DAG selection exceeds limit':'input_limit_exceeded','Document requires bounded selection':'input_limit_exceeded','Subscription auth status unavailable; no model call':'authentication_unavailable','Existing subscription login required; no model call':'subscription_login_required','Owned model process could not start':'model_start_failed','Model output exceeded bound':'model_output_limit','Invalid or incomplete model result':'model_result_invalid','Cancelled owned model process':'model_deadline_or_cancelled','Cancelled during auth status':'request_cancelled','Cancelled before spawn':'request_cancelled','Cancelled after auth status':'request_cancelled','Source changed before send':'source_changed','Source changed before publish':'source_changed','Source retired':'source_changed'};
 return known[message]??(stage==='source-check'?'source_validation_failed':stage==='input-check'?'input_validation_failed':stage==='reservation'?'reservation_unavailable':stage==='authentication'?'authentication_unavailable':stage==='model-call'?'model_request_failed':'storage_unavailable');
}
const keys=['attempt','at','buildSha','code','correlationId','modelCall','projectId','stage'].sort().join(',');
function validate(x:unknown):ModelDiagnostic {
 const r=x as ModelDiagnostic;if(!r||Object.keys(r).sort().join(',')!==keys||!/^[-a-f0-9]{36}$/.test(r.correlationId)||!/^[a-f0-9]{64}$/.test(r.projectId)||typeof r.at!=='string'||!/^\d{4}-\d\d-\d\dT/.test(r.at)||!Number.isFinite(Date.parse(r.at))||!DIAGNOSTIC_STAGES.includes(r.stage)||!DIAGNOSTIC_CODES.includes(r.code)||!['not-started','launch-requested','started','unknown'].includes(r.modelCall)||(r.buildSha!==null&&!/^[a-f0-9]{40}$/.test(r.buildSha))||(r.attempt!==null&&![1,2].includes(r.attempt)))throw new ModelDiagnosticError('diagnostics_unavailable');return structuredClone(r);
}
export function createModelDiagnostics(directory:string,buildSha:string|null,now=()=>new Date().toISOString()){
 const codec={parse(value:unknown){const x=value as {records:unknown[]};if(!x||Object.keys(x).join(',')!=='records'||!Array.isArray(x.records)||x.records.length>DIAGNOSTIC_LIMIT||Buffer.byteLength(JSON.stringify(x))>131072)throw new ModelDiagnosticError('diagnostics_unavailable');return {records:x.records.map(validate)};}};
 async function ensureDirectory(){await mkdir(directory,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((s.mode&0o077)!==0||s.uid!==process.geteuid?.())))throw new ModelDiagnosticError('diagnostics_unavailable');}
 const cache=createLocalSummaryCache({directory,codec});let tail:Promise<unknown>=Promise.resolve(),available=true;
 const retained=(rows:ModelDiagnostic[])=>rows.filter(r=>Date.parse(r.at)>=Date.parse(now())-DIAGNOSTIC_DAYS*86400000).slice(-DIAGNOSTIC_LIMIT);
 return {
  async append(value:Omit<ModelDiagnostic,'at'|'buildSha'>){const row=validate({...value,at:now(),buildSha});const operation=tail.catch(()=>{}).then(async()=>{await ensureDirectory();const previous=await cache.read();await cache.write({records:retained([...(previous?.payload.records??[]),row])},previous?.revision??null);available=true;});tail=operation;try{await operation;}catch{available=false;throw new ModelDiagnosticError('diagnostics_unavailable');}},
  async view(projectId:string):Promise<ModelDiagnosticView>{
   const operation=tail.catch(()=>{}).then(async()=>{let records:ModelDiagnostic[]=[];try{
    try{await lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {available,location:'model-diagnostics/summary-cache-v1.json',retention:{days:DIAGNOSTIC_DAYS,maxRecords:DIAGNOSTIC_LIMIT},records:[]};throw error;}
    await ensureDirectory();const previous=await cache.read(),all=previous?.payload.records??[],kept=retained(all);
    if(previous&&kept.length!==all.length)await cache.write({records:kept},previous.revision);
    records=kept.filter(r=>r.projectId===projectId).slice(-12).reverse();available=true;
   }catch{available=false;}return {available,location:'model-diagnostics/summary-cache-v1.json',retention:{days:DIAGNOSTIC_DAYS,maxRecords:DIAGNOSTIC_LIMIT},records};});tail=operation;return operation;
  },
  settle(){return tail.catch(()=>{});},
 };
}
