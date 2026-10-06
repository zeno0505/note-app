import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {createProjectRegistry} from '../../src/main/projects/registry';
import { createLiveRuntime, type LiveRuntimeDependencies } from '../../src/main/live-runtime';
import type { LoadedLiveConfiguration } from '../../src/main/live-config-types';
import type { OrcaAdapter, OrcaObservation, OrcaResult } from '../../src/collector/orca';
import type { NoteMappingRequest, NoteMappingResult } from '../../src/collector/notes';
import type { DagReadModel, DagReadResult, DagTask } from '../../src/facts/dag-read-model';
import { projectCodeBurn, type CodeBurnQuery, type CodeBurnResult } from '../../src/summary/budget/codeburn';
import { ASPECTS, bindSummaryContext, createSummaryStore } from '../../src/summary/claims';
import { buildContextPack } from '../../src/summary/context';
import { contextScopeId } from '../../src/summary/context/extract';
import { extractProjectionContext } from '../../src/summary/context/projection';
import { summaryCacheCodec, type SummaryCachePayload } from '../../src/summary/storage/payload';
import type { SummaryCacheRecord } from '../../src/summary/storage';

const EPOCH = Date.parse('2026-10-03T05:00:00.000Z');
const DAG = 'dag:synthetic-private-canonical';
const cacheRoot = '/synthetic/main-owned/cache';
const task = (id: string): DagTask => ({id, title: `Synthetic ${id}`, status:'running', dependencies:[],
  e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitVerification:'not-performed'});
function dag(count = 3): DagReadModel {
  return {dagId:DAG, sourceHash:'a'.repeat(64), sourceMtimeMs:1, observedAt:new Date().toISOString(),doneStatus:'done',
    tasks:Array.from({length:count},(_,i)=>task(`T-${i}`)),statusCounts:[{status:'running',count}],
    coverage:{tasksTotal:count,declared:0,required:0,uncoveredDone:[],uncoveredOpen:[],malformed:[]},verifiedFacts:[]};
}
function configuration(): LoadedLiveConfiguration {
  return {configuration:{schemaVersion:1,orcaExecutablePath:'/synthetic/bin/orca',codeburnExecutablePath:'/synthetic/bin/codeburn',localHostId:'local-host',
    noteScopes:[{scopeId:'scope-one',hostId:'local-host',vaultRootPath:'/synthetic/vault',scopePath:'/synthetic/vault/project',dagRelativePaths:['dag.yaml']}],
    dagQuery:{pythonPath:'/synthetic/bin/python',queryScriptPath:'/synthetic/private/query.py'},
    summarySelections:[{scopeId:'scope-one',dagRelativePath:'dag.yaml',taskIds:['T-0']}]},
    view:{state:'ready',message:'Synthetic local configuration.',orcaExecutable:'/synthetic/bin/orca',codeburnExecutable:'/synthetic/bin/codeburn',noteScopeCount:1,dagQueryConfigured:true,summaryTransport:'blocked'}};
}
function observation(count = 2): OrcaObservation {
  const coverage = {state:'complete' as const,returnedCount:count,totalCount:count,truncated:false,hostIds:['local-host'],omittedHostIds:[]};
  const joined = Array.from({length:count},(_,i)=>({key:`raw-runtime-key-${i}`,worktree:{id:`worktree-${i}`,identity:{hostId:'local-host',instanceId:`instance-${i}`,sourceKey:'PRIVATE_SOURCE_KEY'},
    repoId:'repo',projectId:'project',path:`/synthetic/worktree/${i}`,branch:i===0?null:'topic',displayName:`Tree ${i}`,isArchived:false,isMainWorktree:false},
    project:{id:'project',displayName:'Synthetic project',sourceRepoIds:['repo']},projectMapping:'matched' as const,
    process:{worktreeId:`worktree-${i}`,identity:{hostId:'local-host',instanceId:`instance-${i}`,sourceKey:null},repoId:'repo',isArchived:false,
      isActive:true,activityStatus:'active' as const,liveTerminalCount:0,hasAttachedPty:false,lastOutputAt:1,agents:[{paneKey:'PRIVATE_PANE',state:'done' as const,interrupted:false,stateStartedAt:1,updatedAt:1}]},processMapping:'matched' as const}));
  return {runtimeId:'PRIVATE_RUNTIME_INCARNATION',observedAt:new Date().toISOString(),status:{appRunning:true,runtimeReachable:true,runtimeState:'ready',connectionState:'connected',graphState:'ready'},
    projects:{records:[{id:'project',displayName:'Synthetic project',sourceRepoIds:['repo']}],coverage:{...coverage,state:'unknown'}},
    worktrees:{records:joined.map(x=>x.worktree),coverage},processes:{records:joined.map(x=>x.process),coverage},joined,unmatchedProcesses:[],complete:false};
}
function mapping(request: NoteMappingRequest): NoteMappingResult {
  return {status:'complete',mappings:request.worktrees.map(w=>({state:'resolved',worktreeId:w.worktreeId,hostId:w.hostId,scopeId:'scope-one',
    canonicalWorktreePath:w.worktreePath,canonicalNotePath:'/synthetic/vault/project',canonicalDagPath:'/synthetic/vault/project/dag.yaml',dagId:DAG})),
    dags:request.worktrees.length?[{dagId:DAG,hostId:'local-host',canonicalDagPath:'/synthetic/vault/project/dag.yaml',worktreeIds:request.worktrees.map(w=>w.worktreeId)}]:[],scopeIssues:[],filesystemOperations:0};
}
function budget(query: CodeBurnQuery): CodeBurnResult {
  return projectCodeBurn(query,query==='quota'?{providers:[{id:'claude',available:false,windows:[],error:'PRIVATE_ERROR'}, {id:'codex',available:true,windows:[{label:'current',usedPct:15,resetsAt:null}]}]}
    :{currency:'USD',today:{cost:2,savings:1,calls:3},month:{cost:4,savings:2,calls:5}},Date.now());
}
function persisted(model = dag()): SummaryCacheRecord<SummaryCachePayload> {
  const projection = extractProjectionContext({schemaVersion:1,dagId:DAG,dag:model,requestedTaskIds:['T-0'],excerpts:[],previousSources:[],priorApprovedSummary:null,
    limits:{maxBytes:32768,maxApproxTokens:32768,maxRecords:64}});
  const pack = buildContextPack(projection.input), store = createSummaryStore(pack), source = pack.records[0];
  const response = {schemaVersion:1,...bindSummaryContext(pack),generatedAt:model.observedAt,claims:ASPECTS.map(aspect=>({claimId:aspect,aspect,
    kind:aspect==='next'?'inference':'fact',intent:aspect==='next'?'proposal':'informational',text:source.text,citations:[{sourceId:source.sourceId,sourceHash:source.sourceHash,observedAt:source.observedAt,quote:source.text}],assertions:[]}))};
  expect(store.acceptResponse(store.beginUpdate()!,response)).toBe(true);
  const snapshot = store.snapshot();
  expect(store.approve({kind:'user-summary-approval',incarnation:snapshot.incarnation,scopeId:pack.scopeId,candidateHash:snapshot.candidate!.candidateHash,expectedVersion:snapshot.version,approvalId:'synthetic-user-event',approvedAt:model.observedAt})).toBe(true);
  return {revision:7,payload:summaryCacheCodec.parse({state:store.exportState(),projectionContexts:[projection]})};
}
const runtimes: ReturnType<typeof createLiveRuntime>[] = [];
function setup(config = configuration(), cacheAvailable = true, extraDependencies: Partial<LiveRuntimeDependencies> = {},projectRegistry?:ReturnType<typeof createProjectRegistry>,readRoots?:Parameters<typeof createLiveRuntime>[0]['readRoots']) {
  const collect = vi.fn<OrcaAdapter['collect']>(async()=>({ok:true,value:observation()}));
  const mapNotes = vi.fn<LiveRuntimeDependencies['mapNotes']>(async request=>mapping(request));
  const readDag = vi.fn<ReturnType<LiveRuntimeDependencies['dagReader']>['read']>(async()=>({ok:true,value:dag(),unchanged:false}));
  const dagReader = vi.fn<LiveRuntimeDependencies['dagReader']>(()=>({read:readDag}));
  const codeRead = vi.fn<ReturnType<LiveRuntimeDependencies['codeburn']>['read']>(async query=>budget(query));
  const cacheRead = vi.fn<(signal?:AbortSignal)=>Promise<SummaryCacheRecord<SummaryCachePayload>|null>>(async()=>null);
  const summaryCache = vi.fn<LiveRuntimeDependencies['summaryCache']>(()=>({read:cacheRead}));
  const orca = vi.fn<LiveRuntimeDependencies['orca']>(()=>({collect,read:vi.fn()}));
  const codeburn = vi.fn<LiveRuntimeDependencies['codeburn']>(()=>({read:codeRead}));
  const runtime = createLiveRuntime({configuration:config,cacheRoot,cacheAvailable,projectRegistry,readRoots,dependencies:{orca,mapNotes,dagReader,codeburn,summaryCache,...extraDependencies}});
  runtimes.push(runtime);
  return {runtime,collect,mapNotes,readDag,dagReader,codeRead,cacheRead,summaryCache,orca,codeburn};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(EPOCH);});
afterEach(()=>{for(const runtime of runtimes.splice(0))runtime.dispose();vi.useRealTimers();});

describe('connected-project rule reading integration',()=>{
  it('reads only explicitly confirmed ambiguous candidates and rejects disconnected, foreign and retargeted choices',async()=>{
    const registry=createProjectRegistry();let retargeted=false;
    const mapNotes=vi.fn(async(request:NoteMappingRequest):Promise<NoteMappingResult>=>{
      expect(request.requireNoteSymlink).toBe(true);
      const result=mapping({...request,worktrees:request.worktrees.filter(w=>w.selectedScopeId)});
      if(retargeted)for(const m of result.mappings)if(m.state==='resolved')m.canonicalDagPath='/synthetic/vault/project/changed.yaml';
      return {...result,status:'partial',mappings:request.worktrees.map(w=>result.mappings.find(m=>m.worktreeId===w.worktreeId)??{state:'unresolved',worktreeId:w.worktreeId,hostId:w.hostId,reason:'ambiguous-dag',stage:'dag'})};
    });
    const f=setup(configuration(),true,{mapNotes},registry);const first=await f.runtime.connect();expect(f.readDag).not.toHaveBeenCalled();
    const view=first.workstreams[0],candidateId=view.connectionOptions![0].id;
    await expect(f.runtime.confirmProjectConnection({workstreamId:'foreign',candidateId})).rejects.toThrow();
    retargeted=true;await expect(f.runtime.confirmProjectConnection({workstreamId:view.id,candidateId})).rejects.toThrow();expect(registry.connections()).toEqual([]);expect(f.readDag).not.toHaveBeenCalled();
    retargeted=false;const confirmed=await f.runtime.confirmProjectConnection({workstreamId:view.id,candidateId});expect(confirmed.workstreams.some(w=>w.project?.status==='active')).toBe(true);expect(f.readDag).toHaveBeenCalledTimes(1);expect(registry.connections()).toHaveLength(1);
    await f.runtime.disconnect();const reads=mapNotes.mock.calls.length;await expect(f.runtime.confirmProjectConnection({workstreamId:view.id,candidateId})).rejects.toThrow();expect(mapNotes.mock.calls).toHaveLength(reads);
  });
  it('production-wires the explicitly registered canonical DAG and branch only, with manual intent',async()=>{
    const config=configuration();config.configuration!.publicGitHub=[{scopeId:'scope-one',dagRelativePath:'dag.yaml',worktreePath:'/synthetic/worktree/0',branch:'feat/phase1-foundation'}];
    const read=vi.fn<LiveRuntimeDependencies['pullObservations']['read']>(async(selection)=>({...selection,repository:'zeno0505/note-app',observedAt:new Date().toISOString(),coverage:'complete',pulls:[],
      branch:{name:'feat/phase1-foundation',headSha:'a'.repeat(40),ci:[{id:1,sha:'a'.repeat(40),state:'success',event:'push'}],ciFreshness:'current',ciObservedAt:new Date().toISOString()}}));
    const factory=vi.fn<LiveRuntimeDependencies['publicGitHubObserver']>(()=>({read}));const f=setup(config,true,{publicGitHubObserver:factory});
    f.mapNotes.mockImplementation(async request=>{const result=mapping(request);for(const m of result.mappings)if(m.state==='resolved'&&request.worktrees.find(w=>w.worktreeId===m.worktreeId)?.registeredScopeId)m.registration='explicit-read-only';return result;});
    const first=await f.runtime.connect();expect(factory).toHaveBeenCalledTimes(1);expect(factory.mock.calls[0][0].registrations).toEqual([{dagId:DAG,branch:'feat/phase1-foundation'}]);
    expect(first.workstreams[0].noteMapping.registration).toBe('explicit-read-only');expect(first.workstreams[1].noteMapping.registration).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);expect(read.mock.calls[0][0].workstreamId).toBe(first.workstreams[0].id);
    await f.runtime.summarizeNow();expect(read.mock.calls.at(-1)![2]).toBe('manual');
    expect(first.workstreams[0].readingSummary?.sections.find(s=>s.id==='evidence')?.paragraphs.some(p=>p.text.includes('직접 푸시'))).toBe(true);
  });
  it('uses background collection cadence and does not regenerate unchanged content',async()=>{
    const f=setup();const first=await f.runtime.connect();const reading=first.workstreams[0].readingSummary!;
    expect(reading.sections).toHaveLength(4);expect(reading.kind).toBe('rules-only');
    f.runtime.setActivity({active:false,visible:false});
    await vi.advanceTimersByTimeAsync(299_999);expect(f.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);const next=f.runtime.getState().workstreams[0].readingSummary!;
    expect(f.collect).toHaveBeenCalledTimes(2);expect(next).toMatchObject({revision:reading.revision,generatedAt:reading.generatedAt,changed:false});
    expect(next.checkedAt).not.toBe(reading.checkedAt);
  });
  it('makes now-summary distinct from refresh but joins an existing collection and preserves saved claims',async()=>{
    const f=setup();f.cacheRead.mockResolvedValue(persisted());const first=await f.runtime.connect();
    let finish!:(result:OrcaResult<OrcaObservation>)=>void;
    f.collect.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const refresh=f.runtime.refresh();const summary=f.runtime.summarizeNow();
    expect(f.collect).toHaveBeenCalledTimes(2);finish({ok:true,value:observation()});await Promise.all([refresh,summary]);
    const next=f.runtime.getState();expect(next.workstreams[0].readingSummary?.revision).toBe(first.workstreams[0].readingSummary?.revision);
    expect(next.dags[0].summary.approvedClaims).toEqual(first.dags[0].summary.approvedClaims);expect(f.collect).toHaveBeenCalledTimes(2);
  });
  it('suppresses late summary on disconnect and runs no collectors while disconnected',async()=>{
    const f=setup();const before=await f.runtime.summarizeNow();expect(before.workstreams).toEqual([]);expect(f.collect).not.toHaveBeenCalled();
    const first=await f.runtime.connect();let finish!:(result:OrcaResult<OrcaObservation>)=>void;
    f.collect.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.runtime.summarizeNow();
    await f.runtime.disconnect();finish({ok:true,value:observation(0)});await pending;
    expect(f.runtime.getState().connection).toBe('disconnected');expect(f.runtime.getState().workstreams[0].readingSummary).toEqual(first.workstreams[0].readingSummary);
    const calls=f.collect.mock.calls.length;await vi.advanceTimersByTimeAsync(600_000);await f.runtime.summarizeNow();expect(f.collect).toHaveBeenCalledTimes(calls);
  });
  it('retains old reading after collection failure without asserting current zero work',async()=>{
    const f=setup();const first=await f.runtime.connect();f.collect.mockResolvedValueOnce({ok:false,error:{kind:'timeout',query:'status',runtimeId:null,message:'Failed'}});
    const failed=await f.runtime.summarizeNow();expect(failed.freshness).toBe('stale');expect(failed.workstreams[0].readingSummary).toEqual(first.workstreams[0].readingSummary);
    expect(failed.lastError).toBeTruthy();expect(failed.workstreams).toHaveLength(first.workstreams.length);
  });
  it('never connects PR adapter for unresolved notes and never replaces model approvals with rule summaries',async()=>{
    const read=vi.fn();const f=setup(configuration(),true,{pullObservations:{read}});
    f.mapNotes.mockImplementation(async request=>({status:'complete',mappings:request.worktrees.map(w=>({state:'unresolved',worktreeId:w.worktreeId,hostId:w.hostId,reason:'note-missing',stage:'note'})),dags:[],scopeIssues:[],filesystemOperations:0}));
    const result=await f.runtime.connect();expect(read).not.toHaveBeenCalled();expect(result.workstreams[0].readingSummary?.sections[0].paragraphs[0].text).toContain('판단할 수 없습니다');
  });
});
async function flush() { for(let i=0;i<50;i++)await Promise.resolve(); }

describe('main-owned live read-only orchestration',()=>{
  it('requires fresh starts but revalidates the same background snapshot after time-only ageing',async()=>{
    const x=setup();const view=await x.runtime.connect();const id=view.workstreams[0].id,revision=x.runtime.modelSourceRevision(id);
    x.runtime.setActivity({visible:false,active:false});await vi.advanceTimersByTimeAsync(41000);
    expect(x.runtime.getState().freshness).toBe('stale');expect(x.runtime.modelSourceRevision(id)).toBe(revision);
    await expect(x.runtime.resolveSummarySource(id)).rejects.toThrow('Current source unavailable');
    x.mapNotes.mockClear();x.readDag.mockClear();const source=await x.runtime.resolveSummarySource(id,new AbortController().signal,true);
    expect(source.readingSummary).toBeDefined();expect(x.mapNotes).toHaveBeenCalledTimes(1);expect(x.readDag).toHaveBeenCalledTimes(1);
    x.mapNotes.mockImplementation(async request=>{const result=mapping(request);const m=result.mappings[0];if(m.state==='resolved')m.canonicalDagPath='/synthetic/revoked';return result;});
    await expect(x.runtime.resolveSummarySource(id,new AbortController().signal,true)).rejects.toThrow('Source mapping changed');
    await x.runtime.disconnect();expect(x.runtime.modelSourceRevision(id)).toBeNull();await expect(x.runtime.resolveSummarySource(id,new AbortController().signal,true)).rejects.toThrow();
  });
  it('does not treat a failed observation as mere time ageing when revalidating a model snapshot',async()=>{
    const x=setup();const view=await x.runtime.connect(),id=view.workstreams[0].id;
    x.collect.mockResolvedValueOnce({ok:false,error:{kind:'access_denied',query:'status',runtimeId:null,message:'Synthetic failure'}});
    await x.runtime.refresh();expect(x.runtime.modelSourceRevision(id)).toBeNull();await expect(x.runtime.resolveSummarySource(id,new AbortController().signal,true)).rejects.toThrow();
  });

  it('rereads the selected mapping and DAG for summary authorization instead of trusting the poll cache',async()=>{
    const x=setup();const view=await x.runtime.connect();x.mapNotes.mockClear();x.readDag.mockClear();
    const changed=dag();changed.tasks[0].status='done';changed.sourceHash='c'.repeat(64);x.readDag.mockResolvedValue({ok:true,value:changed,unchanged:false});
    const source=await x.runtime.resolveSummarySource(view.workstreams[0].id);
    expect(source.dag.tasks[0].status).toBe('done');expect(x.mapNotes).toHaveBeenCalledTimes(1);
    expect(x.mapNotes.mock.calls[0][0].worktrees).toHaveLength(1);expect(x.readDag).toHaveBeenCalledTimes(1);
    expect(x.dagReader).toHaveBeenCalledTimes(1);expect(JSON.stringify(x.runtime.getState())).not.toContain('worktreeSources');
  });
  it('rejects changed source mapping, disconnected state and pre-aborted authorization reads',async()=>{
    const x=setup();const view=await x.runtime.connect();x.readDag.mockClear();
    x.mapNotes.mockImplementation(async request=>{const result=mapping(request);const m=result.mappings[0];if(m.state==='resolved')m.canonicalDagPath='/synthetic/changed';return result;});
    await expect(x.runtime.resolveSummarySource(view.workstreams[0].id)).rejects.toThrow('Source mapping changed');expect(x.readDag).not.toHaveBeenCalled();
    const controller=new AbortController();controller.abort();await expect(x.runtime.resolveSummarySource(view.workstreams[0].id,controller.signal)).rejects.toThrow();
    await x.runtime.disconnect();await expect(x.runtime.resolveSummarySource(view.workstreams[0].id)).rejects.toThrow();
  });
  it('never reads a historical cache after host startup rejected its ownership/privacy boundary',async()=>{
    const x=setup(configuration(),false);const view=await x.runtime.connect();expect(view.dags[0].summary.state).toBe('error');
    expect(x.summaryCache).not.toHaveBeenCalled();expect(x.cacheRead).not.toHaveBeenCalled();
  });
  it('does not collect on construction, rejects unconfigured connect, and does not auto-connect on refresh',async()=>{
    const x=setup();expect(x.collect).not.toHaveBeenCalled();expect(x.mapNotes).not.toHaveBeenCalled();expect(x.summaryCache).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);expect(x.runtime.getState()).toMatchObject({connection:'disconnected',observedAt:null,freshness:'unknown',workstreams:[],dags:[]});
    await x.runtime.refresh();expect(x.collect).not.toHaveBeenCalled();
    const c=configuration();c.configuration=null;c.view.state='unconfigured';const y=setup(c);
    await y.runtime.connect();expect(y.orca).not.toHaveBeenCalled();expect(y.runtime.getState().connection).toBe('disconnected');
  });
  it('uses configured factories, deduplicates canonical DAGs, and preserves partial coverage and independent signals',async()=>{
    const x=setup(),view=await x.runtime.connect();
    expect(x.orca).toHaveBeenCalledWith({executablePath:'/synthetic/bin/orca'});
    expect(x.codeburn).toHaveBeenCalledWith({executablePath:'/synthetic/bin/codeburn'});
    expect(view.workstreams).toHaveLength(2);expect(view.dags).toHaveLength(1);
    expect(view.workstreams.every(w=>w.noteMapping.dagId===DAG)).toBe(true);
    expect(view.workstreams[0].noteMapping.context).toEqual({state:'verified',noteRootPath:'/synthetic/vault/project',dagPath:'/synthetic/vault/project/dag.yaml'});
    expect(view.workstreams[0]).toMatchObject({branch:null,terminalConnected:false,terminalCount:0,agentState:'done'});
    expect(view.coverage).toEqual({projects:'unknown',worktrees:'complete',processes:'complete',totalWorktrees:2});
    expect(x.readDag).toHaveBeenCalledWith(DAG,{signal:expect.any(AbortSignal)});
    expect(x.mapNotes.mock.calls[1][0].worktrees).toHaveLength(1);
    expect(x.mapNotes.mock.calls[1][0].worktrees[0].selectedDagRelativePath).toBe('dag.yaml');
    expect(x.summaryCache).toHaveBeenCalledWith({directory:path.join(cacheRoot,contextScopeId(DAG)),codec:summaryCacheCodec});
    expect(view.dags[0].summary).toMatchObject({state:'empty',candidateClaims:[],approvedClaims:[],context:{selectedTaskCount:1,recordCount:1,truncated:false}});
  });
  it('polls foreground at 20 seconds, background at five minutes and resumes after five seconds',async()=>{
    const x=setup();await x.runtime.connect();await vi.advanceTimersByTimeAsync(19_999);expect(x.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(x.collect).toHaveBeenCalledTimes(2);
    x.runtime.setActivity({visible:false,active:false});
    expect(x.runtime.getState().polling).toMatchObject({activity:'background',countdownSeconds:0,nextRefreshAt:new Date(Date.now()+300_000).toISOString()});
    await vi.advanceTimersByTimeAsync(299_999);expect(x.collect).toHaveBeenCalledTimes(2);expect(x.runtime.getState().freshness).toBe('stale');
    await vi.advanceTimersByTimeAsync(1);expect(x.collect).toHaveBeenCalledTimes(3);
    x.runtime.setActivity({visible:true,active:true});expect(x.runtime.getState().polling.countdownSeconds).toBe(5);
    await vi.advanceTimersByTimeAsync(4_999);expect(x.collect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);expect(x.collect).toHaveBeenCalledTimes(4);expect(x.runtime.getState().freshness).toBe('current');
    await x.runtime.disconnect();expect(x.runtime.getState().polling).toEqual({activity:'stopped',nextRefreshAt:null,countdownSeconds:0});
    await vi.advanceTimersByTimeAsync(600_000);expect(x.collect).toHaveBeenCalledTimes(4);
    await x.runtime.connect();expect(x.collect).toHaveBeenCalledTimes(5);expect(x.dagReader).toHaveBeenCalledTimes(1);
  });
  it('does not abort first collection on blur, and merges the return countdown with pending work',async()=>{
    const x=setup();let finish!: (value:OrcaResult<OrcaObservation>)=>void;let signal!:AbortSignal;
    x.collect.mockImplementationOnce(({signal:current}={})=>{signal=current!;return new Promise(resolve=>{finish=resolve;});});
    const connecting=x.runtime.connect();await flush();x.runtime.setActivity({visible:true,active:false});expect(signal.aborted).toBe(false);
    x.runtime.setActivity({visible:true,active:true});await vi.advanceTimersByTimeAsync(5000);expect(x.collect).toHaveBeenCalledTimes(1);
    finish({ok:true,value:observation()});await connecting;
    expect(x.runtime.getState()).toMatchObject({freshness:'current',lastError:null});
    expect(x.runtime.getState().polling.nextRefreshAt).toBe(new Date(Date.now()+20_000).toISOString());
  });
  it('explicit disconnect still cancels and ignores a late first collection',async()=>{
    const x=setup();let finish!: (value:OrcaResult<OrcaObservation>)=>void;let signal!:AbortSignal;
    x.collect.mockImplementationOnce(({signal:current}={})=>{signal=current!;return new Promise(resolve=>{finish=resolve;});});
    const connecting=x.runtime.connect();await flush();await x.runtime.disconnect();expect(signal.aborted).toBe(true);
    finish({ok:true,value:observation()});await connecting;expect(x.runtime.getState()).toMatchObject({connection:'disconnected',observedAt:null,workstreams:[]});
    await vi.advanceTimersByTimeAsync(600_000);expect(x.collect).toHaveBeenCalledTimes(1);
    await x.runtime.connect();expect(x.runtime.getState().freshness).toBe('current');expect(x.collect).toHaveBeenCalledTimes(2);
  });
  it('keeps last-good observations after Orca failure and still runs all independent CodeBurn queries',async()=>{
    const x=setup(),first=await x.runtime.connect();
    x.collect.mockResolvedValue({ok:false,error:{kind:'access_denied',query:'status',message:'PRIVATE_REMOTE_ERROR',runtimeId:null}});
    const failed=await x.runtime.refresh();expect(failed.workstreams).toEqual(first.workstreams);expect(failed.dags[0].tasks).toEqual(first.dags[0].tasks);
    expect(failed.observedAt).toBe(first.observedAt);expect(failed.freshness).toBe('stale');expect(failed.lastError).toContain('access_denied');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_REMOTE_ERROR');expect(x.codeRead.mock.calls.map(([q])=>q)).toEqual(['claude-status','codex-status','quota','claude-status','codex-status','quota']);
  });
  it('retains prior usage alongside a failed query, with unavailable quota remaining unknown agent availability',async()=>{
    const x=setup();await x.runtime.connect();x.codeRead.mockImplementation(async query=>query==='claude-status'?{ok:false,observedAt:Date.now(),error:{kind:'unavailable',query}}:budget(query));
    const view=await x.runtime.refresh();expect(view.codeburn.results).toHaveLength(4);
    expect(view.codeburn.results.slice(0,2)).toMatchObject([{ok:true,value:{provider:'claude'}},{ok:false,error:{query:'claude-status',kind:'unavailable'}}]);
    const quota=view.codeburn.results.find(r=>r.ok&&r.value.kind==='quota');
    expect(quota).toMatchObject({ok:true,value:{providers:[{provider:'claude',quotaData:'unavailable',agentAvailability:'unknown',windows:[]},{provider:'codex',quotaData:'available'}]}});
  });
  it('caps displayed tasks at 200 while preserving actual totals and selects context from the full model',async()=>{
    const c=configuration();c.configuration!.summarySelections[0].taskIds=['T-249'];const x=setup(c);x.readDag.mockResolvedValue({ok:true,value:dag(250),unchanged:false});
    const view=await x.runtime.connect();expect(view.dags[0]).toMatchObject({taskCount:250,displayedTaskCount:200});expect(view.dags[0].tasks).toHaveLength(200);
    expect(view.dags[0].summary.context).toMatchObject({selectedTaskCount:1,recordCount:1});expect(view.dags[0].summary.context!.unknowns.join(' ')).toContain('250');
  });
  it('does not recreate a failed/retired DAG reader even after disconnect, map loss, and reconnect',async()=>{
    const x=setup();await x.runtime.connect();x.readDag.mockResolvedValue({ok:false,error:{kind:'cleanup_unverified',message:'PRIVATE_READER_ERROR'}});
    const failed=await x.runtime.refresh();expect(failed.dags[0]).toMatchObject({state:'error',taskCount:3});expect(failed.dags[0].tasks).toHaveLength(3);
    x.mapNotes.mockRejectedValueOnce(new Error('PRIVATE_MAPPING_ERROR'));
    const missing=await x.runtime.refresh();expect(missing.dags[0]).toMatchObject({state:'unavailable',taskCount:3});expect(missing.workstreams[0].noteMapping.state).toBe('unresolved');
    await x.runtime.disconnect();await x.runtime.connect();expect(x.dagReader).toHaveBeenCalledTimes(1);expect(x.runtime.getState().dags[0].state).toBe('unavailable');
    expect(JSON.stringify(x.runtime.getState())).not.toContain('PRIVATE_READER_ERROR');
  });
  it('restores historical candidate and approval, recomputes changed and missing evidence, and never writes',async()=>{
    const x=setup(),record=persisted();x.cacheRead.mockResolvedValue(record);
    const first=await x.runtime.connect();expect(first.dags[0].summary).toMatchObject({state:'restored',revision:7,approvedAt:new Date(EPOCH).toISOString()});
    expect(first.dags[0].summary.candidateClaims).toHaveLength(6);expect(first.dags[0].summary.approvedClaims.every(c=>c.freshness==='current')).toBe(true);
    const changed=dag();changed.tasks[0].title='Changed task';changed.sourceHash='b'.repeat(64);x.readDag.mockResolvedValue({ok:true,value:changed,unchanged:false});
    const stale=await x.runtime.refresh();expect(stale.dags[0].summary.approvedClaims.every(c=>c.freshness==='stale')).toBe(true);
    const missing=dag(0);x.readDag.mockResolvedValue({ok:true,value:missing,unchanged:false});
    const unknown=await x.runtime.refresh();expect(unknown.dags[0].summary.approvedClaims.every(c=>c.freshness==='unknown')).toBe(true);
    expect(unknown.dags[0].summary.approvedClaims.map(c=>c.claim)).toEqual(first.dags[0].summary.approvedClaims.map(c=>c.claim));
    expect(record.revision).toBe(7);expect(x.summaryCache.mock.results.every(r=>Object.keys(r.value).join()==='read')).toBe(true);
  });
  it('does not read a cache without a verified explicit task selection or borrow a mismatched canonical registration',async()=>{
    const c=configuration();c.configuration!.summarySelections=[];const x=setup(c);expect((await x.runtime.connect()).dags[0].summary.state).toBe('unavailable');expect(x.cacheRead).not.toHaveBeenCalled();
    const y=setup();y.mapNotes.mockImplementation(async request=>{
      const result=mapping(request);if(request.worktrees[0]?.selectedDagRelativePath)for(const m of result.mappings)if(m.state==='resolved')m.dagId='other';return result;
    });
    expect((await y.runtime.connect()).dags[0].summary.state).toBe('unavailable');expect(y.cacheRead).not.toHaveBeenCalled();
  });
  it('treats absent cache as empty but corruption/access/unsafe aliases as error; retains previous claims',async()=>{
    const x=setup();x.cacheRead.mockRejectedValue(Object.assign(new Error('missing'),{code:'ENOENT'}));expect((await x.runtime.connect()).dags[0].summary.state).toBe('empty');
    x.cacheRead.mockResolvedValue(persisted());await x.runtime.refresh();x.cacheRead.mockRejectedValue(Object.assign(new Error('PRIVATE_CACHE_PATH'),{code:'unsafe-path'}));
    const failed=await x.runtime.refresh();expect(failed.dags[0].summary.state).toBe('error');expect(failed.dags[0].summary.approvedClaims).toHaveLength(6);
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_CACHE_PATH');expect(failed.dags[0].summary.approvedClaims.every(c=>c.freshness==='unknown')).toBe(true);
  });
  it('sends detached allowlisted display data, never cache manifests, raw sources, runtime identity, or agent payloads',async()=>{
    const x=setup();x.cacheRead.mockResolvedValue(persisted());const view=await x.runtime.connect();
    // User-requested local note context is the sole path display allowlist.
    expect(view.workstreams[0].noteMapping.context).toEqual({state:'verified',noteRootPath:'/synthetic/vault/project',dagPath:'/synthetic/vault/project/dag.yaml'});
    const wire=JSON.stringify({...view,workstreams:view.workstreams.map(w=>({...w,noteMapping:{...w.noteMapping,context:undefined}}))});
    for(const forbidden of ['PRIVATE_RUNTIME_INCARNATION','PRIVATE_SOURCE_KEY','PRIVATE_PANE','raw-runtime-key','canonicalDagPath','sourceMtimeMs','projectionContexts','"entries":','incarnation','/synthetic/vault','/synthetic/worktree'])expect(wire).not.toContain(forbidden);
    view.workstreams[0].title='mutated';view.dags[0].tasks[0].title='mutated';view.configuration.message='mutated';
    expect(JSON.stringify(x.runtime.getState())).not.toContain('mutated');
    const bad=vi.fn(()=>{throw new Error('consumer failure');}),good=vi.fn();x.runtime.subscribe(bad);const unsubscribe=x.runtime.subscribe(good);await x.runtime.refresh();expect(good).toHaveBeenCalled();unsubscribe();
    const calls=good.mock.calls.length;await x.runtime.refresh();expect(good).toHaveBeenCalledTimes(calls);
  });
  it('coalesces concurrent requests, aborts on disconnect, and rejects late results',async()=>{
    const x=setup();let resolve!:(v:OrcaResult<OrcaObservation>)=>void;let signal:AbortSignal|undefined;
    x.collect.mockImplementation(options=>{signal=options?.signal;return new Promise(done=>{resolve=done;});});
    const first=x.runtime.connect(),second=x.runtime.refresh();expect(x.collect).toHaveBeenCalledTimes(1);
    await x.runtime.disconnect();expect(signal!.aborted).toBe(true);resolve({ok:true,value:observation()});await Promise.all([first,second]);
    expect(x.runtime.getState()).toMatchObject({connection:'disconnected',observedAt:null,workstreams:[],dags:[]});expect(x.mapNotes).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('reports successful empty observations without turning failed reads into empty success',async()=>{
    const x=setup();x.collect.mockResolvedValue({ok:true,value:observation(0)});const view=await x.runtime.connect();
    expect(view).toMatchObject({freshness:'current',workstreams:[],dags:[],coverage:{totalWorktrees:0}});expect(x.dagReader).not.toHaveBeenCalled();
    x.collect.mockResolvedValue({ok:false,error:{kind:'unavailable',query:'status',message:'Unavailable',runtimeId:null}});
    const failed=await x.runtime.refresh();expect(failed.freshness).toBe('stale');expect(failed.lastError).toBeTruthy();
  });
  it('bounds a stalled cache response and never starts another read on the retired instance',async()=>{
    const x=setup();x.cacheRead.mockImplementation(()=>new Promise(()=>{}));
    const connecting=x.runtime.connect();await flush();expect(x.cacheRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);const first=await connecting;
    expect(first.refreshing).toBe(false);expect(first.dags[0].summary.state).toBe('error');
    await x.runtime.disconnect();const second=await x.runtime.connect();await x.runtime.refresh();
    expect(second.dags[0].summary.state).toBe('error');expect(x.cacheRead).toHaveBeenCalledTimes(1);expect(x.summaryCache).toHaveBeenCalledTimes(1);
  });
  it('retires cancelled cache IO and ignores late cache results while keeping approved history',async()=>{
    const x=setup(),record=persisted();x.cacheRead.mockResolvedValueOnce(record);await x.runtime.connect();
    let resolve!:(record:SummaryCacheRecord<SummaryCachePayload>)=>void;
    x.cacheRead.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    const refreshing=x.runtime.refresh();await flush();expect(x.cacheRead).toHaveBeenCalledTimes(2);
    await x.runtime.disconnect();await refreshing;const resumed=await x.runtime.connect();
    expect(resumed.dags[0].summary.state).toBe('error');expect(resumed.dags[0].summary.approvedClaims).toHaveLength(6);
    expect(resumed.dags[0].summary.approvedClaims.every(c=>c.freshness==='unknown')).toBe(true);
    resolve({...record,revision:99});await flush();expect(x.runtime.getState().dags[0].summary.revision).toBe(7);
    expect(x.cacheRead).toHaveBeenCalledTimes(2);expect(x.summaryCache).toHaveBeenCalledTimes(1);
  });
  it.each(['mapping','scope'] as const)('retires mapper after a %s timeout so polling cannot accumulate unsettled metadata IO',async where=>{
    const x=setup();x.mapNotes.mockImplementation(async request=>({status:'partial',mappings:request.worktrees.map(w=>({state:'unresolved',worktreeId:w.worktreeId,hostId:w.hostId,
      reason:where==='mapping'?'timeout':'no-allowed-scope',stage:'scope'})),dags:[],scopeIssues:where==='scope'?[{scopeId:'scope-one',hostId:'local-host',reason:'timeout',stage:'scope'}]:[],filesystemOperations:1}));
    await x.runtime.connect();await x.runtime.refresh();await x.runtime.disconnect();await x.runtime.connect();
    expect(x.mapNotes).toHaveBeenCalledTimes(1);expect(x.dagReader).not.toHaveBeenCalled();expect(x.cacheRead).not.toHaveBeenCalled();
    expect(x.runtime.getState().workstreams[0].noteMapping.reason).toContain('retired');
  });
  it('retires a timed-out explicit-selection mapping and does not turn it into current summary context',async()=>{
    const x=setup();x.mapNotes.mockImplementation(async request=>request.worktrees.some(w=>w.selectedDagRelativePath)
      ?{status:'partial',mappings:[],dags:[],scopeIssues:[{scopeId:'scope-one',hostId:'local-host',reason:'aborted',stage:'scope'}],filesystemOperations:1}:mapping(request));
    const first=await x.runtime.connect();expect(first.dags[0].summary.state).toBe('unavailable');expect(x.cacheRead).not.toHaveBeenCalled();
    await x.runtime.refresh();expect(x.mapNotes).toHaveBeenCalledTimes(2);expect(x.runtime.getState().dags[0].state).toBe('unavailable');
  });
  it('keeps unchanged projection claims current after unselected upstream edits and downgrades aged history',async()=>{
    const x=setup();x.cacheRead.mockResolvedValue(persisted());await x.runtime.connect();
    const next=dag();next.tasks[2].title='Unselected change';next.sourceHash='b'.repeat(64);x.readDag.mockResolvedValue({ok:true,value:next,unchanged:false});
    const fresh=await x.runtime.refresh();expect(fresh.dags[0].summary.approvedClaims.every(c=>c.freshness==='current')).toBe(true);
    x.runtime.setActivity({active:false,visible:true});await vi.advanceTimersByTimeAsync(40_000);
    expect(x.runtime.getState().dags[0].summary.approvedClaims.every(c=>c.freshness==='stale')).toBe(true);
  });

  it('preserves historical summary when a transient explicit-selection mapping fails',async()=>{
    const x=setup();x.cacheRead.mockResolvedValue(persisted());await x.runtime.connect();
    x.mapNotes.mockImplementation(async request=>request.worktrees.some(w=>w.selectedDagRelativePath)
      ?{status:'partial',mappings:[],dags:[],scopeIssues:[{scopeId:'scope-one',hostId:'local-host',reason:'scope-unavailable',stage:'scope',errorCode:'EIO'}],filesystemOperations:1}:mapping(request));
    const retained=await x.runtime.refresh();expect(retained.dags[0].summary).toMatchObject({state:'error',revision:7});
    expect(retained.dags[0].summary.approvedClaims).toHaveLength(6);expect(retained.dags[0].summary.approvedClaims.every(c=>c.freshness==='unknown')).toBe(true);
    expect(x.cacheRead).toHaveBeenCalledTimes(1);
  });
  it('bounds status and reference display lists with explicit omission counts without changing context facts',async()=>{
    const x=setup(),model=dag(20);model.statusCounts=Array.from({length:20},(_,i)=>({status:`status-${i}`,count:1}));
    model.tasks[0].dependencies=Array.from({length:20},(_,i)=>({id:`T-${i}`,scope:'internal'}));
    model.tasks[0].commitReferences=Array.from({length:20},(_,i)=>`commit-${i}`);
    model.tasks[0].e2e={state:'declared',required:true,coverage:'references-declared',coveredBy:Array.from({length:20},(_,i)=>`evidence-${i}`)};
    x.readDag.mockResolvedValue({ok:true,value:model,unchanged:false});
    const view=await x.runtime.connect(),display=view.dags[0];
    expect(display.statusCounts).toHaveLength(12);expect(display).toMatchObject({statusCountTotal:20,statusCountsOmitted:8});
    expect(display.tasks[0].dependencies).toHaveLength(8);expect(display.tasks[0].commitReferences).toHaveLength(8);expect(display.tasks[0].e2e.coveredBy).toHaveLength(8);
    expect(display.tasks[0].displayOmissions).toEqual({dependencies:12,commitReferences:12,e2eReferences:12});
    expect(display.summary.context).toMatchObject({selectedTaskCount:1,recordCount:20});expect(model.tasks[0].dependencies).toHaveLength(20);
  });

  it('bounds retained DAG views and reader lifetimes when a canonical alias keeps changing beside an unresolved worktree',async()=>{
    const c=configuration();c.configuration!.summarySelections=[];const x=setup(c);let turn=0;
    x.mapNotes.mockImplementation(async request=>{
      const result=mapping(request),id=`dag:changing-${turn++}`;
      result.status='partial';result.mappings=[{state:'resolved',worktreeId:request.worktrees[0].worktreeId,hostId:'local-host',scopeId:'scope-one',
        canonicalWorktreePath:'/synthetic/worktree',canonicalNotePath:'/synthetic/vault/project',canonicalDagPath:`/synthetic/vault/project/${id}`,dagId:id},
        {state:'unresolved',worktreeId:request.worktrees[1].worktreeId,hostId:'local-host',reason:'note-missing',stage:'note'}];
      result.dags=[{dagId:id,hostId:'local-host',canonicalDagPath:`/synthetic/vault/project/${id}`,worktreeIds:[request.worktrees[0].worktreeId]}];return result;
    });
    x.readDag.mockImplementation(async dagId=>({ok:true,value:{...dag(),dagId},unchanged:false}));
    await x.runtime.connect();for(let i=0;i<20;i++)expect((await x.runtime.refresh()).dags.length).toBeLessThanOrEqual(8);
    expect(x.dagReader).toHaveBeenCalledTimes(8);expect(x.runtime.getState().dags[0].reason).toContain('lifetime DAG registration limit');
  });

});

import { registeredExcerptId, type RegisteredExcerptContext } from '../../src/summary/context/registered';
import { createHash } from 'node:crypto';
it('production-wires trusted registered excerpt reads on polling and fresh review validation only',async()=>{
  const config=configuration();const registration={id:'goal',kind:'goal-document' as const,relativePath:'goal.md',startLine:1,endLine:1};config.configuration!.summarySelections[0].excerpts=[registration];
  const content='목표: 명시적으로 선택한 근거',sourceHash=`sha256:${createHash('sha256').update(content).digest('hex')}`;
  const id=registeredExcerptId(DAG,registration),observedAt=new Date().toISOString();
  const excerptContext:RegisteredExcerptContext={schemaVersion:1,scopeDagId:DAG,excerpts:[{scopeDagId:DAG,id,kind:'goal-document',text:content,sourceHash,observedAt}],provenance:[{excerptId:id,kind:'goal-document',sourceHash,observedAt,registration,canonicalPath:'/synthetic/vault/project/goal.md',fileHash:sourceHash,fileBytes:Buffer.byteLength(content),byteStart:0,byteEnd:Buffer.byteLength(content),lineStart:1,lineEnd:1}]};
  const read=vi.fn(async()=>structuredClone(excerptContext));const excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>(()=>({read}));
  const f=setup(config,true,{excerptReader});expect(read).not.toHaveBeenCalled();const view=await f.runtime.connect();
  expect(view.dags[0].summary.context?.recordCount).toBe(2);expect(excerptReader).toHaveBeenCalledTimes(1);
  expect(excerptReader.mock.calls[0][0]).toMatchObject({dagId:DAG,canonicalScopePath:'/synthetic/vault/project',canonicalNotePath:'/synthetic/vault/project',registrations:[registration]});
  const firstCalls=read.mock.calls.length;const source=await f.runtime.resolveSummarySource(view.workstreams[0].id);expect(read.mock.calls.length).toBe(firstCalls+1);expect(source.registeredExcerpts?.excerpts[0].text).toBe(content);
  expect(JSON.stringify(f.runtime.getState())).not.toContain('goal.md');expect(JSON.stringify(f.runtime.getState())).not.toContain(content);
  read.mockRejectedValueOnce(new Error('Synthetic excerpt unavailable'));await expect(f.runtime.resolveSummarySource(view.workstreams[0].id)).rejects.toThrow();
});

it('bounds a stalled registered excerpt read and retires its lifetime after timeout',async()=>{
  const config=configuration();config.configuration!.summarySelections[0].excerpts=[{id:'goal',kind:'goal-document',relativePath:'goal.md',startLine:1,endLine:1}];
  let finish!:(value:RegisteredExcerptContext)=>void;const pendingRead=new Promise<RegisteredExcerptContext>(resolve=>{finish=resolve;});
  const read=vi.fn((..._args:Parameters<ReturnType<LiveRuntimeDependencies['excerptReader']>['read']>)=>pendingRead),excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>(()=>({read}));const f=setup(config,true,{excerptReader});
  const connecting=f.runtime.connect();await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(1));await vi.advanceTimersByTimeAsync(5_000);const view=await connecting;
  expect(view.dags[0].summary.state).toBe('error');expect(read.mock.calls[0][1]?.aborted).toBe(true);
  finish({schemaVersion:1,scopeDagId:DAG,excerpts:[],provenance:[]});await flush();await f.runtime.refresh();
  expect(read).toHaveBeenCalledTimes(1);expect(excerptReader).toHaveBeenCalledTimes(1);expect(f.runtime.getState().dags[0].summary.state).toBe('error');
});
it('releases a pending excerpt response on disconnect and ignores late completion after reconnect',async()=>{
  const config=configuration();config.configuration!.summarySelections[0].excerpts=[{id:'goal',kind:'goal-document',relativePath:'goal.md',startLine:1,endLine:1}];
  let finish!:(value:RegisteredExcerptContext)=>void;const read=vi.fn((..._args:Parameters<ReturnType<LiveRuntimeDependencies['excerptReader']>['read']>)=>new Promise<RegisteredExcerptContext>(resolve=>{finish=resolve;}));
  const excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>(()=>({read}));const f=setup(config,true,{excerptReader});
  const connecting=f.runtime.connect();await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(1));await f.runtime.disconnect();await connecting;
  expect(read.mock.calls[0][1]?.aborted).toBe(true);finish({schemaVersion:1,scopeDagId:DAG,excerpts:[],provenance:[]});await flush();await f.runtime.connect();
  expect(read).toHaveBeenCalledTimes(1);expect(excerptReader).toHaveBeenCalledTimes(1);expect(f.runtime.getState().dags[0].summary.state).toBe('error');
});

it('does not borrow or require a sibling DAG excerpt registration for an unconfigured DAG in the same scope',async()=>{
  const config=configuration();config.configuration!.noteScopes[0].dagRelativePaths=['a/dag.yaml','b/dag.yaml'];
  config.configuration!.summarySelections=[{scopeId:'scope-one',dagRelativePath:'a/dag.yaml',taskIds:['T-0'],excerpts:[{id:'goal-a',kind:'goal-document',relativePath:'a/goal.md',startLine:1,endLine:1}]}];
  const excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>();const f=setup(config,true,{excerptReader});
  f.mapNotes.mockImplementation(async request=>{const result=mapping(request);if(request.worktrees.some(w=>w.selectedDagRelativePath==='a/dag.yaml'))return {...result,mappings:request.worktrees.map(w=>({state:'unresolved' as const,worktreeId:w.worktreeId,hostId:w.hostId,reason:'dag-outside-note' as const,stage:'dag' as const})),dags:[]};for(const m of result.mappings)if(m.state==='resolved'){m.canonicalNotePath='/synthetic/vault/project/b';m.canonicalDagPath='/synthetic/vault/project/b/dag.yaml';}for(const d of result.dags)d.canonicalDagPath='/synthetic/vault/project/b/dag.yaml';return result;});
  const view=await f.runtime.connect();const source=await f.runtime.resolveSummarySource(view.workstreams[0].id);
  expect(source.dag.dagId).toBe(DAG);expect(source.registeredExcerpts).toBeUndefined();expect(excerptReader).not.toHaveBeenCalled();
});

it('resolves exact registered DAG aliases through the mapper before selecting excerpts',async()=>{
  const config=configuration();config.configuration!.noteScopes[0].dagRelativePaths=['dag-alias.yaml'];config.configuration!.summarySelections[0].dagRelativePath='dag-alias.yaml';
  config.configuration!.summarySelections[0].excerpts=[{id:'goal',kind:'goal-document',relativePath:'goal.md',startLine:1,endLine:1}];
  const read=vi.fn(async()=>({schemaVersion:1 as const,scopeDagId:DAG,excerpts:[],provenance:[]}));const excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>(()=>({read}));const f=setup(config,true,{excerptReader});
  const view=await f.runtime.connect();expect(excerptReader).toHaveBeenCalledTimes(1);expect(read).toHaveBeenCalled();
  f.mapNotes.mockClear();const source=await f.runtime.resolveSummarySource(view.workstreams[0].id);expect(source.registeredExcerpts).toBeDefined();expect(f.mapNotes.mock.calls.some(([r])=>r.worktrees[0].selectedDagRelativePath==='dag-alias.yaml')).toBe(true);
});
it('surfaces an unsupported scope alias instead of dropping its explicitly configured excerpts',async()=>{
  const config=configuration();config.configuration!.noteScopes[0].scopePath='/synthetic/vault/project-alias';
  config.configuration!.summarySelections[0].excerpts=[{id:'goal',kind:'goal-document',relativePath:'goal.md',startLine:1,endLine:1}];
  const excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>(()=>{throw new Error('Synthetic unsupported alias');});const f=setup(config,true,{excerptReader});
  const view=await f.runtime.connect();expect(view.dags[0].summary.state).toBe('error');expect(excerptReader).toHaveBeenCalled();
  await expect(f.runtime.resolveSummarySource(view.workstreams[0].id)).rejects.toThrow('Synthetic unsupported alias');
});

function projectDocumentFixture(links?:{role:'inbox'|'discussion'|'design';wikilink:string}[]) {
 const registration={id:'project-record',kind:'document' as const,relativePath:'reviews/project.jsonl',startLine:1,endLine:1};
 const content=JSON.stringify({schemaVersion:1,id:'project-feature',section:'implemented',text:'합성 프로젝트의 등록된 읽기 기능',verification:null,references:['src/synthetic.ts'],...(links?{links}:{})});
 const sourceHash=`sha256:${createHash('sha256').update(content).digest('hex')}`,id=registeredExcerptId(DAG,registration),observedAt=new Date().toISOString();
 const context:RegisteredExcerptContext={schemaVersion:1,scopeDagId:DAG,excerpts:[{scopeDagId:DAG,id,kind:'document',text:content,sourceHash,observedAt}],provenance:[{excerptId:id,kind:'document',sourceHash,observedAt,registration,canonicalPath:'/synthetic/worktree/0/reviews/project.jsonl',fileHash:sourceHash,fileBytes:Buffer.byteLength(content),byteStart:0,byteEnd:Buffer.byteLength(content),lineStart:1,lineEnd:1}]};
 const config=configuration();config.configuration!.summarySelections=[];config.configuration!.readingDocuments=[{scopeId:'scope-one',dagRelativePath:'dag.yaml',worktreePath:'/synthetic/worktree/0',excerpts:[registration]}];return {config,registration,context};
}
it('production-wires project documents only for the exact verified worktree and keeps them separate from model context',async()=>{
 const {config,registration,context}=projectDocumentFixture();const read=vi.fn(async()=>structuredClone(context));const excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>(()=>({read}));const f=setup(config,true,{excerptReader});
 const first=await f.runtime.connect();expect(excerptReader).toHaveBeenCalledTimes(1);expect(excerptReader.mock.calls[0][0]).toMatchObject({canonicalScopePath:'/synthetic/worktree/0',canonicalNotePath:'/synthetic/worktree/0',registrations:[registration]});
 expect(first.workstreams[0].readingSummary?.sections[0].paragraphs[0].text).toContain('등록된 프로젝트 구현 기록');
 expect(first.workstreams[1].readingSummary?.sections[0].paragraphs.some(p=>p.text.includes('등록된 프로젝트 구현 기록'))).toBe(false);
 expect(first.dags[0].summary.context).toBeNull();const again=await f.runtime.refresh();expect(again.workstreams[0].readingSummary?.changed).toBe(false);
 read.mockRejectedValueOnce(new Error('Missing current document'));const missing=await f.runtime.refresh();expect(missing.workstreams[0].readingSummary?.sections[0].paragraphs.some(p=>p.text.includes('등록된 프로젝트 구현 기록'))).toBe(false);
 expect(missing.workstreams[0].readingSummary?.sections.find(s=>s.id==='evidence')?.paragraphs.some(p=>p.text.includes('근거 문서를 현재 범위에서 확인하지 못했습니다'))).toBe(true);
});
it('bounds a non-cooperative project document reader, retires it and rejects late publication',async()=>{
 const {config,context}=projectDocumentFixture();let finish!:(context:RegisteredExcerptContext)=>void;const read=vi.fn((..._args:Parameters<ReturnType<LiveRuntimeDependencies['excerptReader']>['read']>)=>new Promise<RegisteredExcerptContext>(resolve=>{finish=resolve;}));
 const excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>(()=>({read}));const f=setup(config,true,{excerptReader});const connecting=f.runtime.connect();await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(1));await vi.advanceTimersByTimeAsync(5000);const first=await connecting;
 expect(read.mock.calls[0][1]?.aborted).toBe(true);expect(first.workstreams[0].readingSummary?.sections[0].paragraphs.some(p=>p.text.includes('등록된 프로젝트 구현 기록'))).toBe(false);
 finish(context);await flush();await f.runtime.refresh();expect(read).toHaveBeenCalledTimes(1);expect(excerptReader).toHaveBeenCalledTimes(1);
});
it('does not open a document reader when the mapper resolves another canonical worktree',async()=>{
 const {config}=projectDocumentFixture();const excerptReader=vi.fn<LiveRuntimeDependencies['excerptReader']>();const f=setup(config,true,{excerptReader});
 f.mapNotes.mockImplementation(async request=>{const result=mapping(request);for(const m of result.mappings)if(m.state==='resolved')m.canonicalWorktreePath='/synthetic/other';return result;});
 await f.runtime.connect();expect(excerptReader).not.toHaveBeenCalled();
});

it('tracks one canonical project after worktrees disappear, and only the user can stop/resume periodic project reads',async()=>{
 const registry=createProjectRegistry({now:()=>Date.now()});const f=setup(configuration(),true,{},registry);
 const first=await f.runtime.connect();expect(first.workstreams).toHaveLength(1);const project=first.workstreams[0];expect(project.project?.status).toBe('active');
 await f.runtime.setProjectStatus({projectId:project.id,status:'completed',expectedStatus:'active'});const reads=f.readDag.mock.calls.length;
 await vi.advanceTimersByTimeAsync(20_000);expect(f.readDag.mock.calls.length).toBe(reads);expect(f.runtime.getState().workstreams[0].project?.status).toBe('completed');expect(f.runtime.getState().workstreams[0].observation?.worktree).toBe('observed');expect(f.runtime.getState().workstreams[0].project?.worktreeState).toBe('present');
 const manual=await f.runtime.summarizeNow();expect(f.readDag.mock.calls.length).toBeGreaterThan(reads);expect(f.runtime.getState().workstreams[0].project?.status).toBe('completed');expect(manual.workstreams[0].readingSummary?.generatedAt).toBe(first.workstreams[0].readingSummary?.generatedAt);expect(manual.workstreams[0].readingSummary?.changed).toBe(false);
 await f.runtime.setProjectStatus({projectId:project.id,status:'active',expectedStatus:'completed'});
 f.collect.mockImplementation(async()=>({ok:true,value:observation(0)}));const missing=await f.runtime.refresh();expect(missing.workstreams).toHaveLength(1);expect(missing.workstreams[0].id).toBe(project.id);expect(missing.workstreams[0].project?.status).toBe('active');expect(missing.workstreams[0].project?.worktreeState).toBe('missing');expect(missing.workstreams[0].observation?.worktree).toBe('not-observed');expect(missing.workstreams[0].archived).toBeNull();
 f.readDag.mockImplementation(async()=>({ok:false,error:{kind:'source_unavailable',message:'Synthetic source inaccessible'}}));const unavailable=await f.runtime.refresh();expect(unavailable.workstreams[0].project?.sourceState).toBe('unavailable');expect(unavailable.workstreams[0].readingSummary?.sections[0].paragraphs.some(p=>p.text.includes('판단할 수 없습니다'))).toBe(true);
});

it('keeps document-open authority in main, bound to the current project and exact explicit link',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'note-runtime-wiki-'))),vault=path.join(root,'vault'),note=path.join(vault,'project');
 try {
  await mkdir(note,{recursive:true});await writeFile(path.join(note,'2020-01-01.md'),'synthetic historical note');
  const {config,context}=projectDocumentFixture([{role:'discussion',wikilink:'[[2020-01-01|이전 논의]]'}]);config.configuration!.noteScopes[0].vaultRootPath=vault;config.configuration!.noteScopes[0].scopePath=note;
  const f=setup(config,true,{excerptReader:()=>({read:async()=>structuredClone(context)})});f.mapNotes.mockImplementation(async request=>{const result=mapping(request);for(const m of result.mappings)if(m.state==='resolved'){m.canonicalNotePath=note;m.canonicalDagPath=path.join(note,'dag.yaml');}return result;});
  const first=await f.runtime.connect(),view=first.workstreams[0],link=view.documentLinks![0];expect(link).toMatchObject({role:'discussion',label:'이전 논의'});expect(JSON.stringify(link)).not.toContain(root);
  expect(await f.runtime.resolveDocumentLink({workstreamId:view.id,linkId:link.id})).toBe('obsidian://open?vault=vault&file=project%2F2020-01-01');
  await expect(f.runtime.resolveDocumentLink({workstreamId:first.workstreams[1].id,linkId:link.id})).rejects.toThrow();await expect(f.runtime.resolveDocumentLink({workstreamId:view.id,linkId:link.id,path:note})).rejects.toThrow();
  await f.runtime.disconnect();await expect(f.runtime.resolveDocumentLink({workstreamId:view.id,linkId:link.id})).rejects.toThrow();f.runtime.dispose();
 }finally{await rm(root,{recursive:true,force:true});}
});


it('revokes new project reads while retaining historical summaries and requires fresh source connection',async()=>{
 const config=configuration(),registry=createProjectRegistry();let allowed=true;
 const readRoots={scopesFor:vi.fn(async()=>allowed?config.configuration!.noteScopes:[]),filterScopes:vi.fn(async(scopes:readonly import('../../src/collector/notes').AllowedNoteScope[])=>allowed?[...scopes]:[])};
 const mapNotes=vi.fn(async(request:NoteMappingRequest):Promise<NoteMappingResult>=>request.scopes.length?mapping(request):{status:'partial',mappings:request.worktrees.map(w=>({state:'unresolved',hostId:w.hostId,worktreeId:w.worktreeId,reason:'no-allowed-scope',stage:'scope'})),dags:[],scopeIssues:[],filesystemOperations:0});
 const f=setup(config,true,{mapNotes},registry,readRoots);const first=await f.runtime.connect(),project=first.workstreams[0];expect(project.readingSummary).toBeTruthy();const reads=f.readDag.mock.calls.length;
 allowed=false;await f.runtime.invalidateReadRoots();const stopped=f.runtime.getState();expect(stopped.connection).toBe('disconnected');expect(stopped.configuration.noteScopeCount).toBe(0);expect(stopped.workstreams[0].readingSummary).toEqual(project.readingSummary);expect(stopped.workstreams[0].project?.sourceState).toBe('not-checked');
 await f.runtime.connect();expect(f.readDag).toHaveBeenCalledTimes(reads);expect(f.runtime.getState().workstreams.some(w=>w.project&&w.readingSummary)).toBe(true);
 await expect(f.runtime.resolveSummarySource(project.id,new AbortController().signal)).rejects.toThrow();
});
