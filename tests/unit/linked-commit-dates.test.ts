import { describe, expect, it, vi } from 'vitest';
import { LinkedCommitDateResolver, type LinkedCommitReadAdapter, type LinkedDateTask, type VerifiedCommitRecord } from '../../src/main/linked-commit-dates';
import { linkedDateKst, linkedDateCard } from '../../src/shared/linked-date-format';
const repository = { host: 'github.com', owner: 'synthetic', name: 'alpha' };
const identity = { projectId: 'p', dagId: 'd', sourceHash: 'source', sessionKey: 'session', revision: 'graph' };
const sha = 'a'.repeat(40);
const record = (time = '2026-12-31T16:00:00Z', repo = repository): VerifiedCommitRecord => ({ repository: repo, sha, committerAtUtc: time });
const task = (refs: string[] = [sha], id = 'S-1'): LinkedDateTask => ({ id, references: refs, inspection: 'complete', repository });
function adapter(): LinkedCommitReadAdapter {
  return { revision: 'metadata-1', commit: vi.fn(async () => ({ complete: true, commits: [record()] })),
    pull: vi.fn(async () => ({ complete: true, membershipRevision: 'members-1', commits: [record()] })) };
}
describe('linked commit dates', () => {
  it('stores exact repository/full SHA/committer and explicit PR membership provenance', async () => {
    const out = await new LinkedCommitDateResolver(adapter()).resolve(identity, [task([sha, 'https://github.com/synthetic/alpha/pull/12'])]);
    expect(out.summary.state).toBe('resolved');
    expect(out.tasks[0]!.references[1]).toMatchObject({ state: 'resolved', commits: [{ repository, sha, committerAtUtc: '2026-12-31T16:00:00.000Z', via: { kind: 'declared-pr', number: 12, membershipRevision: 'members-1' } }] });
    expect(Object.isFrozen(out.tasks)).toBe(true);
  });
  it('deduplicates within task, preserves task-bound refs across tasks and partial reference coverage', async () => {
    const out = await new LinkedCommitDateResolver(adapter()).resolve(identity, [task([sha, sha, 'unsupported']), task([sha], 'S-2'), task([], 'S-3')]);
    expect(out.summary.state).toBe('partial');
    expect(out.summary.coverage).toMatchObject({ tasks: { total: 3, resolved: 2, noReference: 1, unresolved: 0 }, references: { total: 3, resolved: 2, unresolved: 1 } });
  });
  it('empty complete is no-reference; incomplete inspection is unknown, never empty success', async () => {
    const resolver = new LinkedCommitDateResolver(adapter());
    expect((await resolver.resolve(identity, [])).summary.state).toBe('no-reference');
    expect((await resolver.resolve(identity, [task([])])).summary.state).toBe('no-reference');
    expect((await resolver.resolve(identity, [{ ...task([]), inspection: 'partial' }])).summary).toMatchObject({ state: 'unknown', coverage: { tasks: { unresolved: 1 } } });
  });
  it.each(['javascript:alert(1)', 'file:///tmp/x', 'https://user@github.com/synthetic/alpha/commit/' + sha,
    'https://github.com:443/synthetic/alpha/commit/' + sha, 'https://github.com/synthetic/alpha/commit/' + sha + '?x=1',
    'https://github.com/synthetic/../commit/' + sha])('rejects unsafe reference %s without adapter I/O', async ref => {
    const read = adapter(); const out = await new LinkedCommitDateResolver(read).resolve(identity, [task([ref])]);
    expect(out.summary.state).toBe('unknown'); expect(read.commit).not.toHaveBeenCalled(); expect(read.pull).not.toHaveBeenCalled();
  });
  it('never guesses repository scope from a bare SHA', async () => {
    const read = adapter(); const out = await new LinkedCommitDateResolver(read).resolve(identity, [{ ...task(), repository: undefined }]);
    expect(out.tasks[0]!.references[0]).toMatchObject({ reason: 'repository-unknown' }); expect(read.commit).not.toHaveBeenCalled();
  });
  it('rejects ambiguous short SHA and wrong repository despite matching SHA', async () => {
    const read = adapter(); read.commit = async () => ({ complete: true, commits: [record(), { ...record(), sha: 'a'.repeat(39) + 'b' }] });
    expect((await new LinkedCommitDateResolver(read).resolve(identity, [task(['aaaaaaa'])])).tasks[0]!.references[0]).toMatchObject({ reason: 'ambiguous' });
    read.commit = async () => ({ complete: true, commits: [record(undefined, { ...repository, name: 'other' })] });
    expect((await new LinkedCommitDateResolver(read).resolve(identity, [task()])).summary.state).toBe('unknown');
  });
  it('retains separate repositories for identical SHA and deterministic max ties', async () => {
    const read = adapter(); read.commit = async repo => ({ complete: true, commits: [record(undefined, repo)] });
    const out = await new LinkedCommitDateResolver(read).resolve(identity, [task([`https://github.com/synthetic/zeta/commit/${sha}`]), task([sha], 'S-2')]);
    expect(out.summary.latest?.repository.name).toBe('alpha'); expect(out.summary.coverage.references.resolved).toBe(2);
  });
  it.each([false, true])('incomplete or unversioned PR membership is unresolved (%s)', async complete => {
    const read = adapter(); read.pull = async () => ({ complete, membershipRevision: '', commits: [record()] });
    const out = await new LinkedCommitDateResolver(read).resolve(identity, [task(['https://github.com/synthetic/alpha/pull/12'])]);
    expect(out.summary.latest).toBeNull(); expect(out.tasks[0]!.references[0]).toMatchObject({ reason: 'incomplete-membership' });
  });
  it.each(['2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00+09:00', 'invalid'])('rejects invalid/nonUTC timestamp %s', async time => {
    const read = adapter(); read.commit = async () => ({ complete: true, commits: [record(time)] });
    expect((await new LinkedCommitDateResolver(read).resolve(identity, [task()])).summary.state).toBe('unknown');
    expect(linkedDateKst(time)).toBeNull();
  });
  it('has no fallback for author/mtime/snapshot/PR dates', async () => {
    const read = adapter(); read.commit = async () => ({ complete: true, commits: [{ ...record(), committerAtUtc: undefined, authorAt: '2030-01-01T00:00:00Z', mtime: 999 } as unknown as VerifiedCommitRecord] });
    expect((await new LinkedCommitDateResolver(read).resolve(identity, [task()])).summary.latest).toBeNull();
  });
  it('cache binds source/session/resolver revision and declarations', async () => {
    const read = adapter(); const resolver = new LinkedCommitDateResolver(read);
    const one = await resolver.resolve(identity, [task()]); expect(await resolver.resolve(identity, [task()])).toBe(one);
    expect(read.commit).toHaveBeenCalledTimes(1);
    await resolver.resolve({ ...identity, sessionKey: 'next' }, [task()]); read.revision = 'next'; await resolver.resolve(identity, [task()]);
    await resolver.resolve(identity, [task([sha], 'different')]); expect(read.commit).toHaveBeenCalledTimes(4);
    resolver.clear(); await resolver.resolve(identity, [task()]); expect(read.commit).toHaveBeenCalledTimes(5);
  });
  it('does not cache transient unresolved results or mutable local adapter hits', async () => {
    const read = adapter(); read.commit = vi.fn(async () => ({ complete: false, commits: [] })); const resolver = new LinkedCommitDateResolver(read);
    await resolver.resolve(identity, [task()]); await resolver.resolve(identity, [task()]); expect(read.commit).toHaveBeenCalledTimes(2);
    read.cache = false; read.commit = vi.fn(async () => ({ complete: true, commits: [record()] }));
    await resolver.resolve(identity, [task()]); await resolver.resolve(identity, [task()]); expect(read.commit).toHaveBeenCalledTimes(2);
  });
  it('times out an uncooperative adapter and rejects cancellation without late cache writes', async () => {
    const read = adapter(); let complete!: (r: { complete: boolean; commits: VerifiedCommitRecord[] }) => void;
    read.commit = () => new Promise(resolve => { complete = resolve; });
    const resolver = new LinkedCommitDateResolver(read, 5);
    await expect(resolver.resolve(identity, [task()])).rejects.toThrow('timeout'); complete({ complete: true, commits: [record()] });
    await new Promise(resolve => setTimeout(resolve, 0));
    const controller = new AbortController(); const pending = resolver.resolve(identity, [task()], controller.signal); controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
  });
  it('clear invalidates in-flight work and caller mutation cannot change captured provenance', async () => {
    const read = adapter(); let release!: () => void;
    read.commit = async () => { await new Promise<void>(r => { release = r; }); return { complete: true, commits: [record()] }; };
    const resolver = new LinkedCommitDateResolver(read); const input = task(); const pending = resolver.resolve(identity, [input]);
    input.id = 'changed'; resolver.clear(); release(); await expect(pending).rejects.toThrow('source-changed');
    const next = resolver.resolve(identity, [task()]); release(); expect((await next).summary.latest?.taskId).toBe('S-1');
  });
  it('enforces input and evidence bounds', async () => {
    const resolver = new LinkedCommitDateResolver(adapter());
    await expect(resolver.resolve(identity, [task(), task()])).rejects.toThrow('unsupported');
    await expect(resolver.resolve(identity, [task(Array(20_001).fill(sha))])).rejects.toThrow('unsupported');
    const read = adapter(); read.pull = async () => ({ complete: true, membershipRevision: 'r', commits: Array(1001).fill(record()) });
    expect((await new LinkedCommitDateResolver(read).resolve(identity, [task(['https://github.com/synthetic/alpha/pull/12'])])).summary.state).toBe('unknown');
  });
  it('formats KST year rollover, explicit year context and multiple years without I/O', () => {
    expect(linkedDateKst('2026-12-31T16:00:00Z')).toBe('2027.01.01 01:00:00 KST');
    expect(linkedDateCard('2026-12-31T16:00:00Z', '2027')).toBe('01.01');
    expect(linkedDateCard('2026-12-31T16:00:00Z', '2026')).toBe('2027.01.01');
    expect(linkedDateCard('2025-01-01T00:00:00Z')).toBe('2025.01.01');
  });
});
