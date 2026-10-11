import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrcaAdapter } from '../../src/collector/orca';
import { mockExecutable, mode } from '../../fixtures/orca/test-helpers';
import { gateOperationDeadline, waitForReadyPid } from './helpers/process-startup';

const directories: string[] = [];
async function setup(kind: string, descendantDelayMs = 300) {
  const fixture = await mockExecutable(); directories.push(fixture.directory);
  await mode(fixture.directory, kind);
  await writeFile(join(fixture.directory, 'startup.json'), JSON.stringify({
    rootDelayMs: 300, descendantDelayMs, waitForRelease: true,
  }));
  return fixture;
}
async function isExecuting(pid: number): Promise<boolean> {
  try {
    const stat=await readFile(`/proc/${pid}/stat`,'utf8');
    const state=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0];
    return state!=='Z'&&state!=='X';
  } catch(error) {
    if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??'')) return false;
    throw error;
  }
}
afterEach(async()=>{
  for(const directory of directories.splice(0)) {
    // Ensure a failed assertion cannot leak its intentionally long-running fixture.
    for(const name of ['pid','descendant-pid']) {
      try {const pid=Number(await readFile(join(directory,name),'utf8'));if(await isExecuting(pid)) process.kill(pid,'SIGKILL');} catch {}
    }
    await rm(directory,{recursive:true,force:true});
  }
});

describe.skipIf(process.platform!=='linux')('owned query process group lifecycle (actual Linux subprocesses)',()=>{
  it.each([
    ['closed','success',null],['inherited','success',null],
    ['closed','error','command_failed'],['inherited','error','command_failed'],
    ['closed','invalid','invalid_json'],['inherited','invalid','invalid_json'],
  ] as const)('finalizes %s-stdio descendants on root %s before returning',async(stdio,outcome,errorKind)=>{
    const {directory,executablePath}=await setup(`descendant-${stdio}-${outcome}`);
    const deadline=gateOperationDeadline(2000),controller=new AbortController();
    const pending=createOrcaAdapter({executablePath,timeoutMs:2000}).read('status',{signal:controller.signal});
    try {
      const root=await waitForReadyPid(directory);
      const descendant=await waitForReadyPid(directory,'descendant-pid');
      expect(await isExecuting(root)).toBe(true);
      expect(await isExecuting(descendant)).toBe(true);
      const started=performance.now();deadline.start();
      await writeFile(join(directory,'release'),'continue');
      const result=await pending;
      expect(await isExecuting(root)).toBe(false);
      expect(await isExecuting(descendant)).toBe(false);
      expect(performance.now()-started).toBeLessThan(2000);
      if(errorKind===null) expect(result.ok).toBe(true);
      else expect(result).toMatchObject({ok:false,error:{kind:errorKind}});
    } finally {deadline.dispose();controller.abort();await pending;}
  },10_000);
  it.each(['closed','inherited'])('kills and verifies %s-stdio descendants on timeout',async stdio=>{
    // The closed-stdio case exceeds the removed fixture-side 1.5 s readiness cap.
    const {directory,executablePath}=await setup(`descendant-${stdio}-hang`,stdio==='closed'?2300:300);
    const deadline=gateOperationDeadline(300),controller=new AbortController();
    const pending=createOrcaAdapter({executablePath,timeoutMs:300}).read('status',{signal:controller.signal});
    try {
      const root=await waitForReadyPid(directory);
      const descendant=await waitForReadyPid(directory,'descendant-pid');
      expect(await isExecuting(descendant)).toBe(true);
      const started=performance.now();deadline.start();
      expect(await pending).toMatchObject({ok:false,error:{kind:'timeout'}});
      expect(performance.now()-started).toBeGreaterThanOrEqual(290);
      expect(await isExecuting(root)).toBe(false);
      expect(await isExecuting(descendant)).toBe(false);
    } finally {deadline.dispose();controller.abort();await pending;}
  },10_000);
  it.each(['closed','inherited'])('kills and verifies %s-stdio descendants on cancellation',async stdio=>{
    const {directory,executablePath}=await setup(`descendant-${stdio}-hang`);
    const deadline=gateOperationDeadline(3000);
    const adapter=createOrcaAdapter({executablePath,timeoutMs:3000});
    const controller=new AbortController();
    const pending=adapter.read('status',{signal:controller.signal});
    try {
      const root=await waitForReadyPid(directory);
      const descendant=await waitForReadyPid(directory,'descendant-pid');deadline.start();
      controller.abort();
      expect(await adapter.read('projects')).toMatchObject({ok:false,error:{kind:'busy'}});
      expect(await pending).toMatchObject({ok:false,error:{kind:'cancelled'}});
      expect(await isExecuting(root)).toBe(false);
      expect(await isExecuting(descendant)).toBe(false);
      await mode(directory,'normal');
      expect((await adapter.read('status')).ok).toBe(true);
    } finally {deadline.dispose();controller.abort();await pending;}
  },10_000);
  it('does not kill an unrelated isolated process group',async()=>{
    const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
    const exited=new Promise<void>(resolve=>unrelated.once('close',()=>resolve()));
    try {
      const {directory,executablePath}=await setup('descendant-closed-error');
      const deadline=gateOperationDeadline(2000),controller=new AbortController();
      const pending=createOrcaAdapter({executablePath,timeoutMs:2000}).read('status',{signal:controller.signal});
      try {
        await waitForReadyPid(directory);deadline.start();
        const descendant=await waitForReadyPid(directory,'descendant-pid');
        await writeFile(join(directory,'release'),'continue');
        expect(await pending).toMatchObject({ok:false,error:{kind:'command_failed'}});
        expect(await isExecuting(descendant)).toBe(false);
        expect(unrelated.pid).toBeTypeOf('number');
        expect(await isExecuting(unrelated.pid!)).toBe(true);
      } finally {deadline.dispose();controller.abort();await pending;}
    } finally {unrelated.kill('SIGKILL');await exited;}
  },10_000);
});
