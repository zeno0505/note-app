import type { GraphSourceNode, GraphSourceEdge, LinkedCommitEvidence, TaskGraphIdentity } from '../../src/shared/task-graph-contract';
import { graphEdgeId } from '../../src/shared/task-graph-contract';

/** Authored synthetic data only. Never import private project snapshots here. */
export interface SyntheticGraphTask extends GraphSourceNode {
  dependencies: { id: string; scope: 'internal' | 'external' }[];
}
export const GRAPH_FIXTURE_IDENTITY: TaskGraphIdentity = {
  projectId: 'synthetic-project', dagId: 'synthetic-dag', sourceHash: 'a'.repeat(64),
  sessionKey: 'synthetic-session-1', revision: 'synthetic-graph-v1',
};
export function syntheticNode(id: string, dependencies: string[] = [], phaseIndex = 0): SyntheticGraphTask {
  return { id, title: `Synthetic task ${id}`, declaredStatus: 'declared-done',
    phase: { id: null, title: 'Shared title', index: phaseIndex },
    dependencies: dependencies.map(id => ({ id, scope: 'internal' })) };
}
export function syntheticChain(count: number): SyntheticGraphTask[] {
  return Array.from({ length: count }, (_, i) => syntheticNode(`S-${i + 1}`, i ? [`S-${i}`] : [], i % 3));
}
export function syntheticHighDegree(): SyntheticGraphTask[] {
  return [...syntheticChain(12), syntheticNode('S-13', Array.from({ length: 12 }, (_, i) => `S-${i + 1}`))];
}
export function syntheticAdversarial(): SyntheticGraphTask[] {
  return [syntheticNode('A-1'), syntheticNode('B-1', ['A-1']),
    syntheticNode('B-2'), syntheticNode('A-2', ['B-2']), // Bidirectional group aggregate, no task cycle.
    syntheticNode('C-1', ['C-2']), syntheticNode('C-2', ['C-1']),
    syntheticNode('D-1', ['D-1']), syntheticNode('E-1'), syntheticNode('E-1'),
    { ...syntheticNode('unparsed', ['E-1', 'missing', 'A-1', 'A-1']), phase: null,
      dependencies: [...syntheticNode('x', ['E-1', 'missing', 'A-1', 'A-1']).dependencies, { id: 'A-1', scope: 'external' }] },
  ];
}
/** Independent test oracle, not a production normalization implementation.
 * Ambiguous IDs never become nodes; declarations incident to them remain diagnosable. */
export function syntheticOracle(rows: readonly SyntheticGraphTask[]) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([id]) => id).sort();
  const nodes = rows.filter(row => counts.get(row.id) === 1);
  const ids = new Set(nodes.map(row => row.id));
  const edges = new Map<string, GraphSourceEdge>();
  for (const row of rows) for (const dependency of row.dependencies) {
    const id = graphEdgeId(dependency.id, row.id, dependency.scope);
    const previous = edges.get(id);
    if (previous) { previous.declarations++; continue; }
    const from: GraphSourceEdge['from'] = dependency.scope === 'external'
      ? { kind: 'unresolved', id: dependency.id, reason: 'external' }
      : ids.has(dependency.id) ? { kind: 'node', id: dependency.id }
      : { kind: 'unresolved', id: dependency.id, reason: counts.has(dependency.id) ? 'duplicate' : 'missing' };
    edges.set(id, { id, from, to: ids.has(row.id) ? { kind: 'node', id: row.id }
      : { kind: 'unresolved', id: row.id, reason: 'duplicate' }, scope: dependency.scope, declarations: 1 });
  }
  return { nodes, edges: [...edges.values()], duplicates };
}
export const SYNTHETIC_LINKED_COMMITS: readonly LinkedCommitEvidence[] = [
  { taskId: 'S-1', declaredReference: '1'.repeat(40), repository: { host: 'github.com', owner: 'synthetic', name: 'one' },
    sha: '1'.repeat(40), committerAtUtc: '2025-12-31T16:00:00Z',
    verifiedCommitUrl: 'https://github.com/synthetic/one/commit/' + '1'.repeat(40), via: { kind: 'declared-commit' } },
  { taskId: 'S-2', declaredReference: 'https://github.com/synthetic/two/pull/7', repository: { host: 'github.com', owner: 'synthetic', name: 'two' },
    sha: '2'.repeat(40), committerAtUtc: '2026-01-01T00:00:00Z',
    verifiedCommitUrl: 'https://github.com/synthetic/two/commit/' + '2'.repeat(40),
    via: { kind: 'declared-pr', number: 7, membershipRevision: 'synthetic-pr-membership-v1' } },
];
