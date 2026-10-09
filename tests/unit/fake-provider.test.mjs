import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {access,readFile} from 'node:fs/promises';
import {runFakeProvider} from '../helpers/fake-provider-runner.mjs';
import preview from '../../fixtures/summary-quality/public-one-shot-preview.json' with {type:'json'};
const base={requestId:'request-public-preview',input:preview.exactInput,deadlineMs:2000};
async function running(pid){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return false;throw e;}if(process.platform==='linux'){try{if((await readFile(`/proc/${pid}/stat`,'utf8')).split(' ')[2]==='Z')return false;}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return false;throw e;}}return true;}
describe.runIf(['darwin','linux'].includes(process.platform))('new test-only fake provider process evidence, never a model runner',()=>{
 it('passes the exact bounded preview with fixed argv, an empty owned cwd and no inherited configuration env',async()=>{
  const result=await runFakeProvider(base);expect(result.status).toBe('fake-complete');expect(result.modelRun).toBe(false);
  const body=JSON.parse(result.body);expect(body.inputSha256).toBe(preview.exactInputSha256);expect(body.argv).toEqual([]);
  expect(body.envKeys.filter(k=>k!=='__CF_USER_TEXT_ENCODING')).toEqual(['NOTE_APP_FAKE_MODE']);
  expect(result.plan).toMatchObject({executableKind:'current-node',environmentKeys:['NOTE_APP_FAKE_MODE'],cwdKind:'owned-empty-temporary-directory'});
  expect(await running(result.pid)).toBe(false);await expect(access(body.cwd)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('rejects another request frame and output/stderr floods; process exit alone is not completion',async()=>{
  for(const [mode,status] of [['wrong-request','invalid-frame'],['oversize','output-budget'],['stderr','stderr-budget']]){
   const result=await runFakeProvider({...base,mode});expect(result.status).toBe(status);expect(result.modelRun).toBe(false);if(result.pid)expect(await running(result.pid)).toBe(false);
  }
 });
 it('enforces a local deadline and pre-aborted cancellation without spawning',async()=>{
  const result=await runFakeProvider({...base,mode:'stall',deadlineMs:200});expect(result.status).toBe('deadline');expect(await running(result.pid)).toBe(false);
  const signal=AbortSignal.abort();expect(await runFakeProvider({...base,signal})).toMatchObject({status:'cancelled',spawned:false});
 });
 it('cancels only the test-owned process group during a pending request',async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),200);
  try{const result=await runFakeProvider({...base,mode:'stall',signal:controller.signal});expect(result.status).toBe('cancelled');expect(await running(result.pid)).toBe(false);}finally{clearTimeout(timer);}
 });
 it('cleans a fixture descendant even after the fixture parent has exited',async()=>{
  const result=await runFakeProvider({...base,mode:'descendant'});expect(result.status).toBe('fake-complete');const pid=JSON.parse(result.body).ownedDescendantPid;
  const deadline=Date.now()+3000;while(await running(pid)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));expect(await running(pid)).toBe(false);
 });
 it('does not expose arbitrary executable/model/mode routes and bounds input before spawning',async()=>{
  await expect(runFakeProvider({...base,mode:'claude'})).rejects.toThrow(/Invalid fake/);
  await expect(runFakeProvider({...base,input:'가'.repeat(6000)})).rejects.toThrow(/Input budget/);
  expect(createHash('sha256').update(base.input).digest('hex')).toBe(preview.exactInputSha256);
 });
});
