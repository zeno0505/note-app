import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as processGroup from '../../src/collector/orca/process-group';
import {
  createRepositoryUsageReader, decodeRepositoryUsage, projectRepositoryUsage,
  type RepositoryUsageContext, type RepositoryUsagePeriod,
} from '../../src/phase2/repository-usage';

const split = { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 10 };
const period = { label: '2026-10-07 to 2026-10-07', start: '2026-10-07T00:00:00.000Z', end: '2026-10-07T23:59:59.999Z' };
const active = { firstActive: '2026-10-07T10:00:00.000Z', lastActive: '2026-10-07T11:00:00.000Z' };
const coverage = { branchKnownCost: 2, branchUnknownCost: 0, noBranchDataCost: 0, noBranchDataSessions: 0, noBranchDataProviders: [] as string[], distinctSessions: 1 };
function payload() {
  return { period: { ...period }, projects: [{ id: '/work/repo', label: 'repo', originKey: 'github.com/example/repo', totalCost: 2,
    branches: [{ projectId: '/work/repo', projectLabel: 'repo', branch: 'main' as string | null, cost: 2, calls: 3, sessions: 1,
      tokens: { ...split }, ...active, worktrees: [{ path: '/work/repo', sessions: 1, cost: 2 }], sessionRows: [{
        sessionId: 'session-1', provider: 'claude', workingDirectory: '/work/repo', cost: 2, calls: 3, tokens: { ...split },
        models: ['model-synthetic'], ...active,
      }] }], coverage: { ...coverage, noBranchDataProviders: [] as string[] } }], totals: { ...coverage, noBranchDataProviders: [] as string[] } };
}
const context: RepositoryUsageContext = { localHostId: 'host-local', checkouts: [{ workstreamId: 'wt-1', hostId: 'host-local',
  repositoryId: 'repo-1', repositoryKey: 'host-local:repo-1', checkoutPath: '/work/repo', registeredProjectId: 'project-1' }] };
const success = (input: unknown = payload()) => {
  const result = decodeRepositoryUsage('today', input, 1000);
  if (!result.ok) throw new Error('Synthetic payload was rejected');
  return result;
};
const directories: string[] = [];
async function fixture(mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'phase2-repository-usage-')); directories.push(directory);
  const executablePath = join(directory, 'codeburn-fixture');
  await writeFile(join(directory, 'mode'), mode);
  await writeFile(executablePath, `#!${process.execPath}\n
const fs = require('node:fs');
const dir = ${JSON.stringify(directory)};
fs.appendFileSync(dir + '/calls', JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync(dir + '/pid', String(process.pid));
const mode = fs.readFileSync(dir + '/mode', 'utf8');
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (mode === 'stdout-overflow') process.stdout.write('SYNTHETIC_SECRET'.repeat(10000));
else if (mode === 'stderr-overflow') process.stderr.write('SYNTHETIC_SECRET'.repeat(10000));
else if (mode === 'nonzero') { process.stderr.write('SYNTHETIC_SECRET'); process.exitCode = 1; }
else if (mode === 'invalid-json') process.stdout.write('SYNTHETIC_SECRET');
else if (mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff]));
else if (mode === 'invalid-schema') process.stdout.write('{}');
else if (mode === 'descendant') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(dir + '/descendant-pid', String(child.pid)); child.unref();
  process.stdout.write(JSON.stringify(${JSON.stringify(payload())}));
}
else { if (mode === 'warning') process.stderr.write('SYNTHETIC_SECRET'); process.stdout.write(JSON.stringify(${JSON.stringify(payload())})); }
`, { mode: 0o700 });
  await chmod(executablePath, 0o700);
  return { directory, executablePath };
}
async function waitForPid(directory: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(join(directory, 'pid'), 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('Synthetic process did not start');
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('verified CodeBurn branch-json projection', () => {
  it('retains source period, cost, tokens, coverage and session identity while dropping unrelated data', () => {
    const input = payload();
    Object.assign(input, { credential: 'SYNTHETIC_SECRET' });
    Object.assign(input.projects[0].branches[0].sessionRows[0], { title: 'SYNTHETIC_PRIVATE_TITLE', accountId: 'SYNTHETIC_ACCOUNT', taskId: 'SYNTHETIC_TASK' });
    const result = success(input);
    expect(result.value).toMatchObject({ source: 'codeburn-cli:spend:branch-json', contract: 'codeburn-0.9.25-branch-json', observedAt: 1000,
      query: 'today', currency: 'USD', approximate: true, coverage: 'unknown', period: { ...period, calendarBasis: 'source-local-timezone-unknown', endInclusive: true },
      projects: [{ codeburnProjectId: '/work/repo', totalCost: 2, branches: [{ branch: 'main', sessionRows: [{ sessionId: 'session-1', provider: 'claude', tokens: split }] }] }] });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_');
  });
  it('keeps no-branch-data projects and explicit coverage without inventing token totals', () => {
    const input = payload();
    input.projects[0].branches = [];
    input.projects[0].coverage = { ...coverage, branchKnownCost: 0, noBranchDataCost: 2, noBranchDataSessions: 1, noBranchDataProviders: ['codex'], distinctSessions: 0 };
    input.totals = { ...input.projects[0].coverage, distinctSessions: 1 };
    const view = projectRepositoryUsage(success(input), context, 'current');
    expect(view.projects[0]).toMatchObject({ totalCost: 2, branchTokens: null, tokens: null, chartCost: 2,
      match: { state: 'matched' }, coverageEvidence: { noBranchDataCost: 2, noBranchDataSessions: 1, noBranchDataProviders: ['codex'] } });
  });
  it('keeps null branch as unknown and counts a session switching branches once per project', () => {
    const input = payload(), project = input.projects[0];
    const second = structuredClone(project.branches[0]); second.branch = null;
    project.branches.push(second); project.totalCost = 4; project.coverage.branchUnknownCost = 2;
    input.totals.branchUnknownCost = 2;
    const result = success(input);
    expect(result.value.projects[0].branches.map(branch => branch.branch)).toEqual(['main', null]);
    expect(result.value.projects[0].coverageEvidence.distinctSessions).toBe(1);
    const view = projectRepositoryUsage(result, context, 'current');
    expect(view.projects[0].tokens?.inputTokens).toBe(200);
    expect(view.projects[0].branches[1].sessionRows[0].taskLinkage.state).toBe('unknown');
  });
  it('accepts missing optional origin, sidechain and historical working-directory fields as unknown', () => {
    const input = payload();
    delete (input.projects[0] as { originKey?: string }).originKey;
    delete (input.projects[0].branches[0].sessionRows[0] as { workingDirectory?: string }).workingDirectory;
    input.projects[0].branches[0].worktrees = [];
    const view = projectRepositoryUsage(success(input), context, 'current');
    expect(view.projects[0].originKey).toBeNull();
    expect(view.projects[0].branches[0].sessionRows[0]).toMatchObject({ workingDirectory: null, isSidechain: null,
      match: { state: 'unknown', repository: null }, accountRef: null, taskLinkage: { state: 'unknown', taskIds: [] } });
  });
  it('accepts source session timestamps with ISO offsets or omitted milliseconds', () => {
    const input = payload();
    const branch = input.projects[0].branches[0];
    Object.assign(branch, { firstActive: '2026-10-07T19:00:00+09:00', lastActive: '2026-10-07T11:00:00Z' });
    Object.assign(branch.sessionRows[0], { firstActive: branch.firstActive, lastActive: branch.lastActive });
    expect(success(input).value.projects[0].branches[0].firstActive).toBe('2026-10-07T19:00:00+09:00');
    Object.assign(branch.sessionRows[0], { firstActive: '2026-10-07T23:00:00+09:00' });
    expect(decodeRepositoryUsage('today', input, 1000).ok).toBe(false);
  });
  it('accepts an empty response as unknown corpus coverage, without creating zero-valued projects', () => {
    const zero = { branchKnownCost: 0, branchUnknownCost: 0, noBranchDataCost: 0, noBranchDataSessions: 0, noBranchDataProviders: [], distinctSessions: 0 };
    const view = projectRepositoryUsage(success({ period, projects: [], totals: zero }), context, 'current');
    expect(view).toMatchObject({ state: 'observed', coverage: 'unknown', projects: [] });
  });
  it.each([
    ['missing period', (v: any) => { delete v.period; }],
    ['backwards period', (v: any) => { v.period.start = '2026-10-08T00:00:00.000Z'; }],
    ['invalid date', (v: any) => { v.period.start = '2026-02-30T00:00:00.000Z'; }],
    ['NaN cost', (v: any) => { v.projects[0].totalCost = NaN; }],
    ['negative tokens', (v: any) => { v.projects[0].branches[0].tokens.inputTokens = -1; }],
    ['fractional tokens', (v: any) => { v.projects[0].branches[0].sessionRows[0].tokens.outputTokens = 0.5; }],
    ['unsafe count', (v: any) => { v.projects[0].branches[0].calls = Number.MAX_SAFE_INTEGER + 1; }],
    ['duplicate project', (v: any) => { v.projects.push(structuredClone(v.projects[0])); }],
    ['duplicate branch', (v: any) => { v.projects[0].branches.push(structuredClone(v.projects[0].branches[0])); }],
    ['duplicate session', (v: any) => { v.projects[0].branches[0].sessionRows.push(structuredClone(v.projects[0].branches[0].sessionRows[0])); }],
    ['mismatched parent', (v: any) => { v.projects[0].branches[0].projectId = '/elsewhere'; }],
    ['mismatched branch total', (v: any) => { v.projects[0].branches[0].cost = 4; }],
    ['mismatched coverage total', (v: any) => { v.totals.branchKnownCost = 4; }],
    ['mismatched worktree', (v: any) => { v.projects[0].branches[0].worktrees[0].path = '/elsewhere'; }],
    ['missing token split', (v: any) => { delete v.projects[0].branches[0].tokens.cacheReadTokens; }],
    ['explicit null cwd', (v: any) => { v.projects[0].branches[0].sessionRows[0].workingDirectory = null; }],
    ['unbounded provider list', (v: any) => { v.totals.noBranchDataProviders = Array(129).fill('provider'); }],
    ['unbounded projects', (v: any) => { v.projects = Array(1001).fill(v.projects[0]); }],
  ])('rejects malformed or inconsistent %s', (_label, mutate) => {
    const input = payload(); mutate(input);
    expect(decodeRepositoryUsage('today', input, 1000)).toMatchObject({ ok: false, error: { kind: 'invalid-schema', query: 'today' } });
  });
  it('rejects invented flow-json and unsupported queries', () => {
    expect(decodeRepositoryUsage('today', { period, models: [], projects: [], links: [] }, 1000).ok).toBe(false);
    expect(decodeRepositoryUsage('lifetime' as RepositoryUsagePeriod, payload(), 1000)).toMatchObject({ ok: false, error: { kind: 'forbidden-query' } });
  });
});

describe('local repository and checkout correspondence', () => {
  it('matches an observed same-host path and keeps task/account identity unknown', () => {
    const view = projectRepositoryUsage(success(), context, 'current');
    expect(view.projects[0]).toMatchObject({ tokens: split, chartCost: 2, match: { state: 'matched', tier: 'registered-project',
      evidence: 'exact-observed-local-checkout-path', repository: { id: 'repo-1', hostId: 'host-local' }, workstreamIds: ['wt-1'] } });
    expect(view.projects[0].branches[0].sessionRows[0]).toMatchObject({ accountRef: null, taskLinkage: { state: 'unknown', taskIds: [] } });
  });
  it('keeps verified unregistered repositories distinct from unknown repositories', () => {
    const unregistered = { ...context, checkouts: [{ ...context.checkouts[0], registeredProjectId: null }] };
    expect(projectRepositoryUsage(success(), unregistered).projects[0].match.tier).toBe('repository-unregistered');
    const nonGit = { ...context, checkouts: [{ ...context.checkouts[0], repositoryId: null }] };
    expect(projectRepositoryUsage(success(), nonGit).projects[0].match.tier).toBe('repository-unknown');
  });
  it('retains separate clone paths with a shared originKey and does not remote-match an unobserved checkout', () => {
    const input = payload(), other = structuredClone(input.projects[0]);
    other.id = '/work/second-clone'; other.branches[0].projectId = other.id;
    other.branches[0].sessionRows[0].workingDirectory = other.id;
    other.branches[0].worktrees[0].path = other.id;
    input.projects.push(other); input.totals.branchKnownCost = 4; input.totals.distinctSessions = 2;
    const view = projectRepositoryUsage(success(input), context, 'current');
    expect(view.projects).toHaveLength(2);
    expect(view.projects.map(project => project.originKey)).toEqual(['github.com/example/repo', 'github.com/example/repo']);
    expect(view.projects[0].match.state).toBe('matched');
    expect(view.projects[1].match).toMatchObject({ state: 'unknown', workstreamIds: [], repository: null });
  });
  it('retains linked-worktree cwd separately from its CodeBurn canonical project path', () => {
    const input = payload();
    input.projects[0].branches[0].sessionRows[0].workingDirectory = '/work/linked';
    input.projects[0].branches[0].worktrees[0].path = '/work/linked';
    const local = { ...context, checkouts: [...context.checkouts, { ...context.checkouts[0], workstreamId: 'wt-2', checkoutPath: '/work/linked', registeredProjectId: null }] };
    const view = projectRepositoryUsage(success(input), local);
    expect(view.projects[0].match.workstreamIds).toEqual(['wt-1']);
    expect(view.projects[0].branches[0].sessionRows[0].match).toMatchObject({ workstreamIds: ['wt-2'], tier: 'repository-unregistered' });
  });
  it('rejects same-path remote host, basename-only, normalized traversal and conflicting identities', () => {
    const remote = { ...context, checkouts: [{ ...context.checkouts[0], hostId: 'host-remote' }] };
    expect(projectRepositoryUsage(success(), remote).projects[0].match.state).toBe('unknown');
    const input = payload(); input.projects[0].id = 'repo'; input.projects[0].branches[0].projectId = 'repo';
    expect(projectRepositoryUsage(success(input), context).projects[0].match.state).toBe('unknown');
    input.projects[0].id = '/work/else/../repo'; input.projects[0].branches[0].projectId = input.projects[0].id;
    expect(projectRepositoryUsage(success(input), context).projects[0].match.state).toBe('unknown');
    const conflicting = { ...context, checkouts: [...context.checkouts, { ...context.checkouts[0], repositoryId: 'other', workstreamId: 'wt-other' }] };
    expect(projectRepositoryUsage(success(), conflicting).projects[0].match.state).toBe('conflict');
  });
  it('keeps stale graph gaps, failure provenance and same-query last success without replaying a different period', () => {
    const previous = success().value;
    const failure = { ok: false as const, observedAt: 2000, error: { kind: 'timeout' as const, query: 'today' as const } };
    expect(projectRepositoryUsage(failure, context, 'current', previous)).toMatchObject({ state: 'failed', freshness: 'stale', lastSuccess: 1000,
      observedAt: 1000, lastAttemptAt: 2000, error: 'timeout', projects: [{ chartCost: null }] });
    expect(projectRepositoryUsage(failure, context, 'current', { ...previous, query: 'month' })).toMatchObject({ projects: [], freshness: 'unknown', lastSuccess: null });
    expect(projectRepositoryUsage(null, context)).toMatchObject({ state: 'unknown', projects: [], totals: null, lastSuccess: null });
    expect(projectRepositoryUsage(success(), context, 'stale').projects[0].chartCost).toBeNull();
  });
  it('returns detached display objects', () => {
    const observation = success();
    const local = structuredClone(context);
    const view = projectRepositoryUsage(observation, local, 'current');
    view.projects[0].branches[0].tokens.inputTokens = 999;
    view.projects[0].match.checkouts[0].checkoutPath = '/changed';
    expect(observation.value.projects[0].branches[0].tokens.inputTokens).toBe(100);
    expect(local.checkouts[0].checkoutPath).toBe('/work/repo');
  });
});

describe('bounded synthetic repository usage CLI', () => {
  it('runs only the two fixed reviewed argv sequences, projects fixture integration, and timestamps completion', async () => {
    const mock = await fixture(), reader = createRepositoryUsageReader(mock), before = Date.now();
    for (const query of ['today', 'month'] as const) {
      const result = await reader.read(query);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.observedAt).toBeGreaterThanOrEqual(before);
      expect(projectRepositoryUsage(result, context, 'current').projects[0].match.workstreamIds).toEqual(['wt-1']);
    }
    expect((await readFile(join(mock.directory, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([
      ['spend', '--format', 'branch-json', '--period', 'today', '--provider', 'all'],
      ['spend', '--format', 'branch-json', '--period', 'month', '--provider', 'all'],
    ]);
  });
  it.each(['lifetime', '__proto__', 'today; evil', '/tmp/arbitrary', null])('rejects arbitrary query %j without spawning', async query => {
    const mock = await fixture();
    expect(await createRepositoryUsageReader(mock).read(query as RepositoryUsagePeriod)).toMatchObject({ ok: false, error: { kind: 'forbidden-query' } });
    await expect(access(join(mock.directory, 'calls'))).rejects.toThrow();
  });
  it('rejects relative executable paths and out-of-bound limits', () => {
    expect(() => createRepositoryUsageReader({ executablePath: 'codeburn' })).toThrow();
    expect(() => createRepositoryUsageReader({ executablePath: '/tmp/mock', timeoutMs: 60_001 })).toThrow();
    expect(() => createRepositoryUsageReader({ executablePath: '/tmp/mock', maxOutputBytes: 0 })).toThrow();
  });
  it('reports stderr presence without retaining diagnostics', async () => {
    const result = await createRepositoryUsageReader(await fixture('warning')).read('today');
    expect(result).toMatchObject({ ok: true, diagnostics: { stderrReported: true } });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });
  it.each([['stdout-overflow', 'output-limit'], ['stderr-overflow', 'output-limit'], ['nonzero', 'command-failed'],
    ['invalid-json', 'invalid-json'], ['invalid-utf8', 'invalid-json'], ['invalid-schema', 'invalid-schema']])('sanitizes %s failures', async (mode, kind) => {
    const result = await createRepositoryUsageReader({ ...await fixture(mode), maxOutputBytes: 2048 }).read('today');
    expect(result).toMatchObject({ ok: false, error: { kind } });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });
  it('cancels its owned process, rejects concurrent requests and safely reuses after cleanup', async () => {
    const mock = await fixture('hang'), reader = createRepositoryUsageReader(mock), controller = new AbortController();
    const pending = reader.read('today', { signal: controller.signal });
    try {
      const pid = await waitForPid(mock.directory);
      expect(await reader.read('month')).toMatchObject({ ok: false, error: { kind: 'busy' } });
      controller.abort();
      expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
      expect(() => process.kill(pid, 0)).toThrow();
      await writeFile(join(mock.directory, 'mode'), 'normal');
      expect((await reader.read('month')).ok).toBe(true);
    } finally { controller.abort(); await pending; }
  });
  it('bounds startup time and never spawns for an already cancelled request', async () => {
    const mock = await fixture('hang'), controller = new AbortController(); controller.abort();
    expect(await createRepositoryUsageReader(mock).read('today', { signal: controller.signal })).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    await expect(access(join(mock.directory, 'calls'))).rejects.toThrow();
    expect(await createRepositoryUsageReader({ ...mock, timeoutMs: 30 }).read('today')).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });
  it('fails closed after unverifiable cleanup and does not launch another request', async () => {
    const actual = processGroup.finalizeQueryGroup;
    vi.spyOn(processGroup, 'finalizeQueryGroup').mockImplementation(async child => { await actual(child); return false; });
    const mock = await fixture(), reader = createRepositoryUsageReader(mock);
    expect(await reader.read('today')).toMatchObject({ ok: false, error: { kind: 'cleanup-unverified' } });
    expect(await reader.read('month')).toMatchObject({ ok: false, error: { kind: 'cleanup-unverified' } });
    expect((await readFile(join(mock.directory, 'calls'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it.skipIf(process.platform === 'win32')('cleans an owned descendant even after the reporting process exits successfully', async () => {
    const mock = await fixture('descendant');
    const result = await createRepositoryUsageReader(mock).read('today');
    expect(result.ok).toBe(true);
    const pid = Number(await readFile(join(mock.directory, 'descendant-pid'), 'utf8'));
    if (process.platform === 'linux') {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        expect(['Z', 'X']).toContain(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
      } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ENOENT'); }
    } else expect(() => process.kill(pid, 0)).toThrow();
  });
  it('does not disclose the missing executable path', async () => {
    const mock = await fixture(); await rm(mock.executablePath);
    const result = await createRepositoryUsageReader(mock).read('today');
    expect(result).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(JSON.stringify(result)).not.toContain(mock.directory);
  });
});
