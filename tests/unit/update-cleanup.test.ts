import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createUpdateCleanupGate,UpdateCleanupError,type UpdateCleanupProof} from '../../src/main/update-cleanup';
import {createLiveRuntime,type LiveRuntimeDependencies} from '../../src/main/live-runtime';
import {createProjectRegistry} from '../../src/main/projects/registry';
import type {LoadedLiveConfiguration} from '../../src/main/live-config-types';
import type {OrcaObservation,OrcaResult} from '../../src/collector/orca';
import type {DagReadModel,DagReadResult,DagReaderRecovery} from '../../src/facts/dag-read-model';
import type {NoteMappingRequest,NoteMappingResult} from '../../src/collector/notes';

function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));});
const runtimes:ReturnType<typeof createLiveRuntime>[]=[];
afterEach(()=>{runtimes.splice(0).forEach(runtime=>runtime.dispose());vi.useRealTimers();});

describe('verified update cleanup ownership',()=>{
  it('is inert until given work and accepts a clean boundary',async()=>{
    const gate=createUpdateCleanupGate();await expect(gate.settle()).resolves.toBeUndefined();expect(vi.getTimerCount()).toBe(0);
  });
  it('retains the underlying promise after a response deadline and permits a proven retry',async()=>{
    const gate=createUpdateCleanupGate(),raw=deferred<void>();const work=gate.track('file write',()=>raw.promise);
    const first=gate.settle({timeoutMs:100}).catch(error=>error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({reason:'pending',areas:['file write']});
    raw.resolve();await work;await expect(gate.settle()).resolves.toBeUndefined();
  });
  it('retains an unverified result despite successful later work',async()=>{
    const gate=createUpdateCleanupGate();
    await gate.track('query',async()=>false,{fulfilled:value=>value});
    await gate.track('query',async()=>true,{fulfilled:value=>value});
    await expect(gate.settle()).rejects.toMatchObject({reason:'unverified',areas:['query']});
  });
  it('does not turn rejected cleanup into success via allSettled',async()=>{
    const gate=createUpdateCleanupGate();
    await Promise.allSettled([gate.track('save',async()=>{throw Error('close failed');},{rejected:()=>false})]);
    await expect(gate.settle()).rejects.toBeInstanceOf(UpdateCleanupError);
  });
  it('requires an independent receipt when the response has already settled',async()=>{
    const gate=createUpdateCleanupGate();let cleanup:UpdateCleanupProof='pending',installed=false;
    const pending=gate.settle({verify:()=>[{area:'DAG query',cleanup}]}).then(()=>{installed=true;});
    await vi.advanceTimersByTimeAsync(50);expect(installed).toBe(false);
    cleanup='verified';await vi.advanceTimersByTimeAsync(25);await pending;expect(installed).toBe(true);
  });
  it('refuses an explicitly unverified late receipt',async()=>{
    const gate=createUpdateCleanupGate();
    await expect(gate.settle({verify:()=>[{area:'DAG query',cleanup:'unverified'}]})).rejects.toMatchObject({reason:'unverified'});
  });
});

const DAG='synthetic-dag';
function configuration():LoadedLiveConfiguration{return {
  configuration:{schemaVersion:1,orcaExecutablePath:'/synthetic/orca',localHostId:'local',noteScopes:[{scopeId:'scope',hostId:'local',vaultRootPath:'/synthetic/vault',scopePath:'/synthetic/vault/note',dagRelativePaths:['dag.yaml']}],dagQuery:{pythonPath:'/synthetic/python',queryScriptPath:'/synthetic/query'},summarySelections:[]},
  view:{state:'ready',message:'Synthetic configuration',orcaExecutable:'/synthetic/orca',codeburnExecutable:null,noteScopeCount:1,dagQueryConfigured:true,summaryTransport:'blocked'},
};}
function observation():OrcaObservation{
  const coverage={state:'complete' as const,returnedCount:1,totalCount:1,truncated:false,hostIds:['local'],omittedHostIds:[]};
  const worktree={id:'tree',identity:{hostId:'local',instanceId:'instance',sourceKey:null},repoId:'repo',projectId:'project',path:'/synthetic/tree',branch:'main',displayName:'Project',isArchived:false,isMainWorktree:true};
  const project={id:'project',displayName:'Project',sourceRepoIds:['repo']};
  return {runtimeId:'runtime',observedAt:new Date().toISOString(),status:{appRunning:true,runtimeReachable:true,runtimeState:'ready',connectionState:'connected',graphState:'ready'},projects:{records:[project],coverage},worktrees:{records:[worktree],coverage},processes:{records:[],coverage:{...coverage,returnedCount:0,totalCount:0}},joined:[{key:'tree',worktree,project,projectMapping:'matched',process:null,processMapping:'not-observed'}],unmatchedProcesses:[],complete:true};
}
function mapping(request:NoteMappingRequest):NoteMappingResult{return {status:'complete',filesystemOperations:0,scopeIssues:[],mappings:request.worktrees.map(w=>({state:'resolved',worktreeId:w.worktreeId,hostId:w.hostId,scopeId:'scope',canonicalWorktreePath:w.worktreePath,canonicalNotePath:'/synthetic/vault/note',canonicalDagPath:'/synthetic/vault/note/dag.yaml',dagId:DAG})),dags:[{dagId:DAG,hostId:'local',canonicalDagPath:'/synthetic/vault/note/dag.yaml',worktreeIds:['tree']}]};}
function model():DagReadModel{return {dagId:DAG,sourceHash:'a'.repeat(64),sourceMtimeMs:1,observedAt:new Date().toISOString(),doneStatus:'done',tasks:[{id:'T-1',title:'Task',status:'running',dependencies:[],e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitVerification:'not-performed'}],statusCounts:[{status:'running',count:1}],coverage:{tasksTotal:1,declared:0,required:0,uncoveredDone:[],uncoveredOpen:[],malformed:[]},verifiedFacts:[]};}
function setup(dependencies:Partial<LiveRuntimeDependencies>={},extra:Partial<Parameters<typeof createLiveRuntime>[0]>={}){
  const collect=vi.fn(async():Promise<OrcaResult<OrcaObservation>>=>({ok:true,value:observation()}));
  const readDag=vi.fn(async():Promise<DagReadResult>=>({ok:true,value:model(),unchanged:false}));
  const runtime=createLiveRuntime({configuration:configuration(),cacheRoot:'/synthetic/cache',...extra,dependencies:{orca:()=>({read:vi.fn(),collect}),mapNotes:async request=>mapping(request),dagReader:()=>({read:readDag}),summaryCache:()=>({read:async()=>null}),...dependencies}});
  runtimes.push(runtime);return {runtime,collect,readDag};
}

describe('live runtime install boundary',()=>{
  it('does no collection when shutting down an unused runtime and refuses fresh work',async()=>{
    const {runtime,collect}=setup();await runtime.prepareUpdateShutdown();
    await expect(runtime.connect()).rejects.toBeInstanceOf(UpdateCleanupError);expect(collect).not.toHaveBeenCalled();
  });
  it('waits for a running owned collector without aborting it or permitting new work',async()=>{
    const raw=deferred<OrcaResult<OrcaObservation>>();let signal:AbortSignal|undefined;
    const {runtime}=setup({orca:()=>({read:vi.fn(),collect:request=>{signal=request?.signal;return raw.promise;}})});
    const connecting=runtime.connect();let ready=false;const shutdown=runtime.prepareUpdateShutdown().then(()=>{ready=true;});
    await vi.advanceTimersByTimeAsync(100);expect(ready).toBe(false);expect(signal?.aborted).toBe(false);
    await expect(runtime.refresh()).rejects.toBeInstanceOf(UpdateCleanupError);
    runtime.setSuspended(false);runtime.setActivity({active:true,visible:true});
    raw.resolve({ok:true,value:observation()});await connecting;await vi.advanceTimersByTimeAsync(25);await shutdown;
    expect(runtime.getState().connection).toBe('disconnected');expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps historical collector cleanup uncertainty after a later success',async()=>{
    const {runtime,collect}=setup();collect.mockResolvedValueOnce({ok:false,error:{kind:'cleanup_unverified',query:null,message:'Cleanup unverified',runtimeId:null}});
    await runtime.connect();await runtime.refresh();
    await expect(runtime.prepareUpdateShutdown()).rejects.toMatchObject({reason:'unverified',areas:['Orca query']});
  });
  it('refuses cancellation/timeout mapping replies without a kernel cleanup receipt',async()=>{
    const {runtime}=setup({mapNotes:async request=>({...mapping(request),scopeIssues:[{scopeId:'scope',hostId:'local',reason:'timeout',stage:'scope'}]})});
    await runtime.connect();await expect(runtime.prepareUpdateShutdown()).rejects.toMatchObject({reason:'unverified',areas:['note mapping']});
  });
  it('waits for independent DAG cleanup proof after a bounded timeout response',async()=>{
    let cleanup:DagReaderRecovery['cleanup']='pending';
    const {runtime}=setup({dagReader:()=>({read:async()=>({ok:false,error:{kind:'timeout',message:'Bounded response'}}),recoveryState:()=>({cause:'timeout',cleanup,retired:true,generation:0})})});
    await runtime.connect();let ready=false;const shutdown=runtime.prepareUpdateShutdown().then(()=>{ready=true;});
    await vi.advanceTimersByTimeAsync(100);expect(ready).toBe(false);
    cleanup='verified';await vi.advanceTimersByTimeAsync(25);await shutdown;expect(ready).toBe(true);
  });
  it('refuses an unverified DAG cleanup receipt even when its request fulfilled',async()=>{
    const {runtime}=setup({dagReader:()=>({read:async()=>({ok:false,error:{kind:'timeout',message:'Bounded response'}}),recoveryState:()=>({cause:'timeout',cleanup:'unverified',retired:true,generation:0})})});
    await runtime.connect();await expect(runtime.prepareUpdateShutdown()).rejects.toMatchObject({reason:'unverified',areas:['DAG query']});
  });
  it('rejects a bounded DAG response with no independent cleanup API',async()=>{
    const {runtime}=setup({dagReader:()=>({read:async()=>({ok:false,error:{kind:'cancelled',message:'Cancelled'}})})});
    await runtime.connect();await expect(runtime.prepareUpdateShutdown()).rejects.toMatchObject({reason:'unverified'});
  });
  it('keeps ownership of read-root IO beyond its five-second response timeout',async()=>{
    const raw=deferred<[]>() ;
    const {runtime}=setup({}, {readRoots:{filterScopes:async scopes=>[...scopes],scopesFor:()=>raw.promise}});
    const connecting=runtime.connect();await vi.advanceTimersByTimeAsync(5000);await connecting;
    const shutdown=runtime.prepareUpdateShutdown().catch(error=>error);await vi.advanceTimersByTimeAsync(10_000);
    expect(await shutdown).toMatchObject({reason:'pending',areas:['read scopes']});
    raw.resolve([]);await vi.advanceTimersByTimeAsync(0);await expect(runtime.prepareUpdateShutdown()).resolves.toBeUndefined();
  });
  it('tracks a late cache read instead of accepting its bounded response as cleanup',async()=>{
    const config=configuration();config.configuration!.summarySelections=[{scopeId:'scope',dagRelativePath:'dag.yaml',taskIds:['T-1']}];
    const raw=deferred<null>();const read=vi.fn(()=>raw.promise);
    const {runtime}=setup({summaryCache:()=>({read})},{configuration:config});
    const connecting=runtime.connect();await vi.advanceTimersByTimeAsync(5000);await connecting;expect(read).toHaveBeenCalledOnce();
    let ready=false;const shutdown=runtime.prepareUpdateShutdown().then(()=>{ready=true;});
    await vi.advanceTimersByTimeAsync(50);expect(ready).toBe(false);
    raw.resolve(null);await vi.advanceTimersByTimeAsync(25);await shutdown;expect(ready).toBe(true);
  });
  it('retains a save failure swallowed by the registry transaction tail',async()=>{
    const registry=createProjectRegistry({persistence:{read:async()=>null,write:async()=>{throw Error('Close failed');}}});
    const {runtime}=setup({}, {projectRegistry:registry});await runtime.connect();await registry.settle();
    await expect(runtime.prepareUpdateShutdown()).rejects.toMatchObject({reason:'unverified',areas:['project state']});
  });
  it('preserves best-effort ordinary disposal without pretending it is verified',async()=>{
    const raw=deferred<OrcaResult<OrcaObservation>>();const {runtime}=setup({orca:()=>({read:vi.fn(),collect:()=>raw.promise})});
    const connecting=runtime.connect();expect(runtime.dispose()).toBeUndefined();
    const shutdown=runtime.prepareUpdateShutdown().catch(error=>error);await vi.advanceTimersByTimeAsync(10_000);expect(await shutdown).toMatchObject({reason:'pending'});
    raw.resolve({ok:true,value:observation()});await connecting;
  });
});
