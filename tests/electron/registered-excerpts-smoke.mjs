import {isolatedEntry} from './isolated-entry.mjs';
import {waitUntil} from './wait-until.mjs';
import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createPhase1Fixture} from './phase1-fixture/setup.mjs';
import {PRIVATE_MARKER,ORCA_ARGV} from './live-fixture/setup.mjs';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';

const evidence=path.resolve('reviews/evidence');await mkdir(evidence,{recursive:true});
const fixture=await createPhase1Fixture(),codeIdentity=await buildIdentity();
const checks=[],screenshots=[],rendererErrors=[];
const registrations=[{id:'goal',kind:'goal-document',relativePath:'goal.md',startLine:2,endLine:2},{id:'decision',kind:'document',relativePath:'decision.md',startLine:2,endLine:2},{id:'inbox-item',kind:'inbox',relativePath:'inbox-item.md',startLine:2,endLine:2}];
const sourcePath=name=>path.join(fixture.scope,name);
const writeSource=(name,text,header=PRIVATE_MARKER)=>writeFile(sourcePath(name),`${header}\n${text}\n${PRIVATE_MARKER}\n`);
await writeSource('goal.md','목표: 근거를 확인할 수 있는 프로젝트 요약');
await writeSource('decision.md','결정: 요약 후보는 사람이 검토한 뒤 승인한다');
await writeSource('inbox-item.md','요청: 현재 상태와 다음 제안을 구분해서 표시한다');
fixture.config.summarySelections[0].excerpts=registrations;
await writeFile(fixture.configPath,JSON.stringify(fixture.config));
await fixture.setTransport({mode:'complete',submittedDelayMs:50,waitingDelayMs:50,responseDelayMs:100});
const sourceSnapshot=async()=>Object.fromEntries(await Promise.all(registrations.map(async r=>[r.relativePath,await readFile(sourcePath(r.relativePath),'utf8')])));
let app,page,userData,cleanup,approvalHash,approvalText,approvalAt;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=()=>page.evaluate(()=>window.noteApp.getLiveState());
const view=ticket=>page.evaluate(id=>window.__excerptViews?.findLast(v=>v.ticketId===id)??null,ticket);
const waitView=(ticket,predicate,label)=>waitUntil(()=>view(ticket),v=>v?.ticketId===ticket&&predicate(v),label);
function noPrivate(value){const serialized=JSON.stringify(value);assert(!serialized.includes(PRIVATE_MARKER),'Unselected source body escaped');assert(!serialized.includes(fixture.scope),'Local source paths escaped');}
async function capture(name){
  if(name==='fresh-source-blocks-stale-approval')await page.getByTestId('summary-status').scrollIntoViewIfNeeded();
  else{
    const context=page.getByTestId('summary-context'),details=context.locator('details').last();
    if(!await details.evaluate(el=>el.open))await details.locator('summary').click();
    await context.locator('.context-record').filter({hasText:'목표 발췌문'}).scrollIntoViewIfNeeded();
  }
  const filename=`T-excerpts-${name}.png`;await page.screenshot({path:path.join(evidence,filename),fullPage:false});screenshots.push(filename);}
async function close(){if(!app)return;const views=page&&!page.isClosed()?await page.evaluate(()=>window.__excerptViews??[]):[];const pids=await app.evaluate(({app})=>app.getAppMetrics().map(m=>m.pid));pids.push(app.process().pid);await app.close();app=undefined;await assertTrackedProcessesExit([...new Set(pids)]);noPrivate(views);}
async function launch(synthetic){
  const entry=await isolatedEntry(fixture.root,path.join(fixture.profile,'note-app'),synthetic?'dist/main/phase1-test.cjs':'dist/main/index.cjs');
  app=await electron.launch({chromiumSandbox:true,args:[entry],env:{...process.env,XDG_CONFIG_HOME:fixture.profile,NOTE_APP_CONFIG:fixture.configPath,NOTE_APP_PHASE1_TEST_CONTROL:fixture.controlPath,NOTE_APP_PHASE1_TEST_TRANSPORT_LOG:fixture.transportLog},timeout:30000});
  page=await app.firstWindow();page.on('pageerror',error=>rendererErrors.push(String(error)));await page.getByTestId('live-connect').waitFor();
  await page.evaluate(()=>{window.__excerptViews=[];window.noteApp.onSummary(v=>window.__excerptViews.push(v));});
  const actual=await realpath(await app.evaluate(({app})=>app.getPath('userData')));const relative=path.relative(fixture.root,actual);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));if(userData)assert.equal(actual,userData);else userData=actual;
  // Stabilize the owned Mac test window before explicit inactive manual collection.
  // This exercises the supported manual path; it does not certify foreground connect.
  if(process.platform==='darwin'){
    await pause(1200);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].blur());
  }
  await page.getByTestId('live-connect').click();
  if(process.platform==='darwin'){await waitUntil(state,s=>s.connection==='connected'&&!s.refreshing,'inactive connection');await page.evaluate(()=>window.noteApp.refreshLive());}
  await waitUntil(state,s=>s.connection==='connected'&&!s.refreshing&&!!s.observedAt,'live source ready');
  await page.getByRole('button',{name:/현재 관측/}).first().click();await page.getByTestId('project-list-item').filter({hasText:'Fictional Atlas checkout'}).locator('a').click();await page.getByTestId('live-workstream').locator('h2 a').click();await page.getByTestId('summary-journey').waitFor();
}
async function prepare(){
  const details=page.getByTestId('summary-task-selection');if(!await details.evaluate(el=>el.open))await details.locator('summary').click();
  await page.getByTestId('summary-task-T-0').check();await page.getByTestId('summary-provider').selectOption('claude');
  const old=await page.evaluate(()=>window.__excerptViews.map(v=>v.ticketId));await page.getByTestId('summary-prepare').click();
  const started=await waitUntil(()=>page.evaluate(ids=>window.__excerptViews.find(v=>!ids.includes(v.ticketId))??null,old),Boolean,'new prepare ticket');
  const result=await waitView(started.ticketId,v=>v.state!=='preparing','prepared exact excerpts');assert.equal(result.state,'prepared',result.message);noPrivate(result);return result;
}
async function run(prepared){await page.getByTestId('summary-run').click();const candidate=await waitView(prepared.ticketId,v=>v.state==='candidate'&&v.persistence.state==='candidate-saved'&&v.canApprove,'saved candidate');noPrivate(candidate);assert.equal(candidate.candidateClaims.length,6);assert.equal(candidate.candidateClaims.find(c=>c.claim.aspect==='goal').claim.kind,'inference');return candidate;}
try{
  let before=await sourceSnapshot();await launch(false);let prepared=await prepare();assert.equal(prepared.preview.recordCount,4);assert.equal(prepared.preview.checkpoint,'new-baseline');assert.equal(prepared.canRun,false);assert.equal(prepared.transport,'blocked');assert.equal((await fixture.transportCalls()).length,0);
  for(const kind of ['goal-document','document','inbox']){const record=prepared.preview.records.find(r=>r.selection===kind);assert(record);assert.equal(record.excerpt.lineStart,2);assert.equal(record.excerpt.lineEnd,2);assert.equal(record.change,'new');assert(record.excerpt.byteEnd>record.excerpt.byteStart);}
  assert.equal(prepared.preview.unknowns.some(x=>/goal document excerpt not supplied/i.test(x)),false);await capture('production-bounded-preview');assert.deepEqual(await sourceSnapshot(),before);await close();
  await writeSource('goal.md','목표: 저장하지 않은 검토 이후 변경된 목표');before=await sourceSnapshot();await launch(false);prepared=await prepare();assert.equal(prepared.preview.checkpoint,'new-baseline');assert.equal(prepared.preview.records.find(r=>r.selection==='goal-document').change,'new');assert.deepEqual(await fixture.cacheFiles(userData),[]);assert.deepEqual(await sourceSnapshot(),before);await close();
  checks.push('Production UI previews exactly registered goal/document/inbox line excerpts with byte/line provenance; unselected marker/path data stays hidden and real execution remains blocked. Restart after unsaved preparation establishes a new baseline and creates no cache file.');

  await launch(true);prepared=await prepare();let candidate=await run(prepared);assert.equal(candidate.persistence.revision,1);await page.getByTestId('summary-approve').click();const approved=await waitView(candidate.ticketId,v=>v.state==='approved'&&v.persistence.state==='approval-saved','saved explicit approval');approvalHash=approved.approvedCandidateHash;approvalText=approved.approvedClaims.map(c=>c.claim.text);approvalAt=approved.approvedAt;assert.equal(approved.persistence.revision,2);assert.deepEqual(await sourceSnapshot(),before);await close();
  await writeSource('goal.md','목표: 저장된 요약 이후 변경된 목표');await writeSource('decision.md','결정: 요약 후보는 사람이 검토한 뒤 승인한다','UNSELECTED HEADER LENGTH CHANGED');before=await sourceSnapshot();
  await launch(true);prepared=await prepare();assert.equal(prepared.preview.checkpoint,'saved-summary');assert.equal(prepared.preview.records.find(r=>r.selection==='goal-document').change,'changed');assert.equal(prepared.preview.records.find(r=>r.selection==='document').change,'unchanged');assert.equal(prepared.preview.records.find(r=>r.selection==='inbox').change,'unchanged');assert.equal(prepared.approvedCandidateHash,approvalHash);assert.deepEqual(prepared.approvedClaims.map(c=>c.claim.text),approvalText);assert.equal(prepared.approvedAt,approvalAt);assert.equal(prepared.canApprove,false);assert.equal(prepared.canRun,true);await capture('saved-checkpoint-changed-slice');
  candidate=await run(prepared);const diskBeforeStale=await fixture.cacheFiles(userData);await writeSource('goal.md','목표: 후보 검토가 끝난 뒤 다시 변경된 목표');before=await sourceSnapshot();await page.getByTestId('summary-approve').click();const stale=await waitView(candidate.ticketId,v=>v.state==='error','stale source approval blocked');assert.equal(stale.canApprove,false);assert.equal(stale.approvedCandidateHash,approvalHash);assert.deepEqual(stale.approvedClaims.map(c=>c.claim.text),approvalText);assert.equal(stale.approvedAt,approvalAt);assert.deepEqual(await fixture.cacheFiles(userData),diskBeforeStale);await capture('fresh-source-blocks-stale-approval');assert.deepEqual(await sourceSnapshot(),before);await close();
  checks.push('A saved synthetic candidate and explicit automated UI approval survive process restart with exact historical wording/time. Selected goal changes are shown against that checkpoint; an outside-only document edit remains unchanged. Fresh registered-source revalidation blocks an approval after another goal edit without changing cache bytes or prior approval.');

  fixture.config.summarySelections[0].excerpts=registrations.filter(r=>r.kind!=='document');await writeFile(fixture.configPath,JSON.stringify(fixture.config));await launch(true);prepared=await prepare();assert.equal(prepared.preview.recordCount,3);assert.equal(prepared.preview.absentSourceIds.length,1);assert.equal(prepared.canApprove,false);assert.equal(prepared.canRun,true);candidate=await run(prepared);assert.equal(candidate.canApprove,true);assert.equal(candidate.approvedCandidateHash,approvalHash);await capture('registration-change-refreshable');assert.deepEqual(await sourceSnapshot(),before);
  checks.push('Removing an exact document registration after restart surfaces the absent source and still permits a new synthetic candidate; no old candidate is silently rebound, approved or stranded. Source files remain unchanged by app operations.');
  // Registered note-link targets are deliberately disclosed for human link review.
  // Excerpt provenance paths are forbidden in the summary subtree and DTOs, while
  // the whole page must still exclude every unselected source-body marker.
  noPrivate(await page.getByTestId('summary-journey').evaluate(el=>el.outerHTML));
  assert(!(await page.content()).includes(PRIVATE_MARKER),'Unselected source body escaped anywhere in the page');
  const pathLocations=await page.evaluate(scope=>{
    const matches=[];const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode()))if(node.textContent.includes(scope))matches.push({tag:node.parentElement?.tagName,allowed:node.parentElement?.matches('[data-testid="note-link-scope"] > option')===true&&node.textContent===scope});
    const attributeMatches=[...document.querySelectorAll('*')].flatMap(el=>[...el.attributes].filter(a=>a.value.includes(scope)).map(a=>({tag:el.tagName,attribute:a.name})));
    return {matches,attributeMatches};
  },fixture.scope);
  assert(pathLocations.matches.length>0,'Expected explicit note-link target option');
  assert(pathLocations.matches.every(match=>match.allowed),'A source path escaped outside the explicit note-link target option');assert.deepEqual(pathLocations.attributeMatches,[]);
  checks.push('Live DOM inspection confines the deliberately disclosed project path to the exact registered note-link target option; summary HTML/DTOs contain no local paths, and the complete page contains no unselected source-body marker.');
  assert.deepEqual(rendererErrors,[]);for(const row of (await fixture.logs()).filter(r=>r.kind==='orca'))assert(ORCA_ARGV.some(args=>JSON.stringify(args)===JSON.stringify(row.args)));
  const runs=(await fixture.transportCalls()).filter(row=>row.event==='run');assert.equal(runs.length,3);assert.equal(new Set(runs.map(row=>row.ticketId)).size,runs.length);await close();cleanup=await fixture.cleanup();
  const report={status:'passed',observedAt:new Date().toISOString(),codeIdentity,checks,screenshots,rendererErrors,cleanup,syntheticRequests:runs.length,realProviderCalls:0,actualUserApprovals:0,successfulAutomatedUiApprovals:1,staleAutomatedUiApprovalsRejected:1,visualReview:'Pending separate screenshot inspection',platform:process.platform,collectionCondition:process.platform==='darwin'?'Explicit manual collection after owned window stabilization/blur':'Native initial collection',scope:'Actual desktop Electron production host/preload/renderer with exact synthetic registered note sources. Candidate execution uses the isolated Phase1 synthetic transport only. No real notes, model call, terminal transport execution or packaging validation.'};
  await writeFile(path.join(evidence,'T-excerpts-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){if(page&&!page.isClosed())await capture('failure').catch(()=>{});await writeFile(path.join(evidence,'T-excerpts-failure.json'),JSON.stringify({status:'failed',at:new Date().toISOString(),error:String(error),checks,screenshots,rendererErrors,lastSummary:await page?.evaluate(()=>window.__excerptViews?.at(-1)??null).catch(()=>null)},null,2));throw error;}
finally{await close();if(!cleanup)await fixture.cleanup();}
