import { describe, expect, it } from 'vitest';
import {
  graphGroupDateSummaries, graphGroupLabel, graphGroupLabels,
  graphDeclaredStatus, graphDateShortLabel, graphDateYearContext,
} from '../../src/renderer/task-graph-overview';
import {
  graphGroupKey, TASK_GRAPH_CONTRACT_VERSION,
  type GraphGrouping, type GraphSourceNode, type LinkedCommitEvidence, type LinkedDateSummary,
} from '../../src/shared/task-graph-contract';
import type { GraphDateReadResult } from '../../src/shared/task-graph-dates';
import { layoutGraphSnapshot } from '../../src/shared/task-graph-layout';
import { GRAPH_FIXTURE_IDENTITY as identity, syntheticNode } from '../helpers/task-graph-fixtures';
import { summarizeLinkedDates, type LinkedDateTask, type LinkedDatesResult } from '../../src/main/linked-commit-dates';

function layout(nodes: readonly GraphSourceNode[], grouping: GraphGrouping = 'prefix', groupKey: string | null = null) {
  return layoutGraphSnapshot({ nodes, edges: [], metadata: { contractVersion: TASK_GRAPH_CONTRACT_VERSION,
    identity, observedAt: '2026-10-14T00:00:00Z', chunkCount: 0, byteLength: 0,
    coverage: { state: 'complete', reasons: [], counts: { sourceTaskRows: nodes.length, uniqueNodes: nodes.length, uniqueEdges: 0, unresolvedEdges: 0 } },
    diagnostics: { duplicateIds: [], cycles: [], repeatedDeclarations: 0 },
  } }, { grouping, groupKey });
}

function evidence(taskId: string, time = '2026-12-31T16:00:00.000Z', name = 'alpha', sha = 'a'.repeat(40)): LinkedCommitEvidence {
  return { taskId, declaredReference: sha, repository: { host: 'github.com', owner: 'synthetic', name }, sha,
    committerAtUtc: time, verifiedCommitUrl: `https://github.com/synthetic/${name}/commit/${sha}`, via: { kind: 'declared-commit' } };
}

function resolved(id: string, time?: string, unresolved = 0): LinkedDateSummary {
  return { state: unresolved ? 'partial' : 'resolved', latest: evidence(id, time), coverage: { inspection: 'complete',
    tasks: { total: 1, resolved: 1, noReference: 0, unresolved: 0 }, references: { total: 1 + unresolved, resolved: 1, unresolved } } };
}

function unlinked(state: 'no-reference' | 'unknown' = 'no-reference', inspection: 'complete' | 'partial' | 'unknown' = 'complete'): LinkedDateSummary {
  const unresolved = state === 'unknown' ? 1 : 0;
  return { state, latest: null, coverage: { inspection,
    tasks: { total: 1, resolved: 0, noReference: 1 - unresolved, unresolved }, references: { total: unresolved, resolved: 0, unresolved } } };
}

function response(tasks: { id: string; summary: LinkedDateSummary }[]): Extract<GraphDateReadResult, { state: 'dates' }> {
  // Deliberately unrelated top-level summary: group dates must use task evidence.
  return { state: 'dates', requestId: 'synthetic-request', identity, metadataRevision: 'synthetic-date-revision',
    summary: resolved('outside', '2099-01-01T00:00:00Z'), tasks };
}

describe('graph overview group labels', () => {
  it('preserves prefix case and distinguishes a literal unparsed prefix from unparsed IDs', () => {
    const nodes = [syntheticNode('A-1'), syntheticNode('a-1'), syntheticNode('unparsed-1'), syntheticNode('invalid')];
    const graph = layout(nodes), labels = graphGroupLabels(graph);
    expect(nodes.map(node => labels.get(graphGroupKey(node, 'prefix')))).toEqual(['A', 'a', 'unparsed', '접두사 미분류']);
    expect(graphGroupLabel(graph, 'unknown-group')).toBe('그룹 미확인');
  });
  it('uses phase titles, IDs and source indices without merging equal titles or missing phases', () => {
    const nodes = [
      { ...syntheticNode('S-1'), phase: { id: null, title: 'Shared', index: 0 } },
      { ...syntheticNode('S-2'), phase: { id: null, title: 'Shared', index: 1 } },
      { ...syntheticNode('S-3'), phase: { id: 'declared-phase', title: null, index: 2 } },
      { ...syntheticNode('S-4'), phase: { id: null, title: null, index: 3 } },
      { ...syntheticNode('S-5'), phase: null },
    ];
    const labels = graphGroupLabels(layout(nodes, 'phase'));
    expect(labels.size).toBe(5);
    expect(nodes.map(node => labels.get(graphGroupKey(node, 'phase')))).toEqual(['Shared', 'Shared', 'declared-phase', 'Phase 4', 'Phase 미지정']);
  });
  it('includes every source group even when layout only contains one chosen group', () => {
    const nodes = [syntheticNode('A-1'), syntheticNode('B-1')];
    const graph = layout(nodes, 'prefix', graphGroupKey(nodes[0], 'prefix'));
    expect(graph.nodes).toHaveLength(1);
    expect([...graphGroupLabels(graph).values()]).toEqual(['A', 'B']);
    expect([...graphGroupLabels(layout(nodes, 'ungrouped')).values()]).toEqual(['전체 작업']);
    expect(graphGroupLabels(layout([])).size).toBe(0);
  });
});

describe('graph overview declared statuses', () => {
  it.each([
    ['done', '완료'], ['deferred', '보류'], ['superseded', '대체됨'], ['pending', '대기'], ['running', '실행 중'],
  ])('maps approved declared status %s to its display vocabulary', (status, label) => {
    expect(graphDeclaredStatus(status)).toEqual({ label, tone: status });
  });
  it.each(['custom-value', 'blocked', 'DONE', ' done ', '', 'unknown', '__proto__', '완료'])('preserves arbitrary status %s without lifecycle reinterpretation', status => {
    expect(graphDeclaredStatus(status)).toEqual({ label: status, tone: 'unknown' });
  });
  it('distinguishes undeclared status from a literal unknown declaration', () => {
    expect(graphDeclaredStatus(null)).toEqual({ label: '미선언', tone: 'unknown' });
    expect(graphDeclaredStatus('unknown').label).toBe('unknown');
  });
});

describe('graph overview linked date coverage', () => {
  it('sums task and reference coverage exactly and chooses latest task maximum for each full-source group', () => {
    const nodes = ['A-1', 'A-2', 'A-3', 'A-4', 'B-1'].map(id => syntheticNode(id));
    const graph = layout(nodes, 'prefix', graphGroupKey(nodes[4], 'prefix'));
    const dates = response([
      { id: 'A-1', summary: resolved('A-1', '2026-12-31T16:00:00.000Z', 2) },
      { id: 'A-2', summary: resolved('A-2', '2026-12-31T15:59:59.000Z') },
      { id: 'A-3', summary: unlinked() }, { id: 'A-4', summary: unlinked('unknown') },
      { id: 'B-1', summary: resolved('B-1', '2025-01-01T00:00:00.000Z') },
    ]);
    const before = JSON.stringify(dates), summary = graphGroupDateSummaries(graph, dates);
    expect(summary.get(graphGroupKey(nodes[0], 'prefix'))).toEqual({ state: 'partial', latest: dates.tasks[0].summary.latest,
      coverage: { inspection: 'complete', tasks: { total: 4, resolved: 2, noReference: 1, unresolved: 1 },
        references: { total: 5, resolved: 2, unresolved: 3 } } });
    expect(summary.get(graphGroupKey(nodes[4], 'prefix'))).toEqual(dates.tasks[4].summary);
    expect(JSON.stringify(dates)).toBe(before);
  });
  it('does not deduplicate task-bound references to the same commit', () => {
    const nodes = [syntheticNode('A-1'), syntheticNode('A-2')], graph = layout(nodes);
    const summary = graphGroupDateSummaries(graph, response(nodes.map(node => ({ id: node.id, summary: resolved(node.id) })))).get(graph.groups[0].key)!;
    expect(summary.state).toBe('resolved');
    expect(summary.coverage.tasks).toEqual({ total: 2, resolved: 2, noReference: 0, unresolved: 0 });
    expect(summary.coverage.references).toEqual({ total: 2, resolved: 2, unresolved: 0 });
    expect(summary.latest?.taskId).toBe('A-1');
  });
  it('aggregates beyond display-page limits without dropping the latest final task', () => {
    const nodes = Array.from({ length: 1001 }, (_, i) => syntheticNode(`A-${i + 1}`));
    const graph = layout(nodes), dates = response(nodes.map((node, i) => ({ id: node.id,
      summary: resolved(node.id, i === 1000 ? '2027-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z') })));
    const summary = graphGroupDateSummaries(graph, dates).get(graph.groups[0].key)!;
    expect(summary.state).toBe('resolved');
    expect(summary.coverage.tasks).toEqual({ total: 1001, resolved: 1001, noReference: 0, unresolved: 0 });
    expect(summary.coverage.references).toEqual({ total: 1001, resolved: 1001, unresolved: 0 });
    expect(summary.latest?.taskId).toBe('A-1001');
  });
  it('keeps same-title phase dates separate and combines them only in ungrouped mode', () => {
    const nodes = [syntheticNode('A-1', [], 0), syntheticNode('A-2', [], 1)];
    const dates = response([{ id: 'A-1', summary: resolved('A-1') }, { id: 'A-2', summary: unlinked() }]);
    const phases = layout(nodes, 'phase'), summaries = graphGroupDateSummaries(phases, dates);
    expect(summaries.size).toBe(2);
    expect(summaries.get(graphGroupKey(nodes[0], 'phase'))?.state).toBe('resolved');
    expect(summaries.get(graphGroupKey(nodes[1], 'phase'))?.state).toBe('no-reference');
    const ungrouped = layout(nodes, 'ungrouped');
    expect(graphGroupDateSummaries(ungrouped, dates).get(ungrouped.groups[0].key)).toMatchObject({ state: 'partial',
      coverage: { tasks: { total: 2, resolved: 1, noReference: 1, unresolved: 0 } } });
  });
  it.each(['projectId', 'dagId', 'sourceHash', 'sessionKey', 'revision'] as const)('rejects date results from another %s', field => {
    const graph = layout([syntheticNode('A-1')]), dates = response([{ id: 'A-1', summary: resolved('A-1') }]);
    expect(graphGroupDateSummaries(graph, { ...dates, identity: { ...identity, [field]: 'different' } }).size).toBe(0);
  });
  it('leaves unavailable, absent and empty-source results empty', () => {
    const graph = layout([syntheticNode('A-1')]);
    expect(graphGroupDateSummaries(graph, null).size).toBe(0);
    expect(graphGroupDateSummaries(graph, undefined).size).toBe(0);
    expect(graphGroupDateSummaries(graph, { state: 'unavailable', requestId: 'request', reason: 'unauthorized' }).size).toBe(0);
    expect(graphGroupDateSummaries(layout([]), response([])).size).toBe(0);
  });
  it('marks omitted or duplicate task summaries unknown, retaining verified evidence from other tasks', () => {
    const graph = layout(['A-1', 'A-2', 'A-3'].map(id => syntheticNode(id)));
    const dates = response([{ id: 'A-1', summary: resolved('A-1') },
      { id: 'A-2', summary: unlinked() }, { id: 'A-2', summary: unlinked() },
      { id: 'outside', summary: resolved('outside', '2099-01-01T00:00:00Z') }]);
    const summary = graphGroupDateSummaries(graph, dates).get(graph.groups[0].key)!;
    expect(summary).toMatchObject({ state: 'partial', latest: { taskId: 'A-1' }, coverage: { inspection: 'unknown',
      tasks: { total: 3, resolved: 1, noReference: 0, unresolved: 2 }, references: { total: 1, resolved: 1, unresolved: 0 } } });
    expect(graphGroupDateSummaries(graph, response([])).get(graph.groups[0].key)).toMatchObject({ state: 'unknown', latest: null });
  });
  it.each(['complete', 'partial', 'unknown'] as const)('retains %s inspection instead of claiming missing declarations are empty', inspection => {
    const graph = layout([syntheticNode('A-1')]);
    const summary = unlinked(inspection === 'complete' ? 'no-reference' : 'unknown', inspection);
    expect(graphGroupDateSummaries(graph, response([{ id: 'A-1', summary }])).get(graph.groups[0].key)).toEqual(summary);
  });
  it('matches main aggregation for mixed states and deterministic timestamp/repository/SHA/task/reference ties', () => {
    const nodes = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'].map(id => syntheticNode(id));
    const tasks: LinkedDateTask[] = nodes.map((node, i) => ({ id: node.id,
      references: i === 3 ? [] : ['reference'], inspection: i === 4 ? 'partial' : 'complete' }));
    const resolutions: LinkedDatesResult['tasks'] = tasks.map((task, i) => ({ id: task.id,
      references: i === 3 ? [] : i === 4 ? [{ state: 'unresolved', declaredReference: 'reference', reason: 'unavailable' }]
        : [{ state: 'resolved', declaredReference: 'reference', commits: [evidence(task.id, undefined, i === 0 ? 'zeta' : 'alpha', (i === 2 ? 'b' : 'a').repeat(40))] }] }));
    const graph = layout(nodes), dates = response(tasks.map((task, i) => ({ id: task.id, summary: summarizeLinkedDates([task], [resolutions[i]]) })));
    expect(graphGroupDateSummaries(graph, dates).get(graph.groups[0].key)).toEqual(summarizeLinkedDates(tasks, resolutions));
    expect(graphGroupDateSummaries(graph, { ...dates, tasks: [...dates.tasks].reverse() })).toEqual(graphGroupDateSummaries(graph, dates));
  });
});

describe('graph overview KST date presentation', () => {
  it('uses the KST year across UTC midnight and year boundaries', () => {
    const summary = resolved('A-1', '2026-12-31T16:00:00.000Z');
    expect(graphDateYearContext([summary])).toBe('2027');
    expect(graphDateShortLabel(summary, '2027')).toBe('01.01');
    expect(graphDateShortLabel(summary, '2026')).toBe('2027.01.01');
    expect(graphDateShortLabel(summary)).toBe('2027.01.01');
  });
  it('retains years for multi-year data, including adjacent instants crossing KST New Year', () => {
    const summaries = [resolved('A-1', '2026-12-31T14:59:59.000Z'), resolved('B-1', '2026-12-31T15:00:00.000Z')];
    const year = graphDateYearContext(summaries);
    expect(year).toBeUndefined();
    expect(summaries.map(summary => graphDateShortLabel(summary, year))).toEqual(['2026.12.31', '2027.01.01']);
  });
  it('keeps card text date-only and leaves partial coverage for evidence details', () => {
    expect(graphDateShortLabel(resolved('A-1', undefined, 1), '2027')).toBe('01.01');
    expect(graphDateShortLabel(unlinked())).toBe('미확인');
    expect(graphDateShortLabel(unlinked('unknown'))).toBe('미확인');
    expect(graphDateShortLabel(undefined)).toBe('미확인');
    expect(graphDateShortLabel(null)).toBe('미확인');
    expect(graphDateYearContext([undefined, unlinked(), resolved('A-1')])).toBe('2027');
    expect(graphDateYearContext([undefined, null, unlinked()])).toBeUndefined();
  });
  it('does not manufacture dates or year context from invalid instants', () => {
    const invalid = resolved('A-1', '2026-02-30T00:00:00Z');
    expect(graphDateShortLabel(invalid)).toBe('미확인');
    expect(graphDateYearContext([invalid])).toBeUndefined();
  });
});
