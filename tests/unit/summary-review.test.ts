import {it,expect,vi} from 'vitest';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSummaryReview} from '../../src/main/summary-review';
import {createModelDiagnostics} from '../../src/main/model-diagnostics';
import type {SummaryAutomationPayload} from '../../src/main/summary-automation';
import {createModelReadingStorage} from '../../src/summary/reading/model-reading-storage';
import {createModelRetryStorage} from '../../src/summary/reading/model-retry-storage';
import {SECTION_IDS,type ModelAdapter} from '../../src/summary/reading/model-harness';
import type {ProjectModelSelection} from '../../src/summary/reading/recent-tasks';
import {runSummaryReviewScenario,binding,project,source} from '../electron/summary-review-fixture/scenarios';
it('isolates custom results, restores saved manual output, cancels preflight, and tolerates unavailable automatic cache',async()=>{expect((await runSummaryReviewScenario()).status).toBe('passed');});

async function fixture(){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'summary-ticket-test-')));
 let data:{revision:number;payload:SummaryAutomationPayload}|null=null;
 let currentBinding=structuredClone(binding);
 const generate=vi.fn<ModelAdapter['generate']>(async(request,signal)=>{
  await request.beforeLaunch?.();if(signal.aborted)throw Error('Synthetic cancellation');
  return {answer:{...request.binding,sections:SECTION_IDS.map(id=>({id,text:request.pack.facts.filter(f=>f.section===id).map(f=>f.text).join(' '),facts:request.pack.facts.filter(f=>f.section===id).map(f=>({id:f.id,state:f.state})),sourceIds:[...new Set(request.pack.facts.filter(f=>f.section===id).flatMap(f=>f.sourceIds))]}))},usage:{},runtimeMs:1,provider:'synthetic-only'};
 });
 const onModelRun=vi.fn();
 const storage=createModelReadingStorage(path.join(root,'model'));
 const retryStorage=createModelRetryStorage(path.join(root,'retry'),storage.lockModelSlot,async(project,inputHash,runId)=>(await storage.failedReservation(project,inputHash))?.runId===runId);
 const review=createSummaryReview({storage,diagnostics:createModelDiagnostics(path.join(root,'diagnostics'),null),retryStorage,autoStorage:{read:async()=>structuredClone(data),write:async(payload,revision)=>{if(revision!==(data?.revision??null))throw Error('Synthetic conflict');data={payload:structuredClone(payload),revision:(revision??0)+1};return structuredClone(data);}},adapter:{generate},onModelRun,binding:async()=>structuredClone(currentBinding),source:async(_id:string,selection:ProjectModelSelection)=>source(selection),identify:(_id:string,selection:ProjectModelSelection)=>project(selection),revision:()=> 'synthetic-revision',recent:async()=>({state:'unknown',taskIds:[],activities:[],coverage:'bounded-records',omittedReferences:0,message:'Synthetic selection'}),tasks:()=>[]});
 return {review,generate,onModelRun,retryStorage,setBinding:(next:typeof binding)=>{currentBinding=structuredClone(next);},async clean(){review.dispose();await review.settle();await rm(root,{recursive:true,force:true});}};
}
const recent={workstreamId:'synthetic',selection:{purpose:'recent' as const}};

it('retains selection through revoke and auto regrant without another selectProject call',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));const f=await fixture();
 const grant=async()=>{const p=await f.review.automation.prepareConsent('synthetic');await f.review.automation.grantConsent({ticketId:p.ticketId,recurringTransferConfirmed:true,usageConfirmed:true,autoEnabled:true});};
 try{
  await f.review.selectProject('synthetic');f.review.setActivity({visible:true,active:true});await grant();
  await vi.advanceTimersByTimeAsync(10000);await f.review.settle();expect(f.onModelRun).toHaveBeenCalledTimes(1);
  f.review.cancelAll(true);await f.review.automation.revoke('synthetic');await grant();
  await vi.advanceTimersByTimeAsync(120000);await f.review.settle();
  expect(f.onModelRun).toHaveBeenCalledTimes(2);expect(f.review.automation.view('synthetic').autoEnabled).toBe(true);
  expect(f.generate).toHaveBeenCalledTimes(1); // The second run reuses the same durable successful input.
 }finally{await f.clean();vi.useRealTimers();}
});

it('consumes exact transfer tickets once and rejects cancelled or expired tickets without calls',async()=>{
 const f=await fixture();const now=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-09T00:00:00Z'));
 try{
  const cancelled=await f.review.prepareTransfer(recent);await f.review.cancelTransfer({ticketId:cancelled.ticketId});
  await expect(f.review.run(recent,{transferTicketId:cancelled.ticketId})).rejects.toThrow('Exact transfer');
  const expired=await f.review.prepareTransfer(recent);now.mockReturnValue(expired.expiresAt);
  await expect(f.review.run(recent,{transferTicketId:expired.ticketId})).rejects.toThrow('Exact transfer');
  expect(f.generate).not.toHaveBeenCalled();
  const valid=await f.review.prepareTransfer(recent);await f.review.run(recent,{transferTicketId:valid.ticketId});
  await expect(f.review.run(recent,{transferTicketId:valid.ticketId})).rejects.toThrow('Exact transfer');
  expect(f.generate).toHaveBeenCalledTimes(1);
 }finally{now.mockRestore();await f.clean();}
});

it('never returns a retry disclosure for a different account than its reserved input',async()=>{
 const f=await fixture();let release!:()=>void;
 try{
  f.generate.mockRejectedValueOnce(Error('Synthetic failed input'));
  const transfer=await f.review.prepareTransfer(recent);await f.review.run(recent,{transferTicketId:transfer.ticketId});
  let entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  vi.spyOn(f.retryStorage,'used').mockImplementationOnce(async()=>{entered();await gate;return false;});
  const pending=f.review.prepareRetry(recent);void pending.catch(()=>{});await ready;
  f.setBinding({...binding,accountId:'concurrent-other-account'});await f.review.prepareTransfer(recent);release();
  await expect(pending).rejects.toThrow('Retry recipient changed');
  expect(f.generate).toHaveBeenCalledTimes(1);
 }finally{release?.();await f.clean();}
});

it('rejects cancelled, expired, consumed, and changed-recipient retry tickets without another call',async()=>{
 const now=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-09T00:00:00Z'));const f=await fixture();
 const run=(ticketId:string)=>f.review.runRetry({ticketId,transferConfirmed:true,oneCallConfirmed:true});
 try{
  f.generate.mockRejectedValueOnce(Error('Synthetic failed input'));
  const transfer=await f.review.prepareTransfer(recent);await f.review.run(recent,{transferTicketId:transfer.ticketId});
  const cancelled=await f.review.prepareRetry(recent);expect(cancelled.transferBinding).toEqual(binding);
  f.review.cancelRetry({ticketId:cancelled.ticketId});await expect(run(cancelled.ticketId)).rejects.toThrow();
  const expired=await f.review.prepareRetry(recent);now.mockReturnValue(expired.expiresAt);await expect(run(expired.ticketId)).rejects.toThrow();
  const changed=await f.review.prepareRetry(recent);f.setBinding({...binding,accountId:'changed-after-retry-confirmation'});
  await run(changed.ticketId);await expect(run(changed.ticketId)).rejects.toThrow();
  expect(f.generate).toHaveBeenCalledTimes(1);
  f.setBinding(binding);const valid=await f.review.prepareRetry(recent);expect((await run(valid.ticketId)).state).toBe('idle');
  expect(f.generate).toHaveBeenCalledTimes(2);await expect(run(valid.ticketId)).rejects.toThrow();
 }finally{now.mockRestore();await f.clean();}
});
