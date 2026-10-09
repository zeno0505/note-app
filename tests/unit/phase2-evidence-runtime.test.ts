import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLiveRuntime, type LiveRuntimeDependencies } from '../../src/main/live-runtime';
import type { LoadedLiveConfiguration } from '../../src/main/live-config-types';
import type { OrcaObservation } from '../../src/collector/orca';
import type { AllowedNoteScope } from '../../src/collector/notes';
import type { DagReadModel } from '../../src/facts/dag-read-model';
import type { EvidenceList } from '../../src/shared/evidence';
const roots: string[] = [], runtimes: ReturnType<typeof createLiveRuntime>[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) runtime.dispose(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==', 'base64');
function observation(tree: string): OrcaObservation {
  const coverage = { state: 'complete' as const, returnedCount: 1, totalCount: 1, truncated: false, hostIds: ['synthetic-host'], omittedHostIds: [] };
  const worktree = { id: 'tree', identity: { hostId: 'synthetic-host', instanceId: 'one', sourceKey: null }, repoId: 'repo', projectId: 'project', path: tree, branch: 'test', displayName: 'Synthetic evidence', isArchived: false, isMainWorktree: false };
  const project = { id: 'project', displayName: 'Synthetic evidence', sourceRepoIds: ['repo'] };
  return { runtimeId: 'synthetic-runtime', observedAt: new Date().toISOString(), status: { appRunning: true, runtimeReachable: true, runtimeState: 'ready', connectionState: 'connected', graphState: 'ready' }, projects: { records: [project], coverage }, worktrees: { records: [worktree], coverage }, processes: { records: [], coverage: { ...coverage, returnedCount: 0, totalCount: 0 } }, joined: [{ key: 'synthetic', worktree, project, projectMapping: 'matched', process: null, processMapping: 'not-observed' }], unmatchedProcesses: [], complete: true };
}
async function fixture(image = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-evidence-runtime-'))); roots.push(root);
  const note = path.join(root, 'vault', 'project'), tree = path.join(root, 'tree'), document = path.join(note, 'docs', 'design.md');
  await fs.mkdir(path.join(note, 'docs', 'images'), { recursive: true }); await fs.mkdir(path.join(tree, 'docs'), { recursive: true });
  await fs.writeFile(path.join(note, 'dag.yaml'), 'phases: []\n'); await fs.symlink(note, path.join(tree, 'docs', 'note'));
  await fs.writeFile(document, image ? '# Synthetic design\n![check](images/check.png)\n![remote](https://example.invalid/remote.png)' : '# Synthetic design\nSafe local text');
  await fs.writeFile(path.join(note, 'docs', 'images', 'check.png'), png);
  const scope: AllowedNoteScope = { scopeId: 'scope', hostId: 'synthetic-host', scopePath: note, vaultRootPath: path.join(root, 'vault'), dagRelativePaths: ['dag.yaml'] };
  const configuration: LoadedLiveConfiguration = { configuration: { schemaVersion: 1, orcaExecutablePath: '/synthetic/orca', localHostId: 'synthetic-host', noteScopes: [scope], summarySelections: [], dagQuery: { pythonPath: '/synthetic/python', queryScriptPath: '/synthetic/query' } }, view: { state: 'ready', message: 'Synthetic test', orcaExecutable: '/synthetic/orca', codeburnExecutable: null, noteScopeCount: 1, dagQueryConfigured: true, summaryTransport: 'blocked' } };
  let sourceHash = 'a'.repeat(64);
  const readDag = vi.fn<ReturnType<LiveRuntimeDependencies['dagReader']>['read']>(async dagId => {
    const value: DagReadModel = { dagId, sourceHash, sourceMtimeMs: 1, observedAt: new Date().toISOString(), doneStatus: 'done', tasks: [{ id: 'T-042', title: 'Synthetic evidence', status: 'pending', dependencies: [], e2e: { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' }, commitReferences: [], commitVerification: 'not-performed', details: { description: null, acceptanceCriteria: [], targetFiles: [], design: ['[[docs/design|Design]]'], discussion: [], omissions: 0 } }], statusCounts: [{ status: 'pending', count: 1 }], coverage: { tasksTotal: 1, declared: 0, required: 0, uncoveredDone: [], uncoveredOpen: [], malformed: [] }, verifiedFacts: [] };
    return { ok: true, value, unchanged: false };
  });
  const filterScopes = vi.fn(async (scopes: readonly AllowedNoteScope[]) => [...scopes]);
  const runtime = createLiveRuntime({ configuration, cacheRoot: path.join(root, 'unused-cache'), readRoots: { filterScopes, scopesFor: async () => [scope] }, dependencies: { orca: () => ({ collect: async () => ({ ok: true, value: observation(tree) }), read: vi.fn() }), dagReader: () => ({ read: readDag }), summaryCache: () => ({ read: async () => null }) } }); runtimes.push(runtime);
  const view = await runtime.connect(); expect(view.freshness).toBe('current'); expect(view.workstreams[0].noteMapping.context?.state).toBe('verified');
  const selection = { workstreamId: view.workstreams[0].id, taskId: 'T-042', sourceHash };
  const prepare = () => runtime.prepareTaskEvidence(selection);
  const read = (list: EvidenceList, expectedSourceHash: string | null = null) => runtime.readTaskEvidence({ sessionId: list.sessionId, evidenceId: list.items[0].evidenceId, expectedSourceHash });
  return { root, note, tree, document, runtime, filterScopes, readDag, selection, prepare, read, changeDag: () => { sourceHash = 'b'.repeat(64); } };
}
describe('Phase 2 evidence runtime session authorization', () => {
  it('reads real synthetic note evidence by opaque IDs and resolves only local declared image targets', async () => {
    const f = await fixture(true), list = await f.prepare(); expect(list.items).toHaveLength(1); expect(list.items[0].label).toBe('Design');
    const view = await f.read(list); expect(view.result).toMatchObject({ ok: true, content: { kind: 'text' }, verification: 'not-assessed' }); expect(view.images?.unsupportedCount).toBe(1); expect(view.images?.items).toHaveLength(1);
    const image = await f.read(view.images!); expect(image.result).toMatchObject({ ok: true, content: { kind: 'image', mime: 'image/png', width: 2, height: 3 } }); expect(JSON.stringify(image)).not.toContain(f.note);
    await expect(f.runtime.readTaskEvidence({ sessionId: list.sessionId, evidenceId: 'docs/design.md', expectedSourceHash: null })).resolves.toMatchObject({ result: { ok: false, code: 'unregistered' } });
  });
  it('rejects released sessions and their derived image sessions', async () => {
    const f = await fixture(true), list = await f.prepare(), view = await f.read(list);
    f.runtime.releaseTaskEvidence({ sessionId: list.sessionId }); await expect(f.read(list)).rejects.toThrow(); await expect(f.read(view.images!)).rejects.toThrow();
  });
  it('does not revive old capabilities across disconnect/reconnect or disposal', async () => {
    const f = await fixture(), list = await f.prepare(); await f.runtime.disconnect(); await expect(f.read(list)).rejects.toThrow(); await f.runtime.connect(); await expect(f.read(list)).rejects.toThrow();
    const next = await f.prepare(); f.runtime.dispose(); await expect(f.read(next)).rejects.toThrow();
  });
  it('rejects old DAG source selections and existing capabilities after a refreshed source change', async () => {
    const f = await fixture(), list = await f.prepare(); f.changeDag(); await f.runtime.refresh(); await expect(f.read(list)).rejects.toThrow(); await expect(f.prepare()).rejects.toThrow();
  });
  it('rejects stale evidence hashes and images whose parent declaration changed or disappeared', async () => {
    const f = await fixture(true), list = await f.prepare(), before = await f.read(list); if (!before.result.ok) throw new Error('Expected document');
    await fs.writeFile(f.document, '# Changed design with no image declaration');
    expect(await f.read(list, before.result.sourceHash)).toMatchObject({ result: { ok: false, code: 'stale-source' } }); await expect(f.read(before.images!)).rejects.toThrow();
    await fs.unlink(f.document); await expect(f.read(before.images!)).rejects.toThrow();
  });
  it('fails closed after current read-root permission is revoked', async () => {
    const f = await fixture(), list = await f.prepare(); f.filterScopes.mockResolvedValue([]); await expect(f.read(list)).rejects.toThrow(); await expect(f.prepare()).rejects.toThrow();
  });
  it('rejects a prepare whose permission await crosses disconnect', async () => {
    const f = await fixture(); let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
    f.filterScopes.mockImplementationOnce(async scopes => { await gate; return [...scopes]; });
    const pending = f.prepare(), rejected = expect(pending).rejects.toThrow(); await f.runtime.disconnect(); resume(); await rejected;
  });
  it('bounds simultaneous session registrations before root initialization', async () => {
    const f = await fixture(); let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
    f.filterScopes.mockImplementation(async scopes => { await gate; return [...scopes]; });
    const pending = Array.from({ length: 4 }, () => f.prepare()); await expect(f.prepare()).rejects.toThrow('처리 중'); resume(); const sessions = await Promise.all(pending); expect(new Set(sessions.map(s => s.sessionId)).size).toBe(4);
  });
  it('retires the oldest session when the bounded capability table fills', async () => {
    const f = await fixture(), lists: EvidenceList[] = [];
    for (let i = 0; i < 17; i++) lists.push(await f.prepare());
    await expect(f.read(lists[0])).rejects.toThrow(); expect(await f.read(lists.at(-1)!)).toMatchObject({ result: { ok: true } });
  });
  it('rechecks session membership after the final awaited permission decision', async () => {
    const f = await fixture(), list = await f.prepare(); let checks = 0, resume!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; }), lastCheck = new Promise<void>(resolve => { reached = resolve; });
    // Main precheck, reader before/after checks, main post-read check, then final publication check.
    f.filterScopes.mockImplementation(async scopes => { if (++checks === 5) { reached(); await gate; } return [...scopes]; });
    const pending = f.read(list), rejected = expect(pending).rejects.toThrow(); await lastCheck; f.runtime.releaseTaskEvidence({ sessionId: list.sessionId }); resume(); await rejected;
  });
  it('cancels an in-flight read on release and closes a descriptor delivered late', async () => {
    const f = await fixture(), list = await f.prepare(); const original = fs.open.bind(fs), closed = vi.fn(); let resume!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; }), opened = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => { const handle = await original(...args); if (args[0] === f.document) { const close = handle.close.bind(handle); handle.close = async () => { closed(); return close(); }; reached(); await gate; } return handle; });
    const pending = f.read(list), rejected = expect(pending).rejects.toThrow(); await opened; f.runtime.releaseTaskEvidence({ sessionId: list.sessionId }); await rejected; resume(); await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });
  it('bounds a stalled authorization and retains an unresolved-operation cap', async () => {
    const f=await fixture();vi.useFakeTimers();
    try{f.filterScopes.mockImplementation(()=>new Promise(()=>{}));const pending=f.prepare();const rejected=expect(pending).rejects.toThrow();await vi.advanceTimersByTimeAsync(5001);await rejected;}
    finally{vi.useRealTimers();}
  });

});
