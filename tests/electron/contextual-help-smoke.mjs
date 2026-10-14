import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createPhase1Fixture} from './phase1-fixture/setup.mjs';
import {isolatedEntry} from './isolated-entry.mjs';
import {waitUntil} from './wait-until.mjs';
import {assertTrackedProcessesExit} from './evidence.mjs';
const f=await createPhase1Fixture(),out=path.resolve(process.env.NOTE_APP_HELP_EVIDENCE??'reviews/evidence/contextual-help');
await mkdir(out,{recursive:true,mode:0o700});
const baseline=process.env.NOTE_APP_HELP_BASELINE==='1';
const report={status:'running',baseline,source:'fictional renderer states in actual Mac Electron; production collectors untouched; hidden nonfocusable test window',checks:[],screenshots:[],realModelCalls:0};
let app,page,base,id;
function front(){return execFileSync('/usr/bin/lsappinfo',['front'],{encoding:'utf8'}).trim();}
const originalForeground=front();
async function shot(name){if(await page.getByRole('tooltip').count())await waitUntil(()=>page.getByRole('tooltip').evaluate(el=>getComputedStyle(el).opacity),v=>Number(v)===1,'capture tooltip transition');const file=path.join(out,name+'.png');await page.screenshot({path:file,animations:'disabled'});report.screenshots.push(file);}
async function publish(mode){
 const next=structuredClone(base),w=next.workstreams.find(w=>w.id===id),dag=next.dags.find(d=>d.dagId===w.noteMapping.dagId);
 if(mode==='missing'){w.noteMapping={state:'unresolved',reason:'note-missing',dagId:null};next.dags=[];}
 if(mode==='error'){dag.state='error';dag.reason='Fixture DAG source access unavailable';}
 if(mode==='stale'){next.freshness='stale';}
 if(mode==='long'){const root='/fictional/read-only/'+Array(12).fill('긴 이름의 공유 노트 디렉토리').join('/');w.noteMapping.context={...w.noteMapping.context,noteRootPath:root,dagPath:root+'/dag.yaml'};}
 await app.evaluate(({BrowserWindow},s)=>BrowserWindow.getAllWindows()[0].webContents.send('note-app:live-changed',s),next);
 await page.waitForTimeout(100);
 return next;
}
async function enterHelp(label){const b=page.getByRole('button',{name:label,exact:true});await b.focus();await page.keyboard.press('Enter');const d=page.getByRole('dialog',{name:label,exact:true});await d.waitFor();await waitUntil(()=>d.evaluate(el=>el.contains(document.activeElement)),Boolean,'help dialog keyboard focus entered');await page.keyboard.press('Escape');await d.waitFor({state:'hidden'});await waitUntil(()=>b.evaluate(el=>document.activeElement===el),Boolean,'dialog focus return');}
try{
 const entry=await isolatedEntry(f.root,path.join(f.profile,'note-app'),'dist/main/index.cjs',{background:true});
 app=await electron.launch({chromiumSandbox:true,args:[entry],env:{...process.env,NOTE_APP_CONFIG:f.configPath}});page=await app.firstWindow();
 await app.evaluate(()=>{const cp=process.getBuiltinModule('child_process'),spawn=cp.spawn;globalThis.__helpCalls=0;cp.spawn=function(exe,args,...rest){if(args?.includes('-p')){globalThis.__helpCalls++;throw Error('model forbidden');}return spawn.call(this,exe,args,...rest);};});
 await waitUntil(()=>page.evaluate(()=>!!window.noteApp),Boolean,'bridge');await page.evaluate(()=>window.noteApp.connectLive());await page.evaluate(()=>window.noteApp.refreshLive());
 base=await waitUntil(()=>page.evaluate(()=>window.noteApp.getLiveState()),s=>s.connection==='connected'&&!s.refreshing&&s.freshness==='current','fixture current');id=base.workstreams.find(w=>w.title==='Fictional Atlas checkout').id;
 base.workstreams=base.workstreams.filter(w=>w.id===id);base.workstreams[0].project.sourceState='available';
 await page.evaluate(()=>window.noteApp.disconnectLive());
 await app.evaluate(({ipcMain},s)=>{ipcMain.removeHandler('note-app:live-state');ipcMain.handle('note-app:live-state',()=>s);ipcMain.removeHandler('note-app:note-reconnect-select');ipcMain.handle('note-app:note-reconnect-select',()=>{throw Error('Fixture directory access unavailable; original connection preserved');});},base);
 await publish('normal');await page.evaluate(id=>location.hash='/workstream/'+encodeURIComponent(id),id);await page.getByTestId('live-workstream').waitFor();
 for(const mode of ['normal','missing','error','stale','long']){
  await publish(mode);await page.emulateMedia({colorScheme:mode==='error'?'dark':'light'});await page.evaluate(()=>scrollTo(0,0));await shot(mode+'-initial');
  const mapping=page.locator('.note-mapping');await mapping.scrollIntoViewIfNeeded();
  if(mode==='long'){await page.getByTestId('note-context').locator('summary').click();}
  await shot(mode+'-connection');
  if(!baseline){
   const status=page.getByTestId('note-connection-status'),button=page.getByTestId('note-reconnect');
   assert(await status.isVisible());assert(await button.isVisible());
   assert(await status.evaluate(el=>el.closest('[data-testid=note-connection]')===document.querySelector('[data-testid=note-reconnect]')?.closest('[data-testid=note-connection]')));
   assert(await mapping.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.querySelector('[data-testid=note-reconnect]').getBoundingClientRect();return b.left>=a.left&&b.right<=a.right&&b.top>=a.top&&b.bottom<=a.bottom;}));
   assert(await mapping.evaluate(el=>el.scrollWidth<=el.clientWidth));
   assert(await status.evaluate(el=>{const a=el.getBoundingClientRect(),b=document.querySelector('[data-testid=note-reconnect]').getBoundingClientRect();return Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<=2&&b.left-a.right<=16;}),'status/reconnect adjacent row');
   if(mode==='error'||mode==='stale')assert(await page.getByTestId('note-connection-recovery').isVisible());
   if(mode==='normal')assert(await page.locator('.note-mapping').evaluate(el=>!!(el.compareDocumentPosition(document.querySelector('[data-testid=reading-summary]'))&Node.DOCUMENT_POSITION_FOLLOWING)));
  }
 }
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(0,0);w.setSize(620,900);});await publish('long');await page.evaluate(()=>scrollTo(0,0));await shot('narrow-initial');await page.locator('.note-mapping').scrollIntoViewIfNeeded();await shot('narrow-connection');
 if(!baseline)assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,900));await publish('normal');
 await page.getByTestId('note-reconnect').scrollIntoViewIfNeeded();const before=await page.evaluate(()=>scrollY);const reconnect=page.getByTestId('note-reconnect');await reconnect.focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'노트 재연결',exact:true}).waitFor();await waitUntil(()=>page.getByRole('dialog',{name:'노트 재연결',exact:true}).evaluate(el=>el.contains(document.activeElement)),Boolean,'reconnect keyboard focus entered');await shot('reconnect-open');await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'노트 재연결',exact:true}).waitFor({state:'hidden'});
 if(!baseline){await waitUntil(()=>reconnect.evaluate(el=>document.activeElement===el),Boolean,'reconnect focus return');assert(Math.abs((await page.evaluate(()=>scrollY))-before)<=2);}
 await reconnect.click();await page.getByTestId('note-reconnect-choose').click();await page.getByTestId('note-reconnect-error').waitFor();await shot('reconnect-error');await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'노트 재연결',exact:true}).waitFor({state:'hidden'});
 await page.getByRole('button',{name:'프로젝트 관측 상세',exact:true}).scrollIntoViewIfNeeded();const helpScroll=await page.evaluate(()=>scrollY);await shot('scroll-before-help');await enterHelp('프로젝트 관측 상세');await shot('scroll-after-help');
 if(!baseline){
  assert(Math.abs((await page.evaluate(()=>scrollY))-helpScroll)<=2);
  for(const label of ['소스 갱신과 AI 요약의 차이','프로젝트 관측 상세','요약 접두사 선택 기준']){const trigger=page.getByRole('button',{name:label,exact:true});assert((await trigger.innerText()).trim().length>0);assert.equal(await trigger.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');}
  const tooltipTrigger=page.getByRole('button',{name:'요약 접두사 선택 기준',exact:true});
  for(const scheme of ['light','dark']){
  await tooltipTrigger.evaluate(el=>el.blur());await page.emulateMedia({colorScheme:scheme});
  await page.mouse.move(0,0);await tooltipTrigger.hover();await page.getByRole('tooltip').waitFor();const value=await page.getByRole('tooltip').innerText();await waitUntil(()=>page.locator('.info-tooltip').evaluate(el=>getComputedStyle(el).opacity),v=>Number(v)===1,'tooltip transition');const colors=await page.locator('.info-tooltip .p-tooltip-text').evaluate(el=>{const c=getComputedStyle(el);return [c.color,c.backgroundColor]});const lum=c=>c.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i],0);const a=lum(colors[0]),b=lum(colors[1]);assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,'tooltip contrast');assert(await tooltipTrigger.evaluate(el=>el.getBoundingClientRect().width<el.parentElement.getBoundingClientRect().width/2));await shot('tooltip-hover-'+scheme);await page.getByRole('tooltip').hover();assert(await page.getByRole('tooltip').isVisible());await page.keyboard.press('Escape');await page.getByRole('tooltip').waitFor({state:'hidden'});
  await page.mouse.move(0,0);await tooltipTrigger.focus();await page.getByRole('tooltip').waitFor();assert.equal(await page.getByRole('tooltip').innerText(),value);assert.equal(await tooltipTrigger.getAttribute('aria-describedby'),await page.getByRole('tooltip').getAttribute('id'));await shot('tooltip-focus-'+scheme);await page.keyboard.press('Escape');await page.getByRole('tooltip').waitFor({state:'hidden'});assert(await tooltipTrigger.evaluate(el=>document.activeElement===el));
  await tooltipTrigger.click();await page.getByRole('tooltip').waitFor();assert.equal(await page.getByRole('tooltip').innerText(),value);await page.keyboard.press('Escape');await page.getByRole('tooltip').waitFor({state:'hidden'});assert.equal(await page.getByRole('dialog').count(),0);
  }
 }
 report.checks.push(baseline?'baseline normal/missing/error/stale/long/narrow screenshots and existing reconnect/help dialogs; no new layout or tooltip acceptance asserted':'normal/missing/error/stale/long/narrow captures; connection target/action grouping and warnings; dialog keyboard/Escape/focus/scroll; short help hover/focus/click/Escape');report.foregroundBefore=originalForeground;report.foregroundAfter=front();report.testWindowNeverFocused=await app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].isFocusable()&&!BrowserWindow.getAllWindows()[0].isFocused());assert(report.testWindowNeverFocused);report.status='passed';
}catch(error){report.status='failed';report.error=String(error);if(page)await shot('failure').catch(()=>{});}
finally{if(app){report.realModelCalls=await app.evaluate(()=>globalThis.__helpCalls);assert.equal(report.realModelCalls,0);const pids=await app.evaluate(({app})=>app.getAppMetrics().map(m=>m.pid));pids.push(app.process().pid);await app.close();await assertTrackedProcessesExit([...new Set(pids)]);}await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});await rm(f.root,{recursive:true,force:true});console.log(JSON.stringify(report));}
if(report.status!=='passed')process.exitCode=1;
