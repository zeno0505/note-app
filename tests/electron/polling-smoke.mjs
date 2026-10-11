import {_electron as electron} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {buildIdentity,assertTrackedProcessesExit} from './evidence.mjs';
const evidence=path.resolve('reviews/evidence');await mkdir(evidence,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let app;const samples=[];
try{
 app=await electron.launch({chromiumSandbox:true,args:[path.resolve('dist/electron-tests/polling-main.cjs')],env:{...process.env,NOTE_APP_TEST_NODE:process.execPath},timeout:30000});
 const page=await app.firstWindow();await page.getByRole('button',{name:'Start 20-second polling'}).click();
 await page.waitForFunction(()=>document.querySelector('#state').textContent.includes('"inflight": 0')&&document.querySelector('#state').textContent.includes('"loads": 1'));
 const initial=await page.evaluate(()=>window.pollTest.stats());samples.push({stage:'initial',...initial});assert.equal(initial.loads,1);assert.equal(initial.freshness,'current');assert.equal(initial.coverage,'unknown');
 await pause(21500);const active=await page.evaluate(()=>window.pollTest.stats());samples.push({stage:'active-after-21.5s',...active});assert.equal(active.loads,2);assert.equal(active.inflight,0);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());const hiddenStart=await page.evaluate(()=>window.pollTest.stats());samples.push({stage:'hidden-start',...hiddenStart});assert.equal(hiddenStart.visible,false);assert.equal(hiddenStart.nextPollAt,null);
 await pause(22000);const hidden=await page.evaluate(()=>window.pollTest.stats());samples.push({stage:'hidden-after-22s',...hidden});assert.equal(hidden.loads,active.loads);assert.equal(hidden.observedAt,active.observedAt);
 await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.show();window.focus();});
 await page.waitForFunction(()=>{const state=JSON.parse(document.querySelector('#state').textContent);return state.loads===3&&state.inflight===0&&state.freshness==='current';});
 const resumed=await page.evaluate(()=>window.pollTest.stats());samples.push({stage:'resumed',...resumed});assert.equal(resumed.loads,3);assert(resumed.observedAt>active.observedAt);assert.equal(resumed.coverage,'unknown');
 await page.screenshot({path:path.join(evidence,'T-010-resumed.png')});
 const pending=await page.evaluate(()=>window.pollTest.stall());assert.equal(pending.inflight,1);
 await page.waitForFunction(()=>{const state=JSON.parse(document.querySelector('#state').textContent);return state.freshness==='stale'&&state.inflight===1&&state.staleAfterMs===1000;});
 const stale=await page.evaluate(()=>window.pollTest.stats());samples.push({stage:'stale-notification-during-pending-read',...stale});
 await page.screenshot({path:path.join(evidence,'T-010-pending-stale.png')});
 const cleanup=await page.evaluate(()=>window.pollTest.cleanup());assert.equal(cleanup.disposed,true);
 const pids=await app.evaluate(({app})=>app.getAppMetrics().map(metric=>metric.pid));await app.close();app=undefined;await assertTrackedProcessesExit(pids);
 const result={status:'passed',observedAt:new Date().toISOString(),codeIdentity:await buildIdentity(),samples,checks:['20-second active cadence observed','No new collection during 22-second native hidden interval','Immediate successful refresh on native show/focus; timestamp advanced','Unknown project coverage preserved','One-second test-only freshness deadline publishes stale while real synthetic subprocess is pending','Dispose, temporary fixture cleanup and tracked process exit'],scope:'Actual Linux Electron window hide/show with synthetic CLI, real wall-clock waits; not macOS background policy or real Orca',visualReview:'Pending separate image opening'};
 await writeFile(path.join(evidence,'T-010-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{if(app)await app.close();}
