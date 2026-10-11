import {app,BrowserWindow,ipcMain} from 'electron';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {lstatSync,realpathSync,mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {assertTrustedSender} from '../../../src/main/security';
import {runScenario,scenarioNames,type Scenario} from './scenarios';
app.enableSandbox();
// Only the trusted parent test process selects this fresh, private fixture directory.
const root=process.env.NOTE_APP_CACHE_TEST_ROOT;
if(!root||resolve(root)!==root||dirname(root)!==realpathSync(tmpdir())||!basename(root).startsWith('note-app-cache-'))throw new Error('Owned temporary cache root required');
const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(root)!==root||(stat.mode&0o077)!==0)throw new Error('Unsafe fixture root');
const phase=process.env.NOTE_APP_CACHE_TEST_PHASE;if(phase!=='seed'&&phase!=='reopen')throw new Error('Fixed fixture phase required');
mkdirSync(join(root,'user-data'),{recursive:true,mode:0o700});app.setPath('userData',join(root,'user-data'));
const directory=resolve('tests/electron/cache-fixture');const entry=pathToFileURL(join(directory,'index.html')).href;
app.whenReady().then(async()=>{
 const window=new BrowserWindow({width:1080,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(__dirname,'cache-preload.cjs')}});
 window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
 let running=false;
 ipcMain.handle('cache-test:run',async(event,...args:unknown[])=>{
  assertTrustedSender(event,window.webContents,entry);
  if(args.length!==1||typeof args[0]!=='string'||!scenarioNames.includes(args[0] as Scenario))throw new Error('Invalid cache scenario');
  const scenario=args[0] as Scenario;
  if((scenario==='save')!==(phase==='seed'))throw new Error('Scenario unavailable in this fixture phase');
  if(running)throw new Error('Scenario already running');running=true;
  try{return await runScenario(scenario,root);}finally{running=false;}
 });
 await window.loadFile(join(directory,'index.html'));
});
app.on('window-all-closed',()=>app.quit());
