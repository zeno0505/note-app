import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createQueryProcess } from './process';
import { projectDagQuery } from './projection';
import type { DagFailureKind, DagReaderOptions, DagReader, DagReaderRecovery, DagReadModel, DagReadResult } from './types';
export type * from './types';

class SourceFailure extends Error { constructor(readonly kind: DagFailureKind) { super(kind); } }
const fail = (kind: DagFailureKind): DagReadResult => ({ ok: false, error: { kind, message: 'DAG observation could not be refreshed.' } });
function limit(v: number | undefined, fallback: number, max: number): number {
  const result = v ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('Invalid DAG reader limit.');
  return result;
}
const trustedPath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
async function fingerprint(path: string, maximum: number, signal: AbortSignal) {
  const active = () => { if (signal.aborted) throw new SourceFailure('cancelled'); };
  active();
  const canonical = await realpath(path);
  active();
  if (canonical !== path) throw new SourceFailure('source_changed');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    active(); // A late open still owns a handle: finally must close it.
    const before = await handle.stat();
    active();
    if (!before.isFile()) throw new SourceFailure('source_unavailable');
    if (before.size > maximum) throw new SourceFailure('source_limit');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    try {
      while (true) {
        active();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        active();
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maximum) throw new SourceFailure('source_limit');
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally { buffer.fill(0); }
    const after = await handle.stat();
    active();
    const canonicalAfter = await realpath(path);
    active();
    const named = await stat(path);
    active();
    if (named.dev !== after.dev || named.ino !== after.ino || named.size !== after.size
      || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs
      || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino
      || canonicalAfter !== path) throw new SourceFailure('source_changed');
    return { hash: hash.digest('hex'), mtimeMs: after.mtimeMs, identity: `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` };
  } finally { try {await handle.close();} catch {throw new SourceFailure('cleanup_unverified');} }
}
/** Main-only factory. The sole per-read argument is a registered opaque DAG ID. */
export function createDagReader(options: DagReaderOptions): DagReader {
  if (!trustedPath(options.pythonPath) || !trustedPath(options.queryScriptPath) || !Array.isArray(options.registrations) || options.registrations.length > 100) throw new Error('Invalid trusted DAG reader configuration.');
  const registrations = new Map<string, string>();
  for (const entry of options.registrations) {
    if (!entry || typeof entry.dagId !== 'string' || !entry.dagId || entry.dagId.length > 1024 || !trustedPath(entry.canonicalDagPath) || registrations.has(entry.dagId)) throw new Error('Invalid DAG registration.');
    registrations.set(entry.dagId, entry.canonicalDagPath);
  }
  const doneStatus = options.doneStatus ?? 'done';
  if (typeof doneStatus !== 'string' || !doneStatus || doneStatus.length > 128 || /[\u0000-\u001f\u007f]/u.test(doneStatus)) throw new Error('Invalid done status.');
  const timeoutMs = limit(options.timeoutMs, 5000, 60000);
  const maxOutputBytes = limit(options.maxOutputBytes, 2 * 1024 * 1024, 8 * 1024 * 1024);
  const maxSourceBytes = limit(options.maxSourceBytes, 16 * 1024 * 1024, 64 * 1024 * 1024);
  if(options.requireDocumentShape!==undefined&&typeof options.requireDocumentShape!=='boolean')throw new Error('Invalid DAG shape requirement');
  let run = createQueryProcess({ pythonPath: options.pythonPath, queryScriptPath: options.queryScriptPath, doneStatus, timeoutMs, maxOutputBytes,requireDocumentShape:options.requireDocumentShape });
  const cache = new Map<string, DagReadModel>();
  let busy = false;
  let abandoned = false;
  let operationSettled=true, cleanupFailed=false, generation=0;
  let cause:DagReaderRecovery['cause']|null=null;
  const recoveryState=():DagReaderRecovery|null=>cause?{cause,cleanup:!operationSettled?'pending':cleanupFailed?'unverified':'verified',retired:abandoned,generation}:null;
  return {
    recoveryState,
    recover(){
      if(!abandoned||busy||!operationSettled||cleanupFailed)return false;
      // No unresolved IO, handles, process groups or snapshot removal remain.
      run=createQueryProcess({pythonPath:options.pythonPath,queryScriptPath:options.queryScriptPath,doneStatus,timeoutMs,maxOutputBytes,requireDocumentShape:options.requireDocumentShape});
      cache.clear();abandoned=false;generation++;return true;
    },
    async read(dagId: string, request: { signal?: AbortSignal } = {}): Promise<DagReadResult> {
      if (typeof dagId !== 'string' || !registrations.has(dagId)) return fail('invalid_request');
      if (abandoned) return fail('cleanup_unverified');
      if (busy) return fail('busy');
      if (request.signal?.aborted) return fail('cancelled');
      busy = true;operationSettled=false;
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
      const abortKind = (): DagFailureKind => request.signal?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'cancelled';
      const observe = async (): Promise<DagReadResult> => {
        try {
          const path = registrations.get(dagId)!;
          const before = await fingerprint(path, maxSourceBytes, signal);
          const prior = cache.get(dagId);
          // Rehash even when mtime is unchanged: equal-size rewrites cannot hide behind timestamps.
          if (prior?.sourceHash === before.hash) {
            if (signal.aborted) return fail(abortKind());
            const value = { ...prior, sourceMtimeMs: before.mtimeMs, observedAt: new Date().toISOString() };
            cache.set(dagId, value);
            return { ok: true, value: structuredClone(value), unchanged: true };
          }
          let queried;try{queried=await run(path,before.hash,maxSourceBytes,signal);}catch{throw new SourceFailure('cleanup_unverified');}
          if (!queried.ok && queried.kind==='cleanup_unverified'){cleanupFailed=true;if(!abandoned)cause='cleanup_unverified';abandoned=true;}
          if (!queried.ok) return fail(queried.kind === 'cancelled' ? abortKind() : queried.kind);
          const after = await fingerprint(path, maxSourceBytes, signal);
          if (before.hash !== after.hash || before.identity !== after.identity) return fail('source_changed');
          let projection;
          try { projection = projectDagQuery(queried.data); } catch { return fail('invalid_schema'); }
          if (signal.aborted) return fail(abortKind());
          const value: DagReadModel = { dagId, sourceHash: after.hash, sourceMtimeMs: after.mtimeMs, observedAt: new Date().toISOString(), doneStatus, ...projection, verifiedFacts: [] };
          cache.set(dagId, value);
          return { ok: true, value: structuredClone(value), unchanged: false };
        } catch (error) {
          if(error instanceof SourceFailure&&error.kind==='cleanup_unverified'){cleanupFailed=true;if(!abandoned)cause='cleanup_unverified';abandoned=true;}
          return fail(signal.aborted ? abortKind() : error instanceof SourceFailure ? error.kind : 'source_unavailable');
        }
      };
      // Node cannot cancel kernel filesystem IO. Bound the *response* independently;
      // retain cleanup ownership and prohibit reuse if work outlives its deadline.
      try {
        return await new Promise<DagReadResult>(resolve => {
          let settled = false;
          const abort = () => {
            if (settled) return;
            settled = true;if(!abandoned)cause=abortKind() as 'cancelled'|'timeout';abandoned=true;
            signal.removeEventListener('abort', abort);
            resolve(fail(abortKind()));
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) { operationSettled=true;abort(); return; }
          void observe().then(result => {
            operationSettled=true;
            if (settled) return;
            settled = true; signal.removeEventListener('abort', abort); resolve(result);
          });
        });
      } finally { busy = false; }
    },
  };
}
