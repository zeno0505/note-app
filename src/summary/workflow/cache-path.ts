import * as fs from 'node:fs/promises';
import path from 'node:path';
import { SummaryWorkflowError } from './requests';

const unsafe = (): never => { throw new SummaryWorkflowError('unsafe-cache', 'Summary cache requires a canonical private app-owned directory and file.'); };
/** POSIX private-cache trust is required before restoring any claimed historical approval. */
function privateOwner(stat: { uid: number; mode: number }): void {
  if (process.platform !== 'win32' && (typeof process.geteuid !== 'function' || stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0)) unsafe();
}
/** Called only with host configuration plus a derived scope hash, never a renderer path.
 * Shared ancestors such as /tmp may be shared; only the app root/scope/file must be private.
 */
export async function ensureSummaryCacheDirectory(root: string, scopeId: string, signal: AbortSignal, create = true): Promise<string> {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root || !/^dag-[a-f0-9]{64}$/.test(scopeId)) return unsafe();
  const check = () => { if (signal.aborted) throw new SummaryWorkflowError('cancelled', 'Summary cache operation cancelled.'); };
  async function identity(directory: string): Promise<string> {
    let current = path.parse(directory).root; const identities: string[] = [];
    for (const component of directory.slice(current.length).split(path.sep)) {
      check(); current = path.join(current, component); const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return unsafe();
      if (current === root || current === directory) privateOwner(stat);
      identities.push(`${stat.dev}:${stat.ino}`);
    }
    if (await fs.realpath(directory) !== directory) return unsafe();
    return identities.join('/');
  }
  check(); const before = await identity(root); const directory = path.join(root, scopeId);
  check();
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
  }
  check();
  if (await identity(root) !== before) return unsafe();
  await identity(directory); check();
  try {
    const stat = await fs.lstat(path.join(directory, 'summary-cache-v1.json'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return unsafe();
    privateOwner(stat);
  } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
  check(); return directory;
}

/** Read-only counterpart for the live historical cache projection. Missing scope/file is
 * never created. A missing scope propagates ENOENT; a missing file is left to cache.read(). */
export async function assertPrivateSummaryCachePath(root: string, scopeDirectory: string, signal?: AbortSignal): Promise<void> {
  if (!path.isAbsolute(scopeDirectory) || path.normalize(scopeDirectory) !== scopeDirectory || path.dirname(scopeDirectory) !== root) return unsafe();
  await ensureSummaryCacheDirectory(root, path.basename(scopeDirectory), signal ?? new AbortController().signal, false);
}
