import {createGitMetadataReadGrants,gitMetadataReadGrantsCodec} from './git-metadata-grants';
import {createGitActivityIndex,gitActivityIndexCodec,type GitActivityIndexInput} from './git-activity-index';
import {gitActivityObjectRevision,readGitActivityReferences} from '../summary/reading/git-activity-metadata';
import {parseGetGitMetadataReadStateRequest,parseSelectGitMetadataReadScopeRequest,parseConfirmGitMetadataReadScopeRequest,parseCancelGitMetadataReadScopeRequest,parseRevokeGitMetadataReadScopeRequest} from '../shared/git-metadata-grants';
import type {DagTask} from '../facts/dag-read-model/types';
import type {ActivityCoverage,TaskActivity} from '../summary/reading/recent-tasks';
import {createHash} from 'node:crypto';
import {createSummaryReview,parseSummarySelectionRequest} from './summary-review';
import {summaryAutomationCodec} from './summary-automation';
import {readSummaryModelIdentity} from './summary-model-identity';
import type {SummaryModelIdentity} from '../summary/reading/claude-account-identity';
import {PROJECT_MODEL_VERSION} from '../summary/reading/model-harness';
import {prepareDocumentRootAfterPicker} from './phase4/document-root-picker';
import {createProjectDocumentRoots,projectDocumentRootsCodec} from './project-document-roots';
import {parseGetProjectDocumentRootsRequest,parseSelectProjectDocumentRootRequest} from '../shared/project-document-roots';
import {refreshAfterProjectPicker} from './project-creation-refresh';
import {matchProjectCreationWorkspace} from './project-creation-selection';
import {createProjectDagCreation} from './project-dag';
import {createProjectDagWriter} from './project-dag-writer';
import {validateProjectDagSource} from './project-dag-source';
import {parseProjectCreationRequest} from '../shared/project-creation';
import {parseConfirmProjectDagRequest,parseCancelProjectDagRequest} from '../shared/project-dag';
import {createOrcaProjectOpener} from './orca-project-open';
import {parseOrcaProjectOpenRequest} from '../shared/orca-project-open';
import {updateStartupAllowed} from './update-startup';
import {createUpdateCleanupGate} from './update-cleanup';
import {persistentConfiguration} from './persistent-config';
import {acknowledgeUpdateBoot} from './update-boot';
import {createUpdateService,type UpdateService} from './update-service';
import {projectAppMemory} from '../phase2/app-memory';
import {createWorkspaceStateStore,workspaceStateCodec} from './workspace-state';
import {createProjectDraftStore,projectDraftCodec} from './project-drafts';
import {reconnectReadiness} from '../shared/reconnect-readiness';
import {createModelRetryStorage} from '../summary/reading/model-retry-storage';
import {createNoteReconnect} from './note-reconnect';
import {createDagCandidateScanner} from './dag-candidates';
import {createReadRoots,readRootsCodec} from './read-roots';
import {readInstallation,verificationProfile,allowInstallation,canonicalTargetVerified} from './install-identity';
import {trayIconPng} from './tray-icon';
import {finishQuit} from './quit-lifecycle';
import { app, BrowserWindow, ipcMain, session, shell, Tray, nativeImage, powerMonitor, Menu, dialog } from 'electron';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DemoStore } from './demo-store';
import { assertNoArguments, assertTrustedSender, parseDemoRequest } from './security';
import type { AppEnvironment } from '../shared/bridge';
import { loadLiveConfiguration } from './live-config';
import {createProjectRegistry,projectRegistryCodec} from './projects/registry';
import {createModelReadingStorage} from '../summary/reading/model-reading-storage';
import {createPublicModelController} from './public-model';
import {createModelDiagnostics} from './model-diagnostics';
import {createProjectModelController} from './project-model';
import {createClaudePublicAdapter} from '../summary/reading/claude-public-adapter';
import publicReadingPack from '../shared/public-reading-pack.json';
import type {PublicReadingPack,ModelAdapter} from '../summary/reading/model-harness';
import {createLocalSummaryCache} from '../summary/storage';
import { createLiveRuntime } from './live-runtime';
import { boundedStartup } from './startup-boundary';
import { observeWindowActivity } from './window-activity';
import { createSummaryWorkflow } from '../summary/workflow';
import { createNoteLinkWorkflow } from '../collector/notes/link-workflow';
import type { Phase1Options } from '../shared/phase1-options';
let started=false;
/** Main-only test injection; normal entry has no environment or renderer gate. */
export function startHost(options: {summaryFactory?: typeof createSummaryWorkflow;updateService?:UpdateService;updateServiceFactory?:typeof createUpdateService;summaryModelAdapter?:ModelAdapter;summaryModelIdentity?:()=>Promise<SummaryModelIdentity>} = {}): void {
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
let updateQuiescing=false;
let projectModel:ReturnType<typeof createProjectModelController>|undefined;
let summaryReview:ReturnType<typeof createSummaryReview>|undefined;
let gitMetadataGrants:ReturnType<typeof createGitMetadataReadGrants>|undefined;
let gitActivityIndex:ReturnType<typeof createGitActivityIndex>|undefined;
let nativeSummaryActivity={visible:false,active:false};
let publicModel:ReturnType<typeof createPublicModelController>|undefined;
let quitSettled=false;
let metadataQuitPrepared=false,metadataQuitPreparing=false;
let projectCreation:ReturnType<typeof createProjectDagCreation>|undefined;
let projectCreationBusy=false;
let orcaProjectOpener:ReturnType<typeof createOrcaProjectOpener<string>>|undefined;
let updateService:UpdateService|undefined;
let updateQuitReady:(()=>Promise<void>)|undefined;
const demoStore = new DemoStore();
let liveRuntime: ReturnType<typeof createLiveRuntime>;
let summaryWorkflow: ReturnType<typeof createSummaryWorkflow>;
const mutations=new Set<Promise<unknown>>();
const hostCleanup=createUpdateCleanupGate();
const projectSourceOperations=new Set<Promise<unknown>>();
function trackProjectSource<T>(operation:Promise<T>):Promise<T>{const pending=hostCleanup.track('project-source-read',()=>operation,{fulfilled:()=>true,rejected:()=>true});projectSourceOperations.add(pending);void pending.then(()=>projectSourceOperations.delete(pending),()=>projectSourceOperations.delete(pending));return pending;}
function owned<T>(area:string,operation:()=>Promise<T>){return hostCleanup.track(area,operation,{rejected:()=>false});}
function startup<T>(operation:Promise<T>,fallback:T){return boundedStartup(owned('startup',()=>operation),fallback);}
function persistence<T extends {read:(...args:any[])=>Promise<any>;write:(...args:any[])=>Promise<any>}>(value:T):T{return {...value,read:(...args:any[])=>owned('settings-read',()=>value.read(...args)),write:(...args:any[])=>owned('settings-write',()=>value.write(...args))};}
const linkControllers=new Set<AbortController>();
function tracked<T>(pending: Promise<T>): Promise<T> {
  mutations.add(pending);void pending.then(()=>mutations.delete(pending),()=>{mutations.delete(pending);hostCleanup.markUnverified('app-operation');});return pending;
}
function linkOperation<T>(action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  hostCleanup.markUnverified('note-link-session');const controller=new AbortController();linkControllers.add(controller);
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
  observeWindowActivity(window,activity=>{nativeSummaryActivity=activity;liveRuntime.setActivity(activity);summaryReview?.setActivity(activity);});
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.once('ready-to-show',()=>window.show());
  window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
  window.on('closed',()=>{mainWindow=null;demoStore.clear();});
  await window.loadFile(rendererEntry);
}
async function showWindow():Promise<void>{if(quitting||updateQuiescing||!liveRuntime)return;if(!mainWindow||quitting){await createWindow();return;}if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}
app.whenReady().then(async()=>{
  if(!await updateStartupAllowed({home:app.getPath('home'),argv:process.argv,installation,version:app.getVersion()})){await dialog.showMessageBox({type:'info',title:'note-app 업데이트',message:'앱 업데이트 또는 복구가 진행 중입니다. 완료한 뒤 다시 열어 주세요.',buttons:['종료']});app.quit();return;}
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
    (async()=>{
      if(installation.role==='verification')return loadLiveConfiguration(undefined,operation=>owned('config-read',()=>operation));
      try{return await loadLiveConfiguration(await owned('config-migration',()=>persistentConfiguration({userData,explicit:process.env.NOTE_APP_CONFIG,legacy:app.isPackaged?join(process.resourcesPath,'live-config.json'):undefined})),operation=>owned('config-read',()=>operation));}
      catch{return loadLiveConfiguration(join(userData,'.invalid-legacy-configuration'));}
    })(),
    startup((async()=>{
      await mkdir(userData,{recursive:true,mode:0o700});const root=join(await realpath(userData),'summary-cache');
      await mkdir(root,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(root)!==root
        ||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw new Error('Unsafe cache directory');
      return {path:root,available:true};
    })(),{path:join(userData,'summary-cache'),available:false}),
  ]);
  const cacheRoot=cacheLocation.path;
  const modelReading=createModelReadingStorage(join(userData,'model-reading'));
  const rawReadLatest=modelReading.readLatest;modelReading.readLatest=(...args)=>hostCleanup.track('model-storage-read',()=>rawReadLatest(...args),{fulfilled:result=>result.state!=='unavailable',rejected:()=>false});
  const rawFailedReservation=modelReading.failedReservation;modelReading.failedReservation=(...args)=>hostCleanup.track('model-reservation-read',()=>rawFailedReservation(...args),{rejected:error=>(error as NodeJS.ErrnoException).code==='ENOENT'});
  const publicClaude=configuration.configuration?.publicModelClaudePath;
  const publicCwd=join(userData,'public-model-empty-workspace');
  if(publicClaude)await mkdir(publicCwd,{recursive:true,mode:0o700});
  publicModel=createPublicModelController(publicReadingPack as PublicReadingPack,modelReading,
    publicClaude?createClaudePublicAdapter(publicClaude,publicCwd,process.env):undefined);
  const projectPersistence=cacheLocation.available?await startup((async()=>{const directory=join(cacheRoot,'projects');await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw new Error('Unsafe project registry');return persistence(createLocalSummaryCache({directory,codec:projectRegistryCodec}));})(),undefined):undefined;
  const workspacePersistence=cacheLocation.available?await startup((async()=>{const directory=join(cacheRoot,'workspace-state');await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw Error('Unsafe workspace state directory');return persistence(createLocalSummaryCache({directory,codec:workspaceStateCodec}));})(),undefined):undefined;
  const workspaceState=createWorkspaceStateStore(workspacePersistence);
  const draftPersistence=cacheLocation.available?await startup((async()=>{const directory=join(cacheRoot,'project-drafts');await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw Error('Unsafe project draft directory');return persistence(createLocalSummaryCache({directory,codec:projectDraftCodec}));})(),undefined):undefined;
  const projectDrafts=createProjectDraftStore(draftPersistence);
  const projectRegistry=createProjectRegistry({persistence:projectPersistence??{read:async()=>null,write:async()=>{throw new Error('앱 프로젝트 상태 저장 위치를 사용할 수 없습니다.');}}});
  const readPersistence=cacheLocation.available?await startup((async()=>{
    const directory=join(cacheRoot,'read-permissions');await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw Error('Unsafe read permission directory');
    return persistence(createLocalSummaryCache({directory,codec:readRootsCodec}));
  })(),undefined):undefined;
  const readRoots=createReadRoots({initialScopes:configuration.configuration?.noteScopes??[],hostId:configuration.configuration?.localHostId,persistence:readPersistence,unavailable:!readPersistence});
  await readRoots.load();
  const documentRootPersistence=cacheLocation.available?await startup((async()=>{const directory=join(cacheRoot,'project-document-roots');await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw Error('Unsafe document grants directory');return persistence(createLocalSummaryCache({directory,codec:projectDocumentRootsCodec}));})(),undefined):undefined;
  const documentRoots=createProjectDocumentRoots({persistence:documentRootPersistence,unavailable:!documentRootPersistence,isProjectAvailable:id=>!!liveRuntime?.projectDocumentIdentity(id),projectIdentity:id=>liveRuntime?.projectDocumentIdentity(id)??null,isDirectoryAllowed:(id,directory)=>liveRuntime?.projectDocumentDirectoryAllowed(id,directory)??false});
  await documentRoots.load();
  liveRuntime=createLiveRuntime({configuration,cacheRoot,cacheAvailable:cacheLocation.available,projectRegistry,readRoots,gitActivityIdentity:async id=>{const state=await gitMetadataGrants?.view(id);return state?JSON.stringify([state.identity,state.state]):null;},readGitActivity:readSummaryGitActivity,extraDocumentRoots:async workstreamId=>(await documentRoots.rootsFor(workstreamId)).map(root=>({key:root.id,path:root.path,label:(root.kind==='review'?'연결한 검수 폴더':'연결한 소스 문서 폴더')+' · '+root.path.split(/[\\/]/u).at(-1),kind:'linked',authorize:()=>documentRoots.revalidate(root)}))});
  async function metadataPersistence<T>(name:string,codec:{parse(value:unknown):T}){if(!cacheLocation.available)return undefined;return startup((async()=>{const directory=join(cacheRoot,name);await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw Error('Unsafe Git metadata cache');return persistence(createLocalSummaryCache({directory,codec}));})(),undefined);}
  const gitGrantPersistence=await metadataPersistence('git-metadata-grants',gitMetadataReadGrantsCodec);
  gitMetadataGrants=createGitMetadataReadGrants({persistence:gitGrantPersistence,unavailable:!gitGrantPersistence,existingAuthority:async(_id,project,signal)=>{if(signal?.aborted||!await readRoots.allowsDirectory(project.worktree))return null;const candidates=[join(project.worktree,'.git'),...(configuration.configuration?.noteLink?.allowedCommonGitDirs??[])],approvedCommonPaths:string[]=[];for(const directory of [...new Set(candidates)])if(await readRoots.allowsDirectory(directory))approvedCommonPaths.push(directory);if(!approvedCommonPaths.length)return null;const revision=(await readRoots.view()).revision;return {worktree:project.worktree,approvedCommonPaths,revision:revision??0,validate:async checkSignal=>!checkSignal?.aborted&&(await readRoots.view()).revision===revision&&await readRoots.allowsDirectory(project.worktree)&&(await Promise.all(approvedCommonPaths.map(directory=>readRoots.allowsDirectory(directory)))).every(Boolean)};},resolveProject:id=>liveRuntime.resolveGitMetadataProject(id),onInvalidate:id=>{summaryReview?.cancelAll(true);if(id)void gitActivityIndex?.invalidate(id).catch(()=>{});summaryReview?.invalidate();}});
  await gitMetadataGrants.load();
  const gitIndexPersistence=await metadataPersistence('git-activity-index',gitActivityIndexCodec);
  const authorityKey=(authority:NonNullable<Awaited<ReturnType<NonNullable<typeof gitMetadataGrants>['resolve']>>>)=>createHash('sha256').update(JSON.stringify([authority.descriptor.contract,authority.identity,authority.revision])).digest('hex');
  async function checkGitAuthority(input:GitActivityIndexInput,signal:AbortSignal){if(quitting||updateQuiescing||signal.aborted)return false;const authority=await gitMetadataGrants?.resolve(input.projectId,signal);if(!authority||authorityKey(authority)!==input.authorityKey||!await authority.validate(signal))return false;return await gitActivityObjectRevision(authority.descriptor,signal,input.declaredReferences)===input.objectRevision;}
  gitActivityIndex=createGitActivityIndex({persistence:gitIndexPersistence,validateAuthority:checkGitAuthority,resolveBatch:async(id,refs,signal,input)=>{const authority=await gitMetadataGrants?.resolve(id,signal);if(!authority||authorityKey(authority)!==input.authorityKey||!await checkGitAuthority(input,signal))throw Error('Git metadata authority changed');return readGitActivityReferences(authority.descriptor,[...refs],signal,async()=>{if(!await checkGitAuthority(input,signal))throw Error('Git metadata authority changed');});}});
  async function readSummaryGitActivity(id:string,tasks:readonly DagTask[],signal:AbortSignal,revalidate:boolean):Promise<{events:TaskActivity[];coverage:ActivityCoverage}>{
    const declaredReferences=[...new Set(tasks.flatMap(task=>task.commitReferences))].sort(),empty:ActivityCoverage={state:declaredReferences.length?'unavailable':'complete',total:declaredReferences.length,checked:0,resolved:0,unresolved:0,unsupported:0,pending:declaredReferences.length};if(!declaredReferences.length||quitting||updateQuiescing||signal.aborted)return {events:[],coverage:empty};
    try{const authority=await gitMetadataGrants?.resolve(id,signal);if(!authority||!gitActivityIndex)return {events:[],coverage:empty};const input={projectId:id,authorityKey:authorityKey(authority),objectRevision:await gitActivityObjectRevision(authority.descriptor,signal,declaredReferences),declaredReferences};const result=await (revalidate?gitActivityIndex.peek(input,signal):gitActivityIndex.observe(input,signal));const events:TaskActivity[]=[];for(const record of result.records){if(record.status!=='resolved'||!record.fullSha||!record.at)continue;for(const task of tasks)if(task.commitReferences.includes(record.declaredReference))events.push({taskId:task.id,kind:'code',at:record.at,source:'git:'+record.fullSha,timeBasis:'git-commit-time',declaredReference:record.declaredReference,fullSha:record.fullSha,sourceHash:createHash('sha256').update(JSON.stringify([input.authorityKey,record])).digest('hex')});}return {events,coverage:result.coverage};}catch{if(signal.aborted)throw Error('Git activity cancelled');return {events:[],coverage:empty};}
  }
  if(configuration.configuration?.orcaExecutablePath&&configuration.configuration.localHostId)orcaProjectOpener=createOrcaProjectOpener<string>({executablePath:configuration.configuration.orcaExecutablePath,localHostId:configuration.configuration.localHostId,resolveSelection:async id=>{const selected=liveRuntime.resolveProjectOrcaTarget(id);if(!selected||!await readRoots.allowsDirectory(dirname(selected.dagPath)))return null;const current=liveRuntime.resolveProjectOrcaTarget(id);return JSON.stringify(current)===JSON.stringify(selected)?current:null;}});
  const modelDiagnostics=createModelDiagnostics(join(userData,'model-diagnostics'),buildSha);
  const rawDiagnosticsView=modelDiagnostics.view,rawDiagnosticsAppend=modelDiagnostics.append;
  modelDiagnostics.view=(...args)=>hostCleanup.track('diagnostics-read',()=>rawDiagnosticsView(...args),{fulfilled:result=>result.available,rejected:()=>false});
  modelDiagnostics.append=(...args)=>owned('diagnostics-write',()=>rawDiagnosticsAppend(...args));
  const modelRetryStorage=createModelRetryStorage(join(userData,'model-diagnostic-retries'),modelReading.lockModelSlot,async(project,inputHash,runId)=>{const failed=await modelReading.failedReservation(project,inputHash);return failed?.runId===runId;});
  const rawRetryUsed=modelRetryStorage.used;modelRetryStorage.used=(...args)=>owned('model-retry-read',()=>rawRetryUsed(...args));
  projectModel=createProjectModelController({retryStorage:modelRetryStorage,diagnostics:modelDiagnostics,storage:modelReading,adapter:publicClaude?createClaudePublicAdapter(publicClaude,publicCwd,process.env):undefined,identify:id=>liveRuntime.identifyModelProject(id),revision:id=>liveRuntime.modelSourceRevision(id),resolve:async(id,signal,phase)=>{const source=await liveRuntime.resolveProjectModelSource(id,signal,phase==='revalidate');if(!source.readingSummary||liveRuntime.getState().dags.find(d=>d.dagId===source.dag.dagId)?.sourceHash!==source.observedDagHash)throw Error('Current reading source unavailable');return {...source,readingSummary:source.readingSummary};}});
  const automationStorage=cacheLocation.available?await startup((async()=>{const directory=join(cacheRoot,'summary-automation');await mkdir(directory,{recursive:true,mode:0o700});const stat=await lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory()||await realpath(directory)!==directory||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())))throw Error('Unsafe summary automation storage');return persistence(createLocalSummaryCache({directory,codec:summaryAutomationCodec}));})(),undefined):undefined;
  const rawSummaryAdapter=options.summaryModelAdapter??(publicClaude?createClaudePublicAdapter(publicClaude,publicCwd,process.env):undefined);
  const summaryAdapter:ModelAdapter|undefined=rawSummaryAdapter?{generate:(request,signal,observe)=>{let started=false;return hostCleanup.track('scoped-summary-model',()=>rawSummaryAdapter.generate(request,signal,async event=>{if(event==='started')started=true;await observe?.(event);}),{fulfilled:receipt=>receipt.process?.cleanup==='verified',rejected:error=>!started||!!error&&typeof error==='object'&&'processInfo' in error&&(error as {processInfo?:{cleanup?:string}}).processInfo?.cleanup==='verified'});}}:undefined;
  summaryReview=createSummaryReview({storage:modelReading,diagnostics:modelDiagnostics,retryStorage:modelRetryStorage,autoStorage:automationStorage??{read:async()=>{throw Error('Automation unavailable');},write:async()=>{throw Error('Automation unavailable');}},adapter:summaryAdapter,
    identify:(id,selection)=>liveRuntime.identifySelectedModelProject(id,selection),revision:(id,selection)=>liveRuntime.selectedModelSourceRevision(id,selection),source:(id,selection,signal,revalidate)=>liveRuntime.resolveSelectedProjectModelSource(id,signal,revalidate,selection),recent:(id,signal)=>liveRuntime.getRecentSummaryTasks(id,signal),tasks:id=>liveRuntime.getSummaryTaskChoices(id),
    binding:async(id,signal)=>{if(!publicClaude&&!(options.summaryModelAdapter&&options.summaryModelIdentity))throw Error('Claude unavailable');const projectIdentity=liveRuntime.summaryProjectIdentity(id),workstream=liveRuntime.getState().workstreams.find(w=>w.id===id),root=workstream?.noteMapping.context?.noteRootPath;if(!projectIdentity||!root||!await readRoots.allowsDirectory(root))throw Error('Current project read permission unavailable');
      const identities:string[]=[];let current=root;while(true){const stat=await lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Project root identity changed');identities.push(current+':'+stat.dev+':'+stat.ino);const parent=dirname(current);if(parent===current)break;current=parent;}if(await realpath(root)!==root)throw Error('Project root moved');
      const account=await (options.summaryModelIdentity?options.summaryModelIdentity():readSummaryModelIdentity(publicClaude!,publicCwd,process.env,signal)),activityIdentity=await liveRuntime.summaryActivityIdentity(id);const readView=await readRoots.view();if(signal.aborted||projectIdentity!==liveRuntime.summaryProjectIdentity(id)||!await readRoots.allowsDirectory(root))throw Error('Summary permission changed');
      return {projectId:id,projectIdentity:JSON.stringify([projectIdentity,activityIdentity]),...account,roots:[{path:root,identity:createHash('sha256').update(JSON.stringify(identities)).digest('hex')}],scopeRevision:'scoped-markdown-v1:read-'+String(readView.revision),inputContract:PROJECT_MODEL_VERSION,selectionPolicy:'last-three-exact-task-activities-v1'};
    }});
  await summaryReview.automation.ready().catch(()=>{});summaryReview.setActivity(nativeSummaryActivity);
  function makeSummaryWorkflow(){const workflow=(options.summaryFactory??createSummaryWorkflow)({cacheRoot,resolveSource:async(workstreamId:string,signal:AbortSignal)=>{
    if(signal.aborted||!cacheLocation.available)throw new Error('App-owned cache unavailable or request cancelled');return liveRuntime.resolveSummarySource(workstreamId,signal);
  }});workflow.subscribe(view=>{if(mainWindow&&!mainWindow.webContents.isDestroyed())mainWindow.webContents.send('note-app:summary-changed',view);});return workflow;}
  summaryWorkflow=makeSummaryWorkflow();
  const linkConfig=configuration.configuration?.noteLink;
  const noteLink=linkConfig?createNoteLinkWorkflow({...linkConfig,resolveSelection:async(worktreeId:string,scopeId:string)=>liveRuntime.resolveNoteSelection(worktreeId,scopeId)}):null;
  liveRuntime.subscribe(state=>{
    projectModel?.invalidate();if(!state.refreshing)summaryReview?.invalidate();
    if(mainWindow&&!mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('note-app:live-changed',state);
  });
  updateService=options.updateService??(options.updateServiceFactory??createUpdateService)({home:app.getPath('home'),installation,version:app.getVersion(),installerDirectory:join(__dirname,'../updater'),restartConfigurationPath:configuration.view.state==='ready'?process.env.NOTE_APP_CONFIG:undefined,
    async cleanup(){
      if(projectCreationBusy||changingReadRoots||pickingReadRoot||reconnectBusy)throw Error('권한 변경 또는 재연결을 먼저 마쳐 주세요.');
      for(const controller of linkControllers)controller.abort();
      projectCreation?.dispose();orcaProjectOpener?.invalidate();projectModel?.cancel();summaryReview?.cancelAll();await publicModel?.cancel();summaryWorkflow.dispose();
      try{await summaryReview?.settle();await gitActivityIndex?.settle();await gitMetadataGrants?.settle();await hostCleanup.settle({verify:()=>[{area:'Orca display',cleanup:orcaProjectOpener?.cleanupState()??'verified'},{area:'Project creation',cleanup:projectCreation?.cleanupState().unverified?'unverified':projectCreation?.cleanupState().pending?'pending':'verified'}]});if(mutations.size)throw Error('저장 작업이 아직 끝나지 않았습니다.');await liveRuntime.prepareUpdateShutdown();}
      finally{summaryWorkflow=makeSummaryWorkflow();}
    },
    requestQuit:ready=>{updateQuitReady=ready;app.quit();},
  });
  updateService.subscribe(state=>{updateQuiescing=state.status==='installing';if(mainWindow&&!mainWindow.webContents.isDestroyed())mainWindow.webContents.send('note-app:update-changed',state);});
  for(const [channel,action] of [
    ['state',()=>updateService!.getState()],['check',()=>updateService!.check()],['prepare',()=>updateService!.prepare()],
    ['cancel',()=>updateService!.cancel()],['defer',()=>updateService!.defer()],['install',()=>updateService!.install()],['dismiss-outcome',()=>updateService!.dismissOutcome()],
  ] as const)ipcMain.handle('note-app:update-'+channel,(event,...args)=>{if(!mainWindow||quitting)throw Error('App unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);assertNoArguments(args);return action();});
  let bootConfirmed=false;
  ipcMain.handle('note-app:boot-ready',async(event,...args)=>{checkReadSender(event);assertNoArguments(args);if(bootConfirmed)return;await acknowledgeUpdateBoot({argv:process.argv,home:app.getPath('home'),installation,version:app.getVersion()});bootConfirmed=true;});
  let changingReadRoots=false,pickingReadRoot=false;
  function checkReadSender(event:Electron.IpcMainInvokeEvent){if(!mainWindow||quitting||updateQuiescing)throw Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);}
  const reconnect=createNoteReconnect({resolve:id=>liveRuntime.resolveReconnectWorktree(id),allowed:p=>readRoots.allowsDirectory(p),scan:configuration.configuration?.dagQuery?createDagCandidateScanner(configuration.configuration.dagQuery):async()=>{throw Error('DAG 검증 실행 환경이 없습니다. 연결 및 설정에서 실행 환경을 확인해 주세요.');},bind:s=>liveRuntime.bindReconnectedNote(s)});
  let reconnectBusy=false,reconnectWorktreePath:string|undefined;
  ipcMain.handle('note-app:note-reconnect-select',async(event,...args)=>{
    checkReadSender(event);hostCleanup.markUnverified('reconnect-session');if(args.length!==1||!args[0]||Object.keys(args[0]).join(',')!=='workstreamId'||typeof args[0].workstreamId!=='string'||args[0].workstreamId.length>256)throw Error('프로젝트 선택 오류');
    if(pickingReadRoot||changingReadRoots||reconnectBusy)throw Error('폴더 선택 또는 재연결 처리 중입니다.');pickingReadRoot=true;reconnect.invalidate();
    try{await liveRuntime.refresh();if(!liveRuntime.resolveReconnectWorktree(args[0].workstreamId))throw Error('현재 로컬 프로젝트 연결을 확인할 수 없습니다.');const result=await dialog.showOpenDialog(mainWindow!,{title:'노트 재연결',message:'이 프로젝트의 노트가 있는 디렉토리를 선택하세요.',properties:['openDirectory'],buttonLabel:'이 디렉토리 검토'});if(result.canceled||result.filePaths.length!==1)return null;reconnectWorktreePath=liveRuntime.resolveReconnectWorktree(args[0].workstreamId)?.worktreePath;return await reconnect.prepare(args[0].workstreamId,result.filePaths[0]);}finally{pickingReadRoot=false;}
  });
  ipcMain.handle('note-app:note-reconnect-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('취소 요청 오류');reconnect.cancel(args[0]);});
  ipcMain.handle('note-app:note-reconnect-confirm',(event,...args)=>{
    checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy||pickingReadRoot)throw Error('재연결 요청 오류');reconnectBusy=true;
    return tracked((async()=>{try{await liveRuntime.refresh();projectModel?.cancel();summaryReview?.cancelAll();await publicModel?.cancel();for(const controller of linkControllers)controller.abort();const result=await reconnect.confirm(args[0]);await liveRuntime.refresh();const workstreamId=reconnectWorktreePath?liveRuntime.reconnectedWorkstream(reconnectWorktreePath):undefined;return {...result,...(workstreamId?{workstreamId}:{}),readiness:reconnectReadiness(liveRuntime.getState(),workstreamId,!!publicClaude)};}finally{reconnectBusy=false;reconnectWorktreePath=undefined;}})());
  });
  ipcMain.handle('note-app:document-roots-get',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('문서 폴더 조회 요청 오류');const request=parseGetProjectDocumentRootsRequest(args[0]);return owned('document-roots-view',()=>documentRoots.view(request.projectId));});
  ipcMain.handle('note-app:document-roots-select',async(event,...args)=>{
    checkReadSender(event);if(args.length!==1)throw Error('문서 폴더 선택 요청 오류');const request=parseSelectProjectDocumentRootRequest(args[0]);if(pickingReadRoot||changingReadRoots||reconnectBusy)throw Error('폴더 선택이 진행 중입니다.');
    const expectedProjectIdentity=liveRuntime.projectDocumentIdentity(request.projectId),pickerWindow=mainWindow;
    if(!expectedProjectIdentity||!pickerWindow||pickerWindow.isDestroyed()||quitting||updateQuiescing)throw Error('현재 프로젝트 연결을 확인해 주세요.');
    const controller=new AbortController();linkControllers.add(controller);pickingReadRoot=true;
    const isActive=()=>mainWindow===pickerWindow&&!pickerWindow.isDestroyed()&&!quitting&&!updateQuiescing;
    try{
      const result=await dialog.showOpenDialog(pickerWindow,{title:request.kind==='review'?'이 프로젝트에 연결할 검수 폴더':'이 프로젝트에 연결할 소스 문서 폴더',message:'선택한 폴더만 읽기 전용 문서 탐색에 연결합니다. 저장소 전체나 볼트를 선택하지 마세요.',properties:['openDirectory'],buttonLabel:'읽기 범위 검토'});
      if(result.canceled||result.filePaths.length!==1)return null;
      if(!isActive()||controller.signal.aborted)throw Error('문서 폴더 선택이 취소되었습니다.');
      return await prepareDocumentRootAfterPicker({expectedProjectIdentity,observation:liveRuntime.getProjectWorkspaceOptions(),currentProjectIdentity:()=>liveRuntime.projectDocumentIdentity(request.projectId),refresh:()=>liveRuntime.refresh(),isActive,signal:controller.signal,prepare:()=>documentRoots.prepare(request.projectId,result.filePaths[0],request.kind),cancel:proposal=>documentRoots.cancel({projectId:proposal.projectId,proposalId:proposal.proposalId})});
    }finally{linkControllers.delete(controller);pickingReadRoot=false;}
  });
  ipcMain.handle('note-app:document-roots-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('문서 폴더 취소 요청 오류');return documentRoots.cancel(args[0]);});
  async function changeDocumentRoots(action:()=>Promise<unknown>){if(changingReadRoots||reconnectBusy||pickingReadRoot)throw Error('읽기 범위 변경이 진행 중입니다.');changingReadRoots=true;liveRuntime.invalidateProjectDocuments();try{return await action();}finally{changingReadRoots=false;}}
  ipcMain.handle('note-app:document-roots-confirm',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('문서 폴더 확인 요청 오류');return tracked(changeDocumentRoots(()=>documentRoots.confirm(args[0])));});
  ipcMain.handle('note-app:document-roots-revoke',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('문서 폴더 철회 요청 오류');return tracked(changeDocumentRoots(()=>documentRoots.revoke(args[0])));});
  ipcMain.handle('note-app:read-roots',(event,...args)=>{checkReadSender(event);assertNoArguments(args);return owned('read-roots-view',()=>readRoots.view());});
  ipcMain.handle('note-app:read-root-select',async(event,...args)=>{
    checkReadSender(event);assertNoArguments(args);if(pickingReadRoot||changingReadRoots||reconnectBusy)throw Error('폴더 선택이 진행 중입니다.');pickingReadRoot=true;
    try{const result=await dialog.showOpenDialog(mainWindow!,{title:'노트 읽기를 허용할 폴더 선택',properties:['openDirectory'],buttonLabel:'읽기 범위 검토'});if(result.canceled||result.filePaths.length!==1)return null;return await readRoots.prepare(result.filePaths[0]);}finally{pickingReadRoot=false;}
  });
  ipcMain.handle('note-app:read-root-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Expected one cancellation');readRoots.cancel(args[0]);});
  async function changeReadRoots(action:()=>Promise<unknown>){if(changingReadRoots||reconnectBusy||pickingReadRoot)throw Error('권한 변경이 진행 중입니다.');changingReadRoots=true;
    try{projectCreation?.dispose();orcaProjectOpener?.invalidate();for(const controller of linkControllers)controller.abort();await publicModel?.cancel();projectModel?.cancel();summaryReview?.cancelAll();summaryWorkflow.dispose();await liveRuntime.invalidateReadRoots();return await action();}
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
    ['note-app:live-disconnect',()=>{gitMetadataGrants?.invalidate();projectCreation?.dispose();orcaProjectOpener?.invalidate();projectModel?.cancel();summaryReview?.cancelAll();return liveRuntime.disconnect();}],
  ] as const) ipcMain.handle(channel,(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing) throw new Error('App window unavailable');
    assertTrustedSender(event,mainWindow.webContents,entryUrl);assertNoArguments(args);
    if((changingReadRoots||reconnectBusy)&&channel!=='note-app:live-state')throw Error('읽기 권한 변경이 진행 중입니다.');
    if(channel==='note-app:public-model-run')hostCleanup.markUnverified('model-run-session');
    return action();
  });
  for(const [channel,action] of [
    ['note-app:project-model-state',(id:string)=>projectModel!.view(id)],
    ['note-app:project-model-run',(id:string)=>projectModel!.run(id)],
    ['note-app:project-model-cancel',(id:string)=>{projectModel!.cancel(id);return projectModel!.view(id);}],
  ] as const)ipcMain.handle(channel,(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing||changingReadRoots||reconnectBusy)throw Error('App unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1||!args[0]||typeof args[0]!=='object'||Array.isArray(args[0])||Object.keys(args[0]).sort().join(',')!==(channel==='note-app:project-model-run'?'transferConfirmed,workstreamId':'workstreamId')||(channel==='note-app:project-model-run'&&args[0].transferConfirmed!==true)||typeof args[0].workstreamId!=='string'||args[0].workstreamId.length>256)throw Error('Invalid project model selection');
    if(channel==='note-app:project-model-run')hostCleanup.markUnverified('model-run-session');
    return tracked(action(args[0].workstreamId));
  });
  for(const [channel,mode] of [['note-app:summary-review-state','state'],['note-app:summary-review-run','run'],['note-app:summary-review-cancel','cancel']] as const)ipcMain.handle(channel,(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('Summary unavailable');const request=parseSummarySelectionRequest(args[0],mode==='run');return tracked(mode==='run'?summaryReview!.run(request,args[0]):mode==='cancel'?summaryReview!.cancel(request):summaryReview!.view(request));});
  ipcMain.handle('note-app:git-metadata-state',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Invalid metadata request');return owned('git-metadata-state',()=>gitMetadataGrants!.view(parseGetGitMetadataReadStateRequest(args[0]).workstreamId));});
  ipcMain.handle('note-app:git-metadata-select',async(event,...args)=>{checkReadSender(event);if(args.length!==1||pickingReadRoot||changingReadRoots||reconnectBusy)throw Error('Git metadata picker unavailable');const {workstreamId}=parseSelectGitMetadataReadScopeRequest(args[0]),target=liveRuntime.resolveReconnectWorktree(workstreamId),identity=liveRuntime.summaryProjectIdentity(workstreamId),window=mainWindow!;if(!target||!identity)throw Error('Current project unavailable');pickingReadRoot=true;try{const chosen=await dialog.showOpenDialog(window,{title:'Git 메타데이터 폴더 선택',message:'이 프로젝트의 공통 .git 폴더를 선택하세요. 커밋 ID·시각만 로컬에서 확인하며 코드 본문을 읽거나 AI로 전송하지 않습니다.',properties:['openDirectory','showHiddenFiles'],buttonLabel:'메타데이터 범위 검토'});if(chosen.canceled||chosen.filePaths.length!==1)return null;await liveRuntime.refresh();if(quitting||updateQuiescing||mainWindow!==window||window.isDestroyed()||identity!==liveRuntime.summaryProjectIdentity(workstreamId)||target.worktreePath!==liveRuntime.resolveReconnectWorktree(workstreamId)?.worktreePath)throw Error('Project changed during metadata picker');return await gitMetadataGrants!.prepare(workstreamId,chosen.filePaths[0]);}finally{pickingReadRoot=false;}});
  ipcMain.handle('note-app:git-metadata-confirm',(event,...args)=>{checkReadSender(event);if(args.length!==1||pickingReadRoot||changingReadRoots||reconnectBusy)throw Error('Git metadata confirmation unavailable');return tracked(gitMetadataGrants!.confirm(parseConfirmGitMetadataReadScopeRequest(args[0])));});
  ipcMain.handle('note-app:git-metadata-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Invalid metadata cancellation');return gitMetadataGrants!.cancel(parseCancelGitMetadataReadScopeRequest(args[0]));});
  ipcMain.handle('note-app:git-metadata-revoke',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Invalid metadata revocation');return tracked(gitMetadataGrants!.revoke(parseRevokeGitMetadataReadScopeRequest(args[0])));});
  ipcMain.handle('note-app:summary-transfer-prepare',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('Transfer unavailable');return tracked(summaryReview!.prepareTransfer(parseSummarySelectionRequest(args[0])));});
  ipcMain.handle('note-app:summary-transfer-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Invalid transfer cancellation');return summaryReview!.cancelTransfer(args[0]);});
  ipcMain.handle('note-app:summary-retry-prepare',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('Retry unavailable');return tracked(summaryReview!.prepareRetry(parseSummarySelectionRequest(args[0])));});
  ipcMain.handle('note-app:summary-retry-run',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('Retry unavailable');return tracked(summaryReview!.runRetry(args[0]));});
  ipcMain.handle('note-app:summary-retry-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Retry unavailable');return summaryReview!.cancelRetry(args[0]);});
  const summaryProject=(value:unknown,keys:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('Invalid summary project');const r=value as {workstreamId:string;enabled?:boolean};if(typeof r.workstreamId!=='string'||!r.workstreamId.length||r.workstreamId.length>1024||!liveRuntime.getState().workstreams.some(w=>w.id===r.workstreamId))throw Error('Current project unavailable');return r;};
  ipcMain.handle('note-app:summary-active-project',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Invalid project');if(args[0]&&Object.keys(args[0]).join(',')==='workstreamId'&&args[0].workstreamId===null)return summaryReview!.selectProject(null);return summaryReview!.selectProject(summaryProject(args[0],['workstreamId']).workstreamId);});
  ipcMain.handle('note-app:summary-consent-prepare',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('Consent unavailable');return tracked(summaryReview!.automation.prepareConsent(summaryProject(args[0],['workstreamId']).workstreamId));});
  ipcMain.handle('note-app:summary-consent-confirm',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('Consent unavailable');return tracked(summaryReview!.automation.grantConsent(args[0]));});
  ipcMain.handle('note-app:summary-consent-revoke',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Invalid consent request');const id=summaryProject(args[0],['workstreamId']).workstreamId;summaryReview!.cancelAll(true);return tracked(summaryReview!.automation.revoke(id));});
  ipcMain.handle('note-app:summary-auto-set',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('Summary unavailable');const r=summaryProject(args[0],['workstreamId','enabled']);if(typeof r.enabled!=='boolean')throw Error('Invalid auto state');return tracked(summaryReview!.automation.setAuto(r.workstreamId,r.enabled));});
  let appMemoryCache:ReturnType<typeof projectAppMemory>|null=null,appMemoryAt=0;
  ipcMain.handle('note-app:app-memory',(event,...args)=>{checkReadSender(event);assertNoArguments(args);const at=Date.now();if(appMemoryCache&&at-appMemoryAt<1000)return appMemoryCache;let metrics:unknown=null;try{metrics=app.getAppMetrics();}catch{}appMemoryCache=projectAppMemory(metrics,process.platform,at);appMemoryAt=at;return appMemoryCache;});
  const projectCreationConfiguration=configuration.configuration;
  const creationConfigured=!!(projectCreationConfiguration?.localHostId&&projectCreationConfiguration.noteLink&&projectCreationConfiguration.dagQuery&&process.platform!=='win32');
  const creationWriter=creationConfigured?createProjectDagWriter({pythonPath:projectCreationConfiguration!.dagQuery!.pythonPath}):null;
  ipcMain.handle('note-app:project-creation-availability',(event,...args)=>{checkReadSender(event);assertNoArguments(args);return {available:creationConfigured,reason:creationConfigured?'검증된 기존 로컬 워크트리와 직접 작성한 지침으로 생성할 수 있습니다.':'안전한 생성에는 설정된 Git·Python 실행 환경과 로컬 Orca 연결이 필요합니다. 초안은 계속 저장할 수 있습니다.'};});
  ipcMain.handle('note-app:project-creation-prepare',(event,...args)=>{checkReadSender(event);if(args.length!==1||projectSourceOperations.size||projectCreationBusy||pickingReadRoot||changingReadRoots||reconnectBusy)throw Error('프로젝트 생성 검토를 시작할 수 없습니다.');const request=parseProjectCreationRequest(args[0]);if(!creationWriter||!projectCreationConfiguration?.noteLink)return {state:'unavailable',reason:'writer_unavailable'};
    if(projectCreation?.cleanupState().pending||projectCreation?.cleanupState().unverified)throw Error('이전 생성 결과를 먼저 확인해 주세요.');projectCreation?.dispose();projectCreationBusy=true;const decidedAt=new Date().toISOString().slice(0,10);
    projectCreation=createProjectDagCreation({writer:creationWriter,readDraft:async id=>(await projectDrafts.list()).find(d=>d.id===id)??null,
      resolveSource:async(draft,signal)=>{const candidate=matchProjectCreationWorkspace(draft,liveRuntime.getProjectWorkspaceOptions());if(!candidate)return null;const selected=liveRuntime.resolveProjectWorkspace({optionId:candidate.optionId,expectedFingerprint:candidate.fingerprint});return validateProjectDagSource(draft,selected,{projectPath:request.projectPath,baseBranch:request.baseBranch,verification:request.verification},projectCreationConfiguration.noteLink!,signal,decidedAt,trackProjectSource);},
      pickDirectory:async(_draft,_source,signal)=>{if(!mainWindow||quitting||updateQuiescing)return null;pickingReadRoot=true;try{const result=await dialog.showOpenDialog(mainWindow,{title:'빈 DAG를 만들 프로젝트 노트 디렉터리',message:'프로젝트 노트 경로와 일치하는 기존 디렉터리를 선택하세요. 미리보기 확인 후 dag.yaml 한 파일만 만듭니다.',properties:['openDirectory'],buttonLabel:'이 위치 미리보기'});if(result.canceled||result.filePaths.length!==1)return null;await refreshAfterProjectPicker(liveRuntime.getProjectWorkspaceOptions(),()=>liveRuntime.refresh(),signal);return result.filePaths[0];}finally{pickingReadRoot=false;}}
    });const session=projectCreation;return tracked(owned('project-creation-prepare',()=>session.prepare({draftId:request.draftId,expectedDraftRevision:request.expectedDraftRevision})).finally(()=>{projectCreationBusy=false;}));
  });
  ipcMain.handle('note-app:project-creation-confirm',(event,...args)=>{checkReadSender(event);if(args.length!==1||projectCreationBusy||pickingReadRoot||changingReadRoots||reconnectBusy||!projectCreation)throw Error('프로젝트 생성 확인을 사용할 수 없습니다.');const request=parseConfirmProjectDagRequest(args[0]),session=projectCreation;projectCreationBusy=true;return tracked(hostCleanup.track('project-creation-write',()=>session.confirm(request),{fulfilled:result=>(result.state!=='unavailable'||result.outcome!=='uncertain')&&!session.cleanupState().unverified,rejected:()=>false}).finally(()=>{projectCreationBusy=false;}));});
  ipcMain.handle('note-app:project-creation-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Expected one cancellation');const request=parseCancelProjectDagRequest(args[0]);projectCreation?.cancel(request);});
  ipcMain.handle('note-app:orca-project-open-availability',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Expected one Orca selection');const {workstreamId}=parseOrcaProjectOpenRequest(args[0]),target=liveRuntime.resolveProjectOrcaTarget(workstreamId);if(!orcaProjectOpener||!target)return {available:false,reason:'unavailable'};const rel=relative(target.worktreePath,target.dagPath);return !rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../')?{available:false,reason:'external-note'}:{available:true,reason:'ready'};});
  ipcMain.handle('note-app:orca-project-open',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('Orca 이동 요청 불가');const {workstreamId}=parseOrcaProjectOpenRequest(args[0]);if(!orcaProjectOpener)return {ok:false,reason:'unavailable',attempted:false};return tracked(hostCleanup.track('Orca display',()=>orcaProjectOpener!.open(workstreamId),{fulfilled:result=>result.ok||result.reason!=='cleanup_unverified',rejected:()=>false}));});
  ipcMain.handle('note-app:project-workspaces',(event,...args)=>{checkReadSender(event);assertNoArguments(args);return liveRuntime.getProjectWorkspaceOptions();});
  ipcMain.handle('note-app:project-workspace-resolve',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Expected one workspace selection');return liveRuntime.resolveProjectWorkspace(args[0]);});
  ipcMain.handle('note-app:project-drafts-list',(event,...args)=>{checkReadSender(event);assertNoArguments(args);return owned('project-drafts-list',()=>projectDrafts.list());});
  ipcMain.handle('note-app:project-draft-save',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('Expected one project draft request');return tracked(projectDrafts.save(args[0]));});
  for(const operation of ['get','set'] as const)ipcMain.handle('note-app:workspace-state-'+operation,(event,...args)=>{checkReadSender(event);const request=args[0];if(args.length!==1||!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!==(operation==='get'?'workstreamId':'state,workstreamId')||typeof request.workstreamId!=='string'||!liveRuntime.getState().workstreams.some(w=>w.id===request.workstreamId))throw Error('화면 상태 요청 오류');return operation==='get'?tracked(workspaceState.get(request.workstreamId)):tracked(workspaceState.set(request.workstreamId,request.state));});
  ipcMain.handle('note-app:documents-prepare',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('문서 요청 불가');return tracked(liveRuntime.prepareProjectDocuments(args[0]));});
  ipcMain.handle('note-app:documents-list',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('문서 요청 불가');return tracked(liveRuntime.listProjectDocuments(args[0]));});
  ipcMain.handle('note-app:documents-open',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('문서 요청 불가');return tracked(liveRuntime.openCatalogDocument(args[0]));});
  ipcMain.handle('note-app:documents-release',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('문서 요청 불가');return liveRuntime.releaseProjectDocuments(args[0]);});
  ipcMain.handle('note-app:evidence-release',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('근거 취소 요청 오류');return liveRuntime.releaseTaskEvidence(args[0]);});
  ipcMain.handle('note-app:evidence-prepare',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('근거 요청 불가');return tracked(liveRuntime.prepareTaskEvidence(args[0]));});
  ipcMain.handle('note-app:evidence-read',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('근거 요청 불가');return tracked(liveRuntime.readTaskEvidence(args[0]));});
  ipcMain.handle('note-app:summary-prefix',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('접두사 선택 불가');projectModel?.cancel();summaryReview?.cancelAll();return tracked(liveRuntime.setSummaryPrefix(args[0]).then(value=>{projectModel?.invalidate();return value;}));});
  ipcMain.handle('note-app:model-retry-prepare',async(event,...args)=>{checkReadSender(event);hostCleanup.markUnverified('model-retry-session');if(args.length!==1||!args[0]||typeof args[0]!=='object'||Array.isArray(args[0])||Object.keys(args[0]).join(',')!=='workstreamId'||typeof args[0].workstreamId!=='string'||args[0].workstreamId.length>256||changingReadRoots||reconnectBusy)throw Error('진단 프로젝트 선택 오류');await liveRuntime.refresh();return projectModel!.prepareRetry(args[0].workstreamId);});
  ipcMain.handle('note-app:model-retry-cancel',(event,...args)=>{checkReadSender(event);if(args.length!==1)throw Error('진단 취소 요청 오류');return projectModel!.cancelRetry(args[0]);});
  ipcMain.handle('note-app:model-retry-run',(event,...args)=>{checkReadSender(event);if(args.length!==1||changingReadRoots||reconnectBusy)throw Error('진단 재시도 요청 오류');hostCleanup.markUnverified('model-retry-session');return tracked(projectModel!.runRetry(args[0]));});
  ipcMain.handle('note-app:project-document-open',async(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);if(args.length!==1)throw new Error('Expected one document selection');const uri=await liveRuntime.resolveDocumentLink(args[0]);await shell.openExternal(uri);
  });
  ipcMain.handle('note-app:project-connection-confirm',(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);if(args.length!==1)throw new Error('Expected one connection selection');return tracked(liveRuntime.confirmProjectConnection(args[0]));
  });
  ipcMain.handle('note-app:project-status',(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one project status request');return tracked(liveRuntime.setProjectStatus(args[0]));
  });
  ipcMain.handle('note-app:environment',(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing) throw new Error('App window unavailable');
    assertTrustedSender(event,mainWindow.webContents,entryUrl); assertNoArguments(args);
    return {version:app.getVersion(),buildSha,buildNumber:installation.buildNumber,installationRole:installation.role,
      installationPath:installation.currentPath,canonicalInstallationPath:installation.canonicalPath,
      platform:process.platform,dataMode:configuration.configuration?'configured':'disabled',summaryBackend:'unconfigured',capabilities:{realOrca:!!configuration.configuration,noteWrites:!!noteLink,remoteSummary:false}} satisfies AppEnvironment;
  });
  ipcMain.handle('note-app:demo',(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing) throw new Error('App window unavailable');
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
    if(!mainWindow||quitting||updateQuiescing)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one summary request');hostCleanup.markUnverified('summary-workflow-session');return action(args[0]);
  });
  ipcMain.handle('note-app:phase1-options',(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);assertNoArguments(args);
    return {noteLinkConfigured:!!noteLink,noteLinkMessage:noteLink?'등록된 프로젝트 범위에 대한 연결 제안을 검토하고 확인할 수 있습니다.':'노트 연결 변경은 시작 설정의 noteLink 항목이 필요합니다.',
      noteScopes:configuration.configuration?.noteScopes.map(scope=>({scopeId:scope.scopeId,scopePath:scope.scopePath}))??[],summaryTransport:'blocked'} satisfies Phase1Options;
  });
  ipcMain.handle('note-app:note-link-preview',(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one note preview request');if(!noteLink)throw new Error('Note link setup is not configured');return linkOperation(signal=>noteLink.preview(args[0],signal));
  });
  ipcMain.handle('note-app:note-link-confirm',(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
    if(args.length!==1)throw new Error('Expected one note confirmation');if(!noteLink)throw new Error('Note link setup is not configured');
    return linkOperation(signal=>noteLink.confirm(args[0],signal).then(result=>{if(result.status!=='rejected')void liveRuntime.refresh();return result;}));
  });
  ipcMain.handle('note-app:note-link-cancel',(event,...args)=>{
    if(!mainWindow||quitting||updateQuiescing)throw new Error('App window unavailable');assertTrustedSender(event,mainWindow.webContents,entryUrl);
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
  // Retire pending scope confirmation before disposal, then keep recovery controls alive
  // if a committed permission change could not be durably rolled back.
  if(!quitSettled&&!metadataQuitPrepared){event.preventDefault();if(metadataQuitPreparing)return;metadataQuitPreparing=true;gitMetadataGrants?.invalidate();void(async()=>{try{await gitMetadataGrants?.settle();}catch{/* Recovery state below decides whether ordinary quit is safe. */}metadataQuitPreparing=false;if(gitMetadataGrants?.hasUnresolvedRecovery()){await showWindow();if(mainWindow)await dialog.showMessageBox(mainWindow,{type:'warning',title:'로컬 읽기 허용 복구 필요',message:'읽기 허용이 저장됐을 수 있습니다. 앱을 다시 시작하기 전에 요약 설정에서 저장소 복구 후 허용 철회를 완료해 주세요.',buttons:['돌아가기']});return;}metadataQuitPrepared=true;app.quit();})();return;}
  quitting=true;gitMetadataGrants?.dispose();gitActivityIndex?.dispose();projectCreation?.dispose();orcaProjectOpener?.dispose();for(const controller of linkControllers)controller.abort();publicModel?.dispose();projectModel?.dispose();summaryReview?.dispose();summaryWorkflow?.dispose();liveRuntime?.dispose();
  if(!quitSettled){event.preventDefault();if(waitingForMutation)return;waitingForMutation=true;
    void finishQuit([...mutations,...projectSourceOperations,orcaProjectOpener?.settle()??Promise.resolve(),projectCreation?.settle()??Promise.resolve(),publicModel?.settle()??Promise.resolve(),projectModel?.settle()??Promise.resolve(),summaryReview?.settle()??Promise.resolve(),gitActivityIndex?.settle()??Promise.resolve(),gitMetadataGrants?.settle()??Promise.resolve(),liveRuntime?.settleRegistry()??Promise.resolve(),updateService?.settle?.()??Promise.resolve()],()=>{
      const finish=()=>{quitSettled=true;tray?.destroy();tray=null;app.quit();};
      if(updateQuitReady)void updateQuitReady().then(finish,()=>{updateQuitReady=undefined;finish();});else finish();
    });
  }
});
let waitingForMutation=false;
}
