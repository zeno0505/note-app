/** Synthetic host-owned cache seed. This does not claim a real user approval or model call. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,realpath,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createDagReader} from '../../../src/facts/dag-read-model';
import {ASPECTS,bindSummaryContext,createSummaryStore} from '../../../src/summary/claims';
import {buildContextPack} from '../../../src/summary/context';
import {contextScopeId} from '../../../src/summary/context/extract';
import {extractProjectionContext} from '../../../src/summary/context/projection';
import {createLocalSummaryCache} from '../../../src/summary/storage';
import {summaryCacheCodec} from '../../../src/summary/storage/payload';
export async function seedHistoricalSummary(options:{fixtureRoot:string;verifiedUserData:string;dagPath:string;pythonPath:string;queryScriptPath:string}){
  const root=await realpath(options.fixtureRoot),userData=await realpath(options.verifiedUserData);
  const relative=path.relative(root,userData);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Refusing cache seed outside verified synthetic profile');
  const dagPath=await realpath(options.dagPath);
  const dagId=`dag:${createHash('sha256').update(JSON.stringify(['note-dag-v1','local',dagPath])).digest('hex')}`;
  const result=await createDagReader({pythonPath:options.pythonPath,queryScriptPath:options.queryScriptPath,registrations:[{dagId,canonicalDagPath:dagPath}]}).read(dagId);
  assert(result.ok,JSON.stringify(result));
  const projected=extractProjectionContext({schemaVersion:1,dagId,dag:result.value,requestedTaskIds:['T-0'],excerpts:[],previousSources:[],priorApprovedSummary:null,limits:{maxBytes:32768,maxApproxTokens:32768,maxRecords:64}});
  const pack=buildContextPack(projected.input),store=createSummaryStore(pack),record=pack.records[0];
  assert(record);const generatedAt=new Date().toISOString();
  const accepted=store.acceptResponse(store.beginUpdate()!,{schemaVersion:1,...bindSummaryContext(pack),generatedAt,claims:ASPECTS.map(aspect=>({claimId:aspect,aspect,kind:'inference',text:`Synthetic historical ${aspect}: review the declared task status`,intent:aspect==='next'?'proposal':'informational',citations:[{sourceId:record.sourceId,sourceHash:record.sourceHash,observedAt:record.observedAt,quote:record.text}],assertions:[{type:'declared-status',sourceId:record.sourceId,status:record.declaredStatus}]}))});
  assert(accepted,'Synthetic candidate rejected');const snapshot=store.snapshot();
  assert(store.approve({kind:'user-summary-approval',incarnation:snapshot.incarnation,scopeId:pack.scopeId,candidateHash:snapshot.candidate!.candidateHash,expectedVersion:snapshot.version,approvalId:'synthetic-history-only-no-real-user-action',approvedAt:generatedAt}));
  const directory=path.join(userData,'summary-cache',contextScopeId(dagId));await mkdir(directory,{recursive:true,mode:0o700});
  const cache=createLocalSummaryCache({directory,codec:summaryCacheCodec});const written=await cache.write({state:store.exportState(),projectionContexts:[projected]},null);assert.equal(written.revision,1);
  const filename=path.join(directory,'summary-cache-v1.json'),bytes=await readFile(filename);
  return {dagId,filename,hash:createHash('sha256').update(bytes).digest('hex'),candidateCount:6,approvedCount:6,actualModelCalls:0,actualUserApprovals:0};
}
