import type { LinkedCommitEvidence, LinkedDateSummary, LinkedReferenceResolution, TaskGraphIdentity } from '../shared/task-graph-contract';

type Repository = LinkedCommitEvidence['repository'];
export interface LinkedDateTask {
  id: string;
  /** Declarations from the authoritative source, not display-truncated references. */
  references: readonly string[];
  inspection: 'complete' | 'partial' | 'unknown';
  /** Only supply if the declaration's repository scope is independently established. */
  repository?: Repository;
}
export interface VerifiedCommitRecord {
  repository: Repository; sha: string; committerAtUtc: string;
}
export type CommitLookup = { complete: boolean; commits: readonly VerifiedCommitRecord[]; failure?: 'ambiguous' | 'unsupported' | 'unavailable' };
export type PullLookup = CommitLookup & { membershipRevision: string };
/** Main-owned adapter. Must establish authoritative repository scope, SHA uniqueness,
 * and complete PR pagination. No renderer URLs, commands, credentials or file paths. */
export interface LinkedCommitReadAdapter {
  revision: string;
  /** Mutable local object stores must bypass cache unless every hit is freshly guarded. */
  cache?: false;
  commit(repository: Repository, sha: string, signal: AbortSignal): Promise<CommitLookup>;
  pull(repository: Repository, number: number, signal: AbortSignal): Promise<PullLookup>;
}
export interface LinkedDatesResult {
  identity: TaskGraphIdentity; resolverRevision: string;
  tasks: readonly { id: string; references: readonly LinkedReferenceResolution[] }[];
  summary: LinkedDateSummary;
}
export const LINKED_DATE_LIMITS = Object.freeze({ tasks: 10_000, references: 20_000,
  commitsPerReference: 1_000, timeoutMs: 10_000, cacheEntries: 8, cacheBytes: 16 * 1024 * 1024 });
const validPart = (value: string): boolean => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(value) && !['.', '..'].includes(value);
export function validLinkedRepository(repository: Repository): boolean {
  return repository?.host === 'github.com' && validPart(repository.owner) && validPart(repository.name);
}
function repoKey(repository: Repository): string { return `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase(); }
function utc(value: string): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const canonical = date.toISOString();
  return canonical === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z') ? canonical : null;
}
function checkedCommit(record: VerifiedCommitRecord, repository: Repository): VerifiedCommitRecord | null {
  if (!record || !validLinkedRepository(record.repository) || repoKey(record.repository) !== repoKey(repository)
    || typeof record.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(record.sha)) return null;
  const timestamp = utc(record.committerAtUtc);
  return timestamp ? { repository: { ...repository }, sha: record.sha.toLowerCase(), committerAtUtc: timestamp } : null;
}
type Declaration = { repository: Repository; kind: 'commit'; sha: string } | { repository: Repository; kind: 'pull'; number: number };
function declaration(value: string, scope?: Repository): Declaration | 'repository-unknown' | 'unsupported' {
  if (/^[a-f0-9]{7,40}$/i.test(value)) return scope && validLinkedRepository(scope)
    ? { repository: scope, kind: 'commit', sha: value.toLowerCase() } : 'repository-unknown';
  // Exact grammar rejects credentials, query/fragment, unexpected ports, escapes and unsafe schemes.
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(commit|pull)\/([a-fA-F0-9]+)$/.exec(value);
  if (!match) return 'unsupported';
  const repository = { host: 'github.com', owner: match[1]!, name: match[2]! };
  if (!validLinkedRepository(repository)) return 'unsupported';
  if (match[3] === 'commit' && /^[a-f0-9]{7,40}$/i.test(match[4]!)) return { repository, kind: 'commit', sha: match[4]!.toLowerCase() };
  const number = Number(match[4]);
  return match[3] === 'pull' && /^[1-9]\d*$/.test(match[4]!) && Number.isSafeInteger(number)
    ? { repository, kind: 'pull', number } : 'unsupported';
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function compare(a: LinkedCommitEvidence, b: LinkedCommitEvidence): number {
  const byTime = Date.parse(b.committerAtUtc) - Date.parse(a.committerAtUtc);
  if (byTime) return byTime;
  const aa = JSON.stringify([repoKey(a.repository), a.sha, a.taskId, a.declaredReference]);
  const bb = JSON.stringify([repoKey(b.repository), b.sha, b.taskId, b.declaredReference]);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}
export function summarizeLinkedDates(tasks: readonly LinkedDateTask[], resolutions: LinkedDatesResult['tasks']): LinkedDateSummary {
  const coverage: LinkedDateSummary['coverage'] = { inspection: tasks.some(t => t.inspection === 'unknown') ? 'unknown'
    : tasks.some(t => t.inspection === 'partial') ? 'partial' : 'complete',
    tasks: { total: tasks.length, resolved: 0, noReference: 0, unresolved: 0 }, references: { total: 0, resolved: 0, unresolved: 0 } };
  let latest: LinkedCommitEvidence | null = null;
  tasks.forEach((task, index) => {
    const refs = resolutions[index]!.references;
    let resolved = false;
    for (const ref of refs) {
      coverage.references.total++;
      if (ref.state === 'resolved') {
        resolved = true; coverage.references.resolved++;
        for (const commit of ref.commits) if (!latest || compare(commit, latest) < 0) latest = commit;
      } else coverage.references.unresolved++;
    }
    if (resolved) coverage.tasks.resolved++;
    else if (!refs.length && task.inspection === 'complete') coverage.tasks.noReference++;
    else coverage.tasks.unresolved++;
  });
  if (latest) return { state: coverage.inspection === 'complete' && coverage.tasks.resolved === tasks.length
    && !coverage.references.unresolved ? 'resolved' : 'partial', latest, coverage };
  return { state: coverage.inspection === 'complete' && !coverage.references.total ? 'no-reference' : 'unknown', latest: null, coverage };
}
export class LinkedCommitDateResolver {
  private cache = new Map<string, { result: LinkedDatesResult; bytes: number }>();
  private cacheBytes = 0;
  private generation = 0;
  private physical = 0;
  constructor(private readonly adapter: LinkedCommitReadAdapter, private readonly timeoutMs: number = LINKED_DATE_LIMITS.timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LINKED_DATE_LIMITS.timeoutMs) throw new Error('invalid timeout');
  }
  clear(): void { this.generation++; this.cache.clear(); this.cacheBytes = 0; }
  async resolve(identity: TaskGraphIdentity, tasks: readonly LinkedDateTask[], signal?: AbortSignal): Promise<LinkedDatesResult> {
    if (signal?.aborted) throw new Error('cancelled');
    if (this.physical >= 1) throw new Error('unsupported');
    if (!this.adapter.revision || this.adapter.revision.length > 256 || tasks.length > LINKED_DATE_LIMITS.tasks
      || tasks.reduce((n, t) => n + t.references.length, 0) > LINKED_DATE_LIMITS.references
      || new Set(tasks.map(t => t.id)).size !== tasks.length
      || tasks.some(t => !t.id || t.id.length > 256 || !['complete', 'partial', 'unknown'].includes(t.inspection)
        || t.references.some(r => typeof r !== 'string' || r.length > 2048))) throw new Error('unsupported');
    // Capture caller-owned input before awaiting so provenance cannot change in flight.
    const generation = this.generation;
    const source = structuredClone(tasks); const boundIdentity = { ...identity }; const revision = this.adapter.revision;
    const key = JSON.stringify([boundIdentity, revision, source]);
    const cached = this.cache.get(key);
    if (cached && this.adapter.cache !== false) { this.cache.delete(key); this.cache.set(key, cached); return cached.result; }
    const controller = new AbortController();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => { controller.abort(); reject(new Error('cancelled')); }; });
    signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); });
    const resolveReference = async (task: LinkedDateTask, ref: string): Promise<LinkedReferenceResolution> => {
      const fail = (reason: Extract<LinkedReferenceResolution, { state: 'unresolved' }>['reason']): LinkedReferenceResolution => ({ state: 'unresolved', declaredReference: ref, reason });
      const parsed = declaration(ref, task.repository);
      if (typeof parsed === 'string') return fail(parsed);
      try {
        const lookup = await (parsed.kind === 'commit' ? this.adapter.commit(parsed.repository, parsed.sha, controller.signal)
          : this.adapter.pull(parsed.repository, parsed.number, controller.signal));
        if (controller.signal.aborted) throw new Error('cancelled');
        if (lookup.failure) return fail(lookup.failure);
        if (lookup.complete !== true || !Array.isArray(lookup.commits) || lookup.commits.length > LINKED_DATE_LIMITS.commitsPerReference)
          return fail(parsed.kind === 'pull' ? 'incomplete-membership' : 'unavailable');
        const membership = parsed.kind === 'pull' ? (lookup as PullLookup).membershipRevision : null;
        if (parsed.kind === 'pull' && (typeof membership !== 'string' || !membership || membership.length > 256)) return fail('incomplete-membership');
        const records = lookup.commits.map(c => checkedCommit(c, parsed.repository));
        if (records.some(c => c === null)) return fail('unavailable');
        const unique = new Map<string, VerifiedCommitRecord>();
        for (const record of records as VerifiedCommitRecord[]) {
          if (parsed.kind === 'commit' && !record.sha.startsWith(parsed.sha)) return fail('unavailable');
          if (unique.has(record.sha) && unique.get(record.sha)!.committerAtUtc !== record.committerAtUtc) return fail('ambiguous');
          unique.set(record.sha, record);
        }
        if (!unique.size) return fail('not-found');
        if (parsed.kind === 'commit' && unique.size !== 1) return fail('ambiguous');
        const commits: LinkedCommitEvidence[] = [...unique.values()].map(c => ({ ...c, taskId: task.id, declaredReference: ref,
          verifiedCommitUrl: `https://github.com/${parsed.repository.owner}/${parsed.repository.name}/commit/${c.sha}`,
          via: parsed.kind === 'commit' ? { kind: 'declared-commit' } : { kind: 'declared-pr', number: parsed.number, membershipRevision: membership! } }));
        commits.sort(compare);
        return { state: 'resolved', declaredReference: ref, commits };
      } catch { if (controller.signal.aborted) throw new Error('cancelled'); return fail('unavailable'); }
    };
    const work = async (): Promise<LinkedDatesResult> => {
      const output: { id: string; references: LinkedReferenceResolution[] }[] = [];
      let evidenceCount = 0;
      for (const task of source) {
        const references: LinkedReferenceResolution[] = [];
        for (const ref of new Set(task.references)) {
          if (controller.signal.aborted) throw new Error('cancelled');
          const result = await resolveReference(task, ref);
          if (result.state === 'resolved') evidenceCount += result.commits.length;
          if (evidenceCount > LINKED_DATE_LIMITS.references) throw new Error('unsupported');
          references.push(result);
        }
        output.push({ id: task.id, references });
      }
      return { identity: boundIdentity, resolverRevision: revision, tasks: output, summary: summarizeLinkedDates(source, output) };
    };
    try {
      this.physical++;
      const pending = work().finally(() => { this.physical--; });
      const result = await Promise.race([pending, cancelled, timeout]);
      if (signal?.aborted || controller.signal.aborted) throw new Error('cancelled');
      if (this.adapter.revision !== revision || this.generation !== generation) throw new Error('source-changed');
      freeze(result);
      const bytes = Buffer.byteLength(JSON.stringify(result)) + Buffer.byteLength(key);
      if (bytes > LINKED_DATE_LIMITS.cacheBytes) throw new Error('unsupported');
      // Failed/unavailable lookups are retryable; cache only fully resolved/no-reference snapshots.
      if (this.adapter.cache !== false && result.summary.coverage.inspection === 'complete' && !result.summary.coverage.references.unresolved) {
        while (this.cache.size >= LINKED_DATE_LIMITS.cacheEntries || this.cacheBytes + bytes > LINKED_DATE_LIMITS.cacheBytes) {
          const oldest = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
        }
        this.cache.set(key, { result, bytes }); this.cacheBytes += bytes;
      }
      return result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
