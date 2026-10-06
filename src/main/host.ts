import {createReadRoots,readRootsCodec} from './read-roots';
import {readInstallation,verificationProfile,allowInstallation,canonicalTargetVerified} from './install-identity';
import {trayIconPng} from './tray-icon';
import {finishQuit} from './quit-lifecycle';
import { app, BrowserWindow, ipcMain, session, shell, Tray, nativeImage, powerMonitor, Menu, dialog } from 'electron';
import { join } from 'node:path';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DemoStore } from './demo-store';
import { assertNoArguments, assertTrustedSender, parseDemoRequest } from './security';
import type { AppEnvironment } from '../shared/bridge';
import { loadLiveConfiguration } from './live-config';
import {createProjectRegistry,projectRegistryCodec} from './projects/registry';
import {createModelReadingStorage} from '../summary/reading/model-reading-storage';
import {createPublicModelController} from './public-model';
import {createProjectModelController} from './project-model';
import {createClaudePublicAdapter} from '../summary/reading/claude-public-adapter';
import publicReadingPack from '../shared/public-reading-pack.json';
import type {PublicReadingPack} from '../summary/reading/model-harness';
import {createLocalSummaryCache} from '../summary/storage';
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
const installation=readInstallation(app.isPackaged,process.platform,app.getAppPath(),app.getPath('home'));
if(installation.role==='verification'){
  const profile=verificationProfile(installation);
  app.setName('note-app Verification');app.setPath('userData',profile);app.setPath('sessionData',profile);
}else if(installation.role==='user'){
  app.setName('note-app');app.setPath('userData',join(app.getPath('appData'),'note-app'));
}
const rendererEntry = join(__dirname, '../renderer/index.html');
const entryUrl = pathToFileURL(rendererEntry).href;
let mainWindow: BrowserWindow | null = null;
let tray:Tray|null=null;
let quitting=false;
let projectModel:ReturnType<typeof createProjectModelController>|undefined;
let publicModel:ReturnType<typeof createPublicModelController>|undefined;
let quitSettled=false;
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
    title:installation.role==='verification'?'note-app Verification':'note-app', width:1280, height:900, minWidth:760, minHeight:620,
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
  window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
  window.on('closed',()=>{mainWindow=null;demoStore.clear();});
  await window.loadFile(rendererEntry);
}
async function showWindow():Promise<void>{if(quitting||!liveRuntime)return;if(!mainWindow||quitting){await createWindow();return;}if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}
app.whenReady().then(async()=>{
  const permitted=await allowInstallation(installation,{
    targetVerified:()=>canonicalTargetVerified(installation),
    warn:async canOpen=>(await dialog.showMessageBox({type:'warning',title:'note-app 설치 경로 확인',
      message:'이 복사본에서는 소스 관측과 AI 요약을 시작하지 않습니다.',
      detail:`실행 경로: ${installation.currentPath}\n사용자 설치 경로: ${installation.canonicalPath}\n빌드: ${installation.buildNumber??'미확인'} · ${installation.buildSha??'미확인'}\n${canOpen?'서명과 빌드를 확인한 설치본을 열 수 있습니다.':'검증된 설치본을 확인하지 못했습니다. 설치를 먼저 완료해 주세요.'}`,
      buttons:canOpen?['종료','설치된 note-app 열기']:['종료'],defaultId:0,cancelId:0})).response,
    openCanonical:()=>shell.openPath(installation.canonicalPath),
  });
  if(!permitted){app.quit();return;}
  const locked=app.requestSingleInstanceLock();if(!locked){app.quit();return;}
  app.on('second-instance',()=>{void showWindow();});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'note-app',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},{role:'editMenu'},{role:'windowMenu'}]));
  const userData=app.getPath('userData');
  const buildSha=installation.buildSha;
  // Canonicalize the trusted Electron-owned parent once (macOS /var aliases included).
  // The cache adapter still rejects symlink descendants and ancestor replacement.
  const [configuration,cacheLocation]=await Promise.all([
    loadLiveConfiguration(installation.role==='verification'?undefined:process.env.NOTE_APP_CONFIG??(app.isPackaged?join(process.resourcesPath,'live-config.json'):undefined)),
    boundedStartup((async()=>{
      await mkdir(userData,{recursive:true,mode:0o700});const root=join(await realpath(userData),'summary-cache');
      await mkdir(root,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(root)!==root
        ||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw new Error('Unsafe cache directory');
      return {path:root,available:true};
    })(),{path:join(userData,'summary-cache'),available:false}),
  ]);
  const cacheRoot=cacheLocation.path;
  const modelReading=createModelReadingStorage(join(userData,'model-reading'));
  const publicClaude=configuration.configuration?.publicModelClaudePath;
  const publicCwd=join(userData,'public-model-empty-workspace');
  if(publicClaude)await mkdir(publicCwd,{recursive:true,mode:0o700});
  publicModel=createPublicModelController(publicReadingPack as PublicReadingPack,modelReading,
    publicClaude?createClaudePublicAdapter(publicClaude,publicCwd,process.env):undefined);
  const projectPersistence=cacheLocation.available?await boundedStartup((async()=>{const directory=join(cacheRoot,'projects');await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw new Error('Unsafe project registry');return createLocalSummaryCache({directory,codec:projectRegistryCodec});})(),undefined):undefined;
  const projectRegistry=createProjectRegistry({persistence:projectPersistence??{read:async()=>null,write:async()=>{throw new Error('앱 프로젝트 상태 저장 위치를 사용할 수 없습니다.');}}});
  const readPersistence=cacheLocation.available?await boundedStartup((async()=>{
    const directory=join(cacheRoot,'read-permissions');await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw Error('Unsafe read permission directory');
    return createLocalSummaryCache({directory,codec:readRootsCodec});
  })(),undefined):undefined;
  const readRoots=createReadRoots({initialScopes:configuration.configuration?.noteScopes??[],hostId:configuration.configuration?.localHostId,persistence:readPersistence,unavailable:!readPersistence});
  await readRoots.load();
  liveRuntime=createLiveRuntime({configuration,cacheRoot,cacheAvailable:cacheLocation.available,projectRegistry,readRoots});
  projectModel=createProjectModelController({storage:modelReading,adapter:publicClaude?createClaudePublicAdapter(publicClaude,publicCwd,process.env):undefined,identify:id=>liveRuntime.identifyModelProject(id),revision:id=>liveRuntime.modelSourceRevision(id),resolve:async(id,signal,phase)=>{const source=await liveRuntime.resolveSummarySource(id,signal,phase==='revalidate');if(!source.readingSummary||liveRuntime.getState().dags.find(d=>d.dagId===source.dag.dagId)?.sourceHash!==source.dag.sourceHash)throw Error('Current reading source unavailable');return {...source,readingSummary:source.readingSummary};}});
  function makeSummaryWorkflow(){const workflow=(options.summaryFactory??createSummaryWorkflow)({cacheRoot,resolveSource:async(workstreamId:string,signal:AbortSignal)=>{
    if(signal.aborted||!cacheLocation.available)throw new Error('App-owned cache unavailable or request cancelled');return liveRuntime.resolveSummarySource(workstreamId,signal);
  }});workflow.subscribe(view=>{if(mainWindow&&!mainWindow.webContents.isDestroyed())mainWindow.webContents.send('note-app:summary-changed',view);});return workflow;}
  summaryWorkflow=makeSummaryWorkflow();
  const linkConfig=configuration.configuration?.noteLink;
  const noteLink=linkConfig?createNoteLinkWorkflow({...linkConfig,resolveSelection:async(worktreeId:string,scopeId:string)=>liveRuntime.resolveNoteSelection(worktreeId,scopeId)}):null;
  liveRuntime.subscribe(state=>{
    projectModel?.invalidate();
    if(mainWindow&&!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('note-app:live-changed',state);
  });
  let changingReadRoots=false,pickingReadRoot=false;
  function checkReadSender(event:Electron.IpcMainInvokeEvent){if(!mainWindow||quitting)throw Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);}
  ipcMain.handle('note-app:read-roots',(event,...args)=>{checkReadSender(event);assertNoArguments(args);return readRoots.view();});
  ipcMain.handle('note-app:read-root-select',async(event,...args)=>{
    checkReadSender(event);assertNoArguments(args);if(pickingReadRoot||changingReadRoots)throw Error('폴더 선택이 진행 중입니다.');pickingReadRoot=true;
    try{const result=await dialog.showOpenDialog(mainWindow!,{title:'노트 읽기를 허용할 폴더 선택',properties:['openDirectory'],buttonLabel:'읽기 범위 검토'});if(result.canceled||result.filePaths.length!==1)return null;return await readRoots.prepare(result.filePaths[0]);}finally{pickingReadRoot=false;}
  });
  ipcMain.handle('note-app:read-root-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Expected one cancellation');readRoots.cancel(args[0]);});
  async function changeReadRoots(action:()=>Promise<unknown>){if(changingReadRoots)throw Error('권한 변경이 진행 중입니다.');changingReadRoots=true;
    try{for(const controller of linkControllers)controller.abort();await publicModel?.cancel();projectModel?.cancel();summaryWorkflow.dispose();await liveRuntime.invalidateReadRoots();return await action();}
    finally{summaryWorkflow=makeSummaryWorkflow();changingReadRoots=false;}
  }
  ipcMain.handle('note-app:read-root-confirm',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Expected one confirmation');return tracked(changeReadRoots(()=>readRoots.confirm(args[0])));});
  ipcMain.handle('note-app:read-root-revoke',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Expected one revocation');return tracked(changeReadRoots(()=>readRoots.revoke(args[0])));});
  for(const [channel,action] of [
    ['note-app:live-state',()=>liveRuntime.getState()],
    ['note-app:live-connect',()=>liveRuntime.connect()],
    ['note-app:live-refresh',()=>liveRuntime.refresh()],
    ['note-app:reading-summary-now',()=>liveRuntime.summarizeNow()],
    ['note-app:public-model-review',async()=>(await publicModel!.view()).latest],
    ['note-app:public-model-state',()=>publicModel!.view()],
    ['note-app:public-model-run',()=>publicModel!.run()],
    ['note-app:public-model-cancel',()=>publicModel!.cancel()],
    ['note-app:live-disconnect',()=>{projectModel?.cancel();return liveRuntime.disconnect();}],
  ] as const) ipcMain.handle(channel,(event,...args)=>{
    if(!mainWindow||quitting) throw new Error('App window unavailable');
    assertTrustedSender(event,mainWindow.webContents,entryUrl);assertNoArguments(args);
    if(changingReadRoots&&channel!=='note-app:live-state')throw Error('읽기 권한 변경이 진행 중입니다.');
    return action();
  });
  for(const [channel,action] of [
    ['note-app:project-model-state',(id:string)=>projectModel!.view(id)],
    ['note-app:project-model-run',(id:string)=>projectModel!.run(id)],
    ['note-app:project-model-cancel',(id:string)=>{projectModel!.cancel(id);return projectModel!.view(id);}],
  ] as const)ipcMain.handle(channel,(event,...args)=>{
    if(!mainWindow||quitting||changingReadRoots)throw Error('App unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1||!args[0]||typeof args[0]!=='object'||Array.isArray(args[0])||Object.keys(args[0]).sort().join(',')!==(channel==='note-app:project-model-run'?'transferConfirmed,workstreamId':'workstreamId')||(channel==='note-app:project-model-run'&&args[0].transferConfirmed!==true)||typeof args[0].workstreamId!=='string'||args[0].workstreamId.length>256)throw Error('Invalid project model selection');
    return tracked(action(args[0].workstreamId));
  });
  ipcMain.handle('note-app:project-document-open',async(event,...args)=>{
    if(!mainWindow||quitting)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);if(args.length!==1)throw new Error('Expected one document selection');const uri=await liveRuntime.resolveDocumentLink(args[0]);await shell.openExternal(uri);
  });
  ipcMain.handle('note-app:project-connection-confirm',(event,...args)=>{
    if(!mainWindow||quitting)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);if(args.length!==1)throw new Error('Expected one connection selection');return tracked(liveRuntime.confirmProjectConnection(args[0]));
  });
  ipcMain.handle('note-app:project-status',(event,...args)=>{
    if(!mainWindow||quitting)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one project status request');return tracked(liveRuntime.setProjectStatus(args[0]));
  });
  ipcMain.handle('note-app:environment',(event,...args)=>{
    if(!mainWindow||quitting) throw new Error('App window unavailable');
    assertTrustedSender(event,mainWindow.webContents,entryUrl); assertNoArguments(args);
    return {version:app.getVersion(),buildSha,buildNumber:installation.buildNumber,installationRole:installation.role,
      installationPath:installation.currentPath,canonicalInstallationPath:installation.canonicalPath,
      platform:process.platform,dataMode:configuration.configuration?'configured':'disabled',summaryBackend:'unconfigured',capabilities:{realOrca:!!configuration.configuration,noteWrites:!!noteLink,remoteSummary:false}} satisfies AppEnvironment;
  });
  ipcMain.handle('note-app:demo',(event,...args)=>{
    if(!mainWindow||quitting) throw new Error('App window unavailable');
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
    if(!mainWindow||quitting)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one summary request');return action(args[0]);
  });
  ipcMain.handle('note-app:phase1-options',(event,...args)=>{
    if(!mainWindow||quitting)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);assertNoArguments(args);
    return {noteLinkConfigured:!!noteLink,noteLinkMessage:noteLink?'등록된 프로젝트 범위에 대한 연결 제안을 검토하고 확인할 수 있습니다.':'노트 연결 변경은 시작 설정의 noteLink 항목이 필요합니다.',
      noteScopes:configuration.configuration?.noteScopes.map(scope=>({scopeId:scope.scopeId,scopePath:scope.scopePath}))??[],summaryTransport:'blocked'} satisfies Phase1Options;
  });
  ipcMain.handle('note-app:note-link-preview',(event,...args)=>{
    if(!mainWindow||quitting)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one note preview request');if(!noteLink)throw new Error('Note link setup is not configured');return linkOperation(signal=>noteLink.preview(args[0],signal));
  });
  ipcMain.handle('note-app:note-link-confirm',(event,...args)=>{
    if(!mainWindow||quitting)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one note confirmation');if(!noteLink)throw new Error('Note link setup is not configured');
    return linkOperation(signal=>noteLink.confirm(args[0],signal).then(result=>{if(result.status!=='rejected')void liveRuntime.refresh();return result;}));
  });
  ipcMain.handle('note-app:note-link-cancel',(event,...args)=>{
    if(!mainWindow||quitting)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    const request=args[0];if(args.length!==1||!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==1||typeof request.proposalId!=='string'||request.proposalId.length>128)throw new Error('Invalid note cancellation');
    return {cancelled:noteLink?.cancel(request.proposalId)??false};
  });
  const image=nativeImage.createFromBuffer(Buffer.from(trayIconPng,'base64'));image.setTemplateImage(true);tray=new Tray(image);tray.setToolTip('note-app');tray.on('click',()=>{void showWindow();});
  powerMonitor.on('suspend',()=>liveRuntime.setSuspended(true));powerMonitor.on('resume',()=>liveRuntime.setSuspended(false));
  await createWindow();
  if(configuration.view.state==='ready')void liveRuntime.connect();
  app.on('activate',()=>{void showWindow();});
});
// A retained tray owns the app lifetime; only explicit quit terminates collection.
app.on('window-all-closed',()=>{});
app.on('before-quit',event=>{
  quitting=true;for(const controller of linkControllers)controller.abort();publicModel?.dispose();projectModel?.dispose();summaryWorkflow?.dispose();liveRuntime?.dispose();
  if(!quitSettled){event.preventDefault();if(waitingForMutation)return;waitingForMutation=true;
    void finishQuit([...mutations,publicModel?.settle()??Promise.resolve(),projectModel?.settle()??Promise.resolve(),liveRuntime?.settleRegistry()??Promise.resolve()],()=>{quitSettled=true;tray?.destroy();tray=null;app.quit();});
  }
});
let waitingForMutation=false;
}
