import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createProcessMemoryAdapter, processMemoryPsCommand,
  type ProcessMemoryAdapterOptions, type ProcessMemoryIO, type TrustedProcessMemoryTarget,
} from '../../src/phase2/process-memory';
import { currentResourceCapabilities, projectMemoryObservations } from '../../src/phase2/resources';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const startTime = Date.UTC(2026, 9, 7);
const now = startTime + 10_000;
const target = (patch: Partial<TrustedProcessMemoryTarget> = {}): TrustedProcessMemoryTarget => ({
  hostId: 'local-host', pid: 100, expectedUid: 501, startTime, source: 'trusted-source:fixture',
  lifetime: { kind: 'linux-start-ticks', value: '123456' },
  linkage: { source: 'worktree-source:fixture', evidence: 'Exact host/PID/lifetime binding', workstreamIds: ['work-a'] }, ...patch,
});
const stat = (pid = 100, ticks = '123456', state = 'S', comm = 'worker') =>
  `${pid} (${comm}) ${[state, ...Array<string>(18).fill('0'), ticks, '1234', '123'].join(' ')}\n`;
const status = (pid = 100, uid = 501, rss: string | null = '2048 kB') =>
  `Name:\tworker\nTgid:\t${pid}\nPid:\t${pid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n${rss === null ? '' : `VmRSS:\t${rss}\n`}`;
const ps = (patch: { pid?: number; uid?: number; date?: string; rss?: string; state?: string } = {}) =>
  ` ${patch.pid ?? 100} ${patch.uid ?? 501} ${patch.date ?? 'Wed Oct  7 00:00:00 2026'} ${patch.rss ?? '2048'} ${patch.state ?? 'S+'}\n`;
const darwinTarget = (patch: Partial<TrustedProcessMemoryTarget> = {}) => target({ lifetime: { kind: 'darwin-lstart' }, ...patch });
function fixture(patch: Partial<ProcessMemoryIO> = {}, options: Partial<ProcessMemoryAdapterOptions> = {}) {
  const readProcFile = vi.fn(async (path: string) => path.endsWith('/stat') ? stat(Number(path.split('/')[2])) : status(Number(path.split('/')[2])));
  const runPs = vi.fn(async () => ({ stdout: ps(), stderrBytes: 0, exitCode: 0 }));
  const io: ProcessMemoryIO = { readProcFile, runPs, ...patch };
  return { adapter: createProcessMemoryAdapter({ hostId: 'local-host', platform: 'linux', now: () => now, io, ...options }), io, readProcFile, runPs };
}
function errno(code: string) { return Object.assign(new Error('private error text must not escape'), { code }); }
afterEach(() => { vi.useRealTimers(); vi.mocked(spawn).mockReset(); });

describe('명시 PID Linux 메모리 관측', () => {
  it('한 PID의 stat/status/stat만 읽고 RSS를 바이트로 변환한다', async () => {
    const f = fixture();
    const result = await f.adapter.read({ targets: [target()] });
    expect(result).toMatchObject({ state: 'complete', coverage: 'partial', scope: 'explicit-pids', error: null });
    expect(result.samples[0]).toMatchObject({ state: 'observed', identityPrecision: 'kernel-ticks', observation: {
      hostId: 'local-host', pid: 100, startTime, rssBytes: 2_097_152, state: 'running', linkage: 'verified', workstreamIds: ['work-a'],
    } });
    expect(f.readProcFile.mock.calls.map(call => call[0])).toEqual(['/proc/100/stat', '/proc/100/status', '/proc/100/stat']);
    expect(f.runPs).not.toHaveBeenCalled();
  });

  it('공백·괄호·개행이 포함된 comm을 버리고 정확한 start ticks를 읽는다', async () => {
    const f = fixture({ readProcFile: async path => path.endsWith('/stat') ? stat(100, '123456', 'S', 'private ) ( name\nworker') : status() });
    const result = await f.adapter.read({ targets: [target()] });
    expect(result.samples[0].state).toBe('observed');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('epoch 시작 시각을 uptime/부팅시각으로 추정하지 않는다', async () => {
    const f = fixture();
    const result = await f.adapter.read({ targets: [target({ startTime: startTime + 123 })] });
    expect(result.observations[0].startTime).toBe(startTime + 123);
    expect(f.readProcFile.mock.calls.every(call => /^\/proc\/100\/(stat|status)$/u.test(call[0]))).toBe(true);
  });

  it('제공된 두 worktree 연결을 shared 한 번으로 투영한다', async () => {
    const result = await fixture().adapter.read({ targets: [target({ linkage: {
      source: 'source', evidence: 'source-owned relationships', workstreamIds: ['work-a', 'work-b', 'work-a'],
    } })] });
    const projection = projectMemoryObservations(result.observations, { capability: { state: 'supported', reason: 'fixture' },
      source: 'fixture', observedAt: now, lastSuccess: now, coverage: result.coverage, freshness: 'current' });
    expect(projection.shared).toMatchObject({ observedBytes: 2_097_152, processCount: 1 });
    expect(projection.exclusive).toEqual([]);
    expect(projection.observedBytes).toBe(2_097_152);
  });

  it('worktree 연결 근거가 없으면 RSS는 unattributed로 남긴다', async () => {
    const result = await fixture().adapter.read({ targets: [target({ linkage: null })] });
    expect(result.observations[0]).toMatchObject({ rssBytes: 2_097_152, linkage: 'unknown', workstreamIds: [] });
  });

  it.each(['ENOENT', 'ESRCH'])('%s는 종료로 보존하고 사용량 0으로 만들지 않는다', async code => {
    const result = await fixture({ readProcFile: async () => { throw errno(code); } }).adapter.read({ targets: [target()] });
    expect(result.samples[0]).toMatchObject({ state: 'exited', observation: { state: 'exited', rssBytes: null, linkage: 'unknown' } });
    const projection = projectMemoryObservations(result.observations, { capability: { state: 'supported', reason: 'fixture' },
      source: 'fixture', observedAt: now, lastSuccess: null, coverage: result.coverage, freshness: 'unknown' });
    expect(projection.processes[0].state).toBe('exited');
    expect(projection.observedBytes).toBeNull();
  });

  it.each(['EACCES', 'EPERM'])('%s 접근 거절 후 다른 경로를 시도하지 않는다', async code => {
    const read = vi.fn(async () => { throw errno(code); });
    const f = fixture({ readProcFile: read });
    const result = await f.adapter.read({ targets: [target()] });
    expect(result.samples[0].state).toBe('denied');
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.runPs).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private error');
  });

  it('잘못된 UID는 RSS와 worktree 연결을 버린다', async () => {
    const result = await fixture({ readProcFile: async path => path.endsWith('/stat') ? stat() : status(100, 502) }).adapter.read({ targets: [target()] });
    expect(result.samples[0]).toMatchObject({ state: 'owner-mismatch', observation: { rssBytes: null, linkage: 'unknown', workstreamIds: [] } });
  });

  it('기존 target와 다른 lifetime이면 status도 읽지 않는다', async () => {
    const read = vi.fn(async () => stat(100, '123457'));
    const result = await fixture({ readProcFile: read }).adapter.read({ targets: [target()] });
    expect(result.samples[0].state).toBe('pid-reused');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stat/status 사이 PID 재사용과 종료를 재검증한다', async () => {
    for (const [last, expected] of [[stat(100, '999'), 'pid-reused'], [stat(100, '123456', 'Z'), 'exited']] as const) {
      const read = vi.fn().mockResolvedValueOnce(stat()).mockResolvedValueOnce(status()).mockResolvedValueOnce(last);
      const result = await fixture({ readProcFile: read }).adapter.read({ targets: [target()] });
      expect(result.samples[0]).toMatchObject({ state: expected, observation: { rssBytes: null, workstreamIds: [] } });
    }
  });

  it('zombie는 첫 stat에서 종료로 표시한다', async () => {
    const read = vi.fn(async () => stat(100, '123456', 'Z'));
    const result = await fixture({ readProcFile: read }).adapter.read({ targets: [target()] });
    expect(result.samples[0].state).toBe('exited');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([null, '-1 kB', 'NaN kB', '9007199254740991 kB', '2 MB'])('RSS %s는 미확인이고 0이 아니다', async rss => {
    const result = await fixture({ readProcFile: async path => path.endsWith('/stat') ? stat() : status(100, 501, rss) }).adapter.read({ targets: [target()] });
    expect(result.samples[0]).toMatchObject({ state: 'unknown', observation: { rssBytes: null } });
  });

  it('명시적으로 관측한 RSS 0만 0으로 보존한다', async () => {
    const result = await fixture({ readProcFile: async path => path.endsWith('/stat') ? stat() : status(100, 501, '0 kB') }).adapter.read({ targets: [target()] });
    expect(result.samples[0]).toMatchObject({ state: 'observed', observation: { rssBytes: 0 } });
  });

  it.each([status(101), status() + 'VmRSS:\t42 kB\n', status().replace('Tgid:\t100', 'Tgid:\t50')])('중복/불일치 status를 거절한다', async value => {
    const result = await fixture({ readProcFile: async path => path.endsWith('/stat') ? stat() : value }).adapter.read({ targets: [target()] });
    expect(result.samples[0].state).toBe('unknown');
  });
});

describe('native ps runner의 synthetic helper 경계', () => {
  function nativeFixture() {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; }) });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
    return { child, adapter: createProcessMemoryAdapter({ hostId: 'local-host', platform: 'darwin', now: () => now, timeoutMs: 20, maxOutputBytes: 128 }) };
  }

  it('고정 단일 PID argv로 성공하고 helper나 대상에 signal을 보내지 않는다', async () => {
    const f = nativeFixture();
    const pending = f.adapter.read({ targets: [darwinTarget()] });
    f.child.stdout.write(ps()); f.child.emit('close', 0);
    const result = await pending;
    expect(result.samples[0].state).toBe('observed');
    expect(spawn).toHaveBeenCalledWith('/bin/ps', ['-p', '100', '-o', 'pid=,uid=,lstart=,rss=,state='], {
      shell: false, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC', COLUMNS: '256' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it('stdout/stderr 합산 상한을 넘으면 생성한 조회 helper만 정리한다', async () => {
    const f = nativeFixture();
    const pending = f.adapter.read({ targets: [darwinTarget()] });
    f.child.stdout.write(ps()); f.child.stderr.write('private'.repeat(20));
    const result = await pending;
    expect(result.error).toBe('output-limit');
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('전체 timeout과 취소는 own helper 정리를 요청하고 late 성공을 버린다', async () => {
    vi.useFakeTimers();
    const f = nativeFixture();
    const pending = f.adapter.read({ targets: [darwinTarget()] });
    await vi.advanceTimersByTimeAsync(20);
    expect((await pending).error).toBe('timeout');
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    f.child.emit('close', 0);

    const cancelled = nativeFixture(), controller = new AbortController();
    const request = cancelled.adapter.read({ targets: [darwinTarget()], signal: controller.signal });
    controller.abort();
    expect((await request).error).toBe('cancelled');
    expect(cancelled.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('실행 권한 오류를 노출 가능한 stderr/원문 없이 보존한다', async () => {
    const f = nativeFixture();
    const pending = f.adapter.read({ targets: [darwinTarget()] });
    f.child.emit('error', errno('EACCES')); f.child.emit('close', -1);
    const result = await pending;
    expect(result.samples[0].state).toBe('denied');
    expect(JSON.stringify(result)).not.toContain('private');
  });
});

describe('명시 PID macOS 메모리 관측', () => {
  it('절대 ps 경로·단일 PID·고정 metadata 열·격리 locale/environment만 쓴다', async () => {
    const f = fixture({}, { platform: 'darwin' });
    const result = await f.adapter.read({ targets: [darwinTarget()] });
    expect(f.runPs).toHaveBeenCalledWith({ executable: '/bin/ps', args: ['-p', '100', '-o', 'pid=,uid=,lstart=,rss=,state='],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC', COLUMNS: '256' } }, expect.objectContaining({ maxBytes: 16 * 1024 }));
    expect(f.readProcFile).not.toHaveBeenCalled();
    expect(result.samples[0]).toMatchObject({ state: 'observed', identityPrecision: 'seconds', observation: {
      rssBytes: 2_097_152, startTime, linkage: 'unknown', workstreamIds: [],
    } });
    expect(result.samples[0].reason).toContain('같은 초');
  });

  it('여러 PID도 각각 단일 selector로 조회하며 kernel-wide 열거를 피한다', async () => {
    const run = vi.fn<ProcessMemoryIO['runPs']>(async command => ({ stdout: ps({ pid: Number(command.args[1]) }), stderrBytes: 0, exitCode: 0 }));
    const result = await fixture({ runPs: run }, { platform: 'darwin' }).adapter.read({ targets: [darwinTarget(), darwinTarget({ pid: 200 })] });
    expect(result.samples).toHaveLength(2);
    expect(run.mock.calls.map(call => call[0].args)).toEqual([
      ['-p', '100', '-o', 'pid=,uid=,lstart=,rss=,state='], ['-p', '200', '-o', 'pid=,uid=,lstart=,rss=,state='],
    ]);
  });

  it.each([
    [ps({ date: 'Wed Oct  7 00:00:01 2026' }), 'pid-reused'], [ps({ uid: 502 }), 'owner-mismatch'],
    [ps({ state: 'Z' }), 'exited'], [ps({ state: 'SE' }), 'exited'], [ps({ state: '?' }), 'unknown'],
    [ps({ date: 'Wed Feb 31 00:00:00 2026' }), 'unknown'], [ps({ pid: 999 }), 'unknown'],
    ['', 'unknown'], [ps() + ps(), 'unknown'], [ps({ rss: '999999999999999999' }), 'unknown'],
  ])('메타데이터 불일치나 누락을 %s에서 %s로 보존한다', async (stdout, state) => {
    const result = await fixture({ runPs: async () => ({ stdout, stderrBytes: 0, exitCode: 0 }) }, { platform: 'darwin' }).adapter.read({ targets: [darwinTarget()] });
    expect(result.samples[0]).toMatchObject({ state, observation: { rssBytes: null, linkage: 'unknown' } });
  });

  it('실패/숨김 표본과 stderr가 있는 응답을 종료로 추정하지 않는다', async () => {
    for (const response of [{ stdout: '', stderrBytes: 0, exitCode: 1 }, { stdout: ps(), stderrBytes: 8, exitCode: 0 }]) {
      const result = await fixture({ runPs: async () => response }, { platform: 'darwin' }).adapter.read({ targets: [darwinTarget()] });
      expect(result.samples[0].state).toBe('unknown');
    }
  });

  it('ps 실행 권한 거절은 denied이며 Linux fallback은 없다', async () => {
    const f = fixture({ runPs: async () => { throw errno('EACCES'); } }, { platform: 'darwin' });
    const result = await f.adapter.read({ targets: [darwinTarget()] });
    expect(result.samples[0].state).toBe('denied');
    expect(f.readProcFile).not.toHaveBeenCalled();
  });
});

describe('시간·입력·출력·동시 조회 경계', () => {
  it.each([0, -1, 1.5, Infinity, 2_147_483_648, '100,200', '1; env'])('PID %s는 I/O 전에 거절한다', async pid => {
    const f = fixture();
    const result = await f.adapter.read({ targets: [target({ pid: pid as number })] });
    expect(result.error).toBe('invalid-target');
    expect(f.readProcFile).not.toHaveBeenCalled();
    expect(() => processMemoryPsCommand(pid as number)).toThrow();
  });

  it.each([
    { hostId: 'remote-host' }, { startTime: now + 1 }, { expectedUid: -1 }, { source: '' },
    { lifetime: { kind: 'linux-start-ticks', value: '' } }, { linkage: { source: 's', evidence: '', workstreamIds: ['w'] } },
  ])('불충분한 source target은 전체 batch I/O 전에 거절한다', async patch => {
    const f = fixture();
    const result = await f.adapter.read({ targets: [target({ pid: 200 }), target(patch as Partial<TrustedProcessMemoryTarget>)] });
    expect(result.error).toBe('invalid-target');
    expect(f.readProcFile).not.toHaveBeenCalled();
  });

  it('중복 PID와 대상 수 상한 초과를 읽기 전에 거절한다', async () => {
    const f = fixture({}, { maxProcesses: 1 });
    expect((await f.adapter.read({ targets: [target(), target({ pid: 200 })] })).error).toBe('output-limit');
    const duplicate = fixture();
    expect((await duplicate.adapter.read({ targets: [target(), target()] })).error).toBe('invalid-target');
    expect(f.readProcFile).not.toHaveBeenCalled();
    expect(duplicate.readProcFile).not.toHaveBeenCalled();
  });

  it('빈 목록/미지원 OS는 관측 0 또는 project coverage complete가 아니다', async () => {
    const f = fixture();
    expect(await f.adapter.read({ targets: [] })).toMatchObject({ state: 'unknown', coverage: 'unknown', observations: [] });
    const unsupported = fixture({}, { platform: 'win32' });
    expect((await unsupported.adapter.read({ targets: [target()] })).error).toBe('unsupported');
    expect(unsupported.readProcFile).not.toHaveBeenCalled();
  });

  it('개별 파일과 전체 출력 상한 초과 뒤 새 PID를 읽지 않는다', async () => {
    const read = vi.fn(async () => 'x'.repeat(21));
    const f = fixture({ readProcFile: read }, { maxFileBytes: 20 });
    const result = await f.adapter.read({ targets: [target(), target({ pid: 200 })] });
    expect(result.error).toBe('output-limit');
    expect(result.samples.map(row => row.state)).toEqual(['output-limit', 'output-limit']);
    expect(read).toHaveBeenCalledTimes(1);
    const total = fixture({}, { maxOutputBytes: Buffer.byteLength(stat()) + Buffer.byteLength(status()) });
    expect((await total.adapter.read({ targets: [target()] })).error).toBe('output-limit');
  });

  it('ps stdout와 stderr를 합친 출력 상한을 적용한다', async () => {
    const result = await fixture({ runPs: async () => ({ stdout: ps(), stderrBytes: 50, exitCode: 0 }) }, { platform: 'darwin', maxFileBytes: 80 }).adapter.read({ targets: [darwinTarget()] });
    expect(result.error).toBe('output-limit');
  });

  it('취소된 요청은 파일/프로세스에 접근하지 않는다', async () => {
    const f = fixture();
    const signal = AbortSignal.abort();
    expect((await f.adapter.read({ targets: [target()], signal })).error).toBe('cancelled');
    expect(f.readProcFile).not.toHaveBeenCalled();
  });

  it('비협조적 읽기도 시간 내 반환하며 정리 전 재조회와 late 결과를 차단한다', async () => {
    vi.useFakeTimers();
    let release!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const f = fixture({ readProcFile: read }, { timeoutMs: 20 });
    const pending = f.adapter.read({ targets: [target(), target({ pid: 200 })] });
    expect((await f.adapter.read({ targets: [target()] })).error).toBe('busy');
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result.error).toBe('timeout');
    expect(result.samples.map(row => row.state)).toEqual(['timeout', 'timeout']);
    expect((await f.adapter.read({ targets: [target()] })).error).toBe('busy');
    release(stat());
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.samples[0].state).toBe('timeout');
    expect((await f.adapter.read({ targets: [] })).error).toBeNull();
  });

  it('한 PID 성공 후 취소되면 성공 표본과 미완료 unknown을 구분한다', async () => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    let release!: (value: string) => void;
    const f = fixture({ readProcFile: async path => {
      if (path.includes('/200/')) { started(); return new Promise(resolve => { release = resolve; }); }
      return path.endsWith('/stat') ? stat() : status();
    } });
    const controller = new AbortController();
    const pending = f.adapter.read({ targets: [target(), target({ pid: 200 })], signal: controller.signal });
    await waiting;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ state: 'partial', error: 'cancelled', coverage: 'partial' });
    expect(result.samples.map(row => row.state)).toEqual(['observed', 'cancelled']);
    release(stat(200));
  });

  it('진행 중 호출자가 target을 바꿔도 최초 PID/연결만 사용한다', async () => {
    let release!: (value: string) => void;
    const read = vi.fn<ProcessMemoryIO['readProcFile']>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(status()).mockResolvedValueOnce(stat());
    const source = target();
    const pending = fixture({ readProcFile: read }).adapter.read({ targets: [source] });
    source.pid = 999;
    (source.linkage!.workstreamIds as string[]).push('wrong-worktree');
    release(stat());
    const result = await pending;
    expect(result.observations[0]).toMatchObject({ pid: 100, workstreamIds: ['work-a'] });
    expect(read.mock.calls.map(call => call[0])).toEqual(['/proc/100/stat', '/proc/100/status', '/proc/100/stat']);
  });

  it('한 번의 성공을 다음 실패의 RSS로 재사용하지 않는다', async () => {
    const f = fixture();
    expect((await f.adapter.read({ targets: [target()] })).samples[0].state).toBe('observed');
    f.io.readProcFile = async () => { throw errno('EACCES'); };
    expect((await f.adapter.read({ targets: [target()] })).observations[0].rssBytes).toBeNull();
  });

  it('잘못된 config와 무한/과대한 상한을 허용하지 않는다', () => {
    for (const options of [{ timeoutMs: 5001 }, { maxProcesses: 129 }, { maxOutputBytes: Infinity }, { maxFileBytes: 0 }, { hostId: '' }]) {
      expect(() => fixture({}, options)).toThrow();
    }
  });

  it('관측 어댑터 구현이 Orca/project memory capability를 승격하지 않는다', () => {
    expect(currentResourceCapabilities().processMemory.state).toBe('unsupported');
    expect(currentResourceCapabilities().systemMemory.state).toBe('unsupported');
  });
});
