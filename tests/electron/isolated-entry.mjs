import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Test-only bootstrap: macOS does not use XDG_CONFIG_HOME for Electron userData.
 * Both host entries must share one explicit fixture profile before app readiness.
 * The caller removes fixtureRoot after every owned Electron process exits.
 */
export async function isolatedEntry(fixtureRoot,profile,mainEntry,{background=process.env.NOTE_APP_E2E_BACKGROUND==='1'}={}) {
  await mkdir(profile,{recursive:true,mode:0o700});
  const entry=await mkdtemp(path.join(fixtureRoot,'electron-entry-'));
  await writeFile(path.join(entry,'package.json'),JSON.stringify({name:'note-app',version:'0.1.0',main:'bootstrap.cjs'}));
  await writeFile(path.join(entry,'bootstrap.cjs'),
    `const {app}=require('electron');${background?"if(process.platform==='darwin')app.setActivationPolicy('accessory');app.on('browser-window-created',(_,w)=>{w.setFocusable(false);w.setOpacity(0);w.show=()=>w.showInactive();});":''}app.setPath('userData',${JSON.stringify(path.resolve(profile))});app.setName('note-app');require(${JSON.stringify(path.resolve(mainEntry))});`);
  return entry;
}
