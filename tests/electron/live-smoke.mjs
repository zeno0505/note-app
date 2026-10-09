import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createLiveFixture,PRIVATE_MARKER,HOSTILE_TITLE,ORCA_ARGV,CODEBURN_ARGV} from './live-fixture/setup.mjs';
import {seedHistoricalSummary} from '../../dist/electron-tests/live-fixture-tools.mjs';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';

const evidence=path.resolve('reviews/evidence');await mkdir(evidence,{recursive:true});
const fixture=await createLiveFixture(),checks=[],screenshots=[],rendererErrors=[],appConsole=[];
const codeIdentity=await buildIdentity();let app,page,verifiedUserData,security,cleanup;
const initialSources=await fixture.sourceSnapshot();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const calls=kind=>fixture.logs().then(rows=>rows.filter(row=>row.kind===kind));
const state=()=>page.evaluate(()=>window.noteApp.getLiveState());
async function waitState(predicate,label,timeout=30000){const deadline=Date.now()+timeout;let current;while(Date.now()<deadline){current=await state();if(predicate(current))return current;await pause(40);}throw new Error(`Timed out: ${label}; ${JSON.stringify({connection:current?.connection,refreshing:current?.refreshing,freshness:current?.freshness,lastError:current?.lastError,dags:current?.dags.map(d=>({state:d.state,reason:d.reason,summary:d.summary.state}))})}`);}
const settled=()=>waitState(s=>s.connection==='connected'&&!s.refreshing&&!!s.observedAt,'connected observation');
async function capture(name){const filename=`T-live-${name}.png`;await page.screenshot({path:path.join(evidence,filename),fullPage:false});screenshots.push(filename);}
function noPrivate(value){assert(!JSON.stringify(value).includes(PRIVATE_MARKER),'Private synthetic body leaked into renderer projection');}
async function sourceUnchanged(expected=initialSources){assert.deepEqual(await fixture.sourceSnapshot(),expected,'Production read-only UI changed note bytes, metadata or symlink identity');}
async function launch(configPath=fixture.configPath){
  app=await electron.launch({chromiumSandbox:true,args:[path.resolve('.')],env:{...process.env,XDG_CONFIG_HOME:fixture.profile,NOTE_APP_CONFIG:configPath},timeout:30000});
  page=await app.firstWindow();page.on('pageerror',error=>rendererErrors.push(String(error)));page.on('console',message=>{if(message.type()==='error')appConsole.push(message.text());});
  await page.getByRole('heading',{name:'작업의 흐름을 한눈에',exact:true}).waitFor({timeout:15000});
  await page.waitForFunction(()=>!!window.noteApp);
  const userData=await app.evaluate(({app})=>app.getPath('userData'));
  const canonical=await realpath(userData),root=await realpath(fixture.root),relative=path.relative(root,canonical);
  assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Electron userData escaped synthetic fixture root');
  if(verifiedUserData)assert.equal(canonical,verifiedUserData);else verifiedUserData=canonical;
  return state();
}
async function close(){if(!app)return;const pids=await app.evaluate(({app})=>app.getAppMetrics().map(m=>m.pid));pids.push(app.process().pid);await app.close();app=undefined;await assertTrackedProcessesExit([...new Set(pids)]);}
async function clickRefresh(){const before=(await calls('orca')).length;await page.getByTestId('live-refresh').click();const deadline=Date.now()+10000;while((await calls('orca')).length===before&&Date.now()<deadline)await pause(20);assert((await calls('orca')).length>before,'Refresh click did not launch Orca');return settled();}
async function verifyCommands(){
  const history=await fixture.logs();
  for(const row of history.filter(row=>row.kind==='orca'))assert(ORCA_ARGV.some(args=>JSON.stringify(args)===JSON.stringify(row.args)),'Unexpected Orca argv');
  for(const row of history.filter(row=>row.kind==='codeburn'))assert(CODEBURN_ARGV.some(args=>JSON.stringify(args)===JSON.stringify(row.args)),'Unexpected CodeBurn argv');
  for(const row of history.filter(row=>row.kind==='dag')){assert.equal(row.args.length,11);assert.deepEqual(row.args.slice(0,3),['-I','-B','-c']);assert.equal(row.args[4],process.env.NOTE_APP_DAG_QUERY_PATH);assert.equal(row.args[5],fixture.dagPath);assert.equal(row.args[6],'done');assert(/^[a-f0-9]{64}$/.test(row.args[7]));assert(/^[a-f0-9]{64}$/.test(row.args[8]));}
}
try{
  const initial=await launch();assert.equal(initial.configuration.state,'ready');assert.equal(initial.connection,'disconnected');assert.equal(initial.observedAt,null);assert.deepEqual(initial.workstreams,[]);assert.deepEqual(initial.codeburn.results,[]);
  await pause(300);assert.deepEqual(await fixture.logs(),[]);await capture('configured-disconnected');
  const environment=await page.evaluate(()=>window.noteApp.getEnvironment());assert.deepEqual(environment.capabilities,{realOrca:true,noteWrites:false,remoteSummary:false});assert.equal(environment.summaryBackend,'unconfigured');
  checks.push('Production app opens configured but disconnected: no Orca, CodeBurn, DAG, cache generation or model subprocess starts automatically; XDG profile and Electron userData are confined to the temporary fixture root');
  await page.getByTestId('live-connect').click();const first=await settled();
  assert.equal(first.freshness,'current');assert.equal(first.workstreams.length,2);assert.equal(first.dags.length,1);assert.equal(first.dags[0].state,'ready');assert.equal(first.dags[0].taskCount,240);assert.equal(first.dags[0].displayedTaskCount,200);assert.equal(first.dags[0].tasks.length,200);assert.equal(first.dags[0].summary.state,'empty');
  assert(first.workstreams.every(w=>w.noteMapping.state==='resolved'));assert.equal(new Set(first.workstreams.map(w=>w.noteMapping.dagId)).size,1);
  const handoff=first.workstreams.find(w=>w.title==='Fictional handoff checkout');assert(handoff);assert.equal(handoff.branch,null);assert.equal(handoff.projectName,null);assert.equal(handoff.projectMapping,'missing-project-id');assert.equal(handoff.agentState,'unknown');assert.equal(handoff.terminalConnected,null);
  assert.equal(first.dags[0].tasks[0].e2e.coverage,'unmet');assert.equal(first.dags[0].tasks[0].dependencies[0].scope,'external');assert.equal(first.dags[0].tasks[0].commitVerification,'not-performed');
  const firstOrca=await calls('orca'),firstCost=await calls('codeburn');assert.equal(firstOrca.length,4);assert.equal(firstCost.length,3);assert.equal((await calls('dag')).length,1);assert.equal((await calls('python-child')).length,1);
  assert.deepEqual(firstCost.map(row=>row.args),CODEBURN_ARGV);
  const quota=first.codeburn.results.find(r=>r.ok&&r.value.kind==='quota').value;assert.equal(quota.providers[0].provider,'claude');assert.equal(quota.providers[0].quotaData,'unavailable');assert.equal(quota.providers[1].provider,'codex');assert.equal(quota.providers[1].quotaData,'available');assert(quota.providers.every(p=>p.agentAvailability==='unknown'));
  noPrivate(first);await sourceUnchanged();
  await page.getByRole('button',{name:/현재 관측/}).first().click();await page.getByTestId('project-list-item').first().waitFor();assert.equal(await page.getByTestId('project-list-item').count(),2);await page.getByTestId('project-list-item').filter({hasText:'Fictional handoff checkout'}).locator('a').click();const handoffCard=page.getByTestId('live-workstream');await handoffCard.getByText('브랜치 없음 / 미확인',{exact:true}).waitFor();await handoffCard.getByText('에이전트 상태 미확인',{exact:true}).waitFor();await handoffCard.getByText('터미널 연결 미확인',{exact:true}).waitFor();await capture('overview');
  checks.push('Connect runs all four exact Orca commands and three independent CodeBurn commands through actual child processes at paths containing spaces; real pinned external query reads one canonical DAG shared by two docs/note symlinks');
  checks.push('Empty branch/null project and handoff agent state remain unknown; quota-unavailable Claude and quota-available Codex remain independent of agent execution availability; full DAG count and bounded 200-task display remain distinct');

  await page.getByRole('button',{name:/현재 관측/}).first().click();await page.getByTestId('project-list-item').first().locator('a').click();await page.getByTestId('live-workstream').locator('h2 a').click();await page.getByTestId('live-dag').waitFor();await page.getByTestId('live-summary').waitFor();await page.getByTestId('live-dag').locator('.task-details > summary').click();await page.getByTestId('live-dag').getByText(HOSTILE_TITLE,{exact:false}).first().waitFor();assert.equal(await page.locator('img[src="x"]').count(),0);assert.equal(await page.evaluate(()=>window.__liveHostileExecuted),undefined);
  await capture('detail-empty-summary');await page.goBack();await page.getByTestId('project-list-item').first().waitFor();
  const dagCount=(await calls('dag')).length;const refreshed=await clickRefresh();assert.equal(refreshed.dags[0].unchanged,true);assert.equal((await calls('dag')).length,dagCount);await sourceUnchanged();
  checks.push('Production detail/back navigation shows DAG declarations and empty cached-summary state; hostile task markup stays text; unchanged DAG refresh skips another external query and leaves note bytes/symlinks untouched');

  await fixture.setMode({orca:'failure'});const stale=await clickRefresh();assert.equal(stale.freshness,'stale');assert(stale.lastError);assert.equal(stale.observedAt,refreshed.observedAt);assert.deepEqual(stale.workstreams,refreshed.workstreams);assert.equal(stale.dags[0].taskCount,240);noPrivate(stale);await page.getByTestId('live-status').getByText('갱신 실패 · 이전 관측 유지',{exact:true}).waitFor();await capture('orca-stale');
  await fixture.setMode({orca:'normal',codeburn:'failure'});const costFailed=await clickRefresh();assert.equal(costFailed.freshness,'current');assert(costFailed.codeburn.results.some(r=>!r.ok&&r.error.query==='claude-status'));assert(costFailed.codeburn.results.some(r=>r.ok&&r.value.kind==='status'&&r.value.provider==='codex'));assert(costFailed.codeburn.results.some(r=>r.ok&&r.value.kind==='quota'));noPrivate(costFailed);
  checks.push('Actual Orca command failure preserves prior workstreams, DAG and successful timestamp with a stale banner; one CodeBurn status failure neither gates the other provider nor quota and raw error bodies are discarded');

  await fixture.setMode({orca:'empty',codeburn:'normal'});const empty=await clickRefresh();assert.equal(empty.freshness,'current');assert.equal(empty.lastError,null);assert.deepEqual(empty.workstreams,[]);assert.deepEqual(empty.dags,[]);await capture('empty');
  await fixture.setMode({orca:'failure'});const emptyStale=await clickRefresh();assert.equal(emptyStale.freshness,'stale');assert.deepEqual(emptyStale.workstreams,[]);assert.equal(emptyStale.observedAt,empty.observedAt);
  await fixture.setMode({orca:'normal'});await clickRefresh();
  checks.push('Explicit successful empty data is separate from failed refresh; an empty last-good observation remains empty and stale after failure; a normal retry recovers');

  await page.getByRole('link',{name:'연결 및 설정',exact:true}).click();await page.getByTestId('live-configuration').waitFor();await page.getByTestId('live-codeburn').waitFor();await capture('settings');
  await page.evaluate(()=>{location.hash='/';});await page.getByTestId('project-list-item').first().waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,760));await capture('narrow');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,900));

  security=await app.evaluate(({BrowserWindow})=>{const prefs=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,webSecurity:prefs.webSecurity,webviewTag:prefs.webviewTag,noSandboxArg:process.argv.some(a=>a.includes('no-sandbox'))};});
  assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false,noSandboxArg:false});
  const exposed=await page.evaluate(()=>({require:typeof window.require,process:typeof window.process,keys:Object.keys(window.noteApp).sort()}));assert.deepEqual(exposed,{require:'undefined',process:'undefined',keys:['cancelReadRoot','confirmReadRoot','getReadRoots','getPublicModelReview','revokeReadRoot','selectReadRoot','summarizeNow','openProjectDocument','confirmProjectConnection','setProjectStatus','approveSummary','cancelNoteLink','cancelSummary','confirmNoteLink','connectLive','disconnectLive','getEnvironment','getLiveState','getPhase1Options','loadDemo','onLiveState','onSummary','prepareSummary','previewNoteLink','readSummary','refreshLive','rejectSummary','runSummary']});
  // The public bridge intentionally drops extra JavaScript arguments. Exercise server-side
  // validation independently using the real handler and its trusted production owner frame.
  const invalidArguments=await app.evaluate(async({BrowserWindow,ipcMain})=>{const owner=BrowserWindow.getAllWindows()[0].webContents;const event={sender:owner,senderFrame:owner.mainFrame};const results=[];for(const channel of ['note-app:environment','note-app:live-state','note-app:live-connect','note-app:live-refresh','note-app:live-disconnect']){const handler=ipcMain._invokeHandlers.get(channel);if(!handler)throw new Error('Missing handler');for(const payload of [null,{},'/tmp/arbitrary',{command:'echo injected'},{path:'/etc/passwd'}]){try{await handler(event,payload);results.push(false);}catch(error){results.push(error.message.includes('accepts no arguments'));}}}return results;});assert(invalidArguments.every(Boolean));assert.equal(invalidArguments.length,25);
  const foreign=await app.evaluate(async({BrowserWindow,app})=>{const other=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:app.getAppPath()+'/dist/preload/index.cjs'}});try{await other.loadFile(app.getAppPath()+'/dist/renderer/index.html');return await other.webContents.executeJavaScript(`Promise.all(['getEnvironment','getLiveState','connectLive','refreshLive','disconnectLive'].map(name=>window.noteApp[name]().then(()=>false,error=>error.message.includes('Untrusted IPC sender'))))`);}finally{other.destroy();}});assert.equal(foreign.length,5);assert(foreign.every(Boolean));
  const childFrame=await page.evaluate(()=>{const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);const result=typeof frame.contentWindow.noteApp;frame.remove();return result;});assert.equal(childFrame,'undefined');
  await page.evaluate(()=>window.open('https://example.com'));assert.equal(app.windows().length,1);await assert.rejects(page.evaluate(()=>fetch('https://example.com').then(r=>r.text())));
  checks.push('Real production settings and narrow 800px window render without horizontal overflow; sandbox, context isolation, no Node exposure and narrow bridge verified; all five no-argument IPC handlers reject 25 invalid payloads and all five actual foreign-window invocations are rejected; child frame, network fetch and new windows blocked');

  const beforeSlow=(await calls('orca')).length;await fixture.setMode({orca:'slow'});await page.getByTestId('live-refresh').click();const slowDeadline=Date.now()+10000;while((await calls('orca')).length===beforeSlow&&Date.now()<slowDeadline)await pause(25);assert((await calls('orca')).length>beforeSlow);
  assert.equal((await state()).refreshing,true);await page.getByTestId('live-refresh').evaluate(button=>{for(let i=0;i<12;i++)button.click();});await page.getByTestId('live-disconnect').click();await waitState(s=>s.connection==='disconnected'&&!s.refreshing,'disconnect during real running child');
  await fixture.quiescence();const disconnectedCalls=(await fixture.logs()).length;await pause(300);assert.equal((await fixture.logs()).length,disconnectedCalls);await sourceUnchanged();await capture('disconnected-after-cancel');
  await fixture.setMode({orca:'normal'});await page.getByTestId('live-connect').evaluate(button=>{for(let i=0;i<12;i++)button.click();});const recovered=await settled();assert.equal(recovered.workstreams.length,2);assert.equal(recovered.freshness,'current');assert.equal((await calls('orca')).length-beforeSlow,5,'One cancelled status plus one coalesced four-command reconnect expected');
  checks.push('Disconnect stays usable during a real hanging child; it cancels the child group, leaves no executing fixture process/snapshot and starts no disconnected polling; rapid UI refresh/connect clicks do not multiply collection and reconnect recovers');

  await close();await fixture.quiescence();await sourceUnchanged();
  const seeded=await seedHistoricalSummary({fixtureRoot:fixture.root,verifiedUserData,dagPath:fixture.dagPath,...fixture.config.dagQuery});
  const callsBeforeReopen=(await fixture.logs()).length;const reopened=await launch();assert.equal(reopened.connection,'disconnected');assert.deepEqual(reopened.dags,[]);await pause(200);assert.equal((await fixture.logs()).length,callsBeforeReopen);
  await page.getByTestId('live-connect').click();const restored=await settled();assert.equal(restored.dags[0].dagId,seeded.dagId);const summary=restored.dags[0].summary;assert.equal(summary.state,'restored');assert.equal(summary.revision,1);assert.equal(summary.candidateClaims.length,6);assert.equal(summary.approvedClaims.length,6);assert(summary.candidateClaims.every(c=>c.freshness==='current'));assert(summary.approvedClaims.every(c=>c.freshness==='current'));assert.equal(summary.context.selectedTaskCount,1);assert.equal(summary.context.recordCount,1);noPrivate(restored);
  await page.getByRole('button',{name:/현재 관측/}).first().click();await page.getByTestId('project-list-item').first().locator('a').click();await page.getByTestId('live-workstream').locator('h2 a').click();await page.getByTestId('live-summary').getByText('이전 후보 요약',{exact:false}).waitFor();await page.getByTestId('live-summary').scrollIntoViewIfNeeded();await capture('historical-summary');
  const historicalText=summary.approvedClaims.map(c=>c.claim.text);fixture.tasks[0].status='running';await fixture.writeDag();const changedSources=await fixture.sourceSnapshot();
  await page.evaluate(()=>window.noteApp.refreshLive());const changed=await settled();assert.equal(changed.dags[0].unchanged,false);assert.equal(changed.dags[0].summary.state,'restored');assert(changed.dags[0].summary.candidateClaims.every(c=>c.freshness==='stale'));assert(changed.dags[0].summary.approvedClaims.every(c=>c.freshness==='stale'));assert.deepEqual(changed.dags[0].summary.approvedClaims.map(c=>c.claim.text),historicalText);await capture('historical-summary-stale');await sourceUnchanged(changedSources);
  assert.equal(createHash('sha256').update(await readFile(seeded.filename)).digest('hex'),seeded.hash,'Production runtime changed the historical cache');
  const dagLaunches=(await calls('dag')).length;await page.evaluate(()=>window.noteApp.refreshLive());const cached=await settled();assert.equal(cached.dags[0].unchanged,true);assert.equal((await calls('dag')).length,dagLaunches);
  fixture.tasks[0].title='Fictional Atlas changed source';await fixture.writeDag();const beforeDagFailure=await fixture.sourceSnapshot();await fixture.setMode({dag:'failure'});await page.evaluate(()=>window.noteApp.refreshLive());const dagFailed=await settled();assert.equal(dagFailed.dags[0].state,'error');assert.equal(dagFailed.dags[0].taskCount,240);assert(dagFailed.dags[0].summary.approvedClaims.every(c=>c.freshness==='unknown'));assert.deepEqual(dagFailed.dags[0].summary.approvedClaims.map(c=>c.claim.text),historicalText);noPrivate(dagFailed);await sourceUnchanged(beforeDagFailure);assert.equal(createHash('sha256').update(await readFile(seeded.filename)).digest('hex'),seeded.hash);await capture('dag-failure-preserves-history');
  checks.push('After production userData containment verification and app closure, test-only production claims/context/storage APIs seed a fictional historical cache; reopened product shows six separate candidate and approved claims without a model or actual approval action');
  checks.push('Changed selected DAG content marks both restored claim sets stale while preserving approved text and cache bytes; unchanged refresh skips the query; real DAG command failure retains history with unknown freshness rather than erasing it or claiming fresh evidence');
  assert.deepEqual(rendererErrors,[]);noPrivate(await page.content());await verifyCommands();await close();
  const invalidConfig=path.join(fixture.root,'invalid startup.json');await writeFile(invalidConfig,JSON.stringify({...fixture.config,command:'unapproved command'}));const countBeforeInvalid=(await fixture.logs()).length;const invalid=await launch(invalidConfig);assert.equal(invalid.configuration.state,'invalid');assert.equal(invalid.connection,'disconnected');await page.evaluate(()=>window.noteApp.connectLive());assert.equal((await fixture.logs()).length,countBeforeInvalid);await capture('invalid-configuration');await close();
  checks.push('Invalid startup configuration is visibly blocked and connect cannot start any subprocess; renderer has no uncaught exceptions; every tracked Electron process exits');
  cleanup=await fixture.cleanup();
  const report={status:'passed',observedAt:new Date().toISOString(),codeIdentity,checks,security,cleanup,screenshots,rendererErrors,scope:'Actual Linux production Electron window, main runtime, preload and renderer; synthetic Orca and CodeBurn CLI processes; temporary synthetic notes and genuine externally supplied pinned query. No real private-source collection, real model/provider call, actual user approval, remote upload or packaged macOS verification.',historicalSummarySeed:{candidateCount:seeded.candidateCount,approvedCount:seeded.approvedCount,actualModelCalls:0,actualUserApprovals:0},visualReview:'Pending separate screenshot inspection'};
  await writeFile(path.join(evidence,'T-live-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(path.join(evidence,'T-live-failure.json'),JSON.stringify({status:'failed',at:new Date().toISOString(),error:String(error),checks,screenshots,rendererErrors,appConsole},null,2));throw error;}
finally{await close();if(!cleanup)await fixture.cleanup();}
