import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { NoteLinkFailureCode } from '../../../shared/note-link-workflow';

export class LinkError extends Error {
  constructor(public code: NoteLinkFailureCode, message: string, public pendingWrite = false) { super(message); }
}
export const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export interface Snapshot {
  path: string; exists: boolean; kind?: 'file' | 'directory' | 'symlink' | 'other';
  dev?: number; ino?: number; mode?: number; size?: number; mtimeMs?: number; ctimeMs?: number;
  link?: string; sha256?: string;
}
export class Budget {
  readonly deadline: number;
  constructor(readonly timeoutMs: number, readonly signal?: AbortSignal) { this.deadline = Date.now() + timeoutMs; }
  check(): void {
    if (this.signal?.aborted) throw new LinkError('cancelled', 'The operation was cancelled.');
    if (Date.now() >= this.deadline) throw new LinkError('timeout', 'The operation exceeded its deadline.');
  }
  async run<T>(operation: () => Promise<T>, mutation = false): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const native = operation();
    try {
      return await Promise.race([native, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LinkError('timeout', mutation ? 'A filesystem change is still pending after its deadline; inspect the reported paths before retrying.' : 'The operation exceeded its deadline.', mutation)), Math.max(1, this.deadline - Date.now()));
        abort = () => reject(new LinkError('cancelled', mutation ? 'Cancellation arrived while a filesystem change was pending; inspect the reported paths before retrying.' : 'The operation was cancelled.', mutation));
        this.signal?.addEventListener('abort', abort, { once: true });
        if (this.signal?.aborted) abort();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) this.signal?.removeEventListener('abort', abort);
    }
  }
}
/** Start descriptor cleanup, but never let an uninterruptible close hide an earlier deadline. */
export async function closeBounded(handle: FileHandle, budget: Budget): Promise<boolean> {
  const closing = handle.close().then(() => true, () => false);
  if (budget.signal?.aborted || Date.now() >= budget.deadline) { void closing; return false; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([closing, new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, budget.deadline - Date.now()));
      abort = () => resolve(false);
      budget.signal?.addEventListener('abort', abort, { once: true });
      if (budget.signal?.aborted) abort();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) budget.signal?.removeEventListener('abort', abort);
  }
}
export function stamp(p: string, s: Stats): Snapshot {
  return { path: p, exists: true, kind: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
}
export function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
export async function snapshot(p: string, budget: Budget, content = false, maxBytes = 1_048_576): Promise<{ snapshot: Snapshot; bytes?: Buffer }> {
  let stat: Stats;
  try { stat = await budget.run(() => fs.lstat(p)); }
  catch (error) { if (missing(error)) return { snapshot: { path: p, exists: false } }; throw error; }
  const initial = stamp(p, stat);
  if (initial.kind === 'symlink') initial.link = await budget.run(() => fs.readlink(p));
  if (!content || initial.kind !== 'file') return { snapshot: initial };
  if (stat.size > maxBytes) throw new LinkError('unsafe-path', 'A required metadata file exceeds the bounded size limit.');
  let handle: FileHandle | undefined;
  // If a read-only open settles after timeout, close it; it cannot become a leaked capability.
  let abandoned = false;
  let failed = false;
  try {
    handle = await budget.run(async () => { const h = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); if (abandoned) { await h.close(); throw new LinkError('timeout', 'The read deadline expired.'); } return h; });
    const opened = stamp(p, await budget.run(() => handle!.stat()));
    if (!equal(initial, opened)) throw new LinkError('stale-preview', 'A metadata file changed while it was opened.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = await budget.run(() => handle!.read(buffer, used, buffer.length - used, used));
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used > maxBytes) throw new LinkError('unsafe-path', 'A required metadata file exceeds the bounded size limit.');
    const after = stamp(p, await budget.run(() => handle!.stat()));
    if (!equal(initial, after)) throw new LinkError('stale-preview', 'A metadata file changed while it was read.');
    const bytes = buffer.subarray(0, used);
    initial.sha256 = hash(bytes);
    return { snapshot: initial, bytes };
  } catch (error) { failed = true; throw error; }
  finally {
    abandoned = true;
    if (handle && !(await closeBounded(handle, budget)) && !failed) throw new LinkError(budget.signal?.aborted ? 'cancelled' : 'timeout', 'Descriptor cleanup is still pending after its read deadline.');
  }
}
export function equal(a: Snapshot, b: Snapshot): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export function identity(a: Snapshot, b: Snapshot): boolean { return a.exists && b.exists && a.dev === b.dev && a.ino === b.ino && a.kind === b.kind && a.mode === b.mode; }
export async function assertSnapshot(expected: Snapshot, budget: Budget, exact = true): Promise<void> {
  const current = (await snapshot(expected.path, budget, expected.sha256 !== undefined)).snapshot;
  if (!(exact ? equal(expected, current) : identity(expected, current))) throw new LinkError('stale-preview', 'A previewed filesystem path changed. Create a fresh preview.');
}
export async function realDirectory(p: string, budget: Budget): Promise<string> {
  const canonical = await budget.run(() => fs.realpath(p));
  const s = (await snapshot(canonical, budget)).snapshot;
  if (s.kind !== 'directory') throw new LinkError('unsafe-path', 'A required path is not a directory.');
  await budget.run(() => fs.access(canonical, constants.R_OK | constants.X_OK));
  return canonical;
}
export function publicError(error: unknown, fallback: NoteLinkFailureCode = 'filesystem-unavailable'): LinkError {
  if (error instanceof LinkError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new LinkError(fallback, code === 'EACCES' || code === 'EPERM' ? 'Permission was denied for a required local path.' : code === 'EEXIST' ? 'A destination appeared concurrently. No existing destination was intentionally overwritten.' : 'A required local filesystem operation failed.');
}
