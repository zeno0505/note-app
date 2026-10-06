import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DemoStore } from './demo-store';
import { assertNoArguments, assertTrustedSender, parseDemoRequest } from './security';
import type { AppEnvironment } from '../shared/bridge';
import { loadLiveConfiguration } from './live-config';
import { createLiveRuntime } from './live-runtime';
import { boundedStartup } from './startup-boundary';
import { observeWindowActivity } from './window-activity';
import { createSummaryWorkflow } from '../summary/workflow';
import { createNoteLinkWorkflow } from '../collector/notes/link-workflow';
import type { Phase1Options } from '../shared/phase1-options';
let started=false;
/** Main-only test injection; normal entry has no environment or renderer gate. */
export function startHost(options: {summaryFactory?: typeof createSummaryWorkflow} = {}): void {
if(started) throw new Error('Host already started');started=true;
app.enableSandbox();
const rendererEntry = join(__dirname, '../renderer/index.html');
const entryUrl = pathToFileURL(rendererEntry).href;
let mainWindow: BrowserWindow | null = null;
const demoStore = new DemoStore();
let liveRuntime: ReturnType<typeof createLiveRuntime>;
let summaryWorkflow: ReturnType<typeof createSummaryWorkflow>;
const mutations=new Set<Promise<unknown>>();
const linkControllers=new Set<AbortController>();
function tracked<T>(pending: Promise<T>): Promise<T> {
  mutations.add(pending);void pending.then(()=>mutations.delete(pending),()=>mutations.delete(pending));return pending;
}
function linkOperation<T>(action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController();linkControllers.add(controller);
  return tracked(action(controller.signal).finally(()=>linkControllers.delete(controller)));
}
async function createWindow(): Promise<void> {
  const localSession = session.fromPartition('note-app-local');
  localSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  localSession.setPermissionCheckHandler(()=>false);
  localSession.webRequest.onBeforeRequest((details,callback)=>{
    const root = pathToFileURL(join(__dirname, '../renderer/')).href;
    callback({cancel: !details.url.startsWith(root)});
  });
  const window = new BrowserWindow({
    title:'note-app', width:1280, height:900, minWidth:760, minHeight:620,
    backgroundColor:'#f5f6f3', show:false,
    webPreferences:{
      preload:join(__dirname,'../preload/index.cjs'),
      contextIsolation:true, sandbox:true, nodeIntegration:false,
      webSecurity:true, webviewTag:false, session:localSession,
    },
  });
  mainWindow = window;
  observeWindowActivity(window,activity=>liveRuntime.setActivity(activity));
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.once('ready-to-show',()=>window.show());
  window.on('closed',()=>{mainWindow=null;demoStore.clear();void liveRuntime.disconnect();});
  await window.loadFile(rendererEntry);
}
app.whenReady().then(async()=>{
  const userData=app.getPath('userData');
  // Canonicalize the trusted Electron-owned parent once (macOS /var aliases included).
  // The cache adapter still rejects symlink descendants and ancestor replacement.
  const [configuration,cacheLocation]=await Promise.all([
    loadLiveConfiguration(process.env.NOTE_APP_CONFIG),
    boundedStartup((async()=>{
      await mkdir(userData,{recursive:true,mode:0o700});const root=join(await realpath(userData),'summary-cache');
      await mkdir(root,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(root)!==root
        ||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw new Error('Unsafe cache directory');
      return {path:root,available:true};
    })(),{path:join(userData,'summary-cache'),available:false}),
  ]);
  const cacheRoot=cacheLocation.path;
  liveRuntime=createLiveRuntime({configuration,cacheRoot,cacheAvailable:cacheLocation.available});
  summaryWorkflow=(options.summaryFactory??createSummaryWorkflow)({cacheRoot,resolveSource:async(workstreamId:string,signal:AbortSignal)=>{
    if(signal.aborted||!cacheLocation.available)throw new Error('App-owned cache unavailable or request cancelled');return liveRuntime.resolveSummarySource(workstreamId,signal);
  }});
  const linkConfig=configuration.configuration?.noteLink;
  const noteLink=linkConfig?createNoteLinkWorkflow({...linkConfig,resolveSelection:async(worktreeId:string,scopeId:string)=>liveRuntime.resolveNoteSelection(worktreeId,scopeId)}):null;
  summaryWorkflow.subscribe(view=>{if(mainWindow&&!mainWindow.webContents.isDestroyed())mainWindow.webContents.send('note-app:summary-changed',view);});
  liveRuntime.subscribe(state=>{
    if(mainWindow&&!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('note-app:live-changed',state);
  });
  for(const [channel,action] of [
    ['note-app:live-state',()=>liveRuntime.getState()],
    ['note-app:live-connect',()=>liveRuntime.connect()],
    ['note-app:live-refresh',()=>liveRuntime.refresh()],
    ['note-app:reading-summary-now',()=>liveRuntime.summarizeNow()],
    ['note-app:live-disconnect',()=>liveRuntime.disconnect()],
  ] as const) ipcMain.handle(channel,(event,...args)=>{
    if(!mainWindow) throw new Error('App window unavailable');
    assertTrustedSender(event,mainWindow.webContents,entryUrl);assertNoArguments(args);
    return action();
  });
  ipcMain.handle('note-app:environment',(event,...args)=>{
    if(!mainWindow) throw new Error('App window unavailable');
    assertTrustedSender(event,mainWindow.webContents,entryUrl); assertNoArguments(args);
    return {version:app.getVersion(),platform:process.platform,dataMode:configuration.configuration?'configured':'disabled',summaryBackend:'unconfigured',capabilities:{realOrca:!!configuration.configuration,noteWrites:!!noteLink,remoteSummary:false}} satisfies AppEnvironment;
  });
  ipcMain.handle('note-app:demo',(event,...args)=>{
    if(!mainWindow) throw new Error('App window unavailable');
    assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1) throw new Error('Expected one demo request');
    const {scenario}=parseDemoRequest(args[0]);
    return demoStore.read(scenario);
  });
  for(const [channel,action] of [
    ['note-app:summary-prepare',(request:unknown)=>summaryWorkflow.prepare(request)],
    ['note-app:summary-run',(request:unknown)=>tracked(summaryWorkflow.run(request))],
    ['note-app:summary-read',(request:unknown)=>summaryWorkflow.read(request)],
    ['note-app:summary-approve',(request:unknown)=>tracked(summaryWorkflow.approve(request))],
    ['note-app:summary-reject',(request:unknown)=>tracked(summaryWorkflow.reject(request))],
    ['note-app:summary-cancel',(request:unknown)=>summaryWorkflow.cancel(request)],
  ] as const)ipcMain.handle(channel,(event,...args)=>{
    if(!mainWindow)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one summary request');return action(args[0]);
  });
  ipcMain.handle('note-app:phase1-options',(event,...args)=>{
    if(!mainWindow)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);assertNoArguments(args);
    return {noteLinkConfigured:!!noteLink,noteLinkMessage:noteLink?'등록된 프로젝트 범위에 대한 연결 제안을 검토하고 확인할 수 있습니다.':'노트 연결 변경은 시작 설정의 noteLink 항목이 필요합니다.',
      noteScopes:configuration.configuration?.noteScopes.map(scope=>({scopeId:scope.scopeId,scopePath:scope.scopePath}))??[],summaryTransport:'blocked'} satisfies Phase1Options;
  });
  ipcMain.handle('note-app:note-link-preview',(event,...args)=>{
    if(!mainWindow)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one note preview request');if(!noteLink)throw new Error('Note link setup is not configured');return linkOperation(signal=>noteLink.preview(args[0],signal));
  });
  ipcMain.handle('note-app:note-link-confirm',(event,...args)=>{
    if(!mainWindow)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one note confirmation');if(!noteLink)throw new Error('Note link setup is not configured');
    return linkOperation(signal=>noteLink.confirm(args[0],signal).then(result=>{if(result.status!=='rejected')void liveRuntime.refresh();return result;}));
  });
  ipcMain.handle('note-app:note-link-cancel',(event,...args)=>{
    if(!mainWindow)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    const request=args[0];if(args.length!==1||!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==1||typeof request.proposalId!=='string'||request.proposalId.length>128)throw new Error('Invalid note cancellation');
    return {cancelled:noteLink?.cancel(request.proposalId)??false};
  });
  await createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0) void createWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin') app.quit();});
let waitingForMutation=false;
app.on('before-quit',event=>{
  for(const controller of linkControllers)controller.abort();
  if(mutations.size){event.preventDefault();if(!waitingForMutation){waitingForMutation=true;summaryWorkflow?.dispose();void Promise.allSettled([...mutations]).then(()=>{waitingForMutation=false;app.quit();});}return;}
  summaryWorkflow?.dispose();liveRuntime?.dispose();
});
}
