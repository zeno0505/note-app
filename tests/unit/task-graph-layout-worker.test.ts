import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { createTaskGraphLayoutClient, type TaskGraphLayoutWorker } from '../../src/renderer/task-graph-layout-client';
import { handleTaskGraphLayoutRequest } from '../../src/renderer/task-graph-layout-worker';
import { assembleGraphSnapshot } from '../../src/shared/task-graph-transport';
import { produceTaskGraph } from '../../src/main/task-graph';
import type { DagReadModel } from '../../src/facts/dag-read-model';
import { GRAPH_FIXTURE_IDENTITY as identity, syntheticChain } from '../helpers/task-graph-fixtures';

function request() {
  const metadata = { contractVersion: 1, identity: { ...identity }, observedAt: '2026-10-14T00:00:00.000Z',
    coverage: { state: 'complete', counts: { sourceTaskRows: 0, uniqueNodes: 0, uniqueEdges: 0, unresolvedEdges: 0 }, reasons: [] },
    diagnostics: { duplicateIds: [], cycles: [], repeatedDeclarations: 0 }, chunkCount: 0, byteLength: 0 };
  return { requestId: 'synthetic-layout-request', snapshot: assembleGraphSnapshot(metadata, []), options: { grouping: 'ungrouped' as const, groupKey: null } };
}
describe('T-060 layout worker protocol', () => {
  it('returns a correlated structured-cloneable result for a verified empty graph', () => {
    const input = request(), before = structuredClone(input), response = handleTaskGraphLayoutRequest(input);
    expect(response).toMatchObject({ requestId: input.requestId, identity, layout: { identity, version: 1, nodes: [], edges: [] } });
    const clone = structuredClone(response);
    if (!('layout' in clone)) throw Error('fixture');
    expect(clone.layout.index.nodeById).toBeInstanceOf(Map);
    expect(input).toEqual(before);
  });

  it.each([null, [], 'source', { requestId: 'x' }])('returns a bounded error for malformed envelope %j', value => {
    expect(handleTaskGraphLayoutRequest(value)).toMatchObject({ error: 'invalid-request' });
  });

  it('rejects accessors without executing them', () => {
    const getter = vi.fn(() => 'private source text');
    const input = Object.defineProperty(request(), 'requestId', { enumerable: true, get: getter });
    expect(handleTaskGraphLayoutRequest(input)).toEqual({ requestId: '', identity: null, error: 'invalid-request' });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['extra', 'id', 'grouping', 'groupKey', 'snapshotShape', 'snapshotCount', 'metadataVersion', 'sourceLimit'])('rejects invalid %s', kind => {
    const input = request() as unknown as Record<string, any>;
    if (kind === 'extra') input.sourcePath = '/never-read';
    if (kind === 'id') input.requestId = 'x'.repeat(257);
    if (kind === 'grouping') input.options.grouping = 'invalid';
    if (kind === 'groupKey') input.options.groupKey = 'x'.repeat(4097);
    if (kind === 'snapshotShape') input.snapshot.source = 'never-evaluated';
    if (kind === 'snapshotCount') input.snapshot.nodes = [{ id: 'extra' }];
    if (kind === 'metadataVersion') input.snapshot.metadata.contractVersion = 0;
    if (kind === 'sourceLimit') input.snapshot.nodes = Array.from({ length: 10001 }, () => null);
    const result = handleTaskGraphLayoutRequest(input);
    expect(result).toMatchObject({ error: 'invalid-request' });
    expect(Object.keys(result).sort()).toEqual(['error', 'identity', 'requestId']);
    expect(JSON.stringify(result)).not.toContain('never-read');
  });

  it('does not echo arbitrary thrown layout exception content', () => {
    const input = request();
    // A prior layout with a hostile property is not a transport payload. Even a
    // local programming error here remains a bounded worker failure.
    input.options = { ...input.options, previous: new Proxy({}, { get() { throw Error('private source and stack'); } }) } as typeof input.options;
    const result = handleTaskGraphLayoutRequest(input);
    expect(result).toEqual({ requestId: input.requestId, identity, error: 'layout-failed' });
    expect(JSON.stringify(result)).not.toContain('private source');
  });
});


function populatedRequest(count: number, dense = false) {
  if (!count) return request();
  const rows = syntheticChain(count);
  if (dense) {
    for (let i = 0; i < count; i++) rows[i].dependencies = i < 10 ? [] : Array.from({ length: 10 }, (_, j) => ({ id: `S-${i - j}`, scope: 'internal' as const }));
    rows[count - 1].dependencies.push(...Array.from({ length: 100 }, (_, j) => ({ id: `S-${j + 1}`, scope: 'internal' as const })));
  }
  const model: DagReadModel = { dagId: identity.dagId, sourceHash: identity.sourceHash, sourceMtimeMs: 0,
    observedAt: '2026-10-14T00:00:00.000Z', doneStatus: 'done',
    tasks: rows.map(row => ({ id: row.id, title: row.title, status: row.declaredStatus, phase: row.phase, dependencies: row.dependencies,
      e2e: { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' }, commitReferences: [], commitVerification: 'not-performed' })),
    statusCounts: [], coverage: { tasksTotal: count, declared: 0, required: 0, uncoveredDone: [], uncoveredOpen: [], malformed: [] }, verifiedFacts: [] };
  const wire = produceTaskGraph(model, { projectId: identity.projectId, dagId: identity.dagId, sessionKey: identity.sessionKey });
  return { ...request(), snapshot: assembleGraphSnapshot(wire.metadata, wire.chunks) };
}

describe('T-060 actual separate-thread layout worker', () => {
  it.each([[0, false], [1001, false], [10000, false], [10000, true]] as const)('runs the production module off-thread for %i source nodes (maximum edges = %s)', async (count, dense) => {
    const compiled = await build({ entryPoints: [resolve('src/renderer/task-graph-layout-worker.ts')],
      bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`;
    // Node provides the physical thread here. This shim only supplies Web Worker
    // messaging globals; the production module installs its actual onmessage.
    const bootstrap = `import {parentPort} from 'node:worker_threads';
      globalThis.postMessage = value => parentPort.postMessage(value);
      await import(${JSON.stringify(moduleUrl)});
      parentPort.on('message', data => globalThis.onmessage({data}));`;
    const input = populatedRequest(count, dense), measurements: { roundtripMs: number; beforeRendererMs: number; rendererFinalizeMs: number; finalizationHeartbeats: number; maxFinalizationGapMs: number }[] = [];
    const iterations = process.env.GRAPH_LAYOUT_TIMING === '1' ? 3 : 1;
    for (let iteration = 0; iteration < iterations; iteration++) {
      const thread = new ThreadWorker(new URL(`data:text/javascript;base64,${Buffer.from(bootstrap).toString('base64')}`));
      let stop: Promise<number> | null = null, receivedAt = 0, lastBeat = 0, heartbeats = 0, maxGap = 0;
      const heartbeat = setInterval(() => {
        if (!receivedAt) return;
        const now = performance.now(); maxGap = Math.max(maxGap, now - (lastBeat || receivedAt)); lastBeat = now; heartbeats++;
      }, 1);
      const adapter: TaskGraphLayoutWorker = {
        onmessage: null, onerror: null, onmessageerror: null,
        postMessage: value => thread.postMessage(value),
        terminate: () => { stop = thread.terminate(); },
      };
      thread.on('message', data => { receivedAt = performance.now(); adapter.onmessage?.({ data } as MessageEvent<unknown>); });
      thread.on('error', error => adapter.onerror?.({ message: error.message, preventDefault() {} } as ErrorEvent));
      thread.on('messageerror', error => adapter.onmessageerror?.({ data: error } as MessageEvent<unknown>));
      const guard = vi.fn(() => input.snapshot.metadata.identity);
      const client = createTaskGraphLayoutClient({ workerFactory: () => adapter, getCurrentIdentity: guard });
      try {
        const start = performance.now(), layout = await client.layout(input.snapshot, input.options), finish = performance.now();
        maxGap = Math.max(maxGap, finish - (lastBeat || receivedAt));
        measurements.push({ roundtripMs: finish - start, beforeRendererMs: receivedAt - start, rendererFinalizeMs: finish - receivedAt,
          finalizationHeartbeats: heartbeats, maxFinalizationGapMs: maxGap });
        if (dense) expect(heartbeats).toBeGreaterThan(2);
        expect(layout.identity).toEqual(input.snapshot.metadata.identity);
        expect(layout.positionById).toBeInstanceOf(Map);
        expect(layout.index.incoming).toBeInstanceOf(Map);
        expect(layout.nodes).toHaveLength(count);
        expect(layout.edges).toHaveLength(dense ? 100000 : Math.max(0, count - 1));
        if (count) expect(layout.index.incoming.get(`S-${count}`)).toHaveLength(dense ? 110 : count > 1 ? 1 : 0);
        expect(guard).toHaveBeenCalledTimes(2);
        expect(stop).not.toBeNull();
        await stop;
      } finally {
        clearInterval(heartbeat);
        client.dispose();
        await thread.terminate();
      }
    }
    if (process.env.GRAPH_LAYOUT_TIMING === '1') {
      const p50 = (key: keyof typeof measurements[number]) => Math.round([...measurements].sort((a, b) => a[key] - b[key])[1][key] * 100) / 100;
      const report = { evidence: 'Node worker shim, not browser UI', nodes: count, edges: input.snapshot.edges.length, samples: measurements.length,
        p50RoundtripMs: p50('roundtripMs'), p50BeforeRendererMs: p50('beforeRendererMs'), p50RendererFinalizeMs: p50('rendererFinalizeMs'), p50FinalizationHeartbeats: p50('finalizationHeartbeats'),
        p50MaxFinalizationGapMs: p50('maxFinalizationGapMs'), measurements };
      console.info(JSON.stringify(report));
      if (process.env.GRAPH_LAYOUT_TIMING_OUTPUT) await appendFile(process.env.GRAPH_LAYOUT_TIMING_OUTPUT, JSON.stringify(report) + '\n');
    }
  }, 20000);
});
