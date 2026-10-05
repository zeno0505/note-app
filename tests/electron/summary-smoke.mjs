import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';
const evidence=path.resolve('reviews/evidence');await mkdir(evidence,{recursive:true});
let app;const results={};const checks=[];
try{
 app=await electron.launch({chromiumSandbox:true,args:[path.resolve('dist/electron-tests/summary-main.cjs')],timeout:30000});
 const page=await app.firstWindow();await page.getByRole('heading',{name:'Bounded summaries, explicit approval'}).waitFor();
 const scenarios=[['bounded-context','Bounded context','Bounded context verified'],['prompt-ceiling','Full prompt ceiling','Full prompt ceiling enforced'],['claims-lifecycle','Approval and stale claims','Approved text preserved'],['late-response','Late response rejection','Late responses rejected'],['unsupported-citation','Unsupported citations','Unsupported evidence rejected'],['provider-budget','Provider budget policy','Provider policy stays advisory']];
 for(const [id,label,status] of scenarios){
  await page.getByRole('button',{name:label,exact:true}).click();await page.getByRole('heading',{name:status,exact:true}).waitFor();
  const result=JSON.parse(await page.locator('#result').textContent());assert.equal(result.scenario,id);results[id]=result;
  if(id==='bounded-context'){assert.equal(await page.locator('#result img').count(),0);assert.equal(await page.evaluate(()=>globalThis.hostileExecuted===true),false);assert((await page.locator('#result').textContent()).includes('<img'));}
  await page.screenshot({path:path.join(evidence,`T-summary-${id}.png`)});
 }
 assert.equal(results['bounded-context'].manifestCount,2);assert.deepEqual(results['bounded-context'].includedSources,['a']);
 assert.equal(await page.locator('#result img').count(),0);assert.equal(await page.evaluate(()=>globalThis.hostileExecuted===true),false);
 assert.equal(results['prompt-ceiling'].rejected,true);
 assert.deepEqual(results['claims-lifecycle'].freshness.map(c=>c.freshness),['stale','stale','stale','current','current','current']);
 assert.equal(results['claims-lifecycle'].failedUpdatePreservedApproval,true);assert.equal(results['claims-lifecycle'].newCandidatePreservedApproval,true);
 assert.equal(results['late-response'].supersededRequestRejected,true);assert.equal(results['late-response'].changedContextVersionRejected,true);
 assert.equal(results['unsupported-citation'].manifestOnlySourceRejected,true);assert.equal(results['unsupported-citation'].unsupportedQuoteRejected,true);
 assert.equal(results['provider-budget'].unknown.state,'choice-required');assert.equal(results['provider-budget'].manualOverride.basis,'user-override');assert.equal(results['provider-budget'].knownCapBlocked.state,'choice-required');
 checks.push('Real pure modules execute in Electron main through fixed synthetic scenarios; exact results attached');
 await assert.rejects(page.evaluate(()=>window.summaryTest.run('unknown')),/Invalid summary scenario/);
 await assert.rejects(page.evaluate(()=>window.summaryTest.run('bounded-context','extra')),/Invalid summary scenario/);
 await assert.rejects(page.evaluate(()=>window.summaryTest.run()),/Invalid summary scenario/);
 const security=await app.evaluate(async({BrowserWindow},paths)=>{
  const original=BrowserWindow.getAllWindows()[0];const prefs=original.webContents.getLastWebPreferences();
  const other=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:paths.preload}});
  try{await other.loadFile(paths.entry);const rejected=await other.webContents.executeJavaScript(`window.summaryTest.run('bounded-context').then(()=>false,()=>true)`);return {sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,foreignSenderRejected:rejected};}finally{other.destroy();}
 },{preload:path.resolve('dist/electron-tests/summary-preload.cjs'),entry:path.resolve('tests/electron/summary-fixture/index.html')});
 assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false,foreignSenderRejected:true});
 checks.push('Unknown, missing and extra arguments rejected; a second real renderer is rejected as an untrusted sender; sandbox and isolation verified');
 const pids=await app.evaluate(({app})=>app.getAppMetrics().map(metric=>metric.pid));await app.close();app=undefined;await assertTrackedProcessesExit(pids);
 checks.push('All tracked Electron processes exited after close');
 const report={status:'passed',observedAt:new Date().toISOString(),codeIdentity:await buildIdentity(),checks,results,security,scope:'Actual Linux Electron harness for pure context, prompt, claim-store and advisory budget contracts. Synthetic data and synthetic approval events only; no live Orca/CodeBurn/provider transport, production summary UI, persistence or packaged macOS verification.',visualReview:'Pending separate screenshot opening'};
 await writeFile(path.join(evidence,'T-summary-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{if(app)await app.close();}
