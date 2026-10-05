import type { ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const GRACE_MS = 100;
const CLEANUP_MS = 1000;
type GroupState = 'gone' | 'snapshot-quiescent' | 'live' | 'unknown';
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Only signal the isolated group created by this query, never discovered arbitrary PIDs. */
function signalOwnedGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* Missing/forbidden group is assessed separately; no raw OS diagnostic escapes. */ }
}
async function groupState(child: ChildProcess): Promise<GroupState> {
  if (!child.pid) return 'gone'; // spawn failed before a process existed
  if (process.platform === 'win32') return child.exitCode !== null || child.signalCode !== null ? 'gone' : 'live';
  try { process.kill(-child.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'; }
  if (process.platform !== 'linux') return 'live';
  // Orphan zombies may never be promptly reaped by a container's PID 1. They cannot
  // execute or fork. Only inspect process state/group/session, never cmdline/environ.
  let entries: string[];
  try { entries = await readdir('/proc'); } catch { return 'unknown'; }
  let unknown = false;
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      if (end < 0 || fields.length < 4) { unknown = true; continue; }
      const [state, , group, session] = fields;
      if (Number(group) === child.pid && Number(session) === child.pid && state !== 'Z' && state !== 'X') return 'live';
    } catch (error) {
      // A process vanishing during the snapshot is normal. An inaccessible process
      // might belong to us, so lack of visibility must not become false proof.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') unknown = true;
    }
  }
  return unknown ? 'unknown' : 'snapshot-quiescent';
}

/**
 * Terminate and verify no executing members remain in the query's owned group.
 * Escaped/new-session daemons are not tracked. Windows covers the direct child only.
 * A false result is fail-closed and must prevent reuse of the runner.
 */
export async function finalizeQueryGroup(child: ChildProcess): Promise<boolean> {
  const started = performance.now();
  signalOwnedGroup(child, 'SIGTERM');
  let hardKilled = false;
  while (performance.now() - started < CLEANUP_MS) {
    if (!hardKilled && performance.now() - started >= GRACE_MS) {
      signalOwnedGroup(child, 'SIGKILL'); hardKilled = true;
    }
    // Bound procfs observation too: never let a slow/inaccessible scan hang cleanup.
    const state = await Promise.race([groupState(child), pause(100).then((): GroupState => 'unknown')]);
    if (state === 'gone') return true;
    if (state === 'snapshot-quiescent') {
      // Procfs is not an atomic snapshot: a listed process can fork and disappear
      // before its stat read. Never accept this observation before hard-killing
      // the owned group, then observing it again on a later pass.
      if (hardKilled) return true;
      signalOwnedGroup(child, 'SIGKILL'); hardKilled = true;
    }
    await pause(10);
  }
  signalOwnedGroup(child, 'SIGKILL');
  return false;
}
