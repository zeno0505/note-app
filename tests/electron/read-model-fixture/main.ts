import {app,BrowserWindow,ipcMain} from 'electron';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertTrustedSender,assertNoArguments} from '../../../src/main/security';
import {createFixture,scenarios,type Scenario} from './fixture';
app.enableSandbox();const directory=resolve('tests/electron/read-model-fixture'),entry=pathToFileURL(join(directory,'index.html')).href;
let fixture:Awaited<ReturnType<typeof createFixture>>|undefined;let cleaned=false;
app.whenReady().then(async()=>{
 fixture=await createFixture();const window=new BrowserWindow({width:1100,height:920,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(__dirname,'read-model-preload.cjs')}});window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
 const trusted=(event:Electron.IpcMainInvokeEvent,args:unknown[])=>{assertTrustedSender(event,window.webContents,entry);assertNoArguments(args);};
 ipcMain.handle('read-model:run',async(event,...args:unknown[])=>{assertTrustedSender(event,window.webContents,entry);if(args.length!==1||typeof args[0]!=='string'||!scenarios.includes(args[0] as Scenario))throw new Error('Invalid read-model scenario');return fixture!.run(args[0] as Scenario);});
 ipcMain.handle('read-model:pulse',async(event,...args)=>{trusted(event,args);return {responsive:true,...await fixture!.stats()};});
 ipcMain.handle('read-model:cancel',(event,...args)=>{trusted(event,args);return fixture!.cancel();});
 ipcMain.handle('read-model:cleanup',async(event,...args)=>{trusted(event,args);const result=await fixture!.cleanup();cleaned=true;return result;});
 await window.loadFile(join(directory,'index.html'));
}).catch(error=>{console.error(error);app.exit(1);});
let quitting=false;app.on('before-quit',event=>{if(quitting||cleaned)return;event.preventDefault();void(async()=>{await fixture?.cleanup();quitting=true;app.quit();})().catch(error=>{console.error(error);app.exit(1);});});app.on('window-all-closed',()=>app.quit());
