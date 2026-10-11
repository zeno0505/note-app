import type {DescriptorMetadataTransport,DescriptorFileMetadata} from './descriptor-metadata';
import fs from 'node:fs/promises';
import {constants,type Stats} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {DocumentRelationship,ProjectDocumentCatalog,ProjectDocumentEntry,ProjectDocumentListing,ProjectDocumentListRequest} from '../../shared/documents';

export const DOCUMENT_CATALOG_LIMITS=Object.freeze({roots:8,entries:5000,page:128,depth:24,queries:24,capabilities:10000,timeoutMs:5000});
export interface DocumentRoot {key:string;path:string;label:string;kind:'note'|'linked';authorize:()=>Promise<boolean>}
interface Root extends DocumentRoot {identity:string}
interface Entry {id:string;root:Root;relativePath:string;kind:'directory'|'file';identity:string}
type MetadataStat=Stats|DescriptorFileMetadata;
const identity=(stat:MetadataStat)=>`${stat.dev}:${stat.ino}:${stat.mode}`;
const stamp=(stat:MetadataStat)=>`${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const excluded=(name:string)=>name.startsWith('.')||['node_modules','vendor','dist','build','coverage','__pycache__'].includes(name);
const format=(name:string):ProjectDocumentEntry['format']=>({'.md':'markdown','.markdown':'markdown','.png':'png','.yaml':'yaml','.yml':'yaml','.json':'json'} as const)[path.extname(name).toLowerCase() as '.md'];
export function safeDocumentRelativePath(value:string):boolean{return !!value&&value.length<=4096&&!path.isAbsolute(value)&&!/[\\:#?%\[\]|\u0000-\u001f\u007f]/u.test(value)&&value.split('/').every(p=>!!p&&p!=='.'&&p!=='..'&&!excluded(p));}
export async function checkedDocumentDirectory(filename:string,active:()=>void):Promise<Stats>{
  let current=path.parse(filename).root,last:Stats|undefined;
  for(const part of filename.slice(current.length).split(path.sep)){active();current=path.join(current,part);last=await fs.lstat(current);active();if(!last.isDirectory()||last.isSymbolicLink())throw Error('문서 폴더 경로가 변경됐거나 안전하지 않습니다.');}
  if(!last||await fs.realpath(filename)!==filename)throw Error('문서 폴더 경로를 확인할 수 없습니다.');active();return last;
}
export class DocumentPathChangedError extends Error {constructor(){super('조회 중 문서 폴더 경로가 변경되었습니다. 다시 조회해 주세요.');}}
/** The system descriptor path is internal, never an input, grant, or renderer path.
 * Directory enumeration and child metadata stay bound to the opened inode even if
 * any ordinary pathname ancestor is renamed or temporarily replaced by a symlink.
 * No pathname-based fallback: unsupported platforms fail closed. */
export async function pinDocumentDirectory(filename:string,active:()=>void,expectedIdentity?:string,openedPath=filename,metadata?:DescriptorMetadataTransport,signal?:AbortSignal){
  const before=await checkedDocumentDirectory(filename,active);
  if(expectedIdentity&&identity(before)!==expectedIdentity)throw new DocumentPathChangedError();
  // macOS lacks directory traversal through /dev/fd. A trusted inherited-fd
  // helper handles metadata there; canonical opens still must match a parent-
  // descriptor-derived identity before any enumeration can occur.
  const openPath=process.platform==='linux'&&!metadata?openedPath:filename;
  const handle=await fs.open(openPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    active();const opened=await handle.stat();active();
    if(!opened.isDirectory()||identity(opened)!==identity(before))throw new DocumentPathChangedError();
    const descriptorPath=process.platform==='linux'&&!metadata?`/proc/self/fd/${handle.fd}`:null;
    if(descriptorPath&&identity(await fs.stat(descriptorPath))!==identity(opened))throw new DocumentPathChangedError();
    if(!descriptorPath&&!metadata)throw Error('안전한 문서 메타데이터 실행 환경을 확인해 주세요.');
    const stat=async(relative:string):Promise<MetadataStat>=>{
      if(!safeDocumentRelativePath(relative))throw new DocumentPathChangedError();const components=relative.split('/'),name=components.pop()!;active();
      if(!descriptorPath){const value=await metadata!.stat({rootFd:handle.fd,rootIdentity:identity(opened),components,name,signal});active();return value;}
      // Never follow intermediate user-owned symlinks while inspecting a target.
      const parents:fs.FileHandle[]=[];let parent=descriptorPath;
      try{for(const component of components){const directory=await fs.open(path.join(parent,component),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);parents.push(directory);active();if(!(await directory.stat()).isDirectory())throw new DocumentPathChangedError();parent=`/proc/self/fd/${directory.fd}`;}const value=await fs.lstat(path.join(parent,name));active();return value;}
      finally{for(const directory of parents.reverse())await directory.close();}
    };
    const list=async(limit:number):Promise<{entries:{name:string;stat:MetadataStat}[];partial:boolean;examinedCount:number}>=>{
      if(!Number.isSafeInteger(limit)||limit<1||limit>DOCUMENT_CATALOG_LIMITS.entries)throw Error('문서 목록 한도 오류');active();
      if(!descriptorPath){const value=await metadata!.list({rootFd:handle.fd,rootIdentity:identity(opened),limit,signal});active();return value;}
      const entries:{name:string;stat:MetadataStat}[]=[];let partial=false;const directory=await fs.opendir(descriptorPath,{bufferSize:64});
      try{for await(const dirent of directory){active();if(entries.length>=limit){partial=true;break;}const child=await fs.lstat(path.join(descriptorPath,dirent.name));active();entries.push({name:dirent.name,stat:child});}}
      finally{try{await directory.close();}catch{/* iterator owns normal closure */}}
      return {entries,partial,examinedCount:entries.length};
    };
    active();return {handle,descriptorPath,before,stat,list,async verify(){active();if(stamp(await handle.stat())!==stamp(before)||stamp(await checkedDocumentDirectory(filename,active))!==stamp(before))throw new DocumentPathChangedError();}};
  }catch(error){await handle.close();throw error;}
}
function request(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('문서 목록 요청 오류');
  const out:Record<string,unknown>={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||![...required,...optional].includes(key)||!d||!('value'in d))throw Error('문서 목록 요청 오류');out[key]=d.value;}
  if(required.some(k=>!Object.hasOwn(out,k)))throw Error('문서 목록 요청 오류');return out;
}
export function documentRequest(value:unknown,required:string[],optional:string[]=[]):Record<string,string|undefined>{const v=request(value,required,optional);for(const [key,item]of Object.entries(v))if(typeof item!=='string'||!item||item.length>(key==='query'?256:key==='workstreamId'?1024:128)||/[\u0000-\u001f\u007f]/u.test(item))throw Error('문서 식별자 오류');return v as Record<string,string|undefined>;}

export function parseDocumentListRequest(value:unknown):ProjectDocumentListRequest {
  const raw=request(value,['catalogId','directoryId'],['query','cursor','refresh']);
  if(Object.hasOwn(raw,'refresh')&&raw.refresh!==true)throw Error('문서 목록 새로고침 요청 오류');
  const {refresh,...fields}=raw;documentRequest(fields,['catalogId','directoryId'],['query','cursor']);
  if(refresh&&raw.cursor)throw Error('새로고침은 첫 페이지에서 시작해 주세요.');
  return raw as unknown as ProjectDocumentListRequest;
}

/** Lazy, filename-only enumeration of explicitly approved project roots. No file bodies are read. */
export async function createDocumentCatalog(options:{roots:DocumentRoot[];now?:()=>number;signal?:AbortSignal;metadata?:DescriptorMetadataTransport}){
  if(!options.roots.length||options.roots.length>DOCUMENT_CATALOG_LIMITS.roots)throw Error('문서 읽기 범위를 확인해 주세요.');
  const now=options.now??Date.now,controller=new AbortController(),catalogId=randomUUID(),rootDirectoryId=randomUUID();
  const signal=AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])]),roots:Root[]=[],entries=new Map<string,Entry>(),byPath=new Map<string,string>();
  const pages=new Map<string,{queryKey:string;offset:number}>(),queries=new Map<string,{entries:ProjectDocumentEntry[];partial:boolean;omissions:string[];observedAt:string}>();let busy=false;
  const active=()=>{if(signal.aborted)throw Error('문서 목록 조회가 취소되었습니다.');};
  const initialDeadline=Date.now()+DOCUMENT_CATALOG_LIMITS.timeoutMs;
  for(const root of options.roots){active();if(Date.now()>initialDeadline||!path.isAbsolute(root.path)||path.normalize(root.path)!==root.path||root.path===path.parse(root.path).root||!await root.authorize())throw Error('문서 읽기 권한을 확인할 수 없습니다.');const stat=await checkedDocumentDirectory(root.path,active);if(!await root.authorize())throw Error('문서 읽기 권한이 변경되었습니다.');active();roots.push({...root,identity:identity(stat)});}
  const revision=createHash('sha256').update(JSON.stringify(roots.map(r=>[r.key,r.identity]))+catalogId).digest('hex');
  const view:ProjectDocumentCatalog={catalogId,revision,scopeLabel:'프로젝트 노트와 명시적으로 연결한 문서 폴더',rootDirectoryId,observedAt:new Date(now()).toISOString()};
  async function validate(root:Root){active();if(!await root.authorize())throw Error('문서 읽기 허용이 철회되었습니다.');const stat=await checkedDocumentDirectory(root.path,active);if(identity(stat)!==root.identity)throw Error('문서 폴더가 교체되었습니다. 다시 연결해 주세요.');active();}
  function register(root:Root,relativePath:string,kind:Entry['kind'],stat:MetadataStat):Entry{
    const key=JSON.stringify([root.key,relativePath]),prior=byPath.get(key);if(prior){const found=entries.get(prior)!;if(found.identity===identity(stat)&&found.kind===kind)return found;entries.delete(prior);byPath.delete(key);}
    if(entries.size>=DOCUMENT_CATALOG_LIMITS.capabilities)throw Error('문서 식별자 한도를 넘었습니다. 목록을 새로고침해 주세요.');const entry={id:randomUUID(),root,relativePath,kind,identity:identity(stat)};entries.set(entry.id,entry);byPath.set(key,entry.id);return entry;
  }
  function descriptor(entry:Entry):ProjectDocumentEntry{
    const common=entry.root.kind==='note'&&['context.md','dag.md','e2e-checklist.md'].includes(entry.relativePath);
    const relationships:DocumentRelationship[]=[{kind:common?'project-context':'catalog',label:common?'프로젝트 공통':'프로젝트 문서 목록',observedAt:view.observedAt,verification:'not-assessed'}];
    return {id:entry.id,kind:entry.kind,scopeLabel:entry.root.label,navigationKey:createHash('sha256').update(JSON.stringify([entry.root.key,entry.root.path,entry.root.identity])).digest('hex')+'/'+entry.relativePath,name:entry.relativePath?path.posix.basename(entry.relativePath):entry.root.label,relativePath:entry.relativePath, ...(entry.kind==='file'?{format:format(entry.relativePath)}:{}),relationships};
  }
  // A virtual root keeps separately authorized folders visibly separate; paths never cross scopes.
  for(const root of roots){const stat=await checkedDocumentDirectory(root.path,active);register(root,'','directory',stat);}
  async function validateEntry(entry:Entry){
    await validate(entry.root);const rootPin=await pinDocumentDirectory(entry.root.path,active,entry.root.identity,undefined,options.metadata,signal);let selected:Awaited<ReturnType<typeof pinDocumentDirectory>>|undefined;
    try{
      if(entry.kind==='directory'){
        if(entry.relativePath){const expected=await rootPin.stat(entry.relativePath);if(!expected.isDirectory()||expected.isSymbolicLink()||identity(expected)!==entry.identity)throw new DocumentPathChangedError();selected=await pinDocumentDirectory(path.join(entry.root.path,entry.relativePath),active,entry.identity,rootPin.descriptorPath?path.join(rootPin.descriptorPath,entry.relativePath):undefined,options.metadata,signal);}else selected=rootPin;
      }else {const stat=await rootPin.stat(entry.relativePath);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw Error('문서 파일 경로를 안전하게 확인할 수 없습니다.');}
      await selected?.verify();if(selected!==rootPin)await rootPin.verify();
    }finally{if(selected&&selected!==rootPin)await selected.handle.close();await rootPin.handle.close();}
  }
  async function list(input:ProjectDocumentListRequest):Promise<ProjectDocumentListing>{
    const req=parseDocumentListRequest(input);if(req.catalogId!==catalogId)throw Error('등록되지 않은 문서 목록입니다.');active();if(busy)throw Error('문서 목록을 조회 중입니다.');busy=true;
    const deadline=Date.now()+DOCUMENT_CATALOG_LIMITS.timeoutMs,check=()=>{active();if(Date.now()>deadline)throw Error('문서 목록 조회 시간이 초과됐습니다.');};
    try{
      const directory=req.directoryId===rootDirectoryId?null:entries.get(req.directoryId!);if(req.directoryId!==rootDirectoryId&&(!directory||directory.kind!=='directory'))throw Error('등록되지 않은 문서 폴더입니다.');
      for(const root of directory?[directory.root]:roots)await validate(root);
      if(directory)await validateEntry(directory);
      const query=(req.query??'').trim().toLocaleLowerCase(),queryKey=JSON.stringify([req.directoryId,query]);if(req.refresh){queries.clear();pages.clear();}let cached=queries.get(queryKey),offset=0;
      if(req.cursor){const page=pages.get(req.cursor);if(!page||page.queryKey!==queryKey||!cached)throw Error('문서 목록 페이지가 만료되었습니다.');offset=page.offset;}
      if(!cached){
        const result:ProjectDocumentEntry[]=[],omissions=new Set<string>();let visited=0,partial=false;
        const registeredBefore=new Set(entries.keys());
        const scan=async(root:Root,relativePath:string,recursive:boolean,depth:number,expectedIdentity:string,openedPath?:string):Promise<void>=>{
          check();if(depth>DOCUMENT_CATALOG_LIMITS.depth){partial=true;omissions.add('폴더 깊이 한도로 일부 목록을 확인하지 못했습니다.');return;}
          const filename=path.join(root.path,relativePath);let pinned:Awaited<ReturnType<typeof pinDocumentDirectory>>|undefined;
          try{
            pinned=await pinDocumentDirectory(filename,check,expectedIdentity,openedPath,options.metadata,signal);
            const remaining=DOCUMENT_CATALOG_LIMITS.entries-visited;if(remaining<=0){partial=true;omissions.add('파일 이름 5,000개 한도로 일부 목록을 확인하지 못했습니다.');return;}
            const listing=await pinned.list(remaining);visited+=listing.examinedCount;
            if(listing.partial){partial=true;omissions.add('파일 이름 5,000개 한도로 일부 목록을 확인하지 못했습니다.');}
            for(const {name,stat}of listing.entries){check();if(excluded(name)||stat.isSymbolicLink())continue;const relative=relativePath?`${relativePath}/${name}`:name;if(!safeDocumentRelativePath(relative))continue;
              if(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1||!format(name)))continue;
              const entry=register(root,relative,stat.isDirectory()?'directory':'file',stat);
              if(!query||relative.toLocaleLowerCase().includes(query))result.push(descriptor(entry));
              if(recursive&&entry.kind==='directory'){if(visited>=DOCUMENT_CATALOG_LIMITS.entries){partial=true;omissions.add('파일 이름 5,000개 한도로 일부 목록을 확인하지 못했습니다.');}else await scan(root,relative,true,depth+1,entry.identity,pinned.descriptorPath?path.join(pinned.descriptorPath,name):undefined);}
            }
            await pinned.verify();
          }catch(error){
            if(signal.aborted||error instanceof DocumentPathChangedError)throw error;
            if(Date.now()>deadline||['EACCES','EPERM','ENOENT'].includes((error as NodeJS.ErrnoException).code??'')){partial=true;omissions.add(Date.now()>deadline?'조회 시간 한도로 일부 목록을 확인하지 못했습니다.':'접근할 수 없는 폴더가 있어 목록이 일부만 표시됩니다.');}
            else throw error;
          }finally{await pinned?.handle.close();}
        };
        try{
        if(directory)await scan(directory.root,directory.relativePath,!!query,0,directory.identity);
        else if(query)for(const root of roots){await scan(root,'',true,0,root.identity);if(visited>DOCUMENT_CATALOG_LIMITS.entries||Date.now()>deadline)break;}
        else for(const root of roots)result.push(descriptor(entries.get(byPath.get(JSON.stringify([root.key,'']))!)!));
        for(const root of directory?[directory.root]:roots)await validate(root);
        }catch(error){for(const [id,entry]of entries)if(!registeredBefore.has(id)){entries.delete(id);byPath.delete(JSON.stringify([entry.root.key,entry.relativePath]));}throw error;}
        result.sort((a,b)=>a.kind===b.kind?a.relativePath.localeCompare(b.relativePath,'en',{numeric:true}):a.kind==='directory'?-1:1);
        cached={entries:result,partial,omissions:[...omissions],observedAt:new Date(now()).toISOString()};if(queries.size>=DOCUMENT_CATALOG_LIMITS.queries){const oldest=queries.keys().next().value!;queries.delete(oldest);for(const [id,p]of pages)if(p.queryKey===oldest)pages.delete(id);}queries.set(queryKey,cached);
      }
      const next=offset+DOCUMENT_CATALOG_LIMITS.page;let nextCursor:string|null=null;if(next<cached.entries.length){nextCursor=[...pages].find(([,page])=>page.queryKey===queryKey&&page.offset===next)?.[0]??randomUUID();pages.set(nextCursor,{queryKey,offset:next});}
      const breadcrumbs:{id:string;name:string}[]=[{id:rootDirectoryId,name:'문서 폴더'}];if(directory){const parts=directory.relativePath?directory.relativePath.split('/'):[];for(let i=0;i<=parts.length;i++){const relative=parts.slice(0,i).join('/'),id=byPath.get(JSON.stringify([directory.root.key,relative]));if(id)breadcrumbs.push({id,name:i?parts[i-1]:directory.root.label});}}
      active();return {catalogId,revision,directoryId:req.directoryId!,breadcrumbs,entries:cached.entries.slice(offset,next),nextCursor,partial:cached.partial,omissions:cached.omissions,observedAt:cached.observedAt};
    }finally{busy=false;}
  }
  async function resolve(id:string){active();const entry=entries.get(id);if(!entry||entry.kind!=='file')throw Error('등록되지 않은 문서입니다.');await validateEntry(entry);active();return {root:entry.root,relativePath:entry.relativePath,descriptor:descriptor(entry),authorize:async()=>{try{await validateEntry(entry);return true;}catch{return false;}}};}
  return {view:()=>structuredClone(view),list,resolve,release(){controller.abort();queries.clear();pages.clear();entries.clear();byPath.clear();}};
}
