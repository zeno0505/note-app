import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { layoutTaskGraph } from '../../src/phase2/graph';
import { filterTasks, interpretTasks, parseTaskPolicy, taskFilterOptions, taskPhaseKey, TASK_STATUS_OPTIONS,
  type ObservedPrReview, type TaskInput, type TaskInterpretationContext, type TaskPolicyDeclaration } from '../../src/phase2/tasks';

const observedAt = '2026-10-07T15:00:00Z';
const context = (patch: Partial<TaskInterpretationContext> = {}): TaskInterpretationContext => ({
  projectId: 'project-a', dagId: 'dag-a', sourceHash: 'sha256:fixture-only', observedAt, ...patch,
});
const task = (id = 'T-001', patch: Partial<TaskInput> = {}): TaskInput => ({
  id, title: `Synthetic ${id}`, status: 'pending', rawType: 'implementation', phase: { id: 'phase-a', title: '기능', index: 0 },
  dependencies: [], e2e: { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' },
  commitReferences: [], commitVerification: 'not-performed', ...patch,
});
const policy = (patch: Partial<TaskPolicyDeclaration> = {}): TaskPolicyDeclaration => ({
  schemaVersion: 1, id: 'project-policy', revision: 'r1', mappingVersion: 'mapping-1', scope: { projectId: 'project-a', dagId: 'dag-a' },
  statuses: { pending: { lifecycle: 'before' }, active: { lifecycle: 'in-progress' }, review: { lifecycle: 'review' }, done: { lifecycle: 'done' } }, ...patch,
});
const review = (patch: Partial<ObservedPrReview> = {}): ObservedPrReview => ({ kind: 'observed-pr-review', projectId: 'project-a', dagId: 'dag-a',
  taskId: 'T-001', state: 'awaiting-review', observedAt, url: 'https://github.com/example/synthetic/pull/1', ...patch });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

describe('Phase 2 explicit task policy interpretation', () => {
  it('has exactly the requested seven values and Korean labels', () => {
    expect(TASK_STATUS_OPTIONS).toEqual([
      { value: 'all', label: '전체' }, { value: 'before', label: '작업 전' }, { value: 'in-progress', label: '진행 중' },
      { value: 'review', label: '검토 대기' }, { value: 'discussion', label: '논의 필요' }, { value: 'verification', label: '검증 필요' },
      { value: 'done', label: '완료' },
    ]);
  });

  it.each(['done', 'committed', 'blocked', 'deferred', 'superseded', 'future-status', null])('never infers a lifecycle from %s without policy', status => {
    const original = freeze(task('T-001', { status })), [row] = interpretTasks([original], context());
    expect(row).toMatchObject({ rawStatus: status, lifecycle: 'unknown', review: false, discussion: false, verification: false });
    expect(row.reasons).toContainEqual(expect.objectContaining({ code: 'missing-policy' }));
    expect(filterTasks([row], { status: 'all' })).toEqual([row]);
    expect(filterTasks([row], { status: 'done' })).toEqual([]);
    expect(row.task).toBe(original);
  });

  it('allows intentionally different project/type semantics for the same raw status', () => {
    const planning = policy({ scope: { projectId: 'project-a', taskTypes: ['planning'] }, statuses: { committed: { lifecycle: 'done', reason: '계획 결과물 완료' } } });
    const development = policy({ id: 'development-policy', scope: { projectId: 'project-a', taskTypes: ['implementation'] }, statuses: { committed: { lifecycle: 'review' } } });
    const elsewhere = policy({ id: 'elsewhere', scope: { projectId: 'project-b' }, statuses: { committed: { lifecycle: 'in-progress' } } });
    const tasks = freeze([task('T-001', { status: 'committed', rawType: 'planning' }), task('T-002', { status: 'committed' })]);
    const rows = interpretTasks(tasks, context({ policies: freeze([planning, development, elsewhere]) }));
    expect(rows.map(row => row.lifecycle)).toEqual(['done', 'review']);
    expect(rows[0].rawType).toBe('planning');
    expect(rows[0].reasons.some(reason => reason.message === '계획 결과물 완료')).toBe(true);
    expect(interpretTasks([tasks[1]], context({ projectId: 'project-b', policies: [planning, development, elsewhere] }))[0].lifecycle).toBe('in-progress');
    expect(rows.every(row => row.verificationState === 'not-performed')).toBe(true);
  });

  it('accepts Vue reactive declarations and detaches policy metadata without mutating source', () => {
    const declared = reactive(policy({ scope: { projectId: 'project-a', taskTypes: ['implementation'] } }));
    const source = reactive([task()]);
    const [row] = interpretTasks(source, context({ policies: [declared] }));
    expect(row.lifecycle).toBe('before');
    expect(row.policy).not.toBe(declared);
    expect(row.policy?.scope.taskTypes).not.toBe(declared.scope.taskTypes);
    declared.statuses.pending.lifecycle = 'done';
    expect(row.policy?.statuses.pending.lifecycle).toBe('before');
    expect(row.task.status).toBe('pending');
  });

  it('supports the pinned policy envelope without treating unrelated conventions as lifecycle conflicts', () => {
    const declarations = freeze([
      { key: 'base_branch', decision: 'main', legacy: false },
      { key: 'commit_convention', decision: { template: 'type: subject' }, legacy: false },
      { key: 'note_app_status_mapping', decision: policy(), legacy: false },
    ]);
    const [row] = interpretTasks([task()], context({ policies: declarations }));
    expect(row.lifecycle).toBe('before');
    expect(row.policy).toEqual(policy());
    expect(declarations).toHaveLength(3);
    expect(parseTaskPolicy(declarations[0])).toMatchObject({ ok: false, ignored: 'unrelated-policy' });
  });

  it('excludes explicitly legacy envelope history while retaining current revision conflict checks', () => {
    const history = { key: 'note_app_status_mapping', legacy: true, decision: 'old free-text convention' };
    const current = { key: 'note_app_status_mapping', legacy: false, decision: policy() };
    expect(parseTaskPolicy(history)).toMatchObject({ ok: false, ignored: 'legacy-policy' });
    expect(interpretTasks([task()], context({ policies: [history, current] }))[0].lifecycle).toBe('before');
    expect(interpretTasks([task()], context({ policies: [history] }))[0].lifecycle).toBe('unknown');
    const conflicting = { ...current, decision: policy({ revision: 'r2', statuses: { pending: { lifecycle: 'done' } } }) };
    const [row] = interpretTasks([task()], context({ policies: [history, current, conflicting] }));
    expect(row.lifecycle).toBe('unknown');
    expect(row.reasons).toContainEqual(expect.objectContaining({ code: 'ambiguous-revision' }));
  });

  it.each([
    { key: 'note_app_status_mapping', decision: policy() },
    { key: 'note_app_status_mapping', decision: policy(), legacy: 'false' },
    { key: 'note_app_status_mapping', decision: 'done means complete', legacy: false },
    { key: 'note_app_status_mapping', decision: { key: 'unrelated', legacy: true }, legacy: false },
  ])('keeps malformed current mapping envelopes unknown alongside a valid declaration (%j)', declaration => {
    const [row] = interpretTasks([task()], context({ policies: [policy(), declaration] }));
    expect(row.lifecycle).toBe('unknown');
    expect(row.reasons).toContainEqual(expect.objectContaining({ code: 'invalid-policy' }));
  });

  it('selects an explicit revision chain irrespective of input order or lexical revision ordering', () => {
    const old = policy({ revision: 'z-old', statuses: { committed: { lifecycle: 'review' } } });
    const middle = policy({ revision: 'middle', mappingVersion: 'v2', supersedes: [{ id: old.id, revision: old.revision }], statuses: { committed: { lifecycle: 'before' } } });
    const latest = policy({ revision: 'a-new', mappingVersion: 'v3', supersedes: [{ id: middle.id, revision: middle.revision }], statuses: { committed: { lifecycle: 'done' } } });
    for (const policies of [[old, latest, middle], [latest, middle, old]]) {
      const [row] = interpretTasks([task('T-001', { status: 'committed' })], context({ policies }));
      expect(row).toMatchObject({ lifecycle: 'done', policy: { revision: 'a-new', mappingVersion: 'v3' }, provenance: { sourceHash: 'sha256:fixture-only', observedAt } });
    }
    expect(interpretTasks([task('T-001', { status: 'committed' })], context({ policies: [old] }))[0].lifecycle).toBe('review');
  });

  it('rejects unlinked revisions, duplicate identities, branches and cyclic revisions', () => {
    const old = policy(), next = policy({ revision: 'r2' });
    const branches = [old, policy({ revision: 'r2', supersedes: [{ id: old.id, revision: 'r1' }] }), policy({ revision: 'r3', supersedes: [{ id: old.id, revision: 'r1' }] })];
    const cycle = [policy({ supersedes: [{ id: old.id, revision: 'r2' }] }), policy({ revision: 'r2', supersedes: [{ id: old.id, revision: 'r1' }] })];
    for (const policies of [[old, next], [old, old], branches, cycle, [policy({ supersedes: [{ id: old.id, revision: old.revision }] })]]) {
      const [row] = interpretTasks([task()], context({ policies }));
      expect(row.lifecycle).toBe('unknown');
      expect(row.reasons).toContainEqual(expect.objectContaining({ code: 'ambiguous-revision' }));
    }
  });

  it('does not choose narrower scope implicitly, even if a conflicting declaration claims to supersede', () => {
    const wide = policy({ scope: { projectId: 'project-a' } });
    const narrow = policy({ revision: 'r2', supersedes: [{ id: wide.id, revision: wide.revision }] });
    const [row] = interpretTasks([task()], context({ policies: [wide, narrow] }));
    expect(row.lifecycle).toBe('unknown');
    expect(row.reasons).toContainEqual(expect.objectContaining({ code: 'ambiguous-scope' }));
  });

  it('matches phase/task scopes exactly and treats reordered scope sets as equivalent', () => {
    const scope = { projectId: 'project-a', phaseIds: ['phase-a', 'phase-b'], taskIds: ['T-001', 'T-002'] };
    const old = policy({ scope });
    const latest = policy({ revision: 'r2', scope: { ...scope, phaseIds: [...scope.phaseIds].reverse(), taskIds: [...scope.taskIds].reverse() }, supersedes: [{ id: old.id, revision: old.revision }] });
    const rows = interpretTasks([task(), task('T-002', { phase: null }), task('T-003')], context({ policies: [old, latest] }));
    expect(rows.map(row => row.lifecycle)).toEqual(['before', 'unknown', 'unknown']);
  });

  it.each([
    'free text convention', {}, { ...policy(), schemaVersion: 0 }, { ...policy(), mappingVersion: null },
    { ...policy(), scope: {} }, { ...policy(), scope: { projectId: 'project-a', taskType: ['planning'] } },
    { ...policy(), scope: { projectId: 'project-a', taskTypes: [] } }, { ...policy(), scope: { projectId: 'project-a', taskTypes: ['planning', 'planning'] } },
    { ...policy(), supersedes: ['r1'] }, { ...policy(), statuses: { done: { lifecycle: 'unknown' } } },
    { ...policy(), statuses: { done: { lifecycle: 'done', verification: 'true' } } },
    { ...policy(), statuses: { done: { lifecycle: new String('done') } } },
    { ...policy(), sourceMtimeMs: 999999999 },
  ])('retains unsupported/malformed declarations as unknown instead of guessing (%j)', declaration => {
    expect(parseTaskPolicy(declaration).ok).toBe(false);
    const [row] = interpretTasks([task()], context({ policies: [policy(), declaration] }));
    expect(row.lifecycle).toBe('unknown');
    expect(row.reasons).toContainEqual(expect.objectContaining({ code: 'invalid-policy' }));
  });

  it('does not let a malformed policy for another project or DAG block this scope', () => {
    const [row] = interpretTasks([task()], context({ policies: [policy(), { scope: { projectId: 'elsewhere' } }, { scope: { projectId: 'project-a', dagId: 'elsewhere' } }] }));
    expect(row.lifecycle).toBe('before');
  });

  it('keeps a new status/type, source provenance and partial collection explicit', () => {
    const [row] = interpretTasks([task('NEW-001', { status: 'future-status', rawType: 'future-type' })], context({ policies: [policy()], partial: true, omittedTaskCount: 14 }));
    expect(row).toMatchObject({ rawType: 'future-type', rawStatus: 'future-status', lifecycle: 'unknown',
      policy: { id: 'project-policy', revision: 'r1', mappingVersion: 'mapping-1' }, provenance: { partial: true, omittedTaskCount: 14 } });
    expect(row.reasons.map(reason => reason.code)).toContain('unmapped-status');
    expect(row.reasons.map(reason => reason.code)).toContain('partial-observation');
  });

  it('keeps done + verification and discussion independent without modifying source status', () => {
    const original = freeze(task('T-001', { status: 'done', e2e: { state: 'declared', required: true, coveredBy: [], coverage: 'unmet' } }));
    const [row] = interpretTasks([original], context({ policies: [policy({ statuses: { done: { lifecycle: 'done', discussion: true } } })] }));
    expect(row).toMatchObject({ lifecycle: 'done', verification: true, discussion: true, rawStatus: 'done', verificationState: 'not-performed' });
    for (const status of ['all', 'done', 'discussion', 'verification'] as const) expect(filterTasks([row], { status })).toEqual([row]);
    expect(row.reasons.map(reason => reason.code)).toContain('e2e-unmet');
    expect(original.status).toBe('done');
  });

  it('treats malformed E2E as verification-needed even when lifecycle is unknown', () => {
    const [row] = interpretTasks([task('T-001', { status: 'future-status', e2e: { state: 'declared', required: null, coveredBy: null, coverage: 'malformed' } })], context());
    expect(row).toMatchObject({ lifecycle: 'unknown', verification: true });
    expect(row.reasons.map(reason => reason.code)).toContain('e2e-malformed');
    expect(filterTasks([row], { status: 'verification' })).toEqual([row]);
  });

  it('never promotes declared E2E/commits, review links or details to verified/observed facts', () => {
    const [row] = interpretTasks([task('T-001', { status: 'done', e2e: { state: 'declared', required: true, coveredBy: ['proof.png'], coverage: 'references-declared' },
      commitReferences: ['abc123'], details: { description: 'https://github.com/example/synthetic/pull/1 awaiting review', acceptanceCriteria: [],
        targetFiles: [], discussion: ['discuss.md'], design: ['design.md'], omissions: 0 } })], context({ policies: [policy()] }));
    expect(row).toMatchObject({ lifecycle: 'done', review: false, discussion: false, verification: false, verificationState: 'not-performed', prReviews: [] });
    expect(row.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['e2e-unverified', 'commits-unverified']));
  });

  it('adds review only for task-bound, explicit valid observations or an explicit policy', () => {
    const ignored = [review({ projectId: 'elsewhere' }), review({ dagId: 'elsewhere' }), review({ taskId: 'T-002' }), review({ observedAt: 'not a date' }),
      review({ url: 'javascript:alert(1)' }), review({ kind: 'declared-link' as never }), review({ state: 'unknown' })];
    expect(interpretTasks([task()], context({ prReviews: ignored }))[0].review).toBe(false);
    const [row] = interpretTasks([task()], context({ prReviews: [review()] }));
    expect(row).toMatchObject({ lifecycle: 'unknown', review: true });
    expect(filterTasks([row], { status: 'review' })).toEqual([row]);
    expect(row.prReviews[0]).toMatchObject({ url: review().url, observedAt });
    expect(interpretTasks([task('T-001', { status: 'review' })], context({ policies: [policy()] }))[0].review).toBe(true);
  });

  it('uses latest observed PR state and preserves equal-time conflicts as unknown', () => {
    const awaited = review(), reviewed = review({ state: 'reviewed', observedAt: '2026-10-07T15:01:00Z' });
    expect(interpretTasks([task()], context({ prReviews: [reviewed, awaited] }))[0].review).toBe(false);
    const conflict = interpretTasks([task()], context({ prReviews: [awaited, review({ state: 'reviewed' })] }))[0];
    expect(conflict.review).toBe(false);
    expect(conflict.prReviews[0].state).toBe('unknown');
  });
});

describe('Phase 2 pure task filtering', () => {
  const source = [task('T-001', { title: '검증 경로', status: 'done', rawType: 'planning' }),
    task('F-001', { status: 'active', rawType: 'feature', phase: { id: 'phase-b', title: '구현', index: 1 } }),
    task('F-002', { status: 'done', rawType: 'all', phase: { id: null, title: null, index: 2 } }),
    task('unparsed-id', { rawType: null, phase: null, status: 'new-status' })];
  const rows = interpretTasks(freeze(source), context({ policies: [policy()] }));
  it('keeps type union, phase memberships and parsed prefixes independent', () => {
    expect(taskFilterOptions(rows)).toEqual({ types: ['all', 'feature', 'planning'], prefixes: ['F', 'T'], phases: [
      { value: 'id:phase-a', label: '기능' }, { value: 'id:phase-b', label: '구현' }, { value: 'index:2', label: 'Phase 3' }, { value: 'unassigned', label: '소속 미확인' },
    ] });
    expect(taskPhaseKey(source[0])).toBe('id:phase-a');
    expect(filterTasks(rows, { status: 'all' })).toHaveLength(4);
    expect(filterTasks(rows, { type: 'all' }).map(row => row.task.id)).toEqual(['F-002']);
    expect(filterTasks(rows, { type: null })).toHaveLength(4);
    expect(filterTasks(rows, { phase: 'unassigned' }).map(row => row.task.id)).toEqual(['unparsed-id']);
  });
  it('combines search/type/phase/prefix/status without mutating source order', () => {
    expect(filterTasks(rows, { status: 'done', search: ' 검증 ', type: 'planning', phase: 'id:phase-a', prefix: 'T' }).map(row => row.task.id)).toEqual(['T-001']);
    expect(filterTasks(rows, { status: 'in-progress', prefix: 'F', search: 'FEATURE' }).map(row => row.task.id)).toEqual(['F-001']);
    expect(filterTasks(rows, { prefix: 'F-' })).toEqual([]);
    expect(filterTasks(rows, { status: 'done', type: 'feature' })).toEqual([]);
    expect(rows.map(row => row.task.id)).toEqual(source.map(value => value.id));
  });
});

describe('Phase 2 read-only lightweight graph', () => {
  it('lays out dependencies before dependants with deterministic geometry and phase metadata', () => {
    const tasks = freeze([task('T-003', { dependencies: [{ id: 'T-002', scope: 'internal' }] }), task('T-001'), task('T-002', { dependencies: [{ id: 'T-001', scope: 'internal' }] })]);
    const first = layoutTaskGraph(tasks), reordered = layoutTaskGraph([...tasks].reverse());
    expect(first).toEqual(reordered);
    expect(first.readOnly).toBe(true);
    expect(first.nodes.map(node => [node.id, node.layer, node.phase])).toEqual([['T-001', 0, 'id:phase-a'], ['T-002', 1, 'id:phase-a'], ['T-003', 2, 'id:phase-a']]);
    expect(first.edges.every(edge => edge.kind === 'internal' && edge.path?.startsWith('M '))).toBe(true);
    expect(first.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it('distinguishes hidden dependencies, external references and missing internal IDs', () => {
    const tasks = [task('T-001'), task('T-002', { dependencies: [
      { id: 'T-001', scope: 'internal' }, { id: 'EXT-001', scope: 'external' }, { id: 'UNKNOWN-001', scope: 'internal' },
    ] })];
    const graph = layoutTaskGraph(tasks, new Set(['T-002']));
    expect(graph.nodes.map(node => node.id)).toEqual(['T-002']);
    expect(graph.diagnostics).toMatchObject({ hiddenNodeCount: 1, hiddenDependencies: [{ taskId: 'T-002', dependencyId: 'T-001' }],
      externalDependencies: [{ taskId: 'T-002', dependencyId: 'EXT-001' }], unknownDependencies: [{ taskId: 'T-002', dependencyId: 'UNKNOWN-001' }] });
    expect(graph.edges.map(edge => edge.kind).sort()).toEqual(['external', 'hidden', 'unknown']);
    expect(graph.edges.every(edge => edge.path === null)).toBe(true);
    expect(graph.nodes[0].layer).toBe(1);
  });

  it('reports exact cyclic components including self-cycles without mislabelling downstream nodes', () => {
    const tasks = [task('T-001', { dependencies: [{ id: 'T-002', scope: 'internal' }] }),
      task('T-002', { dependencies: [{ id: 'T-001', scope: 'internal' }] }),
      task('T-003', { dependencies: [{ id: 'T-002', scope: 'internal' }] }),
      task('T-004', { dependencies: [{ id: 'T-004', scope: 'internal' }] })];
    const graph = layoutTaskGraph(tasks);
    expect(graph.diagnostics.cycles).toEqual([['T-001', 'T-002'], ['T-004']]);
    expect(graph.nodes.find(node => node.id === 'T-003')).toMatchObject({ cycle: false, layer: 1 });
    expect(graph.edges.filter(edge => edge.kind === 'cycle')).toHaveLength(3);
    expect(graph.nodes.every(node => node.x >= 0 && node.y >= 0)).toBe(true);
    expect(layoutTaskGraph(tasks, ['T-003']).diagnostics.cycles).toEqual(graph.diagnostics.cycles);
  });

  it('deduplicates repeated edges and diagnoses ambiguous duplicate task IDs instead of inventing a node', () => {
    const graph = layoutTaskGraph([task('T-001'), task('T-001'), task('T-002', { dependencies: [{ id: 'T-001', scope: 'internal' }, { id: 'T-001', scope: 'internal' }] })]);
    expect(graph.nodes.map(node => node.id)).toEqual(['T-002']);
    expect(graph.diagnostics.duplicateTaskIds).toEqual(['T-001']);
    expect(graph.diagnostics.unknownDependencies).toEqual([{ taskId: 'T-002', dependencyId: 'T-001' }]);
    expect(graph.edges).toHaveLength(1);
  });

  it('handles empty and fully filtered graphs without fabricating nodes', () => {
    expect(layoutTaskGraph([])).toMatchObject({ nodes: [], edges: [], width: 320, height: 160 });
    expect(layoutTaskGraph([task()], [])).toMatchObject({ nodes: [], edges: [], diagnostics: { hiddenNodeCount: 1 } });
  });

  it('records a bounded synthetic 500-task benchmark without claiming a UI/Mac acceptance threshold', () => {
    const fixture = Array.from({ length: 500 }, (_, index) => task(`T-${String(index + 1).padStart(3, '0')}`, {
      status: index % 2 ? 'done' : 'active', phase: { id: `phase-${Math.floor(index / 100)}`, title: `Synthetic phase ${Math.floor(index / 100)}`, index: Math.floor(index / 100) },
      dependencies: index > 0 ? [{ id: `T-${String(Math.floor((index - 1) / 3) + 1).padStart(3, '0')}`, scope: 'internal' }] : [],
    }));
    const heapBefore = process.memoryUsage().heapUsed, start = performance.now();
    const rows = interpretTasks(fixture, context({ policies: [policy()] }));
    const interpreted = performance.now(), graph = layoutTaskGraph(fixture), laidOut = performance.now();
    const filtered = filterTasks(rows, { status: 'done' }), filteredGraph = layoutTaskGraph(fixture, filtered.map(row => row.task.id)), switched = performance.now();
    for (let index = 0; index < 500; index++) expect(graph.nodes.find(node => node.id === fixture[index].id)?.task).toBe(fixture[index]);
    const selected = performance.now();
    const measurement = { fixture: 'synthetic-500-not-real-459', taskCount: fixture.length, edgeCount: graph.edges.length,
      interpretationMs: interpreted - start, layoutMs: laidOut - interpreted, filterAndLayoutMs: switched - laidOut,
      repeatedLookupMs: selected - switched, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore };
    expect(graph.nodes).toHaveLength(500); expect(graph.edges).toHaveLength(499); expect(filteredGraph.nodes).toHaveLength(250);
    for (const duration of [measurement.interpretationMs, measurement.layoutMs, measurement.filterAndLayoutMs, measurement.repeatedLookupMs]) expect(Number.isFinite(duration) && duration >= 0).toBe(true);
    console.info('Phase 2 pure-module measurement; no browser/paint/worker/Mac claim:', JSON.stringify(measurement));
  });
});
