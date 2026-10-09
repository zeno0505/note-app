import {describe,it,expect} from 'vitest';
import {waitUntil} from '../electron/wait-until.mjs';

describe('Electron IPC wait contract',()=>{
  it('does not treat an async false predicate as success',async()=>{
    let reads=0;
    await expect(waitUntil(async()=>++reads,async()=>false,'false IPC',80,10)).rejects.toThrow('Timed out: false IPC');
    expect(reads).toBeGreaterThan(1);
  });
  it('waits for the actual response and condition',async()=>{
    let reads=0;
    const value=await waitUntil(async()=>({ready:++reads>=3}),async value=>value.ready,'ready',500,10);
    expect(value.ready).toBe(true);expect(reads).toBe(3);
  });
  it('bounds a stalled IPC read and omits its source data',async()=>{
    await expect(waitUntil(()=>new Promise(()=>{}),Boolean,'stalled IPC',50)).rejects.toThrow('Timed out: stalled IPC');
  });
  it('propagates read failure rather than silently retrying it',async()=>{
    await expect(waitUntil(async()=>{throw Error('IPC failed');},Boolean,'read')).rejects.toThrow('IPC failed');
  });
});
