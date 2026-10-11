import {describe,it,expect,vi} from 'vitest';
import {finishQuit} from '../../src/main/quit-lifecycle';

describe('native quit settlement',()=>{
 it('does not retry inside a native before-quit callback microtask checkpoint',async()=>{
  let insideNativeCallback=true;const retry=vi.fn(()=>expect(insideNativeCallback).toBe(false));
  const pending=finishQuit([],retry);
  // Electron may drain microtasks before resetting its cancelled native quit flag.
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(retry).not.toHaveBeenCalled();insideNativeCallback=false;
  await pending;expect(retry).toHaveBeenCalledTimes(1);
 });
 it('retains app-owned writes until every pending mutation settles',async()=>{
  let commit!:()=>void;let committed=false;
  const write=new Promise<void>(resolve=>{commit=()=>{committed=true;resolve();};});
  const retry=vi.fn(()=>expect(committed).toBe(true));
  const pending=finishQuit([write,Promise.reject(new Error('other mutation failed'))],retry);
  await new Promise<void>(resolve=>setImmediate(resolve));expect(retry).not.toHaveBeenCalled();
  commit();await pending;expect(retry).toHaveBeenCalledTimes(1);
 });
 it('preserves a final cleanup error for the caller',async()=>{
  await expect(finishQuit([],()=>{throw new Error('cleanup failed');})).rejects.toThrow('cleanup failed');
 });
});
