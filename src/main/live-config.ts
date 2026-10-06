import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { AllowedNoteScope } from '../collector/notes';
import type { LiveConfiguration, LoadedLiveConfiguration } from './live-config-types';
import { boundedStartup } from './startup-boundary';
import { parseExcerptRegistrations } from '../summary/context/registered';

const MAX_CONFIG_BYTES = 65536;
function fail(): never { throw new Error('Invalid local startup configuration'); }
function fields(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record,key))) fail();
  return record;
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function absolute(value: unknown): string {
  const result = text(value);
  if (!path.isAbsolute(result) || path.normalize(result) !== result || result === path.parse(result).root) fail();
  return result;
}
function relative(value: unknown): string {
  const result = text(value);
  if (path.isAbsolute(result) || result.includes('\\') || result.split('/').some(part=>!part || part==='.' || part==='..')) fail();
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}
/** Explicit, bounded startup configuration. Never accepts renderer data. */
export function parseLiveConfiguration(value: unknown): LiveConfiguration {
  const v = fields(value,['schemaVersion','orcaExecutablePath','codeburnExecutablePath','localHostId','noteScopes','dagQuery','summarySelections','noteLink','publicGitHub'],['schemaVersion','orcaExecutablePath']);
  if(v.schemaVersion!==1) fail();
  const noteScopes: AllowedNoteScope[] = list(v.noteScopes ?? [],8).map(raw=>{
    const s=fields(raw,['scopeId','hostId','vaultRootPath','scopePath','dagRelativePaths'],['scopeId','hostId','vaultRootPath','scopePath','dagRelativePaths']);
    const paths=list(s.dagRelativePaths,8).map(relative);
    if(new Set(paths).size!==paths.length || !paths.length) fail();
    const vaultRootPath=absolute(s.vaultRootPath), scopePath=absolute(s.scopePath);
    const inside=path.relative(vaultRootPath,scopePath);
    if(!inside || inside.startsWith(`..${path.sep}`) || inside==='..' || path.isAbsolute(inside)) fail();
    return {scopeId:text(s.scopeId,128),hostId:text(s.hostId,256),vaultRootPath,scopePath,dagRelativePaths:paths};
  });
  if(new Set(noteScopes.map(s=>s.scopeId)).size!==noteScopes.length || noteScopes.reduce((n,s)=>n+s.dagRelativePaths.length,0)>8) fail();
  const localHostId=v.localHostId===undefined?undefined:text(v.localHostId,256);
  if(noteScopes.length && (!localHostId || noteScopes.some(s=>s.hostId!==localHostId))) fail();
  const summarySelections=list(v.summarySelections??[],8).map(raw=>{
    const s=fields(raw,['scopeId','dagRelativePath','taskIds','excerpts'],['scopeId','dagRelativePath','taskIds']);
    const scopeId=text(s.scopeId,128), dagRelativePath=relative(s.dagRelativePath);
    const taskIds=list(s.taskIds,32).map(id=>text(id));
    if(!taskIds.length || new Set(taskIds).size!==taskIds.length || !noteScopes.some(scope=>scope.scopeId===scopeId&&scope.dagRelativePaths.includes(dagRelativePath))) fail();
    return {scopeId,dagRelativePath,taskIds,...(s.excerpts===undefined?{}:{excerpts:parseExcerptRegistrations(s.excerpts)})};
  });
  if(new Set(summarySelections.map(s=>JSON.stringify([s.scopeId,s.dagRelativePath]))).size!==summarySelections.length) fail();
  if(new Set(summarySelections.flatMap(s=>(s.excerpts??[]).map(e=>JSON.stringify([s.scopeId,e.relativePath])))).size>8) fail();
  let dagQuery: LiveConfiguration['dagQuery'];
  if(v.dagQuery!==undefined){const q=fields(v.dagQuery,['pythonPath','queryScriptPath'],['pythonPath','queryScriptPath']);dagQuery={pythonPath:absolute(q.pythonPath),queryScriptPath:absolute(q.queryScriptPath)};}
  if(summarySelections.length&&!dagQuery) fail();
  let publicGitHub:LiveConfiguration['publicGitHub'];
  if(v.publicGitHub!==undefined) {
    publicGitHub=list(v.publicGitHub,8).map(raw=>{
      const p=fields(raw,['scopeId','dagRelativePath','worktreePath','branch'],['scopeId','dagRelativePath','worktreePath','branch']);
      const scopeId=text(p.scopeId,128),dagRelativePath=relative(p.dagRelativePath),worktreePath=absolute(p.worktreePath),branch=text(p.branch,128);
      if(!dagQuery||!localHostId||/[\u0000-\u0020\u007f?#]/u.test(branch)||!noteScopes.some(s=>s.scopeId===scopeId&&s.dagRelativePaths.includes(dagRelativePath)))fail();
      return {scopeId,dagRelativePath,worktreePath,branch};
    });
    if(!publicGitHub.length||new Set(publicGitHub.map(p=>p.worktreePath)).size!==publicGitHub.length)fail();
  }
  let noteLink: LiveConfiguration['noteLink'];
  if(v.noteLink!==undefined){
    const n=fields(v.noteLink,['gitExecutablePath','allowedCommonGitDirs'],['gitExecutablePath','allowedCommonGitDirs']);
    const allowedCommonGitDirs=list(n.allowedCommonGitDirs,8).map(absolute);
    if(new Set(allowedCommonGitDirs).size!==allowedCommonGitDirs.length || !noteScopes.length || !localHostId) fail();
    noteLink={gitExecutablePath:absolute(n.gitExecutablePath),allowedCommonGitDirs};
  }
  return {schemaVersion:1,orcaExecutablePath:absolute(v.orcaExecutablePath),
    ...(v.codeburnExecutablePath===undefined?{}:{codeburnExecutablePath:absolute(v.codeburnExecutablePath)}),
    ...(localHostId?{localHostId}:{}),noteScopes,...(dagQuery?{dagQuery}:{}),...(noteLink?{noteLink}:{}),summarySelections,...(publicGitHub?{publicGitHub}:{})};
}
async function readLiveConfiguration(filename: string | undefined): Promise<LoadedLiveConfiguration> {
  const base={orcaExecutable:null,codeburnExecutable:null,noteScopeCount:0,dagQueryConfigured:false,summaryTransport:'blocked' as const};
  if(!filename) return {configuration:null,view:{...base,state:'unconfigured',message:'NOTE_APP_CONFIG에 명시한 로컬 설정 파일이 없습니다. 설정 후 앱을 다시 열어 주세요.'}};
  let handle;
  try {
    absolute(filename);
    handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await handle.stat();
    if(!before.isFile()||before.size>MAX_CONFIG_BYTES) fail();
    const buffer=Buffer.alloc(MAX_CONFIG_BYTES+1);
    let offset=0;
    try {
      while(offset<buffer.length){const r=await handle.read(buffer,offset,buffer.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}
      const after=await handle.stat();
      if(offset>MAX_CONFIG_BYTES||before.size!==offset||before.mtimeMs!==after.mtimeMs||before.size!==after.size)fail();
      const configuration=parseLiveConfiguration(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,offset))));
      return {configuration,view:{state:'ready',message:'연결하면 등록된 소스의 규칙 기반 설명을 갱신합니다. 모델 요약 생성과 노트 변경은 비활성 상태입니다.',
        orcaExecutable:configuration.orcaExecutablePath,codeburnExecutable:configuration.codeburnExecutablePath??null,
        noteScopeCount:configuration.noteScopes.length,dagQueryConfigured:!!configuration.dagQuery,summaryTransport:'blocked'}};
    } finally {buffer.fill(0);}
  } catch {return {configuration:null,view:{...base,state:'invalid',message:'로컬 설정을 읽거나 검증하지 못했습니다. 경로·파일 권한·설정 형식을 확인한 뒤 앱을 다시 열어 주세요.'}};}
  finally {await handle?.close();}
}
export function loadLiveConfiguration(filename: string | undefined): Promise<LoadedLiveConfiguration> {
  return boundedStartup(readLiveConfiguration(filename), {configuration:null,view:{state:'invalid',
    message:'시작 설정 파일 조회를 완료하지 못했습니다. 경로·권한을 확인한 뒤 앱을 다시 열어 주세요.',
    orcaExecutable:null,codeburnExecutable:null,noteScopeCount:0,dagQueryConfigured:false,summaryTransport:'blocked'}});
}
