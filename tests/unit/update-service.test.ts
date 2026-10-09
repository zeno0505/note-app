import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {UpdateState,UpdateOutcome} from '../../src/shared/update';
const mock=vi.hoisted(()=>({prepared:null as any,spawn:vi.fn(),restore:vi.fn(),check:vi.fn(),prepare:vi.fn(),cancel:vi.fn(),defer:vi.fn(),read:vi.fn(),dismiss:vi.fn(),writePending:vi.fn(),recordFailure:vi.fn(),state:null as UpdateState|null,listener:null as null|((state:UpdateState)=>void)}));
vi.mock('../../src/main/update/source-release-updater',()=>({SourceReleaseUpdater:class{
 constructor(options:{onState:(state:UpdateState)=>void}){mock.listener=options.onState;}
 getState(){return structuredClone(mock.state!);}getPrepared(){return mock.prepared;}
 restore(){return mock.restore();}check(){return mock.check();}prepare(){return mock.prepare();}cancel(){return mock.cancel();}defer(){return mock.defer();}
}}));
vi.mock('node:fs/promises',()=>({cp:vi.fn(async()=>{}),realpath:vi.fn(async(file:string)=>file),lstat:vi.fn(async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,isFile:()=>true,mode:0o700}))}));
vi.mock('node:child_process',()=>({spawn:mock.spawn}));
vi.mock('../../src/main/update-files',()=>({privateUpdateDirectory:vi.fn(async()=>{}),writePrivateUpdateJson:vi.fn(async()=>{}),readPrivateUpdateJson:vi.fn(async()=>({}))}));
vi.mock('../../src/main/update-outcome',()=>({createUpdateOutcomeStore:()=>({read:mock.read,dismiss:mock.dismiss,writePending:mock.writePending,recordFailure:mock.recordFailure})}));
import {createUpdateService} from '../../src/main/update-service';
const options={home:'/synthetic-home',installation:{role:'user' as const,currentPath:'/synthetic-home/Applications/note-app.app',canonicalPath:'/synthetic-home/Applications/note-app.app',buildSha:'a'.repeat(40),buildNumber:'23'},version:'0.1.0',installerDirectory:'/not-used',cleanup:async()=>{},requestQuit:()=>{throw Error('No real installation in service tests');}};
const result:UpdateOutcome={attemptId:'a'.repeat(32),kind:'success',targetVersion:'0.1.0',occurredAt:'2026-10-08T10:00:00.000Z'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
beforeEach(()=>{vi.clearAllMocks();mock.prepared=null;mock.state={status:'idle',current:{version:'0.1.0',buildNumber:'23',sourceSha:'a'.repeat(40)},target:null,message:'idle',checkedAt:null,prerequisites:[],canCheck:true,canPrepare:false,canCancel:false,canDefer:false,canInstall:false};mock.restore.mockResolvedValue(mock.state);mock.read.mockResolvedValue(null);mock.dismiss.mockResolvedValue(null);mock.cancel.mockResolvedValue(mock.state);mock.defer.mockResolvedValue(mock.state);mock.prepare.mockResolvedValue(null);mock.check.mockImplementation(async()=>{mock.state={...mock.state!,status:'unavailable'};mock.listener?.(mock.state);return mock.state;});});
describe('updater startup integration',()=>{
 it('starts local restoration once without blocking construction or inventing a target',async()=>{let resolve!:()=>void;mock.restore.mockImplementation(()=>new Promise<void>(r=>{resolve=r;}));const service=createUpdateService(options);expect(service.getState().status).toBe('idle');await tick();expect(mock.restore).toHaveBeenCalledTimes(1);const checking=service.check();await tick();expect(mock.check).not.toHaveBeenCalled();resolve();expect((await checking).status).toBe('unavailable');expect(mock.writePending).not.toHaveBeenCalled();await service.settle!();});
 it('keeps validated outcome attached through checks and remembers a noarg dismissal',async()=>{mock.read.mockResolvedValue(result);const service=createUpdateService(options);await tick();expect(service.getState().outcome).toEqual(result);expect((await service.check()).outcome).toEqual(result);expect((await service.dismissOutcome()).outcome).toBeNull();expect(mock.dismiss).toHaveBeenCalledWith();expect(mock.writePending).not.toHaveBeenCalled();await service.settle!();});
 it('graceful quit cancels receipt polling and waits for its owned IO',async()=>{let stopped=false;mock.read.mockImplementation(({signal}:{signal:AbortSignal})=>new Promise(resolve=>{const finish=()=>{setImmediate(()=>{stopped=true;resolve(null);});};if(signal.aborted)finish();else signal.addEventListener('abort',finish,{once:true});}));const service=createUpdateService(options);await tick();await service.settle!();expect(stopped).toBe(true);expect(mock.cancel).toHaveBeenCalledTimes(1);});
 it('normal quit drains a pending dismissal and rejects new updater actions',async()=>{let finish!:()=>void,done=false;mock.dismiss.mockImplementation(()=>new Promise<null>(resolve=>{finish=()=>{done=true;resolve(null);};}));const service=createUpdateService(options);await tick();const dismissing=service.dismissOutcome(),duplicate=service.dismissOutcome();await tick();expect(mock.dismiss).toHaveBeenCalledTimes(1);let settled=false;const stopping=service.settle!().then(()=>{settled=true;});await tick();expect(settled).toBe(false);finish();await Promise.all([dismissing,duplicate,stopping]);expect(done).toBe(true);await service.check();expect(mock.check).not.toHaveBeenCalled();});
 it('source errors and receipt read errors cannot enable install',async()=>{mock.restore.mockRejectedValue(Error('unsafe source'));mock.read.mockRejectedValue(Error('unsafe receipt'));const service=createUpdateService(options);await tick();expect(service.getState()).toMatchObject({status:'error',canInstall:false,outcome:null});await service.settle!();});
 it('does not spawn an installer if release authority expires while the pending intent is written',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
  Object.defineProperty(process,'platform',{...descriptor,value:'darwin'});
  try{
    mock.prepared={target:{sourceSha:'b'.repeat(40),buildNumber:'24',version:'0.1.0'},sourceTree:'c'.repeat(40),architecture:'arm64',appSha256:'d'.repeat(64),appPath:'/synthetic/app',packageManifestPath:'/synthetic/manifest',nodeExecutable:'/usr/local/bin/node'};
    mock.writePending.mockImplementation(async()=>{mock.prepared=null;});mock.recordFailure.mockResolvedValue(null);
    const service=createUpdateService(options);await tick();expect((await service.install()).status).toBe('error');expect(mock.spawn).not.toHaveBeenCalled();expect(mock.recordFailure).toHaveBeenCalledTimes(1);await service.settle!();
  }finally{Object.defineProperty(process,'platform',descriptor);}
 });

});
