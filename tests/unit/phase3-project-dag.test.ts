import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createEmptyProjectDraftInput,type ProjectDraft} from '../../src/shared/project-draft';
import {PROJECT_DAG_LIMITS,parsePrepareProjectDagRequest} from '../../src/shared/project-dag';
import {createEmptyProjectDagPreview,createProjectDagPreparer,type ProjectDagValidatedSource,type ProjectDagPickedDestination} from '../../src/main/project-dag';
import {projectDagQuery} from '../../src/facts/dag-read-model/projection';

const id='project-draft-12345678-1234-4234-8234-123456789abc';
const at=Date.parse('2026-01-01T12:00:00.000Z');
const request={draftId:id,expectedDraftRevision:1};
const digest=(content:string)=>createHash('sha256').update(content,'utf8').digest('hex');
function draft():ProjectDraft {
  const input=createEmptyProjectDraftInput();
  input.name='Synthetic project';input.description='Entered project description';
  input.instructions={mode:'custom',source:'',sourceRevision:'',text:'custom instruction text',additional:''};
  input.noteLocation='/synthetic/entered-note-metadata';
  input.repositories=[{name:'Entered repository label',path:'/synthetic/repo',workspace:{mode:'existing',worktreeId:'synthetic-tree',path:'/synthetic/worktree',branch:'workspace-topic'}}];
  return {id,revision:1,updatedAt:new Date(at).toISOString(),input};
}
function source():ProjectDagValidatedSource {
  return {revision:'synthetic-main-validation-v1',draftId:id,draftRevision:1,
    repositoryPath:'/synthetic/repo',workspacePath:'/synthetic/worktree',repo:'example/demo',
    projectPath:'example/demo/project-a',noteDir:'docs/note',baseBranch:'feature/synthetic-integration',
    verification:['npm run typecheck','npm test'],decidedAt:'2026-01-01'};
}
function destination():ProjectDagPickedDestination {return {selectionId:'synthetic-native-selection',targetPath:'/synthetic/selected/task-DAG.yaml'};}
function fixture(){
  const current=draft(),validated=source(),selected=destination();
  const readDraft=vi.fn(async(_id:string,_signal:AbortSignal)=>structuredClone(current)),resolveSource=vi.fn(async(_draft:ProjectDraft,_signal:AbortSignal)=>structuredClone(validated)),resolveDestination=vi.fn(async(_draft:ProjectDraft,_signal:AbortSignal)=>structuredClone(selected));
  const preparer=createProjectDagPreparer({readDraft,resolveSource,resolveDestination,now:()=>at});
  return {current,validated,selected,readDraft,resolveSource,resolveDestination,preparer};
}
afterEach(()=>{vi.useRealTimers();});

describe('Phase3 EMPTY DAG request boundary',()=>{
  it('accepts only a persisted draft ID and exact expected revision',()=>{
    expect(parsePrepareProjectDagRequest(request)).toEqual(request);
    expect(parsePrepareProjectDagRequest(Object.assign(Object.create(null),request))).toEqual(request);
  });
  it.each([
    null,[],{}, {...request,draftId:'../../arbitrary'}, {...request,expectedDraftRevision:0},
    {...request,expectedDraftRevision:1.5},{...request,expectedDraftRevision:Number.MAX_SAFE_INTEGER},
    {...request,targetPath:'/synthetic/arbitrary.yaml'},{...request,metadata:source()},
    {...request,content:'{}'},{...request,verified:true},{...request,confirmed:true},
  ])('rejects malformed or authority-bearing requests',value=>expect(()=>parsePrepareProjectDagRequest(value)).toThrow());
  it('rejects getters, custom prototypes and symbol fields without invoking them',()=>{
    const get=vi.fn(()=>id),value={...request};Object.defineProperty(value,'draftId',{get,enumerable:true});
    expect(()=>parsePrepareProjectDagRequest(value)).toThrow();expect(get).not.toHaveBeenCalled();
    expect(()=>parsePrepareProjectDagRequest(Object.assign(Object.create({}),request))).toThrow();
    expect(()=>parsePrepareProjectDagRequest({...request,[Symbol('path')]:'/synthetic/other'})).toThrow();
  });
});

describe('Phase3 EMPTY DAG pure preview',()=>{
  it('emits the exact single-repository schema2 contract with empty rounds and phases',()=>{
    const p=createEmptyProjectDagPreview(draft(),source(),destination(),at);
    const expected={schema:2,legacy:false,
      project:{repo:'example/demo',project_path:'example/demo/project-a',note_dir:'docs/note'},
      project_policy:[
        {key:'base_branch',decided_at:'2026-01-01',decision:'feature/synthetic-integration',legacy:false},
        {key:'verification',decided_at:'2026-01-01',decision:['npm run typecheck','npm test'],legacy:false},
        {key:'project_instructions',decided_at:'2026-01-01',decision:'custom instruction text',legacy:false},
      ],rounds:[],phases:[]};
    expect(p.content).toBe(JSON.stringify(expected,null,2)+'\n');
    expect(p.contentHash).toBe(digest(p.content));expect(p.byteLength).toBe(Buffer.byteLength(p.content,'utf8'));
    expect(p.draftHash).toBe(digest(JSON.stringify(draft())));
    expect(p).toMatchObject({targetPath:destination().targetPath,targetState:'not-checked',
      createdAt:'2026-01-01T12:00:00.000Z',expiresAt:'2026-01-01T12:02:00.000Z',
      publication:{state:'unavailable',reasons:['safe-no-replace-writer-unavailable','fresh-filesystem-validation-required']},
      registration:{state:'not-registered'},summary:{tasks:0,phases:0,rounds:0,execution:'not-started',completion:'not-evaluated'}});
    expect(p.content).not.toContain('workspace-topic');expect(p.content).not.toContain('Entered repository label');
    expect(p.content).not.toContain('Entered project description');expect(p.content).not.toContain('context.md');
  });
  it('preserves custom instruction text exactly as policy data, with UTF-8 hash/size',()=>{
    const d=draft();d.input.instructions.text='  지침\n\tNever run this automatically\n';
    const p=createEmptyProjectDagPreview(d,source(),destination(),at);
    expect(JSON.parse(p.content).project_policy[2].decision).toBe(d.input.instructions.text);
    expect(p.contentHash).toBe(digest(p.content));expect(p.byteLength).toBeGreaterThan(p.content.length);
    expect(createEmptyProjectDagPreview(d,source(),destination(),at).content).toBe(p.content);
  });
  it('uses explicit authoritative fields without inferring base branch or target from the draft',()=>{
    const d=draft();d.input.noteLocation='/synthetic/untrusted-note-path';d.input.repositories[0].name='wrong/repository';
    d.input.repositories[0].workspace.branch='unverified-other-branch';
    const p=createEmptyProjectDagPreview(d,source(),destination(),at),parsed=JSON.parse(p.content);
    expect(parsed.project.repo).toBe('example/demo');expect(parsed.project_policy[0].decision).toBe(source().baseBranch);
    expect(p.targetPath).toBe(destination().targetPath);
  });
  it('keeps an explicitly planned new workspace as metadata without creating it',()=>{
    const d=draft();d.input.repositories[0].workspace={mode:'new',worktreeId:'',path:'/synthetic/worktree',branch:'future-work'};
    const p=createEmptyProjectDagPreview(d,source(),destination(),at);
    expect(JSON.parse(p.content).phases).toEqual([]);expect(p.registration.state).toBe('not-registered');
    expect(p.targetState).toBe('not-checked');
  });
  it.each([0,2])('rejects %i repositories without flattening or changing any draft data',count=>{
    const d=draft();d.input.repositories=Array.from({length:count},()=>structuredClone(draft().input.repositories[0]));
    const before=structuredClone(d);expect(()=>createEmptyProjectDagPreview(d,source(),destination(),at)).toThrow('single_repository_required');
    expect(d).toEqual(before);
  });
  it('does not invent inheritance, source precedence or additional-instruction composition',()=>{
    const inherited=draft();inherited.input.instructions={mode:'inherit',source:'captured-source',sourceRevision:'captured-revision',text:'Captured text',additional:''};
    expect(()=>createEmptyProjectDagPreview(inherited,source(),destination(),at)).toThrow('custom_instructions_required');
    const additional=draft();additional.input.instructions.additional='Append this';
    expect(()=>createEmptyProjectDagPreview(additional,source(),destination(),at)).toThrow('additional_instructions_unresolved');
    const empty=draft();empty.input.instructions.text=' \n';
    expect(()=>createEmptyProjectDagPreview(empty,source(),destination(),at)).toThrow('custom_instructions_required');
  });
  it.each([
    {draftId:'project-draft-22345678-1234-4234-8234-123456789abc'},{draftRevision:2},
    {repositoryPath:'/synthetic/other'},{workspacePath:'/synthetic/other'},
  ])('rejects source evidence bound to a different draft or repository/workspace',patch=>{
    expect(()=>createEmptyProjectDagPreview(draft(),{...source(),...patch},destination(),at)).toThrow('source_changed');
  });
  it.each([
    {revision:''},{repo:''},{repo:'repo'},{repo:'owner/repo/extra'},
    {projectPath:'elsewhere/project-a'},{projectPath:'example/demo/../escape'},{projectPath:'example/demo'},
    {noteDir:'/synthetic/absolute'},{noteDir:'docs/../note'},{noteDir:'docs//note'},{noteDir:'docs\\note'},
    {baseBranch:''},{baseBranch:'main..other'},{baseBranch:'main other'},{baseBranch:'refs/.hidden'},
    {baseBranch:'refs/heads/test.lock'},{baseBranch:'-flag'},{baseBranch:'topic@{2}'},
    {verification:[]},{verification:['']},{verification:['line\nbreak']},{verification:new Array(2)},
    {verification:Array.from({length:33},()=> 'npm test')},{verification:['x'.repeat(2049)]},
    {decidedAt:'2026-02-30'},{decidedAt:'2026-1-01'},{decidedAt:'yesterday'},
  ])('rejects unsupported or malformed explicit source metadata',patch=>{
    expect(()=>createEmptyProjectDagPreview(draft(),{...source(),...patch},destination(),at)).toThrow();
  });
  it('rejects source accessors, extra claims and verification accessors without executing them',()=>{
    const s=source(),get=vi.fn(()=>s.repo);Object.defineProperty(s,'repo',{get,enumerable:true});
    expect(()=>createEmptyProjectDagPreview(draft(),s,destination(),at)).toThrow();expect(get).not.toHaveBeenCalled();
    expect(()=>createEmptyProjectDagPreview(draft(),{...source(),verified:true} as ProjectDagValidatedSource,destination(),at)).toThrow();
    const array=source();const getter=vi.fn(()=> 'npm test');Object.defineProperty(array.verification,'0',{get:getter,enumerable:true});
    expect(()=>createEmptyProjectDagPreview(draft(),array,destination(),at)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it.each(['relative.yaml','/synthetic/../elsewhere.yaml','/synthetic//dag.yaml','/synthetic/context.md','/synthetic/dag.json','/synthetic/dir/','/synthetic/unsafe\n.yaml','/'])('rejects unsupported destination %s',targetPath=>{
    expect(()=>createEmptyProjectDagPreview(draft(),source(),{...destination(),targetPath},at)).toThrow('invalid_destination');
  });
  it('rejects forged destination fields and missing native selection identity',()=>{
    expect(()=>createEmptyProjectDagPreview(draft(),source(),{...destination(),selectionId:''},at)).toThrow('invalid_destination');
    expect(()=>createEmptyProjectDagPreview(draft(),source(),{...destination(),verified:true} as ProjectDagPickedDestination,at)).toThrow('invalid_destination');
  });
  it('bounds total UTF-8 bytes without truncating text or verification instructions',()=>{
    const d=draft();d.input.instructions.text='한'.repeat(32000);
    const s=source();s.verification=Array.from({length:32},()=> 'x'.repeat(2048));
    expect(()=>createEmptyProjectDagPreview(d,s,destination(),at)).toThrow('content_limit');
  });
  it('also enforces the versioned reader per-policy JSON envelope before any file can be proposed',()=>{
    const d=draft();d.input.instructions.text='x\n'.repeat(16000);
    expect(()=>createEmptyProjectDagPreview(d,source(),destination(),at)).toThrow('content_limit');
    const s=source();s.verification=Array.from({length:32},()=> 'x'.repeat(2048));
    expect(()=>createEmptyProjectDagPreview(draft(),s,destination(),at)).toThrow('content_limit');
  });
  it('never turns an empty read-model projection into passed or completed work',()=>{
    const p=createEmptyProjectDagPreview(draft(),source(),destination(),at),doc=JSON.parse(p.content);
    // This tests local projection only; it does not substitute for the external pinned query.
    const projected=projectDagQuery({index:[],coverage:{tasks_total:0,declared:0,required:0,uncovered_done:[],uncovered_open:[],malformed:[]},
      readContractVersion:2,details:[],phases:doc.phases,policies:doc.project_policy});
    expect(projected.tasks).toEqual([]);expect(projected.statusCounts).toEqual([]);expect(projected.coverage.tasksTotal).toBe(0);
    expect(projected.policies).toEqual(doc.project_policy);expect(p.summary.completion).toBe('not-evaluated');
  });
  it('has no filesystem, subprocess, model or registration dependencies',async()=>{
    const text=await readFile(new URL('../../src/main/project-dag.ts',import.meta.url),'utf8');
    const imports=text.split('\n').filter(line=>line.startsWith('import ')).join('\n');
    expect(imports).not.toMatch(/node:fs|child_process|electron|registry|model|context/);
    const preparer=createProjectDagPreparer({readDraft:async()=>draft()});
    expect(Object.keys(preparer).sort()).toEqual(['dispose','prepare']);
  });
});

describe('Phase3 main-only preparation seam',()=>{
  it('fails closed before reading sources or asking for a destination when authority is missing',async()=>{
    const readDraft=vi.fn(async()=>draft()),resolveDestination=vi.fn(async()=>destination());
    expect(await createProjectDagPreparer({readDraft,resolveDestination}).prepare(request)).toEqual({state:'unavailable',reason:'source_validation_unavailable'});
    expect(readDraft).not.toHaveBeenCalled();expect(resolveDestination).not.toHaveBeenCalled();
    expect(await createProjectDagPreparer({readDraft,resolveSource:async()=>source()}).prepare(request)).toEqual({state:'unavailable',reason:'destination_selection_unavailable'});
  });
  it('revalidates the persisted draft, source evidence and native selection before returning exact preview',async()=>{
    const f=fixture(),before=structuredClone(f.current),result=await f.preparer.prepare(request);
    expect(result).toEqual({state:'preview',preview:createEmptyProjectDagPreview(draft(),source(),destination(),at)});
    expect(f.readDraft).toHaveBeenCalledTimes(3);expect(f.resolveSource).toHaveBeenCalledTimes(2);expect(f.resolveDestination).toHaveBeenCalledTimes(2);
    expect(f.current).toEqual(before);
  });
  it('rejects nonexistent and stale saved drafts without invoking source resolution',async()=>{
    const f=fixture();f.readDraft.mockResolvedValueOnce(null!);
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'draft_unavailable'});
    f.current.revision=2;
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'draft_changed'});expect(f.resolveSource).not.toHaveBeenCalled();
  });
  it('rejects unsupported multiple repositories before touching source or destination adapters',async()=>{
    const f=fixture();f.current.input.repositories.push(structuredClone(f.current.input.repositories[0]));
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'single_repository_required'});
    expect(f.resolveSource).not.toHaveBeenCalled();expect(f.resolveDestination).not.toHaveBeenCalled();expect(f.current.input.repositories).toHaveLength(2);
  });
  it.each(['revision','content'] as const)('rejects a changed saved draft even when only %s changed',async change=>{
    const f=fixture();f.resolveDestination.mockImplementation(async()=>{if(change==='revision')f.current.revision=2;else f.current.input.name='Changed without revision';return destination();});
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'draft_changed'});
  });
  it('rejects a source changed after the first resolver call, including unchanged evidence labels',async()=>{
    const f=fixture();f.resolveSource.mockResolvedValueOnce(source()).mockResolvedValueOnce({...source(),verification:['npm run other']});
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'source_changed'});
  });
  it.each(['selectionId','targetPath'] as const)('rejects a changed destination %s',async field=>{
    const f=fixture();f.resolveDestination.mockResolvedValueOnce(destination()).mockResolvedValueOnce({...destination(),[field]:field==='selectionId'?'new-selection':'/synthetic/selected/other.yaml'});
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'destination_changed'});
  });
  it('detects a draft change during the final source/destination checks',async()=>{
    const f=fixture();let count=0;f.resolveDestination.mockImplementation(async()=>{if(++count===2)f.current.input.description='Changed at end';return destination();});
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'draft_changed'});
  });
  it('does not promote renderer mutations, resolver argument mutations or returned preview mutations',async()=>{
    const f=fixture(),caller={...request};f.resolveSource.mockImplementation(async value=>{value.input.name='Adapter changed its copy';return source();});
    const promise=f.preparer.prepare(caller);caller.expectedDraftRevision=2;
    const result=await promise;expect(result.state).toBe('preview');expect(f.current.input.name).toBe('Synthetic project');
    if(result.state==='preview')result.preview.content='Changed preview';
    const again=await f.preparer.prepare(request);expect(again.state).toBe('preview');
    if(again.state==='preview')expect(again.preview.content).not.toBe('Changed preview');
  });
  it('returns generic failures without disclosing arbitrary adapter exception contents',async()=>{
    const f=fixture();f.resolveSource.mockRejectedValueOnce(Error('Private path or source body'));
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'preparation_failed'});
    expect((await f.preparer.prepare(request)).state).toBe('preview');
  });
  it('rejects overlapping preparation while a bounded read is pending',async()=>{
    const f=fixture();let release:(value:ProjectDraft)=>void=()=>{};f.readDraft.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.preparer.prepare(request);expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'busy'});
    release(draft());expect((await pending).state).toBe('preview');
  });
  it('aborts timed-out adapters and retires instead of accumulating late reads or previews',async()=>{
    vi.useFakeTimers();const f=fixture();let signal:AbortSignal|undefined,release:(value:ProjectDraft)=>void=()=>{};
    f.readDraft.mockImplementationOnce((_id,s)=>{signal=s;return new Promise(resolve=>{release=resolve;});});
    const pending=f.preparer.prepare(request);await vi.advanceTimersByTimeAsync(PROJECT_DAG_LIMITS.timeoutMs+1);
    expect(await pending).toEqual({state:'unavailable',reason:'timeout'});expect(signal?.aborted).toBe(true);
    release(draft());await Promise.resolve();expect(f.resolveSource).not.toHaveBeenCalled();
    expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'cancelled'});expect(f.readDraft).toHaveBeenCalledOnce();
  });
  it('disposal cancels a pending preview and cannot later publish or resolve another source',async()=>{
    const f=fixture();let release:(value:ProjectDraft)=>void=()=>{};f.readDraft.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.preparer.prepare(request);f.preparer.dispose();
    expect(await pending).toEqual({state:'unavailable',reason:'cancelled'});release(draft());await Promise.resolve();
    expect(f.resolveSource).not.toHaveBeenCalled();expect(await f.preparer.prepare(request)).toEqual({state:'unavailable',reason:'cancelled'});
  });
});
