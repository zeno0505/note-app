/** Fresh goal-based review, no prior defect list or navigation state is seeded. */
import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPhase4Fixture} from './phase4-fixture/setup.mjs';
import {isolatedEntry} from './isolated-entry.mjs';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';
const fixture=await createPhase4Fixture(),runId=randomUUID();
const control=path.resolve(process.env.NOTE_APP_REVIEW_CONTROL);
const resultPath=path.join(path.dirname(control),'persona-runtime-result.json');
const result={runId,status:'starting',category:'actual app interaction',fixtureOnly:true,identity:await buildIdentity(),dimensions:fixture.dimensions,modelCalls:null,externalRequests:[]};
let app,watcher;
try{
 await mkdir(path.dirname(control),{recursive:true});const home=path.join(fixture.root,'isolated-home');await mkdir(home,{recursive:true});
 const entry=await isolatedEntry(fixture.root,path.join(fixture.profile,'note-app'),'dist/main/index.cjs');
 app=await electron.launch({chromiumSandbox:true,args:[entry],env:{...process.env,HOME:home,NOTE_APP_CONFIG:fixture.configPath}});const page=await app.firstWindow();
 await page.getByTestId('new-project').waitFor();
 await app.evaluate(()=>{const cp=process.getBuiltinModule('child_process'),spawn=cp.spawn;globalThis.__phase4ModelCalls=0;cp.spawn=function(executable,args,...rest){if(args?.includes('-p')||args?.includes('--prompt')||args?.includes('--agent')){globalThis.__phase4ModelCalls++;throw Error('Model execution forbidden in synthetic document review');}return spawn.call(this,executable,args,...rest);};});
 page.on('request',request=>{if(/^https?:/i.test(request.url()))result.externalRequests.push(request.url());});
 result.security=await app.evaluate(({BrowserWindow})=>{const preferences=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return{sandbox:preferences.sandbox,contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration,webSecurity:preferences.webSecurity,argv:process.argv};});
 if(!result.security.sandbox||!result.security.contextIsolation||result.security.nodeIntegration||!result.security.webSecurity||result.security.argv.some(x=>x.includes('no-sandbox')))throw Error('Runtime security invariant failed');
 await app.evaluate(({dialog})=>{const original=dialog.showOpenDialog;globalThis.__phase4PickerObservations=[];dialog.showOpenDialog=async function(...args){try{const result=await original.apply(this,args);globalThis.__phase4PickerObservations.push({canceled:result.canceled,filePaths:result.filePaths});return result;}catch(error){globalThis.__phase4PickerObservations.push({error:String(error)});throw error;}};});
 result.status='ready';await writeFile(control,JSON.stringify({runId,status:'ready',fixtureRoot:fixture.root,extraRoot:fixture.extraRoot,pid:app.process().pid}));await writeFile(resultPath,JSON.stringify(result,null,2));
 await new Promise(resolve=>{watcher=watch(path.dirname(control),async(_event,name)=>{if(name!==path.basename(control))return;try{const command=JSON.parse(await readFile(control,'utf8'));if(command.runId===runId&&command.status==='stop')resolve();}catch{}});process.once('SIGINT',resolve);process.once('SIGTERM',resolve);app.once('close',resolve);});
 result.status='stopped';result.finalState=await page.evaluate(async()=>{const state=await window.noteApp.getLiveState();return{connection:state.connection,workstreams:state.workstreams.length};});
}catch(error){result.status='failed';result.error=String(error);}
finally{watcher?.close();if(app){result.nativePickerObservations=await app.evaluate(()=>globalThis.__phase4PickerObservations??[]).catch(()=>[]);result.modelCalls=await app.evaluate(()=>globalThis.__phase4ModelCalls??0).catch(()=>null);const pids=await app.evaluate(({app})=>app.getAppMetrics().map(m=>m.pid)).catch(()=>[]);pids.push(app.process().pid);await app.close().catch(()=>{});await assertTrackedProcessesExit([...new Set(pids)]);}result.cleanup=await fixture.cleanup();await writeFile(resultPath,JSON.stringify(result,null,2));}
if(result.status==='failed')process.exitCode=1;
