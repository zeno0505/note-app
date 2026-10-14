import {describe,it,expect} from 'vitest';
import {assertTrackedProcessesExit} from '../electron/evidence.mjs';
describe('owned Electron cleanup evidence',()=>{
 it('reports already-exited and nonexecuting zombies separately',async()=>{
  expect(await assertTrackedProcessesExit([11,12,12],0,async pid=>pid===11?'exited':'zombie')).toEqual({executing:0,exitedPids:[11],zombiePids:[12]});
 });
 it('never treats an executing child as exited',async()=>{
  await expect(assertTrackedProcessesExit([11],0,async()=> 'executing')).rejects.toThrow('remained alive: 11');
 });
 it('does not turn failed process inspection into success',async()=>{
  await expect(assertTrackedProcessesExit([11],0,async()=>{throw Error('unavailable');})).rejects.toThrow('unavailable');
 });
});
