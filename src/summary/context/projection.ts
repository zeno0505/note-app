import { createHash } from 'node:crypto';
import { extractContextInput, taskContextSourceId, excerptContextSourceId, contextScopeId, type ContextExtractionRequest } from './extract';
import { validateRegisteredExcerptContext, type RegisteredExcerptContext } from './registered';
import { ContextValidationError, parseContextInput, utf8Bytes, type ContextInput, type ContextRecord } from './index';

export interface ProjectionProvenanceEntry {
  sourceId: string;
  sourceHash: string;
  /** Exact canonical projection artifact bytes, represented as a UTF-8 string. */
  artifact: string;
  upstream: { dagId: string; taskId: string; sourceHash: string; observedAt: string };
}
export interface ProjectionContext {
  input: ContextInput;
  /** LOCAL ONLY: never append this manifest to a model prompt. */
  provenance: { schemaVersion: 1; sourceType: 'dag-task-projection-v1'; entries: ProjectionProvenanceEntry[]; excerpts?: RegisteredExcerptContext };
}
export const registeredContextSourceId = (dagId: string, kind: 'goal-document' | 'document' | 'inbox', id: string): string => `registered-v1-${excerptContextSourceId(dagId, kind, id).slice(8)}`;
const hash = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
function fail(message: string): never { throw new ContextValidationError(message); }
const remap = (legacyId: string): string => `projection-v1-${hash(JSON.stringify(['dag-task-projection-v1', legacyId])).slice(7)}`;
export const projectionTaskSourceId = (dagId: string, taskId: string): string => remap(taskContextSourceId(dagId, taskId));
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) fail('Invalid projection object');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property)) fail('Invalid projection field');
    result[key] = property.value;
  }
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const artifact = (record: Pick<ContextRecord, 'declaredStatus' | 'dependencies'>, declaration: string): string => JSON.stringify({
  schemaVersion: 1, sourceType: 'dag-task-projection-v1', declaredStatus: record.declaredStatus,
  declaration, dependencies: record.dependencies,
});

function declarationText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || utf8Bytes(value) > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) fail('Invalid declaration text');
  return value;
}
function declaredList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) fail('Invalid bounded declaration references');
  const result = value.map(declarationText);
  if (new Set(result).size !== result.length || JSON.stringify([...result].sort()) !== JSON.stringify(result)) fail('Noncanonical declaration references');
  return result;
}
function validateDeclaration(serialized: string, expectedStatus: ContextRecord['declaredStatus'], dependencyCount: number): void {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { fail('Invalid extracted declaration'); }
  const type = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'sourceType')?.value : undefined;
  const isTask = type === 'dag-task-declaration';
  if (!isTask && type !== 'dag-dependency-declaration') fail('Unexpected declaration source type');
  const d = object(value, isTask ? ['sourceType', 'selection', 'title', 'declaredStatusRaw', 'e2eDeclaration', 'commitReferences', 'evidence'] : ['sourceType', 'selection', 'declaredStatusRaw', 'evidence']);
  const raw = d.declaredStatusRaw === null ? null : declarationText(d.declaredStatusRaw);
  const normalized = ['pending', 'running', 'done', 'blocked', 'unknown'].includes(raw ?? '') ? raw : 'unknown';
  if (normalized !== expectedStatus) fail('Contradictory raw declared status');
  if (!isTask) {
    if (dependencyCount !== 0) fail('Minimal dependency declaration cannot include recursive dependencies');
    const canonical = { sourceType: type, selection: 'direct-dependency-status-only', declaredStatusRaw: raw, evidence: 'Declared status only; no readiness, testing, deployment or execution approval inferred.' };
    if (JSON.stringify(canonical) !== serialized) fail('Noncanonical dependency declaration');
    return;
  }
  const title = d.title === null ? null : declarationText(d.title);
  const e = object(d.e2eDeclaration, ['state', 'required', 'coveredBy', 'coverage']);
  if (!['undeclared', 'declared'].includes(e.state as string) || ![true, false, null].includes(e.required as boolean | null)
    || !['undeclared', 'not-required', 'unmet', 'references-declared', 'malformed'].includes(e.coverage as string)) fail('Invalid E2E declaration');
  const coveredBy = e.coveredBy === null ? null : declaredList(e.coveredBy);
  if (e.state === 'undeclared' && (e.required !== null || coveredBy !== null || e.coverage !== 'undeclared')) fail('Contradictory undeclared E2E fields');
  if (e.state === 'declared' && (e.coverage === 'undeclared'
    || (e.coverage === 'not-required' && e.required !== false)
    || (e.coverage === 'unmet' && (e.required !== true || !!coveredBy?.length))
    || (e.coverage === 'references-declared' && (e.required !== true || !coveredBy?.length)))) fail('Contradictory E2E coverage declaration');
  const canonical = { sourceType: type, selection: 'explicit-task', title, declaredStatusRaw: raw,
    e2eDeclaration: { state: e.state, required: e.required, coveredBy, coverage: e.coverage },
    commitReferences: declaredList(d.commitReferences), evidence: 'Declarations only; commits and E2E references do not establish tests passed or deployment. No execution approval or priority is implied.' };
  if (JSON.stringify(canonical) !== serialized) fail('Noncanonical task declaration');
}

/** Validates linkage/integrity, not upstream authenticity; artifacts and manifest remain local data. */
export function validateProjectionContext(value: unknown): ProjectionContext {
  const root = object(value, ['input', 'provenance']);
  const input = parseContextInput(root.input);
  const hasExcerpts = !!root.provenance && typeof root.provenance === 'object' && Object.hasOwn(root.provenance, 'excerpts');
  const manifest = object(root.provenance, ['schemaVersion', 'sourceType', 'entries', ...(hasExcerpts ? ['excerpts'] : [])]);
  const excerpts = hasExcerpts ? validateRegisteredExcerptContext(manifest.excerpts) : undefined;
  if (manifest.schemaVersion !== 1 || manifest.sourceType !== 'dag-task-projection-v1' || !Array.isArray(manifest.entries) || manifest.entries.length > 256) fail('Invalid projection manifest');
  const projected = new Map(input.records.filter(r => r.sourceId.startsWith('projection-v1-')).map(r => [r.sourceId, r]));
  if (input.records.some(r => !r.sourceId.startsWith('projection-v1-') && !r.sourceId.startsWith('excerpt-') && !r.sourceId.startsWith('registered-v1-'))) fail('Unexpected source contract');
  const entries: ProjectionProvenanceEntry[] = [];
  const seen = new Set<string>();
  for (const item of manifest.entries) {
    const e = object(item, ['sourceId', 'sourceHash', 'artifact', 'upstream']);
    const upstream = object(e.upstream, ['dagId', 'taskId', 'sourceHash', 'observedAt']);
    if (typeof upstream.dagId !== 'string' || typeof upstream.taskId !== 'string' || typeof upstream.sourceHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(upstream.sourceHash)
      || typeof upstream.observedAt !== 'string' || typeof e.sourceId !== 'string' || typeof e.sourceHash !== 'string' || typeof e.artifact !== 'string' || utf8Bytes(e.artifact) > 8192) fail('Invalid projection provenance');
    const record = projected.get(e.sourceId);
    if (!record || seen.has(e.sourceId) || e.sourceId !== projectionTaskSourceId(upstream.dagId, upstream.taskId)
      || input.scopeId !== contextScopeId(upstream.dagId) || e.sourceHash !== record.sourceHash || hash(e.artifact) !== e.sourceHash
      || record.text !== e.artifact || upstream.observedAt !== record.observedAt) fail('Projection provenance linkage mismatch');
    let parsed: unknown;
    try { parsed = JSON.parse(e.artifact); } catch { fail('Invalid projection artifact'); }
    const a = object(parsed, ['schemaVersion', 'sourceType', 'declaredStatus', 'declaration', 'dependencies']);
    if (a.schemaVersion !== 1 || a.sourceType !== 'dag-task-projection-v1' || typeof a.declaration !== 'string'
      || artifact(record, a.declaration) !== e.artifact) fail('Noncanonical or mismatched projection artifact');
    if (record.dependencies.some(d => !/^projection-v1-[a-f0-9]{64}$/.test(d.sourceId))) fail('Dependency uses wrong provenance contract');
    validateDeclaration(a.declaration, record.declaredStatus, record.dependencies.length);
    seen.add(e.sourceId);
    entries.push({ sourceId: e.sourceId, sourceHash: e.sourceHash, artifact: e.artifact,
      upstream: { dagId: upstream.dagId, taskId: upstream.taskId, sourceHash: upstream.sourceHash, observedAt: upstream.observedAt } });
  }
  if (seen.size !== projected.size) fail('Missing projection provenance');
  const registered = input.records.filter(r => r.sourceId.startsWith('registered-v1-'));
  if (registered.length !== (excerpts?.excerpts.length ?? 0) || (excerpts && input.scopeId !== contextScopeId(excerpts.scopeDagId))) fail('Missing registered excerpt provenance');
  for (const excerpt of excerpts?.excerpts ?? []) {
    const record = registered.find(r => r.sourceId === registeredContextSourceId(excerpt.scopeDagId, excerpt.kind, excerpt.id));
    const expected = JSON.stringify({ sourceType: `${excerpt.kind}-excerpt`, selection: 'explicit-scoped-excerpt', excerpt: excerpt.text, evidence: 'Supplied excerpt only; not complete document or inbox coverage.' });
    if (!record || record.sourceHash !== excerpt.sourceHash || record.observedAt !== excerpt.observedAt || record.text !== expected || record.declaredStatus !== 'unknown' || record.dependencies.length) fail('Registered excerpt linkage mismatch');
  }
  entries.sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  return freeze({ input, provenance: { schemaVersion: 1, sourceType: 'dag-task-projection-v1', entries, ...(excerpts ? { excerpts } : {}) } });
}

/** Versioned opt-in adapter. Legacy extraction keeps its original whole-DAG hash semantics. */
export function extractProjectionContext(request: ContextExtractionRequest, registeredExcerpts?: RegisteredExcerptContext): ProjectionContext {
  const excerpts = registeredExcerpts ? validateRegisteredExcerptContext(registeredExcerpts) : undefined;
  if (excerpts && (excerpts.scopeDagId !== request.dagId || JSON.stringify(excerpts.excerpts) !== JSON.stringify(request.excerpts))) fail('Registered excerpts do not match supplied context');
  const legacy = extractContextInput(request);
  // IDs only, from the same bounded in-memory projection already validated by the legacy selector.
  const identities = new Map(request.dag.tasks.map(t => [taskContextSourceId(request.dagId, t.id), t.id]));
  const entries: ProjectionProvenanceEntry[] = [];
  const records = legacy.records.map(record => {
    if (!record.sourceId.startsWith('task-')) return excerpts ? { ...record, sourceId: `registered-v1-${record.sourceId.slice(8)}` } : record;
    const sourceId = remap(record.sourceId);
    const dependencies = record.dependencies.map(d => ({ ...d, sourceId: remap(d.sourceId) })).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
    const text = artifact({ ...record, dependencies }, record.text);
    const sourceHash = hash(text);
    const taskId = identities.get(record.sourceId);
    if (!taskId) fail('Missing local task identity');
    entries.push({ sourceId, sourceHash, artifact: text, upstream: { dagId: request.dagId, taskId, sourceHash: record.sourceHash, observedAt: record.observedAt } });
    return { ...record, sourceId, sourceHash, text, dependencies };
  });
  return validateProjectionContext({ input: { ...legacy, records }, provenance: { schemaVersion: 1, sourceType: 'dag-task-projection-v1', entries, ...(excerpts ? { excerpts } : {}) } });
}
