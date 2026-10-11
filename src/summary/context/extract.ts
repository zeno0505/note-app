import { createHash } from 'node:crypto';
import type { DagReadModel, DagTask } from '../../facts/dag-read-model/types';
import { ContextValidationError, parseContextInput, utf8Bytes, type ContextInput, type ContextRecord } from './index';

export interface ScopedExcerpt {
  scopeDagId: string; id: string; kind: 'goal-document' | 'document' | 'inbox';
  sourceHash: string; observedAt: string; text: string;
}
export interface ContextExtractionRequest {
  schemaVersion: 1; dagId: string; dag: DagReadModel; requestedTaskIds: string[];
  excerpts: ScopedExcerpt[];
  previousSources: ContextInput['previousSources'];
  priorApprovedSummary: ContextInput['priorApprovedSummary']; limits: ContextInput['limits'];
}
function fail(message: string): never { throw new ContextValidationError(message); }
function plain(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Expected extraction data object');
  if (Reflect.ownKeys(value).length !== keys.length) fail('Unexpected extraction fields');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const p = Object.getOwnPropertyDescriptor(value, key);
    if (!p || !('value' in p)) fail('Missing field or accessor in extraction data');
    result[key] = p.value;
  }
  return result;
}
function boundedText(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || utf8Bytes(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('Invalid extraction text');
  return value as string;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail('Invalid bounded extraction array');
  return Array.from({ length: value.length }, (_, i) => {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !('value' in p)) fail('Expected dense extraction array');
    return p.value;
  });
}
function distinctStrings(value: unknown, max: number): string[] {
  const values = list(value, max).map(item => boundedText(item));
  if (new Set(values).size !== values.length) fail('Duplicate extraction ID');
  return values.sort();
}
const digest = (parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const contextScopeId = (dagId: string): string => `dag-${digest([boundedText(dagId, 1024)])}`;
export const taskContextSourceId = (dagId: string, taskId: string): string => `task-${digest([boundedText(dagId, 1024), boundedText(taskId)])}`;
export const excerptContextSourceId = (dagId: string, kind: ScopedExcerpt['kind'], id: string): string => `excerpt-${digest([boundedText(dagId, 1024), kind, boundedText(id)])}`;
const status = (value: string | null): ContextRecord['declaredStatus'] => ['pending', 'running', 'done', 'blocked', 'unknown'].includes(value ?? '') ? value as ContextRecord['declaredStatus'] : 'unknown';
function task(value: unknown): DagTask {
  const t = plain(value, ['id', 'title', 'status', 'dependencies', 'e2e', 'commitReferences', 'commitVerification']);
  const e = plain(t.e2e, ['state', 'required', 'coveredBy', 'coverage']);
  if (!['undeclared', 'declared'].includes(e.state as string) || ![true, false, null].includes(e.required as boolean | null)
    || !['undeclared', 'not-required', 'unmet', 'references-declared', 'malformed'].includes(e.coverage as string)
    || t.commitVerification !== 'not-performed') fail('Invalid declaration provenance');
  const dependencies = list(t.dependencies, 32).map(value => {
    const d = plain(value, ['id', 'scope']);
    if (!['internal', 'external'].includes(d.scope as string)) fail('Invalid dependency scope');
    return { id: boundedText(d.id), scope: d.scope as 'internal' | 'external' };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(dependencies.map(d => d.id)).size !== dependencies.length) fail('Duplicate dependency');
  return { id: boundedText(t.id), title: t.title === null ? null : boundedText(t.title), status: t.status === null ? null : boundedText(t.status), dependencies,
    e2e: { state: e.state as DagTask['e2e']['state'], required: e.required as boolean | null, coveredBy: e.coveredBy === null ? null : distinctStrings(e.coveredBy, 32), coverage: e.coverage as DagTask['e2e']['coverage'] },
    commitReferences: distinctStrings(t.commitReferences, 32), commitVerification: 'not-performed' };
}
/** Pure projection: no IO, graph walk, inbox discovery, ranking, or execution inference. */
export function extractContextInput(request: ContextExtractionRequest): ContextInput {
  const r = plain(request, ['schemaVersion', 'dagId', 'dag', 'requestedTaskIds', 'excerpts', 'previousSources', 'priorApprovedSummary', 'limits']);
  if (r.schemaVersion !== 1) fail('Unsupported extraction schema');
  const dagId = boundedText(r.dagId, 1024);
  // This boundary accepts only the verified reader's typed projection, never raw YAML/query output.
  const d = plain(r.dag, ['dagId', 'sourceHash', 'sourceMtimeMs', 'observedAt', 'doneStatus', 'tasks', 'statusCounts', 'coverage', 'verifiedFacts']);
  if (d.dagId !== dagId || typeof d.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(d.sourceHash)
    || typeof d.sourceMtimeMs !== 'number' || !Number.isFinite(d.sourceMtimeMs) || d.sourceMtimeMs < 0 || list(d.verifiedFacts, 0).length) fail('DAG identity or provenance mismatch');
  if (typeof d.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(d.observedAt)
    || !Number.isFinite(Date.parse(d.observedAt)) || new Date(d.observedAt).toISOString() !== d.observedAt) fail('Invalid DAG observation time');
  boundedText(d.doneStatus, 128);
  const allTasks = list(d.tasks, 10000);
  // Index identifiers only; inspect task content only for explicit selections and direct dependencies.
  const index = new Map<string, unknown>();
  for (const raw of allTasks) {
    if (!raw || typeof raw !== 'object') fail('Invalid projected task');
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'id');
    if (!descriptor || !('value' in descriptor)) fail('Invalid task ID');
    const id = boundedText(descriptor.value);
    if (index.has(id)) fail('Duplicate projected task ID');
    index.set(id, raw);
  }
  const coverage = plain(d.coverage, ['tasksTotal', 'declared', 'required', 'uncoveredDone', 'uncoveredOpen', 'malformed']);
  if (coverage.tasksTotal !== allTasks.length) fail('DAG total does not match projection');
  const requested = distinctStrings(r.requestedTaskIds, 32);
  const selected = new Map<string, DagTask>();
  const missing = requested.filter(id => !index.has(id));
  for (const id of requested) if (index.has(id)) selected.set(id, task(index.get(id)));
  const dependencies = new Map<string, { id: string; status: string | null }>();
  let missingDependencyCount = 0;
  for (const t of selected.values()) for (const dep of t.dependencies) {
    // External declarations never resolve through local coincidentally equal IDs.
    if (dep.scope === 'external' && index.has(dep.id)) fail('External dependency contradicts projected identity');
    if (dep.scope === 'external' || !index.has(dep.id)) { missingDependencyCount++; continue; }
    if (selected.has(dep.id) || dependencies.has(dep.id)) continue;
    const raw = index.get(dep.id) as object;
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'status');
    if (!descriptor || !('value' in descriptor)) fail('Invalid direct dependency status');
    const value = descriptor.value === null ? null : boundedText(descriptor.value);
    dependencies.set(dep.id, { id: dep.id, status: value });
  }
  const sourceHash = `sha256:${d.sourceHash}`;
  const base = (id: string, rawStatus: string | null): Pick<ContextRecord, 'sourceId' | 'sourceHash' | 'observedAt' | 'declaredStatus'> => ({ sourceId: taskContextSourceId(dagId, id), sourceHash, observedAt: d.observedAt as string, declaredStatus: status(rawStatus) });
  const records: ContextRecord[] = [...selected.values()].map(t => ({ ...base(t.id, t.status),
    text: JSON.stringify({ sourceType: 'dag-task-declaration', selection: 'explicit-task', title: t.title, declaredStatusRaw: t.status, e2eDeclaration: t.e2e, commitReferences: t.commitReferences, evidence: 'Declarations only; commits and E2E references do not establish tests passed or deployment. No execution approval or priority is implied.' }),
    dependencies: t.dependencies.map(dep => ({ sourceId: taskContextSourceId(dagId, dep.id), declaredStatus: status(selected.get(dep.id)?.status ?? dependencies.get(dep.id)?.status ?? null) })) }));
  for (const dep of dependencies.values()) records.push({ ...base(dep.id, dep.status), text: JSON.stringify({ sourceType: 'dag-dependency-declaration', selection: 'direct-dependency-status-only', declaredStatusRaw: dep.status, evidence: 'Declared status only; no readiness, testing, deployment or execution approval inferred.' }), dependencies: [] });
  const excerpts = list(r.excerpts, 32).map(value => {
    const x = plain(value, ['scopeDagId', 'id', 'kind', 'sourceHash', 'observedAt', 'text']);
    if (x.scopeDagId !== dagId || !['goal-document', 'document', 'inbox'].includes(x.kind as string)) fail('Excerpt scope or kind mismatch');
    // Multiline bounded excerpts are allowed, unlike identifiers. Final parser enforces bytes/timestamps/hashes.
    if (typeof x.text !== 'string' || !x.text.trim() || utf8Bytes(x.text) > 7000) fail('Invalid bounded excerpt');
    const sourceId = excerptContextSourceId(dagId, x.kind as ScopedExcerpt['kind'], boundedText(x.id));
    return { kind: x.kind, record: { sourceId, sourceHash: x.sourceHash as string, observedAt: x.observedAt as string,
      text: JSON.stringify({ sourceType: `${x.kind}-excerpt`, selection: 'explicit-scoped-excerpt', excerpt: x.text, evidence: 'Supplied excerpt only; not complete document or inbox coverage.' }), declaredStatus: 'unknown' as const, dependencies: [] } };
  });
  records.push(...excerpts.map(e => e.record));
  const unknowns = [`Explicit selected slice; full DAG task count is ${allTasks.length}, not the number of context records. Document and inbox universe was not scanned.`];
  if (!excerpts.some(e => e.kind === 'goal-document')) unknowns.push('Goal document excerpt not supplied; project goal remains unknown.');
  if (missing.length) unknowns.push(`${missing.length} explicitly requested task IDs were not present; no facts were fabricated.`);
  if (missingDependencyCount) unknowns.push(`${missingDependencyCount} direct dependency declarations have unavailable or external status; no recursive lookup was performed.`);
  if (!requested.length) unknowns.push('No task IDs requested; no task work or completion can be inferred.');
  return parseContextInput({ schemaVersion: 1, scopeId: contextScopeId(dagId), records,
    coverage: { complete: false, totalCount: null, unknowns }, previousSources: r.previousSources, priorApprovedSummary: r.priorApprovedSummary, limits: r.limits });
}
