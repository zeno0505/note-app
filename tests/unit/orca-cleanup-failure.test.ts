import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createOrcaAdapter } from '../../src/collector/orca';
import { mockExecutable, mode } from '../../fixtures/orca/test-helpers';

vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,readdir:vi.fn(actual.readdir)};
});

it.skipIf(process.platform!=='linux')('fails closed and disables reuse when process-group exit cannot be verified',async()=>{
  const {directory,executablePath}=await mockExecutable();
  const originalKill=process.kill.bind(process);
  try {
    await mode(directory,'descendant-closed-error');
    // Spawn and SIGTERM/SIGKILL remain real. Only verification is made unavailable.
    vi.mocked(readdir).mockRejectedValue(Object.assign(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'),{code:'EACCES'}));
    const killSpy=vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
      if(pid<0&&signal===0) return true;
      return originalKill(pid,signal);
    });
    const adapter=createOrcaAdapter({executablePath,timeoutMs:3000});
    const started=performance.now();
    const result=await adapter.read('status');
    expect(result).toMatchObject({ok:false,error:{kind:'cleanup_unverified'}});
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
    expect(performance.now()-started).toBeLessThan(2500);
    expect(await adapter.read('projects')).toMatchObject({ok:false,error:{kind:'cleanup_unverified'}});
    expect((await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n')).toHaveLength(1);
    expect(killSpy.mock.calls.some(([,signal])=>signal==='SIGKILL')).toBe(true);
  } finally {
    vi.restoreAllMocks();vi.mocked(readdir).mockReset();
    for(const name of ['pid','descendant-pid']) {
      try {originalKill(Number(await readFile(join(directory,name),'utf8')),'SIGKILL');} catch {}
    }
    await rm(directory,{recursive:true,force:true});
  }
});
