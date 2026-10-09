import {randomBytes} from 'node:crypto';
import {cp,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {UpdateState,UpdateOutcome} from '../shared/update';
import type {InstallationIdentity} from './install-identity';
import {SourceReleaseUpdater} from './update/source-release-updater';
import {createUpdateOutcomeStore} from './update-outcome';
import {privateUpdateDirectory,writePrivateUpdateJson,readPrivateUpdateJson} from './update-files';
export interface UpdateService {
  getState():UpdateState;check():Promise<UpdateState>;prepare():Promise<UpdateState>;cancel():Promise<UpdateState>;
  defer():Promise<UpdateState>|UpdateState;install():Promise<UpdateState>;dismissOutcome():Promise<UpdateState>|UpdateState;subscribe(listener:(state:UpdateState)=>void):()=>void;
  settle?():Promise<unknown>;
}
/** Fixed HTTPS discovery lives in main; renderer and environment cannot select a release. */
export function createUpdateService(options:{home:string;installation:InstallationIdentity;version:string;installerDirectory:string;restartConfigurationPath?:string;
  cleanup():Promise<void>;requestQuit(writeReady:()=>Promise<void>):void;
}):UpdateService{
  if(options.restartConfigurationPath&&(!path.isAbsolute(options.restartConfigurationPath)||path.normalize(options.restartConfigurationPath)!==options.restartConfigurationPath||/[\x00-\x1f\x7f]/.test(options.restartConfigurationPath)))throw Error('Invalid existing restart configuration');
  const listeners=new Set<(state:UpdateState)=>void>();let override:UpdateState|null=null,installFlight:Promise<UpdateState>|null=null,quitting=false,shuttingDown=false;
  const ownedWrites=new Set<Promise<unknown>>();let writeCleanupFailed=false;
  function ownWrite<T>(operation:Promise<T>):Promise<T>{ownedWrites.add(operation);void operation.then(()=>ownedWrites.delete(operation),()=>{ownedWrites.delete(operation);writeCleanupFailed=true;});return operation;}
  let dismissFlight:Promise<UpdateState>|null=null;
  let outcome:UpdateOutcome|null=null;const outcomeAbort=new AbortController();
  const outcomeStore=createUpdateOutcomeStore({home:options.home,installation:options.installation,version:options.version});
  const emit=()=>{const view=getState();for(const listener of listeners)try{listener(view);}catch{}};
  const core=new SourceReleaseUpdater({home:options.home,current:{version:options.version,buildNumber:options.installation.buildNumber,sourceSha:options.installation.buildSha},onState:()=>{override=null;emit();}});
  function getState(){return structuredClone({... (override??core.getState()),outcome});}
  const sourceReady=Promise.resolve().then(()=>core.restore());
  const outcomeReady=Promise.resolve().then(()=>outcomeStore.read({waitMs:60_000,pollMs:200,signal:outcomeAbort.signal})).then(value=>{outcome=value;emit();}).catch(()=>{/* Invalid or inaccessible receipts never become success. */});
  void sourceReady.catch(()=>{override={...core.getState(),status:'error',message:'저장된 업데이트 준비를 확인하지 못했습니다. 다시 확인하고 준비해 주세요.',canInstall:false,canDefer:false};emit();});
  function installing(message:string){override={...core.getState(),status:'installing',message,canCheck:false,canPrepare:false,canCancel:false,canInstall:false,canDefer:false};emit();}
  function failure(){override={...core.getState(),status:'error',message:'설치를 시작하지 못했습니다. 기존 앱과 설정은 보존했습니다. 진행 중인 작업·저장·조회 정리가 불확실하면 앱을 정상 종료한 뒤 다시 열어 설치해 주세요. 조회가 중단되었을 수 있습니다.',canCheck:true,canPrepare:false,canCancel:false,canInstall:!!core.getPrepared(),canDefer:!!core.getPrepared()};emit();return getState();}
  async function install():Promise<UpdateState>{
    await sourceReady;await outcomeReady;await Promise.allSettled([...ownedWrites]);
    if(writeCleanupFailed)return failure();
    if(installFlight)return installFlight;
    if(shuttingDown||quitting)return getState();
    const prepared=core.getPrepared();
    if(!prepared||process.platform!=='darwin'||options.installation.role!=='user')return failure();
    const work=(async()=>{
      let pendingWritten=false;
      const continuing=()=>{if(shuttingDown)throw Error('Application is quitting; installation handoff cancelled');};
      installing('설치 준비와 무결성을 확인합니다. 기존 앱은 아직 교체하지 않습니다.');
      try{
        continuing();
        const transactionId=randomBytes(16).toString('hex'),nonce=randomBytes(32).toString('hex');
        const root=path.join(options.home,'Library','Application Support','note-app-updater'),directory=path.join(root,'transactions',transactionId);
        await privateUpdateDirectory(root);continuing();await privateUpdateDirectory(directory,true);continuing();
        const plan={schemaVersion:1,transactionId,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+10*60*1000).toISOString(),currentPid:process.pid,
          current:{sourceSha:options.installation.buildSha,buildNumber:options.installation.buildNumber},
          target:{sourceSha:prepared.target.sourceSha,sourceTree:prepared.sourceTree,buildNumber:prepared.target.buildNumber,version:prepared.target.version,architecture:prepared.architecture,appSha256:prepared.appSha256},nonce};
        await cp(prepared.appPath,path.join(directory,'note-app.app'),{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});continuing();
        await cp(prepared.packageManifestPath,path.join(directory,'note-app.app.manifest.json'),{errorOnExist:true,force:false});continuing();
        // The installer code is copied from the running verified bundle, not from candidate source.
        const installerStat=await lstat(options.installerDirectory);if(!installerStat.isDirectory()||installerStat.isSymbolicLink()||await realpath(options.installerDirectory)!==options.installerDirectory)throw Error('Invalid installer code');
        await cp(options.installerDirectory,path.join(directory,'installer'),{recursive:true,dereference:false,errorOnExist:true,force:false});continuing();
        await writePrivateUpdateJson(path.join(directory,'plan.json'),plan);continuing();
        const nodeExecutable=prepared.nodeExecutable;
        if(!path.isAbsolute(nodeExecutable)||await realpath(nodeExecutable)!==nodeExecutable)throw Error('Invalid Node runtime');
        const nodeStat=await lstat(nodeExecutable);if(!nodeStat.isFile()||nodeStat.isSymbolicLink()||(nodeStat.mode&0o022))throw Error('Unsafe Node runtime');
        if(core.getPrepared()!==prepared)throw Error('Release check expired during installation preparation');
        await outcomeStore.writePending(plan);pendingWritten=true;continuing();
        if(core.getPrepared()!==prepared)throw Error('Release check expired before installer launch');
        let installerExited=false;
        await new Promise<void>((resolve,reject)=>{
          const child=spawn(nodeExecutable,[path.join(directory,'installer','update-installer.mjs'),'--plan',path.join(directory,'plan.json')],{detached:true,stdio:'ignore',shell:false,
            env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:options.home,LANG:'C',LC_ALL:'C',...(options.restartConfigurationPath?{NOTE_APP_CONFIG:options.restartConfigurationPath}:{})}});
          child.once('error',reject);child.once('exit',()=>{installerExited=true;});child.once('spawn',()=>{child.unref();resolve();});
        });
        const validationDeadline=Date.now()+120_000;let validated=false;
        while(!validated){
          continuing();
          if(installerExited||Date.now()>=validationDeadline)throw Error('Installer did not validate the transaction');
          try{const journal=await readPrivateUpdateJson(path.join(directory,'journal.json')) as Record<string,unknown>;validated=journal.schemaVersion===1&&journal.transactionId===transactionId&&journal.phase==='validated';if(journal.phase==='failed'||journal.phase==='recovery-needed')throw Error('Installer rejected the transaction');}
          catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          if(!validated)await new Promise(resolve=>setTimeout(resolve,100));
        }
        continuing();await options.cleanup();continuing();
        quitting=true;installing('준비된 업데이트를 설치하기 위해 앱을 정상 종료하고 다시 엽니다.');
        options.requestQuit(()=>writePrivateUpdateJson(path.join(directory,'quit-ready.json'),{schemaVersion:1,transactionId,nonce,currentPid:process.pid,sourceSha:options.installation.buildSha,buildNumber:options.installation.buildNumber,quitSettled:true}));
        return getState();
      }catch{if(pendingWritten)try{outcome=await outcomeStore.recordFailure();}catch{}return failure();}
    })();
    installFlight=work;try{return await work;}finally{installFlight=null;}
  }
  function dismissOutcome():Promise<UpdateState>{
    if(dismissFlight)return dismissFlight;
    const work=(async()=>{if(installFlight||quitting||shuttingDown)return getState();await outcomeReady;if(installFlight||quitting||shuttingDown)return getState();outcome=await ownWrite(outcomeStore.dismiss());emit();return getState();})();
    const tracked=work.finally(()=>{if(dismissFlight===tracked)dismissFlight=null;});dismissFlight=tracked;return tracked;
  }
  return {getState,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    async check(){await sourceReady;if(installFlight||quitting||shuttingDown)return getState();override=null;await core.check();return getState();},
    async prepare(){await sourceReady;if(installFlight||quitting||shuttingDown)return getState();override=null;await core.prepare();return getState();},
    async cancel(){if(installFlight||quitting||shuttingDown)return getState();override=null;await core.cancel();return getState();},
    async defer(){await sourceReady;if(installFlight||quitting||shuttingDown)return getState();override=null;await ownWrite(core.defer());return getState();},install,
    dismissOutcome,
    async settle(){shuttingDown=true;outcomeAbort.abort();await core.cancel();await Promise.allSettled([sourceReady,outcomeReady,dismissFlight,...ownedWrites]);if(!quitting&&installFlight)await installFlight;},
  };
}
