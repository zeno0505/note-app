import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectGitActivityMetadata } from '../../src/summary/reading/git-activity-metadata';
import { createLocalLinkedCommitAdapter } from '../../src/main/local-linked-commit-adapter';
import { LinkedCommitDateResolver } from '../../src/main/linked-commit-dates';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const repository = { host: 'github.com', owner: 'synthetic', name: 'test' };
const identity = { projectId: 'p', dagId: 'd', sourceHash: 's', sessionKey: 'g', revision: 'r' };
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'linked-date-test-'))); roots.push(root);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-12-31T16:00:00Z',
  } }).trim();
  git(['init', '-b', 'synthetic']);
  git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic']);
  const sha = git(['rev-parse', 'HEAD']);
  const descriptor = await inspectGitActivityMetadata(root, [path.join(root, '.git')], new AbortController().signal);
  let allowed = true;
  const authority = { descriptor, revision: 1, identity: 'synthetic-authority', validate: async () => allowed };
  const adapter = createLocalLinkedCommitAdapter([{ repository, authority }]);
  return { sha, adapter, revoke: () => { allowed = false; } };
}
describe('guarded local linked commit adapter', () => {
  it('reads actual local commit objects through existing guarded metadata reader, never author date', async () => {
    const f = await fixture(); const resolver = new LinkedCommitDateResolver(f.adapter);
    const result = await resolver.resolve(identity, [{ id: 'S-1', references: [f.sha.slice(0, 12)], inspection: 'complete', repository }]);
    expect(result.summary).toMatchObject({ state: 'resolved', latest: { sha: f.sha, committerAtUtc: '2026-12-31T16:00:00.000Z', repository } });
    f.revoke();
    expect((await resolver.resolve(identity, [{ id: 'S-1', references: [f.sha.slice(0, 12)], inspection: 'complete', repository }])).summary.state).toBe('unknown');
  });
  it('does not map unbound repo to an existing local SHA or assume PR membership', async () => {
    const f = await fixture();
    expect(await f.adapter.commit({ ...repository, name: 'unbound' }, f.sha, new AbortController().signal)).toMatchObject({ complete: false, commits: [] });
    expect(await f.adapter.pull(repository, 1, new AbortController().signal)).toMatchObject({ complete: false, commits: [], membershipRevision: '' });
  });
  it('rejects duplicate/unsafe repository bindings', () => {
    expect(() => createLocalLinkedCommitAdapter([{ repository: { host: 'evil.example', owner: 'a', name: 'b' }, authority: {} as never }])).toThrow();
  });
});
