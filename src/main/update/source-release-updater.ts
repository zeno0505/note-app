import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import type {UpdateState,UpdateTarget} from '../../shared/update';
import {privateUpdateDirectory,readPrivateUpdateJson,writePrivateUpdateJson} from '../update-files';
import {SourceUpdater,type SourceUpdaterOptions,type PreparedUpdate} from './source-updater';
import {SourceReleaseFeed} from './source-feed';
import {parseApprovedDemoManifest,classifyUpdate,compareUpdateVersions,UPDATE_REPOSITORY,validSourceSha,validSha256,validUpdateVersion,validUpdateBuildNumber,
  type ApprovedDemoManifest,type CurrentUpdateBuild} from './manifest';
export const SOURCE_RELEASE_MAX_AGE_MS=90*24*60*60*1000;
export const SOURCE_RELEASE_CHECK_VALIDITY_MS=60*60*1000;
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x:unknown,keys:string[]):x is Record<string,unknown>=>record(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const abort=(signal:AbortSignal)=>{if(signal.aborted)throw Object.assign(Error('Update check cancelled'),{name:'AbortError'});};
export interface SourceReleaseUpdaterOptions extends Omit<SourceUpdaterOptions,'approvedTarget'|'recovery'|'onState'> {
  feed?:Pick<SourceReleaseFeed,'fetchSourceRelease'>;
  onState?:(state:UpdateState)=>void;
}
/** Fixed remote discovery selects exact source identity; all local building and
 * installation contracts stay in the existing SourceUpdater and installer. */
export class SourceReleaseUpdater {
  private readonly current:CurrentUpdateBuild;
  private readonly root:string;
  private readonly feed:Pick<SourceReleaseFeed,'fetchSourceRelease'>;
  private state:UpdateState;
  private core:SourceUpdater|null=null;
  private target:ApprovedDemoManifest|null=null;
  private checked=0;
  private active:Promise<unknown>|null=null;
  private controller:AbortController|null=null;
  private generation=0;
  constructor(private readonly options:SourceReleaseUpdaterOptions){
    this.current={...options.current};this.root=path.join(options.home,'Library/Application Support/note-app-updater');
    this.feed=options.feed??new SourceReleaseFeed();
    this.state={status:'idle',current:{...this.current},target:null,message:'업데이트 확인을 누르면 게시된 버전을 찾습니다. 준비해 둔 업데이트도 현재 릴리스와 다시 검증합니다',checkedAt:null,progress:null,
      prerequisites:[],canCheck:true,canPrepare:false,canCancel:false,canDefer:false,canInstall:false};
  }
  private now(){return (this.options.now?.()??new Date()).getTime();}
  private fresh(){const now=this.now();return !!this.target&&this.checked>0&&now>=this.checked&&now-this.checked<SOURCE_RELEASE_CHECK_VALIDITY_MS
    &&now>=Date.parse(this.target.publishedAt)&&now-Date.parse(this.target.publishedAt)<=SOURCE_RELEASE_MAX_AGE_MS;}
  getState():UpdateState{
    const state=structuredClone(this.state);
    if(!this.fresh()&&(state.canInstall||state.canPrepare)){state.canInstall=false;state.canPrepare=false;state.message='준비한 파일은 보존했습니다. 최신 버전을 다시 확인한 뒤 계속해 주세요';}
    if(state.prerequisites.some(item=>!item.ready))state.canPrepare=false;
    return state;
  }
  getPrepared():PreparedUpdate|null{return this.fresh()&&['ready','deferred'].includes(this.state.status)?this.core?.getPrepared()??null:null;}
  private publicTarget():UpdateTarget|null{return this.target?{version:this.target.version,buildNumber:this.target.buildNumber,sourceSha:this.target.sourceSha,changelog:[...this.target.changelog],publishedAt:this.target.publishedAt}:null;}
  private publish(state:UpdateState){this.state=structuredClone(state);try{this.options.onState?.(this.getState());}catch{}return this.getState();}
  private status(status:UpdateState['status'],message:string){return this.publish({...this.state,status,message,target:this.publicTarget(),progress:null,
    canCheck:status!=='checking'&&status!=='preparing',canPrepare:false,canCancel:status==='checking'||status==='preparing',canDefer:false,canInstall:false});}
  /** Startup performs no network or build. Disk descriptors cannot nominate a release. */
  restore():Promise<UpdateState>{return Promise.resolve(this.getState());}
  private operation<T>(body:(signal:AbortSignal,generation:number)=>Promise<T>):Promise<T>{
    const controller=new AbortController(),generation=++this.generation;this.controller=controller;
    const work=Promise.resolve().then(()=>body(controller.signal,generation));
    const tracked=work.finally(()=>{if(this.active===tracked)this.active=null;if(this.controller===controller)this.controller=null;});this.active=tracked;return tracked;
  }
  private async safeDirectory(directory:string,create=false,privateMode=false){
    let created=false;if(create)await mkdir(directory,{mode:0o700}).then(()=>{created=true;}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory||stat.uid!==process.geteuid?.()||(stat.mode&(privateMode?0o077:0o022)))throw Error('Unsafe release state directory');
    if(created){const parent=await open(path.dirname(directory),constants.O_RDONLY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}}
  }
  private async storage(){
    const home=this.options.home;if(!path.isAbsolute(home)||path.resolve(home)!==home)throw Error('Invalid updater home');
    await this.safeDirectory(home);await this.safeDirectory(path.join(home,'Library'),true);await this.safeDirectory(path.join(home,'Library/Application Support'),true);
    let created=false;await mkdir(this.root,{mode:0o700}).then(()=>{created=true;}).catch(error=>{if(error.code!=='EEXIST')throw error;});await this.safeDirectory(this.root,false,true);
    if(created){
      const parent=await open(path.dirname(this.root),constants.O_RDONLY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
      await writePrivateUpdateJson(path.join(this.root,'owner.json'),{schemaVersion:1,repository:UPDATE_REPOSITORY});
    }
    const owner=await readPrivateUpdateJson(path.join(this.root,'owner.json'));
    if(!exact(owner,['schemaVersion','repository'])||owner.schemaVersion!==1||owner.repository!==UPDATE_REPOSITORY)throw Error('Unowned update state');
    for(const name of ['prepare.lock','cleanup-unverified']){
      try{await lstat(path.join(this.root,name));throw Error('Previous source preparation is not settled');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
  }
  private async acceptWatermark(target:ApprovedDemoManifest){
    const file=path.join(this.root,'source-release-watermark.json'),manifestSha256=createHash('sha256').update(JSON.stringify(target)).digest('hex');
    let previous:unknown;
    try{previous=await readPrivateUpdateJson(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(previous!==undefined){
      if(!exact(previous,['schemaVersion','version','buildNumber','sourceSha','manifestSha256'])||previous.schemaVersion!==1||!validUpdateVersion(previous.version)||!validUpdateBuildNumber(previous.buildNumber)
        ||!validSourceSha(previous.sourceSha)||!validSha256(previous.manifestSha256))throw Error('Invalid release watermark');
      if(Number(target.buildNumber)<Number(previous.buildNumber)||compareUpdateVersions(target.version,previous.version)<0
        ||(target.buildNumber===previous.buildNumber&&(target.sourceSha!==previous.sourceSha||manifestSha256!==previous.manifestSha256)))throw Error('Release was rolled back or mutated');
    }
    const temporary=path.join(this.root,`source-release-${randomUUID()}.pending`);
    await writePrivateUpdateJson(temporary,{schemaVersion:1,version:target.version,buildNumber:target.buildNumber,sourceSha:target.sourceSha,manifestSha256});
    await privateUpdateDirectory(this.root);await rename(temporary,file);
    const directory=await open(this.root,constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
  }
  check():Promise<UpdateState>{
    if(this.active)return this.active.then(()=>this.getState());
    return this.operation(async(signal,generation)=>{
      this.core=null;this.target=null;this.checked=0;this.status('checking','게시된 최신 소스 버전을 확인합니다');
      try{
        abort(signal);
        const target=parseApprovedDemoManifest(await this.feed.fetchSourceRelease(signal));abort(signal);
        if(Date.parse(target.publishedAt)>this.now()||this.now()-Date.parse(target.publishedAt)>SOURCE_RELEASE_MAX_AGE_MS)throw Error('Stale source release');
        const classification=classifyUpdate(target,this.current);
        await this.storage();abort(signal);await this.acceptWatermark(target);abort(signal);
        this.target=target;this.checked=this.now();this.state.checkedAt=new Date(this.checked).toISOString();
        if(classification==='up-to-date')return this.status('up-to-date','현재 게시된 빌드가 이미 설치되어 있습니다');
        const {feed:_,onState:__,...sourceOptions}=this.options;
        const core=new SourceUpdater({...sourceOptions,approvedTarget:target,onState:state=>{
          if(this.core===core&&!this.controller?.signal.aborted)this.publish({...state,checkedAt:new Date(this.checked).toISOString()});
        }});this.core=core;
        let hasSaved=false;try{await lstat(path.join(this.root,'prepared-state.json'));hasSaved=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        abort(signal);if(hasSaved)await core.restore();abort(signal);
        if(!core.getPrepared())await core.check();abort(signal);
        return this.publish({...core.getState(),checkedAt:new Date(this.checked).toISOString()});
      }catch(error){
        this.core=null;this.target=null;this.checked=0;
        return this.status(signal.aborted?'cancelled':(error as {code?:string}).code==='SOURCE_RELEASE_UNAVAILABLE'?'unavailable':'error',signal.aborted?'업데이트 확인을 취소했습니다. 설치된 앱은 그대로입니다'
          :(error as {code?:string}).code==='SOURCE_RELEASE_UNAVAILABLE'?'아직 게시된 업데이트가 없습니다. 현재 앱을 계속 사용할 수 있습니다'
          :'게시된 버전의 신뢰성이나 네트워크를 확인하지 못했습니다. 현재 앱과 준비한 파일은 보존했습니다. 다시 확인해 주세요');
      }
    });
  }
  prepare():Promise<PreparedUpdate|null>{
    if(this.active)return this.active.then(()=>this.getPrepared());
    if(this.getPrepared())return Promise.resolve(this.getPrepared());
    if(!this.core||!this.fresh()||!this.getState().canPrepare){this.status('error','업데이트와 실행 조건을 다시 확인한 뒤 준비해 주세요');return Promise.resolve(null);}
    const core=this.core;
    return this.operation(async signal=>{
      if(signal.aborted){this.status('cancelled','업데이트 준비를 취소했습니다. 설치된 앱은 그대로입니다');return null;}
      const result=await core.prepare();
      if(signal.aborted){this.status('cancelled','업데이트 준비를 취소했습니다. 설치된 앱은 그대로입니다');return null;}
      this.publish({...core.getState(),checkedAt:new Date(this.checked).toISOString()});return this.fresh()?result:null;
    });
  }
  async cancel():Promise<UpdateState>{
    const generation=this.generation;this.controller?.abort();const work=this.active,core=this.core;
    if(core)await core.cancel();if(work)await work.catch(()=>undefined);
    if(work&&this.generation===generation)this.status('cancelled','업데이트를 취소했습니다. 설치된 앱은 그대로입니다');return this.getState();
  }
  defer():Promise<UpdateState>{
    if(this.active)return this.active.then(()=>this.getState());if(!this.core||!this.getPrepared())return Promise.resolve(this.getState());const core=this.core;
    return this.operation(async signal=>{if(signal.aborted)return this.status('cancelled','업데이트 상태 저장을 취소했습니다. 다시 확인해 주세요');await core.defer();if(signal.aborted)return this.status('cancelled','업데이트 상태 저장을 취소했습니다. 다시 확인해 주세요');return this.publish({...core.getState(),checkedAt:new Date(this.checked).toISOString()});});
  }
}
