import {constants} from 'node:fs';
import {lstat,open,realpath,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import type {InstallationIdentity} from './install-identity';
import type {UpdateOutcome} from '../shared/update';
import {UPDATE_REPOSITORY} from './update/manifest';
import {hashAppBundle} from '../../scripts/updater/bundle-integrity.mjs';
import {DIGEST,OUTCOME_PHASES,exactKeys,pathsFor,protocolDigest,validatePlan,validateJournal,
  validateOutcomeReceipt,validateBootAck,type InstallPlan,type InstallJournal} from '../../scripts/updater/protocol.mjs';

interface PendingOutcome {
  schemaVersion:1;updaterProtocolVersion:1;plan:InstallPlan;planSha256:string;
  dismissedEvidenceSha256:string|null;failureAt:string|null;
}
interface Observation {pending:PendingOutcome;outcome:UpdateOutcome;evidence:string;terminal:boolean}
export interface UpdateOutcomeStore {
  /** Main only: call after writing the exact plan and before launching the helper. */
  writePending(plan:unknown):Promise<void>;
  /** Read-only, bounded polling. Absence/invalid evidence never becomes success. */
  read(options?:{waitMs?:number;pollMs?:number;signal?:AbortSignal}):Promise<UpdateOutcome|null>;
  /** Main only: persist helper-launch/validation failure for the intent this process wrote. */
  recordFailure():Promise<UpdateOutcome|null>;
  /** No renderer-controlled path or ID; compare the last presented evidence with current disk state. */
  dismiss():Promise<UpdateOutcome|null>;
}
const writes=new Map<string,Promise<unknown>>();
async function exclusive<T>(key:string,work:()=>Promise<T>):Promise<T>{
  const prior=writes.get(key)??Promise.resolve();
  const flight=prior.catch(()=>{}).then(work);writes.set(key,flight);
  try{return await flight;}finally{if(writes.get(key)===flight)writes.delete(key);}
}
const validTime=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';

/** A receipt is integrity evidence, not authenticity. The trust anchor is the fixed,
 * main-created pending intent in the private updater root, never transaction discovery,
 * argv, a renderer ID, or an arbitrary journal. Same-user code execution is out of scope. */
export function createUpdateOutcomeStore(options:{home:string;installation:InstallationIdentity;version:string}):UpdateOutcomeStore{
  const root=path.join(options.home,'Library','Application Support','note-app-updater');
  const pendingPath=path.join(root,'pending-outcome.json');
  let presented:Observation|null=null,writtenPlan:string|null=null;
  const canonical=path.join(options.home,'Applications','note-app.app');
  const eligible=()=>options.installation.role==='user'&&options.installation.currentPath===canonical&&options.installation.canonicalPath===canonical;

  async function directory(location:string,privateMode=false):Promise<void>{
    if(!path.isAbsolute(location)||path.resolve(location)!==location||!path.isAbsolute(options.home)||path.resolve(options.home)!==options.home)throw Error('Noncanonical outcome path');
    let cursor=path.parse(location).root;
    for(const piece of location.slice(cursor.length).split(path.sep).filter(Boolean)){
      cursor=path.join(cursor,piece);const stat=await lstat(cursor);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe outcome ancestor');
      if(cursor===options.home||cursor.startsWith(options.home+path.sep)){
        if(stat.uid!==process.geteuid?.()||(stat.mode&0o022)!==0)throw Error('Unsafe outcome owner');
      }
      if(cursor===root||cursor.startsWith(root+path.sep))if((stat.mode&0o077)!==0)throw Error('Outcome directory must be private');
    }
    const stat=await lstat(location);
    if(await realpath(location)!==location||(privateMode&&(stat.mode&0o077)!==0))throw Error('Unsafe outcome directory');
  }
  async function readJSON(file:string,privateFile=true):Promise<unknown>{
    await directory(path.dirname(file));
    const before=await lstat(file);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==process.geteuid?.()
      ||(before.mode&(privateFile?0o077:0o022))!==0||before.size>65536)throw Error('Unsafe outcome control file');
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const stat=await handle.stat();
      if(stat.ino!==before.ino||stat.dev!==before.dev||!stat.isFile()||stat.nlink!==1||stat.uid!==process.geteuid?.()
        ||(stat.mode&(privateFile?0o077:0o022))!==0||stat.size>65536)throw Error('Outcome file changed');
      const buffer=Buffer.alloc(65537),{bytesRead}=await handle.read(buffer,0,buffer.length,0),after=await handle.stat();
      if(bytesRead!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error('Outcome file changed during read');
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)));
    }finally{await handle.close();}
  }
  async function ownedRoot():Promise<void>{
    await directory(root,true);
    const marker=await readJSON(path.join(root,'owner.json')) as Record<string,unknown>;
    exactKeys(marker,['schemaVersion','repository']);
    if(marker.schemaVersion!==1||marker.repository!==UPDATE_REPOSITORY)throw Error('Unrecognized updater root');
  }
  async function pending():Promise<PendingOutcome>{
    await ownedRoot();const value=await readJSON(pendingPath) as PendingOutcome;
    exactKeys(value,['schemaVersion','updaterProtocolVersion','plan','planSha256','dismissedEvidenceSha256','failureAt']);
    if(value.schemaVersion!==1||value.updaterProtocolVersion!==1||!DIGEST.test(value.planSha256)
      ||(value.dismissedEvidenceSha256!==null&&!DIGEST.test(value.dismissedEvidenceSha256))
      ||(value.failureAt!==null&&!validTime(value.failureAt)))throw Error('Invalid pending outcome');
    validatePlan(value.plan,Date.now(),{recovery:true});
    if(protocolDigest(value.plan)!==value.planSha256)throw Error('Pending intent integrity mismatch');
    return value;
  }
  async function replacePending(value:PendingOutcome,expected:string|null):Promise<void>{
    await ownedRoot();
    try{const current=await pending();if(expected===null||protocolDigest(current)!==expected)throw Error('Pending outcome changed');}
    catch(error){if(!missing(error)||expected!==null)throw error;}
    const temporary=pendingPath+'.'+randomBytes(8).toString('hex')+'.tmp';
    const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
    try{await rename(temporary,pendingPath);const dir=await open(root,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}
    catch(error){await unlink(temporary).catch(()=>{});throw error;}
  }
  async function installed(plan:InstallPlan,journal?:InstallJournal,phase?:string):Promise<void>{
    if(!eligible())throw Error('Outcome requires canonical installed app');
    const isTarget=options.installation.buildSha===plan.target.sourceSha&&options.installation.buildNumber===plan.target.buildNumber;
    const isCurrent=options.installation.buildSha===plan.current.sourceSha&&options.installation.buildNumber===plan.current.buildNumber;
    if((phase==='healthy'&&!isTarget)||(phase==='rolled-back'&&!isCurrent)||(!isCurrent&&!isTarget))throw Error('Running app does not match outcome');
    const metadata=await readJSON(path.join(canonical,'Contents','Resources','app','package.json'),false) as Record<string,any>;
    if(metadata.name!=='note-app'||metadata.main!=='dist/main/index.cjs'||metadata.updaterProtocolVersion!==1||metadata.installation?.role!=='user'
      ||metadata.sourceSha!==options.installation.buildSha||metadata.installation.buildNumber!==options.installation.buildNumber
      ||metadata.version!==options.version||(isTarget&&metadata.version!==plan.target.version))throw Error('Installed outcome identity mismatch');
    // The restored app may have a different version from the attempted target.
    const expected=isTarget?plan.target.appSha256:journal?.originalAppSha256;
    if(journal&&expected&&await hashAppBundle(canonical)!==expected)throw Error('Installed outcome bytes mismatch');
  }
  const view=(value:PendingOutcome,kind:UpdateOutcome['kind'],occurredAt:string):UpdateOutcome=>({
    attemptId:value.plan.transactionId,kind,targetVersion:value.plan.target.version,occurredAt,
    message:kind==='success'?`버전 ${value.plan.target.version} 업데이트를 완료했습니다.`
      :kind==='rollback'?'새 버전을 시작하지 못해 이전 앱으로 복구했습니다. 기존 설정은 유지됩니다.'
      :kind==='recovery-needed'?'업데이트 복구가 필요합니다. 앱을 정상 종료한 뒤 복구 상태를 확인해 주세요.'
      :kind==='failed'?'업데이트 설치를 완료하지 못했습니다. 상태를 확인한 뒤 다시 시도해 주세요.'
      :'업데이트 결과를 아직 확인하지 못했습니다. 설정에서 업데이트 상태를 확인해 주세요.',
  });
  async function observe():Promise<Observation|null>{
    if(!eligible())return null;
    let value:PendingOutcome;
    try{value=await pending();}catch{return null;}
    const p=pathsFor(options.home,value.plan.transactionId);
    const unknown=():Observation=>({pending:value,outcome:view(value,'unverified',value.plan.createdAt),
      evidence:protocolDigest({plan:value.planSha256,kind:'unverified'}),terminal:false});
    try{
      const diskPlan=validatePlan(await readJSON(p.plan),Date.now(),{recovery:true});
      if(protocolDigest(diskPlan)!==value.planSha256)throw Error('Pending plan changed');
      await installed(value.plan);
      // The helper writes its receipt before releasing the startup interlock.
      // Until cleanup is proven, even a healthy receipt cannot mean completion.
      const unlocked=async()=>{try{await lstat(p.lock);return false;}catch(error){if(missing(error))return true;throw error;}};
      if(!await unlocked())return unknown();
      let journal:InstallJournal;
      try{journal=validateJournal(await readJSON(p.journal),value.plan);if(Date.parse(journal.updatedAt)>Date.now()+5000)throw Error('Outcome timestamp is in the future');}
      catch(error){
        if(!missing(error)||value.failureAt===null)throw error;
        return {pending:value,outcome:view(value,'failed',value.failureAt),terminal:true,
          evidence:protocolDigest({plan:value.planSha256,failureAt:value.failureAt})};
      }
      if(!OUTCOME_PHASES.includes(journal.phase as typeof OUTCOME_PHASES[number])){
        if(value.failureAt!==null)return {pending:value,outcome:view(value,'failed',value.failureAt),terminal:true,
          evidence:protocolDigest({plan:value.planSha256,failureAt:value.failureAt})};
        return unknown();
      }
      const receipt=validateOutcomeReceipt(await readJSON(p.receipt),value.plan,journal);
      if(receipt.phase==='healthy'&&(journal.launchedPid===null||!validateBootAck(await readJSON(p.ack),value.plan,journal.launchedPid)))throw Error('Missing exact boot acknowledgement');
      await installed(value.plan,journal,receipt.phase);
      if(!await unlocked())return unknown();
      return {pending:value,outcome:view(value,receipt.phase==='healthy'?'success':receipt.phase==='rolled-back'?'rollback':receipt.phase,receipt.updatedAt),
        evidence:receipt.receiptSha256,terminal:true};
    }catch{return unknown();}
  }
  const visible=(observation:Observation|null):UpdateOutcome|null=>observation&&observation.pending.dismissedEvidenceSha256!==observation.evidence?structuredClone(observation.outcome):null;
  return {
    async writePending(input){
      if(!eligible())throw Error('Only canonical app can create update intent');
      const plan=structuredClone(validatePlan(input));
      if(plan.current.sourceSha!==options.installation.buildSha||plan.current.buildNumber!==options.installation.buildNumber||plan.currentPid!==process.pid)throw Error('Intent does not identify this process');
      await installed(plan);
      await exclusive(root,async()=>{
        await ownedRoot();const disk=validatePlan(await readJSON(pathsFor(options.home,plan.transactionId).plan));
        if(protocolDigest(disk)!==protocolDigest(plan))throw Error('Plan does not match main intent');
        let prior:PendingOutcome|null=null;try{prior=await pending();}catch(error){if(!missing(error))throw error;}
        const value:PendingOutcome={schemaVersion:1,updaterProtocolVersion:1,plan,planSha256:protocolDigest(plan),dismissedEvidenceSha256:null,failureAt:null};
        await replacePending(value,prior?protocolDigest(prior):null);writtenPlan=value.planSha256;presented=null;
      });
    },
    async read(settings={}){
      const waitMs=Math.min(60000,Math.max(0,settings.waitMs??1500));
      const pollMs=Math.min(1000,Math.max(10,settings.pollMs??100));
      const deadline=Date.now()+waitMs;let observation=await observe();
      while(observation&&!observation.terminal&&Date.now()<deadline&&!settings.signal?.aborted){
        await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);settings.signal?.removeEventListener('abort',finish);resolve();};
          const timer=setTimeout(finish,Math.min(pollMs,Math.max(0,deadline-Date.now())));settings.signal?.addEventListener('abort',finish,{once:true});});
        observation=await observe();
      }
      presented=observation;return visible(observation);
    },
    async recordFailure(){
      await exclusive(root,async()=>{
        const value=await pending();if(!writtenPlan||value.planSha256!==writtenPlan)throw Error('Failure does not identify the main intent');
        const next={...value,failureAt:value.failureAt??new Date().toISOString()};await replacePending(next,protocolDigest(value));
      });
      presented=await observe();return visible(presented);
    },
    async dismiss(){
      const expected=presented;
      return exclusive(root,async()=>{
        const current=await observe();
        if(!expected||!current||expected.pending.planSha256!==current.pending.planSha256||expected.evidence!==current.evidence){presented=current;return visible(current);}
        if(current.pending.dismissedEvidenceSha256!==current.evidence){
          await replacePending({...current.pending,dismissedEvidenceSha256:current.evidence},protocolDigest(current.pending));
        }
        presented=null;return null;
      });
    },
  };
}
