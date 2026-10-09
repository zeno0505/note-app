import fs from 'node:fs/promises';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {createProjectRegistry} from '../../src/main/projects/registry';
import { createLiveRuntime, type LiveRuntimeDependencies } from '../../src/main/live-runtime';
import type { LoadedLiveConfiguration } from '../../src/main/live-config-types';
import type { OrcaAdapter, OrcaObservation, OrcaResult } from '../../src/collector/orca';
import type { NoteMappingRequest, NoteMappingResult } from '../../src/collector/notes';
import type { DagReadModel, DagTask } from '../../src/facts/dag-read-model';
import { projectCodeBurn, type CodeBurnQuery, type CodeBurnResult } from '../../src/summary/budget/codeburn';
import type {SummaryCachePayload} from '../../src/summary/storage/payload';
import type {RepositoryUsagePeriod,RepositoryUsageResult} from '../../src/phase2/repository-usage';
import type {EvidenceList} from '../../src/shared/evidence';
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
afterEach(()=>{for(const runtime of runtimes.splice(0))runtime.dispose();vi.restoreAllMocks();vi.useRealTimers();});


/** All collectors are injected. Only files created in these tests are read. */
async function evidenceFixture(linkCount = 8) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'phase2-expanded-boundary-')));
  const config = configuration();
  config.configuration!.summarySelections = [];
  config.configuration!.noteScopes[0].scopePath = root;
  const f = setup(config), model = dag();
  model.tasks[0].details = { description: null, acceptanceCriteria: [], targetFiles: [], design: ['a.md'], discussion: [], omissions: 0 };
  f.readDag.mockResolvedValue({ ok: true, value: model, unchanged: false });
  f.mapNotes.mockImplementation(async request => {
    const result = mapping(request);
    for (const row of result.mappings) if (row.state === 'resolved') { row.canonicalNotePath = root; row.canonicalDagPath = path.join(root, 'dag.yaml'); }
    for (const row of result.dags) row.canonicalDagPath = path.join(root, 'dag.yaml');
    return result;
  });
  for (let i = 0; i <= linkCount; i++) await writeFile(path.join(root, i === 0 ? 'a.md' : `d${i}.md`), i === linkCount ? 'Synthetic end' : `[next](d${i + 1}.md)`);
  const state = await f.runtime.connect();
  const list = await f.runtime.prepareTaskEvidence({ workstreamId: state.workstreams[0].id, taskId: 'T-0', sourceHash: model.sourceHash });
  return { ...f, root, list };
}
const readEvidence = (runtime: ReturnType<typeof createLiveRuntime>, list: EvidenceList, evidenceId = list.items[0].evidenceId, expectedSourceHash: string | null = null) =>
  runtime.readTaskEvidence({ sessionId: list.sessionId, evidenceId, expectedSourceHash });
function repositorySuccess(query: RepositoryUsagePeriod): RepositoryUsageResult {
  const coverage = { branchKnownCost: 0, branchUnknownCost: 0, noBranchDataCost: 1, noBranchDataSessions: 1, noBranchDataProviders: ['codex'], distinctSessions: 0 };
  return { ok: true, value: { source: 'codeburn-cli:spend:branch-json', contract: 'codeburn-0.9.25-branch-json', query, observedAt: Date.now(),
    period: { label: query, start: '2026-10-03T00:00:00.000Z', end: '2026-10-03T23:59:59.999Z', calendarBasis: 'source-local-timezone-unknown', endInclusive: true },
    currency: 'USD', approximate: true, coverage: 'unknown',
    projects: [0, 1].map(i => ({ codeburnProjectId: `/synthetic/worktree/${i}`, label: `tree${i}`, originKey: null, totalCost: 1, coverageEvidence: { ...coverage }, branches: [] })),
    totals: { ...coverage, noBranchDataCost: 2, noBranchDataSessions: 2 } } };
}

describe('expanded Phase 2 runtime boundaries', () => {
  it('reuses source-bound children through repeated document opens and Back-style hash checks', async () => {
    const f = await evidenceFixture();
    try {
      let childId: string | undefined, hash: string | null = null;
      for (let i = 0; i < 32; i++) {
        const view = await readEvidence(f.runtime, f.list, f.list.items[0].evidenceId, hash);
        expect(view.result.ok).toBe(true);
        if (!view.result.ok) throw Error('Synthetic evidence read failed');
        hash = view.result.sourceHash;
        if (childId) expect(view.references!.session.sessionId).toBe(childId);
        childId = view.references!.session.sessionId;
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('checks document ancestors linearly instead of recursively multiplying file reads', async () => {
    const f = await evidenceFixture();
    try {
      let list = f.list, evidenceId = list.items[0].evidenceId;
      const open = vi.spyOn(fs, 'open');
      for (let depth = 0; depth <= 8; depth++) {
        open.mockClear();
        const view = await readEvidence(f.runtime, list, evidenceId);
        expect(view.result.ok).toBe(true);
        // Three endpoint checks, one bounded read per ancestor, plus the selected file.
        expect(open.mock.calls.length).toBeLessThanOrEqual(1 + 3 * depth);
        if (depth < 8) { list = view.references!.session; evidenceId = view.references!.targets[0].evidenceId; }
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('keeps all checkout/repository identities when several worktrees share one registered DAG', async () => {
    const f = setup(configuration(), true, { repositoryUsage: () => ({ read: async query => repositorySuccess(query) }) }, createProjectRegistry());
    f.collect.mockImplementation(async () => {
      const value = observation(); value.joined[0].worktree.repoId = 'repo-A'; value.joined[1].worktree.repoId = 'repo-B';
      return { ok: true, value };
    });
    const state = await f.runtime.connect(), projects = state.repositoryUsage!.views[0].projects;
    expect(state.workstreams).toHaveLength(1);
    expect(projects[0].match).toMatchObject({ state: 'matched', tier: 'registered-project', repository: { id: 'repo-A' } });
    expect(projects[1].match).toMatchObject({ state: 'matched', tier: 'registered-project', repository: { id: 'repo-B' } });
    expect(projects[0].match.workstreamIds).toEqual([state.workstreams[0].id]);
    expect(projects[1].match.workstreamIds).toEqual([state.workstreams[0].id]);
  });

  it('never matches a historical path from a remote-host checkout', async () => {
    const f = setup(configuration(), true, { repositoryUsage: () => ({ read: async query => repositorySuccess(query) }) });
    f.collect.mockImplementation(async () => { const value = observation(); value.joined[1].worktree.identity.hostId = 'remote-host'; return { ok: true, value }; });
    const state = await f.runtime.connect();
    expect(state.repositoryUsage!.views[0].projects[0].match.state).toBe('matched');
    expect(state.repositoryUsage!.views[0].projects[1].match.state).toBe('unknown');
  });

  it('rejects descendants when the parent document changes and when its root session is released', async () => {
    const f = await evidenceFixture();
    try {
      const parent = await readEvidence(f.runtime, f.list), refs = parent.references!;
      await writeFile(path.join(f.root, 'a.md'), 'Synthetic changed source without a link');
      await expect(readEvidence(f.runtime, refs.session, refs.targets[0].evidenceId)).rejects.toThrow();
      f.runtime.releaseTaskEvidence({ sessionId: f.list.sessionId });
      await expect(readEvidence(f.runtime, refs.session, refs.targets[0].evidenceId)).rejects.toThrow();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('enforces the endpoint deadline and closes a file handle that resolves after cancellation', async () => {
    const f = await evidenceFixture();
    const handle = await fs.open(path.join(f.root, 'a.md'), 'r');
    const close = vi.spyOn(handle, 'close');
    let resume: () => void = () => {}, entered = false;
    const open = vi.spyOn(fs, 'open').mockImplementationOnce(async () => {
      entered = true;
      await new Promise<void>(resolve => { resume = resolve; });
      return handle;
    });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      expect(milliseconds).toBe(5000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const outcome = readEvidence(f.runtime, f.list).then(() => 'unexpected-success', () => 'cancelled');
      await vi.waitFor(() => expect(entered).toBe(true));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toBe('cancelled');
      expect(close).not.toHaveBeenCalled();
      resume();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      await expect(readEvidence(f.runtime, f.list)).rejects.toThrow();
    } finally {
      resume(); open.mockRestore();
      await handle.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('throttles periodic repository reads, permits manual reads, and retains failed results only as stale', async () => {
    const read = vi.fn<ReturnType<LiveRuntimeDependencies['repositoryUsage']>['read']>(async query => repositorySuccess(query));
    const f = setup(configuration(), true, { repositoryUsage: () => ({ read }) });
    await f.runtime.connect(); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40_000); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000); expect(read).toHaveBeenCalledTimes(4);
    f.runtime.setActivity({ active: false, visible: false });
    await vi.advanceTimersByTimeAsync(299_999); expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(6);
    read.mockImplementation(async query => ({ ok: false, observedAt: Date.now(), error: { kind: 'command-failed', query } }));
    const failed = await f.runtime.refresh(); expect(read).toHaveBeenCalledTimes(8);
    for (const view of failed.repositoryUsage!.views) {
      expect(view).toMatchObject({ state: 'failed', freshness: 'stale' });
      expect(view.projects).toHaveLength(2);
      expect(view.projects.every(project => project.chartCost === null)).toBe(true);
    }
    await f.runtime.disconnect();
    await vi.advanceTimersByTimeAsync(600_000); expect(read).toHaveBeenCalledTimes(8);
  });
});
