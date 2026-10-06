import {isolatedEntry} from './isolated-entry.mjs';
import {waitUntil} from './wait-until.mjs';
import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,realpath,readlink,rm} from 'node:fs/promises';
import path from 'node:path';
import {createPhase1Fixture} from './phase1-fixture/setup.mjs';
import {PRIVATE_MARKER,ORCA_ARGV,CODEBURN_ARGV} from './live-fixture/setup.mjs';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';

const evidence=path.resolve('reviews/evidence');await mkdir(evidence,{recursive:true});
const fixture=await createPhase1Fixture(),checks=[],screenshots=[],rendererErrors=[];
const codeIdentity=await buildIdentity(),sourceBefore=await fixture.noteSnapshot();
let app,page,userData,cleanup,security,approvedText,approvedAt;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=()=>page.evaluate(()=>window.noteApp.getLiveState());
const summary=ticketId=>page.evaluate(ticketId=>window.__phase1Views?.findLast(view=>view.ticketId===ticketId)??null,ticketId);
const noPrivate=value=>assert(!JSON.stringify(value).includes(PRIVATE_MARKER),'Unselected private source body escaped');
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
  const entry=await isolatedEntry(fixture.root,path.join(fixture.profile,'note-app'),synthetic?'dist/main/phase1-test.cjs':'dist/main/index.cjs');
  app=await electron.launch({chromiumSandbox:true,args:[entry],env:{...process.env,XDG_CONFIG_HOME:fixture.profile,NOTE_APP_CONFIG:fixture.configPath,NOTE_APP_PHASE1_TEST_CONTROL:fixture.controlPath,NOTE_APP_PHASE1_TEST_TRANSPORT_LOG:fixture.transportLog},timeout:30000});
  page=await app.firstWindow();page.on('pageerror',error=>rendererErrors.push(String(error)));
  await page.getByTestId('live-connect').waitFor({timeout:15000});await page.waitForFunction(()=>!!window.noteApp);
  await page.evaluate(()=>{window.__phase1Views=[];window.noteApp.onSummary(view=>window.__phase1Views.push(view));});
  const actual=await realpath(await app.evaluate(({app})=>app.getPath('userData'))),relative=path.relative(fixture.root,actual);
  assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'App-owned cache escaped temporary profile');
  if(userData)assert.equal(actual,userData,'Production and test entries must restore the same app-owned profile');else userData=actual;
  assert.equal((await state()).connection,'disconnected');
  // Stabilize the owned Mac test window before explicit inactive manual collection.
  // This exercises the supported manual path; it does not certify foreground connect.
  if(process.platform==='darwin'){
    await pause(1200);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].blur());
  }
  await page.getByTestId('live-connect').click();
  if(process.platform==='darwin'){await waitUntil(state,s=>s.connection==='connected'&&!s.refreshing,'inactive connection');await page.evaluate(()=>window.noteApp.refreshLive());}
  return settled();
}
async function close(){if(!app)return;const pids=await app.evaluate(({app})=>app.getAppMetrics().map(m=>m.pid));pids.push(app.process().pid);await app.close();app=undefined;await assertTrackedProcessesExit([...new Set(pids)]);}
async function overview(){await page.evaluate(()=>{location.hash='/';});await page.getByRole('button',{name:/현재 관측/}).first().click();await page.getByTestId('project-list-item').first().waitFor();}
async function detail(title='Fictional Atlas checkout'){
  await overview();const all=page.getByRole('button',{name:/현재 관측/});if(await all.count())await all.first().click();
  await page.getByTestId('project-list-item').filter({hasText:title}).locator('a').click();await page.getByTestId('live-workstream').locator('h2 a').click();await page.getByTestId(title==='Fictional Atlas checkout'?'summary-journey':'note-link-journey').waitFor();
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
  const connected=await launch(false);assert.equal(connected.workstreams.length,2);
  const environment=await page.evaluate(()=>window.noteApp.getEnvironment());assert.equal(environment.capabilities.remoteSummary,false);
  assert.equal((await fixture.transportCalls()).length,0);
  await detail();
  await selectTasks(Array.from({length:32},(_,i)=>`T-${i}`),'auto');assert.equal(await page.getByTestId('summary-task-T-32').isDisabled(),true);assert.equal(await page.locator('[data-testid^="summary-task-"]:checked').count(),32);
  let prepared=await prepare(['T-0'],'auto');
  assert.equal(prepared.preview.selectedTaskCount,1);assert.equal(prepared.preview.recordCount,1);assert(prepared.preview.bytes<=32768);assert(prepared.preview.inputBytes<=65536);assert.equal(prepared.preview.accountingMethod,'utf8-byte-proxy-not-model-tokenizer');assert(prepared.preview.unknowns.some(x=>/goal/i.test(x)));assert(prepared.preview.unresolvedDependencyIds.length>0);
  assert.equal(prepared.budget.state,'choice-required');assert(prepared.budget.assessments.every(a=>a.budget==='unknown'&&a.availability==='unknown'));assert.equal(prepared.transport,'blocked');assert.equal(prepared.canRun,false);assert.equal(await page.getByTestId('summary-run').isDisabled(),true);
  const quota=prepared.codeburn.find(r=>r.ok&&r.value.kind==='quota').value;assert.equal(quota.providers.find(p=>p.provider==='claude').quotaData,'unavailable');assert(!JSON.stringify(quota.providers.find(p=>p.provider==='claude')).includes('remaining":0'));
  await capture('production-context-blocked','summary-context');
  const blocked=await page.evaluate(request=>window.noteApp.runSummary(request),{ticketId:prepared.ticketId,provider:'claude'});assert.equal(blocked.state,'blocked');assert.equal(blocked.candidateHash,null);assert.equal((await fixture.transportCalls()).length,0);assert.deepEqual(await fixture.cacheFiles(userData),[]);
  checks.push('Production renderer selects at most 32 current tasks, reviews exact bounded task/direct-dependency context, missing goal, unresolved dependency and byte-based accounting; unavailable quota and unknown budgets remain unknown. Production run is hardblocked even when test-only control variables are present and public IPC is called directly.');

  // The linked worktree and every write target are inside this fixture root.
  await detail('Fictional handoff checkout');const linkBefore=await fixture.linkSnapshot();
  await previewLink();const proposalText=await page.getByTestId('note-link-proposal').innerText();
  for(const expected of [fixture.worktrees[1],fixture.scope,fixture.exclude,fixture.worktrees[0],'/docs/note'])assert(proposalText.includes(expected),`Missing exact preview authority ${expected}`);
  await capture('link-preview','note-link-proposal');await page.getByTestId('note-link-cancel').click();assert.deepEqual(await fixture.linkSnapshot(),linkBefore);
  await previewLink();const originalExclude=await readFile(fixture.exclude);await writeFile(fixture.exclude,Buffer.concat([originalExclude,Buffer.from('\n# fictional external change\n')]));const changedExclude=await readFile(fixture.exclude);
  await page.getByTestId('note-link-confirm').click();await page.getByTestId('note-link-result').waitFor();assert((await page.getByTestId('note-link-result').textContent()).includes('stale-preview'));assert.deepEqual(await readFile(fixture.exclude),changedExclude);assert.equal((await fixture.metadata(path.join(fixture.worktrees[1],'docs','note'))).exists,false);await capture('link-stale-preview','note-link-result');
  await writeFile(fixture.exclude,originalExclude);await mkdir(path.join(fixture.worktrees[1],'docs'));await writeFile(path.join(fixture.worktrees[1],'docs','note'),'fictional pre-existing conflict');
  await previewLink();assert.equal(await page.getByTestId('note-link-confirm').isDisabled(),true);assert.equal(await readFile(path.join(fixture.worktrees[1],'docs','note'),'utf8'),'fictional pre-existing conflict');await capture('link-conflict','note-link-proposal');await page.getByTestId('note-link-cancel').click();await rm(path.join(fixture.worktrees[1],'docs'),{recursive:true});
  await previewLink();await page.getByTestId('note-link-confirm').evaluate(button=>{for(let i=0;i<10;i++)button.click();});await page.getByTestId('note-link-result').waitFor();
  assert.equal(await realpath(path.join(fixture.worktrees[1],'docs','note')),fixture.scope);assert.equal((await fixture.metadata(path.join(fixture.worktrees[1],'docs','note'))).kind,'symlink');const appliedExclude=await readFile(fixture.exclude,'utf8');assert.equal(appliedExclude.split('\n').filter(line=>line==='/docs/note').length,1);assert.equal(fixture.runGit(['check-ignore','docs/note'],fixture.worktrees[1]).trim(),'docs/note');
  assert((await page.getByTestId('note-link-result').innerText()).includes('노트 연결 적용됨'));const applied=await fixture.linkSnapshot();await capture('link-applied','note-link-result');
  await previewLink();await page.getByTestId('note-link-confirm').click();await page.getByTestId('note-link-result').waitFor();assert((await page.getByTestId('note-link-result').innerText()).includes('변경 없음 · 기존 연결 확인됨'));assert.deepEqual(await fixture.linkSnapshot(),applied,'No-op must preserve symlink, exclude and directory identity');
  assert.deepEqual(await fixture.noteSnapshot(),sourceBefore);checks.push('Actual production UI selects a registered scope and previews exact symlink/exclude paths plus both worktrees sharing the common Git exclusion. Cancel writes nothing, external changes invalidate preview, an existing object conflicts, rapid confirm clicks apply one real temporary symlink/exclude change, and no-op preserves file identity. Source notes stay untouched.');

  security=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity,webviewTag:p.webviewTag,noSandboxArg:process.argv.some(a=>a.includes('no-sandbox'))};});
  assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false,noSandboxArg:false});
  const bridgeKeys=['cancelReadRoot','confirmReadRoot','getReadRoots','getPublicModelReview','revokeReadRoot','selectReadRoot','summarizeNow','openProjectDocument','confirmProjectConnection','setProjectStatus','approveSummary','cancelNoteLink','cancelSummary','confirmNoteLink','connectLive','disconnectLive','getEnvironment','getLiveState','getPhase1Options','loadDemo','onLiveState','onSummary','prepareSummary','previewNoteLink','readSummary','refreshLive','rejectSummary','runSummary'].sort();
  assert.deepEqual(await page.evaluate(()=>({require:typeof window.require,process:typeof window.process,keys:Object.keys(window.noteApp).sort()})),{require:'undefined',process:'undefined',keys:bridgeKeys});
  const invalidPayloads=await page.evaluate(async()=>{const api=window.noteApp;const cases=[['prepareSummary',null],['prepareSummary',{workstreamId:'valid',taskIds:Array.from({length:33},(_,i)=>`T-${i}`),provider:'auto'}],['prepareSummary',{workstreamId:'valid',taskIds:['T-0'],provider:'claude',path:'/etc/passwd'}],['runSummary',{ticketId:'valid',provider:'shell'}],['approveSummary',{ticketId:'valid',candidateHash:'sha256:'+ 'a'.repeat(64),approvedAt:'forged'}],['rejectSummary',{ticketId:'valid',candidateHash:'bad'}],['readSummary',{ticketId:'../path'}],['cancelSummary',{ticketId:'valid',command:'echo'}]];return Promise.all(cases.map(async([name,request])=>{try{await api[name](request);return false;}catch{return true;}}));});assert(invalidPayloads.every(Boolean));
  const escaped=await page.evaluate(()=>window.noteApp.previewNoteLink({worktreeId:'not-registered',scopeId:'../outside'}));assert.equal(escaped.status,'rejected');
  const foreign=await app.evaluate(async({BrowserWindow},files)=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:files.preload}});try{await w.loadFile(files.renderer);return await w.webContents.executeJavaScript(`Promise.all([['getPhase1Options'],['prepareSummary',{workstreamId:'valid',taskIds:['T-0'],provider:'auto'}],['runSummary',{ticketId:'valid',provider:'claude'}],['readSummary',{ticketId:'valid'}],['approveSummary',{ticketId:'valid',candidateHash:'sha256:'+ 'a'.repeat(64)}],['rejectSummary',{ticketId:'valid',candidateHash:'sha256:'+ 'a'.repeat(64)}],['cancelSummary',{ticketId:'valid'}],['previewNoteLink',{worktreeId:'valid',scopeId:'valid'}],['confirmNoteLink',{proposalId:'valid',confirmationToken:'valid'}],['cancelNoteLink',{proposalId:'valid'}]].map(async ([name,request])=>{try{await window.noteApp[name](request);return false;}catch(e){return e.message.includes('Untrusted IPC sender');}}))`);}finally{w.destroy();}},{preload:path.resolve('dist/preload/index.cjs'),renderer:path.resolve('dist/renderer/index.html')});assert.equal(foreign.length,10);assert(foreign.every(Boolean));
  await page.evaluate(()=>window.open('https://example.com'));assert.equal(app.windows().length,1);await assert.rejects(page.evaluate(()=>fetch('https://example.com')));
  assert.equal(await page.evaluate(()=>{const f=document.createElement('iframe');document.body.append(f);const x=typeof f.contentWindow.noteApp;f.remove();return x;}),'undefined');
  checks.push('Real production sandbox/context isolation/no-Node and exact narrow bridge remain intact; malformed summary authority and unregistered link requests fail closed; all ten new methods reject actual foreign-window senders; child frames, external windows and network fetch remain blocked.');
  await close();

  await launch(true);await detail();prepared=await prepare(['T-0']);assert.equal(prepared.transport,'synthetic-test-only');
  const candidate=await runToCandidate(prepared);assert.equal(candidate.approvedClaims.length,0);assert.equal(candidate.persistence.revision,1);assert((await fixture.cacheFiles(userData)).length>0);await capture('candidate-review','summary-candidate');
  const beforeApproval=await fixture.cacheFiles(userData);await page.getByTestId('summary-approve').evaluate(button=>{for(let i=0;i<10;i++)button.click();});
  const approved=await waitSummary(candidate.ticketId,s=>s.state==='approved'&&s.persistence.state==='approval-saved','explicit approval persisted');assert.equal(approved.persistence.revision,2);assert.equal(approved.approvedClaims.length,6);approvedText=approved.approvedClaims.map(c=>c.claim.text);approvedAt=approved.approvedAt;assert(approvedAt);assert.notDeepEqual(await fixture.cacheFiles(userData),beforeApproval);await capture('approved-local-cache','summary-approved');
  checks.push('Separate test-only entry runs the identical production host/preload/renderer with synthetic transport. Actual UI submission, waiting and TUI-idle remain distinct from validated completion. Six-aspect candidate is persisted unapproved; explicit UI approval (including repeated clicks) creates one separate durable approval revision. No real provider is invoked.');
  await close();

  await launch(true);await detail();const restored=await prepare(['T-0']);assert.equal(restored.persistence.state,'restored');assert.equal(restored.persistence.revision,2);assert.equal(restored.approvedAt,approvedAt);assert.deepEqual(restored.approvedClaims.map(c=>c.claim.text),approvedText);assert.equal(restored.canApprove,false);await capture('reopened-approval','summary-approved');
  const dependencySlice=await prepare(['T-1']);assert.equal(dependencySlice.preview.selectedTaskCount,1);assert.equal(dependencySlice.preview.recordCount,2);assert.equal(dependencySlice.preview.records.filter(record=>record.selection==='direct-dependency').length,1);const dependencyCandidate=await runToCandidate(dependencySlice);const beforeStaleApproval=await fixture.cacheFiles(userData);const citedTask=dependencyCandidate.preview.records[0].taskId;fixture.tasks.find(task=>task.id===citedTask).title='Fictional cited task changed after candidate review';await fixture.writeDag();await page.getByTestId('summary-approve').click();const staleApproval=await waitSummary(dependencySlice.ticketId,s=>s.state==='error','changed evidence blocks approval');assert.equal(staleApproval.canApprove,false);assert.deepEqual(staleApproval.approvedClaims.map(c=>c.claim.text),approvedText);assert.equal(staleApproval.approvedAt,approvedAt);assert.deepEqual(await fixture.cacheFiles(userData),beforeStaleApproval);await capture('stale-approval-rejected','summary-status');const staleRestored=await prepare(['T-1']);assert.equal(staleRestored.canApprove,false);assert.equal(staleRestored.canReject,true);await page.getByTestId('summary-reject').click();const rejected=await waitSummary(staleRestored.ticketId,s=>s.state==='rejected'&&s.persistence.state==='rejection-saved','candidate rejection persisted');assert.equal(rejected.candidateHash,null);assert.deepEqual(rejected.approvedClaims.map(c=>c.claim.text),approvedText);assert.equal(rejected.approvedAt,approvedAt);
  checks.push('Closing and reopening the actual Electron app restores candidate and approval from its real app-owned cache without a test seed or new approval. A new bounded task slice creates a distinct candidate; a disk change between candidate review and approval blocks that approval without rewriting the cache. Explicit UI rejection of the restored stale candidate persists and preserves the previous approved wording and timestamp.');

  await fixture.setTransport({mode:'invalid-citation'});const invalidPrepared=await prepare(['T-2']);const beforeInvalid=await fixture.cacheFiles(userData);await startRun(invalidPrepared);const invalid=await waitSummary(invalidPrepared.ticketId,s=>s.state==='error','strict candidate validation');assert.equal(invalid.candidateHash,null);assert.deepEqual(invalid.approvedClaims.map(c=>c.claim.text),approvedText);assert.deepEqual(await fixture.cacheFiles(userData),beforeInvalid);await capture('invalid-candidate','summary-status');assert.equal(await page.locator('img[src="x"]').count(),0);assert.equal(await page.evaluate(()=>window.__liveHostileExecuted),undefined);
  await fixture.setTransport({mode:'complete',responseDelayMs:900});const cancelPrepared=await prepare(['T-3']);const cancelledTicket=cancelPrepared.ticketId,beforeCancel=await fixture.cacheFiles(userData);const cancelledRun=await startRun(cancelPrepared,true);await waitSummary(cancelledTicket,s=>s.state==='waiting','cancellable waiting');await page.getByTestId('summary-cancel').click();await waitSummary(cancelledTicket,s=>s.state==='cancelled','cancelled ticket');
  await waitTransport(cancelledRun,'response-emitted',row=>row.aborted===true);const cancelled=await page.evaluate(ticketId=>window.noteApp.readSummary({ticketId}),cancelledTicket);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.candidateHash,null);assert.deepEqual(await fixture.cacheFiles(userData),beforeCancel);
  const changedPrepared=await prepare(['T-4']);const changedTicket=changedPrepared.ticketId;await startRun(changedPrepared);await waitSummary(changedTicket,s=>s.state==='waiting','source change while waiting');fixture.tasks[4].status='running';await fixture.writeDag();const changedSource=await fixture.noteSnapshot();const changed=await waitSummary(changedTicket,s=>s.state==='error','late source change rejected');assert.equal(changed.canApprove,false);assert.equal(changed.candidateHash,null);assert.deepEqual(changed.approvedClaims.map(c=>c.claim.text),approvedText);assert.deepEqual(await fixture.cacheFiles(userData),beforeCancel);await capture('source-changed','summary-status');
  const navigatePrepared=await prepare(['T-5']);const navigatedTicket=navigatePrepared.ticketId;const navigatedRun=await startRun(navigatePrepared);await waitSummary(navigatedTicket,s=>s.state==='waiting','navigation while waiting');await overview();await waitUntil(()=>page.evaluate(ticketId=>window.noteApp.readSummary({ticketId}),navigatedTicket),s=>s.ticketId===navigatedTicket&&s.state==='cancelled','navigation cancels owned ticket');await detail();assert.equal(await page.getByTestId('summary-status').count(),0);await waitTransport(navigatedRun,'response-emitted',row=>row.aborted===true);assert.equal(await page.getByTestId('summary-status').count(),0);assert.deepEqual(await fixture.cacheFiles(userData),beforeCancel);
  const rows=await fixture.transportCalls(),runs=rows.filter(row=>row.event==='run');assert.equal(runs.length,6,'Repeated UI clicks must not multiply synthetic requests');assert.equal(new Set(runs.map(row=>row.ticketId)).size,runs.length,'Each prepared ticket must run at most once');assert.equal(new Set(runs.map(row=>row.runId)).size,runs.length,'Each invocation must have a unique run ID');for(const row of rows)assert(runs.find(run=>run.ticketId===row.ticketId&&run.runId===row.runId),'Every log row must identify its exact ticket and run');
  await fixture.setTransport({mode:'submission-unknown'});const ambiguousPrepared=await prepare(['T-6']);const ambiguousRun=await startRun(ambiguousPrepared);const ambiguous=await waitSummary(ambiguousPrepared.ticketId,s=>s.state==='error','ambiguous submission');assert(/ambiguous/i.test(ambiguous.message));assert.equal(ambiguous.canRun,false);await waitTransport(ambiguousRun,'submission-unknown');const count=(await fixture.transportCalls()).filter(r=>r.event==='run').length;await pause(600);assert.equal((await fixture.transportCalls()).filter(r=>r.event==='run').length,count);assert.deepEqual(await fixture.cacheFiles(userData),beforeCancel);
  checks.push('Strict unsupported-citation rejection preserves prior approval/cache; hostile selected task markup remains text. Cancel, source changes and navigation reject late completion, repeated clicks create only one run, and ambiguous submission never silently retries. No invalid/late response becomes a saved candidate or approval.');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,760));await capture('narrow','summary-journey');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);assert.deepEqual(await fixture.noteSnapshot(),changedSource);assert.deepEqual(rendererErrors,[]);noPrivate(await page.content());
  for(const row of (await fixture.logs()).filter(r=>r.kind==='orca'))assert(ORCA_ARGV.some(args=>JSON.stringify(args)===JSON.stringify(row.args)),'Unexpected Orca command');for(const row of (await fixture.logs()).filter(r=>r.kind==='codeburn'))assert(CODEBURN_ARGV.some(args=>JSON.stringify(args)===JSON.stringify(row.args)),'Unexpected CodeBurn command');
  await close();await fixture.quiescence();cleanup=await fixture.cleanup();
  const report={status:'passed',observedAt:new Date().toISOString(),codeIdentity,checks,security,screenshots,rendererErrors,cleanup,syntheticRequests:count,realProviderCalls:0,actualUserApprovals:0,successfulAutomatedUiApprovals:1,staleAutomatedUiApprovalsRejected:1,visualReview:'Pending separate screenshot inspection',platform:process.platform,collectionCondition:process.platform==='darwin'?'Explicit manual collection after owned window stabilization/blur':'Native initial collection',scope:'Actual desktop Electron production renderer/preload/IPC/main. Summary execution uses a separate test-only main entry and synthetic transport; production execution remains blocked. Real Git/fs link changes and app-owned cache writes are confined to temporary fictional fixtures. Externally supplied pinned query remains outside the repository. No real private notes, provider/Orca-agent calls, upload, GitHub or macOS packaging validation.',remainingLimits:['Injected note-link rollback/partial and unsettled-OS fault cases are covered by backend tests, not this native UI journey.','Synthetic responses verify orchestration and schema/provenance checks, not model truthfulness or real restricted agent transport.','Real-project foreground connection and packaged .app remain unverified.']};
  await writeFile(path.join(evidence,'T-phase1-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){if(page&&!page.isClosed())await capture('failure').catch(()=>{});await writeFile(path.join(evidence,'T-phase1-failure.json'),JSON.stringify({status:'failed',at:new Date().toISOString(),error:String(error),checks,screenshots,rendererErrors,lastSummary:await page.evaluate(()=>window.__phase1Views?.at(-1)??null).catch(()=>null)},null,2));throw error;}
finally{await close();if(!cleanup)await fixture.cleanup();}
