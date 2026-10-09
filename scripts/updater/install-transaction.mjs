import {constants} from 'node:fs';
import {cp,lstat,mkdir,open,readFile,realpath,rename,rmdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {hashAppBundle} from './bundle-integrity.mjs';
import {BUNDLE_ID,exactKeys,pathsFor,validatePlan,validateBootAck,validateQuit,DIGEST,OUTCOME_PHASES,createOutcomeReceipt} from './protocol.mjs';
const exec=promisify(execFile);
const phases=['validated','copied','backed-up','installed','launched','healthy','rolled-back','recovery-needed','failed'];
const exists=async p=>{try{await lstat(p);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const uid=()=>process.geteuid?.();

/** No path from a renderer, plan, manifest, argv or configuration is a write target. */
async function safePath(location,{directory=false,privateMode=false}={}) {
  if(!path.isAbsolute(location)||path.resolve(location)!==location)throw Error('Noncanonical filesystem path');
  let cursor=path.parse(location).root;
  const pieces=location.slice(cursor.length).split(path.sep).filter(Boolean);
  for(let i=0;i<pieces.length;i++) {
    cursor=path.join(cursor,pieces[i]);const stat=await lstat(cursor);
    if(stat.isSymbolicLink()||(i<pieces.length-1&&!stat.isDirectory()))throw Error('Symlink or unsafe ancestor');
    if(i===pieces.length-1) {
      if((directory?!stat.isDirectory():!stat.isFile())||stat.uid!==uid()
        ||(stat.mode&(privateMode?0o077:0o022))!==0)throw Error('Unsafe ownership or permissions');
      if(!directory&&stat.nlink!==1)throw Error('Hard-linked control file');
    }
  }
  if(await realpath(location)!==location)throw Error('Aliased filesystem path');
}
async function safeOwnedAncestors(home,location) {
  let cursor=home;await safePath(cursor,{directory:true});
  for(const part of path.relative(home,location).split(path.sep).filter(Boolean)) {
    if(part==='..')throw Error('Path escaped trusted home');
    cursor=path.join(cursor,part);await safePath(cursor,{directory:true});
  }
}
async function readJSON(file,{privateMode=true,max=65536}={}) {
  await safePath(file,{privateMode});const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const s=await handle.stat();
    if(!s.isFile()||s.nlink!==1||s.uid!==uid()||(s.mode&(privateMode?0o077:0o022))!==0||s.size>max)throw Error('Unsafe or oversized control file');
    const buffer=Buffer.alloc(max+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0),after=await handle.stat();
    if(bytesRead!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs)throw Error('Control file changed during read');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)));
  }
  finally{await handle.close();}
}
async function atomicJSON(file,value) {
  await safePath(path.dirname(file),{directory:true,privateMode:true});
  if(await exists(file))await safePath(file,{privateMode:true});
  const temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  const handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
  await rename(temporary,file);
  const directory=await open(path.dirname(file),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
}
async function metadataAt(bundle) {
  await safePath(bundle,{directory:true});
  return readJSON(path.join(bundle,'Contents','Resources','app','package.json'),{privateMode:false,max:16384});
}
async function verifyIdentity(bundle,expected,lifecycle) {
  const metadata=await metadataAt(bundle);
  if(metadata.name!=='note-app'||metadata.sourceSha!==expected.sourceSha||metadata.installation?.role!=='user'
    ||metadata.installation?.buildNumber!==expected.buildNumber||metadata.updaterProtocolVersion!==1||metadata.main!=='dist/main/index.cjs'
    ||(expected.version&&metadata.version!==expected.version))throw Error('Application identity mismatch');
  await lifecycle.verifySignature(bundle,{...expected,bundleId:BUNDLE_ID});
  return metadata;
}
function assertNoVersionDowngrade(currentVersion,targetVersion) {
  const stable=/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
  if(typeof currentVersion!=='string'||typeof targetVersion!=='string'||!stable.test(currentVersion)||!stable.test(targetVersion))throw Error('Invalid application version');
  const current=currentVersion.split('.').map(Number),target=targetVersion.split('.').map(Number);
  for(let index=0;index<3;index++) {
    if(target[index]<current[index])throw Error('Application version downgrade is not permitted');
    if(target[index]>current[index])return;
  }
}
async function verifyStage(p,plan,lifecycle) {
  const m=await readJSON(p.manifest);
  if(m.kind!=='local-mac-app'||m.role!=='user'||m.bundleId!==BUNDLE_ID||m.adHocSignatureVerified!==true||m.modelCalls!==0
    ||!['none','explicit-private-local-config','external-private-config'].includes(m.configuration))throw Error('Untrusted package provenance');
  for(const key of ['sourceSha','sourceTree','buildNumber','version','architecture','appSha256'])if(m[key]!==plan.target[key])throw Error('Package provenance mismatch');
  if(!DIGEST.test(m.entrySha256)||!DIGEST.test(m.preloadSha256))throw Error('Missing entry integrity');
  await verifyIdentity(p.stage,plan.target,lifecycle);
  for(const [relative,expected] of [['main/index.cjs',m.entrySha256],['preload/index.cjs',m.preloadSha256]]) {
    const file=path.join(p.stage,'Contents','Resources','app','dist',relative);
    await safePath(file,{privateMode:false});
    if(createHash('sha256').update(await readFile(file)).digest('hex')!==expected)throw Error('Entry integrity mismatch');
  }
  if(await hashAppBundle(p.stage)!==plan.target.appSha256)throw Error('Bundle integrity mismatch');
}
async function acquireLock(p,lifecycle,recovery) {
  try{await mkdir(p.lock,{mode:0o700});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    await safePath(p.lock,{directory:true,privateMode:true});
    const owner=await readJSON(path.join(p.lock,'owner.json'));
    exactKeys(owner,['pid','transactionId']);
    if(!recovery||!Number.isSafeInteger(owner.pid)||owner.pid<2||owner.transactionId!==path.basename(p.directory)
      ||await lifecycle.isAlive(owner.pid))throw Error('Another installation or recovery is active');
    await unlink(path.join(p.lock,'owner.json'));await rmdir(p.lock);await mkdir(p.lock,{mode:0o700});
  }
  await atomicJSON(path.join(p.lock,'owner.json'),{pid:process.pid,transactionId:path.basename(p.directory)});
  return async()=>{await safePath(p.lock,{directory:true,privateMode:true});await unlink(path.join(p.lock,'owner.json'));await rmdir(p.lock);};
}
async function loadPlan(home,planPath,now,recovery) {
  if(typeof planPath!=='string'||path.resolve(planPath)!==planPath||path.basename(planPath)!=='plan.json')throw Error('Invalid plan path');
  const id=path.basename(path.dirname(planPath)),p=pathsFor(home,id);
  if(p.plan!==planPath)throw Error('Plan outside fixed updater root');
  await safeOwnedAncestors(home,p.root);await safeOwnedAncestors(home,path.dirname(p.canonical));
  await safePath(p.root,{directory:true,privateMode:true});await safePath(path.join(p.root,'transactions'),{directory:true,privateMode:true});
  await safePath(p.directory,{directory:true,privateMode:true});await safePath(path.dirname(p.canonical),{directory:true});
  const plan=validatePlan(await readJSON(p.plan),now,{recovery});
  if(plan.transactionId!==id)throw Error('Transaction directory mismatch');
  return {p,plan};
}
async function waitForExit(plan,p,lifecycle,timeoutMs) {
  const deadline=lifecycle.now()+timeoutMs;
  while(lifecycle.now()<deadline) {
    if(await exists(p.quit)) {
      if(!validateQuit(await readJSON(p.quit),plan))throw Error('Invalid graceful exit acknowledgement');
      if(!await lifecycle.isAlive(plan.currentPid))return;
    }
    // The process may finish its acknowledged quit while ps is inspecting it.
    // An identity mismatch is evidence only while that PID is still alive.
    if(await lifecycle.isAlive(plan.currentPid)&&!await lifecycle.identify(plan.currentPid,p.canonical)
      &&await lifecycle.isAlive(plan.currentPid))throw Error('Original process identity changed');
    await lifecycle.pause(100);
  }
  throw Error('Graceful app exit was not confirmed; installed app unchanged');
}
async function runEngine({home,planPath,lifecycle,recovery=false,quitTimeoutMs=60000,bootTimeoutMs=45000}) {
  const {p,plan}=await loadPlan(home,planPath,lifecycle.now(),recovery);
  const release=await acquireLock(p,lifecycle,recovery);let journal,mayRecordFailure=false;
  const save=async(phase,extra={})=>{
    journal={schemaVersion:1,transactionId:plan.transactionId,phase,updatedAt:new Date(lifecycle.now()).toISOString(),
      launchedPid:journal?.launchedPid??null,originalAppSha256:journal?.originalAppSha256??null,detail:null,...extra};
    await atomicJSON(p.journal,journal);
    if(OUTCOME_PHASES.includes(phase))await atomicJSON(p.receipt,createOutcomeReceipt(plan,journal));
  };
  const recoveryBlocked=async()=>{
    if(await lifecycle.isAlive(plan.currentPid)||(journal?.launchedPid&&await lifecycle.isAlive(journal.launchedPid))||(await lifecycle.activeAppPids(p.canonical)).length>0) {
      await save('recovery-needed',{detail:'launched-app-still-running'});
      return {status:'recovery-needed',reason:'Quit the app before recovery',backup:p.backup};
    }
    return null;
  };
  const assertNoCanonicalProcess=async()=>{
    if(await lifecycle.isAlive(plan.currentPid)||(await lifecycle.activeAppPids(p.canonical)).length>0)throw Error('An installed app process is still running');
  };
  const rollback=async()=>{
    let blocked=await recoveryBlocked();if(blocked)return blocked;
    if(!await exists(p.backup))throw Error('Recovery backup unavailable');
    await verifyIdentity(p.backup,plan.current,lifecycle);
    if(!journal?.originalAppSha256||await hashAppBundle(p.backup)!==journal.originalAppSha256)throw Error('Recovery backup integrity mismatch');
    if(await exists(p.canonical)) {
      await verifyIdentity(p.canonical,plan.target,lifecycle);
      if(await exists(p.rejected))throw Error('Recovery destination already exists');
      // Signature/hash checks are asynchronous: a relaunch may have appeared.
      blocked=await recoveryBlocked();if(blocked)return blocked;
      await rename(p.canonical,p.rejected);
    }
    blocked=await recoveryBlocked();if(blocked)return blocked;
    await rename(p.backup,p.canonical);await save('rolled-back',{detail:'app-boot-failed'});
    const restoredPid=await lifecycle.launch(p.canonical,[`--note-app-recovery-transaction=${plan.transactionId}`,`--note-app-recovery-nonce=${plan.nonce}`]);
    return {status:'rolled-back',restoredPid};
  };
  try {
    if(recovery) {
      journal=await readJSON(p.journal);
      exactKeys(journal,['schemaVersion','transactionId','phase','updatedAt','launchedPid','originalAppSha256','detail']);
      if(journal.schemaVersion!==1||journal.transactionId!==plan.transactionId||!phases.includes(journal.phase)
        ||(journal.launchedPid!==null&&(!Number.isSafeInteger(journal.launchedPid)||journal.launchedPid<2))
        ||!DIGEST.test(journal.originalAppSha256))throw Error('Invalid recovery journal');
      if(journal.phase==='healthy'||journal.phase==='rolled-back'){
        // A crash between the durable journal and receipt may be repaired only
        // after verifying the exact installed bundle again.
        const expected=journal.phase==='healthy'?plan.target:plan.current;
        await verifyIdentity(p.canonical,expected,lifecycle);
        if(await hashAppBundle(p.canonical)!==(journal.phase==='healthy'?plan.target.appSha256:journal.originalAppSha256))throw Error('Installed bundle changed');
        if(journal.phase==='healthy'&&!validateBootAck(await readJSON(p.ack),plan,journal.launchedPid))throw Error('Invalid healthy boot acknowledgement');
        await atomicJSON(p.receipt,createOutcomeReceipt(plan,journal));return {status:journal.phase};
      }
      if(await lifecycle.isAlive(plan.currentPid))throw Error('Original app has not exited');
      let acknowledged=false;
      if(await exists(p.ack)&&journal.launchedPid) {
        try{acknowledged=validateBootAck(await readJSON(p.ack),plan,journal.launchedPid);}catch{}
      }
      if(acknowledged&&await lifecycle.isAlive(journal.launchedPid)&&await lifecycle.identify(journal.launchedPid,p.canonical)) {
        await verifyIdentity(p.canonical,plan.target,lifecycle);
        if(await hashAppBundle(p.canonical)!==plan.target.appSha256)throw Error('Installed bundle changed');
        await save('healthy');return {status:'healthy',backup:p.backup};
      }
      if(!await exists(p.backup))return {status:'unchanged'};
      return await rollback();
    }
    if(await exists(p.journal)||await exists(p.ack)||await exists(p.receipt)||await exists(p.backup)||await exists(p.incoming)||await exists(p.rejected))throw Error('Transaction was already used');
    mayRecordFailure=true;
    const currentMetadata=await verifyIdentity(p.canonical,plan.current,lifecycle);
    assertNoVersionDowngrade(currentMetadata.version,plan.target.version);
    await verifyStage(p,plan,lifecycle);
    if(await lifecycle.isAlive(plan.currentPid)&&!await lifecycle.identify(plan.currentPid,p.canonical)
      &&await lifecycle.isAlive(plan.currentPid))throw Error('Original process identity mismatch');
    await save('validated',{originalAppSha256:await hashAppBundle(p.canonical)});
    await waitForExit(plan,p,lifecycle,quitTimeoutMs);
    validatePlan(plan,lifecycle.now());
    await verifyIdentity(p.canonical,plan.current,lifecycle);await verifyStage(p,plan,lifecycle);
    // Copy fully before moving the running installation; no private profile path is used.
    await cp(p.stage,p.incoming,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
    await verifyIdentity(p.incoming,plan.target,lifecycle);
    if(await hashAppBundle(p.incoming)!==plan.target.appSha256)throw Error('Copied bundle integrity mismatch');
    await save('copied');
    await assertNoCanonicalProcess();
    if(await hashAppBundle(p.canonical)!==journal.originalAppSha256)throw Error('Installed app changed during update');
    // Both bundles require the startup interlock. Repeat process checks after
    // expensive verification and journal writes, immediately before each move.
    await assertNoCanonicalProcess();
    try {
      await rename(p.canonical,p.backup);await save('backed-up');
      await assertNoCanonicalProcess();
      await rename(p.incoming,p.canonical);await save('installed');
    }catch(error){if(await exists(p.backup))await rollback();throw error;}
    let pid;
    try{pid=await lifecycle.launch(p.canonical,[`--note-app-update-transaction=${plan.transactionId}`,`--note-app-update-nonce=${plan.nonce}`]);}
    catch{return await rollback();}
    if(!Number.isSafeInteger(pid)||pid<2)throw Error('Launch did not identify an app process');
    await save('launched',{launchedPid:pid});
    const deadline=lifecycle.now()+bootTimeoutMs;
    while(lifecycle.now()<deadline) {
      if(await exists(p.ack)) {
        let acknowledged=false;try{acknowledged=validateBootAck(await readJSON(p.ack),plan,pid);}catch{}
        if(!acknowledged)return await rollback();
        if(!await lifecycle.isAlive(pid)||!await lifecycle.identify(pid,p.canonical))return await rollback();
        await verifyIdentity(p.canonical,plan.target,lifecycle);
        if(await hashAppBundle(p.canonical)!==plan.target.appSha256)throw Error('Installed bundle changed before acknowledgement');
        await save('healthy');return {status:'healthy',backup:p.backup};
      }
      if(!await lifecycle.isAlive(pid))return await rollback();
      await lifecycle.pause(100);
    }
    return await rollback();
  }catch(error){
    // Preserve rollback/recovery evidence. Never overwrite another attempt or
    // rewrite an untrusted recovery journal merely to report an error.
    if(mayRecordFailure&&!OUTCOME_PHASES.includes(journal?.phase))await save('failed',{detail:'installation-failed'});
    throw error;
  }finally{await release();}
}

function nativeLifecycle() {
  return {
    now:()=>Date.now(),pause:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    isAlive:async pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}},
    activeAppPids:async bundle=>{
      const {stdout}=await exec('/bin/ps',['-axo','pid=,comm='],{timeout:5000,maxBuffer:1024*1024});
      const executable=path.join(bundle,'Contents','MacOS','note-app');
      return stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(.+)$/);return m&&m[2]===executable?[Number(m[1])]:[];});
    },
    identify:async(pid,bundle)=>{
      try{const {stdout}=await exec('/bin/ps',['-p',String(pid),'-o','comm='],{timeout:5000,maxBuffer:8192});return stdout.trim()===path.join(bundle,'Contents','MacOS','note-app');}catch{return false;}
    },
    verifySignature:async(bundle,expected)=>{
      await exec('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{timeout:30000,maxBuffer:16384});
      for(const [key,value] of [['CFBundleIdentifier',BUNDLE_ID],['CFBundleExecutable','note-app'],['CFBundleVersion',expected.buildNumber],...(expected.version?[['CFBundleShortVersionString',expected.version]]:[])]) {
        const {stdout}=await exec('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,path.join(bundle,'Contents','Info.plist')],{timeout:5000,maxBuffer:4096});
        if(stdout.trim()!==value)throw Error('Bundle plist identity mismatch');
      }
    },
    launch:async(bundle,args)=>new Promise((resolve,reject)=>{
      // Start the precise executable, obtain its PID and never resolve via LaunchServices name lookup.
      const child=spawn(path.join(bundle,'Contents','MacOS','note-app'),args,{detached:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
      child.once('error',reject);child.once('spawn',()=>{child.unref();resolve(child.pid);});
    }),
  };
}
export async function runInstallTransaction(planPath,{recovery=false}={}) {
  if(process.platform!=='darwin')throw Error('Installing note-app is supported only on macOS');
  // Resolve the account's OS home, never a caller-controlled HOME install target.
  return runEngine({home:os.userInfo().homedir,planPath,lifecycle:nativeLifecycle(),recovery});
}
/** Internal temporary-filesystem test seam; cannot target a real home or invoke native lifecycle. */
export async function runTransactionForTests(options) {
  const temporaryRoot=await realpath(os.tmpdir());
  if(options.home===os.userInfo().homedir||!options.home.startsWith(temporaryRoot+path.sep)
    ||!options.lifecycle||options.testOnly!==true)throw Error('Unsafe test engine invocation');
  return runEngine(options);
}

/** Native integration only: no production CLI route, caller lifecycle or real home. */
export async function runNativeFixtureTransactionForTests(options) {
  const keys=['testOnly','home','planPath',...(Object.hasOwn(options,'recovery')?['recovery']:[]),...(Object.hasOwn(options,'bootTimeoutMs')?['bootTimeoutMs']:[])];
  exactKeys(options,keys);
  const temporaryRoot=await realpath(os.tmpdir());
  if(options.testOnly!==true||typeof options.home!=='string'||options.home===os.userInfo().homedir
    ||!options.home.startsWith(temporaryRoot+path.sep)||!path.basename(options.home).startsWith('note-app-native-fixture-')
    ||(options.recovery!==undefined&&typeof options.recovery!=='boolean')
    ||(options.bootTimeoutMs!==undefined&&(!Number.isSafeInteger(options.bootTimeoutMs)||options.bootTimeoutMs<1000||options.bootTimeoutMs>45000)))throw Error('Unsafe native fixture invocation');
  await safePath(options.home,{directory:true,privateMode:true});
  const marker=await readJSON(path.join(options.home,'native-fixture-owner.json'));
  exactKeys(marker,['kind','ownerPid','home','token']);
  if(marker.kind!=='note-app-native-fixture'||marker.ownerPid!==process.pid||marker.home!==options.home||!DIGEST.test(marker.token))throw Error('Native fixture ownership mismatch');
  const {p}=await loadPlan(options.home,options.planPath,Date.now(),Boolean(options.recovery));
  const bundles=[p.stage];
  if(!options.recovery||await exists(p.canonical))bundles.push(p.canonical);
  else bundles.push(p.backup);
  for(const bundle of [p.backup,p.incoming,p.rejected])if(await exists(bundle)&&!bundles.includes(bundle))bundles.push(bundle);
  for(const bundle of bundles) {
    const metadata=await metadataAt(bundle),fixture=metadata.nativeFixture;
    exactKeys(fixture,['kind','ownerPid','home','token']);
    if(JSON.stringify(fixture)!==JSON.stringify(marker))throw Error('Application is not this owned native fixture');
  }
  if(process.platform!=='darwin')throw Error('Native fixtures require macOS');
  return runEngine({...options,lifecycle:nativeLifecycle()});
}
