import {app,BrowserWindow,ipcMain} from 'electron';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertTrustedSender} from '../../../src/main/security';
import {runScenario,scenarioNames,type Scenario} from './scenarios';
app.enableSandbox();
const directory=resolve('tests/electron/summary-fixture');const entry=pathToFileURL(join(directory,'index.html')).href;
app.whenReady().then(async()=>{
 const window=new BrowserWindow({width:1080,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(__dirname,'summary-preload.cjs')}});
 window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
 ipcMain.handle('summary-test:run',(event,...args:unknown[])=>{
  assertTrustedSender(event,window.webContents,entry);
  if(args.length!==1||typeof args[0]!=='string'||!scenarioNames.includes(args[0] as Scenario))throw new Error('Invalid summary scenario');
  return runScenario(args[0] as Scenario);
 });
 await window.loadFile(join(directory,'index.html'));
});
app.on('window-all-closed',()=>app.quit());
