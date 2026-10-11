import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { finalizeQueryGroup } from '../../collector/orca/process-group';
import type { AgentProvider } from './index';

export type CodeBurnQuery = 'claude-status' | 'codex-status' | 'quota';
export type CodeBurnFailure = 'forbidden-query' | 'busy' | 'cancelled' | 'timeout' | 'output-limit'
  | 'unavailable' | 'access-denied' | 'spawn-failed' | 'command-failed'
  | 'invalid-json' | 'invalid-schema' | 'cleanup-unverified';
interface Observation { observedAt: number; provenance: 'codeburn-cli'; }
export interface CodeBurnPeriod {
  label: 'today' | 'month';
  cost: number; savings: number; calls: number;
  approximate: true;
  /** Original collector flag; absence does not prove zero actual usage. */
  hasUsage?: boolean | null;
  /** Labels alone cannot establish timezone, start/end, or budget comparability. */
  window: null;
}
export interface CodeBurnStatus extends Observation {
  kind: 'status'; provider: AgentProvider; currency: string;
  periods: CodeBurnPeriod[];
  hasUsage?: boolean | null;
  calendarBasis: 'unknown';
}
export interface CodeBurnQuotaProvider {
  provider: AgentProvider;
  quotaData: 'available' | 'unavailable' | 'unknown';
  /** This endpoint does not establish whether an agent can execute. */
  agentAvailability: 'unknown';
  error: 'none' | 'reported-error' | 'unknown';
  windows: { label: string; usedPct: number; resetsAt: string | number | null; resetTimeFormat: 'unverified' }[];
}
export interface CodeBurnQuota extends Observation { kind: 'quota'; providers: CodeBurnQuotaProvider[] }
export type CodeBurnResult =
  | { ok: true; value: CodeBurnStatus | CodeBurnQuota; diagnostics?:{stderrReported:true} }
  | { ok: false; diagnostics?:{stderrReported:true}; observedAt: number; error: { kind: CodeBurnFailure; query: CodeBurnQuery | null } };
export interface CodeBurnOptions {
  /** Explicit trusted main-process configuration, never renderer input or PATH lookup. */
  executablePath: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
const commands = Object.freeze({
  'claude-status': Object.freeze(['status', '--format', 'json', '--provider', 'claude']),
  'codex-status': Object.freeze(['status', '--format', 'json', '--provider', 'codex']),
  quota: Object.freeze(['quota', '--format', 'json']),
});
const isQuery = (query: unknown): query is CodeBurnQuery => typeof query === 'string' && Object.hasOwn(commands, query);
const fail = (kind: CodeBurnFailure, query: CodeBurnQuery | null, observedAt = Date.now()): CodeBurnResult =>
  ({ ok: false, observedAt, error: { kind, query } });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const label = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Narrow fact projection only. Unknown fields are discarded, never interpreted as caps. */
export function projectCodeBurn(query: CodeBurnQuery, input: unknown, observedAt: number): CodeBurnResult {
  if (!isQuery(query)) return fail('forbidden-query', null, observedAt);
  if (!nonnegative(observedAt) || !record(input)) return fail('invalid-schema', query, observedAt);
  const observation: Observation = { observedAt, provenance: 'codeburn-cli' };
  if (query !== 'quota') {
    if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) return fail('invalid-schema', query, observedAt);
    const periods: CodeBurnPeriod[] = [];
    for (const period of ['today', 'month'] as const) {
      const value = input[period];
      if (!record(value) || !nonnegative(value.cost) || !nonnegative(value.savings)
        || !nonnegative(value.calls) || !Number.isSafeInteger(value.calls)) return fail('invalid-schema', query, observedAt);
      periods.push({ label: period, cost: value.cost, savings: value.savings, calls: value.calls, approximate: true, hasUsage:typeof value.hasUsage==='boolean'?value.hasUsage:null, window: null });
    }
    return { ok: true, value: { ...observation, kind: 'status', provider: query === 'claude-status' ? 'claude' : 'codex',
      currency: input.currency, periods, hasUsage:typeof input.hasUsage==='boolean'?input.hasUsage:null, calendarBasis: 'unknown' } };
  }
  if (!Array.isArray(input.providers) || input.providers.length > 32) return fail('invalid-schema', query, observedAt);
  const projected = new Map<AgentProvider, CodeBurnQuotaProvider>();
  for (const value of input.providers) {
    if (!record(value) || typeof value.id !== 'string') return fail('invalid-schema', query, observedAt);
    if (value.id !== 'claude' && value.id !== 'codex') continue;
    if (projected.has(value.id) || typeof value.available !== 'boolean' || !Array.isArray(value.windows)
      || value.windows.length > 32 || (value.error !== undefined && value.error !== null && typeof value.error !== 'string')) {
      return fail('invalid-schema', query, observedAt);
    }
    const windows: CodeBurnQuotaProvider['windows'] = [];
    for (const window of value.windows) {
      if (!record(window)) return fail('invalid-schema', query, observedAt);
      const resetsAt = Object.hasOwn(window, 'resetsAt') ? window.resetsAt : null;
      if (!label(window.label) || !nonnegative(window.usedPct)
        || !(resetsAt === null || label(resetsAt) || nonnegative(resetsAt))) {
        return fail('invalid-schema', query, observedAt);
      }
      windows.push({ label: window.label, usedPct: window.usedPct, resetsAt, resetTimeFormat: 'unverified' });
    }
    const reportedError = typeof value.error === 'string' && value.error.length > 0;
    if ((!value.available && windows.length > 0) || (value.available && reportedError)) return fail('invalid-schema', query, observedAt);
    projected.set(value.id, { provider: value.id, quotaData: value.available ? 'available' : 'unavailable',
      agentAvailability: 'unknown', error: reportedError ? 'reported-error' : value.available ? 'none' : 'unknown', windows });
  }
  return { ok: true, value: { ...observation, kind: 'quota', providers: (['claude', 'codex'] as const).map(provider =>
    projected.get(provider) ?? { provider, quotaData: 'unknown', agentAvailability: 'unknown', error: 'unknown', windows: [] }) } };
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('Invalid CodeBurn collector limit.');
  return result;
}
/** Main-process only. No shell, arbitrary argv, cwd, env, database, credential or session option. */
export function createCodeBurnReader(options: CodeBurnOptions): {
  read(query: CodeBurnQuery, request?: { signal?: AbortSignal }): Promise<CodeBurnResult>;
} {
  if (!options || typeof options.executablePath !== 'string' || !isAbsolute(options.executablePath)
    || /[\u0000-\u001f\u007f]/u.test(options.executablePath)) throw new Error('CodeBurn executable must be a trusted absolute path.');
  const executable = options.executablePath;
  const timeoutMs = limit(options.timeoutMs, 5000, 60_000);
  const maxOutputBytes = limit(options.maxOutputBytes, 512 * 1024, 2 * 1024 * 1024);
  let busy = false;
  let cleanupUnverified = false;
  return {
    async read(query, request = {}): Promise<CodeBurnResult> {
      if (!isQuery(query)) return fail('forbidden-query', null);
      if (cleanupUnverified) return fail('cleanup-unverified', query);
      if (busy) return fail('busy', query);
      if (request.signal?.aborted) return fail('cancelled', query);
      busy = true;
      try {
        return await new Promise(resolve => {
          let chunks: Buffer[] = [];
          let bytes = 0;
          let stderrReported = false;
          let stopped: CodeBurnFailure | null = null;
          let settled = false;
          let cleanup: Promise<boolean> | null = null;
          let child;
          try {
            child = spawn(executable, [...commands[query]], {
              shell: false, windowsHide: true, detached: process.platform !== 'win32',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch { resolve(fail('spawn-failed', query)); return; }
          const wipe = (): void => { for (const chunk of chunks) chunk.fill(0); chunks = []; };
          const finish = (result: CodeBurnResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onAbort);
            wipe();
            resolve(stderrReported?{...result,diagnostics:{stderrReported:true}}:result);
          };
          const startCleanup = (): Promise<boolean> => {
            if (cleanup) return cleanup;
            cleanup = finalizeQueryGroup(child);
            void cleanup.then(verified => {
              if (!verified) {
                cleanupUnverified = true;
                child.stdout.destroy(); child.stderr.destroy();
                finish(fail('cleanup-unverified', query));
              }
            });
            return cleanup;
          };
          const stop = (kind: CodeBurnFailure): void => {
            if (stopped || settled) return;
            stopped = kind;
            wipe();
            child.stdout.destroy(); child.stderr.destroy();
            void startCleanup();
          };
          const timer = setTimeout(() => stop('timeout'), timeoutMs);
          const onAbort = (): void => stop('cancelled');
          request.signal?.addEventListener('abort', onAbort, { once: true });
          if (request.signal?.aborted) onAbort();
          const receive = (chunk: Buffer, retain: boolean): void => {
            if (stopped || settled) return;
            if(!retain&&chunk.byteLength)stderrReported=true;
            bytes += chunk.byteLength;
            if (bytes > maxOutputBytes) { stop('output-limit'); return; }
            if (retain) chunks.push(Buffer.from(chunk));
          };
          child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
          child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
          child.stdout.on('error', () => stop('command-failed'));
          child.stderr.on('error', () => stop('command-failed'));
          child.once('error', (error: NodeJS.ErrnoException) => {
            stop(error.code === 'ENOENT' ? 'unavailable' : error.code === 'EACCES' || error.code === 'EPERM' ? 'access-denied' : 'spawn-failed');
          });
          child.once('exit', () => { void startCleanup(); });
          child.once('close', async (code, signal) => {
            clearTimeout(timer);
            const verified = await startCleanup();
            if (settled || !verified) return;
            if (stopped) { finish(fail(stopped, query)); return; }
            if (code !== 0 || signal !== null) { finish(fail('command-failed', query)); return; }
            const buffer = Buffer.concat(chunks);
            wipe();
            let result: CodeBurnResult;
            try { result = projectCodeBurn(query, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)), Date.now()); }
            catch { result = fail('invalid-json', query); }
            finally { buffer.fill(0); }
            finish(result);
          });
        });
      } finally { busy = false; }
    },
  };
}
