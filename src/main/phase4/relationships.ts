import type {DescriptorMetadataTransport} from './descriptor-metadata';
import path from 'node:path';
import {pinDocumentDirectory,safeDocumentRelativePath} from './catalog';

/** Probe an exact main-owned candidate only, never a basename/vault search. */
export async function inspectDocumentFile(root:string,relativePath:string,signal?:AbortSignal,metadata?:DescriptorMetadataTransport):Promise<'present'|'missing'|'out-of-scope'> {
  if(!safeDocumentRelativePath(relativePath))return 'out-of-scope';
  const active=()=>{if(signal?.aborted)throw Error('문서 조회 취소');};
  let rootPin:Awaited<ReturnType<typeof pinDocumentDirectory>>|undefined;
  try{rootPin=await pinDocumentDirectory(root,active,undefined,undefined,metadata,signal);const stat=await rootPin.stat(relativePath);active();await rootPin.verify();return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1?'present':'out-of-scope';}
  catch(error){if(signal?.aborted)throw error;return ['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'')?'missing':'out-of-scope';}
  finally{await rootPin?.handle.close();}
}
export async function discoverTaskRecordPaths(root:string,taskId:string,signal?:AbortSignal,metadata?:DescriptorMetadataTransport):Promise<{paths:string[];common:string[];omissions:string[]}> {
  const paths:string[]=[],common:string[]=[],omissions:string[]=[];
  const active=()=>{if(signal?.aborted)throw Error('문서 조회 취소');};
  if(taskId==='.'||taskId==='..'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(taskId))return {paths,common,omissions:['태스크 ID가 계약 폴더 이름 규칙과 달라 명시된 링크만 표시합니다.']};
  const folder=`inbox/${taskId}`,absolute=path.join(root,folder);
  let pinned:Awaited<ReturnType<typeof pinDocumentDirectory>>|undefined,rootPin:Awaited<ReturnType<typeof pinDocumentDirectory>>|undefined;
  try{rootPin=await pinDocumentDirectory(root,active,undefined,undefined,metadata,signal);const expected=await rootPin.stat(folder);if(!expected.isDirectory()||expected.isSymbolicLink())throw Error('태스크 기록 폴더가 안전하지 않습니다.');pinned=await pinDocumentDirectory(absolute,active,`${expected.dev}:${expected.ino}:${expected.mode}`,rootPin.descriptorPath?path.join(rootPin.descriptorPath,folder):undefined,metadata,signal);const listing=await pinned.list(256);if(listing.partial)omissions.push('태스크 기록 폴더의 파일 이름 한도로 일부 기록을 확인하지 못했습니다.');for(const {name,stat}of listing.entries){active();if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&/^(assignment|implementation|final|plan|judgment|checklist|check|evidence|discrimination|blocks|decision|design|human-action|review-[1-9]\d{0,5})\.md$/u.test(name))paths.push(`${folder}/${name}`);}
    await pinned.verify();await rootPin.verify();
  }catch(error){paths.length=0;if(signal?.aborted)throw error;if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))omissions.push('태스크 기록 폴더를 안전하게 확인하지 못했습니다.');}
  finally{await pinned?.handle.close();await rootPin?.handle.close();}
  const order=(p:string)=>p.endsWith('/assignment.md')?0:p.endsWith('/implementation.md')?1:p.endsWith('/final.md')?1e7:2+Number(p.match(/review-(\d+)\.md$/)?.[1]??0);
  paths.sort((a,b)=>order(a)-order(b));
  for(const candidate of ['context.md','dag.md','e2e-checklist.md','inbox/integration/implementation.md'])if(await inspectDocumentFile(root,candidate,signal,metadata)==='present')common.push(candidate);
  return {paths,common,omissions};
}
