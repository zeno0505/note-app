import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,chmod,writeFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';
const evidence=path.resolve('reviews/evidence');await mkdir(evidence,{recursive:true});
const root=await mkdtemp(path.join(await realpath(tmpdir()),'note-app-cache-'));await chmod(root,0o700);const identity=await lstat(root);
let app;const results={};const checks=[];const processRuns=[];let report;
async function launch(phase){app=await electron.launch({chromiumSandbox:true,args:[path.resolve('dist/electron-tests/cache-main.cjs')],env:{...process.env,NOTE_APP_CACHE_TEST_ROOT:root,NOTE_APP_CACHE_TEST_PHASE:phase},timeout:30000});const page=await app.firstWindow();await page.getByRole('heading',{name:'Historical approval, local-only cache',exact:true}).waitFor();return page;}
async function close(){const pids=await app.evaluate(({app})=>app.getAppMetrics().map(metric=>metric.pid));const mainPid=app.process().pid;if(mainPid&&!pids.includes(mainPid))pids.push(mainPid);await app.close();app=undefined;await assertTrackedProcessesExit(pids);processRuns.push({pids,allExited:true});}
async function scenario(page,id,label,status){await page.getByRole('button',{name:label,exact:true}).click();await page.getByRole('heading',{name:status,exact:true}).waitFor();const result=JSON.parse(await page.locator('#result').textContent());assert.equal(result.scenario,id);results[id]=result;await page.screenshot({path:path.join(evidence,`T-cache-${id}.png`)});return result;}
try{
 const first=await launch('seed');await scenario(first,'save','Save synthetic approval','Synthetic approval saved');await close();
 checks.push('Saved synthetic approval, then verified every tracked Electron process exited before reopening');
 const second=await launch('reopen');await assert.rejects(second.evaluate(()=>window.cacheTest.run('save')),/unavailable in this fixture phase/);
 await scenario(second,'restore','Restore after restart','Historical approval restored');assert.equal(results.restore.approvalEventsThisScenario,0);assert.equal(results.restore.approvalId,results.save.approvalId);assert.equal(results.restore.candidateHash,results.save.candidateHash);assert.equal(results.restore.revision,1);
 await scenario(second,'changed-evidence','Changed evidence','Changed evidence marks claims stale');assert.equal(results['changed-evidence'].approvalEventsThisScenario,0);assert.equal(results['changed-evidence'].candidateHash,results.save.candidateHash);assert.deepEqual(results['changed-evidence'].freshness.map(c=>c.freshness),['stale','stale','stale','current','current','current']);
 const failure=await scenario(second,'failure-boundaries','Failure boundaries','Failure boundaries verified');assert.equal(failure.historicalCacheUnchanged,true);assert.equal(failure.outcomes.cancelledWrite.lastGoodPreserved,true);assert.equal(failure.outcomes.staleRevision.rejected,true);for(const fault of ['corrupt','unsupported-version','oversize'])assert.equal(failure.outcomes[fault].notEmptySuccess,true);assert.equal(failure.outcomes.symlink.targetUnchanged,true);
 checks.push('New Electron process restored historical local-only approval without calling approve; changed evidence recomputed three stale claims while retaining historical approved text');
 checks.push('Malformed, unsupported, oversized and symlink cache files rejected for reads and writes; stale revision and pre-aborted writes preserved prior bytes; safe cleanup verified');
 await assert.rejects(second.evaluate(()=>window.cacheTest.run('unknown')),/Invalid cache scenario/);await assert.rejects(second.evaluate(()=>window.cacheTest.run('restore','extra')),/Invalid cache scenario/);await assert.rejects(second.evaluate(()=>window.cacheTest.run()),/Invalid cache scenario/);
 const security=await app.evaluate(async({BrowserWindow},paths)=>{
  const original=BrowserWindow.getAllWindows()[0];const prefs=original.webContents.getLastWebPreferences();const foreign=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:paths.preload}});
  try{await foreign.loadFile(paths.entry);const foreignSenderRejected=await foreign.webContents.executeJavaScript(`window.cacheTest.run('restore').then(()=>false,()=>true)`);return {sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,foreignSenderRejected};}finally{foreign.destroy();}
 },{preload:path.resolve('dist/electron-tests/cache-preload.cjs'),entry:path.resolve('tests/electron/cache-fixture/index.html')});
 assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false,foreignSenderRejected:true});await close();
 checks.push('Fixed scenario IPC rejects unknown, missing, extra arguments and foreign renderer; sandbox and context isolation verified');
 report={status:'passed',observedAt:new Date().toISOString(),codeIdentity:await buildIdentity(),checks,results,security,processRuns,scope:'Actual Linux Electron harness using synthetic cache data and historical synthetic approval only. Temporary main-owned root; no actual userData, vault, provider, production persistence UI, power-loss durability or macOS claim.',cancellationScope:'Deterministic pre-aborted write only; mid-write/post-rename race not exercised. No claim that cancellation rolls back a committed write.',visualReview:'Pending separate screenshot opening'};
}finally{
 if(app)await close();
 // No recursive deletion if the trusted root identity changed; preserve and report instead.
 const current=await lstat(root).catch(()=>null);let cleanup;
 if(current?.isDirectory()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino){try{await rm(root,{recursive:true,force:false});cleanup={state:'removed',ownedTemporaryRootRemoved:true};}catch(error){cleanup={state:'indeterminate',message:String(error)};}}
 else cleanup={state:'indeterminate',message:'Fixture root changed or disappeared; recursive deletion withheld'};
 if(report){report.cleanup=cleanup;await writeFile(path.join(evidence,'T-cache-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.equal(cleanup.state,'removed','Temporary root cleanup not verified');}
}
