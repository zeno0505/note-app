import {_electron as electron} from '@playwright/test';
import {build} from 'esbuild';
import {cp,mkdir,mkdtemp,realpath,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {runNativeFixtureTransactionForTests as install} from '../../scripts/updater/install-transaction.mjs';
import {pathsFor,validateBootAck,validateQuit} from '../../scripts/updater/protocol.mjs';
import {hashAppBundle} from '../../scripts/updater/bundle-integrity.mjs';
if(process.platform!=='darwin')throw Error('Run this native acceptance only on Mac');
const evidence=path.resolve(process.env.NOTE_APP_NATIVE_UPDATE_EVIDENCE??'test-results/native-updater');await mkdir(evidence,{recursive:true,mode:0o700});
const compiled=path.join(evidence,'fixture-entry.cjs');await build({entryPoints:['tests/electron/native-updater-entry.ts'],outfile:compiled,platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24'});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={status:'running',platform:process.platform,compiledFixtureEntrySha256:digest(await readFile(compiled)),cases:[],productionCLIUsed:false,productionTargetChanged:false,modelCalls:0,scope:'signed isolated fixtures; real native installer lifecycle and production host renderer/IPC boot ack; synthetic source preparation'};
const json=async(f,x)=>writeFile(f,JSON.stringify(x)+'\n',{mode:0o600});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function ps(){return execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').flatMap(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return m?[{pid:Number(m[1]),parent:Number(m[2]),exe:m[3]}]:[];});}
async function waitUntil(test,label,ms=15000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(await test())return;await pause(100);}throw Error('Timed out: '+label);}
async function makeApp(bundle,marker,mode,sourceSha,buildNumber){
 await cp(path.resolve('node_modules/electron/dist/Electron.app'),bundle,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
 const root=path.join(bundle,'Contents/Resources/app');await mkdir(root,{mode:0o755});await cp('dist',path.join(root,'dist'),{recursive:true});await cp(compiled,path.join(root,'dist/main/index.cjs'));await rm(path.join(root,'dist/main/index.cjs.map'),{force:true});
 await json(path.join(root,'package.json'),{name:'note-app',version:'0.1.0',sourceSha,updaterProtocolVersion:1,installation:{role:'user',buildNumber},private:true,main:'dist/main/index.cjs',nativeFixture:marker,nativeFixtureMode:mode});
 await rename(path.join(bundle,'Contents/MacOS/Electron'),path.join(bundle,'Contents/MacOS/note-app'));
 const plist=path.join(bundle,'Contents/Info.plist');for(const [k,v] of [['CFBundleExecutable','note-app'],['CFBundleDisplayName','note-app Native Fixture'],['CFBundleName','note-app Native Fixture'],['CFBundleIdentifier','dev.noteapp.local'],['CFBundleShortVersionString','0.1.0'],['CFBundleVersion',buildNumber]])execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${k} ${v}`,plist]);
 execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-','--preserve-metadata=entitlements',bundle],{stdio:'pipe'});execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'pipe'});
}
for(const mode of ['healthy','crash','hang']){
 let home,app,tracker,running;const owned=new Set();const result={mode,status:'running'};
 try{
  home=await realpath(await mkdtemp(path.join(os.tmpdir(),'note-app-native-fixture-')));const marker={kind:'note-app-native-fixture',ownerPid:process.pid,home,token:randomBytes(32).toString('hex')};await json(path.join(home,'native-fixture-owner.json'),marker);
  const id=randomBytes(16).toString('hex'),nonce=randomBytes(32).toString('hex'),p=pathsFor(home,id);await mkdir(p.directory,{recursive:true,mode:0o700});await mkdir(path.dirname(p.canonical),{mode:0o700});await json(path.join(p.root,'owner.json'),{schemaVersion:1,repository:'https://github.com/zeno0505/note-app.git'});
  console.log(mode+': signing owned fixture apps');await makeApp(p.canonical,marker,'current','1'.repeat(40),'1');await makeApp(p.stage,marker,mode,'2'.repeat(40),'2');
  const before=await hashAppBundle(p.canonical),plan={schemaVersion:1,transactionId:id,nonce,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),currentPid:88881,current:{sourceSha:'1'.repeat(40),buildNumber:'1'},target:{sourceSha:'2'.repeat(40),sourceTree:'3'.repeat(40),buildNumber:'2',version:'0.1.0',architecture:process.arch,appSha256:await hashAppBundle(p.stage)}};
  const appRoot=path.join(p.stage,'Contents/Resources/app'),manifest={kind:'local-mac-app',role:'user',bundleId:'dev.noteapp.local',adHocSignatureVerified:true,modelCalls:0,configuration:'external-private-config',...plan.target,entrySha256:digest(await readFile(path.join(appRoot,'dist/main/index.cjs'))),preloadSha256:digest(await readFile(path.join(appRoot,'dist/preload/index.cjs')))};
  await json(p.plan,plan);await json(p.manifest,manifest);await json(path.join(home,'fixture-plan.json'),plan);
  const profileSentinel=path.join(home,'profile-preservation-sentinel');await writeFile(profileSentinel,'owned fictional profile; preserve',{mode:0o600});
  tracker=setInterval(()=>{try{const rows=ps();for(const row of rows)if(row.exe.startsWith(home+path.sep)||owned.has(row.parent))owned.add(row.pid);}catch{}},250);
  app=await electron.launch({executablePath:path.join(p.canonical,'Contents/MacOS/note-app'),chromiumSandbox:true,env:{PATH:process.env.PATH,HOME:os.userInfo().homedir,LANG:'C',LC_ALL:'C'},timeout:30000});owned.add(app.process().pid);const page=await app.firstWindow();await page.getByTestId('nav-overview').waitFor({timeout:30000});
  const runtime=await app.evaluate(({app})=>({home:app.getPath('home'),profile:app.getPath('userData'),pid:process.pid}));assert.equal(runtime.home,home);assert(runtime.profile.startsWith(home+path.sep));result.isolatedRuntime=true;
  plan.currentPid=runtime.pid;await json(p.plan,plan);await json(path.join(home,'fixture-plan.json'),plan);
  running=install({testOnly:true,home,planPath:p.plan,bootTimeoutMs:5000});void running.catch(()=>{});
  await page.getByTestId('nav-settings').click();await page.getByTestId('update-install').click();await page.getByTestId('update-install-confirm').click();
  await pause(1500);result.installUiError=await page.getByTestId('update-error').textContent({timeout:500}).catch(()=>null);
  const outcome=await running;result.outcome=outcome.status;result.quitAcknowledged=validateQuit(JSON.parse(await readFile(p.quit,'utf8')),plan);assert(result.quitAcknowledged);await waitUntil(()=>!ps().some(x=>x.pid===plan.currentPid),'original normal quit');result.originalExited=true;
  const journal=JSON.parse(await readFile(p.journal,'utf8'));result.nativeLaunchedPid=journal.launchedPid;result.receiptPhase=JSON.parse(await readFile(p.receipt,'utf8')).phase;
  if(mode==='healthy'){
   assert.equal(outcome.status,'healthy');assert.equal(await hashAppBundle(p.canonical),plan.target.appSha256);assert.equal(await hashAppBundle(p.backup),before);const ack=JSON.parse(await readFile(p.ack,'utf8'));assert(validateBootAck(ack,plan,journal.launchedPid));result.productionRendererIpcAck=true;
  }else if(mode==='crash'){
   assert.equal(outcome.status,'rolled-back');assert.equal(await hashAppBundle(p.canonical),before);assert.equal(JSON.parse(await readFile(path.join(p.canonical,'Contents/Resources/app/package.json'),'utf8')).sourceSha,plan.current.sourceSha);result.restoredPid=outcome.restoredPid;
  }else{
   assert.equal(outcome.status,'recovery-needed');assert(ps().some(x=>x.pid===journal.launchedPid));assert.equal(await hashAppBundle(p.canonical),plan.target.appSha256);assert.equal(await hashAppBundle(p.backup),before);result.hungWasNotKilled=true;
   await waitUntil(async()=>{try{await lstat(path.join(home,'fixture-started-'+journal.launchedPid));return true;}catch{return false;}},'hung fixture quit control ready');await json(path.join(home,'fixture-quit-'+journal.launchedPid),{pid:journal.launchedPid,token:marker.token});await waitUntil(()=>!ps().some(x=>x.pid===journal.launchedPid),'hung fixture app.quit request');assert((await readFile(path.join(home,'normal-quit.jsonl'),'utf8')).includes(String(journal.launchedPid)));
   const recovery=await install({testOnly:true,home,planPath:p.plan,recovery:true,bootTimeoutMs:5000});assert.equal(recovery.status,'rolled-back');assert.equal(await hashAppBundle(p.canonical),before);result.recoveryAfterNormalQuit=recovery.status;result.restoredPid=recovery.restoredPid;
  }
  assert.equal(await readFile(profileSentinel,'utf8'),'owned fictional profile; preserve');result.profileSentinelPreserved=true;
  for(const file of ['plan.json','quit-ready.json','boot-ack.json','journal.json','receipt.json']){try{const bytes=await readFile(path.join(p.directory,file));await writeFile(path.join(evidence,mode+'-'+file),bytes,{mode:0o600});}catch(e){if(e.code!=='ENOENT')throw e;}}
  result.status='passed';console.log(mode+': '+outcome.status+' verified');
 }catch(error){result.status='failed';result.error=String(error);if(home){try{result.fixtureInstallError=JSON.parse(await readFile(path.join(home,'install-error.json'),'utf8'));}catch{}}console.log(mode+': FAILED '+String(error));}
 finally{
  if(tracker)clearInterval(tracker);
  if(home){try{const rows=ps();for(const row of rows)if(row.exe.startsWith(home+path.sep)||owned.has(row.parent))owned.add(row.pid);const mains=rows.filter(x=>x.exe===path.join(home,'Applications/note-app.app/Contents/MacOS/note-app'));
   for(const main of mains){await waitUntil(async()=>{try{await lstat(path.join(home,'fixture-started-'+main.pid));return true;}catch{return false;}},'owned quit handler ready');const marker=JSON.parse(await readFile(path.join(home,'native-fixture-owner.json'),'utf8'));await json(path.join(home,'fixture-quit-'+main.pid),{pid:main.pid,token:marker.token});}
   await waitUntil(()=>!ps().some(x=>owned.has(x.pid)||x.exe.startsWith(home+path.sep)),'all owned fixture processes exit',20000);if(running)await running.catch(()=>{});result.allOwnedExited=true;try{await cp(path.join(home,'normal-quit.jsonl'),path.join(evidence,mode+'-normal-quit.jsonl'));}catch(e){if(e.code!=='ENOENT')throw e;}await rm(home,{recursive:true,force:true});result.fixtureRemoved=true;}catch(e){result.cleanupError=String(e);result.status='failed';}
  }
  report.cases.push(result);await json(path.join(evidence,'report.json'),report);
 }
 if(result.status!=='passed')break;
}
report.status=report.cases.length===3&&report.cases.every(x=>x.status==='passed')?'passed':'failed';await json(path.join(evidence,'report.json'),report);console.log(JSON.stringify(report));if(report.status!=='passed')process.exitCode=1;
