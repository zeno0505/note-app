import {
  graphGroupKey, sameGraphIdentity, TASK_GRAPH_LIMITS, type TaskGraphBridge, type TaskGraphIdentity,
} from '../shared/task-graph-contract';
import { GRAPH_LAYOUT_VERSION, type GraphLayout, type GraphLayoutOptions } from '../shared/task-graph-layout';
import { parseGraphMetadata, type AssembledGraphSnapshot } from '../shared/task-graph-transport';
import { createTaskGraphClient } from './task-graph-client';
import type { TaskGraphLayoutRequest } from './task-graph-layout-worker';

/** Small injectable surface: tests do not need a DOM or a real Web Worker. */
export interface TaskGraphLayoutWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(request: TaskGraphLayoutRequest): void;
  terminate(): void;
}
export interface TaskGraphLayoutClientOptions {
  workerFactory?: () => TaskGraphLayoutWorker;
  /** Must inspect current authority/revision, not just echo the supplied value.
   * Runs before dispatch and again after layout, within the same deadline. */
  getCurrentIdentity: (expected: TaskGraphIdentity, signal: AbortSignal) => TaskGraphIdentity | null | Promise<TaskGraphIdentity | null>;
  timeoutMs?: number;
}
export type TaskGraphLayoutRunOptions = GraphLayoutOptions & { signal?: AbortSignal };

/** Vite recognizes this literal URL and emits a separate production worker. */
export function createTaskGraphLayoutWorker(): TaskGraphLayoutWorker {
  return new Worker(new URL('./task-graph-layout-worker.ts', import.meta.url), { type: 'module' });
}
const errorCodes = new Set(['cancelled', 'timeout', 'background', 'disposed', 'stale-session',
  'source-changed', 'source-unavailable', 'unauthorized', 'disconnected', 'unsupported',
  'invalid-request', 'invalid-schema', 'invalid-result', 'worker-unavailable', 'layout-failed']);
const boundedError = (error: unknown, fallback = 'layout-failed') =>
  Error(error instanceof Error && errorCodes.has(error.message) ? error.message : fallback);

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
function identityValue(value: unknown): TaskGraphIdentity | null {
  const data = dataRecord(value), keys = ['projectId', 'dagId', 'sourceHash', 'sessionKey', 'revision'];
  if (!data || Object.keys(data).length !== keys.length || keys.some(key => typeof data[key] !== 'string'
    || !(data[key] as string).length || (data[key] as string).length > TASK_GRAPH_LIMITS.identityCharacters)) return null;
  return data as unknown as TaskGraphIdentity;
}
function matchingIdentity(value: unknown, expected: TaskGraphIdentity): boolean {
  const parsed = identityValue(value);
  return parsed !== null && sameGraphIdentity(parsed, expected);
}
function invalidResult(): never { throw Error('invalid-result'); }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const data = dataRecord(value);
  if (!data || Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return invalidResult();
  return data;
}
function* arrayValue(value: unknown, maximum: number): Generator<void, unknown[], void> {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) return invalidResult();
  for (let i = 0; i < value.length; i++) {
    if (i % 128 === 0) yield;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalidResult();
  }
  return value;
}
function mapValue(value: unknown, size: number): Map<unknown, unknown> {
  if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype
    || Reflect.ownKeys(value).length || value.size !== size) return invalidResult();
  return value;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown, maximum: number): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function rectangle(value: Record<string, unknown>) {
  if (!finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height)
    || value.width < 0 || value.height < 0) invalidResult();
}

/** Linear bounded validation of the worker's derived data. Geometry is not
 * recomputed here. Exact coverage and alias checks prevent a well-correlated but
 * truncated/malformed result from replacing a valid complete source. */
function* validateLayout(value: unknown, request: TaskGraphLayoutRequest, expected: TaskGraphIdentity): Generator<void, GraphLayout, void> {
  const layout = exactRecord(value, ['version', 'identity', 'grouping', 'groupKey', 'nodes', 'edges', 'width', 'height',
    'columns', 'positionById', 'cycles', 'sourceCycles', 'routeIndex', 'groups', 'groupLinks', 'index']);
  if (!matchingIdentity(layout.identity, expected) || layout.version !== GRAPH_LAYOUT_VERSION
    || layout.grouping !== request.options.grouping || layout.groupKey !== request.options.groupKey
    || !finite(layout.width) || layout.width < 0 || !finite(layout.height) || layout.height < 0) return invalidResult();
  const source = request.snapshot, nodeLimit = TASK_GRAPH_LIMITS.sourceNodes, edgeLimit = TASK_GRAPH_LIMITS.sourceEdges;
  const nodes = yield* arrayValue(layout.nodes, nodeLimit), edges = yield* arrayValue(layout.edges, edgeLimit);
  const index = exactRecord(layout.index, ['nodeById', 'edgeById', 'incoming', 'outgoing', 'groupById']);
  const nodeById = mapValue(index.nodeById, source.nodes.length), edgeById = mapValue(index.edgeById, source.edges.length);
  const incoming = mapValue(index.incoming, source.nodes.length), outgoing = mapValue(index.outgoing, source.nodes.length);
  const groupById = mapValue(index.groupById, source.nodes.length), positions = mapValue(layout.positionById, nodes.length);
  const selected = new Set<string>(), expectedEdges = new Map<string, typeof source.edges[number]>();
  const incomingCounts = new Map<string, number>(), outgoingCounts = new Map<string, number>();
  const groups = new Map<string, { nodes: number; internal: number; statuses: Map<string | null, number> }>();
  const links = new Map<string, number>();
  for (const node of source.nodes) {
    yield;
    const entry = exactRecord(nodeById.get(node.id), ['id', 'title', 'declaredStatus', 'phase']);
    if (entry.id !== node.id || entry.title !== node.title || entry.declaredStatus !== node.declaredStatus) return invalidResult();
    if (node.phase === null) { if (entry.phase !== null) return invalidResult(); }
    else {
      const phase = exactRecord(entry.phase, ['id', 'title', 'index']);
      if (phase.id !== node.phase.id || phase.title !== node.phase.title || phase.index !== node.phase.index) return invalidResult();
    }
    const key = graphGroupKey(node, request.options.grouping);
    if (groupById.get(node.id) !== key) return invalidResult();
    if (request.options.groupKey === null || request.options.groupKey === key) selected.add(node.id);
    incomingCounts.set(node.id, 0); outgoingCounts.set(node.id, 0);
    const group = groups.get(key) ?? { nodes: 0, internal: 0, statuses: new Map<string | null, number>() };
    group.nodes++; group.statuses.set(node.declaredStatus, (group.statuses.get(node.declaredStatus) ?? 0) + 1); groups.set(key, group);
  }
  for (const edge of source.edges) {
    yield;
    const entry = exactRecord(edgeById.get(edge.id), ['id', 'from', 'to', 'scope', 'declarations']);
    if (entry.id !== edge.id || entry.scope !== edge.scope || entry.declarations !== edge.declarations) return invalidResult();
    for (const side of ['from', 'to'] as const) {
    yield;
      const endpoint = edge[side], parsed = exactRecord(entry[side], endpoint.kind === 'node' ? ['kind', 'id'] : ['kind', 'id', 'reason']);
      if (parsed.kind !== endpoint.kind || parsed.id !== endpoint.id || endpoint.kind === 'unresolved' && parsed.reason !== endpoint.reason) return invalidResult();
      if (endpoint.kind === 'node') {
        const counts = side === 'from' ? outgoingCounts : incomingCounts;
        counts.set(endpoint.id, counts.get(endpoint.id)! + 1);
      }
    }
    if (edge.from.kind === 'node' && edge.to.kind === 'node') {
      if (selected.has(edge.from.id) && selected.has(edge.to.id)) expectedEdges.set(edge.id, edge);
      const from = groupById.get(edge.from.id) as string, to = groupById.get(edge.to.id) as string;
      if (from === to) groups.get(from)!.internal++;
      else { const key = JSON.stringify([from, to]); links.set(key, (links.get(key) ?? 0) + 1); }
    }
  }
  for (const node of source.nodes) for (const [adjacency, counts, side] of [
    [incoming, incomingCounts, 'to'], [outgoing, outgoingCounts, 'from'],
  ] as const) {
    yield;
    const ids = yield* arrayValue(adjacency.get(node.id), edgeLimit), seen = new Set<unknown>();
    if (ids.length !== counts.get(node.id)) return invalidResult();
    for (const id of ids) {
    yield;
      if (typeof id !== 'string' || seen.has(id)) return invalidResult(); seen.add(id);
      const edge = edgeById.get(id) as typeof source.edges[number] | undefined;
      if (!edge || edge[side].kind !== 'node' || edge[side].id !== node.id) return invalidResult();
    }
  }
  if (nodes.length !== selected.size || edges.length !== expectedEdges.size) return invalidResult();
  const nodeIds = new Set<string>(), cyclic = new Set<string>();
  for (const item of nodes) {
    yield;
    const node = exactRecord(item, ['id', 'x', 'y', 'width', 'height', 'depth', 'row', 'cycle', 'component']);
    if (typeof node.id !== 'string' || !selected.has(node.id) || nodeIds.has(node.id) || positions.get(node.id) !== item
      || !integer(node.depth, nodeLimit - 1) || !integer(node.row, nodeLimit - 1) || !integer(node.component, nodeLimit - 1)
      || typeof node.cycle !== 'boolean') return invalidResult();
    rectangle(node);
    if ((node.width as number) <= 0 || (node.height as number) <= 0 || (node.x as number) < 0 || (node.y as number) < 0
      || (node.x as number) + (node.width as number) > layout.width || (node.y as number) + (node.height as number) > layout.height) return invalidResult();
    nodeIds.add(node.id); if (node.cycle) cyclic.add(node.id);
  }
  const columnNodes = new Set<string>(); let lastDepth = -1;
  for (const item of (yield* arrayValue(layout.columns, nodes.length))) {
    yield;
    const column = exactRecord(item, ['depth', 'x', 'nodes']);
    if (!integer(column.depth, nodeLimit - 1) || column.depth <= lastDepth || !finite(column.x)) return invalidResult();
    lastDepth = column.depth; let lastRow = -1;
    const entries = yield* arrayValue(column.nodes, nodes.length);
    if (!entries.length) return invalidResult();
    for (const item of entries) {
    yield;
      const node = item as typeof source.nodes[number] & { x: number; depth: number; row: number };
      if (!node || typeof node.id !== 'string' || positions.get(node.id) !== node || columnNodes.has(node.id)
        || node.depth !== column.depth || node.x !== column.x || node.row <= lastRow) return invalidResult();
      columnNodes.add(node.id); lastRow = node.row;
    }
  }
  if (columnNodes.size !== nodes.length) return invalidResult();
  const cycleMembers = new Set<string>();
  for (const item of (yield* arrayValue(layout.cycles, nodes.length))) {
    yield;
    const members = yield* arrayValue(item, nodes.length); if (!members.length) return invalidResult();
    for (const id of members) {
    yield;
      if (typeof id !== 'string' || !cyclic.has(id) || cycleMembers.has(id)) return invalidResult(); cycleMembers.add(id);
    }
  }
  const sourceCycles = yield* arrayValue(layout.sourceCycles, nodeLimit);
  if (sourceCycles.length !== source.metadata.diagnostics.cycles.length) return invalidResult();
  for (let i = 0; i < sourceCycles.length; i++) {
    yield;
    const members = yield* arrayValue(sourceCycles[i], nodeLimit), expectedMembers = source.metadata.diagnostics.cycles[i];
    if (members.length !== expectedMembers.length || members.some((id, j) => id !== expectedMembers[j])) return invalidResult();
    for (const id of expectedMembers) if (selected.has(id)) {
      if (!cyclic.has(id)) return invalidResult(); cycleMembers.add(id);
    }
  }
  if (cycleMembers.size !== cyclic.size) return invalidResult();
  const edgeIds = new Set<string>(), routesById = new Map<string, unknown>();
  for (const item of edges) {
    yield;
    const route = exactRecord(item, ['id', 'from', 'to', 'cycle', 'points', 'bounds']);
    if (typeof route.id !== 'string' || edgeIds.has(route.id)) return invalidResult();
    const edge = expectedEdges.get(route.id);
    if (!edge || route.from !== edge.from.id || route.to !== edge.to.id || typeof route.cycle !== 'boolean') return invalidResult();
    edgeIds.add(route.id); routesById.set(route.id, item);
    const points = yield* arrayValue(route.points, 6); if (points.length < 2) return invalidResult();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of points) {
    yield;
      const point = exactRecord(item, ['x', 'y']); if (!finite(point.x) || !finite(point.y)) return invalidResult();
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    const bounds = exactRecord(route.bounds, ['x', 'y', 'width', 'height']); rectangle(bounds);
    if (bounds.x !== minX || bounds.y !== minY || bounds.width !== maxX - minX || bounds.height !== maxY - minY) return invalidResult();
  }
  if ((layout.routeIndex === null) !== (edges.length === 0)) return invalidResult();
  const branches: { value: unknown; parent: Record<string, unknown> | null }[] =
    layout.routeIndex === null ? [] : [{ value: layout.routeIndex, parent: null }];
  const seenBranches = new Set<unknown>(), indexedRoutes = new Set<string>();
  while (branches.length) {
    yield;
    const next = branches.pop()!;
    if (seenBranches.has(next.value) || seenBranches.size >= 2 * edges.length) return invalidResult();
    seenBranches.add(next.value);
    const data = dataRecord(next.value); if (!data) return invalidResult();
    const leaf = Object.hasOwn(data, 'routes');
    const branch = exactRecord(next.value, leaf ? ['bounds', 'routes'] : ['bounds', 'left', 'right']);
    const bounds = exactRecord(branch.bounds, ['x', 'y', 'width', 'height']); rectangle(bounds);
    const contained = (child: Record<string, unknown>, parent: Record<string, unknown>) =>
      (child.x as number) >= (parent.x as number) - 1e-7 && (child.y as number) >= (parent.y as number) - 1e-7
      && (child.x as number) + (child.width as number) <= (parent.x as number) + (parent.width as number) + 1e-7
      && (child.y as number) + (child.height as number) <= (parent.y as number) + (parent.height as number) + 1e-7;
    if (next.parent && !contained(bounds, next.parent)) return invalidResult();
    if (leaf) {
      const routes = yield* arrayValue(branch.routes, 16); if (!routes.length) return invalidResult();
      for (const route of routes) {
    yield;
        const entry = dataRecord(route);
        if (!entry || typeof entry.id !== 'string' || routesById.get(entry.id) !== route || indexedRoutes.has(entry.id)
          || !contained(entry.bounds as Record<string, unknown>, bounds)) return invalidResult();
        indexedRoutes.add(entry.id);
      }
    } else {
      branches.push({ value: branch.left, parent: bounds }, { value: branch.right, parent: bounds });
    }
  }
  if (indexedRoutes.size !== edges.length) return invalidResult();
  const summaries = yield* arrayValue(layout.groups, source.nodes.length), groupKeys = new Set<string>();
  if (summaries.length !== groups.size) return invalidResult();
  for (const item of summaries) {
    yield;
    const summary = exactRecord(item, ['key', 'grouping', 'nodeCount', 'internalEdgeCount', 'declaredStatusCounts']);
    if (typeof summary.key !== 'string' || groupKeys.has(summary.key)) return invalidResult();
    const expectedGroup = groups.get(summary.key);
    if (!expectedGroup || summary.grouping !== request.options.grouping || summary.nodeCount !== expectedGroup.nodes
      || summary.internalEdgeCount !== expectedGroup.internal) return invalidResult();
    groupKeys.add(summary.key);
    const statuses = yield* arrayValue(summary.declaredStatusCounts, source.nodes.length), statusKeys = new Set<unknown>();
    if (statuses.length !== expectedGroup.statuses.size) return invalidResult();
    for (const item of statuses) {
    yield;
      const status = exactRecord(item, ['status', 'count']);
      if (status.status !== null && typeof status.status !== 'string' || statusKeys.has(status.status)
        || status.count !== expectedGroup.statuses.get(status.status as string | null)) return invalidResult();
      statusKeys.add(status.status);
    }
  }
  const groupLinks = yield* arrayValue(layout.groupLinks, edgeLimit), linkKeys = new Set<string>();
  if (groupLinks.length !== links.size) return invalidResult();
  for (const item of groupLinks) {
    yield;
    const link = exactRecord(item, ['fromGroupKey', 'toGroupKey', 'uniqueEdgeCount', 'semantics']);
    if (typeof link.fromGroupKey !== 'string' || typeof link.toGroupKey !== 'string' || link.semantics !== 'aggregate-only') return invalidResult();
    const key = JSON.stringify([link.fromGroupKey, link.toGroupKey]);
    if (linkKeys.has(key) || !links.has(key) || links.get(key) !== link.uniqueEdgeCount) return invalidResult(); linkKeys.add(key);
  }
  return value as GraphLayout;
}
function* freezeLayout(layout: GraphLayout): Generator<void, GraphLayout, void> {
  const seen = new Set<object>(), pending: object[] = [layout];
  while (pending.length) {
    yield;
    const value = pending.pop()!; if (seen.has(value)) continue; seen.add(value);
    const children = value instanceof Map ? value.values() : Object.values(value);
    for (const child of children) {
      yield;
      if (child && typeof child === 'object') pending.push(child);
    }
    Object.freeze(value);
  }
  // Object.freeze cannot disable Map.set/delete. ReadonlyMap is the consumer
  // contract, and every cache hit is revalidated to catch Map mutation as well.
  return layout;
}
function* responseLayout(value: unknown, request: TaskGraphLayoutRequest, expected: TaskGraphIdentity): Generator<void, GraphLayout, void> {
  const response = dataRecord(value);
  if (!response || response.requestId !== request.requestId || !matchingIdentity(response.identity, expected)) throw Error('invalid-result');
  if (Object.hasOwn(response, 'error')) {
    if (Object.keys(response).length !== 3 || !['invalid-request', 'layout-failed'].includes(response.error as string)) throw Error('invalid-result');
    throw Error(response.error as string);
  }
  if (Object.keys(response).length !== 3) throw Error('invalid-result');
  return yield* validateLayout(response.layout, request, expected);
}

/** A MessageChannel task gives timers/input/rendering a chance to run. Every
 * pending channel is closed on completion or cancellation; no polling or ports
 * survive the request. Promise.resolve alone would only yield a microtask. */
function yieldToEventLoop(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const complete = (error?: Error) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort);
      channel.port1.onmessage = null;
      channel.port1.close(); channel.port2.close();
      if (error) reject(error); else resolve();
    };
    const abort = () => complete(Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    channel.port1.onmessage = () => complete();
    if (signal.aborted) abort();
    else {
      try { channel.port2.postMessage(null); }
      catch { complete(Error('layout-failed')); }
    }
  });
}
async function runStages<T>(work: Generator<void, T, void>, current: () => void, signal: AbortSignal): Promise<T> {
  current(); let sliceStart = performance.now();
  try {
    for (;;) {
      const step = work.next();
      if (step.done) { current(); return step.value; }
      if (performance.now() - sliceStart >= 4) {
        current();
        await yieldToEventLoop(signal);
        current(); sliceStart = performance.now();
      }
    }
  } finally { work.return(undefined as never); }
}

/** Exactly one request owns one worker. Even if a worker or a live guard never
 * responds, cancel/deadline settles the promise and tears down physical work.
 * Owners call setBackground(true) on background and dispose() on unmount. */
export function createTaskGraphLayoutClient(options: TaskGraphLayoutClientOptions) {
  const timeoutMs = options.timeoutMs ?? TASK_GRAPH_LIMITS.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TASK_GRAPH_LIMITS.timeoutMs) throw Error('invalid-request');
  const factory = options.workerFactory ?? createTaskGraphLayoutWorker;
  const prefix = globalThis.crypto.randomUUID();
  let serial = 0, generation = 0, background = false, disposed = false;
  let active: { stop: (reason: string) => void } | null = null;
  // One fulfilled group/revision only. Source indexes can be large; keeping old
  // revision/group caches would multiply their bounded but substantial footprint.
  let cached: { layout: GraphLayout; previous: GraphLayout | undefined } | null = null;
  function cancel(reason = 'cancelled', clearCache = true) {
    generation++;
    active?.stop(reason);
    active = null;
    if (clearCache) cached = null;
  }
  return {
    cancel: () => cancel(),
    setBackground(value: boolean) { background = value; if (value) cancel('background'); },
    dispose() { disposed = true; cancel('disposed'); },
    layout(snapshot: AssembledGraphSnapshot, run: TaskGraphLayoutRunOptions): Promise<GraphLayout> {
      cancel('cancelled', false);
      if (disposed) return Promise.reject(Error('disposed'));
      if (background) return Promise.reject(Error('background'));
      if (run.signal?.aborted) return Promise.reject(Error('cancelled'));
      const expected = identityValue(snapshot.metadata.identity);
      if (!expected) return Promise.reject(Error('invalid-request'));
      const epoch = generation, controller = new AbortController(), deadline = performance.now() + timeoutMs;
      const request: TaskGraphLayoutRequest = { requestId: `${prefix}:${++serial}`, snapshot,
        options: { grouping: run.grouping, groupKey: run.groupKey, ...(run.previous ? { previous: run.previous } : {}) } };
      return new Promise<GraphLayout>((resolve, reject) => {
        let settled = false, worker: TaskGraphLayoutWorker | null = null;
        const owner = { stop: (reason: string) => finish(Error(reason)) };
        const onAbort = () => owner.stop('cancelled');
        const timer = setTimeout(() => owner.stop('timeout'), timeoutMs);
        function finish(error: Error | null, result?: GraphLayout) {
          if (settled) return;
          if (!error) {
            try { current(); }
            catch (failure) { error = boundedError(failure); }
          }
          settled = true;
          clearTimeout(timer);
          run.signal?.removeEventListener('abort', onAbort);
          controller.abort();
          terminateWorker();
          if (active === owner) active = null;
          if (error) { cached = null; reject(error); }
          else { cached = { layout: result!, previous: request.options.previous }; resolve(result!); }
        }
        function terminateWorker() {
          if (!worker) return;
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          worker.terminate(); worker = null;
        }
        function current() {
          if (settled || active !== owner || epoch !== generation || controller.signal.aborted) throw Error('cancelled');
          // Timers cannot interrupt synchronous guards/validation/freezing.
          if (performance.now() >= deadline) throw Error('timeout');
        }
        async function checkIdentity() {
          current();
          const live = await options.getCurrentIdentity({ ...expected! }, controller.signal);
          current();
          if (!matchingIdentity(live, expected!)) throw Error('stale-session');
        }
        active = owner;
        run.signal?.addEventListener('abort', onAbort, { once: true });
        // No worker is allocated if the graph is already stale or inactive.
        void (async () => {
          try {
            await checkIdentity();
            current();
            if (cached && matchingIdentity(cached.layout.identity, expected)
              && cached.layout.version === GRAPH_LAYOUT_VERSION && cached.layout.grouping === request.options.grouping
              && cached.layout.groupKey === request.options.groupKey
              && (cached.previous === request.options.previous || cached.layout === request.options.previous)) {
              const result = await runStages(validateLayout(cached.layout, request, expected), current, controller.signal);
              await runStages(freezeLayout(result), current, controller.signal);
              // Live authority can change during any cooperative yield.
              await checkIdentity();
              finish(null, result);
              return;
            }
            // Discard the previous group before allocating another full index.
            cached = null;
            try { worker = factory(); } catch { throw Error('worker-unavailable'); }
            worker.onmessage = event => {
              void (async () => {
                try {
                  current();
                  // Release the finished worker before yielding validation; no
                  // second message can race this request's atomic publication.
                  terminateWorker();
                  const result = await runStages(responseLayout(event.data, request, expected), current, controller.signal);
                  await runStages(freezeLayout(result), current, controller.signal);
                  await checkIdentity();
                  current();
                  finish(null, result);
                } catch (error) { finish(boundedError(error)); }
              })();
            };
            worker.onerror = event => { event.preventDefault?.(); finish(Error('layout-failed')); };
            worker.onmessageerror = () => finish(Error('invalid-result'));
            try { worker.postMessage(request); } catch { throw Error('invalid-request'); }
          } catch (error) { finish(boundedError(error)); }
        })();
      });
    },
  };
}

/** The complete read -> layout pipeline. The final metadata-only read asks main
 * to revalidate live session and content revision; it never concatenates source
 * revisions or refetches graph chunks solely to validate a layout. */
export function createTaskGraphLayoutPipeline(
  bridge: TaskGraphBridge,
  options: Omit<TaskGraphLayoutClientOptions, 'getCurrentIdentity'> = {},
) {
  const reader = createTaskGraphClient(bridge);
  const prefix = globalThis.crypto.randomUUID();
  let serial = 0, generation = 0, background = false, disposed = false;
  let active: AbortController | null = null;
  const layoutClient = createTaskGraphLayoutClient({ ...options, getCurrentIdentity: async (expected, signal) => {
    const requestId = `${prefix}:probe:${++serial}`;
    const release = () => { void bridge.cancelTaskGraph({ requestId }).catch(() => {}); };
    const current = () => { if (signal.aborted) throw Error('cancelled'); };
    const sameSession = (value: Awaited<ReturnType<TaskGraphBridge['getTaskGraphSession']>>) =>
      value !== null && value.projectId === expected.projectId && value.dagId === expected.dagId && value.sessionKey === expected.sessionKey;
    signal.addEventListener('abort', release, { once: true });
    try {
      current();
      const session = await bridge.getTaskGraphSession({ projectId: expected.projectId });
      current();
      if (!sameSession(session)) throw Error('stale-session');
      const response = await bridge.readTaskGraph({ requestId, projectId: expected.projectId,
        dagId: expected.dagId, sessionKey: expected.sessionKey, expectedRevision: expected.revision });
      current();
      if (response.state !== 'snapshot') throw boundedError(Error(response.reason), 'source-unavailable');
      const metadata = parseGraphMetadata(response.metadata);
      if (!sameGraphIdentity(metadata.identity, expected)) throw Error('source-changed');
      const finalSession = await bridge.getTaskGraphSession({ projectId: expected.projectId });
      current();
      if (!sameSession(finalSession)) throw Error('stale-session');
      return metadata.identity;
    } finally {
      signal.removeEventListener('abort', release);
      release();
    }
  } });
  function supersede() {
    generation++;
    active?.abort(); active = null;
    reader.cancel();
  }
  function cancel() { supersede(); layoutClient.cancel(); }
  return {
    cancel,
    setBackground(value: boolean) { background = value; if (value) cancel(); layoutClient.setBackground(value); },
    dispose() { disposed = true; cancel(); layoutClient.dispose(); },
    async read(projectId: string, run: TaskGraphLayoutRunOptions & { expectedRevision?: string | null }): Promise<{ snapshot: AssembledGraphSnapshot; layout: GraphLayout }> {
      supersede();
      if (disposed) throw Error('disposed');
      if (background) throw Error('background');
      const epoch = generation, controller = new AbortController();
      active = controller;
      const signal = run.signal ? AbortSignal.any([controller.signal, run.signal]) : controller.signal;
      const current = () => { if (epoch !== generation || signal.aborted) throw Error('cancelled'); };
      try {
        current();
        const snapshot = await reader.read(projectId, { signal, expectedRevision: run.expectedRevision });
        current();
        const layout = await layoutClient.layout(snapshot, { ...run, signal });
        current();
        return { snapshot, layout };
      } finally { if (active === controller) active = null; }
    },
    /** Reproject an already validated source for a new grouping. Hover/filter/
     * detail changes use the pure index/viewport functions and need no call. */
    async layout(snapshot: AssembledGraphSnapshot, run: TaskGraphLayoutRunOptions): Promise<GraphLayout> {
      supersede();
      if (disposed) throw Error('disposed');
      if (background) throw Error('background');
      const epoch = generation, controller = new AbortController();
      active = controller;
      const signal = run.signal ? AbortSignal.any([controller.signal, run.signal]) : controller.signal;
      try {
        const result = await layoutClient.layout(snapshot, { ...run, signal });
        if (epoch !== generation || signal.aborted) throw Error('cancelled');
        return result;
      } finally { if (active === controller) active = null; }
    },
  };
}
