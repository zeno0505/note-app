import { readGitActivityReferences } from '../summary/reading/git-activity-metadata';
import type { GitMetadataReadAuthority } from './git-metadata-grants';
import { validLinkedRepository, type LinkedCommitReadAdapter } from './linked-commit-dates';
import type { LinkedCommitEvidence } from '../shared/task-graph-contract';

/** Host-only repository binding: authority proves filesystem scope, repository proves
 * the declared remote identity. Neither may be inferred from renderer data or a bare SHA.
 * Host must establish this association independently; this adapter never reads remotes. */
export interface LocalLinkedRepositoryBinding {
  repository: LinkedCommitEvidence['repository'];
  authority: GitMetadataReadAuthority;
}
export function createLocalLinkedCommitAdapter(bindings: readonly LocalLinkedRepositoryBinding[]): LinkedCommitReadAdapter {
  if (bindings.length > 128 || bindings.some(b => !validLinkedRepository(b.repository))) throw new Error('invalid repository bindings');
  const key = (repo: LinkedCommitEvidence['repository']): string => JSON.stringify([repo.host, repo.owner.toLowerCase(), repo.name.toLowerCase()]);
  if (new Set(bindings.map(b => key(b.repository))).size !== bindings.length) throw new Error('ambiguous repository bindings');
  const bound = bindings.map(b => ({ repository: { ...b.repository }, authority: b.authority }));
  return {
    revision: 'local-linked-commit-v1', cache: false,
    async commit(repository, sha, signal) {
      const binding = bound.find(b => key(b.repository) === key(repository));
      if (!binding || !/^[a-f0-9]{7,40}$/i.test(sha)) return { complete: false, commits: [], failure: 'unavailable' };
      const validate = async (): Promise<void> => { if (signal.aborted || !await binding.authority.validate(signal)) throw new Error('stale authority'); };
      await validate();
      const rows = await readGitActivityReferences(binding.authority.descriptor, [sha], signal, validate);
      await validate();
      const row = rows[0];
      if (row?.status === 'ambiguous') return { complete: false, commits: [], failure: 'ambiguous' };
      if (row?.status === 'unsupported' || row?.status === 'noncommit') return { complete: false, commits: [], failure: 'unsupported' };
      if (row?.status !== 'resolved' || !row.fullSha || !row.at) return { complete: true, commits: [] };
      return { complete: true, commits: [{ repository: { ...binding.repository }, sha: row.fullSha, committerAtUtc: row.at }] };
    },
    // A local object existing does not prove membership in a declared remote PR.
    async pull() { return { complete: false, commits: [], membershipRevision: '' }; },
  };
}
