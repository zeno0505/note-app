import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isolatedEntry} from './isolated-entry.mjs';
import {waitUntil} from './wait-until.mjs';
import {assertTrackedProcessesExit,buildIdentity} from './evidence.mjs';

const root=await mkdtemp(path.join(tmpdir(),'note-app-update-ui-'));
const profile=path.join(root,'profile'),control=path.join(root,'control.json'),log=path.join(root,'actions.jsonl');
const out=path.resolve(process.env.NOTE_APP_UPDATE_EVIDENCE??'reviews/evidence/update-ui');
await mkdir(out,{recursive:true,mode:0o700});
await build({entryPoints:['tests/electron/update-fixture/main.ts'],outfile:'dist/main/update-test.cjs',platform:'node',format:'cjs',bundle:true,external:['electron'],target:'node24'});
const sourceFiles=[...new Set(execFileSync('git',['ls-files','-c','-o','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))].sort();
const sourceHashes={};for(const file of sourceFiles)sourceHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex');
const sourceSnapshot={sha256:createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'),fileCount:sourceFiles.length,files:sourceHashes};
const report={status:'running',source:'Real Electron, production Vue renderer and preload, isolated main-only synthetic source updater',build:await buildIdentity(),sourceSnapshot,realSourceBuilds:0,realModelCalls:0,realInstallerCalls:0,checks:[],screenshots:[]};
let app,page,child;
let entry;
const pageErrors=[];
const configure=options=>writeFile(control,JSON.stringify(options),{mode:0o600});
async function calls(){try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
async function count(action){return (await calls()).filter(call=>call.action===action).length;}
async function status(expected){return waitUntil(()=>page.evaluate(()=>window.noteApp.getUpdateState()),s=>s.status===expected,expected);}
async function shot(name,selector='update-settings'){const file=path.join(out,name+'.png');await page.getByTestId(selector).scrollIntoViewIfNeeded();await page.screenshot({path:file,fullPage:true});await chmod(file,0o600);report.screenshots.push(file);}
async function check(scenario){await configure({scenario});await page.getByTestId('update-check').click();await status(scenario==='error'?'error':scenario==='unavailable'?'unavailable':scenario==='up-to-date'?'up-to-date':'available');}
async function open({settings=true}={}){
  const args=[entry];
  if(process.env.NOTE_APP_E2E_HEADLESS==='1')args.push('--ozone-platform=headless','--disable-gpu');
  app=await electron.launch({chromiumSandbox:true,args,env:{...process.env,XDG_CACHE_HOME:path.join(root,'cache'),NOTE_APP_CONFIG:path.join(root,'absent-config.json'),NOTE_APP_UPDATE_TEST_CONTROL:control,NOTE_APP_UPDATE_TEST_LOG:log},timeout:30000});
  child=app.process();page=await app.firstWindow();
  page.on('pageerror',error=>pageErrors.push(String(error)));
  await page.getByTestId('nav-overview').waitFor();
  if(settings){await page.getByTestId('nav-settings').click();await page.getByTestId('update-check').waitFor();}
}
async function close(){
  if(!app)return;
  if(child?.exitCode===null&&child?.signalCode===null){
    const pids=await app.evaluate(({app})=>app.getAppMetrics().map(metric=>metric.pid)).catch(()=>[]);
    if(child?.pid)pids.push(child.pid);
    await app.close();await assertTrackedProcessesExit([...new Set(pids)]);
  }
  app=undefined;page=undefined;child=undefined;
}
try{
  await configure({scenario:'unavailable'});
  entry=await isolatedEntry(root,profile,'dist/main/update-test.cjs');
  await open();
  assert.equal((await calls()).length,0,'opening Settings must not check, build, install or call a model');
  const sandbox=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation};});
  assert.deepEqual(sandbox,{sandbox:true,nodeIntegration:false,contextIsolation:true});
  const api=await page.evaluate(()=>({require:typeof window.require,process:typeof window.process,keys:Object.keys(window.noteApp)}));
  assert.equal(api.require,'undefined');assert.equal(api.process,'undefined');
  for(const name of ['getUpdateState','checkUpdate','prepareUpdate','cancelUpdate','deferUpdate','installUpdate','dismissUpdateOutcome','onUpdateState'])assert(api.keys.includes(name));
  assert(!api.keys.some(name=>['invoke','exec','spawn','writeFile'].includes(name)));
  report.checks.push('Settings entry is read-only; production preload exposes fixed actions in a sandboxed renderer');
  await page.getByTestId('update-preparation-help').getByText(/현재 앱을 계속 사용할 수 있습니다/).waitFor();
  assert.match(await page.getByTestId('update-preparation-help').textContent(),/Git, Node.js 24 이상, npm/);
  assert.match(await page.getByTestId('update-preparation-help').textContent(),/없는 도구를 자동으로 설치하지 않습니다/);
  assert.equal(await page.getByTestId('update-settings').locator('input,textarea,select').count(),0,'target needs no SHA or configuration input');
  await configure({scenario:'unavailable',checkDelayMs:700});
  await page.getByTestId('update-check').evaluate(button=>{for(let i=0;i<6;i++)button.click();});
  await status('checking');await page.getByTestId('update-cancel').evaluate(button=>{for(let i=0;i<6;i++)button.click();});
  await status('cancelled');await page.waitForTimeout(850);
  assert.equal((await page.evaluate(()=>window.noteApp.getUpdateState())).status,'cancelled');
  assert.equal(await count('check'),1);assert.equal(await count('cancel'),1);
  report.checks.push('Fixed-feed source/local-build explanation, prerequisites and current-app continuation are clear; no target input; repeated manual checks and Cancel coalesce without a late result');
  await check('unavailable');
  await page.getByTestId('update-message').getByText(/승인되어 게시된 업데이트 대상이 없습니다/).waitFor();
  assert.equal(await page.getByTestId('update-target').count(),0);
  assert.equal(await page.getByTestId('update-prepare').count(),0);
  assert.equal(await page.getByTestId('update-install').count(),0);
  await shot('unavailable');
  report.checks.push('Missing approved publication is unavailable, with no invented target or prepare/install action');
  await check('error');assert.equal(await page.getByRole('alert').filter({hasText:'업데이트에 실패했습니다'}).count(),1);
  await check('up-to-date');assert.equal(await page.getByTestId('update-prepare').count(),0);
  for(const [id,label] of [['node','Node.js 24 이상'],['npm','npm'],['git','Git']]){
    await check(`blocked-${id}`);assert.equal(await page.getByTestId('update-prepare').count(),0);
    assert((await page.getByTestId('update-missing-prerequisites').textContent()).includes(label));
    assert.equal(await page.getByTestId('update-settings').locator('details').getAttribute('open'),'');
    await page.getByTestId('update-prerequisites').getByText(/앱을 다시 열어 주세요/).waitFor();
    await shot(`missing-${id}`);
  }
  await check('available');
  await page.getByText('빌드 정보 및 실행 조건',{exact:true}).click();
  assert.match(await page.getByTestId('update-current-sha').textContent(),/^a{40}$/);
  assert.match(await page.getByTestId('update-target-sha').textContent(),/^b{40}$/);
  assert.equal(await page.getByTestId('update-changelog').locator('img').count(),0);
  assert((await page.getByTestId('update-changelog').textContent()).includes('<img src=x onerror=alert(1)>'));
  report.checks.push('Errors recover; latest build and each missing Node/npm/Git prerequisite are explicit with recovery details; full SHAs visible and changelog HTML escaped');
  await configure({scenario:'available',prepareDelayMs:1500});
  const beforePrepare=await count('prepare'),beforeCancel=await count('cancel');
  await page.getByTestId('update-prepare').evaluate(button=>{for(let i=0;i<6;i++)button.click();});
  await status('preparing');await page.getByRole('progressbar',{name:'업데이트 준비 진행 단계'}).waitFor();
  assert.match((await page.getByTestId('update-progress-count').textContent()).trim(),/^준비 단계 [0-6]\/7$/);
  await page.getByText('단계 기준이며, 다운로드 퍼센트가 아닙니다.',{exact:true}).waitFor();
  await shot('preparation-progress');
  await page.getByTestId('update-cancel').evaluate(button=>{for(let i=0;i<6;i++)button.click();});await status('cancelled');
  await page.waitForTimeout(1600);
  assert.equal((await page.evaluate(()=>window.noteApp.getUpdateState())).status,'cancelled');
  assert.equal(await count('prepare'),beforePrepare+1);assert.equal(await count('cancel'),beforeCancel+1);assert.equal(await count('install'),0);
  report.checks.push('Repeated source preparation and Cancel coalesce; cancellation wins over the older in-flight response');
  await configure({scenario:'prepare-error',prepareDelayMs:150});
  await page.getByTestId('update-prepare').click();await status('error');
  assert.equal(await count('install'),0);
  await configure({scenario:'available',prepareDelayMs:4200});
  await page.getByTestId('update-prepare').click();await status('preparing');
  for(let step=0;step<7;step++){
    await waitUntil(()=>page.getByTestId('update-progress-count').textContent(),text=>text.trim()===`준비 단계 ${step}/7`,`preparation step ${step}/7`);
    if(step===4)await shot('local-build-progress');
  }
  await page.getByTestId('nav-overview').click();await status('ready');
  report.checks.push('All seven source preparation stages are visible without pretending to be byte percentages; normal navigation remains usable during preparation');
  await page.getByTestId('nav-settings').click();await page.getByTestId('update-install').waitFor();
  await page.getByTestId('update-later').click();await status('deferred');
  assert.equal((await page.getByTestId('update-progress-count').textContent()).trim(),'준비 단계 7/7');
  assert.match(await page.getByTestId('update-deferred').textContent(),/저장된 준비 상태와 파일 검증이 확인/);
  const beforeRestart=await calls();
  await close();await open();await status('deferred');
  assert.equal(await page.getByRole('dialog').count(),0,'a restored prepared update must not force install review');
  assert.equal(await page.getByTestId('update-install').count(),1);
  assert.match(await page.getByTestId('update-deferred').textContent(),/저장된 준비 상태와 파일 검증이 확인/);
  assert.deepEqual(await calls(),beforeRestart,'restoring a verified deferred state must not check, prepare or install');
  await close();await configure({scenario:'available',invalidDeferred:true});await open();await status('deferred');
  assert.equal(await page.getByTestId('update-install').count(),0);
  assert.match(await page.getByTestId('update-deferred').textContent(),/검증이 확인되지 않아 설치할 수 없습니다/);
  assert.doesNotMatch(await page.getByTestId('update-deferred').textContent(),/검증이 확인되었습니다/);
  await close();await configure({scenario:'available'});await open();await status('deferred');
  assert.equal(await count('install'),0);
  await page.getByTestId('update-install').focus();await page.keyboard.press('Enter');
  const keyboardDialog=page.getByRole('dialog',{name:'업데이트 설치 및 재시작',exact:true});
  await keyboardDialog.waitFor();
  await keyboardDialog.getByText(/이전 앱으로 복구를 시도합니다/).waitFor();
  assert(await page.getByTestId('update-install-cancel').evaluate(element=>document.activeElement===element),'initial focus is on the safe Cancel action');
  for(let i=0;i<7;i++){
    await page.keyboard.press('Tab');assert(await keyboardDialog.evaluate(element=>element.contains(document.activeElement)),'Tab focus remains inside restart confirmation');
  }
  for(let i=0;i<7;i++){
    await page.keyboard.press('Shift+Tab');assert(await keyboardDialog.evaluate(element=>element.contains(document.activeElement)),'Shift+Tab focus remains inside restart confirmation');
  }
  await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'업데이트 설치 및 재시작',exact:true}).waitFor({state:'hidden'});
  await waitUntil(()=>page.getByTestId('update-install').evaluate(button=>document.activeElement===button),Boolean,'focus restored');
  assert.equal(await count('install'),0);
  report.checks.push('Failure can retry; Later survives full app restart only with validated fixture state; failed revalidation cannot install or claim ready; no repeat modal; safe Cancel receives initial focus, Tab/Shift+Tab stay inside, and Escape restores focus');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:760,height:900}));
  for(const scheme of ['light','dark']){
    await page.emulateMedia({colorScheme:scheme});await page.waitForTimeout(100);
    await shot(scheme+'-ready');
    const bounds=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));assert(bounds.scrollWidth<=bounds.width,'Updater fits narrow window');
  }
  await page.getByTestId('update-install').click();
  const dialog=page.getByRole('dialog',{name:'업데이트 설치 및 재시작',exact:true});
  await dialog.waitFor();await dialog.getByRole('button',{name:'취소',exact:true}).click();
  await dialog.waitFor({state:'hidden'});assert.equal(await count('install'),0);
  await page.getByTestId('update-install').click();await dialog.waitFor();
  const confirmFile=path.join(out,'install-confirm.png');await dialog.screenshot({path:confirmFile});await chmod(confirmFile,0o600);report.screenshots.push(confirmFile);
  await page.getByTestId('update-install-confirm').evaluate(button=>{for(let i=0;i<6;i++)button.click();});
  await status('installing');assert.equal(await count('install'),1);
  assert.equal(await page.getByTestId('update-check').isEnabled(),false);
  await page.getByRole('dialog',{name:'업데이트 설치 및 재시작',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));
  report.checks.push('Light/dark narrow layouts fit; explicit confirmation invokes one synthetic install, never a real installer or model');
  await close();
  for(const kind of ['success','rollback','recovery-needed','failed','unverified']){
    await configure({scenario:'available',restartOutcome:kind,attemptId:`restart-${kind}`});
    const beforeOpen=await calls();await open({settings:false});
    const outcome=page.getByTestId('update-outcome');await outcome.waitFor();
    assert.equal(await outcome.getAttribute('data-outcome-kind'),kind);
    assert.equal(await outcome.getAttribute('role'),'status');
    assert.equal(await page.getByTestId('update-settings').count(),0,'restart notice must appear on the normal initial route');
    await shot(`restart-${kind}`,'update-outcome');
    assert.equal(await page.getByRole('dialog').count(),0,'restart outcome must remain nonmodal');
    assert.deepEqual(await calls(),beforeOpen,'opening outcome cannot invoke updater/model actions');
    await page.getByTestId('nav-overview').click();await page.getByTestId('nav-settings').click();await outcome.waitFor();
    assert.equal(await page.getByRole('dialog').count(),0,'reopening Settings must not repeat an install dialog');
    assert.equal(await outcome.count(),1,'Settings must not duplicate the global result');
    if(kind==='unverified'){
      await configure({scenario:'dismiss-error',restartOutcome:kind,attemptId:`restart-${kind}`});
      await page.getByTestId('update-outcome-dismiss').click();
      await page.getByTestId('update-outcome-error').getByText(/결과를 닫지 못했습니다/).waitFor();
      assert.equal(await outcome.count(),1,'a failed persistence write must retain the banner');
      await configure({scenario:'available',restartOutcome:kind,attemptId:`restart-${kind}`});
    }
    const beforeDismiss=await count('dismiss-outcome');
    await page.getByTestId('update-outcome-dismiss').evaluate(button=>{for(let i=0;i<6;i++)button.click();});
    await outcome.waitFor({state:'hidden'});
    assert.equal(await count('dismiss-outcome'),beforeDismiss+1);
    await page.getByTestId('nav-overview').click();await page.getByTestId('nav-settings').click();
    assert.equal(await outcome.count(),0);
    await close();await open();
    await page.getByTestId('update-message').getByText(/가상 검증용 상태/).waitFor();
    assert.equal(await page.getByTestId('update-outcome').count(),0,'main-persisted dismissal survives full app restart');
    assert.equal(await page.getByRole('dialog').count(),0);
    await close();
  }
  assert.equal(await count('install'),1,'outcome notifications never trigger another install');
  assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));
  report.checks.push('All five restart outcomes appear nonmodally on the initial route and exactly once in Settings; dismissal is singleflight, persists across reopen/relaunch, and safely retries a failed fixture write');
  report.actions=await calls();report.status='passed';
}catch(error){report.status='failed';report.error=String(error);if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
  await close().catch(error=>{report.status='failed';report.cleanupError=String(error);});
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  if(report.status==='passed')await rm(root,{recursive:true,force:true});
  console.log(JSON.stringify(report,null,2));
}
if(report.status!=='passed')process.exitCode=1;
