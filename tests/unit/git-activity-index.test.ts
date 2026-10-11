import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLocalSummaryCache,type SummaryCacheRecord} from '../../src/summary/storage';
import {
  createGitActivityIndex,gitActivityDeclaredSetHash,gitActivityIndexCodec,GIT_ACTIVITY_INDEX_LIMITS,
  type GitActivityIndexInput,type GitActivityIndexPayload,type GitActivityIndexPersistence,
} from '../../src/main/git-activity-index';
import {GIT_ACTIVITY_RESOLVER_CONTRACT,type GitActivityReference} from '../../src/summary/reading/git-activity-metadata';

const roots:string[]=[];
afterEach(async()=>{vi.useRealTimers();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const sha=(number:number)=>number.toString(16).padStart(40,'0');
const refs=(count:number)=>Array.from({length:count},(_,index)=>sha(index+1));
const input=(declaredReferences:readonly string[]=refs(1),patch:Partial<GitActivityIndexInput>={}):GitActivityIndexInput=>({
  projectId:'synthetic-project',authorityKey:'worktree-1/gitdir-2/common-3/grant-revision-1',objectRevision:'objects-1',declaredReferences,...patch,
});
const resolved=(declaredReference:string,fullSha=declaredReference.toLowerCase()):GitActivityReference=>({
  declaredReference,status:'resolved',fullSha,at:'2026-10-09T10:00:00.000Z',
});
const resolveAll=vi.fn(async(_projectId:string,references:readonly string[])=>references.map(ref=>resolved(ref)));
function memory(initial:SummaryCacheRecord<GitActivityIndexPayload>|null=null) {
  let record=structuredClone(initial);
  const storage:GitActivityIndexPersistence={
    read:vi.fn(async(signal)=>{if(signal?.aborted)throw Error('Cancelled');return structuredClone(record);}),
    write:vi.fn(async(payload,revision,signal)=>{
      if(signal?.aborted)throw Error('Cancelled');
      if(revision!==(record?.revision??null))throw Error('Conflict');
      record={revision:(revision??0)+1,payload:gitActivityIndexCodec.parse(payload)};
      return structuredClone(record);
    }),
  };
  return {storage,get record(){return structuredClone(record);},set record(value){record=structuredClone(value);}};
}
function service(state=memory(),resolveBatch=resolveAll,validateAuthority=vi.fn(()=>true)) {
  return {state,resolveBatch,validateAuthority,index:createGitActivityIndex({persistence:state.storage,resolveBatch,validateAuthority})};
}
async function durable() {
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),'git-activity-index-')));roots.push(directory);
  const storage=createLocalSummaryCache({directory,codec:gitActivityIndexCodec});
  return {directory,storage};
}
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(accept=>{resolve=accept;});return {promise,resolve};
}

describe('bounded exact declared-reference activity coverage',()=>{
  it('covers 429 declarations in four deterministic durable passes across restarts',async()=>{
    const f=await durable(),references=refs(429),lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref)));
    for(const [pass,checked] of [128,256,384,429].entries()) {
      const index=createGitActivityIndex({persistence:createLocalSummaryCache({directory:f.directory,codec:gitActivityIndexCodec}),resolveBatch:lookup,validateAuthority:()=>true});
      const observed=await index.observe(input([...references].reverse()));
      expect(observed.coverage).toEqual({checked,total:429,resolved:checked,unresolved:0,unsupported:0,pending:429-checked,state:pass===3?'complete':'partial'});
      expect(observed.records.map(row=>row.declaredReference)).toEqual(references.slice(0,checked));
      expect((await f.storage.read())!.payload.projects[0].records).toEqual(observed.records);
    }
    expect(lookup.mock.calls.map(call=>call[1].length)).toEqual([128,128,128,45]);
    expect(lookup.mock.calls.flatMap(call=>[...call[1]])).toEqual(references);
  });

  it('counts every unsupported or unresolved declaration without claiming complete latest coverage',async()=>{
    const declarations=['abcd','dead','beef','feed','branch-name'];
    const statuses=new Map<string,GitActivityReference['status']>([['abcd','resolved'],['dead','ambiguous'],['beef','missing'],['feed','noncommit'],['branch-name','unsupported']]);
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(declaredReference=>statuses.get(declaredReference)==='resolved'?
      resolved(declaredReference,declaredReference.padEnd(40,'0')):{declaredReference,status:statuses.get(declaredReference)!}));
    const f=service(memory(),lookup),first=await f.index.observe(input(declarations));
    expect(first.coverage).toEqual({checked:5,total:5,resolved:1,unresolved:4,unsupported:1,pending:0,state:'partial'});
    expect((await f.index.observe(input(declarations))).coverage).toEqual(first.coverage);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('preserves exact spelling, deduplicates identical declarations, and hashes only the sorted exact current set',async()=>{
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref,ref.toLowerCase().padEnd(40,'0'))));
    const f=service(memory(),lookup),declared=['ABCD','abcd','ABCD'];
    expect((await f.index.observe(input(declared))).records.map(row=>row.declaredReference)).toEqual(['ABCD','abcd']);
    expect(gitActivityDeclaredSetHash(declared)).toBe(gitActivityDeclaredSetHash(['abcd','ABCD']));
    expect(gitActivityDeclaredSetHash(['abcd'])).not.toBe(gitActivityDeclaredSetHash(['ABCD']));
    expect(f.state.record!.payload.projects[0]).toMatchObject({resolverContract:GIT_ACTIVITY_RESOLVER_CONTRACT,declaredSetHash:gitActivityDeclaredSetHash(declared)});
  });

  it('never retains removed declarations or reuses progress from another exact set',async()=>{
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref))),f=service(memory(),lookup);
    await f.index.observe(input(refs(3)));
    const changed=await f.index.observe(input([sha(2)]));
    expect(changed.records).toEqual([resolved(sha(2))]);
    expect(f.state.record!.payload.projects[0].declaredReferences).toEqual([sha(2)]);
    expect(f.state.record!.payload.projects[0].records).toEqual(changed.records);
    expect(lookup.mock.calls.map(call=>call[1])).toEqual([refs(3),[sha(2)]]);
  });

  it('retires abbreviated uniqueness whenever object-store revision changes',async()=>{
    let ambiguous=false;
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(declaredReference=>ambiguous?
      {declaredReference,status:'ambiguous' as const}:resolved(declaredReference,'abcd'.padEnd(40,'0'))));
    const f=service(memory(),lookup);
    expect((await f.index.observe(input(['abcd']))).coverage.state).toBe('complete');
    ambiguous=true;
    const changed=await f.index.observe(input(['abcd'],{objectRevision:'objects-2'}));
    expect(changed).toEqual({records:[{declaredReference:'abcd',status:'ambiguous'}],coverage:{checked:1,total:1,resolved:0,unresolved:1,unsupported:0,pending:0,state:'partial'}});
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(['authorityKey','objectRevision'] as const)('does not reuse a prior %s binding',async key=>{
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref))),f=service(memory(),lookup);
    await f.index.observe(input(refs(200)));
    const changed=await f.index.observe(input(refs(200),{[key]:'replacement-binding'}));
    expect(changed.coverage.checked).toBe(128);
    expect(lookup.mock.calls[1][1]).toEqual(refs(128));
    expect(f.state.record!.payload.projects[0][key]).toBe('replacement-binding');
  });

  it('retires a readable previous resolver contract rather than treating its old resolutions as current',async()=>{
    const f=service();await f.index.observe(input(refs(2)));
    const previous=f.state.record!;previous.payload.projects[0].resolverContract='exact-declared-commit-old';f.state.record=previous;
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref)));
    const index=createGitActivityIndex({persistence:f.state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    expect((await index.peek(input(refs(2)))).coverage.checked).toBe(0);
    expect((await index.observe(input(refs(2)))).coverage.checked).toBe(2);
    expect(lookup).toHaveBeenCalledOnce();
    expect(f.state.record!.payload.projects[0].resolverContract).toBe(GIT_ACTIVITY_RESOLVER_CONTRACT);
  });

  it('peek revalidates but never advances a batch, writes, or returns mismatched cached records',async()=>{
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref))),f=service(memory(),lookup);
    expect((await f.index.peek(input(refs(200)))).coverage).toMatchObject({checked:0,pending:200,state:'partial'});
    expect(lookup).not.toHaveBeenCalled();expect(f.state.storage.write).not.toHaveBeenCalled();
    await f.index.observe(input(refs(200)));
    const writes=vi.mocked(f.state.storage.write).mock.calls.length;
    expect((await f.index.peek(input(refs(200)))).coverage.checked).toBe(128);
    expect((await f.index.peek(input([sha(1)]))).records).toEqual([]);
    expect((await f.index.peek(input(refs(200),{authorityKey:'new-grant'}))).records).toEqual([]);
    expect(lookup).toHaveBeenCalledOnce();expect(f.state.storage.write).toHaveBeenCalledTimes(writes);
  });

  it('has no timestamp-driven refresh, scheduler, or repeated lookup for an unchanged complete set',async()=>{
    vi.useFakeTimers();
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref))),f=service(memory(),lookup);
    await f.index.observe(input());
    vi.setSystemTime(new Date('2035-01-01T00:00:00.000Z'));await vi.advanceTimersByTimeAsync(1_000_000);
    await f.index.observe(input());
    expect(lookup).toHaveBeenCalledOnce();expect(f.state.storage.write).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });

  it('treats an authorized empty declared set as complete without claiming unrecorded activity coverage',async()=>{
    const lookup=vi.fn(async(_id:string,_batch:readonly string[])=>[]),f=service(memory(),lookup);
    expect(await f.index.observe(input([]))).toEqual({records:[],coverage:{checked:0,total:0,resolved:0,unresolved:0,unsupported:0,pending:0,state:'complete'}});
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('activity index concurrency and authority lifecycle',()=>{
  it('serializes concurrent passes globally across projects, without duplicate parallel resolution',async()=>{
    let active=0,maximum=0;
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>{maximum=Math.max(maximum,++active);await Promise.resolve();active--;return batch.map(ref=>resolved(ref));});
    const f=service(memory(),lookup);
    const results=await Promise.all(Array.from({length:4},()=>f.index.observe(input(refs(429)))));
    expect(results.map(result=>result.coverage.checked)).toEqual([128,256,384,429]);
    await Promise.all([f.index.observe(input(refs(2),{projectId:'another-project'})),f.index.observe(input(refs(3),{projectId:'third-project'}))]);
    expect(maximum).toBe(1);expect(lookup.mock.calls.slice(0,4).flatMap(call=>[...call[1]])).toEqual(refs(429));
    expect(f.state.record!.payload.projects).toHaveLength(3);
  });

  it('detaches caller arrays and passes frozen complete bindings to validators and resolvers',async()=>{
    const captured:GitActivityIndexInput[]=[],state=memory();
    const lookup=vi.fn(async(_id:string,batch:readonly string[],_signal:AbortSignal,binding:GitActivityIndexInput)=>{
      captured.push(binding);expect(Object.isFrozen(binding)).toBe(true);expect(Object.isFrozen(binding.declaredReferences)).toBe(true);expect(Object.isFrozen(batch)).toBe(true);
      return batch.map(ref=>resolved(ref));
    });
    const index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:binding=>{expect(Object.isFrozen(binding)).toBe(true);return true;}});
    const values=refs(2),request=input(values),pending=index.observe(request);
    values[0]=sha(999);(request as {authorityKey:string}).authorityKey='mutated';
    expect((await pending).records.map(row=>row.declaredReference)).toEqual(refs(2));
    expect(captured[0].authorityKey).toBe(input().authorityKey);
  });

  it.each([1,2,3,4,5])('denies authority at boundary %i before publishing or persisting results',async boundary=>{
    let count=0;
    const validator=vi.fn(()=>++count<boundary),lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref))),f=service(memory(),lookup,validator);
    expect((await f.index.observe(input())).coverage.state).toBe('unavailable');
    expect(f.state.storage.write).not.toHaveBeenCalled();
    if(boundary===1)expect(f.state.storage.read).not.toHaveBeenCalled();
    if(boundary<=3)expect(lookup).not.toHaveBeenCalled();
  });

  it('does not publish a result if authority changes after persistence acknowledgement',async()=>{
    let checks=0;const state=memory(),index=createGitActivityIndex({persistence:state.storage,resolveBatch:resolveAll,validateAuthority:()=>++checks<6});
    expect((await index.observe(input())).records).toEqual([]);
    expect(state.storage.write).toHaveBeenCalledOnce();
    expect((await index.peek(input())).coverage.state).toBe('unavailable');
  });

  it('revocation aborts active and queued work immediately and removes durable progress before returning',async()=>{
    const state=memory(),first=service(state);await first.index.observe(input(refs(200)));
    const gate=deferred<GitActivityReference[]>(),lookup=vi.fn(async()=>gate.promise),index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    const running=index.observe(input(refs(200))),queued=index.observe(input(refs(200)));
    await vi.waitFor(()=>expect(lookup).toHaveBeenCalledOnce());
    const removed=index.revoke('synthetic-project');
    expect((await running).coverage.state).toBe('unavailable');expect((await queued).records).toEqual([]);
    gate.resolve(refs(200).slice(128).map(ref=>resolved(ref)));
    expect(await removed).toBe(true);await index.settle();
    expect(state.record!.payload.projects).toEqual([]);expect(lookup).toHaveBeenCalledOnce();
    expect((await index.peek(input(refs(200)))).coverage.checked).toBe(0);
  });

  it('invalidation blocks a late write even if the resolver ignores its cancellation signal',async()=>{
    const gate=deferred<GitActivityReference[]>(),state=memory(),lookup=vi.fn(async()=>gate.promise);
    const index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    const running=index.observe(input());await vi.waitFor(()=>expect(lookup).toHaveBeenCalledOnce());
    const removed=index.invalidate('synthetic-project');
    expect((await running).records).toEqual([]);
    gate.resolve([resolved(sha(1))]);expect(await removed).toBe(true);
    expect(state.storage.write).not.toHaveBeenCalled();expect(state.record).toBeNull();
  });

  it('passes revocation into a pending durable write and does not acknowledge erasure until it settles',async()=>{
    const gate=deferred<void>(),started=deferred<void>(),state=memory(),original=state.storage.write;
    let writeSignal:AbortSignal|undefined;
    state.storage.write=vi.fn(async(payload,revision,signal)=>{writeSignal=signal;started.resolve();await gate.promise;return original(payload,revision,signal);});
    const index=createGitActivityIndex({persistence:state.storage,resolveBatch:resolveAll,validateAuthority:()=>true});
    const running=index.observe(input());await started.promise;
    let removed=false;const removal=index.invalidate('synthetic-project').then(result=>{removed=result;return result;});
    expect(writeSignal?.aborted).toBe(true);expect((await running).coverage.state).toBe('unavailable');
    expect(removed).toBe(false);gate.resolve();expect(await removal).toBe(true);expect(state.record).toBeNull();
  });

  it('bounds queued observations and deduplicates lifecycle removals without dropping revocation',async()=>{
    const gate=deferred<GitActivityReference[]>(),state=memory(),lookup=vi.fn(async()=>gate.promise);
    const index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    const queued=Array.from({length:GIT_ACTIVITY_INDEX_LIMITS.pendingRequests},()=>index.observe(input()));
    await vi.waitFor(()=>expect(lookup).toHaveBeenCalledOnce());
    expect((await index.observe(input())).coverage.state).toBe('unavailable');
    const first=index.invalidate('synthetic-project'),second=index.invalidate('synthetic-project');expect(second).toBe(first);
    expect((await Promise.all(queued)).every(result=>result.coverage.state==='unavailable')).toBe(true);
    gate.resolve([resolved(sha(1))]);expect(await first).toBe(true);expect(lookup).toHaveBeenCalledOnce();expect(state.record).toBeNull();
  });

  it('caller cancellation prevents publication and permits a later fresh pass only after the old call settles',async()=>{
    const controller=new AbortController(),gate=deferred<GitActivityReference[]>(),state=memory();
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>lookup.mock.calls.length===1?gate.promise:batch.map(ref=>resolved(ref)));
    const index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    const running=index.observe(input(),controller.signal);await vi.waitFor(()=>expect(lookup).toHaveBeenCalledOnce());controller.abort();
    expect((await running).coverage.state).toBe('unavailable');
    const next=index.observe(input());await Promise.resolve();expect(lookup).toHaveBeenCalledOnce();
    gate.resolve([resolved(sha(1))]);expect((await next).coverage.state).toBe('complete');expect(lookup).toHaveBeenCalledTimes(2);
    expect(state.storage.write).toHaveBeenCalledOnce();
  });

  it('disposal cancels active work and blocks all future cache publications',async()=>{
    const gate=deferred<GitActivityReference[]>(),state=memory(),lookup=vi.fn(async()=>gate.promise),index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    const running=index.observe(input());await vi.waitFor(()=>expect(lookup).toHaveBeenCalledOnce());index.dispose();
    expect((await running).records).toEqual([]);gate.resolve([resolved(sha(1))]);await index.settle();
    expect((await index.observe(input())).coverage.state).toBe('unavailable');expect(state.storage.write).not.toHaveBeenCalled();
  });

  it('retires the instance after a deadline so an ignored cancellation cannot produce duplicate reads',async()=>{
    vi.useFakeTimers();const gate=deferred<GitActivityReference[]>(),state=memory(),lookup=vi.fn(async()=>gate.promise);
    const index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true,operationTimeoutMs:20});
    const running=index.observe(input());await vi.advanceTimersByTimeAsync(20);
    expect((await running).coverage.state).toBe('unavailable');expect(lookup).toHaveBeenCalledOnce();
    expect((await index.observe(input())).coverage.state).toBe('unavailable');gate.resolve([resolved(sha(1))]);await index.settle();
    expect(state.storage.write).not.toHaveBeenCalled();expect(lookup).toHaveBeenCalledOnce();
  });
});

describe('activity index fail-closed persistence and strict bounds',()=>{
  it('does not read Git when durable storage is absent or fails',async()=>{
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref)));
    const absent=createGitActivityIndex({resolveBatch:lookup,validateAuthority:()=>true});
    expect((await absent.observe(input())).coverage.state).toBe('unavailable');
    const state=memory();state.storage.read=vi.fn(async()=>{throw Error('Unreadable');});
    const blocked=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    expect((await blocked.observe(input())).coverage.state).toBe('unavailable');expect(lookup).not.toHaveBeenCalled();expect(state.storage.write).not.toHaveBeenCalled();
  });

  it('preserves a corrupt durable file and refuses Git lookup or empty-success replacement',async()=>{
    const f=await durable(),filename=path.join(f.directory,'summary-cache-v1.json');await writeFile(filename,'{"corrupt":true}');
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref))),index=createGitActivityIndex({persistence:f.storage,resolveBatch:lookup,validateAuthority:()=>true});
    expect((await index.observe(input())).coverage.state).toBe('unavailable');expect(lookup).not.toHaveBeenCalled();
    expect(await readFile(filename,'utf8')).toBe('{"corrupt":true}');
  });

  it('never publishes newly resolved records when the durable write fails',async()=>{
    const state=memory(),original=state.storage.write;
    state.storage.write=vi.fn(async()=>{throw Error('Disk full');});
    const f=service(state),result=await f.index.observe(input());
    expect(result).toEqual({records:[],coverage:{checked:0,total:1,resolved:0,unresolved:0,unsupported:0,pending:1,state:'unavailable'}});
    expect(state.record).toBeNull();state.storage.write=original;
    expect((await f.index.observe(input())).coverage.state).toBe('complete');
  });

  it('preserves previous progress on a failed new batch and safely resumes after restart',async()=>{
    const state=memory(),f=service(state);await f.index.observe(input(refs(200)));
    const original=state.storage.write;state.storage.write=vi.fn(async()=>{throw Error('No space');});
    expect((await f.index.observe(input(refs(200)))).coverage.state).toBe('unavailable');
    expect(state.record!.payload.projects[0].records).toHaveLength(128);
    state.storage.write=original;
    expect((await service(state).index.observe(input(refs(200)))).coverage).toMatchObject({checked:200,pending:0,state:'complete'});
  });

  it('rejects an incorrect persistence acknowledgement without publishing candidate results',async()=>{
    const state=memory();state.storage.write=vi.fn(async payload=>({revision:999,payload}));
    expect((await service(state).index.observe(input())).coverage.state).toBe('unavailable');
  });

  it('fails closed for the rest of the instance when lifecycle erasure cannot be verified',async()=>{
    const f=service();await f.index.observe(input());f.state.storage.write=vi.fn(async()=>{throw Error('Erase unavailable');});
    expect(await f.index.invalidate('synthetic-project')).toBe(false);
    expect((await f.index.peek(input())).coverage.state).toBe('unavailable');
  });

  it.each([
    [{declaredReference:sha(1),status:'resolved',fullSha:sha(2),at:'2026-10-09T10:00:00.000Z'}],
    [{declaredReference:sha(1),status:'resolved',fullSha:sha(1),at:'today'}],
    [{declaredReference:sha(1),status:'resolved',fullSha:sha(1),at:'2026-10-09T10:00:00.000Z',body:'unrelated code'}],
    [{declaredReference:sha(1),status:'missing',fullSha:sha(1)}],
    [{declaredReference:sha(999),status:'missing'}],
    [{declaredReference:sha(1),status:'resolved'}],
    [{declaredReference:sha(1),status:'found'}],
    [resolved(sha(1)),resolved(sha(1))],[],
  ].map(rows=>({rows})))('rejects incomplete, unsolicited, duplicate, or body-bearing resolver output $rows',async({rows})=>{
    const state=memory(),lookup=vi.fn(async()=>rows as GitActivityReference[]),index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    expect((await index.observe(input())).coverage.state).toBe('unavailable');expect(state.storage.write).not.toHaveBeenCalled();
  });

  it('normalizes arbitrary resolver output ordering into the deterministic exact prefix',async()=>{
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>[...batch].reverse().map(ref=>resolved(ref))),f=service(memory(),lookup);
    expect((await f.index.observe(input(refs(5)))).records.map(row=>row.declaredReference)).toEqual(refs(5));
  });

  it('rejects malformed persisted bindings and inconsistent checked prefixes',async()=>{
    const f=service();await f.index.observe(input(refs(2)));const payload=f.state.record!.payload;
    const variants=[
      {...payload,schemaVersion:2}, {...payload,body:'source'}, {...payload,projects:[...payload.projects,...payload.projects]},
      {...payload,projects:[{...payload.projects[0],declaredSetHash:'sha256:changed'}]},
      {...payload,projects:[{...payload.projects[0],records:[resolved(sha(2))]}]},
      {...payload,projects:[{...payload.projects[0],records:[{...resolved(sha(1)),body:'source'}]}]},
    ];
    for(const variant of variants)expect(()=>gitActivityIndexCodec.parse(variant)).toThrow();
  });

  it('rejects accessor, custom prototype, sparse array, over-limit reference set and huge declarations synchronously',()=>{
    const f=service(),getter=vi.fn(()=>refs(1)),accessor={...input()};Object.defineProperty(accessor,'declaredReferences',{enumerable:true,get:getter});
    const bad=[accessor,Object.assign(Object.create({}),input()),input(new Array(2)),input(refs(GIT_ACTIVITY_INDEX_LIMITS.references+1)),input(['x'.repeat(257)])];
    for(const value of bad)expect(()=>f.index.observe(value)).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(f.state.storage.read).not.toHaveBeenCalled();
  });

  it('enforces the global project and declared-reference bounds before starting another lookup',async()=>{
    const sample={projectId:'template',authorityKey:'grant',objectRevision:'objects',resolverContract:GIT_ACTIVITY_RESOLVER_CONTRACT,
      declaredSetHash:gitActivityDeclaredSetHash([]),declaredReferences:[],records:[]};
    const state=memory({revision:1,payload:{schemaVersion:1,projects:Array.from({length:128},(_,i)=>({...sample,projectId:'project-'+i}))}});
    const lookup=vi.fn(async(_id:string,batch:readonly string[])=>batch.map(ref=>resolved(ref))),index=createGitActivityIndex({persistence:state.storage,resolveBatch:lookup,validateAuthority:()=>true});
    expect((await index.observe(input())).coverage.state).toBe('unavailable');expect(lookup).not.toHaveBeenCalled();
    const all=refs(GIT_ACTIVITY_INDEX_LIMITS.references),large=memory({revision:1,payload:{schemaVersion:1,projects:[{...sample,declaredSetHash:gitActivityDeclaredSetHash(all),declaredReferences:all}]}});
    const bounded=createGitActivityIndex({persistence:large.storage,resolveBatch:lookup,validateAuthority:()=>true});
    expect((await bounded.observe(input())).coverage.state).toBe('unavailable');expect(lookup).not.toHaveBeenCalled();
    expect(large.storage.write).not.toHaveBeenCalled();
  });
});
