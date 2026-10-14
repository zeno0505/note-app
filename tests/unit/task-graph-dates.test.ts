import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskGraphDateService, registerTaskGraphDatesIpc } from '../../src/main/task-graph-dates';
import { inspectGitActivityMetadata } from '../../src/summary/reading/git-activity-metadata';
import type { DagReadModel } from '../../src/facts/dag-read-model';
import type { GraphDateReadResult } from '../../src/shared/task-graph-dates';
const graph = { projectId: 'p', dagId: 'd', sessionKey: 'session' };
const request = { ...graph, requestId: 'r', expectedRevision: null };
const repository = { host: 'github.com', owner: 'synthetic', name: 'repo' };
const model = (refs: string[] = []): DagReadModel => ({ dagId: 'd', sourceHash: 'a'.repeat(64), sourceMtimeMs: 999999, observedAt: '2030-01-01T00:00:00Z', doneStatus: 'done', statusCounts: [], verifiedFacts: [],
  coverage: { tasksTotal: 1, declared: 0, required: 0, uncoveredDone: [], uncoveredOpen: [], malformed: [] },
  tasks: [{ id: 'S-1', title: 'Synthetic', status: 'done', dependencies: [], commitReferences: refs, commitVerification: 'not-performed', e2e: { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' } }] });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const base = (dag = model()) => ({ source: async () => ({ authority: graph, dag }), current: () => graph, repository: () => repository, authority: async () => null });
describe('production graph date service and registered IPC path', () => {
  it('resolves an actual permitted local object through registered handler and projects immutable evidence', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'graph-dates-ipc-'))); roots.push(root);
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' } }).trim();
    git(['init', '-b', 'synthetic']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic']);
    const sha = git(['rev-parse', 'HEAD']); const descriptor = await inspectGitActivityMetadata(root, [path.join(root, '.git')], new AbortController().signal);
    const service = createTaskGraphDateService({ ...base(model([sha])), authority: async () => ({ descriptor, identity: 'grant', revision: 1, validate: async () => true }) });
    const handlers = new Map<string, (event: string, ...args: unknown[]) => unknown>();
    registerTaskGraphDatesIpc({ handle: (name, handler) => handlers.set(name, handler) }, service, event => { if (event !== 'trusted') throw Error('sender'); }, () => true, p => p);
    expect(() => handlers.get('note-app:graph-dates')!('bad', request)).toThrow('sender');
    const result = await handlers.get('note-app:graph-dates')!('trusted', request) as GraphDateReadResult;
    expect(result).toMatchObject({ state: 'dates', summary: { state: 'resolved', latest: { sha, committerAtUtc: '2026-01-02T03:04:05.000Z' } }, tasks: [{ id: 'S-1', summary: { state: 'resolved' } }] });
    expect(JSON.stringify(result)).not.toContain(root); expect(JSON.stringify(result)).not.toContain('2020');
  });
  it('keeps declared refs unknown when grant missing and counts unsupported declarations', async () => {
    const dag = model(['unsupported-declaration:0']); dag.tasks[0]!.commitReferencesUnsupported = 2;
    const result = await createTaskGraphDateService(base(dag)).read(request);
    expect(result).toMatchObject({ state: 'dates', summary: { state: 'unknown', coverage: { references: { total: 3, unresolved: 3 }, tasks: { unresolved: 1 } } } });
  });
  it('rejects stale sessions/revisions and source changes during resolution', async () => {
    const service = createTaskGraphDateService(base());
    expect(await service.read({ ...request, sessionKey: 'old' })).toMatchObject({ state: 'unavailable', reason: 'stale-session' });
    expect(await service.read({ ...request, expectedRevision: 'old' })).toMatchObject({ state: 'unavailable', reason: 'source-changed' });
    let reads = 0;
    const changed = createTaskGraphDateService({ ...base(), source: async () => ({ authority: graph, dag: { ...model(), sourceHash: (++reads === 1 ? 'a' : 'b').repeat(64) } }) });
    expect(await changed.read(request)).toMatchObject({ state: 'unavailable', reason: 'source-changed' });
  });
  it('retains a physical operation slot after cancellation until the source actually settles', async () => {
    let finish!: (value: { authority: typeof graph; dag: DagReadModel }) => void;
    let calls = 0;
    const service = createTaskGraphDateService({ ...base(), source: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    const pending = service.read(request); await Promise.resolve();
    expect(await service.read({ ...request, requestId: 'other' })).toMatchObject({ reason: 'unsupported' });
    service.cancel('r'); expect(await pending).toMatchObject({ reason: 'cancelled' });
    for (let i = 0; i < 10; i++) {
      expect(await service.read({ ...request, requestId: `retry-${i}` })).toMatchObject({ reason: 'unsupported' }); service.cancel();
    }
    expect(calls).toBe(1); finish({ authority: graph, dag: model() });
    await new Promise(resolve => setTimeout(resolve, 0));
    const next = service.read({ ...request, requestId: 'next' }); await Promise.resolve(); expect(calls).toBe(2);
    service.cancel(); expect(await next).toMatchObject({ reason: 'cancelled' }); finish({ authority: graph, dag: model() });
  });
  it('retains the physical slot for an abandoned metadata authority lookup', async () => {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: null) => void; let lookups = 0;
    const service = createTaskGraphDateService({ ...base(), authority: () => { lookups++; entered(); return new Promise<null>(resolve => { release = resolve; }); } });
    const pending = service.read(request); await ready; service.cancel();
    expect(await pending).toMatchObject({ reason: 'cancelled' });
    expect(await service.read({ ...request, requestId: 'next' })).toMatchObject({ reason: 'unsupported' });
    expect(lookups).toBe(1); release(null);
  });
  it('rejects renderer paths and unbounded unsupported counts', async () => {
    expect(await createTaskGraphDateService(base()).read({ ...request, path: '/tmp' })).toMatchObject({ reason: 'invalid-request' });
    const dag = model(); dag.tasks[0]!.commitReferencesUnsupported = 20_001;
    expect(await createTaskGraphDateService(base(dag)).read(request)).toMatchObject({ reason: 'unsupported' });
  });
});
