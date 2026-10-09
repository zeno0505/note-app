import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { vi } from 'vitest';

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

export async function waitForReadyPid(directory: string): Promise<number> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      const pid = Number(await readFile(join(directory, 'ready'), 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch { /* The fixture may still be starting. */ }
    await pause(10);
  }
  throw new Error('Synthetic process did not become ready.');
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
