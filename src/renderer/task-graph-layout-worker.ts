import { TASK_GRAPH_LIMITS, type TaskGraphIdentity } from '../shared/task-graph-contract';
import { parseGraphMetadata, type AssembledGraphSnapshot } from '../shared/task-graph-transport';
import { layoutGraphSnapshot, type GraphLayout, type GraphLayoutOptions } from '../shared/task-graph-layout';

/** This boundary receives only an already assembled transport snapshot, never a
 * source path, source text, display projection or bridge capability. */
export interface TaskGraphLayoutRequest {
  requestId: string;
  snapshot: AssembledGraphSnapshot;
  options: GraphLayoutOptions;
}
export type TaskGraphLayoutResponse =
  | { requestId: string; identity: TaskGraphIdentity; layout: GraphLayout }
  | { requestId: string; identity: TaskGraphIdentity | null; error: 'invalid-request' | 'layout-failed' };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('invalid-request');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) throw Error('invalid-request');
    result[key] = descriptor.value;
  }
  return result;
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw Error('invalid-request');
}

/** Exported for deterministic protocol tests. Production execution stays in the
 * dedicated module worker; cancellation is physical Worker.terminate(). */
export function handleTaskGraphLayoutRequest(input: unknown): TaskGraphLayoutResponse {
  let requestId = '', identity: TaskGraphIdentity | null = null;
  let request: TaskGraphLayoutRequest;
  try {
    const message = record(input);
    if (typeof message.requestId !== 'string' || !message.requestId.length
      || message.requestId.length > TASK_GRAPH_LIMITS.idCharacters) throw Error('invalid-request');
    requestId = message.requestId;
    exactKeys(message, ['requestId', 'snapshot', 'options']);
    const snapshot = record(message.snapshot);
    exactKeys(snapshot, ['metadata', 'nodes', 'edges']);
    const metadata = parseGraphMetadata(snapshot.metadata);
    identity = metadata.identity;
    if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length > TASK_GRAPH_LIMITS.sourceNodes
      || !Array.isArray(snapshot.edges) || snapshot.edges.length > TASK_GRAPH_LIMITS.sourceEdges) throw Error('invalid-request');
    // Transport assembly validates the individual node/edge records once. This
    // envelope check prevents accidental display subsets crossing the boundary.
    const counts = metadata.coverage.counts;
    if (snapshot.nodes.length !== (counts?.uniqueNodes ?? 0)
      || snapshot.edges.length !== (counts?.uniqueEdges ?? 0)) throw Error('invalid-request');
    const options = record(message.options);
    exactKeys(options, ['grouping', 'groupKey'], ['previous']);
    if (!['prefix', 'phase', 'ungrouped'].includes(options.grouping as string)
      || (options.groupKey !== null && (typeof options.groupKey !== 'string'
        || !options.groupKey.length || options.groupKey.length > TASK_GRAPH_LIMITS.identityCharacters * 4))) throw Error('invalid-request');
    request = { requestId, snapshot: { metadata, nodes: snapshot.nodes, edges: snapshot.edges },
      options: options as unknown as GraphLayoutOptions };
  } catch {
    return { requestId, identity, error: 'invalid-request' };
  }
  try {
    const layout = layoutGraphSnapshot(request.snapshot, request.options);
    return { requestId, identity: identity!, layout };
  } catch {
    // Never return arbitrary source text, exception messages or stack traces.
    return { requestId, identity, error: 'layout-failed' };
  }
}

const scope = globalThis as unknown as {
  document?: unknown;
  postMessage?: (response: TaskGraphLayoutResponse) => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};
if (typeof scope.document === 'undefined' && typeof scope.postMessage === 'function') {
  scope.onmessage = event => scope.postMessage!(handleTaskGraphLayoutRequest(event.data));
}
