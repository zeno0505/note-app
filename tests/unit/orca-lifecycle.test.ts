import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrcaAdapter } from '../../src/collector/orca';
import { mockExecutable, mode } from '../../fixtures/orca/test-helpers';

const directories: string[] = [];
async function setup(kind: string) {
  const fixture = await mockExecutable(); directories.push(fixture.directory);
  await mode(fixture.directory, kind);
  return fixture;
}
async function waitForDescendant(directory: string): Promise<number> {
  const deadline=Date.now()+2000;
  while(Date.now()<deadline) {
    try {return Number(await readFile(join(directory,'descendant-pid'),'utf8'));}
    catch {await new Promise(resolve=>setTimeout(resolve,10));}
  }
  throw new Error('Synthetic descendant did not become ready.');
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
    const started=performance.now();
    const result=await createOrcaAdapter({executablePath,timeoutMs:2000}).read('status');
    const descendant=await waitForDescendant(directory);
    expect(await isExecuting(descendant)).toBe(false);
    expect(performance.now()-started).toBeLessThan(2000);
    if(errorKind===null) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ok:false,error:{kind:errorKind}});
  });
  it.each(['closed','inherited'])('kills and verifies %s-stdio descendants on timeout',async stdio=>{
    const {directory,executablePath}=await setup(`descendant-${stdio}-hang`);
    const result=await createOrcaAdapter({executablePath,timeoutMs:300}).read('status');
    expect(result).toMatchObject({ok:false,error:{kind:'timeout'}});
    expect(await isExecuting(await waitForDescendant(directory))).toBe(false);
  });
  it.each(['closed','inherited'])('kills and verifies %s-stdio descendants on cancellation',async stdio=>{
    const {directory,executablePath}=await setup(`descendant-${stdio}-hang`);
    const adapter=createOrcaAdapter({executablePath,timeoutMs:3000});
    const controller=new AbortController();
    const pending=adapter.read('status',{signal:controller.signal});
    const descendant=await waitForDescendant(directory);
    controller.abort();
    expect(await adapter.read('projects')).toMatchObject({ok:false,error:{kind:'busy'}});
    expect(await pending).toMatchObject({ok:false,error:{kind:'cancelled'}});
    expect(await isExecuting(descendant)).toBe(false);
    await mode(directory,'normal');
    expect((await adapter.read('status')).ok).toBe(true);
  });
  it('does not kill an unrelated isolated process group',async()=>{
    const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
    const exited=new Promise<void>(resolve=>unrelated.once('close',()=>resolve()));
    try {
      const {directory,executablePath}=await setup('descendant-closed-error');
      expect(await createOrcaAdapter({executablePath}).read('status')).toMatchObject({ok:false,error:{kind:'command_failed'}});
      expect(await isExecuting(await waitForDescendant(directory))).toBe(false);
      expect(unrelated.pid).toBeTypeOf('number');
      expect(await isExecuting(unrelated.pid!)).toBe(true);
    } finally {unrelated.kill('SIGKILL');await exited;}
  });
});
