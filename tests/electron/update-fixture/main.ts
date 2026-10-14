import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {startHost} from '../../../src/main/host';
import type {UpdateOutcome,UpdateState,UpdateTarget} from '../../../src/shared/update';

/** Deliberately synthetic, main-only entry. No production configuration enables this service. */
const control=process.env.NOTE_APP_UPDATE_TEST_CONTROL;
const log=process.env.NOTE_APP_UPDATE_TEST_LOG;
if(!control||!log)throw new Error('Explicit synthetic updater fixture control is required');
const target:UpdateTarget={version:'0.1.1-demo',buildNumber:'20261008001',sourceSha:'b'.repeat(40),publishedAt:'2026-10-08T00:00:00.000Z',changelog:['가상 검증용 업데이트입니다.','<img src=x onerror=alert(1)> 텍스트를 안전하게 표시합니다.']};
const current={version:'0.1.0',buildNumber:'20261007001',sourceSha:'a'.repeat(40)};
let state:UpdateState={status:'idle',current,target:null,message:'가상 검증용 상태입니다. 아직 업데이트를 확인하지 않았습니다.',checkedAt:null,prerequisites:[],canCheck:true,canPrepare:false,canCancel:false,canDefer:false,canInstall:false};
const listeners=new Set<(state:UpdateState)=>void>();
let generation=0;
const persistenceFile=path.join(path.dirname(control),'synthetic-updater-state.json');
type FixturePersistence={deferred:boolean;dismissedAttemptIds:string[]};
let persisted:FixturePersistence={deferred:false,dismissedAttemptIds:[]};
try{persisted=JSON.parse(readFileSync(persistenceFile,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
function persist(){writeFileSync(persistenceFile,JSON.stringify(persisted),{mode:0o600});}
const clone=()=>structuredClone(state);
function record(action:string){appendFileSync(log!,JSON.stringify({action,at:new Date().toISOString()})+'\n',{mode:0o600});}
function set(change:Partial<UpdateState>){state={...state,...change};for(const listener of listeners)listener(clone());return clone();}
function ready(){return set({status:'ready',message:'가상 업데이트 준비가 끝났습니다. 실제 설치 파일은 만들지 않았습니다.',progress:{step:'가상 준비 완료',completed:7,total:7},canCheck:true,canPrepare:false,canCancel:false,canDefer:true,canInstall:true});}
const settings=()=>JSON.parse(readFileSync(control!,'utf8')) as {scenario?:string;checkDelayMs?:number;prepareDelayMs?:number;restartOutcome?:UpdateOutcome['kind'];attemptId?:string;invalidDeferred?:boolean};
const startup=settings();
if(persisted.deferred){
  state={...state,status:'deferred',target,message:startup.invalidDeferred?'가상 검증: 저장된 준비 파일의 검증이 실패했습니다.':'가상 검증: 저장된 준비 상태를 복원하고 파일을 다시 검증했습니다.',progress:startup.invalidDeferred?null:{step:'가상 저장된 준비 검증 완료',completed:7,total:7},canInstall:!startup.invalidDeferred};
}
if(startup.restartOutcome){
  const outcome:UpdateOutcome={attemptId:startup.attemptId??`fixture-${startup.restartOutcome}`,kind:startup.restartOutcome,targetVersion:target.version,occurredAt:'2026-10-08T01:00:00.000Z'};
  if(!persisted.dismissedAttemptIds.includes(outcome.attemptId))state={...state,outcome};
  if(outcome.kind==='success')state={...state,current:{version:target.version,sourceSha:target.sourceSha,buildNumber:target.buildNumber}};
}
startHost({updateService:{
  getState:()=>clone(),
  subscribe(listener:(state:UpdateState)=>void){listeners.add(listener);return ()=>listeners.delete(listener);},
  async check(){
    if(!state.canCheck)return clone();
    record('check');const own=++generation,{scenario,checkDelayMs}=settings();
    set({status:'checking',canCheck:false,canPrepare:false,canCancel:true,canDefer:false,canInstall:false,message:'가상 게시 정보를 확인하는 중입니다.'});
    await new Promise(resolve=>setTimeout(resolve,checkDelayMs??120));
    if(generation!==own)return clone();
    const common={checkedAt:new Date().toISOString(),progress:null,canCheck:true,canCancel:false,canDefer:false,canInstall:false};
    if(scenario==='unavailable')return set({...common,status:'unavailable',target:null,message:'승인되어 게시된 업데이트 대상이 없습니다. 업데이트를 사용할 수 없습니다.',canPrepare:false,prerequisites:[]});
    if(scenario==='error')return set({...common,status:'error',target:null,message:'가상 검증: 게시 정보 확인에 실패했습니다.',canPrepare:false});
    if(scenario==='up-to-date')return set({...common,status:'up-to-date',target:{...target,...current},message:'현재 빌드가 승인된 최신 빌드입니다.',canPrepare:false});
    const tools=[{id:'node',label:'Node.js 24 이상'},{id:'npm',label:'npm'},{id:'git',label:'Git'}];
    const prerequisites=tools.map(tool=>({...tool,ready:scenario!==`blocked-${tool.id}`,detail:scenario===`blocked-${tool.id}`?`가상 검증: ${tool.label}을 사용할 수 없습니다. 필요한 도구를 설치하거나 경로를 확인한 뒤 앱을 다시 열어 주세요.`:'가상 검증용 준비 상태'}));
    return set({...common,status:'available',target,message:'게시 채널의 가상 대상 소스를 이 Mac에서 빌드할 수 있습니다.',canPrepare:prerequisites.every(item=>item.ready),prerequisites});
  },
  async prepare(){
    if(!state.canPrepare)return clone();
    record('prepare');const own=++generation;
    const stages=['도구와 전용 저장 폴더 확인','승인된 커밋 가져오기','의존성 설치','소스 검사','앱 빌드','앱 패키징','빌드 정보와 서명 검증'];
    const delay=(settings().prepareDelayMs??700)/stages.length;
    for(const [completed,step] of stages.entries()){
      set({status:'preparing',message:'가상 업데이트를 준비하는 중입니다. 실제 소스를 내려받거나 빌드하지 않습니다.',progress:{step:`가상 ${step}`,completed,total:7},canCheck:false,canPrepare:false,canCancel:true,canDefer:false,canInstall:false});
      await new Promise(resolve=>setTimeout(resolve,delay));
      if(generation!==own)return clone();
    }
    if(settings().scenario==='prepare-error')return set({status:'error',message:'가상 검증: 업데이트 준비에 실패했습니다. 기존 앱은 유지합니다.',progress:null,canCheck:true,canPrepare:true,canCancel:false});
    return ready();
  },
  async cancel(){
    if(!state.canCancel)return clone();record('cancel');generation++;
    return set({status:'cancelled',message:'업데이트 준비를 취소했습니다. 기존 앱을 계속 사용할 수 있습니다.',progress:null,canCheck:true,canPrepare:!!state.target,canCancel:false});
  },
  async defer(){
    if(!state.canDefer)return clone();record('defer');
    persisted.deferred=true;persist();
    return set({status:'deferred',message:'검증된 가상 준비 상태를 저장했습니다. 나중에 설치할 수 있습니다.',canCheck:true,canPrepare:false,canDefer:false,canInstall:true});
  },
  async install(){
    if(!state.canInstall)return clone();record('install');
    persisted.deferred=false;persist();
    return set({status:'installing',message:'가상 검증: 설치 요청을 확인했습니다. 실제 설치·종료·재시작은 수행하지 않았습니다.',canCheck:false,canPrepare:false,canCancel:false,canDefer:false,canInstall:false});
  },
  async dismissOutcome(){
    if(!state.outcome)return clone();record('dismiss-outcome');
    if(settings().scenario==='dismiss-error')throw new Error('Synthetic dismissal write failure');
    persisted.dismissedAttemptIds.push(state.outcome.attemptId);persist();
    return set({outcome:null});
  },
}});
