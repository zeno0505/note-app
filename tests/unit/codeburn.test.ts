import { afterEach, describe, expect, it } from 'vitest';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodeBurnReader, projectCodeBurn, type CodeBurnQuery } from '../../src/summary/budget/codeburn';
import { delayFixtureStartup, gateOperationDeadline, waitForReadyPid } from './helpers/process-startup';

const status = { currency: 'USD', today: { cost: 1.5, savings: 0, calls: 2 }, month: { cost: 20, savings: 1, calls: 40 } };
const quota = { providers: [
  { id: 'claude', name: 'Claude', available: false, windows: [], error: 'SYNTHETIC_SECRET_ERROR' },
  { id: 'codex', name: 'Codex', available: false, windows: [], error: 'SYNTHETIC_SECRET_ERROR' },
] };
const directories: string[] = [];
async function fixture(mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'codeburn-synthetic-')); directories.push(directory);
  const executablePath = join(directory, 'codeburn-mock');
  await writeFile(join(directory, 'mode'), mode);
  await writeFile(executablePath, `#!${process.execPath}\n
const fs = require('node:fs');
const dir = ${JSON.stringify(directory)};
fs.appendFileSync(dir + '/calls', JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(dir + '/pid', String(process.pid));
const mode = fs.readFileSync(dir + '/mode', 'utf8');
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (mode === 'stdout-overflow') process.stdout.write('SYNTHETIC_SECRET_ERROR'.repeat(10000));
else if (mode === 'stderr-overflow') process.stderr.write('SYNTHETIC_SECRET_ERROR'.repeat(10000));
else if (mode === 'nonzero') { process.stderr.write('SYNTHETIC_SECRET_ERROR'); process.exitCode = 1; }
else if (mode === 'invalid-json') process.stdout.write('SYNTHETIC_SECRET_ERROR');
else if (mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff]));
else if (mode === 'warning') { process.stderr.write('SYNTHETIC_SECRET_WARNING'); process.stdout.write(JSON.stringify(${JSON.stringify(status)})); }
else if (mode === 'invalid-schema') process.stdout.write('{}');
else process.stdout.write(JSON.stringify(process.argv[2] === 'quota' ? ${JSON.stringify(quota)} : ${JSON.stringify(status)}));
`, { mode: 0o700 });
  await chmod(executablePath, 0o700);
  return { directory, executablePath };
}
async function waitForPid(directory: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(join(directory, 'pid'), 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('Synthetic process did not start');
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('CodeBurn fact projection', () => {
  it('preserves absent records separately from reported zero and unknown collection flags', () => {
    const empty={cost:0,savings:0,calls:0};
    const none=projectCodeBurn('codex-status',{currency:'USD',hasUsage:false,today:{...empty,hasUsage:false},month:empty},123);
    expect(none).toMatchObject({ok:true,value:{hasUsage:false,periods:[{hasUsage:false,calls:0},{hasUsage:null,calls:0}]}});
    const unknown=projectCodeBurn('codex-status',{currency:'USD',today:empty,month:empty},123);
    expect(unknown).toMatchObject({ok:true,value:{hasUsage:null,periods:[{hasUsage:null},{hasUsage:null}]}});
    const reported=projectCodeBurn('codex-status',{currency:'USD',hasUsage:true,today:empty,month:{...status.month,hasUsage:true}},123);
    expect(reported).toMatchObject({ok:true,value:{hasUsage:true,periods:[{calls:0},{hasUsage:true,calls:40}]}});
  });

  it('preserves observed cost facts and timestamp without inventing calendar windows or budgets', () => {
    const result = projectCodeBurn('claude-status', { ...status, credential: 'DO_NOT_PROJECT' }, 123);
    expect(result).toMatchObject({ ok: true, value: { observedAt: 123, provider: 'claude', currency: 'USD',
      calendarBasis: 'unknown', provenance: 'codeburn-cli', periods: [
        { label: 'today', cost: 1.5, window: null, approximate: true }, { label: 'month', cost: 20, window: null, approximate: true },
      ] } });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_PROJECT');
    expect(JSON.stringify(result)).not.toContain('remaining');
  });
  it('keeps failed quota data independent of agent availability and redacts reported errors', () => {
    const result = projectCodeBurn('quota', quota, 123);
    expect(result).toMatchObject({ ok: true, value: { observedAt: 123, providers: [
      { provider: 'claude', quotaData: 'unavailable', agentAvailability: 'unknown', error: 'reported-error', windows: [] },
      { provider: 'codex', quotaData: 'unavailable', agentAvailability: 'unknown', error: 'reported-error', windows: [] },
    ] } });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_ERROR');
  });
  it('retains only reported quota fields without deriving a reset epoch or remaining quota', () => {
    const result = projectCodeBurn('quota', { providers: [{ id: 'claude', available: true, error: null,
      windows: [{ label: 'five-hour', usedPct: 35, resetsAt: '2026-10-03T00:00:00Z', unknown: 'DROP_ME' }] }] }, 123);
    expect(result).toMatchObject({ ok: true, value: { providers: [
      { quotaData: 'available', windows: [{ usedPct: 35, resetsAt: '2026-10-03T00:00:00Z', resetTimeFormat: 'unverified' }] },
      { provider: 'codex', quotaData: 'unknown', error: 'unknown', agentAvailability: 'unknown' },
    ] } });
    expect(JSON.stringify(result)).not.toContain('DROP_ME');
  });
  it('projects an omitted quota reset time as unknown without discarding reported usage', () => {
    const result = projectCodeBurn('quota', { providers: [{ id: 'claude', available: true,
      windows: [{ label: 'five-hour', usedPct: 35 }] }] }, 123);
    expect(result).toMatchObject({ ok: true, value: { providers: [
      { provider: 'claude', quotaData: 'available', windows: [
        { label: 'five-hour', usedPct: 35, resetsAt: null, resetTimeFormat: 'unverified' },
      ] },
      { provider: 'codex', quotaData: 'unknown', windows: [] },
    ] } });
  });
  it.each([null, 0, 1_800_000_000, '2026-10-03T00:00:00Z'])(
    'preserves a valid explicitly reported quota reset time (%j)', resetsAt => {
      const result = projectCodeBurn('quota', { providers: [{ id: 'claude', available: true,
        windows: [{ label: 'five-hour', usedPct: 35, resetsAt }] }] }, 123);
      expect(result).toMatchObject({ ok: true, value: { providers: [
        { windows: [{ resetsAt, resetTimeFormat: 'unverified' }] },
        { provider: 'codex', quotaData: 'unknown' },
      ] } });
    });
  it.each([undefined, false, true, '', ' ', '\u0000', 'a'.repeat(121), -1, NaN, Infinity, {}, []])(
    'rejects malformed explicitly present quota reset times (%j)', resetsAt => {
      expect(projectCodeBurn('quota', { providers: [{ id: 'claude', available: true,
        windows: [{ label: 'five-hour', usedPct: 35, resetsAt }] }] }, 123))
        .toMatchObject({ ok: false, error: { kind: 'invalid-schema' } });
    });
  it.each([null, {}, { ...status, currency: '$' }, { ...status, today: { cost: -1, savings: 0, calls: 1 } },
    { ...status, today: { cost: NaN, savings: 0, calls: 1 } }, { ...status, month: { cost: 1, savings: 0, calls: 1.2 } }])(
    'rejects unknown or invalid status shapes (%j)', input => {
      expect(projectCodeBurn('codex-status', input, 123)).toMatchObject({ ok: false, error: { kind: 'invalid-schema' } });
    });
  it.each([{ providers: null }, { providers: [quota.providers[0], quota.providers[0]] },
    { providers: [{ id: 'claude', available: 'false', windows: [] }] },
    { providers: [{ id: 'claude', available: true, windows: [], error: 'failure' }] },
    { providers: [{ id: 'claude', available: false, windows: [{ label: 'hour', usedPct: 1, resetsAt: null }] }] },
    { providers: [{ id: 'claude', available: true, windows: [{ label: 'hour', usedPct: '50%', resetsAt: null }] }] }])(
    'rejects unknown or inconsistent quota shapes (%j)', input => {
      expect(projectCodeBurn('quota', input, 123)).toMatchObject({ ok: false, error: { kind: 'invalid-schema' } });
    });
});

describe('bounded CodeBurn read process', () => {
  it('reports stderr presence and timestamp without retaining sensitive diagnostics',async()=>{
    const mock=await fixture('warning'),reader=createCodeBurnReader(mock),before=Date.now();const result=await reader.read('codex-status');
    expect(result).toMatchObject({ok:true,diagnostics:{stderrReported:true},value:{kind:'status',provider:'codex'}});if(result.ok)expect(result.value.observedAt).toBeGreaterThanOrEqual(before);expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_WARNING');
  });

  it('runs only the three documented argv sequences and timestamps completed reads', async () => {
    const mock = await fixture(); const reader = createCodeBurnReader(mock); const before = Date.now();
    for (const query of ['claude-status', 'codex-status', 'quota'] as const) {
      const result = await reader.read(query); expect(result.ok).toBe(true);
      if (result.ok) { expect(result.value.observedAt).toBeGreaterThanOrEqual(before); expect(result.value.observedAt).toBeLessThanOrEqual(Date.now()); }
    }
    expect((await readFile(join(mock.directory, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([
      ['status', '--format', 'json', '--provider', 'claude'], ['status', '--format', 'json', '--provider', 'codex'], ['quota', '--format', 'json'],
    ]);
  });
  it.each(['budget', 'plan', 'status; rm -rf /', '__proto__', null])('does not spawn unallowlisted query %j', async query => {
    const mock = await fixture(); const reader = createCodeBurnReader(mock);
    expect(await reader.read(query as CodeBurnQuery)).toMatchObject({ ok: false, error: { kind: 'forbidden-query' } });
    await expect(access(join(mock.directory, 'calls'))).rejects.toThrow();
  });
  it('requires an explicit absolute executable and bounded limits', () => {
    expect(() => createCodeBurnReader({ executablePath: 'codeburn' })).toThrow();
    expect(() => createCodeBurnReader({ executablePath: '/tmp/codeburn', timeoutMs: Infinity })).toThrow();
    expect(() => createCodeBurnReader({ executablePath: '/tmp/codeburn', maxOutputBytes: 0 })).toThrow();
  });
  it('times out and waits for the ready synthetic process to exit', async () => {
    const mock = await fixture('hang');
    await delayFixtureStartup(mock.executablePath, mock.directory, 300);
    const deadline = gateOperationDeadline(200), controller = new AbortController();
    const pending = createCodeBurnReader({ ...mock, timeoutMs: 200 }).read('quota', { signal: controller.signal });
    try {
      const pid = await waitForReadyPid(mock.directory);
      const started = performance.now(); deadline.start();
      expect(await pending).toMatchObject({ ok: false, error: { kind: 'timeout' } });
      expect(performance.now() - started).toBeGreaterThanOrEqual(190);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { deadline.dispose(); controller.abort(); await pending; }
  }, 10_000);
  it('keeps the real deadline bounded before a slow fixture becomes ready', async () => {
    const mock = await fixture('hang');
    await delayFixtureStartup(mock.executablePath, mock.directory, 1000);
    expect(await createCodeBurnReader({ ...mock, timeoutMs: 20 }).read('quota')).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    await expect(access(join(mock.directory, 'ready'))).rejects.toThrow();
  });
  it('cancels, rejects overlap, and permits later reuse after verified cleanup', async () => {
    const mock = await fixture('hang'); const reader = createCodeBurnReader(mock); const controller = new AbortController();
    const pending = reader.read('quota', { signal: controller.signal }); const pid = await waitForPid(mock.directory);
    expect(await reader.read('claude-status')).toMatchObject({ ok: false, error: { kind: 'busy' } });
    controller.abort(); expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(() => process.kill(pid, 0)).toThrow();
    await writeFile(join(mock.directory, 'mode'), 'normal');
    expect((await reader.read('quota')).ok).toBe(true);
  });
  it('does not spawn when already cancelled', async () => {
    const mock = await fixture(); const controller = new AbortController(); controller.abort();
    expect(await createCodeBurnReader(mock).read('quota', { signal: controller.signal })).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    await expect(access(join(mock.directory, 'calls'))).rejects.toThrow();
  });
  it.each([
    ['stdout-overflow', 'output-limit'], ['stderr-overflow', 'output-limit'], ['nonzero', 'command-failed'],
    ['invalid-json', 'invalid-json'], ['invalid-utf8', 'invalid-json'], ['invalid-schema', 'invalid-schema'],
  ])('returns sanitized bounded %s failure', async (mode, kind) => {
    const mock = await fixture(mode);
    const result = await createCodeBurnReader({ ...mock, maxOutputBytes: 1024 }).read('quota');
    expect(result).toMatchObject({ ok: false, error: { kind } });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_ERROR');
  });
  it('reports a missing executable without leaking paths or operating-system errors', async () => {
    const mock = await fixture(); await rm(mock.executablePath);
    const result = await createCodeBurnReader(mock).read('quota');
    expect(result).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(JSON.stringify(result)).not.toContain(mock.directory);
  });
});
