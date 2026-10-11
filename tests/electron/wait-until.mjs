import {setTimeout as pause} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';

/** Await IPC reads and predicates explicitly; a Promise is never a success signal.
 * The deadline bounds a stalled read too. Errors omit source data for live runs.
 * A timeout does not cancel the underlying read; the caller still owns cleanup.
 */
export async function waitUntil(read, predicate, label, timeoutMs=20000, intervalMs=30) {
  const deadline=performance.now()+timeoutMs;
  let timer;
  const expired=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(`Timed out: ${label}`)),timeoutMs);
  });
  try {
    while(performance.now()<deadline) {
      const value=await Promise.race([Promise.resolve().then(read),expired]);
      const ready=await Promise.race([Promise.resolve().then(()=>predicate(value)),expired]);
      if(ready && performance.now()<deadline)return value;
      await Promise.race([pause(Math.min(intervalMs,Math.max(0,deadline-performance.now()))),expired]);
    }
    throw new Error(`Timed out: ${label}`);
  } finally {clearTimeout(timer);}
}
