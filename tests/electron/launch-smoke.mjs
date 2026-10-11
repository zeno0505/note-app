import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {assertTrackedProcessesExit} from './evidence.mjs';
const evidence = path.resolve('reviews/evidence');
await mkdir(evidence, { recursive: true });
let app;
const start = performance.now();
try {
  app = await electron.launch({ chromiumSandbox: true, args: [path.resolve('tests/electron/fixture/main.cjs')], timeout: 30000 });
  const pid = app.process().pid;
  const page = await app.firstWindow();
  await page.getByRole('button', {name: 'Check IPC'}).click();
  await page.getByText('IPC verified', {exact:false}).waitFor();
  const security = await app.evaluate(({BrowserWindow}) => {
    const win = BrowserWindow.getAllWindows()[0];
    const {sandbox,contextIsolation,nodeIntegration} = win.webContents.getLastWebPreferences();
    return {sandbox,contextIsolation,nodeIntegration,versions:process.versions,argv:process.argv};
  });
  assert.equal(security.sandbox, true);
  assert.equal(security.contextIsolation, true);
  assert.equal(security.nodeIntegration, false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await assert.rejects(page.evaluate(() => window.harness.ping('malformed')), /Invalid request/);
  await page.getByRole('button', {name:'Check IPC'}).click();
  await page.screenshot({ path: path.join(evidence, 'T-027-electron-smoke.png') });
  const result = { status:'passed', pid, observedAt:new Date().toISOString(), launchAndInteractionMs:performance.now()-start, security, screenshot:'T-027-electron-smoke.png', visuallyReviewed:false, scope:'Actual Linux Electron development shell; not macOS or product feature QA' };
  const trackedPids=await app.evaluate(({app})=>app.getAppMetrics().map(metric=>metric.pid));
  await app.close(); app = undefined;
  await assertTrackedProcessesExit([...new Set([pid,...trackedPids])]);
  result.trackedPids=trackedPids;
  result.closed = true;
  await writeFile(path.join(evidence,'T-027-result.json'), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally { if(app) await app.close(); }
