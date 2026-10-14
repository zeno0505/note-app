import { describe, expect, it } from 'vitest';
import { createRemoteLinkedCommitAdapter, type AuthorizedLinkedCommitProvider, type RemotePullState } from '../../src/main/remote-linked-commit-adapter';
import { LinkedCommitDateResolver } from '../../src/main/linked-commit-dates';
const repository = { host: 'github.com', owner: 'synthetic', name: 'repo' };
const identity = { projectId: 'p', dagId: 'd', sourceHash: 's', sessionKey: 'g', revision: 'r' };
const state = (count = 101): RemotePullState => ({ repository, number: 1, head: 'a'.repeat(40), base: 'b'.repeat(40), commitCount: count });
const record = (index: number) => ({ repository, sha: index.toString(16).padStart(40, '0'), committerAtUtc: '2026-01-01T00:00:00Z' });
function provider(count = 101): AuthorizedLinkedCommitProvider {
  return { revision: 'approved-provider-1', validate: async () => true, commit: async () => ({ complete: true, commits: [record(1)] }),
    pull: async () => state(count), pullCommits: async (_repo, number, page) => ({ repository, number, page, perPage: 100,
      hasNext: page * 100 < count, commits: Array.from({ length: Math.min(100, count - (page - 1) * 100) }, (_, i) => record((page - 1) * 100 + i + 1)) }) };
}
const resolve = (p: AuthorizedLinkedCommitProvider) => new LinkedCommitDateResolver(createRemoteLinkedCommitAdapter(p)).resolve(identity,
  [{ id: 'S-1', references: ['https://github.com/synthetic/repo/pull/1'], inspection: 'complete' }]);
describe('authorized remote membership adapter', () => {
  it('enumerates multiple pages and binds complete membership to exact repo/PR/head/base/SHA set', async () => {
    const result = await resolve(provider());
    expect(result.summary.state).toBe('resolved');
    const ref = result.tasks[0]!.references[0]!; expect(ref.state).toBe('resolved');
    if (ref.state === 'resolved') { expect(ref.commits).toHaveLength(101); expect(ref.commits[0]!.via).toMatchObject({ kind: 'declared-pr', number: 1, membershipRevision: expect.stringMatching(/^[a-f0-9]{64}$/) }); }
  });
  it('does not interpret truncated pagination as complete', async () => {
    const p = provider(); const original = p.pullCommits;
    p.pullCommits = async (...args) => ({ ...await original(...args), hasNext: false });
    expect((await resolve(p)).summary.state).toBe('unknown');
  });
  it('rejects duplicate memberships, wrong scope and changing head', async () => {
    const p = provider(); p.pullCommits = async () => ({ repository, number: 1, page: 1, perPage: 100, hasNext: false, commits: [record(1), record(1)] });
    expect((await resolve(p)).summary.state).toBe('unknown');
    p.pull = async () => ({ ...state(), repository: { ...repository, name: 'foreign' } }); expect((await resolve(p)).summary.state).toBe('unknown');
    const changed = provider(1); let calls = 0; changed.pull = async () => ({ ...state(1), head: (++calls === 1 ? 'a' : 'c').repeat(40) });
    expect((await resolve(changed)).summary.state).toBe('unknown');
  });
  it('revalidates provider authorization/revision and leaves forbidden timestamps unresolved', async () => {
    const denied = provider(); denied.validate = async () => false; expect((await resolve(denied)).summary.state).toBe('unknown');
    const changed = provider(1); const original = changed.pullCommits; changed.pullCommits = async (...args) => { changed.revision = 'changed'; return original(...args); };
    await expect(resolve(changed)).rejects.toThrow('source-changed');
    const invalid = provider(1); invalid.pullCommits = async () => ({ repository, number: 1, page: 1, perPage: 100, hasNext: false, commits: [{ ...record(1), committerAtUtc: '2026-02-30T00:00:00Z' }] });
    expect((await resolve(invalid)).summary.state).toBe('unknown');
  });
  it('captures initial membership state rather than trusting a provider-owned mutable object', async () => {
    const p = provider(1), shared = state(1), original = p.pullCommits;
    p.pull = async () => shared;
    p.pullCommits = async (...args) => { shared.head = 'c'.repeat(40); return original(...args); };
    expect((await resolve(p)).summary.state).toBe('unknown');
  });
  it('does not start a post-page metadata read after authority is revoked during the page call', async () => {
    const p = provider(1), original = p.pullCommits; let allowed = true, reads = 0;
    p.validate = async () => allowed; p.pull = async () => { reads++; return state(1); };
    p.pullCommits = async (...args) => { allowed = false; return original(...args); };
    expect((await resolve(p)).summary.state).toBe('unknown'); expect(reads).toBe(1);
  });
  it('does not exceed membership budget', async () => { expect((await resolve(provider(1001))).summary.state).toBe('unknown'); });
  it('retains physical ownership across caller cancellation until provider work actually settles', async () => {
    const p = provider(1); let release!: (state: RemotePullState) => void; let start!: () => void;
    const ready = new Promise<void>(r => { start = r; }); p.pull = () => { start(); return new Promise(r => { release = r; }); };
    const adapter = createRemoteLinkedCommitAdapter(p); const controller = new AbortController(); const pending = adapter.pull(repository, 1, controller.signal);
    await ready; controller.abort(); await expect(adapter.pull(repository, 1, new AbortController().signal)).rejects.toThrow('unavailable');
    release(state(1)); await expect(pending).rejects.toThrow('unavailable');
  });
});
