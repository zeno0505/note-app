/** Promise microtasks can run inside Electron's native before-quit callback.
 * Retry on the next event-loop turn so its cancelled quit has fully unwound.
 * App-owned writes still settle before windows, tray and the process are closed.
 */
export async function finishQuit(pending:readonly Promise<unknown>[],finish:()=>void):Promise<void> {
  await Promise.allSettled(pending);
  await new Promise<void>(resolve=>setImmediate(resolve));
  finish();
}
