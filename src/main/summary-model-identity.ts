import {execFile} from 'node:child_process';
import {subscriptionEnvironment} from '../summary/reading/claude-public-adapter';

import {parseSummaryModelIdentity,type SummaryModelIdentity} from '../summary/reading/claude-account-identity';
export {parseSummaryModelIdentity,SUMMARY_MODEL_POLICY} from '../summary/reading/claude-account-identity';
export function readSummaryModelIdentity(executable:string,cwd:string,env:NodeJS.ProcessEnv,signal?:AbortSignal):Promise<SummaryModelIdentity>{
  return new Promise((resolve,reject)=>{execFile(executable,['--safe-mode','auth','status','--json'],{cwd,env:subscriptionEnvironment(env),encoding:'utf8',timeout:10000,maxBuffer:65536,signal},(error,stdout)=>{if(error||signal?.aborted)return reject(Error('AI account verification unavailable'));try{resolve(parseSummaryModelIdentity(JSON.parse(stdout)));}catch{reject(Error('AI account verification unavailable'));}});});
}
