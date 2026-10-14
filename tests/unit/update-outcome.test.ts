import {afterEach,expect,it,vi} from 'vitest';
import * as integrity from '../../scripts/updater/bundle-integrity.mjs';
import {realpath,mkdtemp,mkdir,writeFile,readFile,rm,cp,rename,symlink,link,chmod} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createUpdateOutcomeStore} from '../../src/main/update-outcome';
import type {InstallationIdentity} from '../../src/main/install-identity';
import {UPDATE_REPOSITORY} from '../../src/main/update/manifest';
import {createOutcomeReceipt,pathsFor,protocolDigest,type InstallPlan,type InstallJournal} from '../../scripts/updater/protocol.mjs';
import {hashAppBundle} from '../../scripts/updater/bundle-integrity.mjs';
const homes:string[]=[];
afterEach(async()=>{await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
const OLD='a'.repeat(40),NEW='b'.repeat(40),ID='c'.repeat(32),NONCE='d'.repeat(64);
const json=async(file:string,value:unknown)=>writeFile(file,JSON.stringify(value)+'\n',{mode:0o600});
const read=async(file:string)=>JSON.parse(await readFile(file,'utf8'));
async function fixture({intent=true}:{intent?:boolean}={}){
  const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'note-outcome-')));homes.push(home);
  const p=pathsFor(home,ID);await mkdir(p.directory,{recursive:true,mode:0o700});await mkdir(path.dirname(p.canonical),{mode:0o755});
  const makeApp=async(bundle:string,sourceSha:string,buildNumber:string,version:string)=>{
    const app=path.join(bundle,'Contents','Resources','app');await mkdir(app,{recursive:true,mode:0o755});
    await json(path.join(app,'package.json'),{name:'note-app',main:'dist/main/index.cjs',sourceSha,version,updaterProtocolVersion:1,installation:{role:'user',buildNumber}});
    await writeFile(path.join(app,'app.cjs'),sourceSha,{mode:0o644});
  };
  await makeApp(p.canonical,OLD,'21','0.1.0');await makeApp(p.stage,NEW,'22','0.2.0');
  await json(path.join(p.root,'owner.json'),{schemaVersion:1,repository:UPDATE_REPOSITORY});
  const originalAppSha256=await hashAppBundle(p.canonical);
  const now=Date.now();
  const plan:InstallPlan={schemaVersion:1,transactionId:ID,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+600000).toISOString(),
    currentPid:process.pid,current:{sourceSha:OLD,buildNumber:'21'},
    target:{sourceSha:NEW,sourceTree:'e'.repeat(40),buildNumber:'22',version:'0.2.0',architecture:'arm64',appSha256:await hashAppBundle(p.stage)},nonce:NONCE};
  await json(p.plan,plan);
  const installation=(target=false):InstallationIdentity=>({role:'user',currentPath:p.canonical,canonicalPath:p.canonical,buildSha:target?NEW:OLD,buildNumber:target?'22':'21'});
  const store=(target=false)=>createUpdateOutcomeStore({home,installation:installation(target),version:target?'0.2.0':'0.1.0'});
  const oldStore=store();if(intent)await oldStore.writePending(plan);
  async function install(){await rm(p.canonical,{recursive:true});await cp(p.stage,p.canonical,{recursive:true});}
  const ack=()=>({schemaVersion:1,transactionId:ID,nonce:NONCE,pid:99991,sourceSha:NEW,buildNumber:'22',version:'0.2.0',appBooted:true});
  const journal=(phase:InstallJournal['phase']):InstallJournal=>({schemaVersion:1,transactionId:ID,phase,updatedAt:new Date().toISOString(),launchedPid:phase==='failed'?null:99991,originalAppSha256,detail:null});
  async function terminal(phase:InstallJournal['phase']='healthy'){
    const value=journal(phase);await json(p.journal,value);await json(p.receipt,createOutcomeReceipt(plan,value));
    if(phase==='healthy')await json(p.ack,ack());return value;
  }
  return {home,p,plan,oldStore,store,installation,install,ack,journal,terminal,pending:path.join(p.root,'pending-outcome.json')};
}

it('reads exact durable success across restart and persists dismissal across further restarts',async()=>{
  const f=await fixture();await f.install();await f.terminal();
  const restarted=f.store(true);expect(await restarted.read({waitMs:0})).toMatchObject({kind:'success',attemptId:ID,targetVersion:'0.2.0'});
  expect(await restarted.dismiss()).toBeNull();expect(await f.store(true).read({waitMs:0})).toBeNull();
  expect((await read(f.pending)).dismissedEvidenceSha256).toBe((await read(f.p.receipt)).receiptSha256);
});
it('only the fixed main-owned pending reference selects a transaction; arbitrary receipt directories do nothing',async()=>{
  const f=await fixture({intent:false});await f.install();await f.terminal();
  expect(await f.store(true).read({waitMs:0})).toBeNull();
});
it('absence of the updater root is read-only and creates no directories',async()=>{
  const f=await fixture();await rm(f.p.root,{recursive:true});expect(await f.store().read({waitMs:0})).toBeNull();
  await expect(readFile(f.pending)).rejects.toMatchObject({code:'ENOENT'});
});
it('binds main intent writer to this process, current build, disk plan and canonical identity',async()=>{
  const f=await fixture({intent:false});
  for(const patch of [{currentPid:process.pid+1},{current:{sourceSha:OLD,buildNumber:'20'}},{nonce:'f'.repeat(64)}]){
    await expect(f.oldStore.writePending({...f.plan,...patch})).rejects.toThrow();
  }
  const store=createUpdateOutcomeStore({home:f.home,installation:{...f.installation(),role:'verification'},version:'0.1.0'});
  await expect(store.writePending(f.plan)).rejects.toThrow();await expect(readFile(f.pending)).rejects.toMatchObject({code:'ENOENT'});
});
it.each(['nonce','target','current','updaterProtocolVersion','planSha256','journalSha256','receiptSha256','schemaVersion','transactionId','updatedAt'])('fails closed for changed receipt %s',async field=>{
  const f=await fixture();await f.install();await f.terminal();const receipt=await read(f.p.receipt);
  receipt[field]=field==='target'?{...receipt.target,sourceTree:'f'.repeat(40)}:field==='current'?{...receipt.current,buildNumber:'20'}:'incorrect';
  await json(f.p.receipt,receipt);expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
});
it('rejects a self-consistent receipt from a different nonce even when its integrity is recalculated',async()=>{
  const f=await fixture();await f.install();const journal=await f.terminal();
  await json(f.p.receipt,createOutcomeReceipt({...f.plan,nonce:'f'.repeat(64)},journal));
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
});
it('rejects changed plan, journal, missing receipt, and partial JSON without deriving success from journal',async()=>{
  for(const file of ['plan','journal','receipt'] as const){
    const f=await fixture();await f.install();await f.terminal();await writeFile(f.p[file],'{');
    expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
  }
  const f=await fixture();await f.install();await f.terminal();await rm(f.p.receipt);
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
});
it.each(['nonce','pid','sourceSha','buildNumber','version','appBooted'])('success requires exact boot acknowledgement %s',async field=>{
  const f=await fixture();await f.install();await f.terminal();const ack:Record<string,unknown>=f.ack();ack[field]='wrong';await json(f.p.ack,ack);
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
});
it('success requires actual installed bytes and app metadata, including protocol and canonical running build',async()=>{
  const f=await fixture();await f.install();await f.terminal();
  expect((await f.store().read({waitMs:0}))?.kind).toBe('unverified');
  await writeFile(path.join(f.p.canonical,'Contents/Resources/app/app.cjs'),'tampered');
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
  await f.install();const file=path.join(f.p.canonical,'Contents/Resources/app/package.json'),meta=await read(file);meta.updaterProtocolVersion=2;await json(file,meta);
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
});
it('accepts exact restored old app whose version differs from the attempted new target',async()=>{
  const f=await fixture();await f.terminal('rolled-back');
  expect(await f.store().read({waitMs:0})).toMatchObject({kind:'rollback',targetVersion:'0.2.0'});
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
});
it('retains a recovery-needed terminal result across restarts without launching recovery itself',async()=>{
  const f=await fixture();await f.install();await f.terminal('recovery-needed');
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('recovery-needed');
});
it('persists installer failure even before a backup digest exists',async()=>{
  const f=await fixture();const journal={...f.journal('failed'),originalAppSha256:null};
  await json(f.p.journal,journal);await json(f.p.receipt,createOutcomeReceipt(f.plan,journal));
  expect((await f.store().read({waitMs:0}))?.kind).toBe('failed');
});
it('main records a spawn failure only for the exact intent it wrote and keeps it dismissible after restart',async()=>{
  const f=await fixture();expect((await f.oldStore.recordFailure())?.kind).toBe('failed');
  const restarted=f.store();expect((await restarted.read({waitMs:0}))?.kind).toBe('failed');
  await restarted.dismiss();expect(await f.store().read({waitMs:0})).toBeNull();
  await expect(restarted.recordFailure()).rejects.toThrow('main intent');
});
it('polls the boot acknowledgement race until journal and durable receipt become terminal',async()=>{
  const f=await fixture();await f.install();await json(f.p.journal,f.journal('launched'));await json(f.p.ack,f.ack());
  const waiting=f.store(true).read({waitMs:1000,pollMs:10});
  await new Promise(resolve=>setTimeout(resolve,40));await f.terminal();
  expect((await waiting)?.kind).toBe('success');
});
it('bounded polling retains pending and abort waits for in-flight local reads to finish',async()=>{
  const f=await fixture();await json(f.p.journal,f.journal('launched'));const before=await readFile(f.pending,'utf8');
  const controller=new AbortController();const waiting=f.store().read({waitMs:60000,pollMs:1000,signal:controller.signal});
  setTimeout(()=>controller.abort(),20);expect((await waiting)?.kind).toBe('unverified');
  expect(await readFile(f.pending,'utf8')).toBe(before);
  expect((await f.store().read({waitMs:20,pollMs:10}))?.kind).toBe('unverified');
});
it('dismissal compares cached evidence: stale unverified UI cannot dismiss newly arrived success',async()=>{
  const f=await fixture();await f.install();const store=f.store(true);expect((await store.read({waitMs:0}))?.kind).toBe('unverified');
  await f.terminal();expect((await store.dismiss())?.kind).toBe('success');
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('success');
});
it('dismissing unverified evidence does not hide a later terminal receipt',async()=>{
  const f=await fixture();await f.install();const store=f.store(true);await store.read({waitMs:0});await store.dismiss();
  expect(await f.store(true).read({waitMs:0})).toBeNull();await f.terminal();
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('success');
});
it('duplicate dismissal is idempotent and cannot select an arbitrary outcome',async()=>{
  const f=await fixture();await f.install();await f.terminal();const store=f.store(true);await store.read({waitMs:0});
  expect(await store.dismiss()).toBeNull();expect(await store.dismiss()).toBeNull();
  expect(await f.store(true).read({waitMs:0})).toBeNull();
});
it.each(['receipt','plan','journal','ack'])('rejects symlinked transaction control %s',async name=>{
  const f=await fixture();await f.install();await f.terminal();const file=f.p[name as 'receipt'];
  await rename(file,file+'.real');await symlink(file+'.real',file);
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
});
it('rejects hard-linked receipt, unsafe file mode, symlinked directories and nonprivate updater ancestors',async()=>{
  const f=await fixture();await f.install();await f.terminal();await link(f.p.receipt,f.p.receipt+'.link');
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');await rm(f.p.receipt+'.link');
  await chmod(f.p.receipt,0o644);expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');await chmod(f.p.receipt,0o600);
  await rename(f.p.directory,f.p.directory+'.real');await symlink(f.p.directory+'.real',f.p.directory);
  expect((await f.store(true).read({waitMs:0}))?.kind).toBe('unverified');
  await chmod(f.p.root,0o755);expect(await f.store(true).read({waitMs:0})).toBeNull();
});
it.each(['pending','owner'])('untrusted %s cannot anchor any receipt',async name=>{
  const f=await fixture();await f.install();await f.terminal();
  const file=name==='pending'?f.pending:path.join(f.p.root,'owner.json');await rename(file,file+'.real');await symlink(file+'.real',file);
  expect(await f.store(true).read({waitMs:0})).toBeNull();
});
it('wrong root repository, pending protocol, or integrity never selects a trusted outcome',async()=>{
  const f=await fixture();await f.install();await f.terminal();
  const original=await read(f.pending);await json(f.pending,{...original,updaterProtocolVersion:2});expect(await f.store(true).read({waitMs:0})).toBeNull();
  await json(f.pending,{...original,planSha256:'e'.repeat(64)});expect(await f.store(true).read({waitMs:0})).toBeNull();
  await json(f.pending,original);await json(path.join(f.p.root,'owner.json'),{schemaVersion:1,repository:'https://example.invalid/wrong'});
  expect(await f.store(true).read({waitMs:0})).toBeNull();
});
it('pending intent digest is canonical and binds all current/target identities and nonce',async()=>{
  const f=await fixture();const value=await read(f.pending);expect(value.planSha256).toBe(protocolDigest(f.plan));
  for(const changed of [{...f.plan,nonce:'f'.repeat(64)},{...f.plan,current:{...f.plan.current,buildNumber:'20'}},{...f.plan,target:{...f.plan.target,sourceTree:'f'.repeat(40)}}]){
    expect(protocolDigest(changed)).not.toBe(value.planSha256);
  }
});

it('pending polling reads metadata without hashing app binaries; terminal verification hashes once',async()=>{
  const f=await fixture();await f.install();await json(f.p.journal,f.journal('launched'));
  const spy=vi.spyOn(integrity,'hashAppBundle');
  try{
    expect((await f.store(true).read({waitMs:25,pollMs:10}))?.kind).toBe('unverified');expect(spy).not.toHaveBeenCalled();
    await f.terminal();expect((await f.store(true).read({waitMs:0}))?.kind).toBe('success');expect(spy).toHaveBeenCalledTimes(1);
  }finally{spy.mockRestore();}
});
it('dismissal of an older attempt cannot hide or mutate a new pending attempt',async()=>{
  const f=await fixture();await f.terminal('failed');await f.oldStore.read({waitMs:0});
  const nextPlan={...f.plan,transactionId:'f'.repeat(32),nonce:'1'.repeat(64)},p=pathsFor(f.home,nextPlan.transactionId);
  await mkdir(p.directory,{mode:0o700});await json(p.plan,nextPlan);await f.store().writePending(nextPlan);
  const before=await readFile(f.pending,'utf8');expect((await f.oldStore.dismiss())?.attemptId).toBe(nextPlan.transactionId);
  expect(await readFile(f.pending,'utf8')).toBe(before);await expect(f.oldStore.recordFailure()).rejects.toThrow('main intent');
});
it('repeated main failure recording preserves prior dismissal of the same failure',async()=>{
  const f=await fixture();await f.oldStore.recordFailure();await f.oldStore.dismiss();
  const before=await read(f.pending);expect(await f.oldStore.recordFailure()).toBeNull();expect(await read(f.pending)).toEqual(before);
});

it.each(['healthy','rolled-back','recovery-needed','failed'] as const)('requires installer lock release before presenting terminal %s',async phase=>{
  const f=await fixture();const target=phase==='healthy'||phase==='recovery-needed';if(target)await f.install();await f.terminal(phase);
  await mkdir(f.p.lock,{mode:0o700});await json(path.join(f.p.lock,'owner.json'),{pid:99991,transactionId:ID});
  const spy=vi.spyOn(integrity,'hashAppBundle');
  try{
    expect((await f.store(target).read({waitMs:20,pollMs:10}))?.kind).toBe('unverified');expect(spy).not.toHaveBeenCalled();
    expect(await read(path.join(f.p.lock,'owner.json'))).toEqual({pid:99991,transactionId:ID});
    await rm(f.p.lock,{recursive:true});
    expect((await f.store(target).read({waitMs:0}))?.kind).toBe(phase==='healthy'?'success':phase==='rolled-back'?'rollback':phase);
  }finally{spy.mockRestore();}
});
it('polls a healthy receipt until the helper releases its lock without deleting the lock itself',async()=>{
  const f=await fixture();await f.install();await f.terminal();await mkdir(f.p.lock,{mode:0o700});
  const waiting=f.store(true).read({waitMs:1000,pollMs:10});
  await new Promise(resolve=>setTimeout(resolve,30));await rm(f.p.lock,{recursive:true});expect((await waiting)?.kind).toBe('success');
});
