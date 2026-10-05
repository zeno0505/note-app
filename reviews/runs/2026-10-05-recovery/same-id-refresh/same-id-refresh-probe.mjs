import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,realpath,readlink,rm} from 'node:fs/promises';
import path from 'node:path';
import {createPhase1Fixture} from './phase1-fixture/setup.mjs';
import {PRIVATE_MARKER,ORCA_ARGV,CODEBURN_ARGV} from './live-fixture/setup.mjs';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';

const evidence=path.resolve("/workspace/scratch/5a42b5329b35/electron-same-id-probe/evidence");await mkdir(evidence,{recursive:true});
const fixture=await createPhase1Fixture(),checks=[],screenshots=[],rendererErrors=[];
const codeIdentity=await buildIdentity(),sourceBefore=await fixture.noteSnapshot();
let app,page,userData,cleanup,security,approvedText,approvedAt;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=()=>page.evaluate(()=>window.noteApp.getLiveState());
const summary=ticketId=>page.evaluate(ticketId=>window.__phase1Views?.findLast(view=>view.ticketId===ticketId)??null,ticketId);
const noPrivate=value=>assert(!JSON.stringify(value).includes(PRIVATE_MARKER),'Unselected private source body escaped');
async function waitUntil(read,predicate,label,timeout=20000){let value;const until=Date.now()+timeout;while(Date.now()<until){value=await read();if(predicate(value))return value;await pause(30);}throw new Error(`Timed out: ${label}; ${JSON.stringify(value)}`);}
const settled=()=>waitUntil(state,s=>s.connection==='connected'&&!s.refreshing&&!!s.observedAt,'connected live observation');
const waitSummary=(ticketId,predicate,label)=>waitUntil(()=>summary(ticketId),s=>s?.ticketId===ticketId&&predicate(s),`${label} (${ticketId})`);
const waitTransport=(run,event,predicate=()=>true)=>waitUntil(async()=>(await fixture.transportCalls()).find(row=>row.ticketId===run.ticketId&&row.runId===run.runId&&row.event===event&&predicate(row))??null,Boolean,`${event} (${run.ticketId}/${run.runId})`);
async function startRun(prepared,repeated=false){
  const ticketId=prepared.ticketId;
  assert.equal((await fixture.transportCalls()).filter(row=>row.ticketId===ticketId&&row.event==='run').length,0,'Prepared ticket must not already have run');
  if(repeated)await page.getByTestId('summary-run').evaluate(button=>{for(let i=0;i<10;i++)button.click();});else await page.getByTestId('summary-run').click();
  const runs=await waitUntil(async()=>(await fixture.transportCalls()).filter(row=>row.ticketId===ticketId&&row.event==='run'),rows=>rows.length>0,`synthetic run (${ticketId})`);
  assert.equal(runs.length,1,'One prepared ticket must create exactly one synthetic run');assert.equal(typeof runs[0].runId,'string');assert(runs[0].runId);
  return {ticketId,runId:runs[0].runId};
}
async function capture(name,testId){if(testId)await page.getByTestId(testId).scrollIntoViewIfNeeded();const file=`T-phase1-${name}.png`;await page.screenshot({path:path.join(evidence,file),fullPage:false});screenshots.push(file);}
async function launch(synthetic){
  app=await electron.launch({chromiumSandbox:true,args:[path.resolve(synthetic?'dist/main/phase1-test.cjs':'.')],env:{...process.env,XDG_CONFIG_HOME:fixture.profile,NOTE_APP_CONFIG:fixture.configPath,NOTE_APP_PHASE1_TEST_CONTROL:fixture.controlPath,NOTE_APP_PHASE1_TEST_TRANSPORT_LOG:fixture.transportLog},timeout:30000});
  page=await app.firstWindow();page.on('pageerror',error=>rendererErrors.push(String(error)));
  await page.getByTestId('live-connect').waitFor({timeout:15000});await page.waitForFunction(()=>!!window.noteApp);
  await page.evaluate(()=>{window.__phase1Views=[];window.noteApp.onSummary(view=>window.__phase1Views.push(view));});
  const actual=await realpath(await app.evaluate(({app})=>app.getPath('userData'))),relative=path.relative(fixture.root,actual);
  assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'App-owned cache escaped temporary profile');
  if(userData)assert.equal(actual,userData,'Production and test entries must restore the same app-owned profile');else userData=actual;
  assert.equal((await state()).connection,'disconnected');
  await page.getByTestId('live-connect').click();return settled();
}
async function close(){if(!app)return;const pids=await app.evaluate(({app})=>app.getAppMetrics().map(m=>m.pid));pids.push(app.process().pid);await app.close();app=undefined;await assertTrackedProcessesExit([...new Set(pids)]);}
async function overview(){await page.evaluate(()=>{location.hash='/';});await page.getByTestId('live-workstream').first().waitFor();}
async function detail(title='Fictional Atlas checkout'){
  await overview();const all=page.getByRole('button',{name:/전체 비보관·미확인/});if(await all.count())await all.click();
  await page.getByTestId('live-workstream').filter({hasText:title}).locator('h2 a').click();await page.getByTestId(title==='Fictional Atlas checkout'?'summary-journey':'note-link-journey').waitFor();
}
async function selectTasks(ids,provider='claude'){
  const details=page.getByTestId('summary-task-selection');if(!await details.evaluate(el=>el.open))await details.locator('summary').click();
  const checked=await page.locator('[data-testid^="summary-task-"]:checked').evaluateAll(inputs=>inputs.map(input=>input.getAttribute('data-testid')));
  for(const id of checked)await page.getByTestId(id).uncheck();
  for(const id of ids)await page.getByTestId(`summary-task-${id}`).check();
  await page.getByTestId('summary-provider').selectOption(provider);
}
async function prepare(ids,provider='claude'){
  await selectTasks(ids,provider);const knownTickets=await page.evaluate(()=>[...new Set(window.__phase1Views.map(view=>view.ticketId))]);
  await page.getByTestId('summary-prepare').click();
  const started=await waitUntil(()=>page.evaluate(known=>window.__phase1Views.find(view=>!known.includes(view.ticketId))??null,knownTickets),Boolean,'new preparation ticket');
  const view=await waitSummary(started.ticketId,s=>s.state!=='preparing','new prepared context');assert.deepEqual(view.taskIds,[...ids].sort());assert.equal(view.providerChoice,provider);
  assert.equal(view.state,'prepared',view.message);noPrivate(view);return view;
}
async function runToCandidate(prepared){
  const run=await startRun(prepared);
  const submitted=await waitSummary(prepared.ticketId,s=>s.state==='submitted','acknowledged submission');assert.equal(submitted.candidateHash,prepared.candidateHash);assert.equal(submitted.canApprove,false);
  const waiting=await waitSummary(prepared.ticketId,s=>s.state==='waiting','waiting semantic response');assert.equal(waiting.canApprove,false);
  await waitTransport(run,'tui-idle');assert.equal((await summary(prepared.ticketId)).state,'waiting','TUI idle must not become completion');
  const candidate=await waitSummary(prepared.ticketId,s=>s.state==='candidate'&&s.persistence.state==='candidate-saved'&&s.canApprove,'validated saved candidate');
  assert.equal(candidate.candidateClaims.length,6);assert(candidate.candidateClaims.find(c=>c.claim.aspect==='goal').claim.kind==='unknown');assert(candidate.candidateClaims.find(c=>c.claim.aspect==='next').claim.intent==='proposal');assert.equal(candidate.executionAuthorized,false);return candidate;
}
async function previewLink(){await page.getByTestId('note-link-scope').selectOption('fictional-atlas');await page.getByTestId('note-link-preview').click();await page.getByTestId('note-link-proposal').waitFor();}

try{
  await fixture.setTransport({mode:'complete',submittedDelayMs:250,waitingDelayMs:350,responseDelayMs:4000});
  await launch(true);await detail();
  const identity=s=>({workstreamIds:s.workstreams.map(w=>w.id).sort(),dagIds:s.dags.map(d=>d.dagId).sort()});
  const refreshEvidence=[];
  async function refreshSameIdentity(ticketId,expectedState,label){
    const before=await state(),ids=identity(before),callsBefore=(await fixture.logs()).filter(row=>row.kind==='orca').length;
    await page.evaluate(()=>window.noteApp.refreshLive());
    const after=await settled();assert.deepEqual(identity(after),ids,`${label}: identity changed`);assert(after.observedAt>before.observedAt,`${label}: no fresh observation`);
    const exact=await page.evaluate(ticketId=>window.noteApp.readSummary({ticketId}),ticketId);assert.equal(exact.ticketId,ticketId);assert.equal(exact.state,expectedState,`${label}: ticket no longer active`);
    assert.equal(await page.getByTestId('summary-status').count(),1);assert((await page.getByTestId('summary-journey').textContent()).includes(`요청: ${ticketId}`),'Renderer lost the exact active ticket');
    const expectedText=expectedState==='prepared'?'컨텍스트 준비됨':'응답 대기 중';assert.equal((await page.getByTestId('summary-status').textContent()).trim(),expectedText);
    assert.equal(await page.getByTestId('summary-task-T-7').isChecked(),true,'Same-ID refresh cleared selected task');
    const callsAfter=(await fixture.logs()).filter(row=>row.kind==='orca').length;assert.equal(callsAfter-callsBefore,4,'Real live refresh must run exactly the four synthetic Orca collection commands');
    refreshEvidence.push({label,ticketId,state:exact.state,identity:ids,beforeObservedAt:before.observedAt,afterObservedAt:after.observedAt,orcaCommandCount:callsAfter-callsBefore});
    await capture(`same-id-${label}`,'summary-status');
  }
  const prepared=await prepare(['T-7']);await refreshSameIdentity(prepared.ticketId,'prepared','prepared-refresh');assert.equal((await fixture.transportCalls()).filter(row=>row.event==='run').length,0,'Prepared refresh started a run');
  const beforeRunCache=await fixture.cacheFiles(userData);assert.deepEqual(beforeRunCache,[]);
  const run=await startRun(prepared);await waitSummary(run.ticketId,v=>v.state==='waiting','original ticket waiting');await refreshSameIdentity(run.ticketId,'waiting','waiting-refresh');
  assert.equal((await fixture.transportCalls()).filter(row=>row.event==='run').length,1,'Waiting refresh duplicated the run');assert.deepEqual(await fixture.cacheFiles(userData),beforeRunCache,'Refresh persisted a premature candidate');
  const candidate=await waitSummary(run.ticketId,v=>v.state==='candidate'&&v.persistence.state==='candidate-saved'&&v.canApprove,'same ticket expected candidate completion');await waitTransport(run,'response-emitted');
  assert.equal(candidate.ticketId,prepared.ticketId);assert.equal(candidate.candidateClaims.length,6);assert.equal(candidate.approvedClaims.length,0);assert.equal((await fixture.transportCalls()).filter(row=>row.event==='run').length,1);assert((await fixture.cacheFiles(userData)).length>0);assert.equal((await page.getByTestId('summary-status').textContent()).trim(),'새 후보 검토 대기');assert((await page.getByTestId('summary-journey').textContent()).includes(`요청: ${run.ticketId}`));
  const views=await page.evaluate(()=>window.__phase1Views);assert(views.every(view=>view.ticketId===prepared.ticketId),'Unexpected replacement preparation ticket');assert(!views.some(view=>view.state==='cancelled'||view.state==='error'),'Refresh cancelled or errored the owned ticket');
  await capture('same-id-candidate','summary-status');assert.deepEqual(rendererErrors,[]);assert.deepEqual(await fixture.noteSnapshot(),sourceBefore);
  security=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity,noSandboxArg:process.argv.some(a=>a.includes('no-sandbox'))};});assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,noSandboxArg:false});
  await close();cleanup=await fixture.cleanup();
  const result={status:'passed',observedAt:new Date().toISOString(),codeIdentity,security,refreshEvidence,exactRun:run,syntheticRequests:1,realProviderCalls:0,rendererErrors,cleanup,screenshots,checks:['Actual live refresh from the summary detail page preserves workstream/DAG identity, selected task, exact prepared ticket, and visible prepared state without starting transport.','Actual live refresh while the exact ticket is waiting preserves the visible waiting state and ownership, runs four real synthetic collection commands, does not duplicate transport or prematurely persist a candidate.','The same ticket and run subsequently complete to one validated saved six-aspect candidate with no replacement ticket, cancellation, error, approval or user-note change.'],scope:'Actual sandboxed Linux Electron UI plus production live-refresh IPC/main and synthetic CLI/summary transport. Refresh is invoked through the exact public preload method because detail has no refresh button; renderer remains mounted. Prepared and waiting states covered; pending-RPC races remain unit-test coverage.'};await writeFile(path.join(evidence,'same-id-refresh-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){if(page&&!page.isClosed())await capture('same-id-failure','summary-status').catch(()=>{});await writeFile(path.join(evidence,'same-id-refresh-failure.json'),JSON.stringify({status:'failed',observedAt:new Date().toISOString(),error:String(error),rendererErrors},null,2));throw error;}
finally{await close();if(!cleanup)await fixture.cleanup();}
