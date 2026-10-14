import { taskPrefix } from "./summary-prefix";
import type { LiveDagTaskView } from './live';

/** Complete graph transport contract.
 * The complete source index is never derived from LiveDagTaskView/workspaceTasks.
 * All dependency directions are predecessor -> dependent. */
export const TASK_GRAPH_CONTRACT_VERSION = 1 as const;
export const TASK_GRAPH_LIMITS = Object.freeze({
  sourceNodes: 10_000, sourceEdges: 100_000,
  chunkNodes: 250, chunkEdges: 2_000, chunkBytes: 512 * 1024,
  snapshotBytes: 32 * 1024 * 1024, timeoutMs: 10_000,
  idCharacters: 256, titleCharacters: 2_048, identityCharacters: 1_024, statusCharacters: 128,
  chunkCount: 1_000,
  detailBytes: 512 * 1024, detailReferences: 10_000, detailTextCharacters: 4_096,
  detailPolicies: 200, detailPolicyDepth: 32, detailPolicyValues: 20_000,
});
export interface TaskGraphIdentity {
  projectId: string; dagId: string; sourceHash: string;
  /** Opaque main-issued identity; binds workspace, guard and connection generation. */
  sessionKey: string;
  /** Content-addressed graph + metadata revision, not a file mtime. */
  revision: string;
}
export type GraphGrouping = 'prefix' | 'phase' | 'ungrouped';
export interface GraphSourceNode {
  id: string; title: string | null;
  /** Original vocabulary, never a verification or observed completion claim. */
  declaredStatus: string | null;
  phase: { id: string | null; title: string | null; index: number } | null;
}
export type GraphEndpoint =
  | { kind: 'node'; id: string }
  | { kind: 'unresolved'; id: string; reason: 'missing' | 'duplicate' | 'external' | 'source-incomplete' };
export interface GraphSourceEdge {
  /** Stable tuple identity, not an array index. Repeated identical declarations deduplicate. */
  id: string; from: GraphEndpoint; to: GraphEndpoint;
  scope: 'internal' | 'external';
  /** Count of repeated declarations. This does not multiply the unique edge count. */
  declarations: number;
}
export type GraphPartialReason = 'node-limit' | 'edge-limit' | 'byte-limit' | 'incomplete-read' | 'duplicate-id' | 'malformed-source';
export interface GraphCounts {
  /** Raw source rows, including duplicates; null means unknown, never zero by default. */
  sourceTaskRows: number | null;
  uniqueNodes: number; uniqueEdges: number; unresolvedEdges: number;
}
export type GraphCoverage =
  | { state: 'complete'; counts: GraphCounts & { sourceTaskRows: number }; reasons: readonly [] }
  | { state: 'partial'; counts: GraphCounts; reasons: readonly GraphPartialReason[] }
  | { state: 'unknown'; counts: null; reasons: readonly ['not-read'] };
export interface GraphDiagnostics {
  duplicateIds: readonly string[];
  /** Real node SCCs only, including singleton self-loops. Group cycles are unrelated. */
  cycles: readonly (readonly string[])[];
  repeatedDeclarations: number;
}
export interface GraphSnapshotMetadata {
  contractVersion: typeof TASK_GRAPH_CONTRACT_VERSION;
  identity: TaskGraphIdentity; observedAt: string;
  coverage: GraphCoverage; diagnostics: GraphDiagnostics;
  chunkCount: number; byteLength: number;
}
export interface GraphChunk {
  contractVersion: typeof TASK_GRAPH_CONTRACT_VERSION;
  identity: TaskGraphIdentity; index: number;
  nodes: readonly GraphSourceNode[]; edges: readonly GraphSourceEdge[];
  /** UTF-8 bytes of serialized whole chunk, checked by producer and receiver. */
  byteLength: number;
}
export type GraphReadError = 'invalid-request' | 'disconnected' | 'unauthorized' | 'source-unavailable'
  | 'source-changed' | 'stale-session' | 'cancelled' | 'timeout' | 'invalid-schema' | 'unsupported';
export interface GraphReadRequest {
  requestId: string; projectId: string; dagId: string; sessionKey: string;
  expectedRevision: string | null;
}
export interface GraphChunkRequest {
  requestId: string; identity: TaskGraphIdentity; index: number;
}
export type GraphReadResult =
  | { state: 'snapshot'; metadata: GraphSnapshotMetadata }
  | { state: 'unavailable'; requestId: string; reason: GraphReadError };
export type GraphChunkResult =
  | { state: 'chunk'; requestId: string; chunk: GraphChunk }
  | { state: 'unavailable'; requestId: string; reason: GraphReadError };

/** One task from the same complete, guarded source as the selected graph. */
export interface GraphDetailRequest {
  requestId: string; identity: TaskGraphIdentity; taskId: string;
}
export interface GraphDetailSnapshot {
  state: 'detail'; requestId: string; identity: TaskGraphIdentity; observedAt: string;
  /** Full admitted source fields. Display caps never apply; source omissions remain explicit. */
  task: LiveDagTaskView; policies: Record<string, unknown>[];
}
export type GraphDetailResult = GraphDetailSnapshot
  | { state: 'unavailable'; requestId: string; reason: GraphReadError };

/** Projection flags are independent. Filtering/grouping/culling never mutate source adjacency. */
export interface GraphGroupSummary {
  key: string; grouping: GraphGrouping; nodeCount: number; internalEdgeCount: number;
  declaredStatusCounts: readonly { status: string | null; count: number }[];
}
export interface GraphGroupLink {
  fromGroupKey: string; toGroupKey: string; uniqueEdgeCount: number;
  /** Opposing aggregate links never establish a task SCC. */
  semantics: 'aggregate-only';
}
export interface GraphProjection {
  identity: TaskGraphIdentity; grouping: GraphGrouping; groupKey: string;
  visibleNodeIds: readonly string[]; filteredNodeIds: readonly string[];
  otherGroupNodeIds: readonly string[];
}
export type GraphViewportEdge = 'internal' | 'boundary' | 'outside';
export function graphViewportEdge(edge: GraphSourceEdge, visible: ReadonlySet<string>): GraphViewportEdge {
  const from = edge.from.kind === 'node' && visible.has(edge.from.id);
  const to = edge.to.kind === 'node' && visible.has(edge.to.id);
  return from && to ? 'internal' : from || to ? 'boundary' : 'outside';
}
export function graphEdgeId(from: string, to: string, scope: GraphSourceEdge['scope']): string {
  return JSON.stringify([from, to, scope]);
}
export function sameGraphIdentity(a: TaskGraphIdentity, b: TaskGraphIdentity): boolean {
  return a.projectId === b.projectId && a.dagId === b.dagId && a.sourceHash === b.sourceHash
    && a.sessionKey === b.sessionKey && a.revision === b.revision;
}

/** Metadata is resolved once in an authorized main-side read path, never in renderer hover. */
export interface LinkedCommitEvidence {
  taskId: string; declaredReference: string;
  repository: { host: string; owner: string; name: string };
  sha: string; committerAtUtc: string; verifiedCommitUrl: string;
  via: { kind: 'declared-commit' }
    | { kind: 'declared-pr'; number: number; membershipRevision: string };
}
export type LinkedReferenceResolution =
  | { state: 'resolved'; declaredReference: string; commits: readonly LinkedCommitEvidence[] }
  | { state: 'unresolved'; declaredReference: string; reason: 'not-found' | 'ambiguous' | 'repository-unknown' | 'unsupported' | 'unavailable' | 'incomplete-membership' };
export interface LinkedDateCoverage {
  /** Whether all source declarations were inspected; known counts may be lower bounds otherwise. */
  inspection: 'complete' | 'partial' | 'unknown';
  /** Mutually exclusive tasks: any resolved reference / no declared reference / no resolved reference. */
  tasks: { total: number; resolved: number; noReference: number; unresolved: number };
  /** All declared references including unsupported ones; a resolved task can still be partial. */
  references: { total: number; resolved: number; unresolved: number };
}
export type LinkedDateSummary =
  | { state: 'resolved' | 'partial'; latest: LinkedCommitEvidence; coverage: LinkedDateCoverage }
  | { state: 'no-reference' | 'unknown'; latest: null; coverage: LinkedDateCoverage };

/** JSON tuples separate missing, unparsed and literal group names without sentinel collisions.
 * Anonymous phases use their source index; equal titles never merge different phases. */
export function graphGroupKey(node: GraphSourceNode, mode: GraphGrouping): string {
  if (mode === 'ungrouped') return JSON.stringify(['ungrouped']);
  if (mode === 'prefix') {
    const prefix = taskPrefix(node.id);
    return JSON.stringify(prefix === null ? ['prefix', 'unparsed'] : ['prefix', 'value', prefix]);
  }
  return JSON.stringify(node.phase === null ? ['phase', 'missing'] : ['phase', node.phase.id, node.phase.index]);
}

export interface TaskGraphBridge {
  getTaskGraphSession(request: {projectId: string}): Promise<{projectId: string; dagId: string; sessionKey: string} | null>;
  readTaskGraph(request: GraphReadRequest): Promise<GraphReadResult>;
  readTaskGraphChunk(request: GraphChunkRequest): Promise<GraphChunkResult>;
  readTaskGraphDetail(request: GraphDetailRequest): Promise<GraphDetailResult>;
  cancelTaskGraph(request: {requestId: string}): Promise<void>;
}
