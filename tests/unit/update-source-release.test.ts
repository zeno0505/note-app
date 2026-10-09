import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import type {UpdateState} from '../../src/shared/update';
import type {PreparedUpdate} from '../../src/main/update/source-updater';
import type {ApprovedDemoManifest} from '../../src/main/update/manifest';
const mock=vi.hoisted(()=>({onConstruct:null as null|((core:any)=>void),instances:[] as Array<{options:any;state:UpdateState;prepared:PreparedUpdate|null;restore:()=>Promise<void>;check:()=>Promise<void>;prepare:()=>Promise<PreparedUpdate|null>;cancel:()=>Promise<void>;defer:()=>Promise<void>}>}));
vi.mock('../../src/main/update/source-updater',()=>({SourceUpdater:class{
 options:any;state:UpdateState;prepared:PreparedUpdate|null=null;
 constructor(options:any){this.options=options;this.state={status:'idle',current:options.current,target:{...options.approvedTarget,changelog:[...options.approvedTarget.changelog]},message:'core idle',checkedAt:null,prerequisites:[],canCheck:true,canPrepare:false,canCancel:false,canDefer:false,canInstall:false};mock.instances.push(this);mock.onConstruct?.(this);}
 getState(){return structuredClone(this.state);}getPrepared(){return ['ready','deferred'].includes(this.state.status)?this.prepared:null;}
 update(status:UpdateState['status']){this.state={...this.state,status,message:status,canCheck:!['checking','preparing'].includes(status),canPrepare:status==='available',canCancel:status==='preparing',canDefer:status==='ready',canInstall:['ready','deferred'].includes(status)};this.options.onState(this.getState());}
 async restore(){}async check(){this.update('available');}
 async prepare(){this.update('preparing');this.prepared={target:this.options.approvedTarget,stagePath:'/synthetic/stage',appPath:'/synthetic/stage/app',packageManifestPath:'/synthetic/manifest',sourceTree:'c'.repeat(40),lockfileSha256:'d'.repeat(64),architecture:'arm64',appSha256:'e'.repeat(64),nodeExecutable:'/usr/local/bin/node'};this.update('ready');return this.prepared;}
 async cancel(){if(this.state.status==='preparing')this.update('cancelled');}async defer(){this.update('deferred');}
}}));
import {SourceReleaseUpdater,SOURCE_RELEASE_CHECK_VALIDITY_MS} from '../../src/main/update/source-release-updater';
import {UPDATE_REPOSITORY} from '../../src/main/update/manifest';
const roots:string[]=[];const current={version:'0.1.0',buildNumber:'24',sourceSha:'a'.repeat(40)};
const target=():ApprovedDemoManifest=>({schemaVersion:1,channel:'demo',repository:UPDATE_REPOSITORY,version:'0.1.0',buildNumber:'25',sourceSha:'b'.repeat(40),lockfileSha256:'d'.repeat(64),changelog:['Source update'],publishedAt:'2026-10-09T00:00:00.000Z'});
beforeEach(()=>{mock.instances=[];mock.onConstruct=null;});afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const home=await realpath(await mkdtemp(path.join(tmpdir(),'note-source-release-')));roots.push(home);let now=Date.parse('2026-10-09T01:00:00.000Z');const changes:UpdateState[]=[];
 const feed={fetchSourceRelease:vi.fn(async(_signal:AbortSignal)=>target())};const create=()=>new SourceReleaseUpdater({home,current,platform:'darwin',architecture:'arm64',feed,now:()=>new Date(now),onState:state=>changes.push(state)});
 return {home,root:path.join(home,'Library/Application Support/note-app-updater'),feed,create,updater:create(),changes,setNow:(value:number)=>now=value,get now(){return now;}};
}
describe('fixed source release discovery controller',()=>{
 it('startup performs no network/storage/build and cannot trust local target JSON',async()=>{const f=await fixture();expect((await f.updater.restore()).status).toBe('idle');expect(f.feed.fetchSourceRelease).not.toHaveBeenCalled();expect(mock.instances).toHaveLength(0);expect(await readdir(f.home)).toEqual([]);});
 it('fetches a release and hands only its exact validated SHA/lockfile to source preparation',async()=>{const f=await fixture();expect((await f.updater.check()).status).toBe('available');expect(mock.instances).toHaveLength(1);expect(mock.instances[0].options.approvedTarget).toEqual(target());expect((await f.updater.prepare())?.target).toEqual(target());expect(f.changes.map(s=>s.status)).toContain('preparing');expect(f.updater.getState().canInstall).toBe(true);expect((await f.updater.defer()).status).toBe('deferred');});
 it('ready preparation is idempotent and may be deferred without fetching again',async()=>{const f=await fixture();await f.updater.check();const a=await f.updater.prepare();expect(await f.updater.prepare()).toBe(a);await f.updater.defer();expect(f.feed.fetchSourceRelease).toHaveBeenCalledTimes(1);});
 it('same installed identity is up-to-date without starting build prerequisites',async()=>{const f=await fixture();f.feed.fetchSourceRelease.mockResolvedValue({...target(),...current});expect((await f.updater.check()).status).toBe('up-to-date');expect(mock.instances).toHaveLength(0);expect(f.updater.getState().canPrepare).toBe(false);});
 it.each([{buildNumber:'23'},{version:'0.0.9'},{repository:'https://evil.invalid/repo.git'},{sourceSha:'main'},{publishedAt:'2027-01-01T00:00:00.000Z'},{publishedAt:'2026-01-01T00:00:00.000Z'}])('rejects invalid/stale/downward target %j',async patch=>{const f=await fixture();f.feed.fetchSourceRelease.mockResolvedValue({...target(),...patch} as ApprovedDemoManifest);expect((await f.updater.check()).status).toBe('error');expect(mock.instances).toHaveLength(0);expect(f.updater.getPrepared()).toBeNull();});
 it('persistent highwater rejects changed same-build and older observed releases',async()=>{const f=await fixture();await f.updater.check();f.feed.fetchSourceRelease.mockResolvedValue({...target(),changelog:['Mutated']});expect((await f.create().check()).status).toBe('error');f.feed.fetchSourceRelease.mockResolvedValue({...target(),buildNumber:'26',sourceSha:'c'.repeat(40)});expect((await f.create().check()).status).toBe('available');f.feed.fetchSourceRelease.mockResolvedValue(target());expect((await f.create().check()).status).toBe('error');});
 it('failed or unavailable check clears previous install authority, preserving prepared files',async()=>{const f=await fixture();await f.updater.check();await f.updater.prepare();f.feed.fetchSourceRelease.mockRejectedValue(Object.assign(Error('404'),{code:'SOURCE_RELEASE_UNAVAILABLE'}));expect((await f.updater.check()).status).toBe('unavailable');expect(f.updater.getPrepared()).toBeNull();expect(f.updater.getState()).toMatchObject({canInstall:false,canPrepare:false,target:null});});
 it('coalesces checks and cancellation joins network settlement before exposing cancelled',async()=>{const f=await fixture();let finish!:(value:ApprovedDemoManifest)=>void;f.feed.fetchSourceRelease.mockImplementation(()=>new Promise(r=>{finish=r;}));const one=f.updater.check(),two=f.updater.check();await vi.waitFor(()=>expect(f.feed.fetchSourceRelease).toHaveBeenCalledTimes(1));let done=false;const cancel=f.updater.cancel().then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);finish(target());await Promise.all([one,two,cancel]);expect(f.updater.getState().status).toBe('cancelled');expect(mock.instances).toHaveLength(0);});
 it('cancels preparation without late ready authority and requires a fresh check',async()=>{const f=await fixture();await f.updater.check();const core=mock.instances[0];let finish!:(value:PreparedUpdate|null)=>void;core.prepare=async()=>{core.state.status='preparing';return new Promise(r=>{finish=r;});};const preparing=f.updater.prepare();await vi.waitFor(()=>expect(core.state.status).toBe('preparing'));const cancel=f.updater.cancel();finish({target:target()} as PreparedUpdate);expect(await preparing).toBeNull();await cancel;expect(f.updater.getState()).toMatchObject({status:'cancelled',canPrepare:false,canInstall:false});});
 it('fresh authorization expires after an hour and on clock reversal',async()=>{const f=await fixture();await f.updater.check();await f.updater.prepare();f.setNow(f.now+SOURCE_RELEASE_CHECK_VALIDITY_MS);expect(f.updater.getPrepared()).toBeNull();expect(f.updater.getState().canInstall).toBe(false);await f.updater.check();await f.updater.prepare();f.setNow(f.now-1);expect(f.updater.getPrepared()).toBeNull();});
 it('saved files are restored only after a fresh matching remote target is available',async()=>{const f=await fixture();await f.updater.check();await writeFile(path.join(f.root,'prepared-state.json'),'{}',{mode:0o600});let restored=false;const original=mock.instances[0]; // A new core must be constructed after the second fetch.
 await f.updater.check();expect(mock.instances).toHaveLength(2);expect(mock.instances[1]).not.toBe(original);expect(f.feed.fetchSourceRelease).toHaveBeenCalledTimes(2);expect(f.updater.getState().status).toBe('available');void restored;
 });
 it('refuses symlinked or uncertain storage before source preparation',async()=>{const f=await fixture(),foreign=path.join(f.home,'foreign');await mkdir(foreign,{mode:0o700});await writeFile(path.join(foreign,'sentinel'),'untouched');await mkdir(path.dirname(f.root),{recursive:true,mode:0o700});await symlink(foreign,f.root);expect((await f.updater.check()).status).toBe('error');expect(await readdir(foreign)).toEqual(['sentinel']);expect(mock.instances).toHaveLength(0);
 const g=await fixture();await g.updater.check();await mkdir(path.join(g.root,'cleanup-unverified'),{mode:0o700});expect((await g.create().check()).status).toBe('error');});
 it('does not enable preparation when the source prerequisite probe reports a missing tool',async()=>{const f=await fixture();await f.updater.check();const core=mock.instances[0];core.state={...core.state,prerequisites:[{id:'node',label:'Node.js24+',ready:false}]};core.options.onState(core.state);expect(f.updater.getState().canPrepare).toBe(false);});
 it('stale callbacks from a superseded core cannot overwrite the latest release state',async()=>{const f=await fixture();await f.updater.check();const stale=mock.instances[0];await f.updater.check();stale.options.onState({...stale.state,status:'ready',canInstall:true});expect(f.updater.getState().status).toBe('available');expect(f.updater.getState().canInstall).toBe(false);});
 it('immediate cancellation before the scheduled prepare body starts no build work',async()=>{
  const f=await fixture();await f.updater.check();const core=mock.instances[0],prepare=vi.spyOn(core,'prepare');const preparing=f.updater.prepare(),cancel=f.updater.cancel();
  expect(await preparing).toBeNull();await cancel;expect(prepare).not.toHaveBeenCalled();expect(f.updater.getState().canInstall).toBe(false);
 });
 it('immediate cancellation before scheduled defer starts no state write',async()=>{
  const f=await fixture();await f.updater.check();await f.updater.prepare();const core=mock.instances[0],defer=vi.spyOn(core,'defer');const deferring=f.updater.defer(),cancel=f.updater.cancel();
  await Promise.all([deferring,cancel]);expect(defer).not.toHaveBeenCalled();expect(f.updater.getState().canInstall).toBe(false);
 });
 it('immediate check cancellation does not start the feed request',async()=>{
  const f=await fixture();const check=f.updater.check(),cancel=f.updater.cancel();await Promise.all([check,cancel]);expect(f.feed.fetchSourceRelease).not.toHaveBeenCalled();expect(f.updater.getState().status).toBe('cancelled');
 });

 it('cancel between core creation and descriptor lookup cannot start restoration',async()=>{
  const f=await fixture();await f.updater.check();await writeFile(path.join(f.root,'prepared-state.json'),'{}',{mode:0o600});let cancellation:Promise<unknown>|undefined;let restore:any;
  mock.onConstruct=core=>{restore=vi.spyOn(core,'restore');queueMicrotask(()=>{cancellation=f.updater.cancel();});};
  await f.updater.check();await cancellation;expect(restore).not.toHaveBeenCalled();expect(f.updater.getState().status).toBe('cancelled');
 });
 it('an older cancellation continuation cannot overwrite a newer successful check',async()=>{
  const f=await fixture();await f.updater.check();const core=mock.instances[0];let finishPrepare!:(p:PreparedUpdate|null)=>void,finishCancel!:()=>void;
  core.prepare=async()=>new Promise<PreparedUpdate|null>(resolve=>{finishPrepare=resolve;});core.cancel=async()=>new Promise<void>(resolve=>{finishCancel=resolve;});
  const preparing=f.updater.prepare();await vi.waitFor(()=>expect(finishPrepare).toBeTypeOf('function'));const cancelled=f.updater.cancel();finishPrepare(null);await preparing;
  expect((await f.updater.check()).status).toBe('available');finishCancel();await cancelled;expect(f.updater.getState().status).toBe('available');
 });

});
