import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { isOrcaQuery, orcaArguments } from './commands';
import { failure } from './errors';
import { parseOrcaResponse } from './parser';
import { finalizeQueryGroup } from './process-group';
import type { OrcaAdapterOptions, OrcaFailureKind, OrcaQuery, OrcaQueryData, OrcaReadOptions, OrcaResponse, OrcaResult } from './types';

export interface OrcaRunner {
  read<Q extends OrcaQuery>(query: Q, options?: OrcaReadOptions): Promise<OrcaResult<OrcaResponse<OrcaQueryData[Q]>>>;
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('Invalid Orca collector limit.');
  return result;
}
/** Main-process only. There is deliberately no shell, argv, cwd, env, or command-string option. */
export function createOrcaRunner(options: OrcaAdapterOptions = {}): OrcaRunner {
  const executable = options.executablePath ?? 'orca';
  if (typeof executable !== 'string' || (executable !== 'orca' && !isAbsolute(executable)) || /[\u0000-\u001f\u007f]/u.test(executable)) {
    throw new Error('Orca executable must be a trusted absolute path.');
  }
  const timeoutMs = limit(options.timeoutMs, 5000, 60_000);
  const maxOutputBytes = limit(options.maxOutputBytes, 2 * 1024 * 1024, 8 * 1024 * 1024);
  let busy = false;
  let cleanupUnverified = false;
  return {
    async read<Q extends OrcaQuery>(query: Q, request: OrcaReadOptions = {}): Promise<OrcaResult<OrcaResponse<OrcaQueryData[Q]>>> {
      if (!isOrcaQuery(query)) return failure('forbidden_query', null);
      if (cleanupUnverified) return failure('cleanup_unverified', query);
      if (busy) return failure('busy', query);
      if (request.signal?.aborted) return failure('cancelled', query);
      busy = true;
      try {
        return await new Promise(resolve => {
          let chunks: Buffer[] = [];
          let bytes = 0;
          let stopped: OrcaFailureKind | null = null;
          let settled = false;
          let cleanup: Promise<boolean> | null = null;
          let child;
          try {
            child = spawn(executable, [...orcaArguments(query)], {
              shell: false, windowsHide: true, detached: process.platform !== 'win32',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch { resolve(failure('spawn_failed', query)); return; }
          const wipe = (): void => { for (const chunk of chunks) chunk.fill(0); chunks = []; };
          const finish = (result: OrcaResult<OrcaResponse<OrcaQueryData[Q]>>): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onAbort);
            wipe();
            resolve(result);
          };
          const startCleanup = (): Promise<boolean> => {
            if (cleanup) return cleanup;
            cleanup = finalizeQueryGroup(child);
            void cleanup.then(verified => {
              if (!verified) {
                cleanupUnverified = true;
                child.stdout.destroy(); child.stderr.destroy();
                // Bounded failure, never a normal result; this runner cannot spawn again.
                finish(failure('cleanup_unverified', query));
              }
            });
            return cleanup;
          };
          const stop = (kind: OrcaFailureKind): void => {
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
            bytes += chunk.byteLength;
            if (bytes > maxOutputBytes) { stop('output_limit'); return; }
            if (retain) chunks.push(Buffer.from(chunk));
          };
          child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
          child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
          child.stdout.on('error', () => stop('command_failed'));
          child.stderr.on('error', () => stop('command_failed'));
          child.once('error', (error: NodeJS.ErrnoException) => {
            stop(error.code === 'ENOENT' ? 'unavailable' : error.code === 'EACCES' || error.code === 'EPERM' ? 'access_denied' : 'spawn_failed');
          });
          child.once('exit', () => {
            // Even a successful root process may leave live same-group descendants.
            // Start on exit, not close: descendants may still hold stdout/stderr open.
            void startCleanup();
          });
          child.once('close', async (code, signal) => {
            clearTimeout(timer);
            const verified = await startCleanup();
            if (settled || !verified) return;
            if (stopped) { finish(failure(stopped, query)); return; }
            const buffer = Buffer.concat(chunks);
            wipe();
            let result: OrcaResult<OrcaResponse<OrcaQueryData[Q]>>;
            try { result = parseOrcaResponse(query, new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
            catch { result = failure('invalid_json', query); }
            finally { buffer.fill(0); }
            if (code !== 0 || signal !== null) {
              if (!result.ok && (result.error.kind === 'access_denied' || result.error.kind === 'remote_error')) finish(result);
              else finish(failure('command_failed', query));
            } else finish(result);
          });
        });
      } finally { busy = false; }
    },
  };
}
