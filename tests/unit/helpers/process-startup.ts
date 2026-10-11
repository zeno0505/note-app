import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { vi } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import type { ChildProcess } from 'node:child_process';

/** Synthetic executables only: make slow startup reproducible and mark readiness
 * after their signal handlers/body have been installed, rather than merely PID creation. */
export async function delayFixtureStartup(executable: string, directory: string, milliseconds: number): Promise<void> {
  const source = await readFile(executable, 'utf8');
  const shebangEnd = source.indexOf('\n');
  if (!source.startsWith('#!') || shebangEnd < 0) throw new Error('Expected a synthetic executable with a shebang.');
  const delay = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${milliseconds});\n`;
  const ready = `\nrequire('node:fs').writeFileSync(${JSON.stringify(join(directory, 'ready'))}, String(process.pid));\n`;
  await writeFile(executable, source.slice(0, shebangEnd + 1) + delay + source.slice(shebangEnd + 1) + ready);
}

export async function waitForReadyPid(directory: string, name = 'ready'): Promise<number> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid readiness marker name.');
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      const pid = Number(await readFile(join(directory, name), 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await pause(10);
  }
  throw new Error('Synthetic process did not become ready.');
}

/** Observe an owned, directly-parented fixture exiting; never signal an arbitrary PID. */
export async function waitForFixtureExit(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid fixture PID.');
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await pause(10);
  }
  throw new Error('Synthetic process did not exit.');
}

/** Passive observation only. ChildProcess construction is published before its
 * spawnfile/PID exists, so register close first and match the executable later. */
export function observeFixtureChildren(executable: string) {
  const observed: {child: ChildProcess; closed: Promise<void>}[] = [];
  const events = channel('child_process');
  const observe = (message: unknown) => {
    const child = (message as {process: ChildProcess}).process;
    observed.push({child, closed: new Promise(resolve => child.once('close', () => resolve()))});
  };
  events.subscribe(observe);
  return {
    async settle() {
      events.unsubscribe(observe);
      const owned = observed.filter(({child}) => child.spawnfile === executable);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(owned.map(({closed}) => closed)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture close was not observed.')), 5000); }),
        ]);
        return owned.length;
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}

/** Test-only clock gate for the next exact operation deadline. Startup is given
 * its own readiness budget. Once ready, refresh the same native timer so real
 * timeout and real SIGTERM/SIGKILL cleanup are tested without a Node-startup race.
 * Separate ungated tests verify that production deadlines still include startup. */
export function gateOperationDeadline(milliseconds: number) {
  const nativeTimeout = globalThis.setTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay !== milliseconds) return nativeTimeout(callback, delay, ...args);
    spy.mockRestore();
    timer = nativeTimeout(() => { if (ready) callback(...args); }, delay);
    return timer;
  });
  return {
    start() {
      if (!timer || ready) throw new Error('Expected one operation deadline before readiness.');
      ready = true;
      timer.refresh();
    },
    dispose() { spy.mockRestore(); if (timer) clearTimeout(timer); },
  };
}
