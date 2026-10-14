import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLiveRuntime} from '../../src/main/live-runtime';
import type {LoadedLiveConfiguration} from '../../src/main/live-config-types';
import type {OrcaObservation} from '../../src/collector/orca';
import {buildProjectModelPack} from '../../src/main/project-model';
import {interpretTasks} from '../../src/phase2/tasks';
import {createTaskVerificationReader} from '../../src/phase2/verification-records';
import {readingInputHash,SECTION_IDS,validateModelAnswer,PROJECT_MODEL_VERSION} from '../../src/summary/reading/model-harness';

// Actual pinned Python query + production note mapping/runtime/source resolver.
// Only Orca observation and cache are synthetic; no model, network or user data.
const pythonPath=process.env.DAG_QUERY_PYTHON,queryScriptPath=process.env.DAG_QUERY_SCRIPT;
const roots:string[]=[],runtimes:ReturnType<typeof createLiveRuntime>[]=[],readers:ReturnType<typeof createTaskVerificationReader>[]=[];
afterEach(async()=>{for(const reader of readers.splice(0))await reader.dispose();for(const runtime of runtimes.splice(0))runtime.dispose();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
function observation(tree:string):OrcaObservation{
 const coverage={state:'complete' as const,returnedCount:1,totalCount:1,truncated:false,hostIds:['synthetic-host'],omittedHostIds:[]};
 const worktree={id:'tree',identity:{hostId:'synthetic-host',instanceId:'one',sourceKey:null},repoId:'repo',projectId:'project',path:tree,branch:'test',displayName:'Synthetic bounded task',isArchived:false,isMainWorktree:false};
 const project={id:'project',displayName:'Synthetic bounded task',sourceRepoIds:['repo']};
 return {runtimeId:'synthetic-runtime',observedAt:new Date().toISOString(),status:{appRunning:true,runtimeReachable:true,runtimeState:'ready',connectionState:'connected',graphState:'ready'},projects:{records:[project],coverage},worktrees:{records:[worktree],coverage},processes:{records:[],coverage:{...coverage,returnedCount:0,totalCount:0}},joined:[{key:'synthetic',worktree,project,projectMapping:'matched',process:null,processMapping:'not-observed'}],unmatchedProcesses:[],complete:true};
}
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'summary-full-chain-')));roots.push(root);
 const note=path.join(root,'vault','project'),tree=path.join(root,'tree');await fs.mkdir(path.join(note,'inbox','T-1'),{recursive:true});await fs.mkdir(path.join(tree,'docs'),{recursive:true});await fs.symlink(note,path.join(tree,'docs','note'));
 const excerpts=Array.from({length:5},(_,i)=>({id:'document-'+i,kind:'document' as const,relativePath:'doc'+i+'.md',startLine:1,endLine:1}));
 for(let i=0;i<5;i++)await fs.writeFile(path.join(note,'doc'+i+'.md'),i===4?'배포 승인 대기: 생략된 차단 기록':'합성 근거 '+i);
 await fs.writeFile(path.join(note,'inbox/T-1/implementation.md'),'# T-1 구현\n## Verification\n합성 테스트 통과라는 작성자 주장\n');
 await fs.writeFile(path.join(note,'inbox/T-1/review-1.md'),'# T-1 리뷰\n독립성과 대상 SHA가 확인되지 않은 작성자 리뷰\n');
 const document={phases:[{id:'P-1',tasks:[{id:'T-1',title:'근거 기반 작업',status:'blocked',description:'왜: 승인 누락을 사용자에게 알립니다. '+excerpts.map(e=>'[문서]('+e.relativePath+')').join(' '),depends_on:['T-2'],acceptance_criteria:['승인 근거 확인']},{id:'T-2',title:'선행 작업',status:'done'},{id:'R-1',title:'선택 밖',status:'pending',description:'OUTSIDE_BODY_MUST_NOT_ENTER'}]}],project_policy:[] as unknown[]};
 const write=()=>fs.writeFile(path.join(note,'dag.yaml'),JSON.stringify(document));await write();
 const scope={scopeId:'scope',hostId:'synthetic-host',scopePath:note,vaultRootPath:path.join(root,'vault'),dagRelativePaths:['dag.yaml']};
 const configuration:LoadedLiveConfiguration={configuration:{schemaVersion:1,orcaExecutablePath:'/synthetic/orca',localHostId:'synthetic-host',noteScopes:[scope],summarySelections:[{scopeId:'scope',dagRelativePath:'dag.yaml',taskIds:['T-1'],excerpts}],dagQuery:{pythonPath:pythonPath!,queryScriptPath:queryScriptPath!}},view:{state:'ready',message:'Synthetic full-chain regression',orcaExecutable:'/synthetic/orca',codeburnExecutable:null,noteScopeCount:1,dagQueryConfigured:true,summaryTransport:'blocked'}};
 const runtime=createLiveRuntime({configuration,cacheRoot:path.join(root,'unused-cache'),readRoots:{filterScopes:async scopes=>[...scopes],scopesFor:async()=>[scope]},dependencies:{orca:()=>({collect:async()=>({ok:true,value:observation(tree)}),read:vi.fn()}),summaryCache:()=>({read:async()=>null})}});runtimes.push(runtime);
 const state=await runtime.connect();expect(state.freshness).toBe('current');expect(state.dags[0].state).toBe('ready');const id=state.workstreams[0].id;
 const setPolicy=async(discussion:boolean|undefined)=>{document.project_policy=[{key:'note_app_status_mapping',legacy:false,decision:{schemaVersion:1,id:'test-policy',revision:'r1',scope:{projectId:id},mappingVersion:'v1',statuses:{blocked:{lifecycle:'before',...(discussion===undefined?{}:{discussion})}}}}];await write();return runtime.refresh();};
 const source=()=>runtime.resolveSelectedProjectModelSource(id,new AbortController().signal,false,{purpose:'custom',taskIds:['T-1']});
 const pack=async()=>buildProjectModelPack(await source());
 const selection=()=>({workstreamId:id,taskId:'T-1',sourceHash:runtime.getState().dags[0].sourceHash!});
 const verifier=createTaskVerificationReader({prepareTaskEvidence:r=>runtime.prepareTaskEvidence(r),readTaskEvidence:r=>runtime.readTaskEvidence(r),releaseTaskEvidence:async r=>runtime.releaseTaskEvidence(r)});readers.push(verifier);
 return {root,note,runtime,id,document,write,setPolicy,source,pack,selection,verifier};
}
const manifest=(pack:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['pack']>>)=>JSON.parse(pack.sources.find(s=>s.path==='documents/registered-excerpts.json')!.excerpt);
describe.skipIf(!pythonPath||!queryScriptPath)('bounded summary and usefulness full-chain with pinned synthetic DAG',()=>{
 it('preserves true, false and unknown across real query, live refresh, exact selection and model-pack cache identity',async()=>{
  const f=await fixture(),hashes:string[]=[];
  for(const value of [true,false,undefined]){
   const state=await f.setPolicy(value),source=await f.source(),pack=buildProjectModelPack(source),dag=state.dags[0];
   const row=interpretTasks(dag.tasks,{projectId:f.id,dagId:dag.dagId,sourceHash:dag.sourceHash??null,observedAt:dag.observedAt??null,policies:dag.policies})[0];
   expect(row.discussionRequirement).toBe(value??null);expect(row.discussion).toBe(value===true);
   expect(JSON.parse(pack.sources.find(s=>s.path==='dag/selected-policy.json')!.excerpt).tasks[0].discussion).toBe(value??null);
   expect(source.readingSummary.sections.find(s=>s.id==='decisions')!.paragraphs.map(p=>p.text).join(' ')).toContain(value===undefined?'미확인':value?'논의 필요':'논의 불필요');
   hashes.push(readingInputHash(pack));expect(readingInputHash(await f.pack())).toBe(hashes.at(-1));
  }
  expect(new Set(hashes).size).toBe(3);
 });
 it('carries fifth-excerpt omission through the real source chain and invalidates only changed content',async()=>{
  const f=await fixture(),before=await f.pack(),m=manifest(before);expect(m.selected).toHaveLength(4);expect(m.omitted).toHaveLength(1);
  expect(JSON.stringify(before)).not.toContain('생략된 차단 기록');expect(JSON.stringify(before)).not.toContain(f.root);expect(JSON.stringify(before)).not.toContain('OUTSIDE_BODY_MUST_NOT_ENTER');
  await f.runtime.refresh();expect(readingInputHash(await f.pack())).toBe(readingInputHash(before));
  await fs.writeFile(path.join(f.note,'doc4.md'),'승인 완료: 생략된 차단 기록 변경');const after=await f.pack();expect(readingInputHash(after)).not.toBe(readingInputHash(before));expect(manifest(after).omitted[0].sourceHash).not.toBe(m.omitted[0].sourceHash);
  expect(after.sources.length).toBeLessThanOrEqual(12);expect(after.facts.length).toBeLessThanOrEqual(24);expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThanOrEqual(48000);
  const binding={runId:'synthetic',project:after.project,inputHash:readingInputHash(after),version:PROJECT_MODEL_VERSION,attempt:1 as const};
  const answer={...binding,sections:SECTION_IDS.map(id=>({id,text:after.facts.filter(f=>f.section===id).map(f=>f.text).join(' '),facts:after.facts.filter(f=>f.section===id).map(f=>({id:f.id,state:f.state})),sourceIds:[...new Set(after.facts.filter(f=>f.section===id).flatMap(f=>f.sourceIds))]}))};
  expect(validateModelAnswer(answer,binding,after)).toEqual([]);answer.sections.find(s=>s.id==='evidence')!.text=answer.sections.find(s=>s.id==='evidence')!.text.replace('차단·논의·완료 여부는 판단하지 않습니다','모두 검증됐습니다');expect(validateModelAnswer(answer,binding,after).length).toBeGreaterThan(0);
 });
 it('answers status, declared why, blocker and next action without promoting source claims to execution proof',async()=>{
  const f=await fixture();await f.setPolicy(true);const source=await f.source(),task=source.dag.tasks[0];
  expect(task.status).toBe('blocked');expect(task.details?.description).toContain('왜: 승인 누락');
  const decisions=source.readingSummary.sections.find(s=>s.id==='decisions')!.paragraphs;expect(decisions.some(p=>p.text.includes('차단 상태')&&p.basis==='declaration')).toBe(true);
  expect(source.dependencyObservations).toContainEqual({id:'T-2',scope:'internal',status:'done'});
  expect(source.readingSummary.sections.find(s=>s.id==='next')!.paragraphs.some(p=>p.text.includes('확인')||p.text.includes('선택 밖'))).toBe(true);
  const verification=await f.verifier.load(f.selection());expect(verification.state).toBe('present');expect(verification.records.map(r=>r.kind)).toEqual(['verification','review']);
  for(const record of verification.records){expect(record).toMatchObject({assessment:'not-assessed',reviewerIdentity:'unconfirmed',targetSha:'unconfirmed',independence:'unconfirmed'});const opened=await f.runtime.readTaskEvidence({sessionId:record.sessionId,evidenceId:record.evidenceId,expectedSourceHash:record.sourceHash});expect(opened.result).toMatchObject({ok:true,sourceHash:record.sourceHash});}
  expect(source.dag.tasks[0].commitVerification).toBe('not-performed');
 });
 it('makes missing records different from revoked or stale evidence and blocks stale source navigation',async()=>{
  const f=await fixture();const first=await f.verifier.load(f.selection());expect(first.state).toBe('present');const record=first.records[0],oldSelection=f.selection();
  f.document.phases[0].tasks[0].status='done';await f.write();await f.runtime.refresh();
  await expect(f.runtime.readTaskEvidence({sessionId:record.sessionId,evidenceId:record.evidenceId,expectedSourceHash:record.sourceHash})).rejects.toThrow();
  expect((await f.verifier.load(oldSelection)).state).toBe('unknown');
  await fs.rm(path.join(f.note,'inbox/T-1'),{recursive:true});expect((await f.verifier.load(f.selection())).state).toBe('none');
  await f.runtime.disconnect();expect((await f.verifier.load(f.selection())).state).toBe('unknown');
 });
 it('blocks sensitive omitted excerpts at the complete production boundary',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.note,'doc4.md'),'person@example.test');await expect(f.pack()).rejects.toThrow('Sensitive input blocked');
 });
});
