import { createHash } from 'node:crypto';
import type { LinkedCommitEvidence } from '../shared/task-graph-contract';
import { validLinkedRepository, type LinkedCommitReadAdapter, type VerifiedCommitRecord, type CommitLookup } from './linked-commit-dates';

type Repository = LinkedCommitEvidence['repository'];
export interface RemotePullState {
  repository: Repository; number: number; head: string; base: string; commitCount: number;
}
export interface RemoteCommitPage {
  repository: Repository; number: number; page: number; perPage: 100;
  commits: readonly VerifiedCommitRecord[];
  /** Provider must retain pagination evidence; absence of a next page is not inferred from truncation. */
  hasNext: boolean;
}
/** Existing authorized main-owned provider only. Implementations own authentication and
 * repository access; renderer URLs, tokens and arbitrary endpoint strings are not accepted.
 * No default fetch, environment credentials, Git config or connector credential extraction. */
export interface AuthorizedLinkedCommitProvider {
  revision: string;
  validate(repository: Repository, signal: AbortSignal): Promise<boolean>;
  commit(repository: Repository, sha: string, signal: AbortSignal): Promise<CommitLookup>;
  pull(repository: Repository, number: number, signal: AbortSignal): Promise<RemotePullState>;
  pullCommits(repository: Repository, number: number, page: number, perPage: 100, signal: AbortSignal): Promise<RemoteCommitPage>;
}
const repoKey = (repository: Repository): string => `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sameState = (a: RemotePullState, b: RemotePullState): boolean => repoKey(a.repository) === repoKey(b.repository)
  && a.number === b.number && a.head === b.head && a.base === b.base && a.commitCount === b.commitCount;
const stateValid = (state: RemotePullState, repository: Repository, number: number): boolean => !!state && validLinkedRepository(state.repository)
  && repoKey(state.repository) === repoKey(repository) && state.number === number && sha(state.head) && sha(state.base)
  && Number.isSafeInteger(state.commitCount) && state.commitCount > 0 && state.commitCount <= 1000;
/** The resolver supplies the logical deadline; this adapter retains its own physical slot
 * until every abandoned provider call actually settles. The host must retain this instance. */
export function createRemoteLinkedCommitAdapter(provider: AuthorizedLinkedCommitProvider): LinkedCommitReadAdapter {
  if (!provider.revision || provider.revision.length > 256) throw new Error('invalid provider revision');
  let physical = false;
  const active = async (repository: Repository, signal: AbortSignal): Promise<void> => {
    if (signal.aborted || !validLinkedRepository(repository) || !await provider.validate(repository, signal) || signal.aborted) throw new Error('unavailable');
  };
  const owned = async <T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (physical || signal.aborted) throw new Error('unavailable');
    physical = true;
    try { return await work(); } finally { physical = false; }
  };
  return {
    get revision() { return `remote-linked-v1:${provider.revision}`; }, cache: false,
    commit(repository, reference, signal) {
      return owned(async () => {
        if (!/^[a-f0-9]{7,40}$/i.test(reference)) throw new Error('unsupported');
        const revision = provider.revision; await active(repository, signal);
        const result = await provider.commit(repository, reference, signal);
        await active(repository, signal); if (provider.revision !== revision) throw new Error('source-changed');
        return result;
      }, signal);
    },
    pull(repository, number, signal) {
      return owned(async () => {
        const incomplete = () => ({ complete: false, commits: [], membershipRevision: '' });
        if (!Number.isSafeInteger(number) || number < 1) return incomplete();
        const revision = provider.revision; await active(repository, signal);
        const observed = await provider.pull(repository, number, signal);
        if (!stateValid(observed, repository, number)) return incomplete();
        const initial: RemotePullState = { repository: { ...observed.repository }, number: observed.number, head: observed.head, base: observed.base, commitCount: observed.commitCount };
        const commits: VerifiedCommitRecord[] = []; const ids = new Set<string>(); let bytes = 0; let ended = false;
        for (let page = 1; page <= 10; page++) {
          await active(repository, signal);
          const response = await provider.pullCommits(repository, number, page, 100, signal);
          if (!response || !validLinkedRepository(response.repository) || repoKey(response.repository) !== repoKey(repository)
            || response.number !== number || response.page !== page || response.perPage !== 100 || typeof response.hasNext !== 'boolean'
            || !Array.isArray(response.commits) || !response.commits.length || response.commits.length > 100) return incomplete();
          bytes += Buffer.byteLength(JSON.stringify(response)); if (bytes > 1024 * 1024) return incomplete();
          for (const commit of response.commits) {
            if (!commit || !validLinkedRepository(commit.repository) || repoKey(commit.repository) !== repoKey(repository) || !sha(commit.sha) || ids.has(commit.sha)
              || typeof commit.committerAtUtc !== 'string' || commit.committerAtUtc.length > 32) return incomplete();
            ids.add(commit.sha); commits.push({ repository: { ...repository }, sha: commit.sha, committerAtUtc: commit.committerAtUtc });
          }
          if (commits.length > initial.commitCount) return incomplete();
          await active(repository, signal);
          const current = await provider.pull(repository, number, signal);
          if (!stateValid(current, repository, number) || !sameState(initial, current) || provider.revision !== revision) return incomplete();
          if (!response.hasNext) { ended = true; break; }
          if (response.commits.length !== 100) return incomplete();
        }
        await active(repository, signal);
        if (!ended || commits.length !== initial.commitCount || provider.revision !== revision) return incomplete();
        const membershipRevision = createHash('sha256').update(JSON.stringify([revision, initial, commits.map(c => c.sha)])).digest('hex');
        return { complete: true, commits, membershipRevision };
      }, signal);
    },
  };
}
