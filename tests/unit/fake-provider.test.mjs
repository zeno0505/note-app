import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {access,readFile} from 'node:fs/promises';
import {runFakeProvider} from '../helpers/fake-provider-runner.mjs';
import {gateOperationDeadline} from './helpers/process-startup';
import preview from '../../fixtures/summary-quality/public-one-shot-preview.json' with {type:'json'};
const base={requestId:'request-public-preview',input:preview.exactInput,deadlineMs:2000};
async function running(pid){
 expect(Number.isSafeInteger(pid)&&pid>1).toBe(true);
 try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return false;throw e;}
 if(process.platform==='linux'){
  try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');if(['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]))return false;}
  catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return false;throw e;}
 }
 return true;
}
const barrier=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function runReadyProvider(options){
 const controller=new AbortController(),deadline=gateOperationDeadline(options.deadlineMs);
 const pending=runFakeProvider({...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal,
  onRequest:phase=>{deadline.start();options.onRequest?.(phase);}});
 void pending.catch(()=>{});
 try{return await pending;}
 finally{controller.abort();await pending.catch(()=>{});deadline.dispose();}
}
describe.runIf(['darwin','linux'].includes(process.platform))('new test-only fake provider process evidence, never a model runner',()=>{
 it('passes the exact bounded preview with fixed argv, an empty owned cwd and no inherited configuration env',async()=>{
  const result=await runReadyProvider(base);expect(result.status).toBe('fake-complete');expect(result.modelRun).toBe(false);
  const body=JSON.parse(result.body);expect(body.inputSha256).toBe(preview.exactInputSha256);expect(body.argv).toEqual([]);
  expect(body.envKeys.filter(k=>k!=='__CF_USER_TEXT_ENCODING')).toEqual(['NOTE_APP_FAKE_MODE']);
  expect(result.plan).toMatchObject({executableKind:'current-node',environmentKeys:['NOTE_APP_FAKE_MODE'],cwdKind:'owned-empty-temporary-directory'});
  expect(await running(result.pid)).toBe(false);await expect(access(body.cwd)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('rejects another request frame and output/stderr floods; process exit alone is not completion',async()=>{
  for(const [mode,status] of [['wrong-request','invalid-frame'],['oversize','output-budget'],['stderr','stderr-budget']]){
   const result=await runReadyProvider({...base,mode});expect(result.status).toBe(status);expect(result.modelRun).toBe(false);
   expect(result.spawned).toBe(true);expect(await running(result.pid)).toBe(false);
  }
 });
 it('enforces an ungated startup-inclusive deadline and pre-aborted cancellation without spawning',async()=>{
  const result=await runFakeProvider({...base,mode:'stall',deadlineMs:200});expect(result.status).toBe('deadline');expect(result.spawned).toBe(true);expect(await running(result.pid)).toBe(false);
  const signal=AbortSignal.abort();expect(await runFakeProvider({...base,signal})).toMatchObject({status:'cancelled',spawned:false});
 });
 it('enforces the operation deadline after the fixture accepts a request',async()=>{
  let requestPid;const result=await runReadyProvider({...base,mode:'stall',deadlineMs:200,onRequest:({pid})=>{requestPid=pid;}});
  expect(result).toMatchObject({status:'deadline',spawned:true,pid:requestPid});expect(await running(requestPid)).toBe(false);
 });
 it('cancels a ready pending request even when asynchronous setup is held',async()=>{
  const controller=new AbortController(),entered=barrier(),setup=barrier();let requestPid,settled=false;
  const pending=runReadyProvider({...base,mode:'stall',signal:controller.signal,
   beforeSetup:async()=>{entered.release();await setup.promise;},
   onRequest:({pid})=>{requestPid=pid;controller.abort();}}).finally(()=>{settled=true;});
  void pending.catch(()=>{});
  try{
   await entered.promise;expect(settled).toBe(false);expect(requestPid).toBeUndefined();expect(controller.signal.aborted).toBe(false);
   setup.release();const result=await pending;
   expect(result).toMatchObject({status:'cancelled',spawned:true,pid:requestPid});expect(await running(requestPid)).toBe(false);
  }finally{setup.release();controller.abort();await pending.catch(()=>{});}
 });
 it('distinguishes cancellation during held setup from cancellation of a spawned request',async()=>{
  const controller=new AbortController(),entered=barrier(),setup=barrier();let becameReady=false;
  const pending=runFakeProvider({...base,signal:controller.signal,beforeSetup:async()=>{entered.release();await setup.promise;},onReady:()=>{becameReady=true;}});
  try{
   await entered.promise;controller.abort();setup.release();
   expect(await pending).toMatchObject({status:'cancelled',spawned:false});expect(becameReady).toBe(false);
  }finally{setup.release();controller.abort();await pending.catch(()=>{});}
 });
 it('waits for explicit readiness after startup exceeds the former success budget',async()=>{
  const started=performance.now(),result=await runReadyProvider({...base,mode:'slow-success'});
  expect(performance.now()-started).toBeGreaterThanOrEqual(base.deadlineMs);
  expect(result.status).toBe('fake-complete');expect(await running(result.pid)).toBe(false);
 },10000);
 it('joins a fixture after a readiness observer fails before removing its working directory',async()=>{
  let owned;
  await expect(runReadyProvider({...base,mode:'stall',onReady:phase=>{owned=phase;throw new Error('Synthetic readiness observation failed');}})).rejects.toThrow('Synthetic readiness observation failed');
  expect(owned).toBeDefined();expect(await running(owned.pid)).toBe(false);
  await expect(access(owned.cwd)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('cleans a ready fixture descendant even after the fixture parent has exited',async()=>{
  const result=await runReadyProvider({...base,mode:'descendant'});expect(result.status).toBe('fake-complete');const pid=JSON.parse(result.body).ownedDescendantPid;
  expect(await running(result.pid)).toBe(false);expect(await running(pid)).toBe(false);
 });
 it('does not expose arbitrary executable/model/mode routes and bounds input before spawning',async()=>{
  await expect(runFakeProvider({...base,mode:'claude'})).rejects.toThrow(/Invalid fake/);
  await expect(runFakeProvider({...base,input:'가'.repeat(6000)})).rejects.toThrow(/Input budget/);
  expect(createHash('sha256').update(base.input).digest('hex')).toBe(preview.exactInputSha256);
 });
});
