import {
  graphEdgeId, sameGraphIdentity, TASK_GRAPH_CONTRACT_VERSION, TASK_GRAPH_LIMITS,
  type GraphChunk, type GraphChunkRequest, type GraphCounts, type GraphCoverage,
  type GraphDetailRequest, type GraphDetailResult, type GraphDetailSnapshot, type GraphReadError,
  type GraphDiagnostics, type GraphEndpoint, type GraphPartialReason, type GraphReadRequest,
  type GraphSnapshotMetadata, type GraphSourceEdge, type GraphSourceNode, type TaskGraphIdentity,
} from './task-graph-contract';

const invalid = (): never => { throw new Error('invalid graph'); };
const guarded = <T>(read: () => T): T => {
  try { return read(); } catch { return invalid(); }
};

/** Inspect descriptors before reading values. IPC types are not a trust boundary. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) return invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) return invalid();
  const size = integer(length.value, maximum);
  if (Reflect.ownKeys(value).length !== size + 1) return invalid();
  const copy: unknown[] = [];
  for (let i = 0; i < size; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    copy.push(descriptor.value);
  }
  return copy;
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) return invalid();
  return value;
}

function string(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && value.length === 0)) return invalid();
  return value;
}

const nullableString = (value: unknown, maximum: number): string | null =>
  value === null ? null : string(value, maximum, true);

function identity(value: unknown): TaskGraphIdentity {
  const data = record(value, ['projectId', 'dagId', 'sourceHash', 'sessionKey', 'revision']);
  const limit = TASK_GRAPH_LIMITS.identityCharacters;
  return { projectId: string(data.projectId, limit), dagId: string(data.dagId, limit),
    sourceHash: string(data.sourceHash, limit), sessionKey: string(data.sessionKey, limit), revision: string(data.revision, limit) };
}

export function parseGraphReadRequest(value: unknown): GraphReadRequest {
  return guarded(() => {
    const data = record(value, ['requestId', 'projectId', 'dagId', 'sessionKey', 'expectedRevision']);
    const limit = TASK_GRAPH_LIMITS.identityCharacters;
    return { requestId: string(data.requestId, TASK_GRAPH_LIMITS.idCharacters), projectId: string(data.projectId, limit),
      dagId: string(data.dagId, limit), sessionKey: string(data.sessionKey, limit),
      expectedRevision: data.expectedRevision === null ? null : string(data.expectedRevision, limit) };
  });
}

export function parseGraphSessionRequest(value: unknown): { projectId: string } {
  return guarded(() => ({ projectId: string(record(value, ['projectId']).projectId, TASK_GRAPH_LIMITS.identityCharacters) }));
}

export function parseGraphChunkRequest(value: unknown): GraphChunkRequest {
  return guarded(() => {
    const data = record(value, ['requestId', 'identity', 'index']);
    return { requestId: string(data.requestId, TASK_GRAPH_LIMITS.idCharacters), identity: identity(data.identity),
      index: integer(data.index, TASK_GRAPH_LIMITS.chunkCount - 1) };
  });
}

export function parseGraphDetailRequest(value: unknown): GraphDetailRequest {
  return guarded(() => {
    const data = record(value, ['requestId', 'identity', 'taskId']);
    return { requestId: string(data.requestId, TASK_GRAPH_LIMITS.idCharacters), identity: identity(data.identity),
      taskId: string(data.taskId, TASK_GRAPH_LIMITS.idCharacters) };
  });
}

export function parseGraphCancelRequest(value: unknown): string {
  return guarded(() => string(record(value, ['requestId']).requestId, TASK_GRAPH_LIMITS.idCharacters));
}

/** UTF-8 bytes of the complete JSON wire value, including byteLength itself. */
export function graphEncodedBytes(value: unknown): number {
  return guarded(() => {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') return invalid();
    return new TextEncoder().encode(encoded).byteLength;
  });
}

function node(value: unknown): GraphSourceNode {
  const data = record(value, ['id', 'title', 'declaredStatus', 'phase']);
  let phase: GraphSourceNode['phase'] = null;
  if (data.phase !== null) {
    const part = record(data.phase, ['id', 'title', 'index']);
    phase = { id: nullableString(part.id, TASK_GRAPH_LIMITS.idCharacters),
      title: nullableString(part.title, TASK_GRAPH_LIMITS.titleCharacters), index: integer(part.index) };
  }
  return { id: string(data.id, TASK_GRAPH_LIMITS.idCharacters), title: nullableString(data.title, TASK_GRAPH_LIMITS.titleCharacters),
    declaredStatus: nullableString(data.declaredStatus, TASK_GRAPH_LIMITS.statusCharacters), phase };
}

function endpoint(value: unknown): GraphEndpoint {
  // Descriptor-only discriminator inspection avoids invoking a malicious getter.
  if (value === null || typeof value !== 'object') return invalid();
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kind || !('value' in kind)) return invalid();
  if (kind.value === 'node') {
    const data = record(value, ['kind', 'id']);
    return { kind: 'node', id: string(data.id, TASK_GRAPH_LIMITS.idCharacters) };
  }
  const data = record(value, ['kind', 'id', 'reason']);
  if (data.kind !== 'unresolved' || !['missing', 'duplicate', 'external', 'source-incomplete'].includes(data.reason as string)) return invalid();
  return { kind: 'unresolved', id: string(data.id, TASK_GRAPH_LIMITS.idCharacters), reason: data.reason as Extract<GraphEndpoint, { kind: 'unresolved' }>['reason'] };
}

function edge(value: unknown): GraphSourceEdge {
  const data = record(value, ['id', 'from', 'to', 'scope', 'declarations']);
  if (data.scope !== 'internal' && data.scope !== 'external') return invalid();
  const from = endpoint(data.from), to = endpoint(data.to);
  // A dependency declaration belongs to a source task. Only ambiguous duplicate
  // source IDs may prevent resolving the dependent; external refers to predecessor.
  if (to.kind === 'unresolved' && to.reason !== 'duplicate') return invalid();
  if ((data.scope === 'external') !== (from.kind === 'unresolved' && from.reason === 'external')) return invalid();
  if (data.id !== graphEdgeId(from.id, to.id, data.scope)) return invalid();
  const declarations = integer(data.declarations, TASK_GRAPH_LIMITS.sourceEdges);
  if (declarations === 0) return invalid();
  return { id: data.id as string, from, to, scope: data.scope, declarations };
}

function counts(value: unknown): GraphCounts {
  const data = record(value, ['sourceTaskRows', 'uniqueNodes', 'uniqueEdges', 'unresolvedEdges']);
  const parsed = { sourceTaskRows: data.sourceTaskRows === null ? null : integer(data.sourceTaskRows),
    uniqueNodes: integer(data.uniqueNodes, TASK_GRAPH_LIMITS.sourceNodes),
    uniqueEdges: integer(data.uniqueEdges, TASK_GRAPH_LIMITS.sourceEdges),
    unresolvedEdges: integer(data.unresolvedEdges, TASK_GRAPH_LIMITS.sourceEdges) };
  if (parsed.unresolvedEdges > parsed.uniqueEdges || (parsed.sourceTaskRows !== null && parsed.sourceTaskRows < parsed.uniqueNodes)) return invalid();
  return parsed;
}

const partialReasons: readonly GraphPartialReason[] = ['node-limit', 'edge-limit', 'byte-limit', 'incomplete-read', 'duplicate-id', 'malformed-source'];
function coverage(value: unknown): GraphCoverage {
  const data = record(value, ['state', 'counts', 'reasons']);
  if (data.state === 'unknown') {
    const reasons = array(data.reasons, 1);
    if (data.counts !== null || reasons.length !== 1 || reasons[0] !== 'not-read') return invalid();
    return { state: 'unknown', counts: null, reasons: ['not-read'] };
  }
  const parsed = counts(data.counts);
  if (data.state === 'complete') {
    if (array(data.reasons, 0).length || parsed.sourceTaskRows === null || parsed.sourceTaskRows !== parsed.uniqueNodes) return invalid();
    return { state: 'complete', counts: { ...parsed, sourceTaskRows: parsed.sourceTaskRows }, reasons: [] };
  }
  if (data.state !== 'partial') return invalid();
  const reasons = array(data.reasons, partialReasons.length).map(reason => {
    if (!partialReasons.includes(reason as GraphPartialReason)) return invalid();
    return reason as GraphPartialReason;
  });
  if (!reasons.length || new Set(reasons).size !== reasons.length) return invalid();
  return { state: 'partial', counts: parsed, reasons };
}

function diagnostics(value: unknown): GraphDiagnostics {
  const data = record(value, ['duplicateIds', 'cycles', 'repeatedDeclarations']);
  const duplicateIds = array(data.duplicateIds, TASK_GRAPH_LIMITS.sourceNodes).map(id => string(id, TASK_GRAPH_LIMITS.idCharacters));
  if (new Set(duplicateIds).size !== duplicateIds.length) return invalid();
  const members = new Set<string>();
  const cycles = array(data.cycles, TASK_GRAPH_LIMITS.sourceNodes).map(cycle => {
    const ids = array(cycle, TASK_GRAPH_LIMITS.sourceNodes).map(id => string(id, TASK_GRAPH_LIMITS.idCharacters));
    if (!ids.length || members.size + ids.length > TASK_GRAPH_LIMITS.sourceNodes) return invalid();
    for (const id of ids) { if (members.has(id)) return invalid(); members.add(id); }
    return ids;
  });
  return { duplicateIds, cycles, repeatedDeclarations: integer(data.repeatedDeclarations, TASK_GRAPH_LIMITS.sourceEdges) };
}

function metadata(value: unknown): GraphSnapshotMetadata {
  const data = record(value, ['contractVersion', 'identity', 'observedAt', 'coverage', 'diagnostics', 'chunkCount', 'byteLength']);
  if (data.contractVersion !== TASK_GRAPH_CONTRACT_VERSION) return invalid();
  const observedAt = string(data.observedAt, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt)) return invalid();
  const date = new Date(observedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/\.\d{3}Z$/, 'Z') !== observedAt.replace(/\.\d{1,3}Z$/, 'Z')) return invalid();
  const parsed: GraphSnapshotMetadata = { contractVersion: TASK_GRAPH_CONTRACT_VERSION,
    identity: identity(data.identity), observedAt, coverage: coverage(data.coverage), diagnostics: diagnostics(data.diagnostics),
    chunkCount: integer(data.chunkCount, TASK_GRAPH_LIMITS.chunkCount), byteLength: integer(data.byteLength, TASK_GRAPH_LIMITS.snapshotBytes) };
  const { coverage: source, diagnostics: detail, chunkCount, byteLength } = parsed;
  if ((chunkCount === 0) !== (byteLength === 0) || byteLength < chunkCount || byteLength > chunkCount * TASK_GRAPH_LIMITS.chunkBytes) return invalid();
  if (source.state === 'unknown') {
    if (chunkCount || byteLength || detail.duplicateIds.length || detail.cycles.length || detail.repeatedDeclarations) return invalid();
  } else {
    const { uniqueNodes, uniqueEdges, sourceTaskRows } = source.counts;
    if (chunkCount < Math.max(Math.ceil(uniqueNodes / TASK_GRAPH_LIMITS.chunkNodes), Math.ceil(uniqueEdges / TASK_GRAPH_LIMITS.chunkEdges))
      || chunkCount > uniqueNodes + uniqueEdges) return invalid();
    if ((source.state === 'partial' && source.reasons.includes('duplicate-id')) !== (detail.duplicateIds.length > 0)) return invalid();
    if (sourceTaskRows !== null && sourceTaskRows < uniqueNodes + 2 * detail.duplicateIds.length) return invalid();
    if (detail.cycles.reduce((sum, cycle) => sum + cycle.length, 0) > uniqueNodes) return invalid();
    if (!uniqueEdges && (detail.cycles.length || detail.repeatedDeclarations)) return invalid();
    if (uniqueEdges + detail.repeatedDeclarations > TASK_GRAPH_LIMITS.sourceEdges) return invalid();
  }
  if (graphEncodedBytes(parsed) > TASK_GRAPH_LIMITS.chunkBytes) return invalid();
  return parsed;
}

export function parseGraphMetadata(value: unknown): GraphSnapshotMetadata { return guarded(() => metadata(value)); }

function chunk(value: unknown): GraphChunk {
  const data = record(value, ['contractVersion', 'identity', 'index', 'nodes', 'edges', 'byteLength']);
  if (data.contractVersion !== TASK_GRAPH_CONTRACT_VERSION) return invalid();
  const parsed: GraphChunk = { contractVersion: TASK_GRAPH_CONTRACT_VERSION, identity: identity(data.identity),
    index: integer(data.index, TASK_GRAPH_LIMITS.chunkCount - 1),
    nodes: array(data.nodes, TASK_GRAPH_LIMITS.chunkNodes).map(node),
    edges: array(data.edges, TASK_GRAPH_LIMITS.chunkEdges).map(edge), byteLength: integer(data.byteLength, TASK_GRAPH_LIMITS.chunkBytes) };
  if (!parsed.nodes.length && !parsed.edges.length) return invalid();
  if (new Set(parsed.nodes.map(node => node.id)).size !== parsed.nodes.length || new Set(parsed.edges.map(edge => edge.id)).size !== parsed.edges.length) return invalid();
  if (graphEncodedBytes(parsed) !== parsed.byteLength) return invalid();
  return parsed;
}

export function parseGraphChunk(value: unknown): GraphChunk { return guarded(() => chunk(value)); }

/** Iterative Kosaraju: bounded stack even for a full-source chain. */
function cyclesFor(nodes: readonly GraphSourceNode[], edges: readonly GraphSourceEdge[]): string[][] {
  const forward = new Map(nodes.map(node => [node.id, [] as string[]]));
  const reverse = new Map(nodes.map(node => [node.id, [] as string[]]));
  const selfLoops = new Set<string>();
  for (const edge of edges) if (edge.from.kind === 'node' && edge.to.kind === 'node') {
    forward.get(edge.from.id)!.push(edge.to.id); reverse.get(edge.to.id)!.push(edge.from.id);
    if (edge.from.id === edge.to.id) selfLoops.add(edge.from.id);
  }
  const visited = new Set<string>(), order: string[] = [];
  for (const { id } of nodes) {
    if (visited.has(id)) continue;
    visited.add(id);
    const stack = [{ id, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1], neighbors = forward.get(frame.id)!;
      if (frame.next === neighbors.length) { order.push(frame.id); stack.pop(); continue; }
      const next = neighbors[frame.next++];
      if (!visited.has(next)) { visited.add(next); stack.push({ id: next, next: 0 }); }
    }
  }
  visited.clear();
  const cycles: string[][] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (visited.has(id)) continue;
    const members: string[] = [], stack = [id]; visited.add(id);
    while (stack.length) {
      const current = stack.pop()!; members.push(current);
      for (const next of reverse.get(current)!) if (!visited.has(next)) { visited.add(next); stack.push(next); }
    }
    if (members.length > 1 || selfLoops.has(id)) cycles.push(members);
  }
  return cycles;
}

export interface AssembledGraphSnapshot {
  metadata: GraphSnapshotMetadata;
  nodes: readonly GraphSourceNode[];
  edges: readonly GraphSourceEdge[];
}

/** Validate all chunks before exposing any assembled adjacency to a renderer. */
export function assembleGraphSnapshot(metadataValue: unknown, chunksValue: unknown): AssembledGraphSnapshot {
  return guarded(() => {
    const parsedMetadata = metadata(metadataValue);
    const supplied = array(chunksValue, parsedMetadata.chunkCount);
    if (supplied.length !== parsedMetadata.chunkCount) return invalid();
    const indices = new Set<number>(), nodeIds = new Set<string>(), edgeIds = new Set<string>();
    const ordered = new Array<GraphChunk>(parsedMetadata.chunkCount);
    let bytes = 0, nodeCount = 0, edgeCount = 0;
    for (const value of supplied) {
      const parsed = chunk(value);
      if (!sameGraphIdentity(parsedMetadata.identity, parsed.identity) || parsed.index >= supplied.length || indices.has(parsed.index)) return invalid();
      indices.add(parsed.index); ordered[parsed.index] = parsed;
      bytes += parsed.byteLength; nodeCount += parsed.nodes.length; edgeCount += parsed.edges.length;
      if (bytes > TASK_GRAPH_LIMITS.snapshotBytes || nodeCount > TASK_GRAPH_LIMITS.sourceNodes || edgeCount > TASK_GRAPH_LIMITS.sourceEdges) return invalid();
      for (const node of parsed.nodes) { if (nodeIds.has(node.id)) return invalid(); nodeIds.add(node.id); }
      for (const edge of parsed.edges) { if (edgeIds.has(edge.id)) return invalid(); edgeIds.add(edge.id); }
    }
    if (bytes !== parsedMetadata.byteLength) return invalid();
    const nodes = ordered.flatMap(chunk => chunk.nodes), edges = ordered.flatMap(chunk => chunk.edges);
    const source = parsedMetadata.coverage, detail = parsedMetadata.diagnostics;
    if (source.state === 'unknown') return { metadata: parsedMetadata, nodes, edges };
    if (nodeCount !== source.counts.uniqueNodes || edgeCount !== source.counts.uniqueEdges) return invalid();
    const duplicates = new Set(detail.duplicateIds);
    for (const id of duplicates) if (nodeIds.has(id)) return invalid();
    const incomplete = source.state === 'partial' && source.reasons.some(reason => reason !== 'duplicate-id');
    let unresolved = 0, repeated = 0;
    for (const edge of edges) {
      const endpoints = [edge.from, edge.to];
      const external = endpoints.some(endpoint => endpoint.kind === 'unresolved' && endpoint.reason === 'external');
      if ((edge.scope === 'external') !== external) return invalid();
      for (const endpoint of endpoints) {
        if (endpoint.kind === 'node') { if (!nodeIds.has(endpoint.id) || duplicates.has(endpoint.id)) return invalid(); }
        else if (endpoint.reason === 'external') { /* Separate namespace, including equal internal IDs. */ }
        else if (endpoint.reason === 'duplicate') { if (!duplicates.has(endpoint.id) || nodeIds.has(endpoint.id)) return invalid(); }
        else {
          if (nodeIds.has(endpoint.id) || duplicates.has(endpoint.id)) return invalid();
          if ((endpoint.reason === 'source-incomplete') !== incomplete) return invalid();
        }
      }
      if (endpoints.some(endpoint => endpoint.kind === 'unresolved')) unresolved++;
      repeated += edge.declarations - 1;
      if (!Number.isSafeInteger(repeated) || repeated + edgeCount > TASK_GRAPH_LIMITS.sourceEdges) return invalid();
    }
    if (unresolved !== source.counts.unresolvedEdges || repeated !== detail.repeatedDeclarations) return invalid();
    const cycleKey = (cycles: readonly (readonly string[])[]) => cycles.map(ids => JSON.stringify([...ids].sort())).sort();
    if (JSON.stringify(cycleKey(cyclesFor(nodes, edges))) !== JSON.stringify(cycleKey(detail.cycles))) return invalid();
    return { metadata: parsedMetadata, nodes, edges };
  });
}


/** Strict one-task detail decoder. Descriptor inspection precedes every value read.
 * Bounded JSON policies are declarations only; they grant no additional capability. */
export function parseGraphDetailResult(value: unknown): GraphDetailResult {
  return guarded(() => {
    if (value === null || typeof value !== 'object') return invalid();
    const state = Object.getOwnPropertyDescriptor(value, 'state');
    if (!state || !('value' in state)) return invalid();
    if (state.value === 'unavailable') {
      const data = record(value, ['state', 'requestId', 'reason']);
      const reasons: readonly GraphReadError[] = ['invalid-request', 'disconnected', 'unauthorized', 'source-unavailable',
        'source-changed', 'stale-session', 'cancelled', 'timeout', 'invalid-schema', 'unsupported'];
      if (!reasons.includes(data.reason as GraphReadError)) return invalid();
      return { state: 'unavailable', requestId: string(data.requestId, TASK_GRAPH_LIMITS.idCharacters, true), reason: data.reason as GraphReadError };
    }
    const data = record(value, ['state', 'requestId', 'identity', 'observedAt', 'task', 'policies']);
    if (data.state !== 'detail') return invalid();
    let characters = 0;
    const text = (value: unknown, max: number = TASK_GRAPH_LIMITS.detailTextCharacters, empty = true): string => {
      const result = string(value, max, empty);
      characters += result.length;
      if (characters > TASK_GRAPH_LIMITS.detailBytes) return invalid();
      return result;
    };
    const nullableText = (value: unknown): string | null => value === null ? null : text(value);
    const references = (value: unknown, max: number = TASK_GRAPH_LIMITS.detailReferences, empty = false): string[] => array(value, max).map(item => text(item, TASK_GRAPH_LIMITS.detailTextCharacters, empty));
    const raw = record(data.task, ['id', 'title', 'status', 'rawType', 'rawFeature', 'phase', 'details', 'dependencies',
      'e2e', 'commitReferences', 'commitReferencesUnsupported', 'commitVerification', 'displayOmissions']);
    const sourceNode = node({ id: raw.id, title: raw.title, declaredStatus: raw.status, phase: raw.phase });
    const detail = record(raw.details, ['description', 'acceptanceCriteria', 'targetFiles', 'discussion', 'design', 'omissions']);
    const e2e = record(raw.e2e, ['state', 'required', 'coveredBy', 'coverage']);
    if (!['undeclared', 'declared'].includes(e2e.state as string) || e2e.required !== null && typeof e2e.required !== 'boolean'
      || !['undeclared', 'not-required', 'unmet', 'references-declared', 'malformed'].includes(e2e.coverage as string)
      || raw.commitVerification !== 'not-performed') return invalid();
    const omissions = record(raw.displayOmissions, ['dependencies', 'commitReferences', 'e2eReferences']);
    if (omissions.dependencies !== 0 || omissions.commitReferences !== 0 || omissions.e2eReferences !== 0) return invalid();
    const task: GraphDetailSnapshot['task'] = {
      id: sourceNode.id, title: sourceNode.title, status: sourceNode.declaredStatus, phase: sourceNode.phase,
      rawType: nullableText(raw.rawType), rawFeature: nullableText(raw.rawFeature),
      details: { description: nullableText(detail.description), acceptanceCriteria: references(detail.acceptanceCriteria, 40, true),
        targetFiles: references(detail.targetFiles, 40, true), discussion: references(detail.discussion, 40, true),
        design: references(detail.design, 40, true), omissions: integer(detail.omissions) },
      dependencies: array(raw.dependencies, TASK_GRAPH_LIMITS.detailReferences).map(value => {
        const dependency = record(value, ['id', 'scope']);
        if (dependency.scope !== 'internal' && dependency.scope !== 'external') return invalid();
        return { id: text(dependency.id, TASK_GRAPH_LIMITS.idCharacters, false), scope: dependency.scope };
      }),
      e2e: { state: e2e.state as GraphDetailSnapshot['task']['e2e']['state'], required: e2e.required as boolean | null,
        coveredBy: e2e.coveredBy === null ? null : references(e2e.coveredBy),
        coverage: e2e.coverage as GraphDetailSnapshot['task']['e2e']['coverage'] },
      commitReferences: references(raw.commitReferences), commitReferencesUnsupported: integer(raw.commitReferencesUnsupported, TASK_GRAPH_LIMITS.detailReferences),
      commitVerification: 'not-performed', displayOmissions: { dependencies: 0, commitReferences: 0, e2eReferences: 0 },
    };
    if (task.commitReferences.length + task.commitReferencesUnsupported! > TASK_GRAPH_LIMITS.detailReferences) return invalid();
    if (task.e2e.state === 'undeclared' && (task.e2e.required !== null || task.e2e.coveredBy !== null || task.e2e.coverage !== 'undeclared')) return invalid();
    if (task.e2e.state === 'declared' && (task.e2e.coverage === 'undeclared'
      || task.e2e.coverage === 'not-required' && task.e2e.required !== false
      || task.e2e.coverage === 'unmet' && (task.e2e.required !== true || !!task.e2e.coveredBy?.length)
      || task.e2e.coverage === 'references-declared' && (task.e2e.required !== true || !task.e2e.coveredBy?.length))) return invalid();
    let values = 0;
    const json = (value: unknown, depth: number): unknown => {
      if (++values > TASK_GRAPH_LIMITS.detailPolicyValues || depth > TASK_GRAPH_LIMITS.detailPolicyDepth) return invalid();
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
      if (typeof value === 'string') return text(value, 32_768);
      if (Array.isArray(value)) return array(value, TASK_GRAPH_LIMITS.detailPolicyValues).map(item => json(item, depth + 1));
      if (typeof value !== 'object') return invalid();
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return invalid();
      const keys = Reflect.ownKeys(value);
      if (keys.length > TASK_GRAPH_LIMITS.detailPolicyValues) return invalid();
      const copy: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== 'string') return invalid();
        text(key, 32_768);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
        copy[key] = json(descriptor.value, depth + 1);
      }
      return copy;
    };
    const policies = array(data.policies, TASK_GRAPH_LIMITS.detailPolicies).map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
      return json(value, 0) as Record<string, unknown>;
    });
    const observedAt = string(data.observedAt, 32);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt)
      || !Number.isFinite(new Date(observedAt).getTime())
      || new Date(observedAt).toISOString().replace(/\.\d{3}Z$/, 'Z') !== observedAt.replace(/\.\d{1,3}Z$/, 'Z')) return invalid();
    const result: GraphDetailSnapshot = { state: 'detail', requestId: string(data.requestId, TASK_GRAPH_LIMITS.idCharacters),
      identity: identity(data.identity), observedAt, task, policies };
    if (graphEncodedBytes(result) > TASK_GRAPH_LIMITS.detailBytes) return invalid();
    return result;
  });
}
