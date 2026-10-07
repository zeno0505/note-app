import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDagReader, type DagReadModel, type DagCoverage, type DagError } from '../../src/facts/dag-read-model';
import { projectDagQuery } from '../../src/facts/dag-read-model/projection';
import { QUERY_SHA256 } from '../../src/facts/dag-read-model/process';
import {delayFixtureStartup,waitForReadyPid} from './helpers/process-startup';
import { createSnapshotStore } from '../../src/collector/snapshot';
import * as ownedGroups from '../../src/collector/orca/process-group';

const ioHooks = vi.hoisted(() => ({
  realpath: null as null | ((...args: unknown[]) => Promise<unknown>),
  open: null as null | ((...args: unknown[]) => Promise<unknown>),
  mkdtemp: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => ioHooks.realpath ? ioHooks.realpath(...args) : actual.realpath(...args),
    open: (...args: Parameters<typeof actual.open>) => ioHooks.open ? ioHooks.open(...args) : actual.open(...args),
    mkdtemp: (...args: Parameters<typeof actual.mkdtemp>) => ioHooks.mkdtemp ? ioHooks.mkdtemp(...args) : actual.mkdtemp(...args),
  };
});
const directories: string[] = [];
const wire = () => ({ index: [
  { id: 'T-001', title: 'Synthetic declared completion', status: 'finished', depends_on: ['EXT-1'], commits: ['abc123'], e2e: { required: true, covered_by: [] }, description: 'DO NOT RETAIN' },
  { id: 'T-002', status: 'future-vocabulary', depends_on: ['T-001'] },
  { id: 'T-003', status: 'pending', e2e: { required: true, covered_by: ['fixture-e2e'] } },
], coverage: { tasks_total: 3, declared: 2, required: 2, uncovered_done: [{ id: 'T-001' }], uncovered_open: [], malformed: [] } });
async function setup(body = `process.stdout.write(${JSON.stringify(JSON.stringify(wire()))});`) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dag-adapter-test-'))); directories.push(directory);
  const source = join(directory, 'dag.yaml'), executable = join(directory, 'python-stub'), script = join(directory, 'external-query.py');
  await writeFile(source, 'synthetic source'); await writeFile(script, 'synthetic unexecuted query');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(directory, 'calls'))}, JSON.stringify(process.argv.slice(2))+'\\n');\n${body}`); await chmod(executable, 0o700);
  const options = { pythonPath: executable, queryScriptPath: script, doneStatus: 'finished', registrations: [{ dagId: 'dag-test', canonicalDagPath: source }] };
  return { directory, source, executable, script, options };
}
afterEach(async () => { ioHooks.realpath = null; ioHooks.open = null; ioHooks.mkdtemp = null; vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('DAG authoritative-query projection', () => {
  it('keeps legacy scalar commits and marks unsupported optional entries without losing task or coverage declarations',()=>{
    const value=wire();value.index[0].commits='legacy-declaration' as never;value.index[1].commits=['supported',{sha:'do-not-infer-object-sha'},17] as never;
    const projected=projectDagQuery(value);
    expect(projected.tasks[0]).toMatchObject({commitReferences:['legacy-declaration'],commitVerification:'not-performed'});
    expect(projected.tasks[1]).toMatchObject({commitReferences:['supported'],commitReferencesUnsupported:2,commitVerification:'not-performed'});
    expect(projected.coverage.uncoveredDone).toEqual(['T-001']);expect(projected.tasks[1].status).toBe('future-vocabulary');expect(JSON.stringify(projected)).not.toContain('do-not-infer-object-sha');
  });
  it('keeps declared vocabulary, external dependencies, E2E distinctions and unverified references separate', () => {
    const result = projectDagQuery(wire());
    expect(result.tasks[0]).toMatchObject({ status: 'finished', dependencies: [{ id: 'EXT-1', scope: 'external' }], e2e: { coverage: 'unmet' }, commitReferences: ['abc123'], commitVerification: 'not-performed' });
    expect(result.tasks[1]).toMatchObject({ status: 'future-vocabulary', dependencies: [{ id: 'T-001', scope: 'internal' }], e2e: { coverage: 'undeclared' } });
    expect(result.tasks[2].e2e.coverage).toBe('references-declared');
    expect(JSON.stringify(result)).not.toContain('DO NOT RETAIN');
    expect(result.coverage.uncoveredDone).toEqual(['T-001']);
  });
  it('represents malformed E2E coverage without interpreting it as passed', () => {
    const value = wire(); value.index[0].e2e = { required: true, covered_by: 'wrong-shape' as never };
    value.coverage.uncovered_done = []; value.coverage.required = 1; value.coverage.malformed = [{ id: 'T-001' }] as never;
    expect(projectDagQuery(value).tasks[0].e2e.coverage).toBe('malformed');
  });
  it.each([null, {}, { index: [], coverage: {} }, { ...wire(), index: [...wire().index, wire().index[0]] }, { ...wire(), coverage: { ...wire().coverage, tasks_total: 300 } }, { ...wire(), coverage: { ...wire().coverage, uncovered_open: [{ id: 'unrecognized' }] } }])('rejects incompatible output (%j)', value => {
    expect(() => projectDagQuery(value)).toThrow();
  });
});

describe('bounded registered DAG reader (synthetic subprocess)', () => {
  it('executes fixed query modes once, protects cache from mutation, and skips parsing on unchanged hash even if mtime changes', async () => {
    const t = await setup(); const reader = createDagReader(t.options);
    const first = await reader.read('dag-test'); expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.value.tasks[0].status = 'MUTATED';
    await utimes(t.source, new Date(), new Date(Date.now() + 10000));
    const second = await reader.read('dag-test'); expect(second).toMatchObject({ ok: true, unchanged: true, value: { tasks: [{ status: 'finished' }, {}, {}], verifiedFacts: [] } });
    const calls = (await readFile(join(t.directory, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual(['-I', '-B', '-c']);
    expect(calls[0][3]).toContain("'--index', '--fields', 'id,title,status,depends_on,e2e,commits'");
    expect(calls[0][3]).not.toContain('--brief');
    expect(calls[0].slice(4, 8)).toEqual([t.script, t.source, 'finished', QUERY_SHA256]);
  });
  it('rehashes equal-size rewrites with restored mtime and queries again', async () => {
    const t = await setup(); const reader = createDagReader(t.options); await reader.read('dag-test');
    const previous = await stat(t.source); await writeFile(t.source, 'different source'); await utimes(t.source, previous.atime, previous.mtime);
    expect(await reader.read('dag-test')).toMatchObject({ ok: true, unchanged: false });
    expect((await readFile(join(t.directory, 'calls'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });
  it('rejects paths/commands instead of registered IDs, and rejects symlink retargeting', async () => {
    const t = await setup(); const reader = createDagReader(t.options);
    expect(await reader.read(t.source)).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    await rm(t.source); await symlink(t.script, t.source);
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'source_changed' } });
    await expect(readFile(join(t.directory, 'calls'))).rejects.toThrow();
  });
  it('bounds source bytes before spawning', async () => {
    const t = await setup();
    expect(await createDagReader({ ...t.options, maxSourceBytes: 2 }).read('dag-test')).toMatchObject({ ok: false, error: { kind: 'source_limit' } });
    await expect(readFile(join(t.directory, 'calls'))).rejects.toThrow();
  });
  it.each([['process.stdout.write("x".repeat(10000))', 'output_limit'], ['process.stderr.write("secret".repeat(10000))', 'output_limit'], ['process.stdout.write("not json")', 'invalid_schema'], ['process.stdout.write("{}");process.exitCode=1', 'command_failed']] as const)('fails honestly for %s after slow synthetic startup', async (body, kind) => {
    // These assertions test output/schema/exit handling. They must not race a
    // 200ms deadline against host Node startup (observed on macOS).
    const t = await setup(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);\n${body}`);
    expect(await createDagReader({ ...t.options, maxOutputBytes: 2048 }).read('dag-test')).toMatchObject({ ok: false, error: { kind } });
  });
  it('retains the real 200ms timeout for a hanging subprocess independently of startup readiness', async () => {
    const t = await setup('setInterval(()=>{}, 1000)');
    expect(await createDagReader({ ...t.options, timeoutMs: 200 }).read('dag-test')).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });
  it('cancels, rejects overlap and removes its private snapshot directory', async () => {
    const t = await setup('setInterval(()=>{},1000)'); await delayFixtureStartup(t.executable,t.directory,1100); const reader = createDagReader(t.options), controller = new AbortController();
    const first = reader.read('dag-test', { signal: controller.signal });
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'busy' } });
    await waitForReadyPid(t.directory);
    controller.abort(); expect(await first).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    const call = JSON.parse((await readFile(join(t.directory, 'calls'), 'utf8')).trim());
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'cleanup_unverified' } });
    await vi.waitFor(async () => { await expect(stat(call.at(-1))).rejects.toThrow(); });
  });
  it('rejects a source changed while the subprocess was reading', async () => {
    const t = await setup();
    await writeFile(t.executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(t.source)},'raced change');process.stdout.write(${JSON.stringify(JSON.stringify(wire()))})`);
    expect(await createDagReader(t.options).read('dag-test')).toMatchObject({ ok: false, error: { kind: 'source_changed' } });
  });
  it('rejects a cached hash when atomic replacement occurs after open and before the first stat', async () => {
    const t = await setup(); const reader = createDagReader(t.options);
    expect(await reader.read('dag-test')).toMatchObject({ ok: true });
    const replacement = join(t.directory, 'replacement.yaml'); await writeFile(replacement, 'replacement bytes');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    ioHooks.open = async (...args) => {
      const handle = await actual.open(...args as Parameters<typeof actual.open>);
      if (args[0] === t.source) { ioHooks.open = null; await rename(replacement, t.source); }
      return handle;
    };
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'source_changed' } });
    expect((await readFile(join(t.directory, 'calls'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('bounds a permanently stalled realpath and refuses reuse without starting another IO', async () => {
    const t = await setup(); const reader = createDagReader({ ...t.options, timeoutMs: 20 });
    let calls = 0;
    ioHooks.realpath = async () => { calls++; return new Promise(() => {}); };
    const start = performance.now();
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(performance.now() - start).toBeLessThan(150);
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'cleanup_unverified' } });
    expect(calls).toBe(1);
    await expect(readFile(join(t.directory, 'calls'))).rejects.toThrow();
  });
  it('responds before a delayed realpath settles and never opens the source afterward', async () => {
    const t = await setup(); const reader = createDagReader({ ...t.options, timeoutMs: 20 });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let opens = 0;
    ioHooks.open = async (...args) => { opens++; return actual.open(...args as Parameters<typeof actual.open>); };
    ioHooks.realpath = async () => { await new Promise(resolve => setTimeout(resolve, 250)); return t.source; };
    const start = performance.now();
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(performance.now() - start).toBeLessThan(150);
    await new Promise(resolve => setTimeout(resolve, 275));
    expect(opens).toBe(0);
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'cleanup_unverified' } });
  });
  it('closes a handle whose open finishes after timeout without reading or spawning', async () => {
    const t = await setup(); const reader = createDagReader({ ...t.options, timeoutMs: 20 });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const handle = await actual.open(t.source, 'r'); const close = vi.spyOn(handle, 'close'), read = vi.spyOn(handle, 'read');
    let release!: () => void;
    ioHooks.open = async () => { await new Promise<void>(resolve => { release = resolve; }); return handle; };
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(read).not.toHaveBeenCalled();
    await expect(handle.stat()).rejects.toThrow();
    await expect(readFile(join(t.directory, 'calls'))).rejects.toThrow();
  });
  it('waits for a late read to finish before wiping its buffer and closing the handle', async () => {
    const t = await setup(); const reader = createDagReader({ ...t.options, timeoutMs: 20 });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const handle = await actual.open(t.source, 'r'); const close = vi.spyOn(handle, 'close');
    let release!: () => void, captured!: Buffer;
    vi.spyOn(handle, 'read').mockImplementation((async (buffer: Buffer) => {
      captured = buffer;
      await new Promise<void>(resolve => { release = resolve; });
      buffer.fill(65);
      return { bytesRead: buffer.length, buffer };
    }) as never);
    ioHooks.open = async () => handle;
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(close).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(captured.every(byte => byte === 0)).toBe(true);
    await expect(handle.stat()).rejects.toThrow();
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'cleanup_unverified' } });
  });
  it('does not spawn after temporary-directory creation finishes past the deadline', async () => {
    const t = await setup(); const reader = createDagReader({ ...t.options, timeoutMs: 20 });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release!: () => void, lateDirectory: string | undefined;
    ioHooks.mkdtemp = async (...args) => {
      await new Promise<void>(resolve => { release = resolve; });
      lateDirectory = await actual.mkdtemp(...args as Parameters<typeof actual.mkdtemp>) as string;
      return lateDirectory;
    };
    expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    release();
    await vi.waitFor(async () => { expect(lateDirectory).toBeDefined(); await expect(stat(lateDirectory!)).rejects.toThrow(); });
    await expect(readFile(join(t.directory, 'calls'))).rejects.toThrow();
  });
  it('retains last good at the snapshot-store boundary after query failure', async () => {
    const t = await setup(); const reader = createDagReader(t.options);
    const store = createSnapshotStore<DagReadModel, DagCoverage, DagError>({ active: false, load: async ({ signal }) => {
      const result = await reader.read('dag-test', { signal });
      return result.ok ? { kind: 'success', value: result.value, runtimeId: 'dag-test', observedAt: result.value.observedAt, sourceHash: result.value.sourceHash, coverage: result.value.coverage } : { kind: 'failure', error: result.error };
    } });
    try {
      const before = await store.refresh(); expect(before.freshness).toBe('current');
      await writeFile(t.source, 'changed'); await writeFile(t.executable, `#!${process.execPath}\nprocess.exit(1)`);
      const after = await store.refresh(); expect(after.value).toEqual(before.value); expect(after.freshness).toBe('stale'); expect(after.lastAttempt?.outcome).toBe('error');
    } finally { store.dispose(); }
  });
});

const pythonPath = process.env.DAG_QUERY_PYTHON;
const queryScriptPath = process.env.DAG_QUERY_SCRIPT;
describe.skipIf(!pythonPath || !queryScriptPath)('actual external authoritative query (opt-in private dependency)', () => {
  it('executes pinned query over synthetic YAML, preserves source and matches declared coverage', async () => {
    const t = await setup();
    await writeFile(t.source, JSON.stringify({ phases: [{ tasks: wire().index }] })); // JSON is a YAML subset; fixture authored here.
    const before = await readFile(t.source), beforeStat = await stat(t.source);
    const reader = createDagReader({ ...t.options, pythonPath: pythonPath!, queryScriptPath: queryScriptPath! });
    const result = await reader.read('dag-test');
    expect(result).toMatchObject({ ok: true, unchanged: false, value: { coverage: { tasksTotal: 3, declared: 2, required: 2, uncoveredDone: ['T-001'] }, tasks: [{ e2e: { coverage: 'unmet' } }, { e2e: { coverage: 'undeclared' } }, { e2e: { coverage: 'references-declared' } }] } });
    expect(await readFile(t.source)).toEqual(before); expect((await stat(t.source)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(createHash('sha256').update(await readFile(queryScriptPath!)).digest('hex')).toBe(QUERY_SHA256);
    expect(await reader.read('dag-test')).toMatchObject({ ok: true, unchanged: true });
  });
  it('runs a 1000-task YAML parse outside the event loop and rejects invalid YAML', async () => {
    const t = await setup();
    const tasks = Array.from({ length: 1000 }, (_, i) => ({ id: `T-${i}`, status: 'pending', description: 'synthetic bulky context '.repeat(50) }));
    await writeFile(t.source, JSON.stringify({ phases: [{ tasks }] }));
    let ticks = 0; const heartbeat = setInterval(() => ticks++, 5);
    const reader = createDagReader({ ...t.options, timeoutMs: 10000, pythonPath: pythonPath!, queryScriptPath: queryScriptPath! });
    try {
      const result = await reader.read('dag-test');
      expect(result).toMatchObject({ ok: true, value: { coverage: { tasksTotal: 1000, declared: 0, required: 0 } } });
      expect(ticks).toBeGreaterThan(2);
      await writeFile(t.source, 'phases: [broken');
      expect(await reader.read('dag-test')).toMatchObject({ ok: false, error: { kind: 'command_failed' } });
    } finally { clearInterval(heartbeat); }
  }, 15000);
  it('fails closed for an unrecognized script version', async () => {
    const t = await setup();
    expect(await createDagReader({ ...t.options, pythonPath: pythonPath!, queryScriptPath: t.script }).read('dag-test')).toMatchObject({ ok: false, error: { kind: 'command_failed' } });
  });
});

it('recovers a cancelled reader only after all owned work settles; repeated generations reject overlap',async()=>{
 const t=await setup('setInterval(()=>{},1000)');await delayFixtureStartup(t.executable,t.directory,1100);const reader=createDagReader(t.options);
 for(let generation=0;generation<2;generation++){
  const controller=new AbortController(),pending=reader.read('dag-test',{signal:controller.signal});
  expect(reader.recover!()).toBe(false);expect(await reader.read('dag-test')).toMatchObject({ok:false,error:{kind:'busy'}});
  await waitForReadyPid(t.directory);controller.abort();expect(await pending).toMatchObject({ok:false,error:{kind:'cancelled'}});
  expect(reader.recoveryState!()).toMatchObject({cause:'cancelled',retired:true,generation});
  await vi.waitFor(()=>expect(reader.recoveryState!()?.cleanup).toBe('verified'));
  expect(reader.recover!()).toBe(true);expect(reader.recover!()).toBe(false);
 }
 await writeFile(t.executable,`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(wire()))})`);
 expect(await reader.read('dag-test')).toMatchObject({ok:true,unchanged:false});expect(reader.recoveryState!()).toMatchObject({cause:'cancelled',retired:false,generation:2,cleanup:'verified'});
});
it('keeps timeout cause and refuses recovery while filesystem IO remains unresolved',async()=>{
 const t=await setup();const reader=createDagReader({...t.options,timeoutMs:20});let release!:(p:string)=>void;
 ioHooks.realpath=async()=>new Promise<string>(r=>{release=r});
 expect(await reader.read('dag-test')).toMatchObject({ok:false,error:{kind:'timeout'}});expect(reader.recoveryState!()).toMatchObject({cause:'timeout',cleanup:'pending'});expect(reader.recover!()).toBe(false);
 release(t.source);await vi.waitFor(()=>expect(reader.recoveryState!()?.cleanup).toBe('verified'));ioHooks.realpath=null;expect(reader.recover!()).toBe(true);
});
it('never recovers when process group cleanup was not verified',async()=>{
 const t=await setup();const cleanup=vi.spyOn(ownedGroups,'finalizeQueryGroup').mockResolvedValue(false);const reader=createDagReader(t.options);
 expect(await reader.read('dag-test')).toMatchObject({ok:false,error:{kind:'cleanup_unverified'}});expect(reader.recoveryState!()).toMatchObject({cause:'cleanup_unverified',cleanup:'unverified',retired:true});cleanup.mockRestore();
 expect(reader.recover!()).toBe(false);expect(await reader.read('dag-test')).toMatchObject({ok:false,error:{kind:'cleanup_unverified'}});
});
it('refuses recovery when closing the owned source handle fails',async()=>{
 const t=await setup();const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');const handle=await actual.open(t.source,'r');const close=vi.spyOn(handle,'close').mockRejectedValue(Error('synthetic close failure'));ioHooks.open=async()=>handle;
 try{const reader=createDagReader(t.options);expect(await reader.read('dag-test')).toMatchObject({ok:false,error:{kind:'cleanup_unverified'}});expect(reader.recoveryState!()).toMatchObject({cleanup:'unverified'});expect(reader.recover!()).toBe(false);}finally{close.mockRestore();await handle.close();}
});
