import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeQueryGroup } from '../../collector/orca/process-group';
import type { DagFailureKind } from './types';

/** Version-bound transport only: original external main executes twice with fixed CLI modes.
 * No DAG semantics are implemented here. Original bytes are verified before execution. */
export const QUERY_SHA256 = '23d00c96beb0661bb7da064d7dd83566ea754f75165bb9790831dabc25887d47';
const TRANSPORT = `import sys, json, hashlib, pathlib, os, stat
script, source, done, expected, source_hash, maximum, directory = sys.argv[1:]
with open(script, 'rb') as stream: code = stream.read(1024 * 1024 + 1)
if hashlib.sha256(code).hexdigest() != expected: raise RuntimeError('unsupported query version')
namespace = {'__name__': '__dag_query_transport__', '__file__': script}
exec(compile(code, script, 'exec'), namespace)
if not callable(namespace.get('main')) or not callable(namespace.get('emit')): raise RuntimeError('unsupported query contract')
if os.path.realpath(source) != source: raise RuntimeError('source path changed')
fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(fd, 'rb') as stream:
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise RuntimeError('source not a file')
    raw = stream.read(int(maximum) + 1)
if len(raw) > int(maximum) or hashlib.sha256(raw).hexdigest() != source_hash: raise RuntimeError('source changed')
result = {}
snapshot = pathlib.Path(directory) / 'dag.yaml'
snapshot.write_bytes(raw)
for mode, args in [('index', ['--index', '--fields', 'id,title,status,depends_on,e2e,commits']), ('coverage', ['--coverage', '--done-status', done])]:
    emitted = []
    namespace['emit'] = emitted.append
    sys.argv = [script, str(snapshot)] + args
    namespace['main']()
    if len(emitted) != 1: raise RuntimeError('unsupported query emission')
    result[mode] = emitted[0]
print(json.dumps(result, ensure_ascii=True, allow_nan=False))
`;
export type ProcessResult = { ok: true; data: unknown } | { ok: false; kind: DagFailureKind };
/** Same-group cleanup is shared with Orca; query argv is independently fixed here. */
export function createQueryProcess(config: { pythonPath: string; queryScriptPath: string; doneStatus: string; timeoutMs: number; maxOutputBytes: number }) {
  let poisoned = false;
  return async (source: string, sourceHash: string, maxSourceBytes: number, signal: AbortSignal): Promise<ProcessResult> => {
    if (poisoned) return { ok: false, kind: 'cleanup_unverified' };
    if (signal.aborted) return { ok: false, kind: 'cancelled' };
    const directory = await mkdtemp(join(tmpdir(), 'note-dag-query-'));
    try {
      if (signal.aborted) return { ok: false, kind: 'cancelled' };
      return await new Promise<ProcessResult>(resolve => {
      let chunks: Buffer[] = [], bytes = 0, stopped: DagFailureKind | null = null, settled = false;
      const child = spawn(config.pythonPath, ['-I', '-B', '-c', TRANSPORT, config.queryScriptPath, source, config.doneStatus, QUERY_SHA256, sourceHash, String(maxSourceBytes), directory], {
        shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      let cleanup: Promise<boolean> | null = null;
      const wipe = () => { for (const chunk of chunks) chunk.fill(0); chunks = []; };
      const finish = (result: ProcessResult) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); wipe(); resolve(result);
      };
      const clean = (): Promise<boolean> => {
        if (cleanup) return cleanup;
        cleanup = finalizeQueryGroup(child);
        void cleanup.then(ok => { if (!ok) { poisoned = true; child.stdout.destroy(); child.stderr.destroy(); finish({ ok: false, kind: 'cleanup_unverified' }); } });
        return cleanup;
      };
      const stop = (kind: DagFailureKind) => { if (stopped || settled) return; stopped = kind; wipe(); child.stdout.destroy(); child.stderr.destroy(); void clean(); };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), config.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const receive = (chunk: Buffer, retain: boolean) => {
        if (stopped || settled) return;
        bytes += chunk.byteLength;
        if (bytes > config.maxOutputBytes) return stop('output_limit');
        if (retain) chunks.push(Buffer.from(chunk));
      };
      child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
      child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
      child.stdout.on('error', () => stop('command_failed')); child.stderr.on('error', () => stop('command_failed'));
      child.once('error', () => stop('command_failed'));
      child.once('exit', () => { void clean(); });
      child.once('close', async (code, termination) => {
        if (!await clean() || settled) return;
        if (stopped) return finish({ ok: false, kind: stopped });
        if (code !== 0 || termination !== null) return finish({ ok: false, kind: 'command_failed' });
        const buffer = Buffer.concat(chunks); wipe();
        try { finish({ ok: true, data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) }); }
        catch { finish({ ok: false, kind: 'invalid_schema' }); }
        finally { buffer.fill(0); }
      });
    }); } finally { await rm(directory, { recursive: true, force: true }); }
  };
}
