import {afterEach,describe,expect,it,vi} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEmptyProjectDraftInput,type ProjectDraft} from '../../src/shared/project-draft';
import {PROJECT_DAG_LIMITS,parseConfirmProjectDagRequest,parseCancelProjectDagRequest,type ProjectDagPreview} from '../../src/shared/project-dag';
import {createProjectDagCreation,type ProjectDagValidatedSource} from '../../src/main/project-dag';
import {createProjectDagWriter,type ProjectDagWriter,type ProjectDagDirectorySnapshot,type ProjectDagWriteReceipt} from '../../src/main/project-dag-writer';

const id='project-draft-12345678-1234-4234-8234-123456789abc',at=Date.parse('2026-01-01T12:00:00.000Z');
const request={draftId:id,expectedDraftRevision:1};
const directoryPath='/synthetic/vault/example/demo/project-a';
function draft():ProjectDraft {
  const input=createEmptyProjectDraftInput();input.name='Synthetic project';
  input.instructions={mode:'custom',source:'',sourceRevision:'',text:'Custom instructions',additional:''};
  input.repositories=[{name:'example/demo',path:'/synthetic/repo',workspace:{mode:'existing',worktreeId:'tree',path:'/synthetic/tree',branch:'topic'}}];
  return {id,revision:1,updatedAt:new Date(at).toISOString(),input};
}
function source():ProjectDagValidatedSource {
  return {revision:'source-revision',draftId:id,draftRevision:1,repositoryPath:'/synthetic/repo',workspacePath:'/synthetic/tree',
    repo:'example/demo',projectPath:'example/demo/project-a',noteDir:'docs/note',baseBranch:'main',verification:['npm test'],decidedAt:'2026-01-01'};
}
function directory():ProjectDagDirectorySnapshot {
  return {directory:directoryPath,dev:'1',ino:'2',uid:1000,mode:0o40700,targetState:'absent',inspectedAt:new Date(at).toISOString()};
}
function fixture(){
  let time=at;
  const current=draft(),validated=source();
  const readDraft=vi.fn(async(_id:string,_signal:AbortSignal)=>structuredClone(current));
  const resolveSource=vi.fn(async(_draft:ProjectDraft,_signal:AbortSignal)=>structuredClone(validated));
  const pickDirectory=vi.fn(async(_draft:ProjectDraft,_source:ProjectDagValidatedSource,_signal:AbortSignal):Promise<string|null>=>directoryPath);
  const inspect=vi.fn(async(_directory:string,_signal?:AbortSignal)=>directory());
  const publish=vi.fn(async(value:Parameters<ProjectDagWriter['publish']>[0],_signal?:AbortSignal):Promise<ProjectDagWriteReceipt>=>({
    state:value.previousReceipt?'already-created':'created',targetPath:directoryPath+'/dag.yaml',contentHash:value.contentHash,publicationId:value.publicationId,
    directoryDev:'1',directoryIno:'2',targetDev:'1',targetIno:'3',targetUid:1000,targetSize:Buffer.byteLength(value.content),
    targetCtimeNs:'100',targetMtimeNs:'100',createdAt:new Date(at).toISOString(),
  }));
  const writer:ProjectDagWriter={inspect,publish};
  const creation=createProjectDagCreation({readDraft,resolveSource,pickDirectory,writer,now:()=>time});
  return {current,validated,readDraft,resolveSource,pickDirectory,inspect,publish,creation,setTime:(next:number)=>{time=next;}};
}
async function prepare(f:ReturnType<typeof fixture>):Promise<ProjectDagPreview & {previewId:string}> {
  const result=await f.creation.prepare(request);expect(result.state).toBe('preview');
  if(result.state!=='preview'||!result.preview.previewId)throw Error('Expected confirmation preview');
  return result.preview as ProjectDagPreview & {previewId:string};
}
const confirmation=(p:ProjectDagPreview & {previewId:string})=>({previewId:p.previewId,expectedContentHash:p.contentHash});
const roots:string[]=[];
afterEach(async()=>{vi.useRealTimers();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

describe('Phase3 exact EMPTY DAG creation boundary',()=>{
  it('accepts only an opaque preview ID and exact content hash for confirmation',()=>{
    const value={previewId:'project-dag-preview-12345678-1234-4234-8234-123456789abc',expectedContentHash:'a'.repeat(64)};
    expect(parseConfirmProjectDagRequest(value)).toEqual(value);
    expect(parseCancelProjectDagRequest({previewId:value.previewId})).toEqual({previewId:value.previewId});
    for(const bad of [{...value,path:directoryPath},{...value,content:'{}'},{...value,receipt:{}},{...value,expectedContentHash:'bad'},{...value,previewId:'../../path'},null])expect(()=>parseConfirmProjectDagRequest(bad)).toThrow();
  });
  it('prepares exact target/content/hash only after source validation and native directory choice',async()=>{
    const f=fixture(),p=await prepare(f);
    expect(p).toMatchObject({targetPath:directoryPath+'/dag.yaml',targetState:'absent',publication:{state:'confirmation-required'},registration:{state:'not-registered'}});
    expect(p.previewId).toMatch(/^project-dag-preview-/);expect(f.publish).not.toHaveBeenCalled();
    expect(f.pickDirectory).toHaveBeenCalledOnce();expect(f.inspect).toHaveBeenCalledWith(directoryPath,expect.any(AbortSignal));
    expect(f.resolveSource.mock.invocationCallOrder[0]).toBeLessThan(f.pickDirectory.mock.invocationCallOrder[0]);
    expect(f.creation.cleanupState()).toEqual({pending:false,unverified:false});
  });
  it('writes once after exact confirmation and returns created without registration or draft changes',async()=>{
    const f=fixture(),before=structuredClone(f.current),p=await prepare(f);
    expect(await f.creation.confirm(confirmation(p))).toEqual({state:'created',targetPath:p.targetPath,contentHash:p.contentHash,draftId:id,draftRevision:1,registration:{state:'not-registered'}});
    expect(f.publish).toHaveBeenCalledOnce();expect(f.publish.mock.calls[0][0]).toEqual({directory:directory(),content:p.content,contentHash:p.contentHash,publicationId:p.previewId});
    expect(f.current).toEqual(before);expect(f.creation.cleanupState()).toEqual({pending:false,unverified:false});
  });
  it('reconciles a repeated confirmation only by passing the exact main-owned receipt',async()=>{
    const f=fixture(),p=await prepare(f);
    expect((await f.creation.confirm(confirmation(p))).state).toBe('created');
    expect((await f.creation.confirm(confirmation(p))).state).toBe('already-created');
    const second=f.publish.mock.calls[1][0];expect(second.previousReceipt).toMatchObject({publicationId:p.previewId,targetIno:'3',contentHash:p.contentHash});
  });
  it('rejects wrong hashes, unknown tickets and caller supplied ownership without writing',async()=>{
    const f=fixture(),p=await prepare(f);
    expect(await f.creation.confirm({...confirmation(p),expectedContentHash:'0'.repeat(64)})).toMatchObject({state:'unavailable',reason:'preview_changed',outcome:'not-created'});
    expect(await f.creation.confirm({...confirmation(p),previewId:'project-dag-preview-22345678-1234-4234-8234-123456789abc'})).toMatchObject({state:'unavailable',reason:'preview_changed'});
    await expect(f.creation.confirm({...confirmation(p),receipt:{targetIno:'3'}})).rejects.toThrow();expect(f.publish).not.toHaveBeenCalled();
  });
  it('cannot publish mutated returned preview bytes because only the main-owned original is used',async()=>{
    const f=fixture(),p=await prepare(f),original=p.content;
    p.content='{"phases":["injected"]}';p.targetPath='/synthetic/elsewhere/evil.yaml';
    expect((await f.creation.confirm(confirmation(p))).state).toBe('created');
    expect(f.publish.mock.calls[0][0].content).toBe(original);expect(f.publish.mock.calls[0][0].directory.directory).toBe(directoryPath);
  });
  it('rejects an expired preview even when its bytes are unchanged',async()=>{
    const f=fixture(),p=await prepare(f);f.setTime(at+PROJECT_DAG_LIMITS.previewLifetimeMs);
    expect(await f.creation.confirm(confirmation(p))).toMatchObject({state:'unavailable',reason:'preview_expired'});expect(f.publish).not.toHaveBeenCalled();
  });
  it('invalidates an earlier ticket when a new preview begins',async()=>{
    const f=fixture(),first=await prepare(f),second=await prepare(f);expect(first.previewId).not.toBe(second.previewId);
    expect(await f.creation.confirm(confirmation(first))).toMatchObject({state:'unavailable',reason:'preview_changed'});
    expect((await f.creation.confirm(confirmation(second))).state).toBe('created');
  });
  it.each(['draft','source'] as const)('revalidates %s after the native picker returns',async which=>{
    const f=fixture();f.pickDirectory.mockImplementationOnce(async()=>{if(which==='draft')f.current.input.name='Changed';else f.validated.revision='Changed';return directoryPath;});
    expect(await f.creation.prepare(request)).toMatchObject({state:'unavailable',reason:which==='draft'?'draft_changed':'source_changed'});expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(['draft','source'] as const)('revalidates %s again immediately before publishing',async which=>{
    const f=fixture(),p=await prepare(f);if(which==='draft')f.current.input.instructions.text='Changed';else f.validated.baseBranch='changed';
    expect(await f.creation.confirm(confirmation(p))).toMatchObject({state:'unavailable',reason:which==='draft'?'draft_changed':'source_changed',outcome:'not-created'});
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('requires the native directory to end with the exact reviewed logical project path',async()=>{
    for(const picked of ['/synthetic/vault/other/project-a','/synthetic/vault/example/demo/project-ab','/synthetic/vault/example/demo/project-a/extra','/synthetic/vault/example/demo/../project-a']){
      const f=fixture();f.pickDirectory.mockResolvedValueOnce(picked);
      expect(await f.creation.prepare(request)).toMatchObject({state:'unavailable',reason:'invalid_destination'});expect(f.inspect).not.toHaveBeenCalled();
    }
  });
  it('does not treat Cancel or missing source validation as file creation',async()=>{
    const f=fixture();f.pickDirectory.mockResolvedValueOnce(null);
    expect(await f.creation.prepare(request)).toEqual({state:'unavailable',reason:'cancelled'});expect(f.inspect).not.toHaveBeenCalled();
    f.resolveSource.mockResolvedValueOnce(null!);
    expect(await f.creation.prepare(request)).toEqual({state:'unavailable',reason:'source_validation_unavailable'});expect(f.pickDirectory).toHaveBeenCalledOnce();
  });
  it('preserves finite source-validator reason codes without exposing source exception bodies',async()=>{
    const f=fixture();f.resolveSource.mockRejectedValueOnce(Object.assign(Error('Private repository details'),{reason:'invalid_source'}));
    expect(await f.creation.prepare(request)).toEqual({state:'unavailable',reason:'invalid_source'});expect(f.pickDirectory).not.toHaveBeenCalled();
    f.resolveSource.mockRejectedValueOnce(Object.assign(Error('Private repository details'),{reason:'arbitrary-sensitive-string'}));
    expect(await f.creation.prepare(request)).toEqual({state:'unavailable',reason:'target_unavailable'});
  });
  it('does not put native-picker human decision time inside the five-second IO deadline',async()=>{
    vi.useFakeTimers();const f=fixture();let release:(value:string)=>void=()=>{};
    f.pickDirectory.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.creation.prepare(request);await vi.advanceTimersByTimeAsync(0);expect(f.pickDirectory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);expect(f.creation.cleanupState().pending).toBe(true);
    expect(await f.creation.prepare(request)).toEqual({state:'unavailable',reason:'busy'});
    release(directoryPath);expect((await pending).state).toBe('preview');
  });
  it('cancels only the matching preview and never writes after cancellation',async()=>{
    const f=fixture(),p=await prepare(f);
    f.creation.cancel({previewId:'project-dag-preview-22345678-1234-4234-8234-123456789abc'});
    f.creation.cancel({previewId:p.previewId});
    expect(await f.creation.confirm(confirmation(p))).toMatchObject({state:'unavailable',reason:'preview_changed'});expect(f.publish).not.toHaveBeenCalled();
  });
  it('preserves explicit not-created writer failures without claiming success',async()=>{
    const f=fixture(),p=await prepare(f);f.publish.mockRejectedValueOnce(Object.assign(Error('Target already exists'),{outcome:'not-created'}));
    expect(await f.creation.confirm(confirmation(p))).toEqual({state:'unavailable',reason:'publication_failed',outcome:'not-created'});
    expect(f.creation.cleanupState()).toEqual({pending:false,unverified:false});
  });
  it('permanently retires uncertain writes and never retries by hash or replaces the target',async()=>{
    const f=fixture(),p=await prepare(f);f.publish.mockRejectedValueOnce(Object.assign(Error('Interrupted after link'),{outcome:'uncertain'}));
    expect(await f.creation.confirm(confirmation(p))).toEqual({state:'unavailable',reason:'publication_unverified',outcome:'uncertain'});
    expect(f.creation.cleanupState()).toEqual({pending:false,unverified:true});
    expect(await f.creation.confirm(confirmation(p))).toMatchObject({state:'unavailable',outcome:'uncertain'});expect(f.publish).toHaveBeenCalledOnce();
    expect(await f.creation.prepare(request)).toMatchObject({state:'unavailable',reason:'cancelled'});
  });
  it('treats a mismatched writer receipt as uncertain and never reports registration',async()=>{
    const f=fixture(),p=await prepare(f),original=f.publish.getMockImplementation()!;
    f.publish.mockImplementationOnce(async(...args)=>({...await original(...args),contentHash:'0'.repeat(64)}));
    expect(await f.creation.confirm(confirmation(p))).toMatchObject({state:'unavailable',reason:'publication_unverified',outcome:'uncertain'});
    expect(f.creation.cleanupState().unverified).toBe(true);
  });
  it('tracks late writer cleanup after timeout and does not turn a late success into acknowledged creation',async()=>{
    vi.useFakeTimers();const f=fixture(),p=await prepare(f),original=f.publish.getMockImplementation()!;let release:()=>void=()=>{};
    f.publish.mockImplementationOnce(async(...args)=>{await new Promise<void>(resolve=>{release=resolve;});return original(...args);});
    const pending=f.creation.confirm(confirmation(p));await vi.advanceTimersByTimeAsync(0);expect(f.publish).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PROJECT_DAG_LIMITS.timeoutMs+1);
    expect(await pending).toEqual({state:'unavailable',reason:'publication_unverified',outcome:'uncertain'});
    expect(f.creation.cleanupState()).toEqual({pending:true,unverified:true});
    let settled=false;void f.creation.settle().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);
    release();await f.creation.settle();expect(f.creation.cleanupState()).toEqual({pending:false,unverified:true});
  });
  it('disposal during a native picker prevents every subsequent filesystem operation',async()=>{
    const f=fixture();let release:(value:string)=>void=()=>{};f.pickDirectory.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.creation.prepare(request);await vi.waitFor(()=>expect(f.pickDirectory).toHaveBeenCalledOnce());f.creation.dispose();
    expect(await pending).toEqual({state:'unavailable',reason:'cancelled'});release(directoryPath);await f.creation.settle();
    expect(f.inspect).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled();expect(f.creation.cleanupState().unverified).toBe(false);
  });
});

describe.skipIf(process.platform==='win32'||!existsSync('/usr/bin/python3'))('EMPTY DAG native writer and controller integration with temporary synthetic files',()=>{
  async function nativeFixture(){
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'phase3-dag-create-')));roots.push(root);
    const directory=path.join(root,'example','demo','project-a');await mkdir(directory,{recursive:true,mode:0o700});
    const current=draft(),before=structuredClone(current),writer=createProjectDagWriter({pythonPath:'/usr/bin/python3',now:()=>at});
    const creation=createProjectDagCreation({readDraft:async()=>structuredClone(current),resolveSource:async()=>source(),pickDirectory:async()=>directory,writer,now:()=>at});
    const response=await creation.prepare(request);expect(response.state).toBe('preview');
    if(response.state!=='preview')throw Error('Expected real file preparation');
    return {root,directory,current,before,creation,preview:response.preview,target:path.join(directory,'dag.yaml')};
  }
  it('creates exactly the previewed bytes after confirmation, with owned idempotent replay',async()=>{
    const f=await nativeFixture();expect(await readdir(f.directory)).toEqual([]);
    const result=await f.creation.confirm(confirmation(f.preview));expect(result.state).toBe('created');
    expect(await readFile(f.target,'utf8')).toBe(f.preview.content);
    const doc=JSON.parse(await readFile(f.target,'utf8'));expect(doc).toMatchObject({schema:2,legacy:false,rounds:[],phases:[]});
    expect(doc.project_policy.map((p:{key:string})=>p.key)).toEqual(['base_branch','verification','project_instructions']);
    expect(await readdir(f.directory)).toEqual(['dag.yaml']);expect(f.current).toEqual(f.before);
    expect((await f.creation.confirm(confirmation(f.preview))).state).toBe('already-created');
    expect(f.creation.cleanupState()).toEqual({pending:false,unverified:false});
  });
  it.each(['file','symlink'])('preserves a concurrent %s created between preview and confirmation',async kind=>{
    const f=await nativeFixture();
    if(kind==='file')await writeFile(f.target,'External content');
    else {const target=path.join(f.root,'untouched');await writeFile(target,'External content');await symlink(target,f.target);}
    expect(await f.creation.confirm(confirmation(f.preview))).toEqual({state:'unavailable',reason:'publication_failed',outcome:'not-created'});
    expect(await readFile(f.target,'utf8')).toBe('External content');expect(await readdir(f.directory)).toEqual(['dag.yaml']);
  });
  it('cancellation leaves the selected temporary directory empty',async()=>{
    const f=await nativeFixture();f.creation.cancel({previewId:f.preview.previewId});
    expect(await f.creation.confirm(confirmation(f.preview))).toMatchObject({state:'unavailable',reason:'preview_changed'});
    expect(await readdir(f.directory)).toEqual([]);
  });
});
