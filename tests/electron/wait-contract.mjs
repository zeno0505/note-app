import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {waitUntil} from './wait-until.mjs';
import {assertTrackedProcessesExit} from './evidence.mjs';

let app;const report={platform:process.platform};
try {
  app=await electron.launch({chromiumSandbox:true,args:[path.resolve('dist/electron-tests/polling-main.cjs')],timeout:30000});
  const page=await app.firstWindow();
  const began=performance.now();
  try {const result=await page.waitForFunction(async()=>false,{}, {timeout:500});report.asyncFalseReturned=true;report.asyncFalseValue=await result.jsonValue();}
  catch(error){if(error.name!=='TimeoutError')throw error;report.asyncFalseReturned=false;}
  report.asyncFalseElapsedMs=Math.round(performance.now()-began);
  const correctedAt=performance.now();
  await assert.rejects(waitUntil(()=>page.evaluate(async()=>false),Boolean,'false IPC probe',500),/Timed out/);
  report.explicitAwaitElapsedMs=Math.round(performance.now()-correctedAt);
  assert(report.explicitAwaitElapsedMs>=450);
  report.status='passed';
} finally {
  if(app){const pids=await app.evaluate(({app})=>app.getAppMetrics().map(m=>m.pid));pids.push(app.process().pid);await app.close();await assertTrackedProcessesExit(pids);report.electronExited=true;}
  await mkdir('reviews/evidence',{recursive:true});await writeFile('reviews/evidence/wait-contract.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
