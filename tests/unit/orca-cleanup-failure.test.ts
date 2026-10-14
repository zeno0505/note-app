import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createOrcaAdapter } from '../../src/collector/orca';
import { mockExecutable, mode } from '../../fixtures/orca/test-helpers';
import { gateOperationDeadline, waitForReadyPid } from './helpers/process-startup';

vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,readdir:vi.fn(actual.readdir)};
});

it.skipIf(process.platform!=='linux')('fails closed and disables reuse when process-group exit cannot be verified',async()=>{
  const {directory,executablePath}=await mockExecutable();
  const originalKill=process.kill.bind(process);
  const controller=new AbortController();
  await mode(directory,'descendant-closed-error');
  await writeFile(join(directory,'startup.json'),JSON.stringify({rootDelayMs:300,descendantDelayMs:300,waitForRelease:true}));
  const deadline=gateOperationDeadline(3000);
  const adapter=createOrcaAdapter({executablePath,timeoutMs:3000});
  const pending=adapter.read('status',{signal:controller.signal});
  try {
    await waitForReadyPid(directory);
    await waitForReadyPid(directory,'descendant-pid');
    // Spawn and SIGTERM/SIGKILL remain real. Only verification is made unavailable.
    vi.mocked(readdir).mockRejectedValue(Object.assign(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'),{code:'EACCES'}));
    const killSpy=vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
      if(pid<0&&signal===0) return true;
      return originalKill(pid,signal);
    });
    const started=performance.now();deadline.start();
    await writeFile(join(directory,'release'),'continue');
    const result=await pending;
    expect(result).toMatchObject({ok:false,error:{kind:'cleanup_unverified'}});
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
    expect(performance.now()-started).toBeLessThan(2500);
    expect(await adapter.read('projects')).toMatchObject({ok:false,error:{kind:'cleanup_unverified'}});
    expect((await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n')).toHaveLength(1);
    expect(killSpy.mock.calls.some(([,signal])=>signal==='SIGKILL')).toBe(true);
  } finally {
    vi.restoreAllMocks();
    const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readdir).mockReset().mockImplementation(actual.readdir);
    deadline.dispose();controller.abort();await pending;
    for(const name of ['pid','descendant-pid']) {
      try {originalKill(Number(await readFile(join(directory,name),'utf8')),'SIGKILL');} catch {}
    }
    await rm(directory,{recursive:true,force:true});
  }
},10_000);
