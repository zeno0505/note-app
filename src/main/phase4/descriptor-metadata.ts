import {spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {finalizeQueryGroup} from '../../collector/orca/process-group';

/** Only the trusted startup interpreter and main-owned descriptor enter this API.
 * There is deliberately no source pathname, document reader, or executable input. */
export interface DescriptorFileMetadata {
  dev:string;ino:string;mode:number;nlink:number;size:number;mtimeMs:number;ctimeMs:number;
  isFile():boolean;isDirectory():boolean;isSymbolicLink():boolean;
}
export interface DescriptorMetadataRequest {
  rootFd:number;rootIdentity:string;components?:readonly string[];
  expectedDirectories?:readonly string[];signal?:AbortSignal;
}
export interface DescriptorMetadataListing {entries:{name:string;stat:DescriptorFileMetadata}[];partial:boolean;examinedCount:number}
export interface DescriptorMetadataTransport {
  list(request:DescriptorMetadataRequest & {limit:number}):Promise<DescriptorMetadataListing>;
  stat(request:DescriptorMetadataRequest & {name:string}):Promise<DescriptorFileMetadata>;
  dispose():void;settle():Promise<void>;
}
export const DESCRIPTOR_METADATA_LIMITS=Object.freeze({entries:5000,depth:24,pathBytes:4096,concurrency:4,timeoutMs:5000,outputBytes:4*1024*1024});
export type DescriptorMetadataErrorCode='invalid_request'|'invalid_response'|'unsupported'|'path_changed'|'cancelled'|'timeout'|'output_limit'|'command_failed'|'cleanup_unverified'|'busy'|'ENOENT'|'EACCES'|'EPERM';
export class DescriptorMetadataError extends Error {
  constructor(readonly code:DescriptorMetadataErrorCode){super(`Safe document metadata unavailable (${code}).`);this.name='DescriptorMetadataError';}
}
export const descriptorMetadataIdentity=(stat:{dev:number|string;ino:number|string;mode:number}):string=>`${stat.dev}:${stat.ino}:${stat.mode}`;

/** Fixed metadata-only program. -I -S prevents cwd/PYTHONPATH/site startup code;
 * -B prevents bytecode writes. fd 3 is inherited, not opened by pathname.
 * Open "." relative to it to get a fresh directory offset without affecting main.
 * Keep every opened ancestor until after all before/after checks have succeeded. */
const PROGRAM=String.raw`import sys, os, stat, json, errno
class Changed(Exception): pass
def identity(s): return str(s.st_dev)+':'+str(s.st_ino)+':'+str(s.st_mode)
def stamp(s): return (s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def metadata(s):
    return dict(dev=str(s.st_dev),ino=str(s.st_ino),mode=s.st_mode,nlink=s.st_nlink,size=s.st_size,mtimeMs=s.st_mtime_ns/1000000,ctimeMs=s.st_ctime_ns/1000000)
def name_ok(n):
    return isinstance(n,str) and 0<len(n)<=1024 and n not in ('.','..') and not any(c in n for c in ('/','\\','\x00')) and not any(ord(c)<32 or ord(c)==127 or 0xd800<=ord(c)<=0xdfff for c in n)
def run():
    req=json.loads(sys.argv[1])
    if set(req)!=set(('op','rootIdentity','components','expectedDirectories','limit','name')): raise ValueError()
    op,expected,parts,known,limit,name=(req[k] for k in ('op','rootIdentity','components','expectedDirectories','limit','name'))
    if op not in ('list','stat') or not isinstance(parts,list) or len(parts)>24 or not all(name_ok(p) for p in parts): raise ValueError()
    if len('/'.join(parts).encode('utf-8'))>4096 or not isinstance(expected,str): raise ValueError()
    if known is not None and (not isinstance(known,list) or len(known)!=len(parts) or not all(isinstance(k,str) for k in known)): raise ValueError()
    if op=='list' and (type(limit) is not int or not 1<=limit<=5000 or name is not None): raise ValueError()
    if op=='stat' and (not name_ok(name) or limit is not None): raise ValueError()
    if not all(hasattr(os,k) for k in ('O_DIRECTORY','O_NOFOLLOW','O_NONBLOCK')) or os.scandir not in os.supports_fd or os.open not in os.supports_dir_fd or os.stat not in os.supports_dir_fd or os.stat not in os.supports_follow_symlinks: return dict(version=1,error='unsupported')
    inherited=os.fstat(3)
    if not stat.S_ISDIR(inherited.st_mode) or identity(inherited)!=expected: raise Changed()
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK
    opened=[]
    try:
        fd=os.open('.',flags,dir_fd=3);opened.append(fd)
        first=os.fstat(fd)
        if identity(first)!=expected: raise Changed()
        before=[first]
        for i,part in enumerate(parts):
            fd=os.open(part,flags,dir_fd=fd);opened.append(fd)
            current=os.fstat(fd)
            if not stat.S_ISDIR(current.st_mode) or known is not None and identity(current)!=known[i]: raise Changed()
            before.append(current)
        response=dict(version=1,op=op,rootIdentity=expected,chain=[identity(s) for s in before[1:]])
        if op=='list':
            entries=[];partial=False;count=0
            with os.scandir(fd) as iterator:
                for item in iterator:
                    count+=1
                    if count>limit: partial=True;break
                    if not name_ok(item.name): continue
                    # Never use DirEntry's path, follow links, or open file bodies.
                    current=os.stat(item.name,dir_fd=fd,follow_symlinks=False)
                    entries.append(dict(name=item.name,stat=metadata(current)))
            response.update(entries=entries,partial=partial,examinedCount=min(count,limit))
        else:
            response['stat']=metadata(os.stat(name,dir_fd=fd,follow_symlinks=False))
        for i,current in enumerate(opened):
            if stamp(os.fstat(current))!=stamp(before[i]): raise Changed()
            if i and stamp(os.stat(parts[i-1],dir_fd=opened[i-1],follow_symlinks=False))!=stamp(before[i]): raise Changed()
        if stamp(os.fstat(3))!=stamp(first): raise Changed()
        return response
    finally:
        for fd in reversed(opened): os.close(fd)
try:
    result=run()
except Changed:
    result=dict(version=1,error='path_changed')
except OSError as e:
    code={errno.ENOENT:'ENOENT',errno.EACCES:'EACCES',errno.EPERM:'EPERM',errno.ELOOP:'path_changed',errno.ENOTDIR:'path_changed'}.get(e.errno,'command_failed')
    result=dict(version=1,error=code)
except (ValueError,TypeError,KeyError,OverflowError):
    result=dict(version=1,error='invalid_request')
except Exception:
    result=dict(version=1,error='command_failed')
finally:
    try: os.close(3)
    except OSError: pass
sys.stdout.write(json.dumps(result,ensure_ascii=True,allow_nan=False,separators=(',',':'))+'\n')
`;

function bad():never {throw new DescriptorMetadataError('invalid_response');}
const validName=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024&&v!=='.'&&v!=='..'&&!/[\/\\\u0000-\u001f\u007f\ud800-\udfff]/u.test(v);
const validIdentity=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19}):[0-9]{1,7}$/u.test(v);
function record(v:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length)bad();
  const out:Record<string,unknown>={};
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!('value'in d))bad();out[key]=d.value;}
  return out;
}
function metadata(v:unknown):DescriptorFileMetadata {
  const r=record(v,['dev','ino','mode','nlink','size','mtimeMs','ctimeMs']);
  if(![r.dev,r.ino].every(n=>typeof n==='string'&&/^(0|[1-9][0-9]{0,19})$/u.test(n))
    ||![r.mode,r.nlink,r.size].every(n=>Number.isSafeInteger(n)&&Number(n)>=0)||Number(r.mode)>0o177777
    ||![r.mtimeMs,r.ctimeMs].every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=8.64e15))bad();
  const value=r as unknown as Omit<DescriptorFileMetadata,'isFile'|'isDirectory'|'isSymbolicLink'>;
  return {...value,isFile:()=>((value.mode&0o170000)===0o100000),isDirectory:()=>((value.mode&0o170000)===0o040000),isSymbolicLink:()=>((value.mode&0o170000)===0o120000)};
}
interface Request {op:'list'|'stat';rootIdentity:string;components:string[];expectedDirectories:string[]|null;limit:number|null;name:string|null}
function request(op:Request['op'],value:DescriptorMetadataRequest & {limit?:number;name?:string}):Request {
  if(!Number.isSafeInteger(value.rootFd)||value.rootFd<0||!validIdentity(value.rootIdentity)
    ||value.signal!==undefined&&!(value.signal instanceof AbortSignal))throw new DescriptorMetadataError('invalid_request');
  const parts=value.components??[],known=value.expectedDirectories;
  if(!Array.isArray(parts)||parts.length>DESCRIPTOR_METADATA_LIMITS.depth||!parts.every(validName)||Buffer.byteLength(parts.join('/'))>DESCRIPTOR_METADATA_LIMITS.pathBytes
    ||known!==undefined&&(!Array.isArray(known)||known.length!==parts.length||!known.every(validIdentity))
    ||op==='list'&&(!Number.isSafeInteger(value.limit)||value.limit!<1||value.limit!>DESCRIPTOR_METADATA_LIMITS.entries)
    ||op==='stat'&&!validName(value.name))throw new DescriptorMetadataError('invalid_request');
  return {op,rootIdentity:value.rootIdentity,components:[...parts],expectedDirectories:known?[...known]:null,limit:op==='list'?value.limit!:null,name:op==='stat'?value.name!:null};
}
function response(value:unknown,req:Request):DescriptorMetadataListing|DescriptorFileMetadata {
  if(value&&typeof value==='object'&&Object.hasOwn(value,'error')){
    const r=record(value,['version','error']);
    if(r.version!==1||!['unsupported','path_changed','invalid_request','command_failed','ENOENT','EACCES','EPERM'].includes(String(r.error)))bad();
    throw new DescriptorMetadataError(r.error as DescriptorMetadataErrorCode);
  }
  const r=record(value,req.op==='list'?['version','op','rootIdentity','chain','entries','partial','examinedCount']:['version','op','rootIdentity','chain','stat']);
  if(r.version!==1||r.op!==req.op||r.rootIdentity!==req.rootIdentity||!Array.isArray(r.chain)||r.chain.length!==req.components.length||!r.chain.every(validIdentity)
    ||req.expectedDirectories&&r.chain.some((id,i)=>id!==req.expectedDirectories![i]))bad();
  if(req.op==='stat')return metadata(r.stat);
  if(!Array.isArray(r.entries)||r.entries.length>req.limit!||typeof r.partial!=='boolean'||!Number.isSafeInteger(r.examinedCount)||Number(r.examinedCount)<r.entries.length||Number(r.examinedCount)>req.limit!||r.partial&&r.examinedCount!==req.limit)bad();
  const seen=new Set<string>();
  const entries=r.entries.map(value=>{const e=record(value,['name','stat']);if(!validName(e.name)||seen.has(e.name))bad();seen.add(e.name);return {name:e.name,stat:metadata(e.stat)};});
  return {entries,partial:r.partial,examinedCount:r.examinedCount as number};
}

export function createDescriptorMetadataTransport(config:{pythonPath:string;timeoutMs?:number;maxOutputBytes?:number}):DescriptorMetadataTransport {
  const timeout=config.timeoutMs??DESCRIPTOR_METADATA_LIMITS.timeoutMs,maximum=config.maxOutputBytes??DESCRIPTOR_METADATA_LIMITS.outputBytes;
  if(typeof config.pythonPath!=='string'||!path.isAbsolute(config.pythonPath)||path.normalize(config.pythonPath)!==config.pythonPath||/[\u0000-\u001f\u007f]/u.test(config.pythonPath)
    ||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000||!Number.isSafeInteger(maximum)||maximum<1||maximum>8*1024*1024)throw new DescriptorMetadataError('invalid_request');
  const controller=new AbortController(),pending=new Set<Promise<unknown>>(),children=new Set<ChildProcess>();let poisoned=false;
  function execute(req:Request,rootFd:number,signal:AbortSignal):Promise<DescriptorMetadataListing|DescriptorFileMetadata>{
    if(signal.aborted)return Promise.reject(new DescriptorMetadataError('cancelled'));
    if(poisoned)return Promise.reject(new DescriptorMetadataError('cleanup_unverified'));
    if(process.platform!=='linux'&&process.platform!=='darwin')return Promise.reject(new DescriptorMetadataError('unsupported'));
    if(children.size>=DESCRIPTOR_METADATA_LIMITS.concurrency)return Promise.reject(new DescriptorMetadataError('busy'));
    return new Promise((resolve,reject)=>{
      let child:ChildProcess;
      try{child=spawn(config.pythonPath,['-I','-B','-S','-c',PROGRAM,JSON.stringify(req)],{
        shell:false,windowsHide:true,detached:true,cwd:'/',env:{LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe',rootFd],
      });}catch{reject(new DescriptorMetadataError('command_failed'));return;}
      children.add(child);
      let chunks:Buffer[]=[],bytes=0,settled=false,stopped:DescriptorMetadataErrorCode|null=null,cleanup:Promise<boolean>|undefined;
      const wipe=()=>{for(const chunk of chunks)chunk.fill(0);chunks=[];};
      const finish=(error?:DescriptorMetadataErrorCode,result?:DescriptorMetadataListing|DescriptorFileMetadata)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);wipe();
        if(error)reject(new DescriptorMetadataError(error));else resolve(result!);
      };
      const clean=()=>cleanup??=finalizeQueryGroup(child).catch(()=>false).then(ok=>{
        if(!ok){poisoned=true;child.stdout?.destroy();child.stderr?.destroy();finish('cleanup_unverified');}return ok;
      });
      const stop=(code:DescriptorMetadataErrorCode)=>{if(stopped||settled)return;stopped=code;wipe();child.stdout?.destroy();child.stderr?.destroy();void clean();};
      const abort=()=>stop('cancelled'),timer=setTimeout(()=>stop('timeout'),timeout);
      const receive=(chunk:Buffer,retain:boolean)=>{if(stopped||settled)return;bytes+=chunk.byteLength;if(bytes>maximum){stop('output_limit');return;}if(retain)chunks.push(Buffer.from(chunk));};
      child.stdout?.on('data',(chunk:Buffer)=>receive(chunk,true));child.stderr?.on('data',(chunk:Buffer)=>receive(chunk,false));
      child.stdout?.on('error',()=>stop('command_failed'));child.stderr?.on('error',()=>stop('command_failed'));
      child.once('error',()=>stop('command_failed'));child.once('exit',()=>{void clean();});
      child.once('close',async(code,termination)=>{
        children.delete(child);if(!await clean()||settled)return;
        if(stopped){finish(stopped);return;}if(code!==0||termination!==null){finish('command_failed');return;}
        const buffer=Buffer.concat(chunks);wipe();
        try{finish(undefined,response(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)),req));}
        catch(error){finish(error instanceof DescriptorMetadataError?error.code:'invalid_response');}
        finally{buffer.fill(0);}
      });
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  const run=(op:Request['op'],value:DescriptorMetadataRequest & {limit?:number;name?:string})=>{
    let req:Request;try{req=request(op,value);}catch(error){return Promise.reject(error);}
    const signal=value.signal?AbortSignal.any([controller.signal,value.signal]):controller.signal;
    const flight=execute(req,value.rootFd,signal);pending.add(flight);void flight.then(()=>pending.delete(flight),()=>pending.delete(flight));return flight;
  };
  return {
    list:value=>run('list',value) as Promise<DescriptorMetadataListing>,
    stat:value=>run('stat',value) as Promise<DescriptorFileMetadata>,
    dispose(){controller.abort();},
    async settle(){while(pending.size)await Promise.allSettled([...pending]);if(poisoned)throw new DescriptorMetadataError('cleanup_unverified');},
  };
}
