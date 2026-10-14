import {ipcMain} from 'electron';
import {startHost} from '../../../src/main/host';
const control={prepareMode:'normal',readDelayMs:0,prepareCalls:0,readCalls:0,releases:0,modelCalls:0};
Object.assign(globalThis,{__verificationFixture:control});
const original=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>original(channel,async(event,...args)=>{
 if(channel==='note-app:evidence-prepare'){control.prepareCalls++;if(control.prepareMode==='error')throw Error('Synthetic discovery unavailable');}
 if(channel==='note-app:evidence-read'){control.readCalls++;const delay=control.readDelayMs;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));}
 if(channel==='note-app:evidence-release')control.releases++;
 return listener(event,...args);
});
// Provider literal matches the API schema; identity and adapter are synthetic and never call a model.
startHost({summaryModelIdentity:async()=>({provider:'Anthropic Claude',accountId:'synthetic',accountLabel:'Synthetic fixture',modelPolicy:'no-model'}),summaryModelAdapter:{async generate(){control.modelCalls++;throw Error('External model prohibited in verification fixture');}}});
