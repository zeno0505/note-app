import { afterEach, describe, expect, it } from 'vitest';
import { access, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createOrcaAdapter } from '../../src/collector/orca';
import { mockExecutable, mode, replaceFixture } from '../../fixtures/orca/test-helpers';
import { delayFixtureStartup, gateOperationDeadline, waitForReadyPid } from './helpers/process-startup';

const directories: string[] = [];
async function setup() {
  const test = await mockExecutable(); directories.push(test.directory); return test;
}
async function waitForPid(directory: string): Promise<number> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(join(directory, 'pid'), 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('Synthetic process did not start.');
}
function expectExited(pid: number) { expect(() => process.kill(pid, 0)).toThrow(); }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive:true,force:true}))); });

describe('bounded real-process Orca runner', () => {
  it('executes exactly four fixed argv arrays and joins safe observations', async () => {
    const {directory,executablePath} = await setup();
    const result = await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtimeId).toBe('runtime-synthetic');
    expect(result.value.joined[0]).toMatchObject({key:'["runtime-synthetic","local","instance-synthetic"]',projectMapping:'matched',processMapping:'matched',process:{hasAttachedPty:true,agents:[{state:'done'}]}});
    expect(result.value.projects.coverage.state).toBe('unknown');
    expect(result.value.worktrees.coverage.state).toBe('complete');
    expect(result.value.complete).toBe(false);
    const calls = (await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toEqual([['status','--json'],['project','list','--json'],['worktree','list','--limit','1000','--json'],['worktree','ps','--limit','1000','--json']]);
    expectExited(await waitForPid(directory));
  });
  it.each(['status --json; touch /tmp/not-allowed','__proto__','toString','agent','worktree run',{},null])('never spawns an unsupported query (%j)', async query => {
    const {directory,executablePath} = await setup();
    const result = await createOrcaAdapter({executablePath}).read(query as never);
    expect(result).toMatchObject({ok:false,error:{kind:'forbidden_query'}});
    await expect(access(join(directory,'calls.jsonl'))).rejects.toThrow();
  });
  it.each(['hang','ignore-term'])('times out and waits for a ready child to exit, including %s', async kind => {
    const {directory,executablePath} = await setup(); await mode(directory,kind);
    await delayFixtureStartup(executablePath, directory, 300);
    const deadline = gateOperationDeadline(200), controller = new AbortController();
    const pending = createOrcaAdapter({executablePath,timeoutMs:200}).read('status', { signal: controller.signal });
    try {
      const pid = await waitForReadyPid(directory);
      const started = performance.now(); deadline.start();
      expect(await pending).toMatchObject({ok:false,error:{kind:'timeout'}});
      expect(performance.now() - started).toBeGreaterThanOrEqual(190);
      expectExited(pid);
    } finally { deadline.dispose(); controller.abort(); await pending; }
  }, 10_000);
  it('keeps the real operation deadline bounded even before a slow fixture is ready', async () => {
    const {directory,executablePath} = await setup(); await mode(directory, 'hang');
    await delayFixtureStartup(executablePath, directory, 1000);
    expect(await createOrcaAdapter({executablePath,timeoutMs:20}).read('status')).toMatchObject({ok:false,error:{kind:'timeout'}});
    await expect(access(join(directory, 'ready'))).rejects.toThrow();
  });
  it('cancels an active process and blocks overlapping reads/collections until exit', async () => {
    const {directory,executablePath} = await setup(); await mode(directory,'ignore-term');
    const adapter = createOrcaAdapter({executablePath,timeoutMs:3000});
    const controller = new AbortController();
    const pending = adapter.collect({signal:controller.signal});
    const pid = await waitForPid(directory);
    expect(await adapter.read('projects')).toMatchObject({ok:false,error:{kind:'busy'}});
    expect(await adapter.collect()).toMatchObject({ok:false,error:{kind:'busy'}});
    controller.abort();
    expect(await pending).toMatchObject({ok:false,error:{kind:'cancelled'}});
    expectExited(pid);
    await mode(directory,'normal');
    expect((await adapter.read('status')).ok).toBe(true);
  });
  it('does not spawn when already cancelled', async () => {
    const {directory,executablePath} = await setup();
    const controller = new AbortController(); controller.abort();
    expect(await createOrcaAdapter({executablePath}).read('status',{signal:controller.signal})).toMatchObject({ok:false,error:{kind:'cancelled'}});
    await expect(access(join(directory,'calls.jsonl'))).rejects.toThrow();
  });
  it.each(['overflow','stderr-overflow'])('caps combined output without retaining %s', async kind => {
    const {directory,executablePath} = await setup(); await mode(directory,kind);
    const result = await createOrcaAdapter({executablePath,maxOutputBytes:1024}).read('status');
    expect(result).toMatchObject({ok:false,error:{kind:'output_limit'}});
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_DISCARDED_OUTPUT');
    expectExited(await waitForPid(directory));
  });
  it.each([['denied','access_denied'],['nonzero','command_failed'],['invalid-json','invalid_json'],['invalid-utf8','invalid_json']])('returns safe %s failure rather than empty success', async (kind,errorKind) => {
    const {directory,executablePath} = await setup(); await mode(directory,kind);
    const result = await createOrcaAdapter({executablePath}).read('status');
    expect(result).toMatchObject({ok:false,error:{kind:errorKind}});
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ERROR_BODY_MUST_NOT_ESCAPE');
  });
  it('discards synthetic private payloads from every source after real execution', async () => {
    const {directory,executablePath} = await setup();
    for (const query of ['status','projects','worktrees','processes'] as const) await replaceFixture(directory,query,value => {
      value.prompt='SYNTHETIC_PRIVATE_CANARY';value.result.preview='SYNTHETIC_PRIVATE_CANARY';
      if(query==='projects') value.result.projects[0].lastAssistantMessage='SYNTHETIC_PRIVATE_CANARY';
      if(query==='worktrees'||query==='processes') value.result.worktrees[0].toolInput={body:'SYNTHETIC_PRIVATE_CANARY'};
      if(query==='processes') {value.result.worktrees[0].agents[0].toolName='SYNTHETIC_PRIVATE_CANARY';value.result.worktrees[0].agents[0].taskTitle='SYNTHETIC_PRIVATE_CANARY';}
    });
    const result=await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_CANARY');
    expect(JSON.stringify(result)).not.toContain('taskTitle');
  });
  it('sanitizes malformed response diagnostics after actual process execution', async () => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory,'worktrees',value => {value.result.worktrees[0].isArchived = 'SYNTHETIC_PRIVATE_CANARY';});
    const result = await createOrcaAdapter({executablePath}).read('worktrees');
    expect(result).toMatchObject({ok:false,error:{kind:'invalid_schema'}});
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_CANARY');
  });
  it('reports unavailable executable and OS access denial explicitly', async () => {
    const {directory,executablePath} = await setup();
    expect(await createOrcaAdapter({executablePath:join(directory,'does-not-exist')}).read('status')).toMatchObject({ok:false,error:{kind:'unavailable'}});
    await chmod(executablePath,0o600);
    expect(await createOrcaAdapter({executablePath}).read('status')).toMatchObject({ok:false,error:{kind:'access_denied'}});
  });
  it('rejects unsafe configuration instead of creating a generic shell API', () => {
    expect(() => createOrcaAdapter({executablePath:'node mock.cjs'})).toThrow('trusted absolute path');
    expect(() => createOrcaAdapter({executablePath:'/tmp/bad\nname'})).toThrow('trusted absolute path');
    for (const options of [{timeoutMs:0},{timeoutMs:Infinity},{timeoutMs:60_001},{maxOutputBytes:0},{maxOutputBytes:8*1024*1024+1}]) expect(() => createOrcaAdapter(options)).toThrow('limit');
  });
});

describe('runtime and logical join boundaries through the same executable', () => {
  it.each(['projects','worktrees','processes'] as const)('rejects runtime restart at %s and does not mix observations', async query => {
    const {directory,executablePath} = await setup(); await mode(directory,'runtime-change',query);
    expect(await createOrcaAdapter({executablePath}).collect()).toMatchObject({ok:false,error:{kind:'runtime_changed',query}});
  });
  it('collects and joins a detached worktree with an explicitly absent project', async () => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory, 'worktrees', value => {
      value.result.worktrees[0].branch = '';
      value.result.worktrees[0].projectId = null;
    });
    const result = await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.joined[0]).toMatchObject({
      worktree: { branch: null, projectId: null }, project: null,
      projectMapping: 'missing-project-id', processMapping: 'matched',
    });
    const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual(['worktree', 'ps', '--limit', '1000', '--json']);
  });
  it('preserves observed partial rows and host omissions', async () => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory,'worktrees',value => {value.result.truncated = true; value.result.totalCount = 5; value.result.hostScope.omittedHostIds = ['remote-omitted'];});
    const result = await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.joined).toHaveLength(1);
      expect(result.value.complete).toBe(false);
      expect(result.value.worktrees.coverage).toMatchObject({state:'partial',totalCount:5,truncated:true,omittedHostIds:['remote-omitted']});
    }
  });
  it('observes a normal complete empty worktree list without inventing completeness for project pagination', async () => {
    const {directory,executablePath} = await setup();
    for (const query of ['worktrees','processes'] as const) await replaceFixture(directory,query,value => {value.result.worktrees=[];value.result.totalCount=0;});
    await replaceFixture(directory,'projects',value => {value.result.projects=[];});
    const result = await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.joined).toEqual([]);
      expect(result.value.worktrees.coverage).toMatchObject({state:'complete',returnedCount:0,totalCount:0});
      expect(result.value.projects.coverage.state).toBe('unknown');
    }
  });
  it('never matches equal instance/worktree IDs across different hosts', async () => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory,'processes',value => {value.result.worktrees[0].hostId='remote-synthetic';value.result.hostScope.hostIds=['remote-synthetic'];});
    const result = await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.joined[0]).toMatchObject({process:null,processMapping:'not-observed'});
      expect(result.value.unmatchedProcesses).toHaveLength(1);
    }
  });
  it('matches same instance IDs independently on separate hosts', async () => {
    const {directory,executablePath} = await setup();
    for (const query of ['worktrees','processes'] as const) await replaceFixture(directory,query,value => {
      const duplicate=structuredClone(value.result.worktrees[0]); duplicate.hostId='remote-synthetic';
      if(duplicate.identity) duplicate.identity.executionHostId='remote-synthetic';
      value.result.worktrees.push(duplicate);value.result.totalCount=2;value.result.hostScope.hostIds.push('remote-synthetic');
    });
    const result = await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.joined.map(row => row.processMapping)).toEqual(['matched','matched']);
      expect(new Set(result.value.joined.map(row => row.key)).size).toBe(2);
    }
  });
  it('does not infer missing project IDs from matching repositories, or instance IDs from paths', async () => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory,'worktrees',value => {delete value.result.worktrees[0].projectId;delete value.result.worktrees[0].instanceId;delete value.result.worktrees[0].identity;});
    const result = await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.joined[0]).toMatchObject({key:null,project:null,projectMapping:'missing-project-id',process:null,processMapping:'identity-unavailable'});
  });
  it('marks a supplied but unobserved project ID explicitly', async () => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory,'projects',value => {value.result.projects=[];});
    const result=await createOrcaAdapter({executablePath}).collect();
    expect(result.ok).toBe(true);
    if(result.ok) expect(result.value.joined[0].projectMapping).toBe('project-not-observed');
  });
  it.each(['worktrees','processes'] as const)('rejects ambiguous stable %s identity instead of deduplicating arbitrarily', async query => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory,query,value => {value.result.worktrees.push(value.result.worktrees[0]);value.result.totalCount=2;});
    expect(await createOrcaAdapter({executablePath}).collect()).toMatchObject({ok:false,error:{kind:'ambiguous_identity'}});
  });
  it('rejects contradictory source IDs for a matched host/instance', async () => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory,'processes',value => {value.result.worktrees[0].worktreeId='different-id';});
    expect(await createOrcaAdapter({executablePath}).collect()).toMatchObject({ok:false,error:{kind:'ambiguous_identity'}});
  });
  it('does not swallow one failed source after previous success', async () => {
    const {directory,executablePath} = await setup(); const adapter=createOrcaAdapter({executablePath});
    expect((await adapter.collect()).ok).toBe(true);
    await mode(directory,'denied','processes');
    const result=await adapter.collect();
    expect(result).toMatchObject({ok:false,error:{kind:'access_denied',query:'processes'}});
    expect(result).not.toHaveProperty('value');
  });
  it.each(['stopped','unreachable','unknown','missing-id'])('does not present %s runtime as successful live observation', async kind => {
    const {directory,executablePath} = await setup();
    await replaceFixture(directory,'status',value => {
      if(kind==='stopped') value.result.app.running=false;
      if(kind==='unreachable') value.result.runtime.reachable=false;
      if(kind==='unknown') value.result.runtime.state='new-state';
      if(kind==='missing-id') {delete value._meta;delete value.result.runtime.runtimeId;}
    });
    expect(await createOrcaAdapter({executablePath}).collect()).toMatchObject({ok:false,error:{kind:kind==='missing-id'?'runtime_unidentified':'unavailable'}});
    const calls=(await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n');
    expect(calls).toHaveLength(1);
  });
});
