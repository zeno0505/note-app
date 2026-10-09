import test from 'node:test';
import assert from 'node:assert/strict';
import {realpath,mkdtemp,mkdir,writeFile,readFile,rm,chmod,rename,symlink,cp,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {hashAppBundle} from '../../scripts/updater/bundle-integrity.mjs';
import {pathsFor,validatePlan,validateBootAck,validateOutcomeReceipt,protocolDigest} from '../../scripts/updater/protocol.mjs';
import {runInstallTransaction,runTransactionForTests} from '../../scripts/updater/install-transaction.mjs';
const json=async(p,v)=>writeFile(p,JSON.stringify(v),{mode:0o600});
const sha=s=>createHash('sha256').update(s).digest('hex');
const OLD='a'.repeat(40),NEW='b'.repeat(40),TREE='c'.repeat(40),ID='d'.repeat(32),NONCE='e'.repeat(64);
async function fixture(t,{mode='healthy',quit=true,currentAlive=false}={}) {
  const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'note-app-install-test-')));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const p=pathsFor(home,ID);
  await mkdir(p.directory,{recursive:true,mode:0o700});await mkdir(path.dirname(p.canonical),{mode:0o755});
  async function makeApp(root,sourceSha,buildNumber) {
    const app=path.join(root,'Contents','Resources','app');
    await mkdir(path.join(app,'dist','main'),{recursive:true,mode:0o755});
    await mkdir(path.join(app,'dist','preload'),{mode:0o755});await mkdir(path.join(root,'Contents','MacOS'),{mode:0o755});
    await writeFile(path.join(app,'dist','main','index.cjs'),'main-'+sourceSha);
    await writeFile(path.join(app,'dist','preload','index.cjs'),'preload-'+sourceSha);
    await writeFile(path.join(root,'Contents','MacOS','note-app'),'fake executable',{mode:0o755});
    await json(path.join(root,'Contents','Info.plist'),{bundleId:'dev.noteapp.local',buildNumber,version:'0.1.0'});
    await json(path.join(app,'package.json'),{name:'note-app',version:'0.1.0',sourceSha,updaterProtocolVersion:1,installation:{role:'user',buildNumber},main:'dist/main/index.cjs'});
  }
  await makeApp(p.canonical,OLD,'1');await makeApp(p.stage,NEW,'2');
  let time=Date.parse('2026-10-08T09:00:00.000Z');
  const plan={schemaVersion:1,transactionId:ID,createdAt:new Date(time).toISOString(),expiresAt:new Date(time+600000).toISOString(),
    currentPid:88881,current:{sourceSha:OLD,buildNumber:'1'},target:{sourceSha:NEW,sourceTree:TREE,buildNumber:'2',version:'0.1.0',architecture:'arm64',appSha256:await hashAppBundle(p.stage)},nonce:NONCE};
  const manifest={kind:'local-mac-app',sourceSha:NEW,sourceTree:TREE,role:'user',bundleId:'dev.noteapp.local',buildNumber:'2',version:'0.1.0',architecture:'arm64',
    appSha256:plan.target.appSha256,entrySha256:sha('main-'+NEW),preloadSha256:sha('preload-'+NEW),adHocSignatureVerified:true,configuration:'external-private-config',modelCalls:0};
  await json(p.plan,plan);await json(p.manifest,manifest);
  const quitAck={schemaVersion:1,transactionId:ID,nonce:NONCE,currentPid:plan.currentPid,sourceSha:OLD,buildNumber:'1',quitSettled:true};
  if(quit)await json(p.quit,quitAck);
  const alive=new Set(currentAlive?[plan.currentPid]:[]),events=[];let onPause;
  const ack=pid=>({schemaVersion:1,transactionId:ID,nonce:NONCE,pid,sourceSha:NEW,buildNumber:'2',version:'0.1.0',appBooted:true});
  const lifecycle={now:()=>time,pause:async ms=>{time+=ms;await onPause?.();},isAlive:async pid=>alive.has(pid),identify:async()=>true,activeAppPids:async()=>[...alive],
    verifySignature:async(bundle,expected)=>{const value=JSON.parse(await readFile(path.join(bundle,'Contents','Info.plist'),'utf8'));assert.equal(value.bundleId,expected.bundleId);assert.equal(value.buildNumber,expected.buildNumber);},
    launch:async(bundle,args)=>{
      const meta=JSON.parse(await readFile(path.join(bundle,'Contents','Resources','app','package.json'),'utf8'));
      events.push({type:'launch',sourceSha:meta.sourceSha,args});
      if(meta.sourceSha===OLD){alive.add(88883);return 88883;}
      if(mode==='launch-failure')throw Error('launch failed');
      const pid=88882;
      if(mode!=='crash')alive.add(pid);
      if(mode==='healthy')await json(p.ack,ack(pid));
      if(mode==='wrong-ack')await json(p.ack,{...ack(pid),nonce:'f'.repeat(64)});
      return pid;
    }};
  const run=(extra={})=>runTransactionForTests({testOnly:true,home,planPath:p.plan,lifecycle,quitTimeoutMs:400,bootTimeoutMs:400,...extra});
  const current=async()=>JSON.parse(await readFile(path.join(p.canonical,'Contents','Resources','app','package.json'),'utf8'));
  return {home,p,plan,manifest,quitAck,ack,run,current,events,alive,lifecycle,setPause:fn=>onPause=fn,advance:ms=>time+=ms};
}

test('healthy update verifies exact boot identity, retains old backup and leaves profile unchanged',async t=>{
  const f=await fixture(t);const profile=path.join(f.home,'Library','Application Support','note-app');
  await mkdir(profile,{mode:0o700});await writeFile(path.join(profile,'private-profile'),'untouched');
  const result=await f.run();assert.equal(result.status,'healthy');assert.equal((await f.current()).sourceSha,NEW);
  assert.equal(JSON.parse(await readFile(path.join(f.p.backup,'Contents','Resources','app','package.json'),'utf8')).sourceSha,OLD);
  assert.equal(await readFile(path.join(profile,'private-profile'),'utf8'),'untouched');
  assert.deepEqual(f.events[0].args,[`--note-app-update-transaction=${ID}`,`--note-app-update-nonce=${NONCE}`]);
});
test('launch failure restores exact previous bundle and relaunches previous app',async t=>{
  const f=await fixture(t,{mode:'launch-failure'});const before=await hashAppBundle(f.p.canonical);
  assert.equal((await f.run()).status,'rolled-back');assert.equal(await hashAppBundle(f.p.canonical),before);
  assert.equal(f.events.at(-1).sourceSha,OLD);
});
test('core app crash without acknowledgement rolls back',async t=>{
  const f=await fixture(t,{mode:'crash'});assert.equal((await f.run()).status,'rolled-back');assert.equal((await f.current()).sourceSha,OLD);
});
test('live hung app is never killed or overwritten; explicit recovery after quit restores backup',async t=>{
  const f=await fixture(t,{mode:'hang'});assert.equal((await f.run()).status,'recovery-needed');assert.equal((await f.current()).sourceSha,NEW);
  assert.equal(f.alive.has(88882),true);f.alive.delete(88882);f.advance(1000000);
  assert.equal((await f.run({recovery:true})).status,'rolled-back');assert.equal((await f.current()).sourceSha,OLD);
});
test('wrong nonce cannot acknowledge health or discard backup',async t=>{
  const f=await fixture(t,{mode:'wrong-ack'});assert.equal((await f.run()).status,'recovery-needed');assert.ok(await lstat(f.p.backup));
});
test('an acknowledgement is solely app-core boot, independent of collector/TCC/DAG availability',async t=>{
  const f=await fixture(t);f.lifecycle.collectorStatus='failed';f.lifecycle.orcaStatus='failed';f.lifecycle.codeburnStatus='failed';
  f.lifecycle.tccStatus='denied';f.lifecycle.dagStatus='unavailable';assert.equal((await f.run()).status,'healthy');
});
test('without settled quit acknowledgement, even process exit cannot replace app',async t=>{
  const f=await fixture(t,{quit:false});await assert.rejects(f.run(),/Graceful app exit/);assert.equal((await f.current()).sourceSha,OLD);assert.equal(f.events.length,0);
});
test('settled acknowledgement still waits for process to actually exit',async t=>{
  const f=await fixture(t,{currentAlive:true});await assert.rejects(f.run(),/Graceful app exit/);assert.equal((await f.current()).sourceSha,OLD);
});
test('wait accepts confirmed settled quit followed by actual exit',async t=>{
  const f=await fixture(t,{currentAlive:true});f.setPause(async()=>f.alive.delete(f.plan.currentPid));assert.equal((await f.run()).status,'healthy');
});
test('an acknowledged process exiting during identity inspection is not mistaken for PID reuse',async t=>{
  const f=await fixture(t,{currentAlive:true});let inspections=0;
  f.lifecycle.identify=async()=>{if(++inspections===2){f.alive.delete(f.plan.currentPid);return false;}return true;};
  assert.equal((await f.run()).status,'healthy');
});
test('a still-live process with changed identity remains rejected',async t=>{
  const f=await fixture(t,{currentAlive:true});let inspections=0;
  f.lifecycle.identify=async()=>++inspections===1;
  await assert.rejects(f.run(),/Original process identity changed/);
  assert.equal((await f.current()).sourceSha,OLD);
});
test('tampered stage fails before old app is moved',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.p.stage,'Contents','MacOS','note-app'),'tampered');
  await assert.rejects(f.run(),/Bundle integrity/);assert.equal((await f.current()).sourceSha,OLD);
});
test('verification identity can never be installed as canonical',async t=>{
  const f=await fixture(t);f.manifest.role='verification';await json(f.p.manifest,f.manifest);
  await assert.rejects(f.run(),/provenance/);assert.equal((await f.current()).sourceSha,OLD);
});
test('exact target source tree, full SHA, version and digest are bound',async t=>{
  for(const key of ['sourceSha','sourceTree','version','appSha256']) {
    const f=await fixture(t);f.manifest[key]='incorrect';await json(f.p.manifest,f.manifest);
    await assert.rejects(f.run(),/provenance mismatch/);assert.equal((await f.current()).sourceSha,OLD);
  }
});
test('unknown paths and fields, traversal, stale plan, and downgrade are rejected',async t=>{
  const f=await fixture(t);
  assert.throws(()=>validatePlan({...f.plan,canonical:'/tmp/other'},f.lifecycle.now()),/fields/);
  assert.throws(()=>validatePlan({...f.plan,expiresAt:f.plan.createdAt},f.lifecycle.now()),/stale/);
  assert.throws(()=>validatePlan({...f.plan,target:{...f.plan.target,buildNumber:'1'}},f.lifecycle.now()),/identity/);
  await assert.rejects(f.run({planPath:f.p.directory+'/../'+ID+'/plan.json'}),/plan path/);
  f.advance(700000);await assert.rejects(f.run(),/stale/);assert.equal((await f.current()).sourceSha,OLD);
});
test('symlinked controls and escaping bundle symlinks are refused',async t=>{
  const f=await fixture(t);await rename(f.p.plan,f.p.plan+'.real');await symlink(f.p.plan+'.real',f.p.plan);
  await assert.rejects(f.run(),/Symlink/);
  const g=await fixture(t);await symlink('/etc/passwd',path.join(g.p.stage,'evil'));
  await assert.rejects(g.run(),/bundle link/i);assert.equal((await g.current()).sourceSha,OLD);
});
test('safe internal framework links are hashed by target and path',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.p.stage,'Contents','Frameworks'));
  await writeFile(path.join(f.p.stage,'Contents','Frameworks','actual'),'framework');
  await symlink('actual',path.join(f.p.stage,'Contents','Frameworks','current'));
  assert.notEqual(await hashAppBundle(f.p.stage),f.plan.target.appSha256);
});
test('public-writable plan and updater directories are refused',async t=>{
  const f=await fixture(t);await chmod(f.p.plan,0o644);await assert.rejects(f.run(),/permissions/);
  await chmod(f.p.plan,0o600);await chmod(f.p.root,0o755);await assert.rejects(f.run(),/permissions/);
});
test('singleflight rejects simultaneous transaction without changing app',async t=>{
  const f=await fixture(t);await mkdir(f.p.lock,{mode:0o700});await json(path.join(f.p.lock,'owner.json'),{pid:88889,transactionId:ID});
  await assert.rejects(f.run(),/active/);assert.equal((await f.current()).sourceSha,OLD);
});
test('already used plans cannot be replayed after successful installation',async t=>{
  const f=await fixture(t);await f.run();await assert.rejects(f.run(),/already used/);assert.equal((await f.current()).sourceSha,NEW);
});
test('boot acknowledgement requires exact process, full SHA, build and version',async t=>{
  const f=await fixture(t);for(const patch of [{pid:111},{sourceSha:OLD},{buildNumber:'1'},{version:'0.2.0'},{nonce:'f'.repeat(64)}]) {
    assert.equal(validateBootAck({...f.ack(88882),...patch},f.plan,88882),false);
  }
  assert.throws(()=>validateBootAck({...f.ack(88882),collectorHealthy:true},f.plan,88882),/fields/);
});
test('production entry cannot install on Linux; isolated test seam rejects a real home and CLI bypass',async()=>{
  if(process.platform!=='darwin')await assert.rejects(runInstallTransaction('/tmp/plan.json'),/only on macOS/);
  await assert.rejects(runTransactionForTests({testOnly:true,home:os.homedir(),lifecycle:{}}),/Unsafe test/);
  assert.throws(()=>execFileSync(process.execPath,['scripts/update-installer.mjs','--plan','/tmp/plan.json','--platform','darwin'],{encoding:'utf8',stdio:'pipe'}));
});

test('recovery cannot replace a live app even if crash lost its launched PID journal entry',async t=>{
  const f=await fixture(t,{mode:'hang'});await f.run();
  const journal=JSON.parse(await readFile(f.p.journal,'utf8'));journal.phase='installed';journal.launchedPid=null;await json(f.p.journal,journal);
  assert.equal((await f.run({recovery:true})).status,'recovery-needed');assert.equal((await f.current()).sourceSha,NEW);
  f.alive.clear();assert.equal((await f.run({recovery:true})).status,'rolled-back');
});
test('recovery verifies backup bytes before restoring them',async t=>{
  const f=await fixture(t,{mode:'hang'});await f.run();f.alive.clear();
  await writeFile(path.join(f.p.backup,'Contents','MacOS','note-app'),'tampered');
  await assert.rejects(f.run({recovery:true}),/backup integrity/);assert.equal((await f.current()).sourceSha,NEW);
});
test('an unrelated canonical instance appearing during exit blocks replacement',async t=>{
  const f=await fixture(t);f.alive.add(77777);
  await assert.rejects(f.run(),/still running/);assert.equal((await f.current()).sourceSha,OLD);
});
test('PID reuse cannot satisfy original app identity while waiting to quit',async t=>{
  const f=await fixture(t,{currentAlive:true});f.lifecycle.identify=async()=>false;
  await assert.rejects(f.run(),/process identity mismatch/);assert.equal((await f.current()).sourceSha,OLD);
});
test('malformed boot acknowledgement keeps running app and backup recoverable',async t=>{
  const f=await fixture(t,{mode:'hang'});f.setPause(async()=>writeFile(f.p.ack,'bad json',{mode:0o600}));
  assert.equal((await f.run()).status,'recovery-needed');f.alive.clear();assert.equal((await f.run({recovery:true})).status,'rolled-back');
});
test('a symlinked staging bundle cannot reach an unrelated directory',async t=>{
  const f=await fixture(t);await rename(f.p.stage,f.p.stage+'.actual');await symlink(f.p.stage+'.actual',f.p.stage);
  await assert.rejects(f.run(),/Symlink/);assert.equal((await f.current()).sourceSha,OLD);
});
test('non-owner-writable updater ancestors are required',async t=>{
  const f=await fixture(t);await chmod(path.join(f.home,'Library'),0o777);await assert.rejects(f.run(),/permissions/);
  assert.equal((await f.current()).sourceSha,OLD);
});
test('crash recovery can restore after original was backed up but new bundle not renamed yet',async t=>{
  const f=await fixture(t);const originalAppSha256=await hashAppBundle(f.p.canonical);
  await rename(f.p.canonical,f.p.backup);
  await json(f.p.journal,{schemaVersion:1,transactionId:ID,phase:'copied',updatedAt:f.plan.createdAt,launchedPid:null,originalAppSha256,detail:null});
  assert.equal((await f.run({recovery:true})).status,'rolled-back');assert.equal(await hashAppBundle(f.p.canonical),originalAppSha256);
});

test('a canonical process appearing during rollback verification prevents every restore rename',async t=>{
  const f=await fixture(t,{mode:'crash'});const originalVerify=f.lifecycle.verifySignature;
  f.lifecycle.verifySignature=async(bundle,expected)=>{
    await originalVerify(bundle,expected);
    if(bundle===f.p.backup)f.alive.add(77777);
  };
  const result=await f.run();assert.equal(result.status,'recovery-needed');
  assert.equal((await f.current()).sourceSha,NEW);assert.ok(await lstat(f.p.backup));
  assert.equal(f.events.some(event=>event.sourceSha===OLD),false);
});
test('a canonical process appearing during target rollback verification prevents replacement',async t=>{
  const f=await fixture(t,{mode:'crash'});const originalVerify=f.lifecycle.verifySignature;
  let backupVerified=false;
  f.lifecycle.verifySignature=async(bundle,expected)=>{
    await originalVerify(bundle,expected);
    if(bundle===f.p.backup)backupVerified=true;
    if(backupVerified&&bundle===f.p.canonical)f.alive.add(77777);
  };
  assert.equal((await f.run()).status,'recovery-needed');assert.equal((await f.current()).sourceSha,NEW);
  assert.ok(await lstat(f.p.backup));
});
test('liveness is checked again after old-bundle hashing before the first swap',async t=>{
  const f=await fixture(t);let checks=0;
  f.lifecycle.activeAppPids=async()=>{checks++;if(checks===2)f.alive.add(77777);return [...f.alive];};
  await assert.rejects(f.run(),/still running/);assert.equal((await f.current()).sourceSha,OLD);
  assert.equal(f.events.length,0);
});
test('restored launch carries a distinct exact recovery challenge',async t=>{
  const f=await fixture(t,{mode:'crash'});assert.equal((await f.run()).status,'rolled-back');
  assert.deepEqual(f.events.at(-1).args,[`--note-app-recovery-transaction=${ID}`,`--note-app-recovery-nonce=${NONCE}`]);
});
test('a baseline without the startup interlock requires a separate bootstrap install',async t=>{
  const f=await fixture(t);const file=path.join(f.p.canonical,'Contents','Resources','app','package.json');
  const metadata=JSON.parse(await readFile(file,'utf8'));delete metadata.updaterProtocolVersion;await json(file,metadata);
  await assert.rejects(f.run(),/identity mismatch/);assert.equal((await f.current()).sourceSha,OLD);
  assert.equal(f.events.length,0);
});
test('a target without the startup interlock is never installed',async t=>{
  const f=await fixture(t);const file=path.join(f.p.stage,'Contents','Resources','app','package.json');
  const metadata=JSON.parse(await readFile(file,'utf8'));delete metadata.updaterProtocolVersion;await json(file,metadata);
  await assert.rejects(f.run(),/identity mismatch/);assert.equal((await f.current()).sourceSha,OLD);
});

test('increasing build number cannot bypass an application-version downgrade',async t=>{
  const f=await fixture(t);const file=path.join(f.p.canonical,'Contents','Resources','app','package.json');
  const metadata=JSON.parse(await readFile(file,'utf8'));metadata.version='0.2.0';await json(file,metadata);
  await assert.rejects(f.run(),/version downgrade/);assert.equal((await f.current()).sourceSha,OLD);
  assert.equal(f.events.length,0);
});
test('unverified current semantic version fails closed before replacement',async t=>{
  const f=await fixture(t);const file=path.join(f.p.canonical,'Contents','Resources','app','package.json');
  const metadata=JSON.parse(await readFile(file,'utf8'));metadata.version='unknown';await json(file,metadata);
  await assert.rejects(f.run(),/Invalid application version/);assert.equal((await f.current()).sourceSha,OLD);
  assert.equal(f.events.length,0);
});


test('healthy, rollback, recovery-needed and failed receipts are durable and bound to the exact plan and journal',async t=>{
  for(const [mode,phase] of [['healthy','healthy'],['crash','rolled-back'],['hang','recovery-needed'],['healthy','failed']]) {
    const f=await fixture(t,{mode,quit:phase!=='failed'});
    if(phase==='failed')await assert.rejects(f.run(),/Graceful app exit/);else await f.run();
    const journal=JSON.parse(await readFile(f.p.journal,'utf8')),receipt=JSON.parse(await readFile(f.p.receipt,'utf8'));
    assert.equal(receipt.phase,phase);assert.equal(receipt.nonce,NONCE);assert.equal(receipt.updaterProtocolVersion,1);
    assert.equal(receipt.planSha256,protocolDigest(f.plan));assert.equal(receipt.journalSha256,protocolDigest(journal));
    assert.deepEqual(receipt.current,f.plan.current);assert.deepEqual(receipt.target,f.plan.target);
    assert.equal(validateOutcomeReceipt(receipt,f.plan,journal),receipt);assert.equal((await lstat(f.p.receipt)).mode&0o077,0);
    assert.throws(()=>validateOutcomeReceipt({...receipt,nonce:'f'.repeat(64)},f.plan,journal),/does not match/);
    assert.throws(()=>validateOutcomeReceipt({...receipt,updaterProtocolVersion:2},f.plan,journal),/does not match/);
  }
});
test('early stage failure writes a failed receipt without claiming a backup or success',async t=>{
  const f=await fixture(t);f.manifest.role='verification';await json(f.p.manifest,f.manifest);
  await assert.rejects(f.run(),/provenance/);const journal=JSON.parse(await readFile(f.p.journal,'utf8'));
  assert.equal(journal.originalAppSha256,null);assert.equal(journal.phase,'failed');
  const receipt=JSON.parse(await readFile(f.p.receipt,'utf8'));assert.equal(receipt.phase,'failed');validateOutcomeReceipt(receipt,f.plan,journal);
});
test('a replay does not replace a previously healthy receipt with a failure receipt',async t=>{
  const f=await fixture(t);await f.run();const before=await readFile(f.p.receipt,'utf8');
  await assert.rejects(f.run(),/already used/);assert.equal(await readFile(f.p.receipt,'utf8'),before);
});
test('recovery repairs receipt interrupted after healthy journal only after exact bundle and ack verification',async t=>{
  const f=await fixture(t);await f.run();await rm(f.p.receipt);f.alive.clear();
  assert.equal((await f.run({recovery:true})).status,'healthy');assert.equal(JSON.parse(await readFile(f.p.receipt,'utf8')).phase,'healthy');
  await rm(f.p.receipt);await json(f.p.ack,{...f.ack(88882),nonce:'f'.repeat(64)});
  await assert.rejects(f.run({recovery:true}),/boot acknowledgement/);await assert.rejects(lstat(f.p.receipt),{code:'ENOENT'});
});

test('a lock-release failure retains the interlock even after a durable healthy receipt',async t=>{
  const f=await fixture(t),launch=f.lifecycle.launch;
  f.lifecycle.launch=async(...args)=>{const pid=await launch(...args);await chmod(f.p.lock,0o755);return pid;};
  await assert.rejects(f.run(),/permissions/);
  assert.equal(JSON.parse(await readFile(f.p.receipt,'utf8')).phase,'healthy');
  assert.equal((await lstat(f.p.lock)).isDirectory(),true);assert.equal((await f.current()).sourceSha,NEW);
  // The post-restart reader must wait for verified helper cleanup; it never removes this lock.
});
