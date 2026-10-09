import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {finalizeQueryGroup} from '../collector/orca/process-group';
import {PROJECT_DAG_LIMITS} from '../shared/project-dag';

/** Main-only capability evidence. Never accept these objects from renderer IPC. */
export interface ProjectDagDirectorySnapshot {
  directory:string;dev:string;ino:string;uid:number;mode:number;
  targetState:'absent';inspectedAt:string;
}
/** Keep in main memory, and use only with the writer instance that issued it. */
export interface ProjectDagWriteReceipt {
  state:'created'|'already-created';targetPath:string;contentHash:string;publicationId:string;
  directoryDev:string;directoryIno:string;targetDev:string;targetIno:string;
  targetUid:number;targetSize:number;targetCtimeNs:string;targetMtimeNs:string;createdAt:string;
}
export interface ProjectDagWriteRequest {
  directory:ProjectDagDirectorySnapshot;content:string;contentHash:string;publicationId:string;
  previousReceipt?:ProjectDagWriteReceipt;
}
export interface ProjectDagWriter {
  inspect(directory:string,signal?:AbortSignal):Promise<ProjectDagDirectorySnapshot>;
  publish(request:ProjectDagWriteRequest,signal?:AbortSignal):Promise<ProjectDagWriteReceipt>;
}
export type ProjectDagWriterErrorCode=
  |'invalid_configuration'|'invalid_request'|'invalid_content'|'content_limit'|'unsupported_platform'
  |'unsafe_path'|'directory_changed'|'target_exists'|'receipt_mismatch'|'permission_denied'
  |'io_failed'|'busy'|'cancelled'|'timeout'|'output_limit'|'command_failed'|'cleanup_unverified'|'publication_uncertain';
export class ProjectDagWriterError extends Error {
  constructor(readonly code:ProjectDagWriterErrorCode,readonly outcome:'not-created'|'uncertain'='not-created') {
    super(`Project DAG publication: ${code}`);this.name='ProjectDagWriterError';
  }
}

const INPUT_LIMIT=192*1024,OUTPUT_LIMIT=16*1024,RECEIPT_LIMIT=256;
const HASH=/^[a-f0-9]{64}$/u,INTEGER=/^(?:0|[1-9][0-9]{0,30})$/u;
const HELPER_CODES=new Set<ProjectDagWriterErrorCode>(['invalid_request','invalid_content','content_limit','unsupported_platform','unsafe_path','directory_changed','target_exists','receipt_mismatch','permission_denied','io_failed']);

/**
 * No source file is executed and no YAML is parsed. The fixed helper only publishes
 * exact main-approved bytes to dag.yaml. Every path component is opened relative
 * to a held directory descriptor with O_NOFOLLOW. All mutations use that final
 * descriptor, including cleanup; no path-based rename/write fallback exists.
 *
 * Before/after path checks detect relocation. They cannot exclude all simultaneous
 * same-user ancestor swaps, but a swap never redirects a directory-relative write
 * into another directory inode. Stat/link and stat/unlink are not an atomic proof
 * against a malicious process running as this same user. Detected substitutions
 * fail closed; an uncertain publication permanently retires this writer.
 */
const HELPER=String.raw`import os, sys, json, stat, hashlib, base64, secrets
LIMIT = 131072
TARGET = 'dag.yaml'
linked = False
link_attempted = False
fds = []
temp_name = None
temp_identity = None
root_fd = None

class Refusal(Exception):
    def __init__(self, code): self.code = code

def refuse(code): raise Refusal(code)
def identity(s): return (s.st_dev, s.st_ino)
def safe_directory(s, final=False):
    if not stat.S_ISDIR(s.st_mode): refuse('unsafe_path')
    if s.st_uid not in (0, os.getuid()): refuse('unsafe_path')
    # A root-owned sticky shared ancestor (/tmp) cannot rename another user's
    # owned child. A sticky directory owned by somebody else is not equivalent.
    sticky_root = not final and s.st_uid == 0 and bool(s.st_mode & stat.S_ISVTX)
    if s.st_mode & 0o022 and not sticky_root: refuse('unsafe_path')
    if final and (s.st_uid != os.getuid() or s.st_mode & 0o300 != 0o300): refuse('unsafe_path')

def open_directory(directory):
    if not isinstance(directory, str) or len(directory.encode('utf-8')) > 4096 or not directory.startswith('/') or directory == '/' or '\x00' in directory:
        refuse('unsafe_path')
    if os.path.normpath(directory) != directory or directory.startswith('//') or os.path.realpath(directory) != directory:
        refuse('unsafe_path')
    components = directory[1:].split('/')
    if len(components) > 256 or any(part in ('', '.', '..') for part in components): refuse('unsafe_path')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open('/', flags)
    try:
        safe_directory(os.fstat(current))
        for index, component in enumerate(components):
            child = os.open(component, flags, dir_fd=current)
            os.close(current)
            current = child
            safe_directory(os.fstat(current), index == len(components) - 1)
        return current
    except BaseException:
        os.close(current)
        raise

def check_expected(fd, expected):
    s = os.fstat(fd)
    safe_directory(s, True)
    if str(s.st_dev) != expected['dev'] or str(s.st_ino) != expected['ino'] or s.st_uid != expected['uid'] or stat.S_IMODE(s.st_mode) != expected['mode']:
        refuse('directory_changed')
    return s

def check_path(directory, expected):
    check = open_directory(directory)
    try: return check_expected(check, expected)
    finally: os.close(check)

def target_absent(fd):
    try: os.stat(TARGET, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError: return
    refuse('target_exists')

def remove_owned_temp():
    global temp_name
    if root_fd is None or temp_name is None or temp_identity is None: return
    try:
        s = os.stat(temp_name, dir_fd=root_fd, follow_symlinks=False)
        # Never unlink a substitute, even a symlink or another same-user file.
        if identity(s) == temp_identity and stat.S_ISREG(s.st_mode):
            os.unlink(temp_name, dir_fd=root_fd)
            temp_name = None
    except FileNotFoundError:
        temp_name = None

def target_receipt(fd, expected_identity, expected_content, previous=None):
    target_fd = os.open(TARGET, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
    try:
        before = os.fstat(target_fd)
        if not stat.S_ISREG(before.st_mode) or identity(before) != expected_identity or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_size != len(expected_content):
            refuse('receipt_mismatch')
        if previous is not None and (before.st_uid != previous['targetUid'] or before.st_size != previous['targetSize'] or str(before.st_ctime_ns) != previous['targetCtimeNs'] or str(before.st_mtime_ns) != previous['targetMtimeNs']):
            refuse('receipt_mismatch')
        chunks = []
        total = 0
        while True:
            block = os.read(target_fd, min(65536, LIMIT + 1 - total))
            if not block: break
            chunks.append(block)
            total += len(block)
            if total > LIMIT: refuse('receipt_mismatch')
        actual = b''.join(chunks)
        after = os.fstat(target_fd)
        named = os.stat(TARGET, dir_fd=fd, follow_symlinks=False)
        if actual != expected_content or identity(after) != expected_identity or identity(named) != expected_identity or named.st_ctime_ns != after.st_ctime_ns or named.st_mtime_ns != after.st_mtime_ns or named.st_size != after.st_size or named.st_nlink != 1 or before.st_ctime_ns != after.st_ctime_ns or before.st_mtime_ns != after.st_mtime_ns or before.st_size != after.st_size or after.st_nlink != 1:
            refuse('receipt_mismatch')
        return {'targetDev': str(after.st_dev), 'targetIno': str(after.st_ino), 'targetUid': after.st_uid, 'targetSize': after.st_size, 'targetCtimeNs': str(after.st_ctime_ns), 'targetMtimeNs': str(after.st_mtime_ns)}
    finally: os.close(target_fd)

def run():
    global root_fd, temp_name, temp_identity, linked, link_attempted
    if os.name != 'posix' or not all(hasattr(os, flag) for flag in ('O_DIRECTORY','O_NOFOLLOW','O_CLOEXEC')) or os.open not in os.supports_dir_fd or os.link not in os.supports_dir_fd or os.unlink not in os.supports_dir_fd:
        refuse('unsupported_platform')
    raw = sys.stdin.buffer.read(196609)
    if len(raw) > 196608: refuse('invalid_request')
    request = json.loads(raw.decode('utf-8'))
    directory = request['directory']
    root_fd = open_directory(directory)
    initial = os.fstat(root_fd)
    expected = {'dev':str(initial.st_dev), 'ino':str(initial.st_ino), 'uid':initial.st_uid, 'mode':stat.S_IMODE(initial.st_mode)}
    if request['operation'] == 'inspect':
        target_absent(root_fd)
        check_path(directory, expected)
        target_absent(root_fd)
        return {'directory':directory, **expected, 'targetState':'absent'}
    if request['operation'] != 'publish': refuse('invalid_request')
    expected = request['expected']
    check_expected(root_fd, expected)
    content = base64.b64decode(request['contentBase64'], validate=True)
    if not content or len(content) > LIMIT: refuse('content_limit')
    content.decode('utf-8', errors='strict')
    if hashlib.sha256(content).hexdigest() != request['contentHash']: refuse('invalid_content')
    previous = request.get('previousReceipt')
    if previous is not None:
        if previous['directoryDev'] != expected['dev'] or previous['directoryIno'] != expected['ino'] or previous['contentHash'] != request['contentHash'] or previous['publicationId'] != request['publicationId'] or previous['targetPath'] != directory + '/' + TARGET:
            refuse('receipt_mismatch')
        receipt = target_receipt(root_fd, (int(previous['targetDev']),int(previous['targetIno'])), content, previous)
        check_expected(root_fd, expected)
        check_path(directory, expected)
        return {'state':'already-created', **receipt}
    target_absent(root_fd)
    check_path(directory, expected)
    temp_name = '.dag.yaml.note-app-' + secrets.token_hex(16) + '.tmp'
    temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=root_fd)
    fds.append(temp_fd)
    temp_stat = os.fstat(temp_fd)
    temp_identity = identity(temp_stat)
    if not stat.S_ISREG(temp_stat.st_mode) or temp_stat.st_uid != os.getuid() or temp_stat.st_nlink != 1: refuse('unsafe_path')
    remaining = memoryview(content)
    while remaining:
        written = os.write(temp_fd, remaining)
        if written <= 0: refuse('io_failed')
        remaining = remaining[written:]
    os.fsync(temp_fd)
    check_expected(root_fd, expected)
    check_path(directory, expected)
    temp_named = os.stat(temp_name, dir_fd=root_fd, follow_symlinks=False)
    if identity(temp_named) != temp_identity or not stat.S_ISREG(temp_named.st_mode): refuse('receipt_mismatch')
    # link is one atomic no-replace publication: EEXIST includes dangling symlinks.
    link_attempted = True
    try: os.link(temp_name, TARGET, src_dir_fd=root_fd, dst_dir_fd=root_fd, follow_symlinks=False)
    except FileExistsError:
        link_attempted = False
        refuse('target_exists')
    linked = True
    remove_owned_temp()
    os.fsync(temp_fd)
    os.fsync(root_fd)
    receipt = target_receipt(root_fd, temp_identity, content)
    check_expected(root_fd, expected)
    check_path(directory, expected)
    return {'state':'created', **receipt}

try:
    result = run()
    response = {'ok':True, 'value':result}
except Refusal as error:
    response = {'ok':False, 'code':error.code, 'outcome':'uncertain' if linked or link_attempted else 'not-created'}
except PermissionError:
    response = {'ok':False, 'code':'permission_denied', 'outcome':'uncertain' if linked or link_attempted else 'not-created'}
except OSError as error:
    code = 'unsafe_path' if error.errno in (20,40,62) else 'io_failed'
    response = {'ok':False, 'code':code, 'outcome':'uncertain' if linked or link_attempted else 'not-created'}
except (ValueError, KeyError, TypeError, UnicodeError):
    response = {'ok':False, 'code':'invalid_request', 'outcome':'uncertain' if linked or link_attempted else 'not-created'}
except BaseException:
    response = {'ok':False, 'code':'io_failed', 'outcome':'uncertain' if linked or link_attempted else 'not-created'}
finally:
    try: remove_owned_temp()
    except OSError: pass
    for fd in fds:
        try: os.close(fd)
        except OSError: pass
    if root_fd is not None:
        try: os.close(root_fd)
        except OSError: pass
sys.stdout.buffer.write(json.dumps(response, separators=(',',':')).encode('utf-8') + b'\n')
`;

function validPath(value:unknown):value is string {
  return typeof value==='string'&&value.length>1&&Buffer.byteLength(value,'utf8')<=PROJECT_DAG_LIMITS.path&&path.isAbsolute(value)&&path.resolve(value)===value&&!/[\u0000-\u001f\u007f]/u.test(value)&&Buffer.from(value,'utf8').toString('utf8')===value;
}
function record(value:unknown):value is Record<string,unknown> {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function integer(value:unknown):value is string {return typeof value==='string'&&INTEGER.test(value);}
function safeNumber(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function snapshot(value:unknown):value is ProjectDagDirectorySnapshot {
  return record(value)&&validPath(value.directory)&&integer(value.dev)&&integer(value.ino)&&safeNumber(value.uid)&&safeNumber(value.mode)&&value.mode<=0o7777&&value.targetState==='absent'&&typeof value.inspectedAt==='string';
}
function receiptKey(receipt:ProjectDagWriteReceipt):string {
  return JSON.stringify([receipt.targetPath,receipt.contentHash,receipt.publicationId,receipt.directoryDev,receipt.directoryIno,receipt.targetDev,receipt.targetIno,receipt.targetUid,receipt.targetSize,receipt.targetCtimeNs,receipt.targetMtimeNs,receipt.createdAt]);
}
function validReceipt(value:unknown):value is ProjectDagWriteReceipt {
  return record(value)&&(value.state==='created'||value.state==='already-created')&&validPath(value.targetPath)&&typeof value.contentHash==='string'&&HASH.test(value.contentHash)&&typeof value.publicationId==='string'&&integer(value.directoryDev)&&integer(value.directoryIno)&&integer(value.targetDev)&&integer(value.targetIno)&&safeNumber(value.targetUid)&&safeNumber(value.targetSize)&&value.targetSize<=PROJECT_DAG_LIMITS.contentBytes&&integer(value.targetCtimeNs)&&integer(value.targetMtimeNs)&&typeof value.createdAt==='string';
}

export function createProjectDagWriter(options:{pythonPath:string;now?:()=>number}):ProjectDagWriter {
  if(!options||!validPath(options.pythonPath))throw new ProjectDagWriterError('invalid_configuration');
  const pythonPath=options.pythonPath,now=options.now??Date.now;
  const receipts=new Map<string,string>();let active=false,poisoned:'cleanup_unverified'|'publication_uncertain'|null=null;
  async function run(input:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>> {
    if(poisoned)throw new ProjectDagWriterError(poisoned,'uncertain');
    if(active)throw new ProjectDagWriterError('busy');
    if(signal?.aborted)throw new ProjectDagWriterError('cancelled');
    if(process.platform==='win32')throw new ProjectDagWriterError('unsupported_platform');
    const encoded=Buffer.from(JSON.stringify(input),'utf8');
    if(encoded.length>INPUT_LIMIT)throw new ProjectDagWriterError('content_limit');
    active=true;
    try{return await new Promise<Record<string,unknown>>((resolve,reject)=>{
      const publishing=input.operation==='publish';
      let chunks:Buffer[]=[],outputBytes=0,settled=false,stopped:ProjectDagWriterErrorCode|null=null;
      let cleanup:Promise<boolean>|null=null;
      const child=spawn(pythonPath,['-I','-B','-c',HELPER],{shell:false,windowsHide:true,detached:true,cwd:'/',env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
      const wipe=()=>{chunks.forEach(chunk=>chunk.fill(0));chunks=[];encoded.fill(0);};
      const finish=(error:ProjectDagWriterError|null,value?:Record<string,unknown>)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);wipe();
        if(error){if(error.outcome==='uncertain'&&!poisoned)poisoned='publication_uncertain';reject(error);}else resolve(value!);
      };
      const failure=(code:ProjectDagWriterErrorCode)=>new ProjectDagWriterError(code,publishing&&child.pid!==undefined?'uncertain':'not-created');
      const clean=():Promise<boolean>=>{
        if(cleanup)return cleanup;
        cleanup=finalizeQueryGroup(child).catch(()=>false);
        void cleanup.then(ok=>{if(!ok){poisoned='cleanup_unverified';child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();finish(failure('cleanup_unverified'));}});
        return cleanup;
      };
      const stop=(code:ProjectDagWriterErrorCode)=>{if(stopped||settled)return;stopped=code;child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();void clean().then(ok=>{if(ok)finish(failure(code));});};
      const abort=()=>stop('cancelled');
      const timer=setTimeout(()=>stop('timeout'),PROJECT_DAG_LIMITS.timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      const receive=(chunk:Buffer,retain:boolean)=>{
        if(stopped||settled)return;outputBytes+=chunk.byteLength;
        if(outputBytes>OUTPUT_LIMIT){stop('output_limit');return;}
        if(retain)chunks.push(Buffer.from(chunk));
      };
      child.stdout.on('data',(chunk:Buffer)=>receive(chunk,true));child.stderr.on('data',(chunk:Buffer)=>receive(chunk,false));
      child.stdin.on('error',()=>stop('command_failed'));child.stdout.on('error',()=>stop('command_failed'));child.stderr.on('error',()=>stop('command_failed'));
      child.once('error',()=>stop('command_failed'));
      child.once('exit',()=>{void clean();});
      child.once('close',async(code,termination)=>{
        if(!await clean()||settled||stopped)return;
        if(code!==0||termination!==null){finish(failure('command_failed'));return;}
        try{
          const result:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
          if(!record(result))throw Error('Invalid response');
          if(result.ok===false&&typeof result.code==='string'&&HELPER_CODES.has(result.code as ProjectDagWriterErrorCode)&&(result.outcome==='not-created'||result.outcome==='uncertain')){
            finish(new ProjectDagWriterError(result.code as ProjectDagWriterErrorCode,result.outcome));return;
          }
          if(result.ok!==true||!record(result.value))throw Error('Invalid response');
          finish(null,result.value);
        }catch{finish(failure('command_failed'));}
      });
      if(signal?.aborted)abort();
      if(!stopped)child.stdin.end(encoded);
    });}finally{encoded.fill(0);active=false;}
  }
  return {
    async inspect(directory,signal){
      if(!validPath(directory))throw new ProjectDagWriterError('unsafe_path');
      const value=await run({operation:'inspect',directory},signal);
      const result={...value,inspectedAt:new Date(now()).toISOString()};
      if(!snapshot(result)||result.directory!==directory)throw new ProjectDagWriterError('command_failed');
      return Object.freeze(result);
    },
    async publish(request,signal){
      if(!request||!snapshot(request.directory)||typeof request.publicationId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(request.publicationId)||typeof request.contentHash!=='string'||!HASH.test(request.contentHash))throw new ProjectDagWriterError('invalid_request');
      if(typeof request.content!=='string')throw new ProjectDagWriterError('invalid_content');
      if(!request.content.length||request.content.length>PROJECT_DAG_LIMITS.contentBytes)throw new ProjectDagWriterError('content_limit');
      const content=Buffer.from(request.content,'utf8');
      if(content.toString('utf8')!==request.content)throw new ProjectDagWriterError('invalid_content');
      if(!content.length||content.length>PROJECT_DAG_LIMITS.contentBytes)throw new ProjectDagWriterError('content_limit');
      if(createHash('sha256').update(content).digest('hex')!==request.contentHash)throw new ProjectDagWriterError('invalid_content');
      // Capture immutable main-approved evidence before the asynchronous boundary.
      const directory={...request.directory},publicationId=request.publicationId,contentHash=request.contentHash;
      const previousReceipt=request.previousReceipt===undefined?undefined:{...request.previousReceipt};
      const createdAt=previousReceipt?.createdAt??new Date(now()).toISOString();
      if(previousReceipt!==undefined&&(!validReceipt(previousReceipt)||receipts.get(publicationId)!==receiptKey(previousReceipt)||previousReceipt.publicationId!==publicationId||previousReceipt.contentHash!==contentHash||previousReceipt.directoryDev!==directory.dev||previousReceipt.directoryIno!==directory.ino||previousReceipt.targetPath!==path.join(directory.directory,'dag.yaml')))throw new ProjectDagWriterError('receipt_mismatch');
      if(previousReceipt===undefined&&receipts.has(publicationId))throw new ProjectDagWriterError('receipt_mismatch');
      const value=await run({operation:'publish',directory:directory.directory,expected:{dev:directory.dev,ino:directory.ino,uid:directory.uid,mode:directory.mode},contentBase64:content.toString('base64'),contentHash,publicationId,...(previousReceipt?{previousReceipt}: {})},signal);
      const result={...value,targetPath:path.join(directory.directory,'dag.yaml'),contentHash,publicationId,directoryDev:directory.dev,directoryIno:directory.ino,createdAt};
      if(!validReceipt(result)||result.targetUid!==directory.uid||result.targetSize!==content.length||result.state!==(previousReceipt?'already-created':'created')){poisoned='publication_uncertain';throw new ProjectDagWriterError('command_failed','uncertain');}
      receipts.delete(publicationId);receipts.set(publicationId,receiptKey(result));
      if(receipts.size>RECEIPT_LIMIT)receipts.delete(receipts.keys().next().value!);
      return Object.freeze(result);
    },
  };
}
