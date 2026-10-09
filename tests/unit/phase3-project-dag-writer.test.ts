import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod,link,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,stat,symlink,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectDagWriter,ProjectDagWriterError,type ProjectDagDirectorySnapshot} from '../../src/main/project-dag-writer';

const pythonPath='/usr/bin/python3',at=Date.parse('2026-10-08T12:00:00.000Z');
const content='{"schema":2,"legacy":false,"project":{"repo":"synthetic-저장소"},"rounds":[],"phases":[]}\n';
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'phase3-dag-writer-')));roots.push(root);
  const directory=path.join(root,'project');await mkdir(directory,{mode:0o700});
  const writer=createProjectDagWriter({pythonPath,now:()=>at});
  return {root,directory,writer,target:path.join(directory,'dag.yaml')};
}
const request=(directory:ProjectDagDirectorySnapshot,publicationId='synthetic-publication')=>({directory,content,contentHash:hash(content),publicationId});
/** Synthetic trusted interpreter wrapper inserts deterministic races in the embedded
 * helper, without adding test hooks or a source-execution option to production. */
async function intercept(root:string,needle:string,replacement:string){
  const executable=path.join(root,'synthetic-python-wrapper');
  await writeFile(executable,`#!${process.execPath}\nconst cp=require('node:child_process');const fs=require('node:fs');const original=process.argv.at(-1);const needle=${JSON.stringify(needle)};if(!original.includes(needle))process.exit(77);const code=original.replace(needle,${JSON.stringify(replacement)});const result=cp.spawnSync(${JSON.stringify(pythonPath)},['-I','-B','-c',code],{input:fs.readFileSync(0),encoding:null,timeout:15000,maxBuffer:1024*1024});if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);process.exit(result.status??78);\n`,{mode:0o700});
  return createProjectDagWriter({pythonPath:executable,now:()=>at});
}

it('rejects non-absolute, unnormalized or control-bearing interpreter configuration',()=>{
  for(const pythonPath of ['python3','./python3','/tmp/../python3','/tmp/python3\n'])expect(()=>createProjectDagWriter({pythonPath})).toThrow(ProjectDagWriterError);
});

describe.skipIf(process.platform==='win32'||!existsSync(pythonPath))('main-only atomic EMPTY DAG writer with synthetic POSIX fixtures',()=>{
  it('inspects without writing and publishes exactly one private UTF-8 dag.yaml',async()=>{
    const f=await fixture(),snapshot=await f.writer.inspect(f.directory);
    expect(snapshot).toMatchObject({directory:f.directory,targetState:'absent',uid:process.getuid!(),inspectedAt:new Date(at).toISOString()});
    expect(Object.isFrozen(snapshot)).toBe(true);expect(await readdir(f.directory)).toEqual([]);
    const receipt=await f.writer.publish(request(snapshot));
    expect(receipt).toMatchObject({state:'created',targetPath:f.target,contentHash:hash(content),directoryDev:snapshot.dev,directoryIno:snapshot.ino,targetSize:Buffer.byteLength(content),createdAt:new Date(at).toISOString()});
    expect(await readFile(f.target,'utf8')).toBe(content);expect(await readdir(f.directory)).toEqual(['dag.yaml']);
    expect((await stat(f.target)).mode&0o777).toBe(0o600);expect((await stat(f.target)).nlink).toBe(1);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('reconciles only a previously issued exact inode, timestamps and bytes',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),input=request(directory),receipt=await f.writer.publish(input);
    const repeated=await f.writer.publish({...input,previousReceipt:structuredClone(receipt)});
    expect(repeated).toEqual({...receipt,state:'already-created'});expect(await readdir(f.directory)).toEqual(['dag.yaml']);
    await expect(f.writer.publish(input)).rejects.toMatchObject({code:'receipt_mismatch',outcome:'not-created'});
    const otherWriter=createProjectDagWriter({pythonPath});
    await expect(otherWriter.publish({...input,previousReceipt:receipt})).rejects.toMatchObject({code:'receipt_mismatch'});
    await expect(f.writer.publish({...input,publicationId:'different',previousReceipt:receipt})).rejects.toMatchObject({code:'receipt_mismatch'});
  });

  it('does not claim an arbitrary pre-existing matching file as owned',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory);await writeFile(f.target,content);
    await expect(f.writer.publish(request(directory))).rejects.toMatchObject({code:'target_exists',outcome:'not-created'});
    await expect(f.writer.inspect(f.directory)).rejects.toMatchObject({code:'target_exists'});
    expect(await readFile(f.target,'utf8')).toBe(content);
  });

  it.each(['file','directory','symlink','dangling-symlink'])('never replaces an existing %s named dag.yaml',async kind=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),outside=path.join(f.root,'outside');
    await writeFile(outside,'untouched');
    if(kind==='file')await writeFile(f.target,'existing');
    else if(kind==='directory')await mkdir(f.target);
    else await symlink(kind==='symlink'?outside:path.join(f.root,'missing'),f.target);
    await expect(f.writer.publish(request(directory))).rejects.toMatchObject({code:'target_exists',outcome:'not-created'});
    expect(await readFile(outside,'utf8')).toBe('untouched');expect(await readdir(f.directory)).toEqual(['dag.yaml']);
    if(kind==='file')expect(await readFile(f.target,'utf8')).toBe('existing');
  });

  it('refuses directory and ancestor symlinks, relative aliases, and unsafe writable ancestors',async()=>{
    const f=await fixture(),alias=path.join(f.root,'alias');await symlink(f.directory,alias);
    await expect(f.writer.inspect(alias)).rejects.toMatchObject({code:'unsafe_path'});
    await expect(f.writer.inspect(path.join(f.root,'alias','nested'))).rejects.toMatchObject({code:'unsafe_path'});
    await expect(f.writer.inspect(f.directory+'/')).rejects.toMatchObject({code:'unsafe_path'});
    await expect(f.writer.inspect(f.root+'/../'+path.basename(f.root)+'/project')).rejects.toMatchObject({code:'unsafe_path'});
    await chmod(f.root,0o777);
    try{await expect(f.writer.inspect(f.directory)).rejects.toMatchObject({code:'unsafe_path'});}
    finally{await chmod(f.root,0o700);}
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('refuses a final directory that loses private write permissions',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory);await chmod(f.directory,0o777);
    try{await expect(f.writer.publish(request(directory))).rejects.toMatchObject({code:'unsafe_path'});}
    finally{await chmod(f.directory,0o700);}
    await chmod(f.directory,0o500);
    try{await expect(f.writer.inspect(f.directory)).rejects.toMatchObject({code:'unsafe_path'});}
    finally{await chmod(f.directory,0o700);}
  });

  it('binds confirmation to the inspected dev/inode and permission identity',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),moved=path.join(f.root,'moved');
    await rename(f.directory,moved);await mkdir(f.directory,{mode:0o700});
    await expect(f.writer.publish(request(directory))).rejects.toMatchObject({code:'directory_changed',outcome:'not-created'});
    expect(await readdir(f.directory)).toEqual([]);expect(await readdir(moved)).toEqual([]);
    const current=await f.writer.inspect(f.directory);await chmod(f.directory,0o750);
    await expect(f.writer.publish(request(current))).rejects.toMatchObject({code:'directory_changed'});
  });

  it('rejects a replacement file even when the approved bytes still match',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),input=request(directory),receipt=await f.writer.publish(input);
    await rename(f.target,path.join(f.directory,'old-owned-file'));await writeFile(f.target,content);
    await expect(f.writer.publish({...input,previousReceipt:receipt})).rejects.toMatchObject({code:'receipt_mismatch'});
    expect(await readFile(f.target,'utf8')).toBe(content);
  });

  it('rejects changed content, timestamps and additional hard links on receipt replay',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),input=request(directory),receipt=await f.writer.publish(input);
    await link(f.target,path.join(f.directory,'other-link'));
    await expect(f.writer.publish({...input,previousReceipt:receipt})).rejects.toMatchObject({code:'receipt_mismatch'});
    await unlink(path.join(f.directory,'other-link'));await writeFile(f.target,content+'changed');
    await expect(f.writer.publish({...input,previousReceipt:receipt})).rejects.toMatchObject({code:'receipt_mismatch'});
    expect(await readFile(f.target,'utf8')).toBe(content+'changed');
  });

  it('validates hash, bounded exact UTF-8 bytes and immutable fixed filename before spawning',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),input=request(directory);
    await expect(f.writer.publish({...input,contentHash:'0'.repeat(64)})).rejects.toMatchObject({code:'invalid_content'});
    await expect(f.writer.publish({...input,content:'\ud800'})).rejects.toMatchObject({code:'invalid_content'});
    await expect(f.writer.publish({...input,content:'a'.repeat(128*1024+1)})).rejects.toMatchObject({code:'content_limit'});
    await expect(f.writer.publish({...input,publicationId:'../other.yaml'})).rejects.toMatchObject({code:'invalid_request'});
    const maximum='a'.repeat(128*1024);await f.writer.publish({...input,content:maximum,contentHash:hash(maximum)});
    expect((await readFile(f.target)).length).toBe(128*1024);expect(await readdir(f.directory)).toEqual(['dag.yaml']);
  });

  it('honors cancellation before any helper starts and fails a missing interpreter safely',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),controller=new AbortController();controller.abort();
    await expect(f.writer.publish(request(directory),controller.signal)).rejects.toMatchObject({code:'cancelled',outcome:'not-created'});
    await expect(createProjectDagWriter({pythonPath:path.join(f.root,'missing-python')}).publish(request(directory))).rejects.toMatchObject({code:'command_failed',outcome:'not-created'});
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('uses atomic no-replace when a competing file appears after the absence check',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory);
    const writer=await intercept(f.root,'    link_attempted = True',"    competitor = os.open(TARGET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=root_fd)\n    os.write(competitor, b'competing file')\n    os.close(competitor)\n    link_attempted = True");
    await expect(writer.publish(request(directory))).rejects.toMatchObject({code:'target_exists',outcome:'not-created'});
    expect(await readFile(f.target,'utf8')).toBe('competing file');expect(await readdir(f.directory)).toEqual(['dag.yaml']);
  });

  it('detects relocation before publication and only cleans its held original directory',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),moved=path.join(f.root,'relocated');
    const writer=await intercept(f.root,'    os.fsync(temp_fd)',`    os.rename(directory, ${JSON.stringify(moved)})\n    os.mkdir(directory, 0o700)\n    os.fsync(temp_fd)`);
    await expect(writer.publish(request(directory))).rejects.toMatchObject({code:'directory_changed',outcome:'not-created'});
    expect(await readdir(f.directory)).toEqual([]);expect(await readdir(moved)).toEqual([]);
  });

  it('reports an uncertain outcome if relocation happens after atomic publication',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),moved=path.join(f.root,'relocated');
    const writer=await intercept(f.root,'    linked = True',`    linked = True\n    os.rename(directory, ${JSON.stringify(moved)})\n    os.mkdir(directory, 0o700)`);
    await expect(writer.publish(request(directory))).rejects.toMatchObject({code:'directory_changed',outcome:'uncertain'});
    expect(await readdir(f.directory)).toEqual([]);expect(await readFile(path.join(moved,'dag.yaml'),'utf8')).toBe(content);
    expect(await readdir(moved)).toEqual(['dag.yaml']);
  });

  it('never unlinks a substituted temporary inode during cleanup',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory);
    const writer=await intercept(f.root,'    temp_named = os.stat(temp_name, dir_fd=root_fd, follow_symlinks=False)',"    os.unlink(temp_name, dir_fd=root_fd)\n    substitute = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=root_fd)\n    os.write(substitute, b'not ours')\n    os.close(substitute)\n    temp_named = os.stat(temp_name, dir_fd=root_fd, follow_symlinks=False)");
    await expect(writer.publish(request(directory))).rejects.toMatchObject({code:'receipt_mismatch',outcome:'not-created'});
    const files=await readdir(f.directory);expect(files).toHaveLength(1);expect(files[0]).toMatch(/^\.dag\.yaml\.note-app-/u);
    expect(await readFile(path.join(f.directory,files[0]),'utf8')).toBe('not ours');
  });

  it('never claims cancellation after spawn means no file was created',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory);
    const writer=await intercept(f.root,"    return {'state':'created', **receipt}","    import time\n    time.sleep(30)\n    return {'state':'created', **receipt}");
    const controller=new AbortController(),publishing=writer.publish(request(directory),controller.signal);
    const deadline=Date.now()+3000;
    while(!existsSync(f.target)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    controller.abort();
    await expect(publishing).rejects.toMatchObject({code:'cancelled',outcome:'uncertain'});
    expect(await readFile(f.target,'utf8')).toBe(content);
    await expect(writer.publish(request(directory,'retry'))).rejects.toMatchObject({code:'publication_uncertain',outcome:'uncertain'});
  });

  it('bounds execution to five seconds and preserves uncertainty after publication',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory);
    const writer=await intercept(f.root,"    return {'state':'created', **receipt}","    import time\n    time.sleep(30)\n    return {'state':'created', **receipt}");
    const started=Date.now();await expect(writer.publish(request(directory))).rejects.toMatchObject({code:'timeout',outcome:'uncertain'});
    expect(Date.now()-started).toBeLessThan(7500);expect(await readFile(f.target,'utf8')).toBe(content);
  },10000);


  it('allows exactly one atomic winner across separate concurrent writer instances',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory),other=createProjectDagWriter({pythonPath});
    const result=await Promise.allSettled([f.writer.publish(request(directory,'one')),other.publish(request(directory,'two'))]);
    expect(result.filter(value=>value.status==='fulfilled')).toHaveLength(1);
    const loser=result.find(value=>value.status==='rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({code:'target_exists',outcome:'not-created'});
    expect(await readFile(f.target,'utf8')).toBe(content);expect(await readdir(f.directory)).toEqual(['dag.yaml']);
  });

  it('serializes helper access without starting an unbounded number of processes',async()=>{
    const f=await fixture(),first=f.writer.inspect(f.directory);
    await expect(f.writer.inspect(f.directory)).rejects.toMatchObject({code:'busy'});
    await expect(first).resolves.toMatchObject({targetState:'absent'});
  });

  it('captures the granted snapshot before a caller mutates its copy',async()=>{
    const f=await fixture(),directory={...await f.writer.inspect(f.directory)},input=request(directory);
    const publishing=f.writer.publish(input);directory.directory=path.join(f.root,'ungranted');directory.ino='0';
    const receipt=await publishing;expect(receipt.targetPath).toBe(f.target);expect(receipt.directoryIno).not.toBe('0');
    expect(await readFile(f.target,'utf8')).toBe(content);
  });

  it('fails honestly if directory durability cannot be established after the link',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory);
    const writer=await intercept(f.root,'    os.fsync(root_fd)',"    raise OSError('synthetic fsync failure')");
    await expect(writer.publish(request(directory))).rejects.toMatchObject({code:'io_failed',outcome:'uncertain'});
    expect(await readFile(f.target,'utf8')).toBe(content);
    await expect(writer.inspect(f.directory)).rejects.toMatchObject({code:'publication_uncertain',outcome:'uncertain'});
    await expect(writer.publish(request(directory,'retry'))).rejects.toMatchObject({code:'publication_uncertain',outcome:'uncertain'});
  });

  it('bounds combined stdout/stderr and never returns a success from noisy helpers',async()=>{
    const f=await fixture(),directory=await f.writer.inspect(f.directory);
    const writer=await intercept(f.root,'    content = base64.b64decode',"    sys.stderr.buffer.write(b'x' * 20000)\n    sys.stderr.buffer.flush()\n    content = base64.b64decode");
    await expect(writer.publish(request(directory))).rejects.toMatchObject({code:'output_limit',outcome:'uncertain'});
  });
});
