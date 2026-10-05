import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { copyBoundedCacheData } from './data';

export const MAX_SUMMARY_CACHE_BYTES = 4 * 1024 * 1024;
const FILE = 'summary-cache-v1.json';
const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export class SummaryCacheError extends Error {
  constructor(public readonly code: 'invalid' | 'unsafe-path' | 'conflict' | 'busy' | 'cancelled' | 'committed-cleanup-failed', message: string, public readonly committedRevision?: number) { super(message); }
}
export interface SummaryCacheRecord<T> { revision: number; payload: T }
/** Trusted main-process parser, never supplied by a renderer or imported document. */
export interface SummaryCacheCodec<T> { parse(value: unknown): T }
interface Envelope<T> extends SummaryCacheRecord<T> { schemaVersion: 1; integrity: string }
const fail = (code: SummaryCacheError['code'], message: string): never => { throw new SummaryCacheError(code, message); };
const cancelled = (signal?: AbortSignal): void => { if (signal?.aborted) fail('cancelled', 'Cache operation cancelled'); };
const errno = (error: unknown, code: string): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === code;
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('invalid', 'Invalid cache envelope fields');
  return value as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER) fail('invalid', 'Invalid cache revision');
  return value as number;
}
/** Does not establish approval authenticity. Only a host-controlled cache may use this adapter. */
export function createLocalSummaryCache<T>(options: { directory: string; codec: SummaryCacheCodec<T> }) {
  const directory = options.directory;
  // Caller must supply an existing, private, main-owned directory. Never create a vault path.
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory === path.parse(directory).root) fail('unsafe-path', 'Expected canonical absolute app-cache directory');
  const filename = path.join(directory, FILE);
  const lockname = path.join(directory, '.summary-cache.lock');
  async function checkDirectory(): Promise<string> {
    let current = path.parse(directory).root;
    const identities: string[] = [];
    for (const component of directory.slice(current.length).split(path.sep)) {
      current = path.join(current, component);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe-path', 'Cache ancestors must be real directories');
      identities.push(`${stat.dev}:${stat.ino}`);
    }
    if (await fs.realpath(directory) !== directory) fail('unsafe-path', 'Cache path escaped its main-owned directory');
    return identities.join('/');
  }
  async function read(signal?: AbortSignal): Promise<SummaryCacheRecord<T> | null> {
    cancelled(signal);
    const identity = await checkDirectory();
    let handle;
    try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (errno(error, 'ENOENT')) return null; if (errno(error, 'ELOOP')) fail('unsafe-path', 'Symlink cache rejected'); throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) fail('unsafe-path', 'Cache must be an single-link regular file');
      if (stat.size > MAX_SUMMARY_CACHE_BYTES) fail('invalid', 'Cache exceeds byte limit');
      // Read at most the bound plus one, even if the file grows after stat.
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_SUMMARY_CACHE_BYTES + 1));
      let used = 0;
      while (used < buffer.length) {
        cancelled(signal);
        const result = await handle.read(buffer, used, Math.min(65536, buffer.length - used), used);
        if (!result.bytesRead) break;
        used += result.bytesRead;
      }
      if (used !== stat.size) fail('invalid', 'Cache changed during read');
      cancelled(signal);
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await checkDirectory() !== identity) fail('conflict', 'Cache changed during read');
      let input: unknown;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))); }
      catch { fail('invalid', 'Malformed cache JSON or UTF-8'); }
      const e = fields(input, ['schemaVersion', 'revision', 'payload', 'integrity']);
      if (e.schemaVersion !== 1) fail('invalid', 'Unsupported cache version');
      const rev = revision(e.revision);
      const integrity = digest(JSON.stringify({ schemaVersion: 1, revision: rev, payload: e.payload }));
      if (e.integrity !== integrity) fail('invalid', 'Cache integrity mismatch');
      let payload!: T;
      try { payload = options.codec.parse(e.payload); } catch { fail('invalid', 'Invalid summary persistence payload'); }
      cancelled(signal);
      return { revision: rev, payload };
    } finally { await handle.close(); }
  }
  async function write(payload: T, expectedRevision: number | null, signal?: AbortSignal): Promise<SummaryCacheRecord<T>> {
    cancelled(signal);
    if (expectedRevision !== null) revision(expectedRevision);
    // Detach before awaiting. The codec validates structure/provenance and rejects approval imports.
    let parsed!: T;
    try { parsed = options.codec.parse(copyBoundedCacheData(payload, MAX_SUMMARY_CACHE_BYTES)); } catch { fail('invalid', 'Invalid summary persistence payload'); }
    const next = (expectedRevision ?? 0) + 1;
    revision(next);
    const body = { schemaVersion: 1 as const, revision: next, payload: parsed };
    const envelope: Envelope<T> = { ...body, integrity: digest(JSON.stringify(body)) };
    const serialized = Buffer.from(JSON.stringify(envelope));
    if (serialized.length > MAX_SUMMARY_CACHE_BYTES) fail('invalid', 'Cache exceeds byte limit');
    const identity = await checkDirectory();
    cancelled(signal);
    let lock;
    try { lock = await fs.open(lockname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (errno(error, 'EEXIST') || errno(error, 'ELOOP')) fail('busy', 'Cache writer lock exists; refusing takeover'); throw error; }
    let lockStat: { dev: number; ino: number } | null = null;
    let committed = false;
    let temporary: string | null = null;
    let temporaryIdentity: { dev: number; ino: number } | null = null;
    try {
      lockStat = await lock.stat();
      cancelled(signal);
      const existing = await read(signal); // Corruption/unsupported version blocks writes; never empty-success.
      if ((existing?.revision ?? null) !== expectedRevision) fail('conflict', 'Stale cache revision');
      temporary = path.join(directory, `.summary-cache-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        temporaryIdentity = await handle.stat();
        let offset = 0;
        while (offset < serialized.length) {
          cancelled(signal);
          const result = await handle.write(serialized, offset, Math.min(65536, serialized.length - offset), offset);
          if (!result.bytesWritten) throw new Error('Cache write made no progress');
          offset += result.bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      cancelled(signal);
      if (await checkDirectory() !== identity) fail('unsafe-path', 'Cache directory changed before commit');
      const current = await read(signal);
      if ((current?.revision ?? null) !== expectedRevision) fail('conflict', 'Cache changed before commit');
      const tempStat = await fs.lstat(temporary);
      if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== 1 || tempStat.dev !== temporaryIdentity.dev || tempStat.ino !== temporaryIdentity.ino) fail('unsafe-path', 'Temporary file changed');
      cancelled(signal);
      await fs.rename(temporary, filename); // Commit point. Cancellation after this point does not roll back.
      temporary = null;
      committed = true;
      return { revision: next, payload: parsed };
    } finally {
      // Only remove files created by this invocation, and only while directory/inode still match.
      try {
        if (await checkDirectory() === identity) {
          if (temporary && temporaryIdentity) {
            const stat = await fs.lstat(temporary).catch(error => { if (errno(error, 'ENOENT')) return null; throw error; });
            if (stat && !stat.isSymbolicLink() && stat.dev === temporaryIdentity.dev && stat.ino === temporaryIdentity.ino) await fs.unlink(temporary);
          }
          const stat = await fs.lstat(lockname).catch(error => { if (errno(error, 'ENOENT')) return null; throw error; });
          if (lockStat && stat && !stat.isSymbolicLink() && stat.dev === lockStat.dev && stat.ino === lockStat.ino) await fs.unlink(lockname);
        }
      } catch (error) {
        if (committed) throw new SummaryCacheError('committed-cleanup-failed', 'Cache was committed but cleanup failed; read its revision before retry', next);
        throw error;
      } finally {
        try { await lock.close(); } catch (error) {
          if (committed) throw new SummaryCacheError('committed-cleanup-failed', 'Cache was committed but lock close failed; read its revision before retry', next);
          throw error;
        }
      }
    }
  }
  return { read, write };
}
