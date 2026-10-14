import {afterEach,describe,expect,it,vi} from 'vitest';
import {refreshAfterProjectPicker} from '../../src/main/project-creation-refresh';
import {PROJECT_DAG_LIMITS} from '../../src/shared/project-dag';
afterEach(()=>vi.useRealTimers());
const stale={state:'unavailable' as const,reason:'stale' as const};
describe('post-native-picker observation refresh',()=>{
 it('does not start an unrelated full collection when the current selection is ready',async()=>{
  const refresh=vi.fn(async()=>{});await refreshAfterProjectPicker({state:'ready',reason:null},refresh,new AbortController().signal);expect(refresh).not.toHaveBeenCalled();
 });
 it('does not reconnect a disconnected source or repair other unavailable states',async()=>{
  const refresh=vi.fn(async()=>{});for(const reason of ['disconnected','unavailable'] as const)await refreshAfterProjectPicker({state:'unavailable',reason},refresh,new AbortController().signal);expect(refresh).not.toHaveBeenCalled();
 });
 it('joins an existing refresh rather than accepting its prior snapshot',async()=>{
  const refresh=vi.fn(async()=>{});await refreshAfterProjectPicker({state:'unavailable',reason:'refreshing'},refresh,new AbortController().signal);expect(refresh).toHaveBeenCalledTimes(1);
 });
 it('awaits one fresh read before source revalidation may continue',async()=>{
  let complete!:()=>void;const refresh=vi.fn(()=>new Promise<void>(resolve=>complete=resolve));let finished=false;
  const pending=refreshAfterProjectPicker(stale,refresh,new AbortController().signal).then(()=>finished=true);
  await Promise.resolve();expect(refresh).toHaveBeenCalledTimes(1);expect(finished).toBe(false);complete();await pending;expect(finished).toBe(true);
 });
 it('does not refresh for an already cancelled workflow',async()=>{
  const c=new AbortController();c.abort();const refresh=vi.fn(async()=>{});
  await expect(refreshAfterProjectPicker(stale,refresh,c.signal)).rejects.toMatchObject({reason:'cancelled'});expect(refresh).not.toHaveBeenCalled();
 });
 it('aborts the wait without claiming the coalesced runtime read was cancelled',async()=>{
  const c=new AbortController();let settle!:()=>void;const operation=new Promise<void>(resolve=>settle=resolve);
  const pending=refreshAfterProjectPicker(stale,()=>operation,c.signal);await Promise.resolve();c.abort();await expect(pending).rejects.toMatchObject({reason:'cancelled'});settle();await operation;
 });
 it('bounds only the refresh wait and safely observes late rejection',async()=>{
  vi.useFakeTimers();let reject!:(error:Error)=>void;const refresh=()=>new Promise((_,r)=>reject=r);
  const pending=refreshAfterProjectPicker(stale,refresh,new AbortController().signal);const assertion=expect(pending).rejects.toMatchObject({reason:'timeout'});
  await vi.advanceTimersByTimeAsync(PROJECT_DAG_LIMITS.timeoutMs);await assertion;reject(new Error('late runtime failure'));await Promise.resolve();
 });
 it('keeps refresh failures fail-closed',async()=>{
  await expect(refreshAfterProjectPicker(stale,async()=>{throw Error('private source failure');},new AbortController().signal)).rejects.toMatchObject({reason:'source_changed'});
 });
});
