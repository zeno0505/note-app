import {afterEach,describe,expect,it,vi} from 'vitest';
import type {DagReadModel} from '../../src/facts/dag-read-model';
import {createTaskGraphService,produceTaskGraph} from '../../src/main/task-graph';
import {TASK_GRAPH_LIMITS,type GraphDetailSnapshot,type TaskGraphIdentity} from '../../src/shared/task-graph-contract';
import {graphEncodedBytes,parseGraphDetailRequest,parseGraphDetailResult} from '../../src/shared/task-graph-transport';

const authority={projectId:'project',dagId:'dag',sessionKey:'generation-1'};
function model(count=1001):DagReadModel {
  const tasks=Array.from({length:count},(_,i)=>({id:`T-${i}`,title:`Synthetic task ${i}`,status:'pending',
    dependencies:[] as {id:string;scope:'internal'|'external'}[],
    e2e:{state:'undeclared' as const,required:null,coveredBy:null,coverage:'undeclared' as const},
    commitReferences:[] as string[],commitVerification:'not-performed' as const}));
  return {dagId:'dag',sourceHash:'source-hash',sourceMtimeMs:0,observedAt:'2026-10-14T00:00:00.000Z',doneStatus:'done',tasks,
    policies:[{legacy:true,key:'synthetic',decision:{statuses:['pending'],nested:{value:0}}}],statusCounts:[],
    coverage:{tasksTotal:count,declared:0,required:0,uncoveredDone:[],uncoveredOpen:[],malformed:[]},verifiedFacts:[]};
}
function setup(value=model()) {
  let current:typeof authority|null=authority;
  const read=vi.fn(async()=>value);
  const service=createTaskGraphService({current:()=>current,read});
  const identity=produceTaskGraph(value,authority).metadata.identity;
  return {value,identity,service,read,request:(requestId='detail',taskId=value.tasks.at(-1)?.id??'missing')=>({requestId,identity,taskId}),
    setCurrent:(next:typeof current)=>{current=next;}};
}
afterEach(()=>vi.useRealTimers());

describe('complete graph one-task detail source',()=>{
  it('returns task beyond 1000 with all >8 refs and explicit source omissions, detached from the source',async()=>{
    const value=model(),last=value.tasks[1000];
    last.dependencies=Array.from({length:12},(_,i)=>({id:`T-${i}`,scope:'internal'}));
    last.commitReferences=Array.from({length:15},(_,i)=>`synthetic-ref-${i}`);last.commitReferencesUnsupported=2;
    last.e2e={state:'declared',required:true,coveredBy:Array.from({length:13},(_,i)=>`E2E-${i}`),coverage:'references-declared'};
    last.rawType='feature';last.rawFeature='Synthetic feature';
    last.details={description:'Admitted description',acceptanceCriteria:['criterion'],targetFiles:['src/synthetic.ts'],discussion:['discussion/synthetic.md'],design:['design/synthetic.md'],omissions:3};
    const f=setup(value),result=await f.service.detail(f.request());
    expect(result.state).toBe('detail');if(result.state!=='detail')throw Error('detail expected');
    expect(result.identity).toEqual(f.identity);expect(result.task.id).toBe('T-1000');expect(result.task.dependencies).toHaveLength(12);
    expect(result.task.commitReferences).toHaveLength(15);expect(result.task.e2e.coveredBy).toHaveLength(13);
    expect(result.task.commitReferencesUnsupported).toBe(2);expect(result.task.details?.omissions).toBe(3);
    expect(result.task.displayOmissions).toEqual({dependencies:0,commitReferences:0,e2eReferences:0});expect(result.policies).toEqual(value.policies);
    result.task.dependencies.pop();result.task.details!.design[0]='changed';result.policies[0].key='changed';
    expect(last.dependencies).toHaveLength(12);expect(last.details.design).toEqual(['design/synthetic.md']);expect(value.policies![0].key).toBe('synthetic');
    expect((await f.service.detail(f.request('again'))).state).toBe('detail');f.service.invalidate();
  });
  it('requires full identity, rejects missing/duplicate task IDs and never accepts stale revisions',async()=>{
    const f=setup();
    for(const field of ['projectId','dagId','sourceHash','sessionKey','revision'] as const){
      const request=f.request(field);request.identity={...request.identity,[field]:'wrong'};
      const result=await f.service.detail(request);expect(result.state).toBe('unavailable');
    }
    expect(await f.service.detail(f.request('missing','T-no-such-task'))).toMatchObject({state:'unavailable',reason:'unsupported'});
    f.value.sourceHash='changed';expect(await f.service.detail(f.request('hash-change'))).toMatchObject({reason:'source-changed'});
    f.value.sourceHash=f.identity.sourceHash;f.value.tasks[0].title='changed title';
    expect(await f.service.detail(f.request('revision-change'))).toMatchObject({reason:'source-changed'});
    const duplicate=model(2);duplicate.tasks[1].id=duplicate.tasks[0].id;const d=setup(duplicate);
    expect(await d.service.detail(d.request('duplicate','T-0'))).toMatchObject({reason:'unsupported'});
  });
  it('rechecks current generation after a physical read, including A→B→A generation change',async()=>{
    const f=setup();let resolve!:(value:DagReadModel)=>void;
    f.read.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const pending=f.service.detail(f.request());await Promise.resolve();
    f.setCurrent({...authority,sessionKey:'generation-3'});resolve(f.value);
    expect(await pending).toMatchObject({state:'unavailable',reason:'stale-session'});
    expect(await f.service.detail(f.request('again'))).toMatchObject({reason:'stale-session'});
    f.setCurrent(null);expect(await f.service.detail(f.request('revoked'))).toMatchObject({reason:'unauthorized'});
  });
  it('shares four physical-operation slots with graph reads; cancellation does not free abandoned I/O slots',async()=>{
    const f=setup(),finish:((value:DagReadModel)=>void)[]=[];
    f.read.mockImplementation(()=>new Promise(resolve=>finish.push(resolve)));
    const pending=Array.from({length:4},(_,i)=>f.service.detail(f.request(`detail-${i}`)));
    await Promise.resolve();for(let i=0;i<4;i++)f.service.cancel({requestId:`detail-${i}`});
    expect((await Promise.all(pending)).map(r=>r.state==='unavailable'?r.reason:'')).toEqual(Array(4).fill('cancelled'));
    expect(await f.service.detail(f.request('fifth'))).toMatchObject({reason:'unsupported'});
    expect(await f.service.read({...authority,requestId:'snapshot',expectedRevision:null})).toMatchObject({reason:'unsupported'});
    for(const resolve of finish)resolve(f.value);await Promise.resolve();await Promise.resolve();
    f.read.mockResolvedValue(f.value);expect((await f.service.detail(f.request('recovered'))).state).toBe('detail');
  });
  it('an old cancelled request cannot release a newer request that reuses its ID',async()=>{
    const f=setup(model(1)),finish:((value:DagReadModel)=>void)[]=[];
    f.read.mockImplementation(()=>new Promise(resolve=>finish.push(resolve)));
    const first=f.service.detail(f.request('same'));await Promise.resolve();f.service.cancel({requestId:'same'});
    const second=f.service.detail(f.request('same'));await Promise.resolve();
    expect(await first).toMatchObject({reason:'cancelled'});
    expect(await f.service.detail(f.request('same'))).toMatchObject({reason:'unsupported'});
    finish[1](f.value);expect((await second).state).toBe('detail');finish[0](f.value);
  });
  it('bounds hung reads, allows invalidation and never publishes a cancelled response',async()=>{
    vi.useFakeTimers();const value=model(1),identity=produceTaskGraph(value,authority).metadata.identity;
    const service=createTaskGraphService({current:()=>authority,read:()=>new Promise(()=>{}),timeoutMs:20});
    const pending=service.detail({requestId:'timeout',identity,taskId:'T-0'});
    await vi.advanceTimersByTimeAsync(21);expect(await pending).toMatchObject({reason:'timeout'});
    const other=service.detail({requestId:'invalidate',identity,taskId:'T-0'});await Promise.resolve();service.invalidate();
    expect(await other).toMatchObject({reason:'cancelled'});
  });
  it('fails closed on encoded UTF-8 response limits and source reference limits without truncating',async()=>{
    const f=setup(model(1));f.value.tasks[0].commitReferences=Array.from({length:100},()=> '한'.repeat(4096));
    expect(await f.service.detail(f.request())).toMatchObject({reason:'unsupported'});
    f.value.tasks[0].commitReferences=Array.from({length:10001},()=> 'ref');
    expect(await f.service.detail(f.request('count'))).toMatchObject({reason:'unsupported'});
    f.value.tasks[0].commitReferences=['ref'];expect((await f.service.detail(f.request('safe'))).state).toBe('detail');
  });
  it('rejects timeout elapsed during synchronous projection and releases completed detail leases',async()=>{
    const value=model(1),identity=produceTaskGraph(value,authority).metadata.identity;let time=0;
    const service=createTaskGraphService({current:()=>authority,read:async()=>{time=11;return value;},timeoutMs:10,now:()=>time});
    expect(await service.detail({requestId:'expired',identity,taskId:'T-0'})).toMatchObject({reason:'timeout'});
    const f=setup(model(1));for(let i=0;i<8;i++)expect((await f.service.detail(f.request(`done-${i}`))).state).toBe('detail');
  });
});

async function sample():Promise<GraphDetailSnapshot>{const f=setup(model(1)),result=await f.service.detail(f.request());if(result.state!=='detail')throw Error('fixture detail');return result;}
describe('strict graph-detail wire decoders',()=>{
  it('rejects extra request properties, accessors and hostile identities without evaluating getters',()=>{
    const identity:TaskGraphIdentity={...authority,sourceHash:'hash',revision:'revision'},request={requestId:'id',identity,taskId:'T-0'};
    expect(parseGraphDetailRequest(request)).toEqual(request);
    for(const value of [{...request,path:'/unauthorized'},{...request,taskId:''},{...request,identity:{...identity,url:'https://example.test'}},Object.create(request)])expect(()=>parseGraphDetailRequest(value)).toThrow();
    const getter=vi.fn(()=>identity),hostile={...request};Object.defineProperty(hostile,'identity',{get:getter,enumerable:true});
    expect(()=>parseGraphDetailRequest(hostile)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it('accepts a valid bounded snapshot and refuses unknown fields, truncated refs or false verification claims',async()=>{
    const value=await sample();expect(parseGraphDetailResult(value)).toEqual(value);expect(graphEncodedBytes(value)).toBeLessThan(TASK_GRAPH_LIMITS.detailBytes);
    for(const mutate of [(v:GraphDetailSnapshot)=>Object.assign(v,{path:'private'}),(v:GraphDetailSnapshot)=>Object.assign(v.task,{raw:'source body'}),
      (v:GraphDetailSnapshot)=>{v.task.displayOmissions.dependencies=1;},(v:GraphDetailSnapshot)=>Object.assign(v.task,{commitVerification:'verified'}),
      (v:GraphDetailSnapshot)=>{v.observedAt='2026-02-30T00:00:00.000Z';},(v:GraphDetailSnapshot)=>{v.task.e2e.coverage='references-declared';}]){
      const malformed=structuredClone(value);mutate(malformed);expect(()=>parseGraphDetailResult(malformed)).toThrow();
    }
  });
  it('bounds nested policies, rejects dangerous descriptors and preserves __proto__ as inert declaration data',async()=>{
    const value=await sample(),getter=vi.fn();Object.defineProperty(value.task.details!,'description',{get:getter,enumerable:true});
    expect(()=>parseGraphDetailResult(value)).toThrow();expect(getter).not.toHaveBeenCalled();
    const safe=await sample();safe.policies=[JSON.parse('{"__proto__":{"polluted":true},"key":"legacy"}')];
    const parsed=parseGraphDetailResult(safe);expect(parsed.state).toBe('detail');expect(({} as {polluted?:unknown}).polluted).toBeUndefined();
    let nested:Record<string,unknown>={};for(let i=0;i<34;i++)nested={nested};safe.policies=[nested];expect(()=>parseGraphDetailResult(safe)).toThrow();
    safe.policies=[{value:()=>{throw Error('must not execute');}}];expect(()=>parseGraphDetailResult(safe)).toThrow();
    const policy={};Object.defineProperty(policy,'value',{get:getter,enumerable:true});safe.policies=[policy];expect(()=>parseGraphDetailResult(safe)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
});
