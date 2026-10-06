/** Main-only observation seam. No concrete GitHub transport or discovery is provided. */
export interface PullObservation {
  number: number;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
  mergeSha: string | null;
  taskIds: string[];
  mapping: 'verified' | 'unresolved' | 'squash-unverified';
  ci: { sha: string; state: 'success' | 'failure' | 'pending' | 'unknown' }[];
  reviews: { sha: string; state: 'approved' | 'changes-requested' | 'commented' | 'unknown'; reviewer: 'coderabbit' | 'review-agent' | 'human' }[];
}
export interface PullObservationResult {
  workstreamId: string;
  dagId: string;
  repository: string;
  observedAt: string;
  coverage: 'complete' | 'partial';
  pulls: PullObservation[];
}
export interface PullObservationAdapter {
  read(selection: { workstreamId: string; dagId: string }, signal: AbortSignal): Promise<unknown>;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid pull observation');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error('Invalid pull fields');
  return v;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid pull text');
  return value;
}
function sha(value: unknown): string {
  const s = text(value, 64);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(s)) throw new Error('Invalid commit SHA');
  return s;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error('Invalid pull state');
  return value as T;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Pull observation limit');
  return value;
}
/** Structural/correlation validation does not authenticate GitHub or task mapping. */
export function parsePullObservation(value: unknown, selection: {workstreamId: string; dagId: string}): PullObservationResult {
  // Count the serialized response before exposing any of it to the display boundary.
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > 131_072) throw new Error('Pull response limit');
  const v = object(value, ['workstreamId', 'dagId', 'repository', 'observedAt', 'coverage', 'pulls']);
  if (v.workstreamId !== selection.workstreamId || v.dagId !== selection.dagId) throw new Error('Foreign pull scope');
  const repository = text(v.repository);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository identity');
  const observedAt = text(v.observedAt, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) throw new Error('Invalid observation time');
  const pulls = array(v.pulls, 32).map(raw => {
    const p = object(raw, ['number', 'state', 'headSha', 'mergeSha', 'taskIds', 'mapping', 'ci', 'reviews']);
    if (!Number.isSafeInteger(p.number) || (p.number as number) < 1) throw new Error('Invalid pull number');
    const taskIds = array(p.taskIds, 32).map(id => text(id, 100));
    if (new Set(taskIds).size !== taskIds.length) throw new Error('Duplicate pull tasks');
    const ci = array(p.ci, 32).map(rawCI => {
      const c = object(rawCI, ['sha', 'state']);
      return {sha: sha(c.sha), state: enumeration(c.state, ['success', 'failure', 'pending', 'unknown'] as const)};
    });
    const reviews = array(p.reviews, 32).map(rawReview => {
      const r = object(rawReview, ['sha', 'state', 'reviewer']);
      return {sha: sha(r.sha), state: enumeration(r.state, ['approved', 'changes-requested', 'commented', 'unknown'] as const), reviewer: enumeration(r.reviewer, ['coderabbit', 'review-agent', 'human'] as const)};
    });
    return { number: p.number as number, state: enumeration(p.state, ['open', 'closed', 'merged'] as const), headSha: sha(p.headSha),
      mergeSha: p.mergeSha === null ? null : sha(p.mergeSha), taskIds,
      mapping: enumeration(p.mapping, ['verified', 'unresolved', 'squash-unverified'] as const), ci, reviews };
  });
  if (new Set(pulls.map(p => p.number)).size !== pulls.length) throw new Error('Duplicate pulls');
  return {workstreamId: selection.workstreamId, dagId: selection.dagId, repository, observedAt,
    coverage: enumeration(v.coverage, ['complete', 'partial'] as const), pulls};
}
