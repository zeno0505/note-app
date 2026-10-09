import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLocalSummaryCache,type SummaryCacheRecord} from '../../src/summary/storage';
import {createProjectDraftStore,projectDraftCodec,type ProjectDraftPayload,type ProjectDraftPersistence} from '../../src/main/project-drafts';
import {PROJECT_DRAFT_LIMITS,createEmptyProjectDraftInput,parseProjectDraft,parseProjectDraftInput,parseSaveProjectDraftRequest,projectDraftReadiness,type ProjectDraftInput} from '../../src/shared/project-draft';

const at=Date.parse('2026-10-08T10:00:00.000Z');
const id='project-draft-00000000-0000-4000-8000-000000000000';
const roots:string[]=[];
afterEach(async()=>{vi.useRealTimers();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),'phase3-draft-')));roots.push(directory);
  const cache=createLocalSummaryCache({directory,codec:projectDraftCodec});
  return {directory,cache,store:createProjectDraftStore(cache,()=>at),filename:path.join(directory,'summary-cache-v1.json')};
}
function input():ProjectDraftInput {
  return {name:'Synthetic project',description:'A synthetic description\nwith multiple lines.',references:[
    {kind:'notion',url:'https://example.notion.site/context',state:'entered'},
    {kind:'slack',url:'https://example.slack.com/archives/C123/p123',state:'entered'},
    {kind:'figma',url:'https://www.figma.com/design/example',state:'entered'},
    {kind:'notion',url:'https://www.notion.so/another',state:'entered'},
  ],instructions:{mode:'inherit',source:'Synthetic guide',sourceRevision:'sha256:synthetic',text:'Captured synthetic instructions.',additional:'An extra instruction.'},
  noteLocation:'/synthetic/notes/project',repositories:[
    {name:'Application',path:'/synthetic/repositories/application',workspace:{mode:'existing',worktreeId:'opaque-worktree-one',path:'/synthetic/worktrees/application',branch:'topic'}},
    {name:'Service',path:'/synthetic/repositories/service',workspace:{mode:'new',worktreeId:'',path:'/synthetic/worktrees/service',branch:'new-topic'}},
  ]};
}
function memory(){
  let record:SummaryCacheRecord<ProjectDraftPayload>|null=null;
  const storage:ProjectDraftPersistence={read:vi.fn(async()=>structuredClone(record)),write:vi.fn(async(payload,revision)=>{
    if(revision!==(record?.revision??null))throw Error('Cache conflict');
    record={revision:(revision??0)+1,payload:structuredClone(payload)};return structuredClone(record);
  })};
  return {storage,get record(){return record;}};
}

describe('Phase3 strict entered-only project draft schema',()=>{
  it('keeps multiple references, inherited source snapshot/revision and independent per-repository bindings',()=>{
    expect(parseProjectDraftInput(input())).toEqual(input());
    expect(projectDraftReadiness(input())).toEqual({readyForReview:true,missing:[]});
    const parsed=parseProjectDraftInput(input());parsed.repositories[0].workspace.path='changed';
    expect(input().repositories[0].workspace.path).not.toBe('changed');
    expect(Object.keys(parsed)).not.toContain('status');
  });
  it('accepts incomplete draft fields while reporting readiness separately',()=>{
    const empty=createEmptyProjectDraftInput();empty.references.push({kind:'notion',url:'',state:'entered'});
    expect(parseProjectDraftInput(empty)).toEqual(empty);
    expect(projectDraftReadiness(empty)).toEqual({readyForReview:false,missing:['name','description','references','instructions','noteLocation','repositories']});
    const custom=input();custom.instructions={mode:'custom',source:'',sourceRevision:'',text:'Standalone instructions',additional:''};
    expect(projectDraftReadiness(custom).readyForReview).toBe(true);
    custom.repositories[1].workspace.branch='';expect(projectDraftReadiness(custom).missing).toEqual(['workspaceBindings']);
  });
  it.each([
    ['notion','http://www.notion.so/context'],['notion','https://notion.so.evil.test/context'],
    ['notion','https://evilnotion.so/context'],['slack','https://www.figma.com/context'],
    ['figma','https://user:password@www.figma.com/file/example'],['figma','https://www.figma.com:8443/file/example'],
    ['slack','file:///synthetic/file'],['slack','javascript:alert(1)'],['figma',' https://www.figma.com/file/example'],
    ['notion','https://www.notion.so\\@evil.test/path'],['notion','https://www.notion.so/has space'],
  ])('rejects an unsafe or mismatched %s URL %s',(kind,url)=>{
    expect(()=>parseProjectDraftInput({...input(),references:[{kind,url,state:'entered'}]})).toThrow();
  });
  it.each(['https://notion.so/context','https://team.notion.site/context'])('accepts supported Notion domain %s',url=>{
    expect(parseProjectDraftInput({...input(),references:[{kind:'notion',url,state:'entered'}]}).references[0].url).toBe(url);
  });
  it.each([
    null,[],{},
    {...input(),path:'/synthetic/arbitrary'},
    {...input(),name:'x'.repeat(PROJECT_DRAFT_LIMITS.name+1)},
    {...input(),description:'bad\u0000data'},
    {...input(),references:Array.from({length:33},()=>input().references[0])},
    {...input(),references:[{...input().references[0],state:'fetched'}]},
    {...input(),instructions:{...input().instructions,command:'run'}},
    {...input(),instructions:{...input().instructions,sourceRevision:123}},
    {...input(),repositories:[{...input().repositories[0],workspace:{...input().repositories[0].workspace,mode:'execute'}}]},
    {...input(),repositories:Array.from({length:17},()=>input().repositories[0])},
  ])('rejects malformed, over-bound, or authority-bearing metadata',value=>expect(()=>parseProjectDraftInput(value)).toThrow());
  it('rejects accessors, custom prototypes and sparse/extended arrays without reading them',()=>{
    const getter=vi.fn(()=>input().name),value={...input()};Object.defineProperty(value,'name',{get:getter,enumerable:true});
    expect(()=>parseProjectDraftInput(value)).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(()=>parseProjectDraftInput(Object.assign(Object.create({}),input()))).toThrow();
    const sparse=input();sparse.references=new Array(2);expect(()=>parseProjectDraftInput(sparse)).toThrow();
    const extended=input();Object.assign(extended.references,{path:'outside'});expect(()=>parseProjectDraftInput(extended)).toThrow();
  });
  it('bounds total UTF-8 bytes even when every individual field fits',()=>{
    const big=input();big.description='한'.repeat(PROJECT_DRAFT_LIMITS.description);big.instructions.text='한'.repeat(PROJECT_DRAFT_LIMITS.instructionText);
    big.instructions.additional='한'.repeat(PROJECT_DRAFT_LIMITS.additionalInstructions);
    big.repositories=Array.from({length:16},()=>({...input().repositories[0],path:'한'.repeat(4096)}));
    expect(()=>parseProjectDraftInput(big)).toThrow();
  });
  it.each([
    {id:null,expectedRevision:1,input:input()},{id,expectedRevision:null,input:input()},
    {id:'../../elsewhere',expectedRevision:1,input:input()},{id,expectedRevision:0,input:input()},
    {id,expectedRevision:Infinity,input:input()},{id,expectedRevision:1.5,input:input()},
    {id:null,expectedRevision:null,input:input(),destination:'/synthetic/other'},
  ])('rejects malformed or mismatched optimistic-concurrency requests',request=>expect(()=>parseSaveProjectDraftRequest(request)).toThrow());
  it('rejects invalid persisted timestamps/revisions, duplicate IDs and schema versions',()=>{
    const draft={id,revision:1,updatedAt:new Date(at).toISOString(),input:input()};
    expect(parseProjectDraft(draft)).toEqual(draft);
    for(const value of [{...draft,updatedAt:'yesterday'},{...draft,revision:0},{...draft,input:{...input(),approved:true}}])expect(()=>parseProjectDraft(value)).toThrow();
    for(const value of [{schemaVersion:2,drafts:[]},{schemaVersion:1,drafts:[draft,draft]},{schemaVersion:1,drafts:[],projects:[]}])expect(()=>projectDraftCodec.parse(value)).toThrow();
  });
});

describe('Phase3 app-owned durable project draft storage',()=>{
  it('round trips multiple repository bindings and all entered metadata across a restart',async()=>{
    const f=await fixture(),created=await f.store.save({id:null,expectedRevision:null,input:input()});
    expect(created).toMatchObject({revision:1,updatedAt:new Date(at).toISOString(),input:input()});
    expect(created.id).toMatch(/^project-draft-/);
    expect(await createProjectDraftStore(f.cache).list()).toEqual([created]);
    const changed={...created.input,name:'Edited draft'};
    const updated=await createProjectDraftStore(f.cache,()=>at+1000).save({id:created.id,expectedRevision:created.revision,input:changed});
    expect(updated).toMatchObject({id:created.id,revision:2,input:changed});
    expect(await f.store.list()).toEqual([updated]);
    expect(await readdir(f.directory)).toEqual(['summary-cache-v1.json']);
  });
  it('persists incomplete forms and only reports success after disk acknowledgement',async()=>{
    const state=memory(),store=createProjectDraftStore(state.storage,()=>at);
    let release:(value:SummaryCacheRecord<ProjectDraftPayload>)=>void=()=>{};
    const original=state.storage.write;
    state.storage.write=vi.fn(async(payload,revision,signal)=>{const saved=await original(payload,revision,signal);return new Promise<SummaryCacheRecord<ProjectDraftPayload>>(resolve=>{release=resolve;}).then(()=>saved);});
    let completed=false;const pending=store.save({id:null,expectedRevision:null,input:createEmptyProjectDraftInput()}).then(value=>{completed=true;return value;});
    await vi.waitFor(()=>expect(state.storage.write).toHaveBeenCalledOnce());
    expect(completed).toBe(false);release(state.record!);
    const saved=await pending;expect(projectDraftReadiness(saved.input).readyForReview).toBe(false);
    expect(await store.list()).toEqual([saved]);
  });
  it('serializes simultaneous edits and rejects the stale edit without lost updates',async()=>{
    const state=memory(),store=createProjectDraftStore(state.storage,()=>at);
    const initial=await store.save({id:null,expectedRevision:null,input:input()});
    const results=await Promise.allSettled(['First','Second'].map(name=>store.save({id:initial.id,expectedRevision:1,input:{...input(),name}})));
    expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
    expect(await store.list()).toMatchObject([{revision:2,input:{name:'First'}}]);
    await expect(store.save({id,expectedRevision:1,input:input()})).rejects.toThrow(/변경/);
  });
  it('re-reads cache revisions across store instances rather than overwriting a newer edit',async()=>{
    const f=await fixture(),second=createProjectDraftStore(f.cache,()=>at+1000);
    const initial=await f.store.save({id:null,expectedRevision:null,input:input()});
    await second.save({id:initial.id,expectedRevision:1,input:{...input(),name:'External edit'}});
    await expect(f.store.save({id:initial.id,expectedRevision:1,input:input()})).rejects.toThrow(/변경/);
    expect(await f.store.list()).toMatchObject([{revision:2,input:{name:'External edit'}}]);
  });
  it('detaches queued request values and returned records from saved state',async()=>{
    const state=memory(),store=createProjectDraftStore(state.storage,()=>at),request={id:null,expectedRevision:null,input:input()};
    const saving=store.save(request);request.input.name='Mutated while queued';request.input.repositories[0].workspace.path='Mutated';
    const created=await saving;created.input.name='Mutated return';
    const listed=await store.list();expect(listed[0].input).toEqual(input());listed[0].input.repositories.splice(0);
    expect((await store.list())[0].input.repositories).toHaveLength(2);
  });
  it('retains last-good data and exposes write failure instead of an in-memory success',async()=>{
    const state=memory(),store=createProjectDraftStore(state.storage,()=>at);
    const initial=await store.save({id:null,expectedRevision:null,input:input()});
    state.storage.write=vi.fn(async()=>{throw Error('Synthetic disk failure');});
    await expect(store.save({id:initial.id,expectedRevision:1,input:{...input(),name:'Unstored'}})).rejects.toThrow('Synthetic disk failure');
    expect(await store.list()).toEqual([initial]);
    await expect(createProjectDraftStore().list()).rejects.toThrow();
    await expect(createProjectDraftStore().save({id:null,expectedRevision:null,input:input()})).rejects.toThrow();
  });
  it('preserves corrupt or unsupported cache bytes and refuses to replace them',async()=>{
    const f=await fixture();await writeFile(f.filename,'{"broken":true}');
    await expect(f.store.list()).rejects.toThrow();await expect(f.store.save({id:null,expectedRevision:null,input:input()})).rejects.toThrow();
    expect(await readFile(f.filename,'utf8')).toBe('{"broken":true}');
  });
  it('refuses a symlink cache and leaves the synthetic target untouched',async()=>{
    const f=await fixture(),target=path.join(f.directory,'unrelated');await writeFile(target,'preserve');await symlink(target,f.filename);
    await expect(f.store.save({id:null,expectedRevision:null,input:input()})).rejects.toThrow();expect(await readFile(target,'utf8')).toBe('preserve');
  });
  it('caps draft count without silently evicting existing work',async()=>{
    const state=memory(),store=createProjectDraftStore(state.storage,()=>at);
    for(let i=0;i<PROJECT_DRAFT_LIMITS.drafts;i++)await store.save({id:null,expectedRevision:null,input:createEmptyProjectDraftInput()});
    await expect(store.save({id:null,expectedRevision:null,input:input()})).rejects.toThrow(/수/);
    expect(await store.list()).toHaveLength(PROJECT_DRAFT_LIMITS.drafts);
    const first=(await store.list())[0];await expect(store.save({id:first.id,expectedRevision:1,input:input()})).resolves.toMatchObject({revision:2});
  });
  it('bounds pending persistence requests while a disk operation is stalled',async()=>{
    vi.useFakeTimers();const state=memory();state.storage.read=vi.fn(()=>new Promise<never>(()=>{}));
    const store=createProjectDraftStore(state.storage,()=>at);
    const pending=Array.from({length:32},()=>store.list()),settled=Promise.allSettled(pending);
    await expect(store.list()).rejects.toThrow(/너무 많/);
    await vi.advanceTimersByTimeAsync(5001);expect((await settled).every(result=>result.status==='rejected')).toBe(true);
    expect(state.storage.read).toHaveBeenCalledOnce();
  });
  it.each(['read','write'] as const)('aborts and fails closed after a timed-out %s, without starting another operation',async operation=>{
    vi.useFakeTimers();let signal:AbortSignal|undefined;
    const state=memory();state.storage[operation]=vi.fn((...args:unknown[])=>{signal=args.at(-1) as AbortSignal;return new Promise<never>(()=>{});});
    const store=createProjectDraftStore(state.storage,()=>at);
    const pending=store.save({id:null,expectedRevision:null,input:input()});
    const rejected=expect(pending).rejects.toThrow(/응답/);
    await vi.advanceTimersByTimeAsync(5001);await rejected;
    expect(signal?.aborted).toBe(true);const calls=vi.mocked(state.storage[operation]).mock.calls.length;
    await expect(store.list()).rejects.toThrow(/사용/);expect(state.storage[operation]).toHaveBeenCalledTimes(calls);
  });
});
