import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as processGroup from '../../src/collector/orca/process-group';
import {createOrcaProjectOpener,ORCA_PROJECT_OPEN_VERSION,parseOrcaProjectOpenResponse,type OrcaProjectOpenSelection} from '../../src/main/orca-project-open';
import {createOrcaRunner} from '../../src/collector/orca/runner';
import {createUpdateCleanupGate} from '../../src/main/update-cleanup';

// Sanitized source-contract fixtures, not captured private Mac output. A real
// temporary executable verifies the dispatch/lifecycle contract on this platform.
const rootDirectories:string[]=[];
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((done,failed)=>{resolve=done;reject=failed;});
  return {promise,resolve,reject};
}
const binding:OrcaProjectOpenSelection={hostId:'synthetic-local',worktreeId:'synthetic-repo::/synthetic/tree',worktreePath:'/synthetic/tree',dagPath:'/synthetic/tree/docs/note/dag.yaml',runtimeId:'synthetic-runtime'};
const response=(change?:(value:any)=>void)=>{
  const value={id:'synthetic-request',ok:true,_meta:{runtimeId:binding.runtimeId},result:{worktree:binding.worktreeId,relativePath:'docs/note/dag.yaml',kind:'text',opened:true}};
  change?.(value);return JSON.stringify(value);
};
const parse=(raw:string)=>parseOrcaProjectOpenResponse(raw,binding,'docs/note/dag.yaml');
const script=String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=__dirname,args=process.argv.slice(2),settings=JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8'));
const query=args[0]==='--version'?'version':args[0]==='status'?'status':'display';
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({args,environment:{orcaOpen:process.env.ORCA_OPEN_COMMAND??null,orcaApp:process.env.ORCA_APP_EXECUTABLE??null,nodeOptions:process.env.NODE_OPTIONS??null}})+'\n');
fs.writeFileSync(path.join(root,'ready-'+query),String(process.pid));
const mode=settings[query+'Mode']??'normal';
if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='stdout-overflow'){process.stdout.write('SYNTHETIC_PRIVATE_CANARY'.repeat(10000));}
else if(mode==='stderr-overflow'){process.stderr.write('SYNTHETIC_PRIVATE_CANARY'.repeat(10000));}
else if(mode==='invalid-json'){process.stdout.write('SYNTHETIC_PRIVATE_CANARY');}
else if(mode==='invalid-utf8'){process.stdout.write(Buffer.from([0xc3,0x28]));}
else if(mode==='nonzero'){process.stderr.write('SYNTHETIC_PRIVATE_CANARY');process.exitCode=1;}
else if(query==='version'){process.stdout.write((settings.cliVersion??settings.version)+'\n');}
else {
  if(mode==='descendant'){
    const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    fs.writeFileSync(path.join(root,'descendant-pid'),String(child.pid));child.unref();
  }
  const result=query==='status'?{target:{kind:settings.target??'local'},app:{running:settings.running??true},runtime:{runtimeId:settings.runtimeId,appVersion:settings.version,state:'ready',reachable:true,connectionState:'connected'}}:{worktree:args[5].slice(3),relativePath:path.relative(settings.worktreePath,args[3]).split(path.sep).join('/'),kind:'text',opened:settings.opened??true};
  const envelope={id:'synthetic-request',ok:true,_meta:{runtimeId:settings[query+'Runtime']??settings.runtimeId},result};
  if(query==='display'&&settings.displayRelative)result.relativePath=settings.displayRelative;
  process.stdout.write(JSON.stringify(envelope));
}
`;
async function setup(settings:Record<string,unknown>={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'orca-display-'));rootDirectories.push(directory);
  const worktreePath=await fs.realpath(directory),dagPath=path.join(worktreePath,'docs','note','dag.yaml');
  await fs.mkdir(path.dirname(dagPath),{recursive:true});await fs.writeFile(dagPath,'version: 1\ntasks: []\n');
  const selected:OrcaProjectOpenSelection={...binding,worktreePath,dagPath,worktreeId:'synthetic-repo::'+worktreePath};
  const config={runtimeId:selected.runtimeId,version:ORCA_PROJECT_OPEN_VERSION,worktreePath,...settings};
  await fs.writeFile(path.join(directory,'settings.json'),JSON.stringify(config));
  const executablePath=path.join(directory,'synthetic-orca.cjs');await fs.writeFile(executablePath,`#!${process.execPath}\n${script}`,{mode:0o700});
  const resolve=vi.fn(async()=>({...selected} as OrcaProjectOpenSelection|null));
  const create=(extra:Partial<Parameters<typeof createOrcaProjectOpener<string>>[0]>={})=>createOrcaProjectOpener<string>({executablePath,localHostId:selected.hostId,resolveSelection:resolve,...extra});
  const calls=async()=>{try{return (await fs.readFile(path.join(directory,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch{return [] as any[];}};
  return {directory,executablePath,selected,resolve,create,calls};
}
async function ready(directory:string,query='display'){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){try{return Number(await fs.readFile(path.join(directory,'ready-'+query),'utf8'));}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
  throw Error('Synthetic process did not become ready.');
}
async function expectNotExecuting(pid:number){
  try{process.kill(pid,0);}catch{return;}
  if(process.platform==='linux'){
    let stat:string;try{stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');}catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return;throw error;}
    expect(['Z','X']).toContain(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);return;
  }
  throw Error('Synthetic process still exists.');
}
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await Promise.all(rootDirectories.splice(0).map(directory=>fs.rm(directory,{recursive:true,force:true})));});

describe('source-reviewed Orca 1.4.222 display receipt',()=>{
  it.each(['image','binary','markdown','text'])('accepts only observed %s display kind and strips unrelated envelope fields',kind=>{
    expect(parse(response(value=>{value.result.kind=kind;value.privatePayload='SYNTHETIC_PRIVATE_CANARY';value._meta.extra='SYNTHETIC_PRIVATE_CANARY';}))).toEqual({ok:true,opened:true});
  });
  it.each([
    [(value:any)=>{value._meta.runtimeId='foreign';},'runtime_changed'],
    [(value:any)=>{delete value._meta;},'invalid_schema'],
    [(value:any)=>{value.result.worktree='foreign';},'selection_changed'],
    [(value:any)=>{value.result.worktree={id:binding.worktreeId};},'invalid_schema'],
    [(value:any)=>{value.result.relativePath='../outside.yaml';},'selection_changed'],
    [(value:any)=>{value.result.kind='terminal';},'invalid_schema'],
    [(value:any)=>{value.result.opened=false;},'not_opened'],
    [(value:any)=>{value.result.opened='true';},'invalid_schema'],
    [(value:any)=>{value.result.prompt='SYNTHETIC_PRIVATE_CANARY';},'invalid_schema'],
    [(value:any)=>{delete value.id;},'invalid_schema'],
  ] as const)('fails closed on changed or unverified success %#',(change,reason)=>{
    expect(parse(response(change))).toEqual({ok:false,reason,attempted:true});
  });
  it('bounds direct parser calls and never exposes raw diagnostics',()=>{
    expect(parse('not-json')).toEqual({ok:false,reason:'invalid_json',attempted:true});
    expect(parse('x'.repeat(65537))).toEqual({ok:false,reason:'output_limit',attempted:true});
    expect(parse(JSON.stringify({id:'synthetic-error',ok:false,error:{code:'runtime_access_denied',message:'SYNTHETIC_PRIVATE_CANARY'}}))).toEqual({ok:false,reason:'access_denied',attempted:true});
  });
});

describe('bounded main-only existing-file display capability',()=>{
  it('uses only version/status plus exact full-ID file open and strips execution overrides',async()=>{
    const test=await setup();vi.stubEnv('ORCA_OPEN_COMMAND','SYNTHETIC_PRIVATE_CANARY');vi.stubEnv('ORCA_APP_EXECUTABLE','SYNTHETIC_PRIVATE_CANARY');vi.stubEnv('NODE_OPTIONS','--require /missing-synthetic-module');
    const opener=test.create();expect(await opener.open('opaque-selection')).toEqual({ok:true,opened:true});
    expect(test.resolve).toHaveBeenCalledTimes(3);
    expect((await test.calls()).map(call=>call.args)).toEqual([['--version'],['status','--json'],['file','open','--path',test.selected.dagPath,'--worktree','id:'+test.selected.worktreeId,'--focus','--json']]);
    expect((await test.calls()).every(call=>Object.values(call.environment).every(value=>value===null))).toBe(true);
    expect(opener.cleanupState()).toBe('verified');await expectNotExecuting(await ready(test.directory));
  });
  it.each(['unsupported','1.4.221','1.4.223'])('does not dispatch file open to unaccepted version %s',async version=>{
    const test=await setup({version});expect(await test.create().open('opaque')).toEqual({ok:false,reason:'unsupported_version',attempted:false});expect(await test.calls()).toHaveLength(1);
  });
  it('checks the running app version separately from the configured CLI version',async()=>{
    const test=await setup({cliVersion:ORCA_PROJECT_OPEN_VERSION,version:'1.4.221'});expect(await test.create().open('opaque')).toEqual({ok:false,reason:'unsupported_version',attempted:false});expect(await test.calls()).toHaveLength(2);
  });
  it.each([{target:'remote'},{running:false}])('requires a running local runtime %j',async settings=>{
    const test=await setup(settings);expect(await test.create().open('opaque')).toEqual({ok:false,reason:'unavailable',attempted:false});expect(await test.calls()).toHaveLength(2);
  });
  it('rejects a runtime change before dispatch and an uncertain changed receipt afterward without retry',async()=>{
    const before=await setup({statusRuntime:'foreign'});expect(await before.create().open('opaque')).toEqual({ok:false,reason:'runtime_changed',attempted:false});expect(await before.calls()).toHaveLength(2);
    const after=await setup({displayRuntime:'foreign'});expect(await after.create().open('opaque')).toEqual({ok:false,reason:'runtime_changed',attempted:true});expect(await after.calls()).toHaveLength(3);
  });
  it('requires a current authorized main-owned local selection before any command',async()=>{
    for(const invalid of [null,{...binding,hostId:'foreign'},{...binding,dagPath:'/outside/dag.yaml'},{...binding,dagPath:'relative.yaml'}]){
      const test=await setup();test.resolve.mockResolvedValue(invalid);expect((await test.create().open('opaque')).ok).toBe(false);expect(await test.calls()).toEqual([]);
    }
  });
  it('does not create a missing file or open directories or an external-vault symlink',async()=>{
    const test=await setup();await fs.unlink(test.selected.dagPath);expect((await test.create().open('opaque')).ok).toBe(false);expect(await test.calls()).toEqual([]);await expect(fs.stat(test.selected.dagPath)).rejects.toThrow();
    await fs.mkdir(test.selected.dagPath);expect(await test.create().open('opaque')).toMatchObject({ok:false,reason:'unsafe_path'});await fs.rmdir(test.selected.dagPath);
    const external=await fs.mkdtemp(path.join(os.tmpdir(),'orca-vault-'));rootDirectories.push(external);const target=path.join(external,'dag.yaml');await fs.writeFile(target,'tasks: []');await fs.symlink(target,test.selected.dagPath);
    expect(await test.create().open('opaque')).toEqual({ok:false,reason:'unsafe_path',attempted:false});expect(await test.calls()).toEqual([]);
  });
  it('rechecks selection and physical file identity after the status query',async()=>{
    const changed=await setup();changed.resolve.mockResolvedValueOnce({...changed.selected}).mockResolvedValueOnce({...changed.selected,runtimeId:'changed'});
    expect(await changed.create().open('opaque')).toEqual({ok:false,reason:'selection_changed',attempted:false});expect(await changed.calls()).toHaveLength(2);
    const replaced=await setup();let count=0;replaced.resolve.mockImplementation(async()=>{if(++count===2){await fs.rename(replaced.selected.dagPath,replaced.selected.dagPath+'.old');await fs.writeFile(replaced.selected.dagPath,'changed');}return {...replaced.selected};});
    expect(await replaced.create().open('opaque')).toEqual({ok:false,reason:'selection_changed',attempted:false});expect(await replaced.calls()).toHaveLength(2);
  });
  it('rechecks authorization immediately after the final filesystem proof',async()=>{
    const test=await setup();test.resolve.mockResolvedValueOnce({...test.selected}).mockResolvedValueOnce({...test.selected}).mockResolvedValueOnce(null);
    expect(await test.create().open('opaque')).toEqual({ok:false,reason:'unavailable',attempted:false});expect(await test.calls()).toHaveLength(2);
  });
  it('uses a canonical in-tree symlink target but rejects a symlinked worktree root',async()=>{
    const test=await setup(),target=path.join(test.selected.worktreePath,'real-dag.yaml');await fs.rename(test.selected.dagPath,target);await fs.symlink(target,test.selected.dagPath);
    expect(await test.create().open('opaque')).toEqual({ok:true,opened:true});expect((await test.calls())[2].args[3]).toBe(target);
    const alias=test.directory+'-alias';rootDirectories.push(alias);await fs.symlink(test.directory,alias);test.resolve.mockResolvedValue({...test.selected,worktreePath:alias,dagPath:path.join(alias,'real-dag.yaml'),worktreeId:'synthetic-repo::'+alias});
    expect(await test.create().open('opaque')).toEqual({ok:false,reason:'unsafe_path',attempted:false});expect(await test.calls()).toHaveLength(3);
  });
  it('reports opened false and wrong relative path as failures without leaking raw output',async()=>{
    const unopened=await setup({opened:false});expect(await unopened.create().open('opaque')).toEqual({ok:false,reason:'not_opened',attempted:true});
    const wrong=await setup({displayRelative:'SYNTHETIC_PRIVATE_CANARY'});expect(await wrong.create().open('opaque')).toEqual({ok:false,reason:'selection_changed',attempted:true});
  });
  it.each([['stdout-overflow','output_limit'],['stderr-overflow','output_limit'],['invalid-json','invalid_json'],['invalid-utf8','invalid_json'],['nonzero','command_failed']])('bounds %s and cleans its child',async(displayMode,reason)=>{
    const test=await setup({displayMode});const result=await test.create({maxOutputBytes:2048}).open('opaque');expect(result).toEqual({ok:false,reason,attempted:true});expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_CANARY');await expectNotExecuting(await ready(test.directory));
  });
  it('blocks overlap, cancels active display, waits for cleanup, and permits a later explicit request',async()=>{
    const test=await setup({displayMode:'hang'}),opener=test.create(),pending=opener.open('opaque');const pid=await ready(test.directory);
    expect(opener.cleanupState()).toBe('pending');expect(await opener.open('second')).toEqual({ok:false,reason:'busy',attempted:false});opener.invalidate();
    expect(await pending).toEqual({ok:false,reason:'cancelled',attempted:true});await expectNotExecuting(pid);expect(opener.cleanupState()).toBe('verified');
    const settings=JSON.parse(await fs.readFile(path.join(test.directory,'settings.json'),'utf8'));settings.displayMode='normal';await fs.writeFile(path.join(test.directory,'settings.json'),JSON.stringify(settings));
    expect(await opener.open('explicit-retry')).toEqual({ok:true,opened:true});
    opener.dispose();expect(await opener.open('third')).toEqual({ok:false,reason:'unavailable',attempted:false});
  },10000);
  it('retains a never-settling resolver after a bounded timeout and refuses reuse and update',async()=>{
    const test=await setup();test.resolve.mockImplementation(()=>new Promise(()=>{}));
    const opener=test.create({timeoutMs:20}),gate=createUpdateCleanupGate();
    expect(await gate.track('Orca display',()=>opener.open('opaque'),{fulfilled:result=>result.ok||result.reason!=='cleanup_unverified'})).toEqual({ok:false,reason:'timeout',attempted:false});
    expect(opener.cleanupState()).toBe('pending');expect(await opener.open('again')).toEqual({ok:false,reason:'busy',attempted:false});expect(test.resolve).toHaveBeenCalledTimes(1);
    await expect(gate.settle({timeoutMs:0,verify:()=>[{area:'Orca display',cleanup:opener.cleanupState()}]})).rejects.toMatchObject({reason:'pending',areas:['Orca display']});
    let settled=false;void opener.settle().then(()=>{settled=true;});opener.dispose();await new Promise<void>(resolve=>setImmediate(resolve));
    expect(settled).toBe(false);expect(opener.cleanupState()).toBe('pending');expect(await test.calls()).toEqual([]);
  });
  it.each(['resolve','reject'] as const)('retains a timed-out resolver until its late %s, without late dispatch',async outcome=>{
    const test=await setup(),original=deferred<OrcaProjectOpenSelection>();test.resolve.mockImplementation(()=>original.promise);
    const opener=test.create({timeoutMs:20});expect(await opener.open('opaque')).toEqual({ok:false,reason:'timeout',attempted:false});
    expect(opener.cleanupState()).toBe('pending');expect(await opener.open('again')).toEqual({ok:false,reason:'busy',attempted:false});
    let settled=false;const cleanup=opener.settle().then(()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));expect(settled).toBe(false);
    if(outcome==='resolve')original.resolve({...test.selected});else original.reject(Error('SYNTHETIC_PRIVATE_CANARY'));
    await cleanup;expect(settled).toBe(true);expect(opener.cleanupState()).toBe('verified');expect(await test.calls()).toEqual([]);
    test.resolve.mockResolvedValue(null);expect(await opener.open('new-explicit-request')).toEqual({ok:false,reason:'unavailable',attempted:false});expect(test.resolve).toHaveBeenCalledTimes(2);
  });
  it.each(['invalidate','dispose'] as const)('retains an unabortable filesystem read after %s until actual settlement',async action=>{
    const test=await setup(),original=deferred<string>(),entered=deferred<void>();
    const realpath=vi.spyOn(fs,'realpath').mockImplementationOnce(()=>{entered.resolve();return original.promise;});
    const opener=test.create(),pending=opener.open('opaque');await entered.promise;opener[action]();
    expect(await pending).toEqual({ok:false,reason:'cancelled',attempted:false});expect(opener.cleanupState()).toBe('pending');
    expect(await opener.open('again')).toEqual({ok:false,reason:action==='dispose'?'unavailable':'busy',attempted:false});
    let settled=false;const cleanup=opener.settle().then(()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));expect(settled).toBe(false);
    original.resolve(test.selected.worktreePath);await cleanup;realpath.mockRestore();expect(opener.cleanupState()).toBe('verified');expect(await test.calls()).toEqual([]);
  });
  it.each(['invalidate','dispose'] as const)('retains an unabortable main resolver after %s until actual settlement',async action=>{
    const test=await setup(),original=deferred<OrcaProjectOpenSelection>(),entered=deferred<void>();test.resolve.mockImplementation(()=>{entered.resolve();return original.promise;});
    const opener=test.create(),pending=opener.open('opaque');await entered.promise;const cleanup=opener.settle();opener[action]();
    expect(await pending).toEqual({ok:false,reason:'cancelled',attempted:false});expect(opener.cleanupState()).toBe('pending');
    original.resolve({...test.selected});await cleanup;expect(opener.cleanupState()).toBe('verified');expect(await test.calls()).toEqual([]);
  });
  it('does not dispatch an already cancelled request',async()=>{
    const test=await setup(),controller=new AbortController();controller.abort();expect(await test.create().open('opaque',{signal:controller.signal})).toEqual({ok:false,reason:'cancelled',attempted:false});expect(await test.calls()).toEqual([]);
  });
  it('times out an owned child and handles unavailable executables safely',async()=>{
    const test=await setup({statusMode:'hang'}),opener=test.create({timeoutMs:100});expect(await opener.open('opaque')).toEqual({ok:false,reason:'timeout',attempted:false});expect(opener.cleanupState()).toBe('verified');
    expect(await test.create({executablePath:path.join(test.directory,'missing')}).open('opaque')).toEqual({ok:false,reason:'unavailable',attempted:false});
  });
  it.skipIf(process.platform==='win32')('cleans same-group descendants even after a successful display receipt',async()=>{
    const test=await setup({displayMode:'descendant'});expect(await test.create().open('opaque')).toEqual({ok:true,opened:true});const pid=Number(await fs.readFile(path.join(test.directory,'descendant-pid'),'utf8'));await expectNotExecuting(pid);
  });
  it('poisons reuse when group cleanup cannot be verified',async()=>{
    const test=await setup();vi.spyOn(processGroup,'finalizeQueryGroup').mockResolvedValue(false);const opener=test.create();
    expect(await opener.open('opaque')).toEqual({ok:false,reason:'cleanup_unverified',attempted:false});expect(opener.cleanupState()).toBe('unverified');
    expect(await opener.open('again')).toEqual({ok:false,reason:'cleanup_unverified',attempted:false});expect(await test.calls()).toHaveLength(1);
  });
  it('rejects generic configuration and keeps the read-only collector allowlist unchanged',async()=>{
    const test=await setup();for(const executablePath of ['orca','node script','/tmp/new\nline'])expect(()=>test.create({executablePath})).toThrow('trusted absolute path');
    for(const extra of [{timeoutMs:0},{timeoutMs:30001},{maxOutputBytes:65537}])expect(()=>test.create(extra)).toThrow('limit');
    expect(await createOrcaRunner({executablePath:test.executablePath}).read('file open' as never)).toMatchObject({ok:false,error:{kind:'forbidden_query'}});expect(await test.calls()).toEqual([]);
  });
});
