import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskGraphService, produceTaskGraph } from '../../src/main/task-graph';
import type { DagReadModel } from '../../src/facts/dag-read-model';
import { createTaskGraphLayoutClient, createTaskGraphLayoutPipeline, type TaskGraphLayoutWorker } from '../../src/renderer/task-graph-layout-client';
import { handleTaskGraphLayoutRequest, type TaskGraphLayoutRequest } from '../../src/renderer/task-graph-layout-worker';
import { assembleGraphSnapshot } from '../../src/shared/task-graph-transport';
import type { TaskGraphBridge, TaskGraphIdentity } from '../../src/shared/task-graph-contract';
import { syntheticChain, syntheticHighDegree, syntheticNode, type SyntheticGraphTask } from '../helpers/task-graph-fixtures';

const authority = { projectId: 'synthetic-project', dagId: 'synthetic-dag', sessionKey: 'synthetic-session' };
const run = { grouping: 'ungrouped' as const, groupKey: null };
function model(rows: readonly SyntheticGraphTask[] = syntheticChain(3)): DagReadModel {
  return { dagId: authority.dagId, sourceHash: 'synthetic-source-v1', sourceMtimeMs: 0, observedAt: '2026-10-14T00:00:00.000Z', doneStatus: 'done',
    tasks: rows.map(row => ({ id: row.id, title: row.title, status: row.declaredStatus, phase: row.phase, dependencies: row.dependencies,
      e2e: { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' }, commitReferences: [], commitVerification: 'not-performed' })),
    statusCounts: [], coverage: { tasksTotal: rows.length, declared: 0, required: 0, uncoveredDone: [], uncoveredOpen: [], malformed: [] }, verifiedFacts: [] };
}
function snapshot(rows?: readonly SyntheticGraphTask[]) {
  const wire = produceTaskGraph(model(rows), authority);
  return assembleGraphSnapshot(wire.metadata, wire.chunks);
}
class FakeWorker implements TaskGraphLayoutWorker {
  onmessage: TaskGraphLayoutWorker['onmessage'] = null;
  onerror: TaskGraphLayoutWorker['onerror'] = null;
  onmessageerror: TaskGraphLayoutWorker['onmessageerror'] = null;
  request: TaskGraphLayoutRequest | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((request: TaskGraphLayoutRequest) => { this.request = structuredClone(request); });
  respond(value: unknown = handleTaskGraphLayoutRequest(this.request)) { this.onmessage?.({ data: value } as MessageEvent<unknown>); }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup() {
  const graph = snapshot(), workers: FakeWorker[] = [];
  let current: TaskGraphIdentity | null = graph.metadata.identity;
  const getCurrentIdentity = vi.fn(async () => current);
  const client = createTaskGraphLayoutClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, getCurrentIdentity });
  return { graph, client, workers, getCurrentIdentity, setCurrent: (value: TaskGraphIdentity | null) => { current = value; } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('T-060 cancellable worker boundary', () => {
  it('dispatches complete data, preserves Map indexes across cloning and checks live identity twice', async () => {
    const s = setup(), before = structuredClone(s.graph), promise = s.client.layout(s.graph, run);
    await flush();
    expect(s.workers).toHaveLength(1);
    expect(s.workers[0].request?.snapshot).toEqual(s.graph);
    s.workers[0].respond(structuredClone(handleTaskGraphLayoutRequest(s.workers[0].request)));
    const layout = await promise;
    expect(layout.nodes).toHaveLength(3);
    expect(layout.index.nodeById).toBeInstanceOf(Map);
    expect(layout.index.incoming.get('S-3')).toHaveLength(1);
    expect(s.getCurrentIdentity).toHaveBeenCalledTimes(2);
    expect(s.getCurrentIdentity.mock.calls[0]).toEqual([s.graph.metadata.identity, expect.any(AbortSignal)]);
    expect(s.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(s.workers[0].onmessage).toBeNull();
    expect(s.graph).toEqual(before);
  });

  it('reuses only the current identity/group result after a fresh authority check', async () => {
    const s = setup(), first = s.client.layout(s.graph, run);
    await flush(); s.workers[0].respond(); const layout = await first;
    expect(await s.client.layout(s.graph, run)).toBe(layout);
    expect(s.workers).toHaveLength(1);
    expect(s.getCurrentIdentity).toHaveBeenCalledTimes(4);
    expect(await s.client.layout(s.graph, { ...run, previous: layout })).toBe(layout);
    expect(s.workers).toHaveLength(1);
    s.setCurrent({ ...s.graph.metadata.identity, revision: 'changed' });
    await expect(s.client.layout(s.graph, run)).rejects.toThrow('stale-session');
    expect(s.workers).toHaveLength(1);
  });

  it('keeps at most one group cached and invalidates on explicit cancel/background', async () => {
    const s = setup();
    for (const options of [run, { grouping: 'prefix' as const, groupKey: null }, run]) {
      const pending = s.client.layout(s.graph, options); await flush(); s.workers.at(-1)!.respond(); await pending;
    }
    expect(s.workers).toHaveLength(3);
    s.client.cancel();
    const afterCancel = s.client.layout(s.graph, run); await flush(); s.workers[3].respond(); await afterCancel;
    s.client.setBackground(true); s.client.setBackground(false);
    const afterBackground = s.client.layout(s.graph, run); await flush(); s.workers[4].respond(); await afterBackground;
    expect(s.workers).toHaveLength(5);
  });

  it('does not reuse a layout when an independently supplied previous layout changes', async () => {
    const s = setup(), first = s.client.layout(s.graph, run);
    await flush(); s.workers[0].respond(); const result = await first;
    const second = s.client.layout(s.graph, { ...run, previous: structuredClone(result) });
    await flush(); expect(s.workers).toHaveLength(2); s.workers[1].respond(); await second;
  });

  it('physically terminates replaced workers and rejects delayed A to B to A callbacks', async () => {
    const s = setup();
    const first = s.client.layout(s.graph, run), firstFailure = expect(first).rejects.toThrow('cancelled');
    await flush();
    const firstWorker = s.workers[0], lateFirst = firstWorker.onmessage!;
    const other = { ...s.graph, metadata: { ...s.graph.metadata, identity: { ...s.graph.metadata.identity, sessionKey: 'B' } } };
    s.setCurrent(other.metadata.identity);
    const second = s.client.layout(other, run), secondFailure = expect(second).rejects.toThrow('cancelled');
    await flush();
    const secondWorker = s.workers[1], lateSecond = secondWorker.onmessage!;
    s.setCurrent(s.graph.metadata.identity);
    const third = s.client.layout(s.graph, run);
    await flush();
    lateFirst({ data: handleTaskGraphLayoutRequest(firstWorker.request) } as MessageEvent<unknown>);
    lateSecond({ data: handleTaskGraphLayoutRequest(secondWorker.request) } as MessageEvent<unknown>);
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);
    expect(secondWorker.terminate).toHaveBeenCalledTimes(1);
    expect(s.workers[2].terminate).not.toHaveBeenCalled();
    s.workers[2].respond();
    expect((await third).identity).toEqual(s.graph.metadata.identity);
    await Promise.all([firstFailure, secondFailure]);
    expect(new Set(s.workers.map(worker => worker.request?.requestId)).size).toBe(3);
  });

  it.each(['projectId', 'dagId', 'sourceHash', 'sessionKey', 'revision'] as const)('rejects changed live %s after computation', async field => {
    const s = setup(), promise = s.client.layout(s.graph, run);
    await flush();
    s.setCurrent({ ...s.graph.metadata.identity, [field]: 'changed' });
    s.workers[0].respond();
    await expect(promise).rejects.toThrow('stale-session');
    expect(s.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['projectId', 'dagId', 'sourceHash', 'sessionKey', 'revision'] as const)('rejects mismatched worker %s even when live authority is unchanged', async field => {
    const s = setup(), promise = s.client.layout(s.graph, run);
    await flush();
    const result = handleTaskGraphLayoutRequest(s.workers[0].request);
    s.workers[0].respond({ ...result, identity: { ...s.graph.metadata.identity, [field]: 'other' } });
    await expect(promise).rejects.toThrow('invalid-result');
    expect(s.getCurrentIdentity).toHaveBeenCalledTimes(1);
  });

  it.each(['requestId', 'layoutIdentity', 'version', 'grouping', 'groupKey', 'missingLayout', 'extraField'])('rejects malformed worker %s', async kind => {
    const s = setup(), promise = s.client.layout(s.graph, run);
    await flush();
    const result = handleTaskGraphLayoutRequest(s.workers[0].request);
    if (!('layout' in result)) throw Error('fixture');
    const changed: Record<string, unknown> = { ...result, layout: { ...result.layout } };
    const layout = changed.layout as Record<string, unknown>;
    if (kind === 'requestId') changed.requestId = 'unrelated';
    if (kind === 'layoutIdentity') layout.identity = { ...result.identity, revision: 'old' };
    if (kind === 'version') layout.version = 0;
    if (kind === 'grouping') layout.grouping = 'prefix';
    if (kind === 'groupKey') layout.groupKey = 'other';
    if (kind === 'missingLayout') delete changed.layout;
    if (kind === 'extraField') changed.path = '/not-accepted';
    s.workers[0].respond(changed);
    await expect(promise).rejects.toThrow('invalid-result');
    expect(s.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing index', (layout: any) => { delete layout.index; }],
    ['truncated nodes', (layout: any) => { layout.nodes = []; layout.positionById.clear(); layout.columns = []; layout.edges = []; layout.routeIndex = null; }],
    ['truncated routes', (layout: any) => { layout.edges = []; layout.routeIndex = null; }],
    ['source node omitted', (layout: any) => { layout.index.nodeById.delete('S-1'); }],
    ['source node altered', (layout: any) => { layout.index.nodeById.get('S-1').title = 'other'; }],
    ['source edge altered', (layout: any) => { layout.index.edgeById.values().next().value.to.id = 'S-1'; }],
    ['adjacency omitted', (layout: any) => { layout.index.incoming.set('S-2', []); }],
    ['adjacency duplicated', (layout: any) => { const id = layout.index.incoming.get('S-2')[0]; layout.index.incoming.set('S-2', [id, id]); }],
    ['group membership altered', (layout: any) => { layout.index.groupById.set('S-1', 'other'); }],
    ['node map alias broken', (layout: any) => { layout.positionById.set('S-1', { ...layout.nodes[0] }); }],
    ['node ID duplicated', (layout: any) => { layout.nodes[1].id = layout.nodes[0].id; }],
    ['nonfinite coordinates', (layout: any) => { layout.nodes[0].x = Infinity; }],
    ['zero card size', (layout: any) => { layout.nodes[0].width = 0; }],
    ['invalid row', (layout: any) => { layout.nodes[0].row = -1; }],
    ['canvas too small', (layout: any) => { layout.width = 0; }],
    ['column omitted', (layout: any) => { layout.columns.pop(); }],
    ['column alias broken', (layout: any) => { layout.columns[0].nodes[0] = { ...layout.nodes[0] }; }],
    ['route target altered', (layout: any) => { layout.edges[0].to = 'S-1'; }],
    ['route point nonfinite', (layout: any) => { layout.edges[0].points[0].x = NaN; }],
    ['route bounds altered', (layout: any) => { layout.edges[0].bounds.width++; }],
    ['route index omitted', (layout: any) => { layout.routeIndex = null; }],
    ['route index route omitted', (layout: any) => { layout.routeIndex.routes.pop(); }],
    ['route index cyclic', (layout: any) => { layout.routeIndex = { bounds: layout.routeIndex.bounds }; layout.routeIndex.left = layout.routeIndex; layout.routeIndex.right = layout.routeIndex; }],
    ['source cycles fabricated', (layout: any) => { layout.sourceCycles = [['S-1']]; }],
    ['groups omitted', (layout: any) => { layout.groups = []; }],
    ['status counts altered', (layout: any) => { layout.groups[0].declaredStatusCounts[0].count++; }],
    ['group links fabricated', (layout: any) => { layout.groupLinks = [{ fromGroupKey: 'a', toGroupKey: 'b', uniqueEdgeCount: 1, semantics: 'aggregate-only' }]; }],
    ['oversize nodes', (layout: any) => { layout.nodes = Array.from({ length: 10001 }, () => layout.nodes[0]); }],
    ['oversize edges', (layout: any) => { layout.edges = Array.from({ length: 100001 }, () => layout.edges[0]); }],
  ] as const)('rejects structurally invalid derived data: %s', async (_name, mutate) => {
    const s = setup(), promise = s.client.layout(s.graph, run);
    await flush();
    const result = handleTaskGraphLayoutRequest(s.workers[0].request);
    if (!('layout' in result)) throw Error('fixture');
    mutate(result.layout);
    s.workers[0].respond(result);
    await expect(promise).rejects.toThrow('invalid-result');
    expect(s.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects a correlated forged empty result for a nonempty graph', async () => {
    const s = setup(), promise = s.client.layout(s.graph, run); await flush();
    s.workers[0].respond({ requestId: s.workers[0].request!.requestId, identity: s.graph.metadata.identity,
      layout: { identity: s.graph.metadata.identity, version: 1, ...run, nodes: [], edges: [] } });
    await expect(promise).rejects.toThrow('invalid-result');
  });

  it('freezes records/arrays and revalidates cache Maps against the original snapshot', async () => {
    const s = setup(), promise = s.client.layout(s.graph, run); await flush(); s.workers[0].respond();
    const result = await promise;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nodes)).toBe(true);
    expect(Object.isFrozen(result.nodes[0])).toBe(true);
    expect(Object.isFrozen(result.index.incoming.get('S-2'))).toBe(true);
    (result.index.nodeById as Map<string, unknown>).delete('S-1');
    await expect(s.client.layout(s.graph, run)).rejects.toThrow('invalid-result');
    expect(s.workers).toHaveLength(1);
    const recovered = s.client.layout(s.graph, run); await flush(); s.workers[1].respond();
    expect((await recovered).nodes).toHaveLength(3);
  });

  it('preserves global-cycle diagnostics when a group projection contains no local cycle', async () => {
    const graph = snapshot([syntheticNode('A-1', ['B-1']), syntheticNode('B-1', ['A-1'])]), worker = new FakeWorker();
    const client = createTaskGraphLayoutClient({ workerFactory: () => worker, getCurrentIdentity: () => graph.metadata.identity });
    const promise = client.layout(graph, { grouping: 'prefix', groupKey: JSON.stringify(['prefix', 'value', 'A']) });
    await flush(); worker.respond(); const result = await promise;
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].cycle).toBe(true);
    expect(result.cycles).toEqual([]);
    expect(result.sourceCycles).toEqual([['A-1', 'B-1']]);
  });

  it('does not allocate a worker for a stale graph or pre-aborted signal', async () => {
    const s = setup();
    s.setCurrent(null);
    await expect(s.client.layout(s.graph, run)).rejects.toThrow('stale-session');
    const controller = new AbortController(); controller.abort();
    await expect(s.client.layout(s.graph, { ...run, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(s.workers).toHaveLength(0);
  });

  it.each(['cancel', 'background', 'dispose', 'signal'] as const)('terminates active work on %s and settles once', async reason => {
    const s = setup(), controller = new AbortController();
    const promise = s.client.layout(s.graph, { ...run, signal: controller.signal });
    await flush();
    const worker = s.workers[0], late = worker.onmessage!;
    if (reason === 'cancel') s.client.cancel();
    if (reason === 'background') s.client.setBackground(true);
    if (reason === 'dispose') s.client.dispose();
    if (reason === 'signal') controller.abort();
    await expect(promise).rejects.toThrow(reason === 'background' ? 'background' : reason === 'dispose' ? 'disposed' : 'cancelled');
    late({ data: handleTaskGraphLayoutRequest(worker.request) } as MessageEvent<unknown>);
    await flush();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    if (reason === 'background') {
      await expect(s.client.layout(s.graph, run)).rejects.toThrow('background');
      s.client.setBackground(false);
      const resumed = s.client.layout(s.graph, run); await flush(); s.workers[1].respond();
      await expect(resumed).resolves.toHaveProperty('identity', s.graph.metadata.identity);
    }
    if (reason === 'dispose') await expect(s.client.layout(s.graph, run)).rejects.toThrow('disposed');
  });

  it('uses one deadline for an unresponsive worker and clears it on completion', async () => {
    vi.useFakeTimers();
    const graph = snapshot(), worker = new FakeWorker();
    const client = createTaskGraphLayoutClient({ workerFactory: () => worker, getCurrentIdentity: () => graph.metadata.identity, timeoutMs: 25 });
    const promise = client.layout(graph, run), failure = expect(promise).rejects.toThrow('timeout');
    await flush();
    await vi.advanceTimersByTimeAsync(26);
    await failure;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a synchronous guard that exceeds the monotonic deadline before timers can run', async () => {
    const graph = snapshot(), factory = vi.fn(() => new FakeWorker());
    const client = createTaskGraphLayoutClient({ workerFactory: factory, timeoutMs: 5, getCurrentIdentity: () => {
      const until = performance.now() + 15; while (performance.now() < until) { /* Deliberately block this test's timer. */ }
      return graph.metadata.identity;
    } });
    await expect(client.layout(graph, run)).rejects.toThrow('timeout');
    expect(factory).not.toHaveBeenCalled();
  });

  it('checks the monotonic deadline after synchronous result freezing and before publication', async () => {
    const graph = snapshot(), worker = new FakeWorker(); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const client = createTaskGraphLayoutClient({ workerFactory: () => worker, timeoutMs: 10, getCurrentIdentity: () => graph.metadata.identity });
    const promise = client.layout(graph, run); await flush();
    const response = handleTaskGraphLayoutRequest(worker.request); if (!('layout' in response)) throw Error('fixture');
    const freeze = Object.freeze;
    vi.spyOn(Object, 'freeze').mockImplementation(value => { const result = freeze(value); if (value === response.layout) now = 11; return result; });
    worker.respond(response);
    await expect(promise).rejects.toThrow('timeout');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('bounds a non-settling live identity check (after worker = %s)', async afterWorker => {
    vi.useFakeTimers();
    const graph = snapshot(), worker = new FakeWorker(); let checks = 0;
    const client = createTaskGraphLayoutClient({ workerFactory: () => worker, timeoutMs: 25,
      getCurrentIdentity: () => ++checks === 1 && afterWorker ? graph.metadata.identity : new Promise(() => {}) });
    const promise = client.layout(graph, run), failure = expect(promise).rejects.toThrow('timeout');
    await flush(); if (afterWorker) worker.respond(); await flush();
    await vi.advanceTimersByTimeAsync(26); await failure;
    expect(worker.terminate).toHaveBeenCalledTimes(afterWorker ? 1 : 0);
  });

  it('cancels while awaiting the final guard and rejects its later success', async () => {
    const graph = snapshot(), worker = new FakeWorker(); let checks = 0, release!: (identity: TaskGraphIdentity) => void;
    const client = createTaskGraphLayoutClient({ workerFactory: () => worker,
      getCurrentIdentity: () => ++checks === 1 ? graph.metadata.identity : new Promise(resolve => { release = resolve; }) });
    const promise = client.layout(graph, run);
    await flush(); worker.respond(); await flush(); client.cancel();
    await expect(promise).rejects.toThrow('cancelled');
    release(graph.metadata.identity); await flush();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('cancels cooperative finalization without publishing and closes every pending channel', async () => {
    const graph = snapshot(syntheticChain(10000)), worker = new FakeWorker();
    const response = handleTaskGraphLayoutRequest({ requestId: 'prepared', snapshot: graph, options: run });
    const NativeChannel = globalThis.MessageChannel; let opened = 0, closed = 0, published = false;
    vi.stubGlobal('MessageChannel', class extends NativeChannel {
      constructor() {
        super(); opened += 2;
        for (const port of [this.port1, this.port2]) { const close = port.close.bind(port); port.close = () => { closed++; close(); }; }
      }
    });
    const guard = vi.fn(() => graph.metadata.identity);
    const client = createTaskGraphLayoutClient({ workerFactory: () => worker, getCurrentIdentity: guard });
    const promise = client.layout(graph, run); void promise.then(() => { published = true; }, () => {});
    await flush(); worker.respond({ ...response, requestId: worker.request!.requestId });
    const cancellation = new Promise<void>(resolve => setTimeout(() => { client.cancel(); resolve(); }, 0));
    await expect(promise).rejects.toThrow('cancelled'); await cancellation; await flush();
    expect(opened).toBeGreaterThan(0); expect(closed).toBe(opened);
    expect(published).toBe(false); expect(guard).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('rejects identity changes during yielded finalization (cache hit = %s)', async cached => {
    const graph = snapshot(syntheticChain(1001)), worker = new FakeWorker();
    const response = handleTaskGraphLayoutRequest({ requestId: 'prepared', snapshot: graph, options: run });
    let identity = graph.metadata.identity, published = false;
    const guard = vi.fn(() => identity);
    const client = createTaskGraphLayoutClient({ workerFactory: () => worker, getCurrentIdentity: guard });
    if (cached) {
      const initial = client.layout(graph, run); await flush(); worker.respond({ ...response, requestId: worker.request!.requestId }); await initial;
    }
    const promise = client.layout(graph, run); void promise.then(() => { published = true; }, () => {});
    await flush(); if (!cached) worker.respond({ ...response, requestId: worker.request!.requestId });
    const change = new Promise<void>(resolve => setTimeout(() => { identity = { ...identity, revision: 'changed-during-finalization' }; resolve(); }, 0));
    await expect(promise).rejects.toThrow('stale-session'); await change;
    expect(published).toBe(false); expect(guard).toHaveBeenCalledTimes(cached ? 4 : 2);
  });

  it('enforces the deadline during yielded finalization without a partial result', async () => {
    const graph = snapshot(syntheticChain(10000)), worker = new FakeWorker();
    const response = handleTaskGraphLayoutRequest({ requestId: 'prepared', snapshot: graph, options: run });
    const guard = vi.fn(() => graph.metadata.identity);
    const client = createTaskGraphLayoutClient({ workerFactory: () => worker, getCurrentIdentity: guard, timeoutMs: 10 });
    const promise = client.layout(graph, run), failure = expect(promise).rejects.toThrow('timeout');
    await flush(); worker.respond({ ...response, requestId: worker.request!.requestId });
    await failure;
    expect(guard).toHaveBeenCalledTimes(1); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['factory', 'postMessage', 'error', 'messageerror'] as const)('settles bounded %s failure without exposing arbitrary exception text', async failure => {
    const graph = snapshot(), worker = new FakeWorker();
    if (failure === 'postMessage') worker.postMessage.mockImplementation(() => { throw Error('private source text'); });
    const client = createTaskGraphLayoutClient({ workerFactory: () => { if (failure === 'factory') throw Error('private path'); return worker; },
      getCurrentIdentity: () => graph.metadata.identity });
    const promise = client.layout(graph, run); await flush();
    if (failure === 'error') worker.onerror!({ preventDefault: vi.fn(), message: 'private source text' } as unknown as ErrorEvent);
    if (failure === 'messageerror') worker.onmessageerror!({ data: 'private source text' } as MessageEvent<unknown>);
    await expect(promise).rejects.toThrow({ factory: 'worker-unavailable', postMessage: 'invalid-request', error: 'layout-failed', messageerror: 'invalid-result' }[failure]);
    expect(worker.terminate).toHaveBeenCalledTimes(failure === 'factory' ? 0 : 1);
  });
});

function pipelineSetup(rows: readonly SyntheticGraphTask[] = syntheticChain(3)) {
  let value = model(rows), current: typeof authority | null = authority;
  const service = createTaskGraphService({ current: () => current, read: async () => value });
  const bridge: TaskGraphBridge = {
    getTaskGraphSession: vi.fn(async () => current), readTaskGraph: vi.fn(service.read),
    readTaskGraphChunk: vi.fn(service.chunk), readTaskGraphDetail: vi.fn(service.detail), cancelTaskGraph: vi.fn(async request => { service.cancel(request); }),
  };
  const workers: FakeWorker[] = [];
  const pipeline = createTaskGraphLayoutPipeline(bridge, { workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  return { pipeline, bridge, service, workers, changeRevision: () => { value = { ...value, sourceHash: 'new-source' }; },
    changeSession: () => { current = { ...authority, sessionKey: 'new-session' }; } };
}

describe('T-060 complete renderer pipeline', () => {
  it('keeps >1,000 nodes and degree 12 with final metadata freshness checks and releases every lease', async () => {
    const rows = [...syntheticChain(1001), ...syntheticHighDegree().map(node => ({ ...node, id: `H${node.id}`,
      dependencies: node.dependencies.map(dependency => ({ ...dependency, id: `H${dependency.id}` })) }))];
    const s = pipelineSetup(rows), promise = s.pipeline.read(authority.projectId, run);
    await vi.waitFor(() => expect(s.workers).toHaveLength(1));
    const chunksBefore = vi.mocked(s.bridge.readTaskGraphChunk).mock.calls.length;
    s.workers[0].respond();
    const result = await promise;
    expect(result.snapshot.nodes).toHaveLength(1014);
    expect(result.layout.index.nodeById.size).toBe(1014);
    expect(result.layout.index.incoming.get('HS-13')).toHaveLength(12);
    expect(s.bridge.readTaskGraphChunk).toHaveBeenCalledTimes(chunksBefore);
    expect(s.bridge.readTaskGraph).toHaveBeenCalledTimes(3);
    const reads = vi.mocked(s.bridge.readTaskGraph).mock.calls.map(([request]) => request);
    expect(reads.slice(1).every(request => request.expectedRevision === result.snapshot.metadata.identity.revision)).toBe(true);
    expect(new Set(reads.map(request => request.requestId)).size).toBe(3);
    const released = new Set(vi.mocked(s.bridge.cancelTaskGraph).mock.calls.map(([request]) => request.requestId));
    expect(reads.every(request => released.has(request.requestId))).toBe(true);
    s.pipeline.dispose(); s.service.invalidate();
  });

  it('serves an existing snapshot from the bounded cache after a new main-side revision probe', async () => {
    const s = pipelineSetup(), initial = s.pipeline.read(authority.projectId, run);
    await vi.waitFor(() => expect(s.workers).toHaveLength(1)); s.workers[0].respond();
    const first = await initial;
    const chunkCount = vi.mocked(s.bridge.readTaskGraphChunk).mock.calls.length;
    expect(await s.pipeline.layout(first.snapshot, run)).toBe(first.layout);
    expect(s.workers).toHaveLength(1);
    expect(s.bridge.readTaskGraph).toHaveBeenCalledTimes(5);
    expect(s.bridge.readTaskGraphChunk).toHaveBeenCalledTimes(chunkCount);
    s.changeRevision();
    await expect(s.pipeline.layout(first.snapshot, run)).rejects.toThrow('source-changed');
    expect(s.workers).toHaveLength(1);
    s.pipeline.dispose(); s.service.invalidate();
  });

  it.each(['revision', 'session'] as const)('rejects live %s changes while the worker runs', async change => {
    const s = pipelineSetup(), promise = s.pipeline.read(authority.projectId, run);
    await vi.waitFor(() => expect(s.workers).toHaveLength(1));
    if (change === 'revision') s.changeRevision(); else s.changeSession();
    s.workers[0].respond();
    await expect(promise).rejects.toThrow(change === 'revision' ? 'source-changed' : 'stale-session');
    expect(s.workers[0].terminate).toHaveBeenCalledTimes(1);
    s.pipeline.dispose(); s.service.invalidate();
  });

  it('cancels before read completion and refuses background/unmounted requests', async () => {
    const s = pipelineSetup(), promise = s.pipeline.read(authority.projectId, run);
    s.pipeline.setBackground(true);
    await expect(promise).rejects.toThrow('cancelled');
    await expect(s.pipeline.read(authority.projectId, run)).rejects.toThrow('background');
    s.pipeline.setBackground(false); s.pipeline.dispose();
    await expect(s.pipeline.read(authority.projectId, run)).rejects.toThrow('disposed');
    expect(s.workers).toHaveLength(0);
    s.service.invalidate();
  });
});
