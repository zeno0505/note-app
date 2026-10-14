import { describe, expect, it } from 'vitest';
import { layoutTaskGraph } from '../../src/phase2/graph';
import type { TaskInput } from '../../src/phase2/tasks';
import { graphEdgeId, graphGroupKey, graphViewportEdge, sameGraphIdentity, TASK_GRAPH_LIMITS } from '../../src/shared/task-graph-contract';
import type { GraphCoverage, LinkedDateSummary } from '../../src/shared/task-graph-contract';
import { GRAPH_FIXTURE_IDENTITY, syntheticAdversarial, syntheticChain, syntheticHighDegree, syntheticNode, syntheticOracle, SYNTHETIC_LINKED_COMMITS } from '../helpers/task-graph-fixtures';

describe('T-057 source contract and independent synthetic oracle (no IPC reader)', () => {
  it.each([0, 1, 387, 1001, 10000])('retains %i source nodes independently of display paging', count => {
    const oracle = syntheticOracle(syntheticChain(count));
    expect(oracle.nodes).toHaveLength(count);
    expect(oracle.edges).toHaveLength(Math.max(0, count - 1));
  });
  it('has explicit finite source, byte, chunk and timeout budgets', () => {
    for (const budget of Object.values(TASK_GRAPH_LIMITS)) expect(Number.isSafeInteger(budget) && budget > 0).toBe(true);
    expect(TASK_GRAPH_LIMITS.chunkNodes).toBeLessThan(TASK_GRAPH_LIMITS.sourceNodes);
    expect(TASK_GRAPH_LIMITS.chunkBytes).toBeLessThan(TASK_GRAPH_LIMITS.snapshotBytes);
    // A limit is a rejection/partial threshold, not performance certification.
    expect(syntheticChain(TASK_GRAPH_LIMITS.sourceNodes + 1).length).toBeGreaterThan(TASK_GRAPH_LIMITS.sourceNodes);
  });
  it('keeps all 12 direct predecessors, not the bounded display 8', () => {
    const oracle = syntheticOracle(syntheticHighDegree());
    expect(oracle.edges.filter(edge => edge.to.id === 'S-13')).toHaveLength(12);
    expect(oracle.edges.filter(edge => edge.from.id === 'S-1').map(edge => edge.to.id)).toEqual(['S-2', 'S-13']);
  });
  it('preserves duplicates, dangling/external refs, self-loop and repeated declarations separately', () => {
    const oracle = syntheticOracle(syntheticAdversarial());
    expect(oracle.nodes).toHaveLength(8);
    expect(oracle.duplicates).toEqual(['E-1']);
    expect(oracle.edges).toHaveLength(9);
    expect(oracle.edges.filter(e => e.from.kind === 'unresolved').map(e => e.from)).toEqual([
      { kind: 'unresolved', id: 'E-1', reason: 'duplicate' },
      { kind: 'unresolved', id: 'missing', reason: 'missing' },
      { kind: 'unresolved', id: 'A-1', reason: 'external' },
    ]);
    expect(oracle.edges.find(e => e.id === graphEdgeId('A-1', 'unparsed', 'internal'))?.declarations).toBe(2);
    expect(oracle.edges.some(e => e.from.id === 'D-1' && e.to.id === 'D-1')).toBe(true);
  });
  it('distinguishes actual SCCs from opposing group links using the existing layout on full synthetic input', () => {
    const input: TaskInput[] = syntheticAdversarial().map(row => ({ ...row, status: row.declaredStatus, commitReferences: [], commitVerification: 'not-performed',
      e2e: { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' } }));
    expect(layoutTaskGraph(input).diagnostics.cycles).toEqual([['C-1', 'C-2'], ['D-1']]);
  });
  it('partitions every unique edge exactly once for arbitrary viewports, including unresolved refs', () => {
    const { edges, nodes } = syntheticOracle(syntheticAdversarial());
    for (let mask = 0; mask < 2 ** nodes.length; mask++) {
      const visible = new Set(nodes.filter((_, i) => mask & (1 << i)).map(n => n.id));
      const kinds = edges.map(edge => graphViewportEdge(edge, visible));
      expect(kinds.filter(k => k === 'internal').length + kinds.filter(k => k === 'boundary').length + kinds.filter(k => k === 'outside').length).toBe(edges.length);
    }
    const edge = edges.find(e => e.from.id === 'A-1' && e.to.id === 'B-1')!;
    expect(graphViewportEdge(edge, new Set(['A-1']))).toBe('boundary');
    expect(graphViewportEdge(edge, new Set(['B-1']))).toBe('boundary');
    expect(graphViewportEdge(edge, new Set(['A-1', 'B-1']))).toBe('internal');
    expect(graphViewportEdge(edge, new Set())).toBe('outside');
  });
  it('does not alias edge tuple IDs or internal and external declarations', () => {
    expect(graphEdgeId('a:b', 'c', 'internal')).not.toBe(graphEdgeId('a', 'b:c', 'internal'));
    expect(graphEdgeId('a', 'b', 'internal')).not.toBe(graphEdgeId('a', 'b', 'external'));
  });
  it('distinguishes prefix, equal-title phases, missing phase, unparsed IDs and ungrouped', () => {
    const a = syntheticNode('A-1', [], 0), b = syntheticNode('A-2', [], 1);
    expect(graphGroupKey(a, 'prefix')).toBe(graphGroupKey(b, 'prefix'));
    expect(graphGroupKey(a, 'phase')).not.toBe(graphGroupKey(b, 'phase'));
    expect(graphGroupKey({ ...a, phase: null }, 'phase')).not.toBe(graphGroupKey(a, 'phase'));
    expect(graphGroupKey(syntheticNode('bad'), 'prefix')).not.toBe(graphGroupKey(syntheticNode('unparsed-1'), 'prefix'));
    expect(graphGroupKey(a, 'ungrouped')).toBe(graphGroupKey(b, 'ungrouped'));
  });
  it('rejects identity equality across projects, revisions, guards and connection sessions', () => {
    expect(sameGraphIdentity(GRAPH_FIXTURE_IDENTITY, { ...GRAPH_FIXTURE_IDENTITY })).toBe(true);
    for (const key of Object.keys(GRAPH_FIXTURE_IDENTITY) as (keyof typeof GRAPH_FIXTURE_IDENTITY)[])
      expect(sameGraphIdentity(GRAPH_FIXTURE_IDENTITY, { ...GRAPH_FIXTURE_IDENTITY, [key]: 'changed' })).toBe(false);
  });
  it('distinguishes complete empty from unknown and partial source coverage', () => {
    const unknown: GraphCoverage = { state: 'unknown', counts: null, reasons: ['not-read'] };
    const empty: GraphCoverage = { state: 'complete', counts: { sourceTaskRows: 0, uniqueNodes: 0, uniqueEdges: 0, unresolvedEdges: 0 }, reasons: [] };
    const partial: GraphCoverage = { state: 'partial', counts: { sourceTaskRows: null, uniqueNodes: 1000, uniqueEdges: 999, unresolvedEdges: 0 }, reasons: ['incomplete-read'] };
    expect(unknown.counts).toBeNull(); expect(empty.counts.sourceTaskRows).toBe(0);
    expect(partial.counts.sourceTaskRows).toBeNull();
  });
  it('represents task-level resolved but reference-level partial linked-date coverage', () => {
    const summary: LinkedDateSummary = { state: 'partial', latest: SYNTHETIC_LINKED_COMMITS[1],
      coverage: { inspection: 'complete', tasks: { total: 4, resolved: 2, noReference: 1, unresolved: 1 }, references: { total: 4, resolved: 2, unresolved: 2 } } };
    expect(summary.coverage.tasks.resolved + summary.coverage.tasks.noReference + summary.coverage.tasks.unresolved).toBe(4);
    expect(summary.latest.via.kind).toBe('declared-pr');
    expect(summary.latest.repository.name).toBe('two');
    const midnight = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    expect(midnight.format(new Date(SYNTHETIC_LINKED_COMMITS[0].committerAtUtc))).toBe('01/01/2026, 01:00');
  });
});
