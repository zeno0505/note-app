import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ProcessMemoryObservation, ResourceCoverage } from './resources';

/** Main-process only. This is an explicit target reader, never a process discovery API. */
export interface TrustedProcessMemoryTarget {
  hostId: string;
  pid: number;
  expectedUid: number;
  /** Epoch milliseconds supplied by the trusted source, never inferred from process uptime. */
  startTime: number;
  source: string;
  lifetime: { kind: 'linux-start-ticks'; value: string } | { kind: 'darwin-lstart' };
  /** A trusted source must bind these worktrees to this exact host/PID/lifetime. */
  linkage: { source: string; evidence: string; workstreamIds: readonly string[] } | null;
}

export type ProcessMemoryReadState = 'observed' | 'denied' | 'exited' | 'pid-reused' | 'owner-mismatch'
  | 'unknown' | 'invalid-target' | 'unsupported' | 'timeout' | 'cancelled' | 'output-limit' | 'busy';
export interface ProcessMemorySample {
  pid: number;
  state: ProcessMemoryReadState;
  targetSource: string;
  linkageEvidence: { source: string; evidence: string } | null;
  /** Diagnostic metadata only; no command names, arguments, environment, or error text. */
  reason: string;
  identityPrecision: 'kernel-ticks' | 'seconds' | 'unknown';
  observation: ProcessMemoryObservation;
}
export interface ProcessMemoryReadResult {
  state: 'complete' | 'partial' | 'unknown';
  /** Always partial/unknown: a supplied PID list cannot establish all project processes. */
  coverage: ResourceCoverage;
  scope: 'explicit-pids';
  observedAt: number;
  samples: ProcessMemorySample[];
  observations: ProcessMemoryObservation[];
  error: ProcessMemoryReadState | null;
}

interface ReadBudget { signal: AbortSignal; maxBytes: number }
export interface ProcessMemoryPsCommand {
  executable: '/bin/ps';
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}
/** Injection is for trusted host adapters/tests, never renderer-controlled configuration. */
export interface ProcessMemoryIO {
  readProcFile(path: string, budget: ReadBudget): Promise<string>;
  runPs(command: ProcessMemoryPsCommand, budget: ReadBudget): Promise<{ stdout: string; stderrBytes: number; exitCode: number }>;
}
export interface ProcessMemoryAdapterOptions {
  hostId: string;
  platform?: NodeJS.Platform;
  maxProcesses?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxFileBytes?: number;
  now?: () => number;
  io?: ProcessMemoryIO;
}

const MAX_PID = 2_147_483_647;
const textReference = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const pidValue = (value: unknown): value is number => natural(value) && value > 0 && value <= MAX_PID;
const timestamp = (value: unknown): value is number => natural(value) && value <= 8_640_000_000_000_000;
const reasons: Record<ProcessMemoryReadState, string> = {
  observed: '명시 PID의 메타데이터를 관측했습니다. RSS는 물리 메모리나 시스템 압력이 아닙니다.',
  denied: '운영체제가 읽기 접근을 거절했습니다. 권한 확대나 다른 경로 재시도는 하지 않습니다.',
  exited: '해당 PID가 사라졌거나 종료 상태입니다. 사용량 0으로 대체하지 않습니다.',
  'pid-reused': '신뢰한 시작 식별자와 달라졌습니다. 다른 lifetime의 RSS를 귀속하지 않습니다.',
  'owner-mismatch': '신뢰한 소유 UID와 다릅니다. RSS와 프로젝트 귀속을 폐기했습니다.',
  unknown: '표본이 없거나 불완전합니다. 숨겨진 프로세스와 종료를 추정으로 구분하지 않습니다.',
  'invalid-target': '명시 host/PID/소유자/시작 식별자 또는 연결 근거가 유효하지 않습니다.',
  unsupported: '이 운영체제의 명시 PID 메타데이터 어댑터는 지원하지 않습니다.',
  timeout: '전체 관측 시간 상한을 초과했습니다.',
  cancelled: '관측이 취소됐습니다.',
  'output-limit': '입력 대상 수 또는 읽기 출력 상한을 초과했습니다.',
  busy: '이전 읽기 또는 조회 helper 정리가 진행 중입니다. 중복 조회하지 않습니다.',
};
class MemoryReadError extends Error {
  constructor(readonly state: ProcessMemoryReadState) { super(state); }
}
function fail(state: ProcessMemoryReadState): never { throw new MemoryReadError(state); }
function errorState(error: unknown, proc: boolean): ProcessMemoryReadState {
  if (error instanceof MemoryReadError) return error.state;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'denied';
  if (proc && (code === 'ENOENT' || code === 'ESRCH')) return 'exited';
  return 'unknown';
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!natural(result) || result < 1 || result > maximum) throw new Error('Invalid process memory limit.');
  return result;
}

/** Single PID is intentional: Apple's ps expands a multi-PID selector to KERN_PROC_ALL. */
export function processMemoryPsCommand(pid: number): ProcessMemoryPsCommand {
  if (!pidValue(pid)) throw new Error('Invalid process memory PID.');
  return { executable: '/bin/ps', args: ['-p', String(pid), '-o', 'pid=,uid=,lstart=,rss=,state='],
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC', COLUMNS: '256' } };
}

const nativeIO: ProcessMemoryIO = {
  async readProcFile(path, { signal, maxBytes }) {
    if (!/^\/proc\/[1-9]\d*\/(stat|status)$/u.test(path)) fail('invalid-target');
    signal.throwIfAborted();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(maxBytes + 1);
    try {
      let length = 0;
      while (length <= maxBytes) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        signal.throwIfAborted();
        if (bytesRead === 0) return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
        length += bytesRead;
        if (length > maxBytes) fail('output-limit');
      }
      return fail('output-limit');
    } finally { buffer.fill(0); await file.close(); }
  },
  runPs(command, { signal, maxBytes }) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(command.executable, [...command.args], {
        shell: false, env: { ...command.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let bytes = 0, stderrBytes = 0;
      let chunks: Buffer[] = [];
      let stopped: unknown = null;
      const wipe = () => { for (const chunk of chunks) chunk.fill(0); chunks = []; };
      const stop = (reason: unknown) => {
        if (stopped) return;
        stopped = reason; wipe();
        // Only the helper created above is signalled. Never signal an observed/user PID.
        child.kill('SIGKILL');
        child.stdout.destroy(); child.stderr.destroy();
      };
      const abort = () => stop(new MemoryReadError('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        if (stopped) return;
        bytes += chunk.length;
        if (bytes > maxBytes) stop(new MemoryReadError('output-limit'));
        else chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stopped) return;
        bytes += chunk.length; stderrBytes += chunk.length;
        if (bytes > maxBytes) stop(new MemoryReadError('output-limit'));
      });
      child.stdout.on('error', () => stop(new MemoryReadError('unknown')));
      child.stderr.on('error', () => stop(new MemoryReadError('unknown')));
      child.once('error', error => { stopped ??= error; });
      child.once('close', code => {
        signal.removeEventListener('abort', abort);
        try {
          if (stopped) reject(stopped);
          else resolve({ stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), stderrBytes, exitCode: code ?? -1 });
        } catch { reject(new MemoryReadError('unknown')); }
        finally { wipe(); }
      });
      if (signal.aborted) abort();
    });
  },
};

function validTarget(value: TrustedProcessMemoryTarget, hostId: string, platform: NodeJS.Platform, now: number): boolean {
  if (!value || value.hostId !== hostId || !pidValue(value.pid) || !natural(value.expectedUid) || value.expectedUid > 0xffff_ffff
    || !timestamp(value.startTime) || value.startTime > now || !textReference(value.source)) return false;
  if (platform === 'linux' && (value.lifetime?.kind !== 'linux-start-ticks'
    || typeof value.lifetime.value !== 'string' || !/^(0|[1-9]\d{0,19})$/u.test(value.lifetime.value))) return false;
  if (platform === 'darwin' && value.lifetime?.kind !== 'darwin-lstart') return false;
  const link = value.linkage;
  return link === null || !!link && textReference(link.source) && textReference(link.evidence)
    && Array.isArray(link.workstreamIds) && link.workstreamIds.length > 0 && link.workstreamIds.length <= 32
    && link.workstreamIds.every(textReference);
}
function safeTarget(value: TrustedProcessMemoryTarget): TrustedProcessMemoryTarget {
  return { ...value, lifetime: { ...value.lifetime }, linkage: value.linkage
    ? { ...value.linkage, workstreamIds: [...new Set(value.linkage.workstreamIds)] } : null };
}
function unknownSample(target: TrustedProcessMemoryTarget, state: ProcessMemoryReadState, now: number): ProcessMemorySample {
  return { pid: target.pid, state, targetSource: target.source, linkageEvidence: null,
    reason: reasons[state], identityPrecision: 'unknown', observation: {
    hostId: textReference(target.hostId) ? target.hostId : null, pid: pidValue(target.pid) ? target.pid : null,
    // This is the caller's previously proven lifetime, not an identity for a replacement PID.
    startTime: target.startTime, observedAt: now, rssBytes: null, state: state === 'exited' ? 'exited' : 'unknown',
    workstreamIds: [], linkage: 'unknown', source: 'os-explicit-process-metadata',
  } };
}
function sample(target: TrustedProcessMemoryTarget, now: number, rssBytes: number | null, coarse: boolean): ProcessMemorySample {
  return { pid: target.pid, state: rssBytes === null ? 'unknown' : 'observed', targetSource: target.source,
    linkageEvidence: !coarse && target.linkage ? { source: target.linkage.source, evidence: target.linkage.evidence } : null,
    reason: coarse ? 'macOS lstart는 초 해상도입니다. 같은 초의 PID 재사용을 배제할 수 없어 프로젝트 귀속은 미확인입니다.' : reasons[rssBytes === null ? 'unknown' : 'observed'],
    identityPrecision: coarse ? 'seconds' : 'kernel-ticks', observation: {
      hostId: target.hostId, pid: target.pid, startTime: coarse ? Math.floor(target.startTime / 1000) * 1000 : target.startTime,
      observedAt: now, rssBytes, state: 'running', workstreamIds: !coarse && target.linkage ? [...target.linkage.workstreamIds] : [],
      linkage: !coarse && target.linkage ? 'verified' : 'unknown', source: coarse ? 'darwin-ps:explicit-pid' : 'linux-proc:explicit-pid',
    } };
}
function parseStat(value: string, pid: number): { ticks: string; exited: boolean } {
  // comm may contain spaces, parentheses and newlines. It is discarded, not logged.
  const end = value.lastIndexOf(')');
  if (!value.startsWith(`${pid} (`) || end < 0) return fail('unknown');
  const fields = value.slice(end + 1).trim().split(/\s+/u);
  if (fields.length < 20 || !/^[RSDTtXZxKWPI]$/u.test(fields[0]) || !/^(0|[1-9]\d{0,19})$/u.test(fields[19])) return fail('unknown');
  return { ticks: fields[19], exited: /^[ZXx]$/u.test(fields[0]) };
}
function field(value: string, name: string): string | null {
  const lines = value.split('\n').filter(line => line.startsWith(`${name}:`));
  return lines.length === 1 ? lines[0].slice(name.length + 1).trim() : null;
}
function parseStatus(value: string, target: TrustedProcessMemoryTarget): number | null {
  if (field(value, 'Pid') !== String(target.pid) || field(value, 'Tgid') !== String(target.pid)) fail('unknown');
  const uid = field(value, 'Uid')?.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/u);
  if (!uid || !natural(Number(uid[2]))) fail('unknown');
  if (Number(uid[2]) !== target.expectedUid) fail('owner-mismatch');
  const raw = field(value, 'VmRSS');
  if (raw === null) return null;
  const rss = raw.match(/^(\d+)\s+kB$/u);
  if (!rss || !natural(Number(rss[1]) * 1024)) fail('unknown');
  return Number(rss[1]) * 1024;
}
function parsePs(value: string, target: TrustedProcessMemoryTarget): { rssBytes: number; exited: boolean } {
  const lines = value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) fail('unknown');
  const parts = lines[0].match(/^(\d+)\s+(\d+)\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\d+)\s+([A-Za-z?+<>]+)$/u);
  if (!parts || Number(parts[1]) !== target.pid) fail('unknown');
  if (!natural(Number(parts[2]))) fail('unknown');
  if (Number(parts[2]) !== target.expectedUid) fail('owner-mismatch');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(parts[4]);
  const start = Date.UTC(Number(parts[9]), month, Number(parts[5]), Number(parts[6]), Number(parts[7]), Number(parts[8]));
  const date = new Date(start);
  if (date.getUTCMonth() !== month || date.getUTCDate() !== Number(parts[5]) || date.getUTCHours() !== Number(parts[6])
    || date.getUTCMinutes() !== Number(parts[7]) || date.getUTCSeconds() !== Number(parts[8])
    || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()] !== parts[3]) fail('unknown');
  if (start !== Math.floor(target.startTime / 1000) * 1000) fail('pid-reused');
  const rssBytes = Number(parts[10]) * 1024;
  if (!natural(rssBytes) || !/^[IRSTUHZ]/u.test(parts[11])) fail('unknown');
  return { rssBytes, exited: parts[11].startsWith('Z') || parts[11].includes('E') };
}

export function createProcessMemoryAdapter(options: ProcessMemoryAdapterOptions) {
  if (!textReference(options.hostId)) throw new Error('A trusted local host identity is required.');
  const hostId = options.hostId;
  const platform = options.platform ?? process.platform, io = options.io ?? nativeIO, now = options.now ?? Date.now;
  const maxProcesses = limit(options.maxProcesses, 32, 128), timeoutMs = limit(options.timeoutMs, 1500, 5000);
  const maxOutputBytes = limit(options.maxOutputBytes, 256 * 1024, 1024 * 1024);
  const maxFileBytes = limit(options.maxFileBytes, 16 * 1024, 64 * 1024);
  let busy = false;
  function result(samples: ProcessMemorySample[], observedAt: number, error: ProcessMemoryReadState | null = null): ProcessMemoryReadResult {
    const measured = samples.some(row => row.state === 'observed');
    return { state: !error && samples.length > 0 && samples.every(row => row.state === 'observed' || row.state === 'exited') ? 'complete' : measured ? 'partial' : 'unknown',
      coverage: measured ? 'partial' : 'unknown', scope: 'explicit-pids', observedAt, samples,
      observations: samples.map(row => ({ ...row.observation, workstreamIds: [...row.observation.workstreamIds] })), error };
  }
  return {
    async read(request: { targets: readonly TrustedProcessMemoryTarget[]; signal?: AbortSignal }): Promise<ProcessMemoryReadResult> {
      const observedAt = now();
      if (!timestamp(observedAt)) throw new Error('Invalid observation clock.');
      if (!request || !Array.isArray(request.targets)) return result([], observedAt, 'invalid-target');
      if (request.targets.length > maxProcesses) return result([], observedAt, 'output-limit');
      if (busy) return result([], observedAt, 'busy');
      if (request.signal?.aborted) return result([], observedAt, 'cancelled');
      if (platform !== 'linux' && platform !== 'darwin') return result([], observedAt, 'unsupported');
      // Validate and detach the complete request before any I/O, including duplicate PIDs.
      const seen = new Set<number>();
      for (const target of request.targets) {
        if (!validTarget(target, hostId, platform, observedAt) || seen.has(target.pid)) return result([], observedAt, 'invalid-target');
        seen.add(target.pid);
      }
      const targets = request.targets.map(safeTarget);
      if (!targets.length) return result([], observedAt);
      const controller = new AbortController();
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
      let timedOut = false, bytes = 0;
      const samples: ProcessMemorySample[] = [];
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let onAbort!: () => void;
      const stopped = new Promise<ProcessMemoryReadResult>(resolve => {
        onAbort = () => {
          const state = timedOut ? 'timeout' : 'cancelled';
          resolve(result([...samples, ...targets.slice(samples.length).map(target => unknownSample(target, state, now()))], now(), state));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      busy = true;
      const work = (async () => {
        const readProc = async (target: TrustedProcessMemoryTarget, name: 'stat' | 'status') => {
          signal.throwIfAborted();
          const maxBytes = Math.min(maxFileBytes, maxOutputBytes - bytes);
          if (maxBytes <= 0) fail('output-limit');
          const value = await io.readProcFile(`/proc/${target.pid}/${name}`, { signal, maxBytes });
          signal.throwIfAborted();
          const length = Buffer.byteLength(value);
          bytes += length;
          if (length > maxBytes || bytes > maxOutputBytes) fail('output-limit');
          return value;
        };
        for (const target of targets) {
          if (signal.aborted) break;
          try {
            if (platform === 'linux') {
              const before = parseStat(await readProc(target, 'stat'), target.pid);
              if (target.lifetime.kind !== 'linux-start-ticks' || before.ticks !== target.lifetime.value) fail('pid-reused');
              if (before.exited) fail('exited');
              const rssBytes = parseStatus(await readProc(target, 'status'), target);
              const after = parseStat(await readProc(target, 'stat'), target.pid);
              if (after.ticks !== before.ticks) fail('pid-reused');
              if (after.exited) fail('exited');
              samples.push(sample(target, now(), rssBytes, false));
            } else {
              const maxBytes = Math.min(maxFileBytes, maxOutputBytes - bytes);
              if (maxBytes <= 0) fail('output-limit');
              const value = await io.runPs(processMemoryPsCommand(target.pid), { signal, maxBytes });
              signal.throwIfAborted();
              const length = Buffer.byteLength(value.stdout) + value.stderrBytes;
              if (!natural(value.stderrBytes) || length > maxBytes) fail('output-limit');
              bytes += length;
              if (value.exitCode !== 0 || value.stderrBytes > 0) fail('unknown');
              const parsed = parsePs(value.stdout, target);
              if (parsed.exited) fail('exited');
              samples.push(sample(target, now(), parsed.rssBytes, true));
            }
          } catch (error) {
            if (signal.aborted) break;
            const state = errorState(error, platform === 'linux');
            samples.push(unknownSample(target, state, now()));
            if (state === 'output-limit') {
              samples.push(...targets.slice(samples.length).map(item => unknownSample(item, state, now())));
              return result(samples, now(), state);
            }
          }
        }
        return result(samples, now());
      })();
      // A non-cooperative OS/test read may outlive the caller's deadline. Keep the adapter
      // busy until it really settles, so repeated polls cannot accumulate orphan work.
      void work.then(() => { busy = false; }, () => { busy = false; });
      try { return await Promise.race([work, stopped]); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
    },
  };
}
