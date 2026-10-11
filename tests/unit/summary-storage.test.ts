import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ASPECTS, bindSummaryContext, createSummaryStore, parseSummaryStoreState, restoreSummaryStoreFromLocalCache, type SummaryResponse } from '../../src/summary/claims';
import { extractProjectionContext } from '../../src/summary/context/projection';
import { buildContextPack } from '../../src/summary/context';
import { createLocalSummaryCache, MAX_SUMMARY_CACHE_BYTES } from '../../src/summary/storage';
import { summaryCacheCodec, type SummaryCachePayload } from '../../src/summary/storage/payload';
const fault = vi.hoisted(() => ({ afterWrite: null as (() => void) | null, beforeRename: null as (() => void) | null, beforeUnlink: null as (() => void) | null, beforeLstat: null as ((filename: string) => void) | null }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => { fault.beforeLstat?.(String(args[0])); return actual.lstat(...args); }, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]).endsWith('.tmp')) {
      const write = handle.write.bind(handle);
      handle.write = (async (...values: Parameters<typeof write>) => {
        const result = await write(...values); fault.afterWrite?.(); return result;
      }) as typeof handle.write;
    }
    return handle;
  }, unlink: async (...args: Parameters<typeof actual.unlink>) => { fault.beforeUnlink?.(); return actual.unlink(...args); }, rename: async (...args: Parameters<typeof actual.rename>) => { fault.beforeRename?.(); return actual.rename(...args); } };
});
const at = '2026-10-02T12:00:00.000Z';
const digest = (x: string) => `sha256:${createHash('sha256').update(x).digest('hex')}`;
function pack(text = 'Synthetic work is running', include = true) {
  return buildContextPack({ schemaVersion: 1, scopeId: 'test', records: include ? [{ sourceId: 'excerpt-test', sourceHash: digest(text), observedAt: at, text, declaredStatus: 'running', dependencies: [] }] : [], coverage: { complete: true, totalCount: include ? 1 : 0, unknowns: [] }, previousSources: [], priorApprovedSummary: null, limits: { maxBytes: 32768, maxApproxTokens: 32768, maxRecords: 256 } });
}
function fixture(): SummaryCachePayload {
  const p = pack(); const store = createSummaryStore(p);
  const response: SummaryResponse = { schemaVersion: 1, ...bindSummaryContext(p), generatedAt: at,
    claims: ASPECTS.map(aspect => ({ claimId: aspect, aspect, kind: aspect === 'next' ? 'inference' : 'fact', intent: aspect === 'next' ? 'proposal' : 'informational', text: p.records[0].text, citations: [{ sourceId: p.records[0].sourceId, sourceHash: p.records[0].sourceHash, observedAt: at, quote: p.records[0].text }], assertions: [] })) };
  expect(store.acceptResponse(store.beginUpdate()!, response)).toBe(true);
  const snapshot = store.snapshot();
  expect(store.approve({ kind: 'user-summary-approval', incarnation: snapshot.incarnation, scopeId: 'test', candidateHash: snapshot.candidate!.candidateHash, expectedVersion: snapshot.version, approvalId: 'local-event', approvedAt: at })).toBe(true);
  return { state: store.exportState(), projectionContexts: [] };
}
const directories: string[] = [];
async function setup() {
  // Canonicalize only the trusted test root. Product cache paths still reject
  // symlink ancestors, including aliases such as macOS /var -> /private/var.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summary-cache-test-')));
  directories.push(directory);
  return { directory, filename: path.join(directory, 'summary-cache-v1.json'), cache: createLocalSummaryCache({ directory, codec: summaryCacheCodec }) };
}
afterEach(async () => { fault.afterWrite = null; fault.beforeRename = null; fault.beforeUnlink = null; fault.beforeLstat = null; for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe('main-owned local summary cache', () => {
  it('round trips across instances and preserves historical approval against changed/deleted evidence', async () => {
    const { cache, directory } = await setup(); expect(await cache.read()).toBeNull();
    const payload = fixture(); expect((await cache.write(payload, null)).revision).toBe(1);
    const reopened = createLocalSummaryCache({ directory, codec: summaryCacheCodec }); const loaded = (await reopened.read())!;
    expect(loaded.payload).toEqual(payload);
    const restored = restoreSummaryStoreFromLocalCache(loaded.payload.state, pack('Changed evidence'));
    expect(restored.snapshot().approved).toEqual(payload.state.approved);
    expect(restored.snapshot().approvedClaims.every(c => c.freshness === 'stale')).toBe(true);
    const deleted = restoreSummaryStoreFromLocalCache(loaded.payload.state, pack('', false));
    expect(deleted.snapshot().approvedClaims.every(c => c.freshness === 'unknown')).toBe(true);
    expect(deleted.snapshot().approved).toEqual(payload.state.approved);
  });
  it.each(['malformed', 'version', 'integrity', 'oversized'])('rejects %s without replacing corrupt bytes or empty-success', async kind => {
    const { cache, filename } = await setup(); await cache.write(fixture(), null);
    const raw = JSON.parse(await fs.readFile(filename, 'utf8'));
    let corrupt = '{';
    if (kind === 'version') { raw.schemaVersion = 2; corrupt = JSON.stringify(raw); }
    if (kind === 'integrity') { raw.payload.state.version++; corrupt = JSON.stringify(raw); }
    if (kind === 'oversized') corrupt = ' '.repeat(MAX_SUMMARY_CACHE_BYTES + 1);
    await fs.writeFile(filename, corrupt);
    await expect(cache.read()).rejects.toMatchObject({ code: 'invalid' });
    await expect(cache.write(fixture(), 1)).rejects.toMatchObject({ code: 'invalid' });
    expect(await fs.readFile(filename, 'utf8')).toBe(corrupt);
  });
  it('rejects stale revisions and concurrent writers', async () => {
    const { cache, directory } = await setup(); const payload = fixture(); await cache.write(payload, null);
    await expect(cache.write(payload, null)).rejects.toMatchObject({ code: 'conflict' });
    await cache.write(payload, 1);
    await expect(cache.write(payload, 1)).rejects.toMatchObject({ code: 'conflict' });
    const results = await Promise.allSettled([cache.write(payload, 2), createLocalSummaryCache({ directory, codec: summaryCacheCodec }).write(payload, 2)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await cache.read())!.revision).toBe(3);
  });
  it.each(['cancel', 'failure'])('cleans owned partial temporary writes on %s and preserves last good', async kind => {
    const { cache, filename, directory } = await setup(); const payload = fixture(); await cache.write(payload, null);
    const good = await fs.readFile(filename, 'utf8'); const controller = new AbortController();
    fault.afterWrite = () => { if (kind === 'cancel') controller.abort(); else throw new Error('Synthetic disk failure'); };
    await expect(cache.write(payload, 1, controller.signal)).rejects.toThrow();
    expect(await fs.readFile(filename, 'utf8')).toBe(good);
    expect(await fs.readdir(directory)).toEqual(['summary-cache-v1.json']);
  });
  it('returns committed success when cancellation arrives after rename begins', async () => {
    const { cache } = await setup(); const controller = new AbortController();
    fault.beforeRename = () => controller.abort();
    expect((await cache.write(fixture(), null, controller.signal)).revision).toBe(1);
    expect((await cache.read())!.revision).toBe(1);
  });
  it('does not delete stale locks or unrelated temporary files', async () => {
    const { cache, directory } = await setup();
    await fs.writeFile(path.join(directory, '.summary-cache.lock'), 'other writer');
    await fs.writeFile(path.join(directory, '.summary-cache-unrelated.tmp'), 'retain');
    await expect(cache.write(fixture(), null)).rejects.toMatchObject({ code: 'busy' });
    expect(await fs.readFile(path.join(directory, '.summary-cache.lock'), 'utf8')).toBe('other writer');
    expect(await fs.readFile(path.join(directory, '.summary-cache-unrelated.tmp'), 'utf8')).toBe('retain');
  });
  it('rejects symlink cache files, symlink ancestors and lexical escapes', async () => {
    const { cache, directory, filename } = await setup(); const target = path.join(directory, 'other'); await fs.writeFile(target, 'retain');
    await fs.symlink(target, filename); await expect(cache.read()).rejects.toMatchObject({ code: 'unsafe-path' });
    await expect(cache.write(fixture(), null)).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await fs.readFile(target, 'utf8')).toBe('retain');
    const alias = path.join(directory, 'alias'); await fs.symlink(directory, alias);
    await expect(createLocalSummaryCache({ directory: alias, codec: summaryCacheCodec }).read()).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(() => createLocalSummaryCache({ directory: `${directory}/../escape`, codec: summaryCacheCodec })).toThrow();
  });
  it('rejects an aliased temporary ancestor until its trusted fixture root is explicitly canonicalized', async () => {
    const { directory } = await setup();
    const realParent = path.join(directory, 'real'), aliasParent = path.join(directory, 'alias');
    await fs.mkdir(realParent);
    await fs.symlink(realParent, aliasParent, 'dir');
    const aliased = await fs.mkdtemp(path.join(aliasParent, 'cache-'));
    const canonical = await fs.realpath(aliased);
    expect(aliased).not.toBe(canonical);
    const unsafe = createLocalSummaryCache({ directory: aliased, codec: summaryCacheCodec });
    await expect(unsafe.read()).rejects.toMatchObject({ code: 'unsafe-path' });
    await expect(unsafe.write(fixture(), null)).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(await fs.readdir(canonical)).toEqual([]);
    const safe = createLocalSummaryCache({ directory: canonical, codec: summaryCacheCodec });
    expect((await safe.write(fixture(), null)).revision).toBe(1);
    expect((await safe.read())!.revision).toBe(1);
    // Creating valid bytes through the canonical path does not authorize aliases.
    await expect(unsafe.read()).rejects.toMatchObject({ code: 'unsafe-path' });
  });
  it('preserves last good after invalid refresh and rejects rehashed malformed pack/candidate state', async () => {
    const { cache } = await setup(); const payload = fixture(); await cache.write(payload, null);
    const restored = restoreSummaryStoreFromLocalCache(payload.state, pack());
    // A new request on restored current state is a no-op; context change makes refresh due.
    restored.updateContext(pack('new'));
    expect(restored.acceptResponse(restored.beginUpdate()!, { approved: true })).toBe(false);
    const failed = { state: restored.exportState(), projectionContexts: [] };
    await cache.write(failed, 1);
    expect((await cache.read())!.payload.state.approved).toEqual(payload.state.approved);
    const bad = structuredClone(payload.state); bad.packs[0].records[0].declaredStatus = 'executed' as never;
    const { packHash: _, ...body } = bad.packs[0]; bad.packs[0].packHash = digest(JSON.stringify(body)); bad.currentPackHash = bad.packs[0].packHash;
    expect(() => parseSummaryStoreState(bad)).toThrow();
    const tampered = structuredClone(payload); tampered.state.candidate!.claims[0].text = 'Fake';
    await expect(cache.write(tampered, 2)).rejects.toMatchObject({ code: 'invalid' });
    expect((await cache.read())!.revision).toBe(2);
  });
});

function rehashStatePack(state: SummaryCachePayload['state']) {
  const p = state.packs[0];
  for (let i = 0; i < 10; i++) { p.usage.bytes = Buffer.byteLength(JSON.stringify(p)); p.usage.approximateTokens = p.usage.bytes; }
  const { packHash: _, ...body } = p; p.packHash = digest(JSON.stringify(body)); state.currentPackHash = p.packHash;
}
it('rejects impossible rehashed retrieval and historical-source metadata', () => {
  const empty = createSummaryStore(pack('', false)).exportState();
  const missing = structuredClone(empty); missing.packs[0].unresolvedDependencyIds = ['invented']; rehashStatePack(missing);
  expect(() => parseSummaryStoreState(missing)).toThrow(/unresolved/);
  const prior = structuredClone(empty); prior.packs[0].priorApprovedSummary = { text: 'Synthetic old approval', approvedAt: at, approvalId: 'old', sources: [{ sourceId: 'invented', sourceHash: digest('fake') }], freshness: 'stale' }; rehashStatePack(prior);
  expect(() => parseSummaryStoreState(prior)).toThrow(/provenance/);
});
it('round trips local projection provenance without leaking it into prompt packs and rejects scope mismatch', async () => {
  const projection = extractProjectionContext({ schemaVersion: 1, dagId: 'local-private-dag', dag: {
    dagId: 'local-private-dag', sourceHash: 'a'.repeat(64), sourceMtimeMs: 1, observedAt: at, doneStatus: 'done',
    tasks: [{ id: 'A', title: 'Synthetic task', status: 'running', dependencies: [], e2e: { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' }, commitReferences: [], commitVerification: 'not-performed' }],
    statusCounts: [{ status: 'running', count: 1 }], coverage: { tasksTotal: 1, declared: 0, required: 0, uncoveredDone: [], uncoveredOpen: [], malformed: [] }, verifiedFacts: [],
  }, requestedTaskIds: ['A'], excerpts: [], previousSources: [], priorApprovedSummary: null, limits: { maxBytes: 32768, maxApproxTokens: 32768, maxRecords: 256 } });
  const p = buildContextPack(projection.input); const state = createSummaryStore(p).exportState();
  const { cache, filename } = await setup(); await cache.write({ state, projectionContexts: [projection] }, null);
  expect((await cache.read())!.payload.projectionContexts).toEqual([projection]);
  expect(await fs.readFile(filename, 'utf8')).toContain('local-private-dag');
  expect(JSON.stringify(p)).not.toContain('local-private-dag'); expect(JSON.stringify(p)).not.toContain('upstream');
  await expect(cache.write({ state, projectionContexts: [] }, 1)).rejects.toThrow();
  await expect(cache.write({ state, projectionContexts: [projection, projection] }, 1)).rejects.toThrow();
  const emptyState = createSummaryStore(buildContextPack({ ...projection.input, records: [], coverage: { complete: true, totalCount: 0, unknowns: [] } })).exportState();
  expect(() => summaryCacheCodec.parse({ state: emptyState, projectionContexts: [projection] })).toThrow();
  const wrong = structuredClone(state); wrong.packs[0].scopeId = 'another-scope'; rehashStatePack(wrong);
  expect(() => summaryCacheCodec.parse({ state: wrong, projectionContexts: [projection] })).toThrow();
});
it('rejects oversized write data and accessors before touching disk', async () => {
  const { cache, directory } = await setup(); let invoked = false; const payload = fixture();
  Object.defineProperty(payload, 'projectionContexts', { get() { invoked = true; return []; } });
  await expect(cache.write(payload, null)).rejects.toMatchObject({ code: 'invalid' }); expect(invoked).toBe(false);
  const huge = fixture() as unknown as Record<string, unknown>; huge.extra = 'x'.repeat(MAX_SUMMARY_CACHE_BYTES + 1);
  await expect(cache.write(huge as unknown as SummaryCachePayload, null)).rejects.toMatchObject({ code: 'invalid' });
  expect(await fs.readdir(directory)).toEqual([]);
});

it('reports post-commit cleanup failure explicitly rather than implying rollback', async () => {
  const { cache } = await setup(); fault.beforeUnlink = () => { throw new Error('Synthetic cleanup failure'); };
  await expect(cache.write(fixture(), null)).rejects.toMatchObject({ code: 'committed-cleanup-failed', committedRevision: 1 });
  expect((await cache.read())!.revision).toBe(1);
  await expect(cache.write(fixture(), 1)).rejects.toMatchObject({ code: 'busy' });
});

it.each(['EIO','EACCES'])('does not hide cleanup lstat %s as a missing lock', async code => {
  const {cache}=await setup();
  fault.beforeLstat=filename=>{if(filename.endsWith('.summary-cache.lock'))throw Object.assign(new Error('Synthetic metadata failure'),{code});};
  await expect(cache.write(fixture(),null)).rejects.toMatchObject({code:'committed-cleanup-failed',committedRevision:1});
  expect((await cache.read())!.revision).toBe(1);
  await expect(cache.write(fixture(),1)).rejects.toMatchObject({code:'busy'});
});
