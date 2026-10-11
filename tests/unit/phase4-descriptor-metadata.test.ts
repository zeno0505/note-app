import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {finalizeQueryGroup} from '../../src/collector/orca/process-group';
import {createDescriptorMetadataTransport,descriptorMetadataIdentity,DESCRIPTOR_METADATA_LIMITS,type DescriptorMetadataTransport} from '../../src/main/phase4/descriptor-metadata';

vi.mock('node:child_process',async original=>{const actual=await original<typeof import('node:child_process')>();return {...actual,spawn:vi.fn(actual.spawn)};});
vi.mock('../../src/collector/orca/process-group',async original=>{const actual=await original<typeof import('../../src/collector/orca/process-group')>();return {...actual,finalizeQueryGroup:vi.fn(actual.finalizeQueryGroup)};});
const actualSpawn=(await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
const actualFinalize=(await vi.importActual<typeof import('../../src/collector/orca/process-group')>('../../src/collector/orca/process-group')).finalizeQueryGroup;
// Native suites use the interpreter explicitly configured by the test runner.
const trustedPythonPath=process.env.DAG_QUERY_PYTHON||process.env.NOTE_APP_PYTHON||'/usr/bin/python3';
const directories:string[]=[],handles:fs.FileHandle[]=[],transports:DescriptorMetadataTransport[]=[];
beforeEach(()=>{vi.mocked(spawn).mockReset().mockImplementation(actualSpawn);vi.mocked(finalizeQueryGroup).mockReset().mockImplementation(actualFinalize);});
afterEach(async()=>{vi.useRealTimers();for(const transport of transports.splice(0)){transport.dispose();await transport.settle().catch(()=>{});}for(const handle of handles.splice(0))await handle.close().catch(()=>{});for(const directory of directories.splice(0))await fs.rm(directory,{recursive:true,force:true});vi.restoreAllMocks();});
const factory=(config:Partial<Parameters<typeof createDescriptorMetadataTransport>[0]>={})=>{const value=createDescriptorMetadataTransport({pythonPath:trustedPythonPath,...config});transports.push(value);return value;};
async function fixture(){const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'descriptor-metadata-')));directories.push(parent);const root=path.join(parent,'root');await fs.mkdir(root);const handle=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(handle);return {parent,root,handle,request:{rootFd:handle.fd,rootIdentity:descriptorMetadataIdentity(await handle.stat())}};}
const fakeStat={dev:'1',ino:'2',mode:0o100644,nlink:1,size:5,mtimeMs:1000,ctimeMs:1000};
const request={rootFd:12,rootIdentity:'1:3:16877',limit:10};
const answer=()=>({version:1,op:'list',rootIdentity:request.rootIdentity,chain:[],entries:[{name:'safe.md',stat:{...fakeStat}}],partial:false,examinedCount:1});
function childFixture({automaticClose=true,install=true}:{automaticClose?:boolean;install?:boolean}={}){
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),pid:undefined,exitCode:null,signalCode:null,kill:vi.fn(()=>{if(automaticClose)queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true;})});
  if(install){vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);vi.mocked(finalizeQueryGroup).mockImplementation(async target=>{target.kill('SIGKILL');return true;});}
  return {child,emit(value:unknown,code=0){child.stdout.write(typeof value==='string'?value:JSON.stringify(value));child.emit('close',code,null);}};
}

describe('fixed descriptor metadata protocol',()=>{
  it('constructs without IO and uses fixed isolated argv, environment, cwd and fd inheritance',async()=>{
    const f=childFixture(),transport=factory({pythonPath:'/trusted/runtime/python3'});expect(spawn).not.toHaveBeenCalled();
    const pending=transport.list(request),call=vi.mocked(spawn).mock.calls[0]!;
    expect(call[0]).toBe('/trusted/runtime/python3');expect(call[1]?.slice(0,4)).toEqual(['-I','-B','-S','-c']);
    const source=call[1]![4];expect(source).toContain('os.scandir(fd)');expect(source).toContain('dir_fd=fd,follow_symlinks=False');expect(source).not.toMatch(/read\(|exec\(|eval\(|subprocess|socket|urlopen/u);
    expect(JSON.parse(call[1]![5])).toEqual({op:'list',rootIdentity:request.rootIdentity,components:[],expectedDirectories:null,limit:10,name:null});
    expect(call[2]).toEqual({shell:false,windowsHide:true,detached:true,cwd:'/',env:{LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe',12]});
    f.emit(answer());const result=await pending;expect(result.entries[0].stat.isFile()).toBe(true);expect(result.entries[0].stat.isDirectory()).toBe(false);
  });
  it.each([
    ['bad JSON','not json'],['extra field',{...answer(),body:'private'}],['version',{...answer(),version:2}],['wrong operation',{...answer(),op:'stat'}],
    ['wrong root',{...answer(),rootIdentity:'1:4:16877'}],['wrong chain',{...answer(),chain:['1:4:16877']}],['partial type',{...answer(),partial:'yes'}],
    ['traversal',{...answer(),entries:[{name:'../outside.md',stat:fakeStat}]}],['duplicate',{...answer(),entries:[{name:'same.md',stat:fakeStat},{name:'same.md',stat:fakeStat}]}],
    ['negative size',{...answer(),entries:[{name:'safe.md',stat:{...fakeStat,size:-1}}]}],['unsafe integer',{...answer(),entries:[{name:'safe.md',stat:{...fakeStat,nlink:1e20}}]}],
    ['metadata extra field',{...answer(),entries:[{name:'safe.md',stat:{...fakeStat,body:'private'}}]}],['numeric inode',{...answer(),entries:[{name:'safe.md',stat:{...fakeStat,ino:2}}]}],
    ['foreign error',{version:1,error:'PRIVATE path details'}],['excess entries',{...answer(),entries:Array.from({length:11},(_,i)=>({name:`${i}.md`,stat:fakeStat}))}],
    ['undercounted entries',{...answer(),examinedCount:0}],['overbudget count',{...answer(),examinedCount:11}],['fractional count',{...answer(),examinedCount:1.5}],['premature partial',{...answer(),partial:true}],
  ])('rejects malformed %s without raw output disclosure',async(_label,payload)=>{
    const f=childFixture(),pending=factory().list(request);f.emit(payload);await expect(pending).rejects.toMatchObject({code:'invalid_response'});
  });
  it('rejects malformed UTF-8 instead of replacement-decoding it',async()=>{const f=childFixture(),pending=factory().list(request);f.child.stdout.write(Buffer.from([0xff]));f.child.emit('close',0,null);await expect(pending).rejects.toMatchObject({code:'invalid_response'});});
  it.each(['ENOENT','EACCES','EPERM','path_changed','unsupported'])('retains safe helper error %s',async code=>{const f=childFixture(),pending=factory().list(request);f.emit({version:1,error:code});await expect(pending).rejects.toMatchObject({code});});
  it.each([{components:['..']},{components:['a/b']},{components:['a\\b']},{components:Array(25).fill('a')},{expectedDirectories:['1:2:16877']},{limit:0},{limit:5001},{rootFd:-1},{rootIdentity:'malformed'}])('rejects unsafe inputs before spawn: %j',async override=>{await expect(factory().list({...request,...override})).rejects.toMatchObject({code:'invalid_request'});expect(spawn).not.toHaveBeenCalled();});
  it('handles spawn failures and reports no runtime details',async()=>{const f=childFixture(),pending=factory().list(request);f.child.emit('error',Error('/private/path permission detail'));await expect(pending).rejects.toMatchObject({code:'command_failed'});});
  it('caps combined stdout and stderr and rejects late success',async()=>{const f=childFixture(),pending=factory({maxOutputBytes:10}).list(request);f.child.stdout.write('123456');f.child.stderr.write('private');await expect(pending).rejects.toMatchObject({code:'output_limit'});expect(finalizeQueryGroup).toHaveBeenCalledTimes(1);f.emit(answer());});
  it('cancels and waits for process close; parent can settle outstanding ownership',async()=>{
    const f=childFixture({automaticClose:false}),controller=new AbortController(),transport=factory(),pending=transport.list({...request,signal:controller.signal});let returned=false;
    void pending.catch(()=>{returned=true;});controller.abort();await Promise.resolve();await Promise.resolve();expect(returned).toBe(false);expect(finalizeQueryGroup).toHaveBeenCalledTimes(1);
    f.child.emit('close',null,'SIGKILL');await expect(pending).rejects.toMatchObject({code:'cancelled'});await transport.settle();
  });
  it('times out, cleans only its child and never publishes a late result',async()=>{vi.useFakeTimers();const f=childFixture(),pending=factory({timeoutMs:5}).list(request),rejected=expect(pending).rejects.toMatchObject({code:'timeout'});await vi.advanceTimersByTimeAsync(5);await rejected;expect(finalizeQueryGroup).toHaveBeenCalledWith(f.child);f.emit(answer());});
  it('pre-cancel and disposed transport do not start a child',async()=>{const transport=factory();await expect(transport.list({...request,signal:AbortSignal.abort()})).rejects.toMatchObject({code:'cancelled'});transport.dispose();await expect(transport.list(request)).rejects.toMatchObject({code:'cancelled'});expect(spawn).not.toHaveBeenCalled();});
  it('poisons transport after unverifiable cleanup and reports this from settle',async()=>{
    const f=childFixture({automaticClose:false});vi.mocked(finalizeQueryGroup).mockResolvedValue(false);const transport=factory(),pending=transport.list(request);f.child.emit('error',Error('private'));
    await expect(pending).rejects.toMatchObject({code:'cleanup_unverified'});await expect(transport.list(request)).rejects.toMatchObject({code:'cleanup_unverified'});await expect(transport.settle()).rejects.toMatchObject({code:'cleanup_unverified'});expect(spawn).toHaveBeenCalledTimes(1);f.child.emit('close',null,'SIGKILL');
  });
  it('bounds unresolved child ownership even after cancellation starts',async()=>{
    const children:Array<ReturnType<typeof childFixture>['child']>=[];vi.mocked(spawn).mockImplementation(()=>{const f=childFixture({automaticClose:false,install:false});children.push(f.child);return f.child as unknown as ChildProcess;});
    vi.mocked(finalizeQueryGroup).mockImplementation(async target=>{target.kill('SIGKILL');return true;});
    const transport=factory(),pending=Array.from({length:DESCRIPTOR_METADATA_LIMITS.concurrency},()=>transport.list(request));
    const rejected=pending.map(p=>expect(p).rejects.toMatchObject({code:'cancelled'}));
    await expect(transport.list(request)).rejects.toMatchObject({code:'busy'});transport.dispose();
    // Disposal stops new work even while close has not yet arrived.
    await expect(transport.list(request)).rejects.toMatchObject({code:'cancelled'});expect(children).toHaveLength(4);
    for(const child of children)child.emit('close',null,'SIGKILL');await Promise.all(rejected);
  });
});

describe.skipIf(process.platform!=='linux'&&process.platform!=='darwin')('real trusted Python descriptor metadata',()=>{
  it('lists one directory and stats exact targets without returning source bytes or losing main fd/offset',async()=>{
    const f=await fixture(),transport=factory();await fs.mkdir(path.join(f.root,'nested'));await fs.writeFile(path.join(f.root,'문서.md'),'DO_NOT_DISCLOSE_SOURCE_BODY');await fs.writeFile(path.join(f.root,'nested','inside.json'),'{}');
    const one=await transport.list({...f.request,limit:10}),two=await transport.list({...f.request,limit:10});
    expect(one.entries.map(e=>e.name).sort()).toEqual(['nested','문서.md']);expect(two.entries.map(e=>e.name).sort()).toEqual(['nested','문서.md']);expect(JSON.stringify(one)).not.toContain('DO_NOT_DISCLOSE');
    const nested=one.entries.find(e=>e.name==='nested')!.stat,stat=await transport.stat({...f.request,components:['nested'],expectedDirectories:[descriptorMetadataIdentity(nested)],name:'inside.json'});
    expect(stat.isFile()).toBe(true);expect(stat.size).toBe(2);expect(descriptorMetadataIdentity(await f.handle.stat())).toBe(f.request.rootIdentity);
  });
  it('skips unsafe filenames but preserves their safe neighbor and counts skipped names against budget',async()=>{
    const f=await fixture();await fs.writeFile(path.join(f.root,'back\\slash.md'),'unsafe');await fs.writeFile(path.join(f.root,'line\nbreak.md'),'unsafe');await fs.writeFile(path.join(f.root,'safe.md'),'safe');
    const transport=factory(),result=await transport.list({...f.request,limit:10});expect(result.entries.map(e=>e.name)).toEqual(['safe.md']);expect(result.examinedCount).toBe(3);expect((await transport.list({...f.request,limit:1})).partial).toBe(true);
  });
  it('reports bounded enumeration and missing exact names',async()=>{const f=await fixture();await Promise.all(['a.md','b.md','c.md'].map(name=>fs.writeFile(path.join(f.root,name),'')));const transport=factory();expect(await transport.list({...f.request,limit:2})).toMatchObject({partial:true,entries:expect.any(Array)});await expect(transport.stat({...f.request,name:'missing.md'})).rejects.toMatchObject({code:'ENOENT'});});
  it('returns symlink metadata without following final links, including dangling links',async()=>{
    const f=await fixture();await fs.writeFile(path.join(f.parent,'outside.md'),'outside');await fs.symlink(path.join(f.parent,'outside.md'),path.join(f.root,'link.md'));await fs.symlink('/missing-private-target',path.join(f.root,'dangling.md'));
    const transport=factory();expect((await transport.stat({...f.request,name:'link.md'})).isSymbolicLink()).toBe(true);expect((await transport.stat({...f.request,name:'dangling.md'})).isSymbolicLink()).toBe(true);expect((await transport.list({...f.request,limit:10})).entries.every(e=>e.stat.isSymbolicLink())).toBe(true);
  });
  it('fails closed on a substituted relative parent or changed expected inode',async()=>{
    const f=await fixture(),transport=factory(),nested=path.join(f.root,'nested'),outside=path.join(f.parent,'outside');await fs.mkdir(nested);await fs.mkdir(outside);await fs.writeFile(path.join(outside,'outside-name.md'),'outside');
    const expected=descriptorMetadataIdentity(await fs.stat(nested));await fs.rename(nested,nested+'-saved');await fs.symlink(outside,nested);
    await expect(transport.list({...f.request,components:['nested'],expectedDirectories:[expected],limit:10})).rejects.toMatchObject({code:'path_changed'});
    await expect(transport.stat({...f.request,components:['nested'],name:'outside-name.md'})).rejects.toMatchObject({code:'path_changed'});
    await fs.unlink(nested);await fs.mkdir(nested);await expect(transport.list({...f.request,components:['nested'],expectedDirectories:[expected],limit:10})).rejects.toMatchObject({code:'path_changed'});
  });
  it('stays attached to original root across an ordinary-path ancestor symlink swap',async()=>{
    const f=await fixture(),transport=factory();await fs.writeFile(path.join(f.root,'safe.md'),'safe');const outside=await fs.mkdtemp(path.join(os.tmpdir(),'descriptor-outside-'));directories.push(outside);await fs.mkdir(path.join(outside,'root'));await fs.writeFile(path.join(outside,'root','outside-name.md'),'outside');
    const moved=f.parent+'-saved';await fs.rename(f.parent,moved);await fs.symlink(outside,f.parent);
    try{const result=await transport.list({...f.request,limit:10});expect(result.entries.map(e=>e.name)).toEqual(['safe.md']);expect(JSON.stringify(result)).not.toContain('outside-name');await expect(transport.stat({...f.request,name:'outside-name.md'})).rejects.toMatchObject({code:'ENOENT'});}
    finally{await fs.unlink(f.parent);await fs.rename(moved,f.parent);}
  });
  it('rejects a wrong inherited root identity before returning any metadata',async()=>{const f=await fixture();await fs.writeFile(path.join(f.root,'private.md'),'private');await expect(factory().list({...f.request,rootIdentity:'1:2:16877',limit:10})).rejects.toMatchObject({code:'path_changed'});});
  it('terminates a real timed-out helper before settling and preserves the parent descriptor',async()=>{
    const f=await fixture(),transport=factory({timeoutMs:1});let pid:number|undefined;
    vi.mocked(spawn).mockImplementation((...args:Parameters<typeof spawn>)=>{const child=actualSpawn(...args);pid=child.pid;return child;});
    await expect(transport.list({...f.request,limit:10})).rejects.toMatchObject({code:'timeout'});await transport.settle();
    expect(pid).toBeTypeOf('number');expect(()=>process.kill(pid!,0)).toThrow();expect(descriptorMetadataIdentity(await f.handle.stat())).toBe(f.request.rootIdentity);
  });
});
