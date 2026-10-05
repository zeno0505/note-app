import {app,BrowserWindow,ipcMain} from 'electron';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,chmod,symlink,rm,lstat,readlink} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createOrcaAdapter} from '../../../src/collector/orca';
import {mapWorktreesToNotes} from '../../../src/collector/notes';
import {assertTrustedSender,assertNoArguments} from '../../../src/main/security';
app.enableSandbox();
const fixtureDirectory=resolve('tests/electron/collector-fixture');
const entryUrl=pathToFileURL(join(fixtureDirectory,'index.html')).href;
let window:BrowserWindow;
let active:AbortController|null=null;
import {fixture,cleanup,roots,scenarios,type Scenario} from './setup';
app.whenReady().then(async()=>{
  window=new BrowserWindow({width:980,height:790,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:join(__dirname,'preload.cjs')}});
  window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
  const trusted=(event:Electron.IpcMainInvokeEvent)=>assertTrustedSender(event,window.webContents,entryUrl);
  ipcMain.handle('collector:run',async(event,...args)=>{
    trusted(event);
    if(args.length!==1||typeof args[0]!=='string'||!scenarios.includes(args[0] as Scenario))throw new Error('Invalid collector scenario');
    if(active)return {ok:false,kind:'busy'};
    active=new AbortController();const signal=active.signal;const scenario=args[0] as Scenario;let setup:Awaited<ReturnType<typeof fixture>>|undefined;
    try{
      setup=await fixture(scenario);
      const adapter=createOrcaAdapter({executablePath:setup.executable,timeoutMs:4000,maxOutputBytes:1024*1024});
      const observed=await adapter.collect({signal});
      if(!observed.ok)return {ok:false,kind:observed.error.kind,message:observed.error.message};
      const first=observed.value.worktrees.records[0];
      if(!first?.path||!first.identity.hostId)throw new Error('Synthetic collected worktree missing');
      const mapped=await mapWorktreesToNotes({localHostId:'local',worktrees:[{worktreeId:first.id,hostId:first.identity.hostId,worktreePath:first.path},{worktreeId:'second-synthetic',hostId:'local',worktreePath:setup.second}],scopes:[{scopeId:'project-synthetic',hostId:'local',vaultRootPath:setup.vault,scopePath:setup.scope,dagRelativePaths:['dag.yaml']}],signal});
      const projected=JSON.stringify(observed);
      if(projected.includes('SYNTHETIC_PRIVATE_BODY')||projected.includes('lastAssistantMessage')||projected.includes('toolInput'))throw new Error('Private synthetic payload escaped');
      const linkAfter=await lstat(join(setup.first,'docs/note'));
      const existingLinkUnchanged=linkAfter.isSymbolicLink()&&linkAfter.ino===setup.initialLink.ino&&linkAfter.mtimeMs===setup.initialLink.mtimeMs&&linkAfter.mode===setup.initialLink.mode&&(await readlink(join(setup.first,'docs/note')))===setup.scope;
      const noteBytesUnchanged=(await readFile(join(setup.scope,'dag.yaml'),'utf8'))==='schema: 2\ntasks: []\n';
      return {ok:true,scenario,runtimeId:observed.value.runtimeId,worktrees:observed.value.worktrees.records.length,projectCoverage:observed.value.projects.coverage.state,processCoverage:observed.value.processes.coverage.state,mappingStatus:mapped.status,canonicalDags:mapped.dags.length,linkedWorktrees:mapped.dags[0]?.worktreeIds.length??0,unresolved:mapped.mappings.filter(row=>row.state==='unresolved').map(row=>row.reason),filesystemOperations:mapped.filesystemOperations,privatePayloadDiscarded:true,existingLinkUnchanged,noteBytesUnchanged,scope:'Synthetic executable and temporary filesystem inside actual Linux Electron; not real Orca or macOS'};
    }finally{active=null;if(setup){await rm(setup.root,{recursive:true,force:true});roots.delete(setup.root);}}
  });
  ipcMain.handle('collector:cancel',(event,...args)=>{trusted(event);assertNoArguments(args);active?.abort();return {requested:true};});
  ipcMain.handle('collector:ping',(event,...args)=>{trusted(event);assertNoArguments(args);return {responsive:true};});
  ipcMain.handle('collector:cleanup',async(event,...args)=>{trusted(event);assertNoArguments(args);if(active)throw new Error('Collection still running');await cleanup();return {remainingRoots:roots.size};});
  await window.loadFile(join(fixtureDirectory,'index.html'));
});
let quitPrepared=false;
app.on('before-quit',event=>{
  if(quitPrepared)return;event.preventDefault();active?.abort();
  void(async()=>{const deadline=Date.now()+6000;while(active&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));await cleanup();quitPrepared=true;app.quit();})().catch(()=>{console.error('Test fixture cleanup failed');app.exit(1);});
});
app.on('window-all-closed',()=>app.quit());
