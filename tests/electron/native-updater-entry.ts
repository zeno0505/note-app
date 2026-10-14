// Compiled only by native-updater-smoke.mjs; never used by the packaged production entry.
import {app} from 'electron';
import {readFileSync,mkdirSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import {startHost} from '../../src/main/host';
import {writePrivateUpdateJson,readPrivateUpdateJson} from '../../src/main/update-files';
import {createUpdateOutcomeStore} from '../../src/main/update-outcome';
const metadata=JSON.parse(readFileSync(path.join(app.getAppPath(),'package.json'),'utf8'));
const fixture=metadata.nativeFixture,home=fixture.home;
const marker=JSON.parse(readFileSync(path.join(home,'native-fixture-owner.json'),'utf8'));
if(JSON.stringify(marker)!==JSON.stringify(fixture))throw Error('Not owned fixture');
for(const name of ['home','appData','userData','sessionData','temp','logs','crashDumps'] as const){const location=name==='home'?home:path.join(home,'runtime',name);mkdirSync(location,{recursive:true,mode:0o700});app.setPath(name,location);}
delete process.env.NOTE_APP_CONFIG;
app.setActivationPolicy('accessory');
app.on('browser-window-created',(_event,window)=>{window.setFocusable(false);window.setOpacity(0);});
const quitRequest=path.join(home,'fixture-quit-'+process.pid);
const quitTimer=setInterval(()=>{try{const request=JSON.parse(readFileSync(quitRequest,'utf8'));if(request.pid!==process.pid||request.token!==fixture.token)throw Error('Invalid fixture quit request');clearInterval(quitTimer);appendFileSync(path.join(home,'normal-quit.jsonl'),JSON.stringify({pid:process.pid,via:'owned control request -> app.quit'})+'\n',{mode:0o600});app.quit();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}},100);quitTimer.unref();
app.on('will-quit',()=>clearInterval(quitTimer));
appendFileSync(path.join(home,'fixture-started-'+process.pid),'ready',{mode:0o600});
const mode=metadata.nativeFixtureMode;
if(mode==='crash'){app.whenReady().then(()=>process.exit(42));}
else if(mode==='hang'){app.enableSandbox();app.whenReady().then(()=>appendFileSync(path.join(home,'hung-start.jsonl'),JSON.stringify({pid:process.pid})+'\n',{mode:0o600}));app.on('window-all-closed',()=>{});}
else if(mode==='current'&&!process.argv.some(a=>a.startsWith('--note-app-recovery-transaction='))){
 startHost({updateServiceFactory:options=>{
  let plan=JSON.parse(readFileSync(path.join(home,'fixture-plan.json'),'utf8'));
  const directory=path.join(home,'Library','Application Support','note-app-updater','transactions',plan.transactionId);
  const listeners=new Set<(s:any)=>void>();let state:any={status:'ready',current:{version:'0.1.0',...plan.current},target:{version:'0.1.0',buildNumber:plan.target.buildNumber,sourceSha:plan.target.sourceSha,changelog:['Owned native fixture; preparation synthetic'],publishedAt:plan.createdAt},message:'Native fixture stage already built; no network/model calls',checkedAt:null,progress:{step:'Fixture preparation',completed:7,total:7},prerequisites:[],canCheck:false,canPrepare:false,canCancel:false,canDefer:false,canInstall:true};
  const outcome=createUpdateOutcomeStore({home,installation:options.installation,version:options.version});
  return {getState:()=>structuredClone(state),subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},check:async()=>state,prepare:async()=>state,cancel:async()=>state,defer:async()=>state,dismissOutcome:async()=>state,settle:async()=>{},install:async()=>{
   plan=JSON.parse(readFileSync(path.join(home,'fixture-plan.json'),'utf8'));
   const deadline=Date.now()+30000;
   while(true){try{const journal:any=await readPrivateUpdateJson(path.join(directory,'journal.json'));if(journal.phase==='validated')break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(Date.now()>deadline)throw Error('Fixture installer validation timeout');await new Promise(r=>setTimeout(r,50));}
   state={...state,status:'installing',canInstall:false};for(const listener of listeners)listener(state);
   try{await outcome.writePending(plan);await options.cleanup();}catch(error){appendFileSync(path.join(home,'install-error.json'),JSON.stringify({error:String(error),stack:(error as Error).stack,areas:(error as any).areas,reason:(error as any).reason}),{mode:0o600});throw error;}
   options.requestQuit(()=>writePrivateUpdateJson(path.join(directory,'quit-ready.json'),{schemaVersion:1,transactionId:plan.transactionId,nonce:plan.nonce,currentPid:process.pid,sourceSha:plan.current.sourceSha,buildNumber:plan.current.buildNumber,quitSettled:true}));
   return state;
  }};
 }});
}else startHost();
