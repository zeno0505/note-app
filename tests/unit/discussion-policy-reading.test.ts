import {describe, expect, it} from 'vitest';
import {buildProjectModelPack, type ProjectModelSource} from '../../src/main/project-model';
import {interpretTasks, type TaskPolicyDeclaration} from '../../src/phase2/tasks';
import type {LiveDagTaskView} from '../../src/shared/live';
import {createReadingScheduler, explainReading, type ReadingInput} from '../../src/summary/reading';
import {prefixReading, scopedDagView} from '../../src/summary/reading/prefix';
import {exactTaskScope} from '../../src/summary/reading/scoped-project';

const at = '2026-10-07T00:00:00Z';
function task(id: string, status = 'pending'): LiveDagTaskView {
  return {id, title: id, status, dependencies: [], commitReferences: [], commitVerification: 'not-performed',
    e2e: {state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared'},
    displayOmissions: {dependencies: 0, commitReferences: 0, e2eReferences: 0}};
}
function policy(discussion?: boolean, patch: Partial<TaskPolicyDeclaration> = {}): Record<string, unknown> {
  return {key: 'note_app_status_mapping', legacy: false, decision: {
    schemaVersion: 1, id: 'discussion-policy', revision: 'r1', mappingVersion: 'v1',
    scope: {projectId: 'work-1', dagId: 'dag-1'},
    statuses: {pending: {lifecycle: 'before', ...(discussion === undefined ? {} : {discussion})}}, ...patch,
  }};
}
function input(policies: Record<string, unknown>[] = [policy()]): ReadingInput {
  return {workstream: {id: 'work-1', title: 'Synthetic', projectName: 'Synthetic', branch: 'main', archived: false,
    terminalConnected: false, terminalCount: 0, agentState: 'unknown', projectMapping: 'matched',
    noteMapping: {state: 'resolved', reason: null, dagId: 'dag-1'}},
  dag: {dagId: 'dag-1', sourceHash: 'a'.repeat(64), readContractVersion: 2, policies,
    state: 'ready', reason: null, observedAt: at, unchanged: false, taskCount: 1, displayedTaskCount: 1,
    tasks: [task('T-1')], statusCounts: [], statusCountTotal: 0, statusCountsOmitted: 0,
    summary: {state: 'empty', reason: 'No model', revision: null, candidateClaims: [], approvedClaims: [], approvedAt: null, context: null}}};
}
function modelSource(data: ReadingInput): ProjectModelSource {
  const dag = data.dag!;
  return {projectKey: 'project:' + 'a'.repeat(64), policyProjectId: data.workstream.id,
    mappingIdentity: 'synthetic', codeburn: [],
    dag: {dagId: dag.dagId, sourceHash: dag.sourceHash!, sourceMtimeMs: 1, observedAt: at,
      doneStatus: 'done', readContractVersion: dag.readContractVersion, policies: dag.policies, tasks: dag.tasks,
      statusCounts: [], coverage: {tasksTotal: dag.tasks.length, declared: 0, required: 0, uncoveredDone: [], uncoveredOpen: [], malformed: []}, verifiedFacts: []},
    readingSummary: {kind: 'rules-only', workstreamId: data.workstream.id, fingerprint: 'synthetic', revision: 1,
      generatedAt: at, checkedAt: at, changed: false, limitation: 'bounded', ...explainReading(data, {state: 'unconfigured'})}};
}
const decisions = (data: ReadingInput) => explainReading(data, {state: 'unconfigured'}).sections.find(section => section.id === 'decisions')!;
const decisionText = (data: ReadingInput) => decisions(data).paragraphs.map(p => p.text).join('\n');
const policyRows = (data: ReadingInput) => JSON.parse(buildProjectModelPack(modelSource(data)).sources.find(s => s.path === 'dag/selected-policy.json')!.excerpt).tasks;

describe('discussion policy evidence in reading summaries', () => {
  it.each([true, false, undefined])('keeps explicit %s distinct from unknown through interpretation and the model pack', value => {
    const data = input([policy(value)]);
    const [row] = interpretTasks(data.dag!.tasks, {projectId: 'work-1', dagId: 'dag-1', sourceHash: null, observedAt: at, policies: data.dag!.policies});
    expect(row.discussion).toBe(value === true);
    expect(row.discussionRequirement).toBe(value ?? null);
    expect(policyRows(data)[0].discussion).toBe(value ?? null);
    if (value === undefined) expect(decisionText(data)).toContain('논의가 필요한지');
    else {
      expect(decisionText(data)).toContain(`명시 정책에서 논의 ${value ? '필요' : '불필요'}로 선언된 작업: T-1`);
      expect(decisionText(data)).not.toContain('논의가 필요한지');
      expect(decisionText(data)).toContain('설계가 끝나 구현만 남았는지는 미확인');
    }
  });

  it.each([true, false, undefined])('keeps %s consistent through prefixReading and buildProjectModelPack', value => {
    const data = input([policy(value)]), source = modelSource(data);
    source.summaryPrefix = 'T';
    source.readingSummary = prefixReading(data.workstream, scopedDagView(data.dag!, source.dag));
    const pack = buildProjectModelPack(source);
    const row = JSON.parse(pack.sources.find(s => s.path === 'dag/selected-policy.json')!.excerpt).tasks[0];
    const prose = pack.facts.filter(f => f.section === 'decisions').map(f => f.text).join('\n');
    expect(row.discussion).toBe(value ?? null);
    if (value === undefined) {
      expect(prose).toContain('논의가 필요한지');
      expect(prose).not.toContain('논의 불필요로 선언');
    } else {
      expect(prose).toContain(`명시 정책에서 논의 ${value ? '필요' : '불필요'}로 선언된 작업: T-1`);
      expect(prose).not.toContain('논의가 필요한지');
      expect(prose).toContain('설계가 끝나 구현만 남았는지는 미확인');
    }
  });

  it.each([
    ['missing', []],
    ['unmapped status', [policy(true, {statuses: {other: {lifecycle: 'before', discussion: true}}})]],
    ['foreign project', [policy(true, {scope: {projectId: 'other'}})]],
    ['foreign task', [policy(true, {scope: {projectId: 'work-1', taskIds: ['T-2']}})]],
    ['legacy', [{...policy(true), legacy: true}]],
    ['invalid', [{...policy(true), legacy: 'false'}]],
    ['conflicting', [policy(true), policy(false, {id: 'competing-policy'})]],
  ] as const)('keeps %s policy discussion unknown instead of false', (_label, policies) => {
    const data = input([...policies]);
    expect(policyRows(data)[0].discussion).toBeNull();
    expect(decisionText(data)).toContain('논의가 필요한지');
    expect(decisionText(data)).not.toContain('논의 불필요로 선언');
    expect(decisionText(data)).not.toContain('논의 필요로 선언');
  });

  it('reports required, not required and unknown tasks separately without turning policy into design completion', () => {
    const data = input([policy(true, {statuses: {
      pending: {lifecycle: 'before', discussion: true}, done: {lifecycle: 'done', discussion: false},
      active: {lifecycle: 'in-progress'},
    }})]);
    data.dag!.tasks = [task('T-1'), task('T-2', 'done'), task('T-3', 'active')];
    data.dag!.taskCount = data.dag!.displayedTaskCount = 3;
    const result = decisions(data), text = decisionText(data);
    expect(text).toContain('논의 필요로 선언된 작업: T-1');
    expect(text).toContain('논의 불필요로 선언된 작업: T-2');
    expect(text).toContain('정책 해석이 미확인인 작업: T-3');
    expect(text).not.toContain('논의가 필요한지');
    expect(result.designState).toBe('unrecorded');
    expect(result.paragraphs[0]).toMatchObject({basis: 'declaration', sources: [expect.objectContaining({kind: 'dag', id: 'dag-1'})]});
    expect(Object.fromEntries(policyRows(data).map((row: {id: string; discussion: boolean | null}) => [row.id, row.discussion]))).toEqual({'T-1': true, 'T-2': false, 'T-3': null});
    const pack = buildProjectModelPack(modelSource(data));
    expect(pack.facts.filter(f => f.section === 'decisions').map(f => f.text).join('\n')).toContain('논의 필요로 선언된 작업: T-1');
  });

  it.each(['unresolved', 'error', 'foreign-dag', 'legacy-contract'] as const)('does not apply unavailable or unbound %s policy', state => {
    const data = input([policy(true)]);
    if (state === 'unresolved') data.workstream.noteMapping.state = 'unresolved';
    else if (state === 'error') data.dag!.state = 'error';
    else if (state === 'foreign-dag') data.dag!.dagId = 'elsewhere';
    else delete data.dag!.readContractVersion;
    expect(decisionText(data)).toContain('논의가 필요한지');
    expect(decisionText(data)).not.toContain('논의 필요로 선언');
  });

  it('regenerates cached prose when only the discussion policy changes', async () => {
    const data = input([policy(true)]), scheduler = createReadingScheduler({now: () => Date.parse(at)});
    const update = async () => (await scheduler.update([data], new AbortController().signal))[0];
    const first = await update();
    data.dag!.policies = [policy(false)];
    const second = await update();
    expect(second.revision).toBe(first.revision + 1);
    expect(second.sections.find(s => s.id === 'decisions')!.paragraphs[0].text).toContain('논의 불필요로 선언');
    data.dag!.policies = [];
    const third = await update();
    expect(third.revision).toBe(second.revision + 1);
    expect(third.sections.find(s => s.id === 'decisions')!.paragraphs[0].text).toContain('논의가 필요한지');
  });

  it('uses current read-model policies rather than earlier display policies in prefix summaries', () => {
    const data = input([policy(false)]), current = modelSource(input([policy(true)])).dag;
    const view = scopedDagView(data.dag!, current);
    expect(prefixReading(data.workstream, view).sections.find(s => s.id === 'decisions')!.paragraphs[0].text).toContain('논의 필요로 선언');
    const legacy = {...current, readContractVersion: undefined, policies: undefined};
    expect(prefixReading(data.workstream, scopedDagView(data.dag!, legacy)).sections.find(s => s.id === 'decisions')!.paragraphs[0].text).toContain('논의가 필요한지');
  });

  it('changes the prefix fingerprint when v2 becomes legacy even if policy bytes are retained', () => {
    const data = input([policy(true)]), model = modelSource(data).dag;
    const current = prefixReading(data.workstream, scopedDagView(data.dag!, model));
    const legacy = prefixReading(data.workstream, scopedDagView(data.dag!, {...model, readContractVersion: undefined}));
    expect(legacy.fingerprint).not.toBe(current.fingerprint);
    expect(legacy.sections.find(s => s.id === 'decisions')!.paragraphs[0].text).toContain('논의가 필요한지');
    expect(current.sections.find(s => s.id === 'decisions')!.paragraphs[0].text).toContain('논의 필요로 선언');
  });

  it('changes the exact-task semantic hash when only the read contract version changes', () => {
    const model = modelSource(input([policy(true)])).dag;
    const current = exactTaskScope(model, ['T-1']);
    const legacy = exactTaskScope({...model, readContractVersion: undefined}, ['T-1']);
    expect(legacy.sourceHash).not.toBe(current.sourceHash);
    expect(legacy.tasks).toEqual(current.tasks);
  });
});
