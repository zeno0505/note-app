import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,symlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {buildContextPack,type ContextRecord} from '../../../src/summary/context';
import {ASPECTS,bindSummaryContext,createSummaryStore,restoreSummaryStoreFromLocalCache,type SummaryResponse} from '../../../src/summary/claims';
import {createLocalSummaryCache,MAX_SUMMARY_CACHE_BYTES,SummaryCacheError} from '../../../src/summary/storage';
import {summaryCacheCodec,type SummaryCachePayload} from '../../../src/summary/storage/payload';
const at='2026-10-02T12:00:00.000Z';const later='2026-10-02T13:00:00.000Z';
const filename='summary-cache-v1.json';
const provenance='Historical synthetic approval; local-only provenance, not authenticated user consent';
function pack(changed=false){
 const records:ContextRecord[]=['a','b'].map((sourceId,index)=>({sourceId,sourceHash:`sha256:${(changed&&index===0?'c':sourceId).repeat(64)}`,observedAt:changed&&index===0?later:at,text:`Synthetic source ${sourceId}: ${changed&&index===0?'work changed':'work is running'}.`,declaredStatus:'running',dependencies:[]}));
 return buildContextPack({schemaVersion:1,scopeId:'synthetic-cache',records,coverage:{complete:true,totalCount:2,unknowns:[]},previousSources:[],priorApprovedSummary:null,limits:{maxBytes:32768,maxApproxTokens:32768,maxRecords:256}});
}
function seed(){
 const context=pack();const store=createSummaryStore(context);
 const response:SummaryResponse={schemaVersion:1,...bindSummaryContext(context),generatedAt:at,claims:ASPECTS.map((aspect,index)=>{const source=context.records[index<3?0:1];return {claimId:aspect,aspect,kind:aspect==='next'?'inference':'fact',text:source.text,intent:aspect==='next'?'proposal':'informational',citations:[{sourceId:source.sourceId,sourceHash:source.sourceHash,observedAt:source.observedAt,quote:source.text}],assertions:[{type:'declared-status',sourceId:source.sourceId,status:'running'}]};})};
 assert(store.acceptResponse(store.beginUpdate()!,response));const state=store.snapshot();assert.equal(state.approved,null);
 assert(store.approve({kind:'user-summary-approval',incarnation:state.incarnation,scopeId:context.scopeId,candidateHash:state.candidate!.candidateHash,expectedVersion:state.version,approvalId:'synthetic-cache-approval',approvedAt:at}));
 return {state:store.exportState(),projectionContexts:[]} satisfies SummaryCachePayload;
}
async function cacheAt(root:string,name:string){const directory=join(root,name);await mkdir(directory,{recursive:true,mode:0o700});return {directory,cache:createLocalSummaryCache({directory,codec:summaryCacheCodec})};}
function errorCode(code:SummaryCacheError['code']){return (error:unknown)=>error instanceof SummaryCacheError&&error.code===code;}
async function noDebris(directory:string){const debris=(await readdir(directory)).filter(name=>name==='.summary-cache.lock'||name.endsWith('.tmp'));assert.deepEqual(debris,[]);return true;}
export const scenarioNames=['save','restore','changed-evidence','failure-boundaries'] as const;
export type Scenario=typeof scenarioNames[number];
export async function runScenario(scenario:Scenario,root:string){
 const {cache}=await cacheAt(root,'historical-cache');
 if(scenario==='save'){
  assert.equal(await cache.read(),null);const result=await cache.write(seed(),null);assert.equal(result.revision,1);
  return {scenario,status:'Synthetic approval saved',revision:result.revision,approvalId:result.payload.state.approved!.approvalId,candidateHash:result.payload.state.approved!.summary.candidateHash,approvalEventsThisScenario:1,provenance};
 }
 const historical=await cache.read();assert(historical,'The saved cache must exist; missing is not restore success');
 if(scenario==='restore'||scenario==='changed-evidence'){
  // These branches never call seed() or approve(). They consume only the on-disk historical state.
  const store=restoreSummaryStoreFromLocalCache(historical.payload.state,pack(scenario==='changed-evidence'));
  const state=store.snapshot();assert.deepEqual(state.approved,historical.payload.state.approved);assert(state.approved);
  const freshness=state.approvedClaims.map(c=>({claimId:c.claim.claimId,freshness:c.freshness,reasons:c.reasons}));
  assert.deepEqual(freshness.map(c=>c.freshness),scenario==='restore'?Array(6).fill('current'):['stale','stale','stale','current','current','current']);
  return {scenario,status:scenario==='restore'?'Historical approval restored':'Changed evidence marks claims stale',revision:historical.revision,approvalId:state.approved.approvalId,candidateHash:state.approved.summary.candidateHash,approvedText:state.approved.summary.claims[0].text,freshness,approvalEventsThisScenario:0,provenance};
 }
 const outcomes:Record<string,unknown>={};
 // Stale revision and deterministic pre-commit cancellation preserve exact last-good bytes.
 const safe=await cacheAt(root,'failure-safe');await safe.cache.write(historical.payload,null);const good=await readFile(join(safe.directory,filename));
 await assert.rejects(safe.cache.write(historical.payload,null),errorCode('conflict'));assert.deepEqual(await readFile(join(safe.directory,filename)),good);
 outcomes.staleRevision={rejected:true,lastGoodPreserved:true,cleanupVerified:await noDebris(safe.directory)};
 const abort=new AbortController();abort.abort();await assert.rejects(safe.cache.write(historical.payload,1,abort.signal),errorCode('cancelled'));assert.deepEqual(await readFile(join(safe.directory,filename)),good);
 outcomes.cancelledWrite={rejected:true,lastGoodPreserved:true,cleanupVerified:await noDebris(safe.directory),observedPhase:'already aborted before write starts',midWriteAndPostRenameRace:'not exercised; cancellation after commit cannot promise rollback'};
 const unsupported=JSON.parse(good.toString());unsupported.schemaVersion=999;
 for(const [name,bytes] of [['corrupt',Buffer.from('{broken')],['unsupported-version',Buffer.from(JSON.stringify(unsupported))],['oversize',Buffer.alloc(MAX_SUMMARY_CACHE_BYTES+1,32)]] as const){
  const fault=await cacheAt(root,`failure-${name}`);const file=join(fault.directory,filename);await writeFile(file,bytes,{mode:0o600});
  await assert.rejects(fault.cache.read(),errorCode('invalid'));await assert.rejects(fault.cache.write(historical.payload,null),errorCode('invalid'));assert.deepEqual(await readFile(file),bytes);
  outcomes[name]={readRejected:true,writeRejected:true,notEmptySuccess:true,evidencePreserved:true,cleanupVerified:await noDebris(fault.directory)};
 }
 const links=await cacheAt(root,'failure-symlink');const target=join(root,'synthetic-sentinel.txt');await writeFile(target,'synthetic sentinel',{mode:0o600});await symlink(target,join(links.directory,filename));
 await assert.rejects(links.cache.read(),errorCode('unsafe-path'));await assert.rejects(links.cache.write(historical.payload,null),errorCode('unsafe-path'));assert.equal(await readFile(target,'utf8'),'synthetic sentinel');assert((await lstat(join(links.directory,filename))).isSymbolicLink());
 outcomes.symlink={readRejected:true,writeRejected:true,targetUnchanged:true,linkPreserved:true,cleanupVerified:await noDebris(links.directory)};
 assert.deepEqual(await cache.read(),historical);
 return {scenario,status:'Failure boundaries verified',outcomes,historicalCacheUnchanged:true,provenance,cleanupScope:'Owned fixture directories only; no hostile path-swap or cleanup-indeterminate fault injected'};
}
