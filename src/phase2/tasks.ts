import type { DagTask } from '../facts/dag-read-model/types';
import { taskPrefix } from '../shared/summary-prefix';

export const TASK_STATUS_OPTIONS = [
  { value: 'all', label: '전체' },
  { value: 'before', label: '작업 전' },
  { value: 'in-progress', label: '진행 중' },
  { value: 'review', label: '검토 대기' },
  { value: 'discussion', label: '논의 필요' },
  { value: 'verification', label: '검증 필요' },
  { value: 'done', label: '완료' },
] as const;
export type TaskStatusFilter = typeof TASK_STATUS_OPTIONS[number]['value'];
export type TaskLifecycle = 'before' | 'in-progress' | 'review' | 'done' | 'unknown';
export interface TaskPolicyScope {
  projectId: string;
  dagId?: string;
  taskTypes?: readonly string[];
  phaseIds?: readonly string[];
  taskIds?: readonly string[];
}
export interface TaskPolicyReference { id: string; revision: string }
export interface TaskStatusMapping {
  lifecycle: Exclude<TaskLifecycle, 'unknown'>;
  discussion?: boolean;
  verification?: boolean;
  reason?: string;
}
/** Explicit, opt-in schema. Legacy/unknown documents are retained by the reader,
 * but do not silently acquire this schema's meaning. Revisions are opaque IDs. */
export interface TaskPolicyDeclaration extends TaskPolicyReference {
  schemaVersion: 1;
  scope: TaskPolicyScope;
  mappingVersion: string;
  supersedes?: readonly TaskPolicyReference[];
  statuses: Readonly<Record<string, TaskStatusMapping>>;
}
export const STATUS_MAPPING_POLICY_KEY = 'note_app_status_mapping';
export interface TaskPolicyEnvelope {
  key: typeof STATUS_MAPPING_POLICY_KEY;
  decision: TaskPolicyDeclaration;
  legacy: boolean;
}
export type TaskInput = DagTask & {
  rawType?: string | null;
  phase?: { id: string | null; title: string | null; index: number } | null;
  details?: { description: string | null; acceptanceCriteria: string[]; targetFiles: string[]; discussion: string[]; design: string[]; omissions: number };
};
/** A link or a declaration is not an observed PR review. Consumers must supply
 * this separately from DAG declarations, with its task binding and observation. */
export interface ObservedPrReview {
  kind: 'observed-pr-review';
  projectId: string;
  dagId: string;
  taskId: string;
  state: 'awaiting-review' | 'reviewed' | 'unknown';
  url: string;
  observedAt: string;
}
export interface TaskInterpretationContext {
  projectId: string;
  dagId: string;
  sourceHash: string | null;
  observedAt: string | null;
  policies?: readonly unknown[];
  prReviews?: readonly ObservedPrReview[];
  partial?: boolean;
  omittedTaskCount?: number;
}
export interface TaskReason {
  kind: 'policy' | 'unknown' | 'declaration' | 'observed';
  code: string;
  message: string;
}
export interface TaskInterpretation<T extends TaskInput = TaskInput> {
  task: T;
  rawType: string | null;
  rawStatus: string | null;
  lifecycle: TaskLifecycle;
  /** Independent flags, never an exclusive partition of the task count. */
  discussion: boolean;
  verification: boolean;
  review: boolean;
  verificationState: 'not-performed';
  policy: TaskPolicyDeclaration | null;
  prReviews: ObservedPrReview[];
  reasons: TaskReason[];
  provenance: {
    projectId: string; dagId: string; sourceHash: string | null; observedAt: string | null;
    interpretationVersion: 'phase2-task-v1'; partial: boolean; omittedTaskCount: number;
  };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(nonempty) && new Set(value).size === value.length;
const reference = (value: unknown): value is TaskPolicyReference => record(value) && nonempty(value.id) && nonempty(value.revision);
const allowed = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const refKey = (value: TaskPolicyReference) => JSON.stringify([value.id, value.revision]);
const scopeKey = (scope: TaskPolicyScope) => JSON.stringify([scope.projectId, scope.dagId ?? null,
  scope.taskTypes ? [...scope.taskTypes].sort() : null, scope.phaseIds ? [...scope.phaseIds].sort() : null,
  scope.taskIds ? [...scope.taskIds].sort() : null]);

/** Strict about semantic fields: misspelling a scope constraint must not widen it. */
export function parseTaskPolicy(input: unknown): { ok: true; value: TaskPolicyDeclaration } | { ok: false; reason: string; ignored?: 'unrelated-policy' | 'legacy-policy' } {
  let value = input;
  if (record(input) && nonempty(input.key)) {
    // The pinned --policy --all transport also includes conventions unrelated to
    // lifecycle. Only this explicit key opts into interpretation; history stays
    // in the read model, with legacy:true explicitly excluded from application.
    if (input.key !== STATUS_MAPPING_POLICY_KEY) return { ok: false, ignored: 'unrelated-policy', reason: '상태 매핑 이외의 원본 프로젝트 정책' };
    if (input.legacy === true) return { ok: false, ignored: 'legacy-policy', reason: '과거 정책 선언이며 현재 상태 해석에는 적용하지 않음' };
    if (input.legacy !== false || !allowed(input, ['key', 'decision', 'legacy'])) return { ok: false, reason: '명시 상태 정책 envelope의 현재·과거 구분이나 형식이 모호합니다' };
    value = input.decision;
  }
  if (!record(value) || value.schemaVersion !== 1 || !reference(value) || !nonempty(value.mappingVersion)) {
    return { ok: false, reason: '지원하는 명시 정책 형식·ID·개정·매핑 버전이 없습니다' };
  }
  if (!allowed(value, ['schemaVersion', 'id', 'revision', 'scope', 'mappingVersion', 'supersedes', 'statuses'])) {
    return { ok: false, reason: '지원하지 않는 정책 필드가 있어 의미를 확정할 수 없습니다' };
  }
  const scope = value.scope;
  if (!record(scope) || !nonempty(scope.projectId) || !allowed(scope, ['projectId', 'dagId', 'taskTypes', 'phaseIds', 'taskIds']) ||
      (own(scope, 'dagId') && !nonempty(scope.dagId)) ||
      ['taskTypes', 'phaseIds', 'taskIds'].some(key => own(scope, key) && !strings(scope[key]))) {
    return { ok: false, reason: '정책 적용 범위가 없거나 모호합니다' };
  }
  if (own(value, 'supersedes') && (!Array.isArray(value.supersedes) || !value.supersedes.every(item =>
      reference(item) && allowed(item as unknown as Record<string, unknown>, ['id', 'revision'])))) {
    return { ok: false, reason: '정책 개정 관계가 올바르지 않습니다' };
  }
  if (!record(value.statuses) || Object.keys(value.statuses).length === 0 || Object.entries(value.statuses).some(([status, mapping]) =>
    !nonempty(status) || !record(mapping) || !allowed(mapping, ['lifecycle', 'discussion', 'verification', 'reason']) ||
    typeof mapping.lifecycle !== 'string' || !['before', 'in-progress', 'review', 'done'].includes(mapping.lifecycle) ||
    ['discussion', 'verification'].some(key => own(mapping, key) && typeof mapping[key] !== 'boolean') ||
    (own(mapping, 'reason') && !nonempty(mapping.reason)))) {
    return { ok: false, reason: '상태별 명시 매핑이 없거나 지원하지 않는 형식입니다' };
  }
  // Copy only the validated fields. structuredClone rejects Vue reactive proxies,
  // which are legitimate reader inputs in the renderer.
  const declaration = value as unknown as TaskPolicyDeclaration;
  return { ok: true, value: {
    schemaVersion: 1, id: declaration.id, revision: declaration.revision, mappingVersion: declaration.mappingVersion,
    scope: { ...declaration.scope,
      ...(declaration.scope.taskTypes ? { taskTypes: [...declaration.scope.taskTypes] } : {}),
      ...(declaration.scope.phaseIds ? { phaseIds: [...declaration.scope.phaseIds] } : {}),
      ...(declaration.scope.taskIds ? { taskIds: [...declaration.scope.taskIds] } : {}) },
    ...(declaration.supersedes ? { supersedes: declaration.supersedes.map(({ id, revision }) => ({ id, revision })) } : {}),
    statuses: Object.fromEntries(Object.entries(declaration.statuses).map(([status, mapping]) => [status, { ...mapping }])),
  } };
}

function scopeMatches(scope: TaskPolicyScope, task: TaskInput, context: TaskInterpretationContext): boolean {
  return scope.projectId === context.projectId && (scope.dagId === undefined || scope.dagId === context.dagId) &&
    (scope.taskTypes === undefined || (task.rawType != null && scope.taskTypes.includes(task.rawType))) &&
    (scope.phaseIds === undefined || (task.phase?.id != null && scope.phaseIds.includes(task.phase.id))) &&
    (scope.taskIds === undefined || scope.taskIds.includes(task.id));
}
type ParsedPolicy = ReturnType<typeof parseTaskPolicy> & { raw: unknown };
function selectPolicy(task: TaskInput, context: TaskInterpretationContext, parsed: readonly ParsedPolicy[]):
  { policy: TaskPolicyDeclaration | null; reason: TaskReason } {
  const unknown = (code: string, message: string) => ({ policy: null, reason: { kind: 'unknown', code, message } as TaskReason });
  for (const item of parsed) {
    if (item.ok || item.ignored) continue;
    // A malformed declaration from a demonstrably different project/DAG is irrelevant.
    const declaration = record(item.raw) && item.raw.key === STATUS_MAPPING_POLICY_KEY ? item.raw.decision : item.raw;
    const scope = record(declaration) && record(declaration.scope) ? declaration.scope : null;
    if (scope && nonempty(scope.projectId) && scope.projectId !== context.projectId) continue;
    if (scope && nonempty(scope.dagId) && scope.dagId !== context.dagId) continue;
    return unknown('invalid-policy', item.reason);
  }
  const candidates = parsed.flatMap(item => item.ok && scopeMatches(item.value.scope, task, context) ? [item.value] : []);
  if (candidates.length === 0) return unknown('missing-policy', '적용 가능한 명시 정책이 없어 해석 미확인');
  const keys = candidates.map(refKey);
  if (new Set(keys).size !== keys.length) return unknown('ambiguous-revision', '동일 정책 ID·개정 선언이 중복되어 해석 미확인');
  if (new Set(candidates.map(policy => scopeKey(policy.scope))).size !== 1) {
    return unknown('ambiguous-scope', '겹치는 정책 적용 범위의 우선순위가 명시되지 않아 해석 미확인');
  }
  const byKey = new Map(candidates.map(policy => [refKey(policy), policy]));
  const descendants = new Map<string, Set<string>>();
  for (const policy of candidates) {
    const reached = new Set<string>(), queue = [...(policy.supersedes ?? []).map(refKey)];
    while (queue.length) {
      const key = queue.pop()!;
      if (reached.has(key)) continue;
      reached.add(key);
      for (const prior of byKey.get(key)?.supersedes ?? []) queue.push(refKey(prior));
    }
    if (reached.has(refKey(policy))) return unknown('ambiguous-revision', '정책 개정 관계가 순환하여 해석 미확인');
    descendants.set(refKey(policy), reached);
  }
  const latest = candidates.filter(policy => keys.every(key => key === refKey(policy) || descendants.get(refKey(policy))!.has(key)));
  if (latest.length !== 1) return unknown('ambiguous-revision', '명시 개정 관계로 최신 정책을 하나로 정할 수 없어 해석 미확인');
  return { policy: latest[0], reason: { kind: 'policy', code: 'explicit-policy',
    message: `${latest[0].id} / ${latest[0].revision} / ${latest[0].mappingVersion} 명시 정책` } };
}

function observedReviews(task: TaskInput, context: TaskInterpretationContext): ObservedPrReview[] {
  const observations = (context.prReviews ?? []).filter(review => {
    if (review.kind !== 'observed-pr-review' || review.projectId !== context.projectId || review.dagId !== context.dagId ||
        review.taskId !== task.id || !['awaiting-review', 'reviewed', 'unknown'].includes(review.state) ||
        !nonempty(review.observedAt) || !Number.isFinite(Date.parse(review.observedAt))) return false;
    try { return new URL(review.url).protocol === 'https:'; } catch { return false; }
  });
  const latest = new Map<string, ObservedPrReview>();
  for (const review of observations) {
    const prior = latest.get(review.url), time = Date.parse(review.observedAt), priorTime = prior ? Date.parse(prior.observedAt) : -Infinity;
    if (time > priorTime) latest.set(review.url, { ...review });
    else if (prior && time === priorTime && prior.state !== review.state) latest.set(review.url, { ...prior, state: 'unknown' });
  }
  return [...latest.values()].sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

/** No raw status, dependency, reference or source object is changed. In particular,
 * done/committed/blocked/deferred/superseded have no built-in lifecycle meaning. */
export function interpretTasks<T extends TaskInput>(tasks: readonly T[], context: TaskInterpretationContext): TaskInterpretation<T>[] {
  const parsed = (context.policies ?? []).map(raw => ({ ...parseTaskPolicy(raw), raw }));
  return tasks.map(task => {
    const selected = selectPolicy(task, context, parsed), reasons = [selected.reason];
    const mapping = selected.policy && task.status !== null && own(selected.policy.statuses, task.status) ? selected.policy.statuses[task.status] : null;
    const lifecycle = mapping?.lifecycle ?? 'unknown';
    if (selected.policy && !mapping) reasons.push({ kind: 'unknown', code: 'unmapped-status', message: '원본 상태에 대한 명시 매핑이 없어 해석 미확인' });
    if (mapping) reasons.push({ kind: 'policy', code: 'status-mapping', message: mapping.reason ?? `원본 상태 ${task.status} → ${mapping.lifecycle}` });
    const e2eMissing = task.e2e.coverage === 'unmet', e2eMalformed = task.e2e.coverage === 'malformed';
    if (mapping?.discussion) reasons.push({ kind: 'policy', code: 'discussion-policy', message: '명시 정책에 따라 논의 필요' });
    if (mapping?.verification) reasons.push({ kind: 'policy', code: 'verification-policy', message: '명시 정책에 따라 검증 필요' });
    if (e2eMissing) reasons.push({ kind: 'declaration', code: 'e2e-unmet', message: '필수 E2E 근거 참조가 선언되지 않아 검증 필요' });
    if (e2eMalformed) reasons.push({ kind: 'declaration', code: 'e2e-malformed', message: 'E2E 선언을 해석할 수 없어 검증 필요' });
    if (task.e2e.coverage === 'references-declared') reasons.push({ kind: 'declaration', code: 'e2e-unverified', message: 'E2E 참조는 선언이며 실행 통과는 미검증' });
    if (task.commitReferences.length > 0) reasons.push({ kind: 'declaration', code: 'commits-unverified', message: '커밋 참조는 선언이며 실제 커밋 검증은 수행하지 않음' });
    const prReviews = observedReviews(task, context);
    const awaitingReview = prReviews.some(review => review.state === 'awaiting-review');
    if (awaitingReview) reasons.push({ kind: 'observed', code: 'pr-awaiting-review', message: '태스크에 연결하여 관측한 PR이 검토 대기' });
    if (context.partial) reasons.push({ kind: 'unknown', code: 'partial-observation', message: '부분 수집 결과이며 전체 태스크·의존·근거를 확정하지 않음' });
    return { task, rawType: task.rawType ?? null, rawStatus: task.status, lifecycle,
      discussion: mapping?.discussion === true, verification: mapping?.verification === true || e2eMissing || e2eMalformed,
      review: lifecycle === 'review' || awaitingReview, verificationState: 'not-performed', policy: selected.policy, prReviews, reasons,
      provenance: { projectId: context.projectId, dagId: context.dagId, sourceHash: context.sourceHash, observedAt: context.observedAt,
        interpretationVersion: 'phase2-task-v1', partial: context.partial === true, omittedTaskCount: context.omittedTaskCount ?? 0 } };
  });
}

export interface TaskFilters {
  status?: TaskStatusFilter;
  search?: string;
  /** null/undefined means all. A source type literally named "all" remains selectable. */
  type?: string | null;
  phase?: string | null;
  prefix?: string | null;
}
export function taskPhaseKey(task: TaskInput): string {
  return task.phase ? task.phase.id !== null ? `id:${task.phase.id}` : `index:${task.phase.index}` : 'unassigned';
}
export function taskMatchesStatus(row: TaskInterpretation, status: TaskStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'discussion') return row.discussion;
  if (status === 'verification') return row.verification;
  if (status === 'review') return row.review;
  return row.lifecycle === status;
}
export function filterTasks<T extends TaskInput>(rows: readonly TaskInterpretation<T>[], filters: TaskFilters = {}): TaskInterpretation<T>[] {
  const search = filters.search?.trim().toLowerCase() ?? '';
  return rows.filter(row => taskMatchesStatus(row, filters.status ?? 'all') &&
    (filters.type == null || row.rawType === filters.type) &&
    (filters.phase == null || taskPhaseKey(row.task) === filters.phase) &&
    (filters.prefix == null || taskPrefix(row.task.id) === filters.prefix) &&
    `${row.task.id} ${row.task.title ?? ''} ${row.rawType ?? ''} ${row.rawStatus ?? ''} ${row.task.phase?.title ?? ''} ${row.task.details?.description ?? ''}`.toLowerCase().includes(search));
}
export function taskFilterOptions(rows: readonly TaskInterpretation[]): { types: string[]; phases: { value: string; label: string }[]; prefixes: string[] } {
  const phases = new Map<string, { value: string; label: string; index: number }>();
  for (const { task } of rows) {
    const value = taskPhaseKey(task);
    if (!phases.has(value)) phases.set(value, { value, label: task.phase?.title ?? task.phase?.id ?? (task.phase ? `Phase ${task.phase.index + 1}` : '소속 미확인'), index: task.phase?.index ?? Number.MAX_SAFE_INTEGER });
  }
  return {
    types: [...new Set(rows.flatMap(row => row.rawType === null ? [] : [row.rawType]))].sort(),
    phases: [...phases.values()].sort((a, b) => a.index - b.index || a.value.localeCompare(b.value)).map(({ value, label }) => ({ value, label })),
    prefixes: [...new Set(rows.flatMap(row => { const prefix = taskPrefix(row.task.id); return prefix ? [prefix] : []; }))].sort(),
  };
}
