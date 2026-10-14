/** Interactive first-use review. Fresh synthetic profile; genuine Linux folder picker.
 * No drafts or selected project are seeded into the visible app. The production
 * host may automatically connect the explicitly supplied synthetic config.
 * The parent hands goals and fixture values to an independent UI operator.
 */
import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPhase1Fixture} from './phase1-fixture/setup.mjs';
import {isolatedEntry} from './isolated-entry.mjs';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';
const fixture=await createPhase1Fixture();
const runId=randomUUID();
const control=path.resolve(process.env.NOTE_APP_REVIEW_CONTROL);
const resultPath=path.join(path.dirname(control),'persona-runtime-result.json');
const result={runId,status:'starting',fixtureOnly:true,nativePicker:'unmodified',modelCalls:null,identity:await buildIdentity()};
let app,watcher;
try{
 await mkdir(path.dirname(control),{recursive:true,mode:0o700});
 fixture.runGit(['remote','add','origin','https://github.com/example/demo.git']);
 const destination=path.join(fixture.root,'notes','example','demo','first-project');
 await mkdir(destination,{recursive:true,mode:0o700});
 const home=path.join(fixture.root,'isolated-home');await mkdir(home,{recursive:true,mode:0o700});
 const config=JSON.parse(await readFile(fixture.configPath,'utf8'));config.dagQuery.pythonPath=process.env.NOTE_APP_PYTHON;config.summarySelections=[];
 await writeFile(fixture.configPath,JSON.stringify(config));
 const entry=await isolatedEntry(fixture.root,path.join(fixture.profile,'note-app'),'dist/main/index.cjs');
 app=await electron.launch({chromiumSandbox:true,args:[entry],env:{...process.env,HOME:home,NOTE_APP_CONFIG:fixture.configPath}});
 const page=await app.firstWindow();await page.getByTestId('new-project').waitFor();
 // Observation-only counter plus fail-closed protection against model subprocesses.
 await app.evaluate(()=>{const cp=process.getBuiltinModule('child_process'),spawn=cp.spawn;globalThis.__modelCalls=0;cp.spawn=function(executable,args,...rest){if(args?.includes('--prompt')||args?.includes('--agent')||args?.includes('-p')){globalThis.__modelCalls++;throw Error('Model execution forbidden in synthetic first-use review');}return spawn.call(this,executable,args,...rest);};});
 const drafts=await page.evaluate(()=>window.noteApp.listProjectDrafts());if(drafts.length!==0)throw Error('First-use profile is not empty');
 result.security=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity,webviewTag:p.webviewTag,argv:process.argv};});
 if(!result.security.sandbox||!result.security.contextIsolation||result.security.nodeIntegration||!result.security.webSecurity||result.security.webviewTag||result.security.argv.some(s=>s.includes('no-sandbox')))throw Error('Review security invariant failed');
 result.initialDraftCount=drafts.length;result.initialConnection=await page.evaluate(async()=>(await window.noteApp.getLiveState()).connection);result.status='ready';
 await writeFile(control,JSON.stringify({runId,status:'ready',fixtureRoot:fixture.root,destination,repositoryPath:fixture.worktrees[0],branch:'fictional-main',projectPath:'example/demo/first-project',pid:app.process().pid}));
 await writeFile(resultPath,JSON.stringify(result,null,2));
 await new Promise(resolve=>{watcher=watch(path.dirname(control),async(_event,name)=>{if(name!==path.basename(control))return;try{const command=JSON.parse(await readFile(control,'utf8'));if(command.runId===runId&&command.status==='stop')resolve();}catch{}});process.once('SIGINT',resolve);process.once('SIGTERM',resolve);app.once('close',resolve);});
 result.status='stopped';result.finalDrafts=await page.evaluate(()=>window.noteApp.listProjectDrafts());
}catch(error){result.status='failed';result.error=String(error);}
finally{watcher?.close();if(app){result.modelCalls=await app.evaluate(()=>globalThis.__modelCalls??0).catch(()=>null);const pids=await app.evaluate(({app})=>app.getAppMetrics().map(m=>m.pid)).catch(()=>[]);pids.push(app.process().pid);await app.close().catch(()=>{});await assertTrackedProcessesExit([...new Set(pids)]);}
 result.cleanup=await fixture.cleanup();await writeFile(resultPath,JSON.stringify(result,null,2));}
if(result.status==='failed')process.exitCode=1;
