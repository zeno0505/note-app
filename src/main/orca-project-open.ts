import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {finalizeQueryGroup} from '../collector/orca/process-group';
import type {OrcaProjectOpenFailureReason,OrcaProjectOpenResult} from '../shared/orca-project-open';

/** Source-reviewed CLI contract only. A different version needs fresh acceptance. */
export const ORCA_PROJECT_OPEN_VERSION='1.4.222';
const MAX_OUTPUT_BYTES=64*1024;
export interface OrcaProjectOpenSelection {
  hostId:string;worktreeId:string;worktreePath:string;dagPath:string;runtimeId:string;
}
export interface OrcaProjectOpenerOptions<Request> {
  /** Trusted startup configuration only. Never a renderer/request executable. */
  executablePath:string;
  localHostId:string;
  /** Resolve an explicitly authorized, current binding. null means unavailable.
   * Return the full Orca worktree ID, not an application view ID or a fuzzy selector. */
  resolveSelection(request:Request,signal:AbortSignal):Promise<OrcaProjectOpenSelection|null>|OrcaProjectOpenSelection|null;
  timeoutMs?:number;
  maxOutputBytes?:number;
}
class OpenError extends Error {
  constructor(readonly reason:OrcaProjectOpenFailureReason){super(reason);}
}
const fail=(reason:OrcaProjectOpenFailureReason):never=>{throw new OpenError(reason);};
function record(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('invalid_schema');
  return value as Record<string,unknown>;
}
function text(value:unknown,maximum=4096):string{
  if(typeof value!=='string'||!value.length||value.length>maximum||value.trim()!==value||/[\u0000-\u001f\u007f]/u.test(value))return fail('invalid_schema');
  return value;
}
function limit(value:number|undefined,fallback:number,maximum:number):number{
  const result=value??fallback;
  if(!Number.isSafeInteger(result)||result<1||result>maximum)throw Error('Invalid Orca display limit.');
  return result;
}
function selection(value:OrcaProjectOpenSelection|null,localHostId:string):OrcaProjectOpenSelection{
  if(!value)return fail('unavailable');
  const row=record(value),keys=['hostId','worktreeId','worktreePath','dagPath','runtimeId'] as const;
  if(Reflect.ownKeys(row).length!==keys.length)return fail('unavailable');
  const copied={} as OrcaProjectOpenSelection;
  for(const key of keys){const entry=Object.getOwnPropertyDescriptor(row,key);if(!entry||!('value' in entry))return fail('unavailable');copied[key]=text(entry.value);}
  if(copied.hostId!==localHostId)return fail('unavailable');
  for(const p of [copied.worktreePath,copied.dagPath])if(!path.isAbsolute(p)||path.normalize(p)!==p)return fail('unsafe_path');
  if(!copied.worktreeId.endsWith('::'+copied.worktreePath)||copied.worktreeId.length<=copied.worktreePath.length+2)return fail('unavailable');
  if(copied.worktreePath===path.parse(copied.worktreePath).root||!within(copied.worktreePath,copied.dagPath))return fail('unsafe_path');
  return copied;
}
function within(root:string,file:string):boolean{
  const relative=path.relative(root,file);
  return !!relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
}
function envelope(json:string,expectedRuntime:string):Record<string,unknown>{
  if(typeof json!=='string'||Buffer.byteLength(json,'utf8')>MAX_OUTPUT_BYTES)return fail('output_limit');
  let parsed:unknown;try{parsed=JSON.parse(json);}catch{return fail('invalid_json');}
  const body=record(parsed);text(body.id,512);
  if(body.ok===false){
    if(body._meta!==undefined){const meta=record(body._meta);if(meta.runtimeId!==null&&meta.runtimeId!==undefined&&text(meta.runtimeId)!==expectedRuntime)return fail('runtime_changed');}
    const error=record(body.error);return fail(error.code==='runtime_access_denied'?'access_denied':'command_failed');
  }
  if(body.ok!==true)return fail('invalid_schema');
  const meta=record(body._meta);if(text(meta.runtimeId)!==expectedRuntime)return fail('runtime_changed');
  return record(body.result);
}
function verifyStatus(json:string,expected:OrcaProjectOpenSelection):void{
  const result=envelope(json,expected.runtimeId),runtime=record(result.runtime),app=record(result.app),target=record(result.target);
  if(text(runtime.runtimeId)!==expected.runtimeId)return fail('runtime_changed');
  if(runtime.appVersion!==ORCA_PROJECT_OPEN_VERSION)return fail('unsupported_version');
  if(target.kind!=='local'||app.running!==true||runtime.reachable!==true||runtime.state!=='ready'||runtime.connectionState!=='connected')return fail('unavailable');
}

/** Strict display-only receipt projection. Unknown payloads never leave main. */
export function parseOrcaProjectOpenResponse(json:string,expected:OrcaProjectOpenSelection,relativePath:string):OrcaProjectOpenResult{
  try{
    const result=envelope(json,expected.runtimeId);
    if(Object.keys(result).sort().join(',')!=='kind,opened,relativePath,worktree')return fail('invalid_schema');
    if(text(result.worktree)!==expected.worktreeId)return fail('selection_changed');
    if(text(result.relativePath)!==relativePath)return fail('selection_changed');
    if(typeof result.kind!=='string'||!['image','binary','markdown','text'].includes(result.kind)||typeof result.opened!=='boolean')return fail('invalid_schema');
    if(!result.opened)return fail('not_opened');
    return {ok:true,opened:true};
  }catch(error){return {ok:false,reason:error instanceof OpenError?error.reason:'invalid_schema',attempted:true};}
}

/** Standard OS/session values only: no ORCA_* command/runtime overrides, Node
 * preload hooks, dynamic-loader injection or caller-selected environment. */
function displayEnvironment():NodeJS.ProcessEnv{
  const result:NodeJS.ProcessEnv={};
  for(const key of ['HOME','USER','LOGNAME','PATH','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','SystemRoot','WINDIR']){
    const value=process.env[key];if(value!==undefined)result[key]=value;
  }
  return result;
}

/** Main-only display capability. No generic argv, shell, app-only launch, URL,
 * worktree creation, prompt, terminal or agent operation exists here. */
export function createOrcaProjectOpener<Request>(options:OrcaProjectOpenerOptions<Request>){
  const executable=options.executablePath;
  if(typeof executable!=='string'||!path.isAbsolute(executable)||/[\u0000-\u001f\u007f]/u.test(executable))throw Error('Orca display executable must be a trusted absolute path.');
  const host=text(options.localHostId),timeoutMs=limit(options.timeoutMs,10_000,30_000),maxBytes=limit(options.maxOutputBytes,MAX_OUTPUT_BYTES,MAX_OUTPUT_BYTES);
  // A bounded reply is not proof that an unabortable resolver/filesystem read
  // finished. Retain every original promise until its actual settlement.
  const pendingReads=new Set<Promise<unknown>>();
  let active:AbortController|null=null,activeCompletion:Promise<void>|null=null,disposed=false,cleanupUnverified=false;
  async function open(request:Request,requestOptions:{signal?:AbortSignal}={}):Promise<OrcaProjectOpenResult>{
    if(cleanupUnverified)return {ok:false,reason:'cleanup_unverified',attempted:false};
    if(disposed)return {ok:false,reason:'unavailable',attempted:false};
    if(active||pendingReads.size)return {ok:false,reason:'busy',attempted:false};
    if(requestOptions.signal?.aborted)return {ok:false,reason:'cancelled',attempted:false};
    const controller=new AbortController();active=controller;let attempted=false,timedOut=false,completed!:()=>void;
    activeCompletion=new Promise<void>(resolve=>{completed=resolve;});
    const deadline=Date.now()+timeoutMs;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    const cancel=()=>controller.abort();requestOptions.signal?.addEventListener('abort',cancel,{once:true});
    const check=()=>{if(controller.signal.aborted||Date.now()>=deadline)return fail(timedOut||Date.now()>=deadline?'timeout':'cancelled');};
    async function bounded<T>(operation:()=>Promise<T>|T):Promise<T>{
      check();let onAbort:(()=>void)|undefined;
      const original=Promise.resolve().then(()=>{check();return operation();});
      pendingReads.add(original);
      void original.then(()=>pendingReads.delete(original),()=>pendingReads.delete(original));
      try{return await Promise.race([original,new Promise<never>((_,reject)=>{
        onAbort=()=>reject(new OpenError(timedOut?'timeout':'cancelled'));controller.signal.addEventListener('abort',onAbort,{once:true});if(controller.signal.aborted)onAbort();
      })]);}finally{if(onAbort)controller.signal.removeEventListener('abort',onAbort);}
    }
    async function inspect(chosen:OrcaProjectOpenSelection){
      const root=await bounded(()=>fs.realpath(chosen.worktreePath)),file=await bounded(()=>fs.realpath(chosen.dagPath));
      // The CLI computes its relative path against the registered worktree path.
      // A symlinked root could produce a different destination, so fail closed.
      if(root!==chosen.worktreePath||!within(root,file))return fail('unsafe_path');
      const tree=await bounded(()=>fs.lstat(root)),note=await bounded(()=>fs.lstat(file));
      if(!tree.isDirectory()||!note.isFile()||note.isSymbolicLink())return fail('unsafe_path');
      if(await bounded(()=>fs.realpath(root))!==root||await bounded(()=>fs.realpath(file))!==file)return fail('selection_changed');
      return {root,file,relativePath:path.relative(root,file).split(path.sep).join('/'),
        fingerprint:JSON.stringify([root,file,tree.dev,tree.ino,note.dev,note.ino,note.size,note.mtimeMs,note.ctimeMs])};
    }
    async function run(args:readonly string[],display:boolean):Promise<string>{
      check();
      return new Promise((resolve,reject)=>{
        let chunks:Buffer[]=[],bytes=0,stopped:OrcaProjectOpenFailureReason|null=null,settled=false,cleanup:Promise<boolean>|null=null;
        let child:ReturnType<typeof spawn>;
        try{
          child=spawn(executable,[...args],{shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:displayEnvironment()});
          if(display)attempted=true;
        }catch{return reject(new OpenError('spawn_failed'));}
        const wipe=()=>{for(const chunk of chunks)chunk.fill(0);chunks=[];};
        const finish=(reason:OrcaProjectOpenFailureReason|null,json?:string)=>{
          if(settled)return;settled=true;controller.signal.removeEventListener('abort',onAbort);wipe();
          if(reason)reject(new OpenError(reason));else resolve(json!);
        };
        const startCleanup=():Promise<boolean>=>{
          if(cleanup)return cleanup;
          cleanup=finalizeQueryGroup(child).catch(()=>false);
          void cleanup.then(verified=>{if(!verified){cleanupUnverified=true;child.stdout!.destroy();child.stderr!.destroy();finish('cleanup_unverified');}});
          return cleanup;
        };
        const stop=(reason:OrcaProjectOpenFailureReason)=>{
          if(stopped||settled)return;stopped=reason;wipe();child.stdout!.destroy();child.stderr!.destroy();void startCleanup();
        };
        const onAbort=()=>stop(timedOut?'timeout':'cancelled');
        controller.signal.addEventListener('abort',onAbort,{once:true});if(controller.signal.aborted)onAbort();
        const receive=(chunk:Buffer,retain:boolean)=>{if(stopped||settled)return;bytes+=chunk.byteLength;if(bytes>maxBytes){stop('output_limit');return;}if(retain)chunks.push(Buffer.from(chunk));};
        child.stdout!.on('data',(chunk:Buffer)=>receive(chunk,true));child.stderr!.on('data',(chunk:Buffer)=>receive(chunk,false));
        child.stdout!.on('error',()=>stop('command_failed'));child.stderr!.on('error',()=>stop('command_failed'));
        child.once('error',(error:NodeJS.ErrnoException)=>stop(error.code==='ENOENT'?'unavailable':error.code==='EACCES'||error.code==='EPERM'?'access_denied':'spawn_failed'));
        child.once('exit',()=>{void startCleanup();});
        child.once('close',async(code,signal)=>{
          const verified=await startCleanup();if(settled||!verified)return;
          if(stopped){finish(stopped);return;}
          if(code!==0||signal!==null){finish('command_failed');return;}
          const buffer=Buffer.concat(chunks);wipe();
          try{finish(null,new TextDecoder('utf-8',{fatal:true}).decode(buffer));}catch{finish('invalid_json');}finally{buffer.fill(0);}
        });
      });
    }
    try{
      const chosen=selection(await bounded(()=>options.resolveSelection(request,controller.signal)),host);
      const initial=await inspect(chosen);
      // CLI and running app versions are separate evidence. Both must match the
      // reviewed contract; no help/version text is interpreted as a command.
      if(await run(['--version'],false)!==ORCA_PROJECT_OPEN_VERSION+'\n')return fail('unsupported_version');
      verifyStatus(await run(['status','--json'],false),chosen);
      const current=selection(await bounded(()=>options.resolveSelection(request,controller.signal)),host);
      if(JSON.stringify(current)!==JSON.stringify(chosen))return fail('selection_changed');
      const verified=await inspect(current);if(verified.fingerprint!==initial.fingerprint)return fail('selection_changed');
      const finalSelection=selection(await bounded(()=>options.resolveSelection(request,controller.signal)),host);
      if(JSON.stringify(finalSelection)!==JSON.stringify(chosen))return fail('selection_changed');
      check();
      // Orca accepts a pathname, not a transferred descriptor. These freshness
      // checks are not an atomic lock against an independent filesystem writer.
      const json=await run(['file','open','--path',verified.file,'--worktree',`id:${chosen.worktreeId}`,'--focus','--json'],true);
      return parseOrcaProjectOpenResponse(json,chosen,verified.relativePath);
    }catch(error){return {ok:false,reason:error instanceof OpenError?error.reason:'unavailable',attempted};}
    finally{clearTimeout(timer);requestOptions.signal?.removeEventListener('abort',cancel);active=null;activeCompletion=null;completed();}
  }
  return {open,invalidate(){active?.abort();},dispose(){disposed=true;active?.abort();},
    cleanupState:():'verified'|'pending'|'unverified'=>cleanupUnverified?'unverified':active||pendingReads.size?'pending':'verified',
    /** Shutdown ownership follows the original work, not the bounded reply. */
    async settle():Promise<void>{while(activeCompletion||pendingReads.size)await Promise.allSettled([...pendingReads,...(activeCompletion?[activeCompletion]:[])]);}};
}
