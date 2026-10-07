import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {DagCandidateExclusion} from '../shared/note-reconnect';
import {createDagReader,type DagReaderOptions} from '../facts/dag-read-model';
export interface VerifiedDagCandidate {id:string;relativePath:string;taskCount:number;sourceHash:string}
export interface DagCandidateScan {candidates:VerifiedDagCandidate[];excludedCount:number;excluded:DagCandidateExclusion[]}
/** Only the selected directory, never nested notes or a vault traversal. */
export function createDagCandidateScanner(configuration:Pick<DagReaderOptions,'pythonPath'|'queryScriptPath'>){
 let retired=false;
 return async function scan(directory:string):Promise<DagCandidateScan>{
  if(retired)throw Error('이 실행의 DAG 후보 검증이 중단됐습니다. 앱을 다시 시작한 뒤 확인해 주세요.');
  const names:string[]=[];let entries=0,excludedCount=0;const excluded:DagCandidateExclusion[]=[];
  const dir=await fs.opendir(directory);
  for await(const entry of dir){if(++entries>256)throw Error('폴더 항목이 너무 많습니다. DAG가 있는 더 작은 디렉토리를 선택해 주세요.');if(/\.(yaml|yml)$/i.test(entry.name)){if(names.length>=16)throw Error('YAML 후보가 16개를 초과합니다. 더 작은 디렉토리를 선택해 주세요.');if(!entry.isFile()||entry.name.length>160||/[\u0000-\u001f\u007f]/u.test(entry.name)){excludedCount++;excluded.push({relativePath:entry.name.length<=160&&!/[\u0000-\u001f\u007f]/u.test(entry.name)?entry.name:'(파일명 확인 불가)',reason:'unsafe_file'});continue;}names.push(entry.name);}}
  names.sort((a,b)=>a.localeCompare(b));const candidates:VerifiedDagCandidate[]=[];
  const deadline=AbortSignal.timeout(15000);
  for(const name of names){
   if(deadline.aborted){retired=true;throw Error('DAG 후보 확인 시간이 초과했습니다. 앱을 다시 시작한 뒤 확인해 주세요.');}
   const file=path.join(directory,name);if(await fs.realpath(file)!==file||(await fs.lstat(file)).isSymbolicLink()){excludedCount++;excluded.push({relativePath:name,reason:'unsafe_file'});continue;}
   const id=randomUUID(),reader=createDagReader({...configuration,registrations:[{dagId:id,canonicalDagPath:file}],requireDocumentShape:true,maxSourceBytes:16*1024*1024});
   const result=await reader.read(id,{signal:deadline});
   if(result.ok)candidates.push({id,relativePath:name,taskCount:result.value.coverage.tasksTotal,sourceHash:result.value.sourceHash});
   else if(['timeout','cleanup_unverified','cancelled'].includes(result.error.kind)){retired=true;throw Error('DAG 후보 검증을 완료하지 못했습니다. 앱을 다시 시작한 뒤 확인해 주세요. 기존 자료는 변경하지 않았습니다.');}
   else {excludedCount++;const kind=result.error.kind;excluded.push({relativePath:name,reason:kind==='document_shape_invalid'||kind==='invalid_schema'||kind==='source_limit'||kind==='source_unavailable'||kind==='source_changed'||kind==='output_limit'?kind:'query_failed'});}
  }
  return {candidates,excludedCount,excluded};
 };
}
