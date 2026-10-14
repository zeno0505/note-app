import { describe, expect, it, vi } from 'vitest';
import { graphEdgeId, TASK_GRAPH_LIMITS as L, type GraphChunk, type GraphSnapshotMetadata, type GraphSourceEdge, type GraphSourceNode } from '../../src/shared/task-graph-contract';
import { assembleGraphSnapshot, graphEncodedBytes, parseGraphCancelRequest, parseGraphChunk, parseGraphChunkRequest, parseGraphMetadata, parseGraphReadRequest, parseGraphSessionRequest } from '../../src/shared/task-graph-transport';
import { GRAPH_FIXTURE_IDENTITY as identity } from '../helpers/task-graph-fixtures';

const makeNode = (id: string): GraphSourceNode => ({ id, title: `Synthetic ${id}`, declaredStatus: null, phase: null });
const makeEdge = (from: string, to: string): GraphSourceEdge => ({ id: graphEdgeId(from, to, 'internal'), from: { kind: 'node', id: from }, to: { kind: 'node', id: to }, scope: 'internal', declarations: 1 });
function seal(chunk: GraphChunk): GraphChunk {
  for (let i = 0; i < 10; i++) {
    const bytes = graphEncodedBytes(chunk);
    if (bytes === chunk.byteLength) return chunk;
    chunk.byteLength = bytes;
  }
  throw Error('fixture byte length did not converge');
}
const makeChunk = (nodes: readonly GraphSourceNode[], edges: readonly GraphSourceEdge[] = [], index = 0): GraphChunk =>
  seal({ contractVersion: 1, identity: { ...identity }, index, nodes, edges, byteLength: 0 });
function makeMetadata(chunks: readonly GraphChunk[]): GraphSnapshotMetadata {
  const nodes = chunks.flatMap(chunk => chunk.nodes), edges = chunks.flatMap(chunk => chunk.edges);
  return { contractVersion: 1, identity: { ...identity }, observedAt: '2026-10-14T00:00:00.000Z',
    coverage: { state: 'complete', counts: { sourceTaskRows: nodes.length, uniqueNodes: nodes.length, uniqueEdges: edges.length,
      unresolvedEdges: edges.filter(edge => edge.from.kind === 'unresolved' || edge.to.kind === 'unresolved').length }, reasons: [] },
    diagnostics: { duplicateIds: [], cycles: [], repeatedDeclarations: edges.reduce((sum, edge) => sum + edge.declarations - 1, 0) },
    chunkCount: chunks.length, byteLength: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) };
}
const readRequest = () => ({ requestId: 'request', projectId: identity.projectId, dagId: identity.dagId, sessionKey: identity.sessionKey, expectedRevision: null });
const invalid = (action: () => unknown) => expect(action).toThrow('invalid graph');

describe('T-058 strict graph request decoding', () => {
  it('returns fresh bounded requests and accepts exact character limits', () => {
    const input = { ...readRequest(), requestId: 'r'.repeat(256), projectId: 'p'.repeat(1024), dagId: 'd'.repeat(1024), sessionKey: 's'.repeat(1024), expectedRevision: 'v'.repeat(1024) };
    expect(parseGraphReadRequest(input)).toEqual(input);
    expect(parseGraphReadRequest(input)).not.toBe(input);
    expect(parseGraphCancelRequest({ requestId: input.requestId })).toBe(input.requestId);
    expect(parseGraphSessionRequest({ projectId: input.projectId })).toEqual({ projectId: input.projectId });
    const request = { requestId: 'r', identity: Object.fromEntries(Object.keys(identity).map(key => [key, 'i'.repeat(1024)])), index: L.chunkCount - 1 };
    expect(parseGraphChunkRequest(request)).toEqual(request);
  });

  it.each(['requestId', 'projectId', 'dagId', 'sessionKey', 'expectedRevision'])('rejects overlong request field %s', key => {
    invalid(() => parseGraphReadRequest({ ...readRequest(), [key]: 'x'.repeat(key === 'requestId' ? 257 : 1025) }));
  });

  it('rejects untrusted shapes, accessors, inherited fields, symbols and extra authority', () => {
    const getter = vi.fn(() => 'request');
    const accessor = Object.defineProperty(readRequest(), 'requestId', { enumerable: true, get: getter });
    for (const value of [null, [], 'request', new Date(), Object.create(readRequest()), { ...readRequest(), path: '/untrusted' }, { ...readRequest(), url: 'https://invalid.test' },
      { ...readRequest(), [Symbol('hidden')]: true }, accessor, Object.defineProperty(readRequest(), 'requestId', { value: 'request', enumerable: false })]) {
      invalid(() => parseGraphReadRequest(value));
    }
    expect(getter).not.toHaveBeenCalled();
    invalid(() => parseGraphCancelRequest('request'));
    invalid(() => parseGraphCancelRequest({ requestId: 'request', projectId: 'other' }));
    invalid(() => parseGraphSessionRequest({ projectId: 'p', authorized: true }));
    for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, L.chunkCount]) invalid(() => parseGraphChunkRequest({ requestId: 'r', identity, index }));
  });
});

describe('T-058 bounded strict chunk decoding', () => {
  it('retains exact ID/title/status/phase limits and escaped tuple identities longer than 256', () => {
    const id = '\u0000'.repeat(256), other = '\\'.repeat(256);
    const node: GraphSourceNode = { id, title: '한'.repeat(2048), declaredStatus: 's'.repeat(128), phase: { id: 'p'.repeat(256), title: 't'.repeat(2048), index: Number.MAX_SAFE_INTEGER } };
    const chunk = makeChunk([node, makeNode(other)], [makeEdge(id, other)]);
    expect(chunk.edges[0].id.length).toBeGreaterThan(256);
    expect(parseGraphChunk(chunk)).toEqual(chunk);
    expect(graphEncodedBytes(chunk)).toBeGreaterThan(JSON.stringify(chunk).length);
    const parsed = parseGraphChunk(chunk);
    expect(parsed.nodes[0]).not.toBe(node);
    expect(parsed.identity).not.toBe(chunk.identity);
  });

  it.each([
    ['id', 'x'.repeat(257)], ['title', 'x'.repeat(2049)], ['declaredStatus', 'x'.repeat(129)],
    ['phase', { id: 'x'.repeat(257), title: null, index: 0 }], ['phase', { id: null, title: 'x'.repeat(2049), index: 0 }],
    ['phase', { id: null, title: null, index: -1 }], ['phase', { id: null, title: null, index: 0, url: 'https://invalid.test' }],
  ])('rejects malformed node %s', (key, value) => {
    invalid(() => parseGraphChunk(makeChunk([{ ...makeNode('a'), [key]: value } as GraphSourceNode])));
  });

  it('checks exact self-inclusive UTF-8 bytes and every structural edge field', () => {
    const chunk = makeChunk([makeNode('a'), makeNode('b')], [makeEdge('a', 'b')]);
    for (const mutate of [
      (c: GraphChunk) => { c.byteLength--; },
      (c: GraphChunk) => { c.byteLength++; },
      (c: GraphChunk) => { (c as { contractVersion: number }).contractVersion = 2; },
      (c: GraphChunk) => { c.edges[0].id = 'made-up'; seal(c); },
      (c: GraphChunk) => { c.edges[0].declarations = 0; seal(c); },
      (c: GraphChunk) => { c.edges[0].declarations = 1.5; seal(c); },
      (c: GraphChunk) => { Object.assign(c.edges[0].from, { reason: 'missing' }); seal(c); },
      (c: GraphChunk) => { c.nodes = [...c.nodes, c.nodes[0]]; seal(c); },
      (c: GraphChunk) => { c.edges = [...c.edges, c.edges[0]]; seal(c); },
      (c: GraphChunk) => { Object.assign(c, { rawSource: 'untrusted' }); seal(c); },
    ]) { const changed = structuredClone(chunk); mutate(changed); invalid(() => parseGraphChunk(changed)); }
    const unicode = makeChunk([{ ...makeNode('a'), title: '한😀' }]);
    unicode.byteLength = JSON.stringify(unicode).length;
    invalid(() => parseGraphChunk(unicode));
  });

  it('rejects sparse, decorated, subclassed and accessor arrays without invoking getters', () => {
    const getter = vi.fn(() => makeNode('a'));
    const base = makeChunk([makeNode('a')]);
    const accessor = Object.defineProperty([makeNode('a')], '0', { enumerable: true, get: getter });
    class Nodes extends Array<GraphSourceNode> {}
    for (const nodes of [new Array(1), Object.assign([makeNode('a')], { hidden: true }), new Nodes(makeNode('a')), accessor]) invalid(() => parseGraphChunk({ ...base, nodes }));
    expect(getter).not.toHaveBeenCalled();
  });

  it('accepts exact chunk item budgets and rejects empty or one-over-budget chunks', () => {
    expect(parseGraphChunk(makeChunk(Array.from({ length: 250 }, (_, i) => makeNode(`n-${i}`)))).nodes).toHaveLength(250);
    expect(parseGraphChunk(makeChunk([], Array.from({ length: 2000 }, (_, i) => makeEdge(`n-${i}`, 'target')))).edges).toHaveLength(2000);
    invalid(() => parseGraphChunk(makeChunk([])));
    invalid(() => parseGraphChunk(makeChunk(Array.from({ length: 251 }, (_, i) => makeNode(`n-${i}`)))));
    invalid(() => parseGraphChunk(makeChunk([], Array.from({ length: 2001 }, (_, i) => makeEdge(`n-${i}`, 'target')))));
  });

  it('accepts exactly 512 KiB and rejects the next UTF-8 byte', () => {
    const nodes = Array.from({ length: 250 }, (_, i) => ({ ...makeNode(`n-${i}`), title: '' }));
    const chunk = makeChunk(nodes);
    let remaining = L.chunkBytes - chunk.byteLength;
    for (const node of nodes) { const size = Math.min(2048, remaining); node.title = 'x'.repeat(size); remaining -= size; }
    seal(chunk);
    const adjustable = nodes.find(node => node.title.length > 0 && node.title.length < 2048)!;
    adjustable.title = adjustable.title.slice(0, adjustable.title.length - (chunk.byteLength - L.chunkBytes));
    seal(chunk);
    expect(chunk.byteLength).toBe(L.chunkBytes);
    expect(parseGraphChunk(chunk).byteLength).toBe(L.chunkBytes);
    adjustable.title += 'x'; seal(chunk);
    expect(chunk.byteLength).toBe(L.chunkBytes + 1);
    invalid(() => parseGraphChunk(chunk));
  });
});

describe('T-058 bounded metadata and atomic assembly', () => {
  it('keeps verified empty, unknown, and partial snapshots distinct', () => {
    const empty = makeMetadata([]);
    expect(assembleGraphSnapshot(empty, [])).toEqual({ metadata: empty, nodes: [], edges: [] });
    const unknown: GraphSnapshotMetadata = { ...empty, coverage: { state: 'unknown', counts: null, reasons: ['not-read'] } };
    expect(assembleGraphSnapshot(unknown, []).metadata.coverage.state).toBe('unknown');
    const partial: GraphSnapshotMetadata = { ...empty, coverage: { state: 'partial', counts: { sourceTaskRows: null, uniqueNodes: 0, uniqueEdges: 0, unresolvedEdges: 0 }, reasons: ['incomplete-read'] } };
    expect(assembleGraphSnapshot(partial, []).metadata.coverage.state).toBe('partial');
    invalid(() => parseGraphMetadata({ ...unknown, chunkCount: 1, byteLength: 400 }));
    invalid(() => parseGraphMetadata({ ...unknown, coverage: { state: 'unknown', counts: empty.coverage.counts, reasons: ['not-read'] } }));
    invalid(() => parseGraphMetadata({ ...partial, coverage: { ...partial.coverage, reasons: [] } }));
    invalid(() => parseGraphMetadata({ ...partial, coverage: { ...partial.coverage, reasons: ['incomplete-read', 'incomplete-read'] } }));
  });

  it('rejects impossible chunk loops, count budgets, totals and malformed timestamps before fetching', () => {
    const chunk = makeChunk([makeNode('a')]), metadata = makeMetadata([chunk]);
    for (const changes of [
      { chunkCount: 1001 }, { chunkCount: 2 }, { chunkCount: 0 }, { byteLength: 0 }, { byteLength: L.snapshotBytes + 1 },
      { byteLength: L.chunkBytes + 1 }, { observedAt: '2026-02-30T00:00:00Z' }, { observedAt: 'not-a-date' }, { contractVersion: 2 },
      { url: 'https://invalid.test' }, { diagnostics: { duplicateIds: [], cycles: [], repeatedDeclarations: -1 } },
    ]) invalid(() => parseGraphMetadata({ ...metadata, ...changes }));
    for (const changes of [
      { uniqueNodes: L.sourceNodes + 1 }, { uniqueEdges: L.sourceEdges + 1 }, { uniqueEdges: 0, unresolvedEdges: 1 },
      { sourceTaskRows: null }, { sourceTaskRows: 2 }, { uniqueNodes: 251, sourceTaskRows: 251 }, { uniqueEdges: 2001 },
    ]) invalid(() => parseGraphMetadata({ ...metadata, coverage: { state: 'complete', counts: { ...metadata.coverage.counts, ...changes }, reasons: [] } }));
  });

  it('rejects metadata above its own single-chunk byte budget', () => {
    const duplicateIds = Array.from({ length: 2500 }, (_, i) => `${i}`.padEnd(256, 'x'));
    const metadata: GraphSnapshotMetadata = { ...makeMetadata([]), coverage: { state: 'partial', counts: { sourceTaskRows: 5000, uniqueNodes: 0, uniqueEdges: 0, unresolvedEdges: 0 }, reasons: ['duplicate-id'] }, diagnostics: { duplicateIds, cycles: [], repeatedDeclarations: 0 } };
    expect(graphEncodedBytes(metadata)).toBeGreaterThan(L.chunkBytes);
    invalid(() => parseGraphMetadata(metadata));
  });

  it('accepts exact metadata caps for 32 MiB, 10,000 nodes and 100,000 declarations', () => {
    const metadata: GraphSnapshotMetadata = { ...makeMetadata([]), chunkCount: 64, byteLength: L.snapshotBytes,
      coverage: { state: 'complete', counts: { sourceTaskRows: L.sourceNodes, uniqueNodes: L.sourceNodes, uniqueEdges: L.sourceEdges, unresolvedEdges: 0 }, reasons: [] } };
    expect(parseGraphMetadata(metadata)).toEqual(metadata);
    invalid(() => parseGraphMetadata({ ...metadata, byteLength: L.snapshotBytes + 1 }));
    invalid(() => parseGraphMetadata({ ...metadata, diagnostics: { ...metadata.diagnostics, repeatedDeclarations: 1 } }));
    const edge = { ...makeEdge('a', 'b'), declarations: L.sourceEdges };
    const chunks = [makeChunk([makeNode('a'), makeNode('b')], [edge])];
    expect(assembleGraphSnapshot(makeMetadata(chunks), chunks).edges[0].declarations).toBe(L.sourceEdges);
    edge.declarations++;
    invalid(() => parseGraphChunk(makeChunk(chunks[0].nodes, [edge])));
  });

  it('accepts exactly 1,000 nonempty chunks and rejects a forged larger acquisition loop', () => {
    const chunks = Array.from({ length: L.chunkCount }, (_, index) => makeChunk([makeNode(`n-${index}`)], [], index));
    const metadata = makeMetadata(chunks);
    expect(assembleGraphSnapshot(metadata, chunks).nodes).toHaveLength(L.chunkCount);
    invalid(() => parseGraphMetadata({ ...metadata, chunkCount: L.chunkCount + 1 }));
  });

  it('rejects mixed identity/version, repeated, out-of-range and missing indices, and aggregate corruption', () => {
    const chunks = [makeChunk([makeNode('a')]), makeChunk([makeNode('b')], [makeEdge('a', 'b')], 1)];
    const metadata = makeMetadata(chunks);
    expect(assembleGraphSnapshot(metadata, [...chunks].reverse()).nodes.map(node => node.id)).toEqual(['a', 'b']);
    invalid(() => assembleGraphSnapshot(metadata, [chunks[0]]));
    invalid(() => assembleGraphSnapshot(metadata, [...chunks, chunks[0]]));
    invalid(() => assembleGraphSnapshot(metadata, [chunks[0], chunks[0]]));
    for (const key of Object.keys(identity)) {
      const changed = structuredClone(chunks); Object.assign(changed[1].identity, { [key]: 'different' }); seal(changed[1]);
      invalid(() => assembleGraphSnapshot(metadata, changed));
    }
    for (const index of [0, 2]) { const changed = structuredClone(chunks); changed[1].index = index; seal(changed[1]); invalid(() => assembleGraphSnapshot(makeMetadata(changed), changed)); }
    const duplicateNode = [chunks[0], makeChunk([makeNode('a')], [], 1)];
    invalid(() => assembleGraphSnapshot(makeMetadata(duplicateNode), duplicateNode));
    const duplicateEdge = [chunks[1], makeChunk([], [makeEdge('a', 'b')], 0)];
    invalid(() => assembleGraphSnapshot(makeMetadata(duplicateEdge), duplicateEdge));
    invalid(() => assembleGraphSnapshot({ ...metadata, byteLength: metadata.byteLength + 1 }, chunks));
    invalid(() => assembleGraphSnapshot({ ...metadata, coverage: { state: 'complete', counts: { ...metadata.coverage.counts!, sourceTaskRows: 3, uniqueNodes: 3 }, reasons: [] } }, chunks));
  });

  it('checks endpoint existence, explicit external scope and repeated declaration diagnostics', () => {
    const base = makeEdge('a', 'b');
    const missing = { ...base, from: { kind: 'unresolved', id: 'a', reason: 'missing' } } as GraphSourceEdge;
    const chunks = [makeChunk([makeNode('b')], [missing])];
    expect(assembleGraphSnapshot(makeMetadata(chunks), chunks).edges).toEqual([missing]);
    for (const edge of [base, { ...missing, from: { kind: 'unresolved', id: 'a', reason: 'duplicate' } }, { ...missing, from: { kind: 'unresolved', id: 'a', reason: 'source-incomplete' } }, { ...missing, from: { kind: 'unresolved', id: 'a', reason: 'external' } }]) {
      const changed = [makeChunk([makeNode('b')], [edge as GraphSourceEdge])];
      invalid(() => assembleGraphSnapshot(makeMetadata(changed), changed));
    }
    const external: GraphSourceEdge = { ...base, id: graphEdgeId('a', 'b', 'external'), scope: 'external', from: { kind: 'unresolved', id: 'a', reason: 'external' }, declarations: 3 };
    const externalChunks = [makeChunk([makeNode('a'), makeNode('b')], [external])];
    const externalMetadata = makeMetadata(externalChunks);
    expect(assembleGraphSnapshot(externalMetadata, externalChunks).edges[0].from.kind).toBe('unresolved');
    invalid(() => assembleGraphSnapshot({ ...externalMetadata, diagnostics: { ...externalMetadata.diagnostics, repeatedDeclarations: 1 } }, externalChunks));
    invalid(() => assembleGraphSnapshot({ ...externalMetadata, coverage: { state: 'complete', counts: { ...externalMetadata.coverage.counts!, unresolvedEdges: 0 }, reasons: [] } }, externalChunks));
    const falselyMissing = [makeChunk([makeNode('a'), makeNode('b')], [missing])];
    invalid(() => assembleGraphSnapshot(makeMetadata(falselyMissing), falselyMissing));
  });

  it('requires duplicate diagnostics and partial coverage, preserving proven missing versus incomplete', () => {
    const duplicate: GraphSourceEdge = { ...makeEdge('dup', 'b'), from: { kind: 'unresolved', id: 'dup', reason: 'duplicate' } };
    const missing: GraphSourceEdge = { ...makeEdge('absent', 'b'), from: { kind: 'unresolved', id: 'absent', reason: 'missing' } };
    const chunks = [makeChunk([makeNode('b')], [duplicate, missing])];
    const base = makeMetadata(chunks);
    const metadata: GraphSnapshotMetadata = { ...base, coverage: { state: 'partial', counts: { ...base.coverage.counts!, sourceTaskRows: 3 }, reasons: ['duplicate-id'] }, diagnostics: { ...base.diagnostics, duplicateIds: ['dup'] } };
    expect(assembleGraphSnapshot(metadata, chunks).nodes).toHaveLength(1);
    invalid(() => assembleGraphSnapshot({ ...metadata, diagnostics: { ...metadata.diagnostics, duplicateIds: [] } }, chunks));
    invalid(() => assembleGraphSnapshot({ ...metadata, coverage: { state: 'partial', counts: metadata.coverage.counts!, reasons: ['duplicate-id', 'incomplete-read'] } }, chunks));
    const incomplete = structuredClone(chunks); incomplete[0].edges[1].from = { kind: 'unresolved', id: 'absent', reason: 'source-incomplete' }; seal(incomplete[0]);
    const partial: GraphSnapshotMetadata = { ...metadata, byteLength: incomplete[0].byteLength, coverage: { state: 'partial', counts: metadata.coverage.counts!, reasons: ['duplicate-id', 'incomplete-read'] } };
    expect(assembleGraphSnapshot(partial, incomplete).edges).toHaveLength(2);
    const collision = [makeChunk([makeNode('b'), makeNode('dup')], [duplicate])];
    invalid(() => assembleGraphSnapshot({ ...metadata, byteLength: collision[0].byteLength, coverage: { state: 'partial', counts: { sourceTaskRows: 4, uniqueNodes: 2, uniqueEdges: 1, unresolvedEdges: 1 }, reasons: ['duplicate-id'] } }, collision));
  });

  it('validates real SCCs including self-loops and accepts order-independent diagnostics', () => {
    const nodes = ['a', 'b', 'c', 'd'].map(makeNode), edges = [makeEdge('a', 'b'), makeEdge('b', 'a'), makeEdge('c', 'c'), makeEdge('a', 'd')];
    const chunks = [makeChunk(nodes, edges)], metadata = makeMetadata(chunks);
    metadata.diagnostics.cycles = [['c'], ['b', 'a']];
    expect(assembleGraphSnapshot(metadata, chunks).nodes).toHaveLength(4);
    for (const cycles of [[], [['a', 'b']], [['a', 'b', 'c']], [['a', 'b'], ['d']], [['a', 'a']], [['a', 'b'], ['c'], ['c']], [['unknown']]]) {
      invalid(() => assembleGraphSnapshot({ ...metadata, diagnostics: { ...metadata.diagnostics, cycles } }, chunks));
    }
  });

  it.each([1001, 10000])('assembles %i source nodes iteratively, independently of display caps', count => {
    const nodes = Array.from({ length: count }, (_, i) => makeNode(`n-${i}`));
    const edges = nodes.slice(1).map((node, i) => makeEdge(nodes[i].id, node.id));
    edges.push(...Array.from({ length: 12 }, (_, i) => makeEdge(`n-${i}`, nodes[count - 1].id)));
    const chunks: GraphChunk[] = [];
    for (let start = 0; start < nodes.length; start += L.chunkNodes) chunks.push(makeChunk(nodes.slice(start, start + L.chunkNodes), [], chunks.length));
    for (let start = 0; start < edges.length; start += L.chunkEdges) chunks.push(makeChunk([], edges.slice(start, start + L.chunkEdges), chunks.length));
    const assembled = assembleGraphSnapshot(makeMetadata(chunks), chunks);
    expect(assembled.nodes).toHaveLength(count); expect(assembled.edges).toHaveLength(count + 11);
    expect(assembled.edges.filter(edge => edge.to.id === `n-${count - 1}`)).toHaveLength(13);
  });
});


describe('dependency direction source ownership',()=>{
  it.each(['external','missing','source-incomplete'] as const)('rejects a fabricated %s dependent even with matching byte/count metadata',reason=>{
    const edge:GraphSourceEdge={id:graphEdgeId('a','unseen',reason==='external'?'external':'internal'),from:{kind:'node',id:'a'},to:{kind:'unresolved',id:'unseen',reason},scope:reason==='external'?'external':'internal',declarations:1};
    const chunks=[makeChunk([makeNode('a')],[edge])];invalid(()=>assembleGraphSnapshot(makeMetadata(chunks),chunks));
  });
});
