import {app,BrowserWindow,ipcMain} from 'electron';
import {join,resolve,dirname} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createOrcaAdapter} from '../../../src/collector/orca';
import {createOrcaSnapshotStore,type OrcaSnapshotStore} from '../../../src/collector/snapshot';
import {fixture,cleanup} from '../collector-fixture/setup';
import {assertTrustedSender,assertNoArguments} from '../../../src/main/security';
app.enableSandbox();
const directory=resolve('tests/electron/polling-fixture');const entry=pathToFileURL(join(directory,'index.html')).href;
let window:BrowserWindow;let store:OrcaSnapshotStore|null=null;let loads=0;let inflight=0;let disposed=false;
let staleAfterMs=40000;
const startedAt=Date.now();const samples:unknown[]=[];
function stats(){const state=store?.getState();return {elapsedMs:Date.now()-startedAt,loads,inflight,visible:window.isVisible(),active:state?.active??false,freshness:state?.freshness??'unknown',observedAt:state?.observedAt??null,lastAttempt:state?.lastAttempt??null,lastSuccessAt:state?.lastSuccessAt??null,coverage:state?.coverage?.state??'unknown',nextPollAt:state?.nextPollAt??null,intervalMs:20000,staleAfterMs};}
function publish(){if(!window.isDestroyed())window.webContents.send('poll-test:state',stats());}
app.whenReady().then(async()=>{
  window=new BrowserWindow({width:980,height:760,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(__dirname,'polling-preload.cjs')}});window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
  const trusted=(event:Electron.IpcMainInvokeEvent,args:unknown[])=>{assertTrustedSender(event,window.webContents,entry);assertNoArguments(args);};
  const visible=()=>{store?.setActivity({visible:window.isVisible(),active:window.isFocused()});publish();};
  window.on('show',visible);window.on('hide',visible);window.on('focus',visible);window.on('blur',visible);
  ipcMain.handle('poll-test:start',async(event,...args)=>{
    trusted(event,args);if(store)return stats();
    const setup=await fixture('normal');const adapter=createOrcaAdapter({executablePath:setup.executable,timeoutMs:2000});
    store=createOrcaSnapshotStore({intervalMs:20000,active:window.isFocused(),visible:window.isVisible(),load:async options=>{loads++;inflight++;publish();try{return await adapter.collect(options);}finally{inflight--;}}});
    store.subscribe(()=>publish());await store.start();const result=stats();samples.push(result);return result;
  });
  ipcMain.handle('poll-test:stall',async(event,...args)=>{
    trusted(event,args);store?.dispose();while(inflight>0)await new Promise(resolve=>setTimeout(resolve,20));
    const setup=await fixture('normal');const adapter=createOrcaAdapter({executablePath:setup.executable,timeoutMs:3000});staleAfterMs=1000;
    store=createOrcaSnapshotStore({intervalMs:20000,staleAfterMs,active:window.isFocused(),visible:window.isVisible(),load:async options=>{loads++;inflight++;publish();try{return await adapter.collect(options);}finally{inflight--;}}});
    store.subscribe(()=>publish());await store.start();
    await writeFile(join(dirname(setup.executable),'mode.json'),JSON.stringify({kind:'hang',query:'projects'}));
    void store.refresh();return stats();
  });
  ipcMain.handle('poll-test:stats',(event,...args)=>{trusted(event,args);const result=stats();samples.push(result);return result;});
  ipcMain.handle('poll-test:cleanup',async(event,...args)=>{trusted(event,args);store?.dispose();disposed=true;while(inflight>0)await new Promise(resolve=>setTimeout(resolve,20));await cleanup();return {samples,disposed};});
  await window.loadFile(join(directory,'index.html'));
});
let quitPrepared=false;
app.on('before-quit',event=>{
 if(quitPrepared)return;event.preventDefault();store?.dispose();
 void(async()=>{const deadline=Date.now()+6000;while(inflight>0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));await cleanup();quitPrepared=true;app.quit();})().catch(()=>{console.error('Polling fixture cleanup failed');app.exit(1);});
});
app.on('window-all-closed',()=>app.quit());
