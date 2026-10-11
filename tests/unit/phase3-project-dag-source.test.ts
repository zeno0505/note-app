import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import type {FileHandle} from 'node:fs/promises';
import {promisify} from 'node:util';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createEmptyProjectDraftInput,type ProjectDraft} from '../../src/shared/project-draft';
import type {ProjectWorkspaceOption} from '../../src/shared/project-workspaces';
import {validateProjectDagSource,type ProjectDagSourceConfiguration,type ProjectDagSourceSettings} from '../../src/main/project-dag-source';
import * as gitReads from '../../src/collector/notes/link-workflow/git';
import {Budget,closeBounded} from '../../src/collector/notes/link-workflow/safe-io';

const exec=promisify(execFile);
const decisionDate='2026-10-08';
const gitEnv={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Synthetic Test',
  GIT_AUTHOR_EMAIL:'synthetic@example.invalid',GIT_COMMITTER_NAME:'Synthetic Test',GIT_COMMITTER_EMAIL:'synthetic@example.invalid'};
let root:string,checkout:string,git:string,draft:ProjectDraft,selected:ProjectWorkspaceOption;
let settings:ProjectDagSourceSettings,config:ProjectDagSourceConfiguration;
async function runGit(...args:string[]){return exec(git,['-c','core.hooksPath=/dev/null',...args],{env:gitEnv,timeout:5000});}
function validate(signal=new AbortController().signal){return validateProjectDagSource(draft,selected,settings,config,signal,decisionDate);}
function spyOnSpawn(){const spy=vi.spyOn(childProcess,'spawn');syncBuiltinESMExports();return spy;}
function pendingOperations(){
  const pending=new Set<Promise<unknown>>();
  const track=<T>(operation:Promise<T>):Promise<T>=>{
    pending.add(operation);void operation.then(()=>pending.delete(operation),()=>pending.delete(operation));return operation;
  };
  class TrackedBudget extends Budget {override trackOperation<T>(operation:Promise<T>):Promise<T>{return track(operation);}}
  return {pending,track,TrackedBudget};
}
function selectCheckout(p:string,branch:string|null='main'){
  selected.path=p;selected.branch=branch;
  draft.input.repositories[0].path=p;
  Object.assign(draft.input.repositories[0].workspace,{path:p,branch:branch??''});
}
async function files(directory:string):Promise<Record<string,string>>{
  const result:Record<string,string>={};
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const p=path.join(directory,entry.name);
    if(entry.isDirectory())for(const [child,bytes] of Object.entries(await files(p)))result[entry.name+'/'+child]=bytes;
    else if(entry.isSymbolicLink())result[entry.name]='link:'+await fs.readlink(p);
    else result[entry.name]=(await fs.readFile(p)).toString('base64');
  }
  return result;
}
beforeEach(async()=>{
  git=await fs.realpath((await exec('which',['git'])).stdout.trim());
  root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'project-dag-source-')));
  checkout=path.join(root,'checkout with spaces;$(touch NEVER)');
  await fs.mkdir(checkout);
  await runGit('init','--quiet','--initial-branch=main',checkout);
  await runGit('-C',checkout,'commit','--quiet','--allow-empty','-m','Synthetic fixture');
  await runGit('-C',checkout,'remote','add','origin','https://github.com/example/demo.git');
  const input=createEmptyProjectDraftInput();
  input.name='Synthetic display name';input.description='Synthetic project';
  input.instructions={mode:'custom',source:'',sourceRevision:'',text:'Synthetic instructions',additional:''};
  input.noteLocation=path.join(root,'unselected-metadata-only');
  input.repositories=[{name:'Untrusted display label',path:checkout,workspace:{mode:'existing',worktreeId:'synthetic-worktree',path:checkout,branch:'main'}}];
  draft={id:'project-draft-12345678-1234-4234-8234-123456789abc',revision:1,updatedAt:'2026-10-08T00:00:00.000Z',input};
  selected={optionId:'project-workspace-'+'1'.repeat(64),fingerprint:'2'.repeat(64),hostId:'synthetic-local',
    worktreeId:'synthetic-worktree',path:checkout,branch:'main',
    repository:{key:JSON.stringify(['synthetic-local','synthetic-repo']),id:'synthetic-repo',hostId:'synthetic-local',projectId:null,label:'Observed label'}};
  settings={projectPath:'example/demo/explicit-project',baseBranch:'main',verification:['npm run typecheck','npm test']};
  config={gitExecutablePath:git,allowedCommonGitDirs:[]};
});
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();syncBuiltinESMExports();if(root)await fs.rm(root,{recursive:true,force:true});});

describe('main-only single-repository source validation',()=>{
  it('derives canonical GitHub identity and an exact stable source without any writes',async()=>{
    const before=await files(root),original=structuredClone({draft,selected,settings,config});
    const result=await validate();
    expect(result).toMatchObject({draftId:draft.id,draftRevision:1,repositoryPath:checkout,workspacePath:checkout,
      repo:'example/demo',projectPath:'example/demo/explicit-project',noteDir:'docs/note',baseBranch:'main',
      verification:settings.verification,decidedAt:decisionDate});
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(await validate()).toEqual(result);
    expect({draft,selected,settings,config}).toEqual(original);
    expect(await files(root)).toEqual(before);
    expect(result.repo).not.toBe(draft.input.repositories[0].name);
  });
  it.each(['git@github.com:example/demo.git','ssh://git@github.com/example/demo.git',
    'ssh://github.com/example/demo','https://github.com/example/demo'])('accepts credential-free GitHub remote %s',async remote=>{
    await runGit('-C',checkout,'remote','set-url','origin',remote);
    expect((await validate()).repo).toBe('example/demo');
  });
  it.each(['https://token@github.com/example/demo.git','https://git:secret@github.com/example/demo.git',
    'https://github.com.example.invalid/example/demo.git','https://github.com:443/example/demo.git',
    'ssh://someone@github.com/example/demo.git','ssh://git:secret@github.com/example/demo.git',
    'git@github.com:example/demo.git?token=x','https://github.com/example/demo.git#fragment',
    'https://github.com/example/%2e%2e','https://github.com/example/demo/../other','git://github.com/example/demo',
    'ext::touch NEVER','../another-checkout'])('rejects unsupported or credential-bearing origin %s',async remote=>{
    await runGit('-C',checkout,'remote','set-url','origin',remote);
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
  });
  it.each(['worktreeId','path','branch'])('rejects a stale draft workspace %s before traversing the checkout',async field=>{
    draft.input.repositories[0].workspace[field as 'worktreeId'|'path'|'branch']='stale';
    const realpath=vi.spyOn(fs,'realpath');
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
    expect(realpath).not.toHaveBeenCalled();
  });
  it.each(['','/synthetic/arbitrary-saved-path'])('does not follow a saved repository path %s',async savedPath=>{
    draft.input.repositories[0].path=savedPath;
    const realpath=vi.spyOn(fs,'realpath');
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
    expect(realpath).not.toHaveBeenCalled();
  });
  it.each([0,2])('rejects %i repositories without flattening or reading sources',async count=>{
    draft.input.repositories=Array.from({length:count},()=>structuredClone(draft.input.repositories[0]));
    const realpath=vi.spyOn(fs,'realpath');
    await expect(validate()).rejects.toMatchObject({reason:'single_repository_required'});
    expect(realpath).not.toHaveBeenCalled();
  });
  it('rejects planned new workspaces, missing checkouts, non-root paths and symlink aliases',async()=>{
    draft.input.repositories[0].workspace.mode='new';
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
    draft.input.repositories[0].workspace.mode='existing';
    selectCheckout(path.join(root,'missing'));
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    const sub=path.join(checkout,'child');await fs.mkdir(sub);selectCheckout(sub);
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    const alias=path.join(root,'alias');await fs.symlink(checkout,alias,'dir');selectCheckout(alias);
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
  });
  it('detects an actual branch change despite stale runtime metadata',async()=>{
    await runGit('-C',checkout,'checkout','--quiet','-b','changed');
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
    selected.branch='changed';draft.input.repositories[0].workspace.branch='changed';
    expect((await validate()).baseBranch).toBe('main');
  });
  it('accepts an exact fully qualified observed branch while keeping the draft binding exact',async()=>{
    selected.branch='refs/heads/main';draft.input.repositories[0].workspace.branch='refs/heads/main';
    expect((await validate()).baseBranch).toBe('main');
    draft.input.repositories[0].workspace.branch='main';
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
  });
  it('rejects stale or non-head observed refs rather than loosely matching a suffix',async()=>{
    selected.branch='refs/heads/missing';draft.input.repositories[0].workspace.branch=selected.branch;
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
    selected.branch='refs/remotes/origin/main';draft.input.repositories[0].workspace.branch=selected.branch;
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
    selected.branch='refs/heads/main';draft.input.repositories[0].workspace.branch=selected.branch;
    await runGit('-C',checkout,'checkout','--quiet','--detach');
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
  });
  it('binds a verified detached HEAD only when the current observation is detached',async()=>{
    await runGit('-C',checkout,'checkout','--quiet','--detach');
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});
    selectCheckout(checkout,null);
    expect((await validate()).baseBranch).toBe('main');
  });
  it('requires a real local base branch, never infers one from the selected branch',async()=>{
    settings.baseBranch='missing';await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    settings.baseBranch='refs/heads/main';await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    await runGit('-C',checkout,'branch','integration');settings.baseBranch='integration';
    expect((await validate()).baseBranch).toBe('integration');
  });
  it.each(['../main','--help','main^{commit}','main@{1}','main:bad','main\nother','main.lock','main//topic','/main'])('rejects invalid base branch %s before Git runs',async branch=>{
    settings.baseBranch=branch;const realpath=vi.spyOn(fs,'realpath');
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});expect(realpath).not.toHaveBeenCalled();
  });
  it.each(['/example/demo/name','example/demo/../escape','example/demo/./name','example/demo/name/','example/demo//name',
    'example/demo/name\\escape','example/demo/ name','example/demo/C:drive','example/demo','other/demo/name'])('rejects an invalid logical project path %s',async projectPath=>{
    settings.projectPath=projectPath;await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
  });
  it('requires explicit verification and stores shell-looking text without running it',async()=>{
    settings.verification=[];await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    settings.verification=[`touch '${path.join(root,'VERIFICATION-MUST-NOT-RUN')}' && $(echo unsafe)`, 'Review manually'];
    const result=await validate();expect(result.verification).toEqual(settings.verification);
    await expect(fs.lstat(path.join(root,'VERIFICATION-MUST-NOT-RUN'))).rejects.toMatchObject({code:'ENOENT'});
    result.verification.push('changed');expect(settings.verification).toHaveLength(2);
  });
  it('ignores injected Git environment and disables configured filesystem monitors',async()=>{
    const marker=path.join(root,'MONITOR-MUST-NOT-RUN');
    await runGit('-C',checkout,'config','core.fsmonitor',`touch '${marker}'`);
    vi.stubEnv('GIT_DIR',path.join(root,'not-the-selected-git'));
    vi.stubEnv('GIT_CONFIG_COUNT','1');vi.stubEnv('GIT_CONFIG_KEY_0','remote.origin.url');vi.stubEnv('GIT_CONFIG_VALUE_0','https://github.com/foreign/repo');
    expect((await validate()).repo).toBe('example/demo');
    await expect(fs.lstat(marker)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('requires exact registered common metadata for a linked worktree',async()=>{
    const linked=path.join(root,'linked');await runGit('-C',checkout,'worktree','add','--quiet','-b','linked-topic',linked);
    selectCheckout(linked,'linked-topic');
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    config.allowedCommonGitDirs=[root];await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    config.allowedCommonGitDirs=[path.join(checkout,'.git')];
    expect(await validate()).toMatchObject({repositoryPath:linked,workspacePath:linked,repo:'example/demo',baseBranch:'main'});
  });
  it('rejects relocated ordinary metadata and metadata file symlinks',async()=>{
    const actual=path.join(root,'foreign-config');await fs.rename(path.join(checkout,'.git','config'),actual);
    await fs.symlink(actual,path.join(checkout,'.git','config'));
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    await fs.unlink(path.join(checkout,'.git','config'));await fs.rename(actual,path.join(checkout,'.git','config'));
    await fs.writeFile(path.join(checkout,'.git','commondir'),'../foreign\n');
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
  });
  it.each([
    '[include]\n path = OUTSIDE\n','[InClUdE]\n path = OUTSIDE\n','[includeIf "gitdir:CHECKOUT/"]\n path = OUTSIDE\n',
    '[includeif "onbranch:main"]\n path = OUTSIDE\n','[include.path]\n value = OUTSIDE\n',
    '[ include ]\n path = OUTSIDE\n','[include\t]\n path = OUTSIDE\n',
    '[inclu\\\nde]\n path = OUTSIDE\n','[inclu\\de]\n path = OUTSIDE\n',
    '[include "escaped\\\"subsection"]\n path = OUTSIDE\n','[includeIf.gitdir:CHECKOUT/]\n path = OUTSIDE\n',
    '[core]\n synthetic = value\\\n[include]\n path = OUTSIDE\n',
  ])('refuses indirect or ambiguous config before Git or target reads: %s',async addition=>{
    const outside=path.join(root,'outside-config');await fs.writeFile(outside,'[remote "origin"]\n url = https://github.com/example/demo.git\n');
    await runGit('-C',checkout,'remote','remove','origin');
    await fs.appendFile(path.join(checkout,'.git','config'),'\n'+addition.replaceAll('OUTSIDE',outside).replaceAll('CHECKOUT',checkout));
    const spawn=spyOnSpawn(),open=vi.spyOn(fs,'open');
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    expect(spawn).not.toHaveBeenCalled();expect(open.mock.calls.some(args=>args[0]===outside)).toBe(false);
  });
  it.each(['symlink','directory','oversized'])('refuses %s config before any Git invocation',async kind=>{
    const location=path.join(checkout,'.git','config'),outside=path.join(root,'outside-config');
    await fs.rename(location,outside);
    if(kind==='symlink')await fs.symlink(outside,location);
    if(kind==='directory')await fs.mkdir(location);
    if(kind==='oversized')await fs.writeFile(location,Buffer.alloc(1_048_577,32));
    const spawn=spyOnSpawn(),open=vi.spyOn(fs,'open');
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    expect(spawn).not.toHaveBeenCalled();expect(open.mock.calls.some(args=>args[0]===outside)).toBe(false);
  });
  it.each(['common','main-worktree','linked-worktree'])('guards linked %s config before the first Git read',async kind=>{
    const linked=path.join(root,'linked');await runGit('-C',checkout,'worktree','add','--quiet','-b','linked-topic',linked);
    const linkedGit=(await runGit('-C',linked,'rev-parse','--absolute-git-dir')).stdout.trim();
    await runGit('-C',checkout,'config','extensions.worktreeConfig','true');
    selectCheckout(linked,'linked-topic');config.allowedCommonGitDirs=[path.join(checkout,'.git')];
    const target=kind==='common'?path.join(checkout,'.git','config'):kind==='main-worktree'?
      path.join(checkout,'.git','config.worktree'):path.join(linkedGit,'config.worktree');
    const outside=path.join(root,'outside-config');await fs.writeFile(outside,'[core]\n filemode = true\n');
    await fs.appendFile(target,'\n[includeIf "gitdir:*"]\n path = '+outside+'\n');
    const spawn=spyOnSpawn(),open=vi.spyOn(fs,'open');
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    expect(spawn).not.toHaveBeenCalled();expect(open.mock.calls.some(args=>args[0]===outside)).toBe(false);
  });
  it('allows direct worktree configuration and packed refs and objects',async()=>{
    await runGit('-C',checkout,'config','extensions.worktreeConfig','true');
    await fs.writeFile(path.join(checkout,'.git','config.worktree'),'[core]\n autocrlf = false\n');
    await runGit('-C',checkout,'pack-refs','--all','--prune');await runGit('-C',checkout,'repack','-ad');
    const spawn=spyOnSpawn();expect((await validate()).repo).toBe('example/demo');
    expect(spawn).toHaveBeenCalled();
  });
  it.each(['[extensions]\n partialClone = origin\n','[remote "origin"]\n promisor = true\n',
    '[remote "origin"]\n PrOmIsOr = false\n'])('refuses potentially network-triggering configuration before invoking Git: %s',async addition=>{
    await fs.appendFile(path.join(checkout,'.git','config'),'\n'+addition);const spawn=spyOnSpawn();
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});expect(spawn).not.toHaveBeenCalled();
  });
  it.each(['alternates','http-alternates'])('does not open an external object store from %s',async name=>{
    const outside=path.join(root,'outside-objects');await fs.rename(path.join(checkout,'.git','objects'),outside);
    await fs.mkdir(path.join(checkout,'.git','objects','info'),{recursive:true});
    await fs.writeFile(path.join(checkout,'.git','objects','info',name),outside+'\n');
    const spawn=spyOnSpawn();await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(['HEAD','refs/heads/main','refs/heads','objects','packed-refs'])('rejects indirect %s metadata before any Git invocation',async name=>{
    const target=path.join(checkout,'.git',name),outside=path.join(root,'outside-metadata');
    if(name==='packed-refs')await runGit('-C',checkout,'pack-refs','--all');
    await fs.rename(target,outside);await fs.symlink(outside,target);
    const spawn=spyOnSpawn(),open=vi.spyOn(fs,'open');
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});
    expect(spawn).not.toHaveBeenCalled();expect(open.mock.calls.some(args=>args[0]===outside)).toBe(false);
  });
  it('rejects a symlinked selected loose object and a symlinked pack index',async()=>{
    const id=(await runGit('-C',checkout,'rev-parse','HEAD')).stdout.trim();
    const object=path.join(checkout,'.git','objects',id.slice(0,2),id.slice(2)),outside=path.join(root,'outside-object');
    await fs.rename(object,outside);await fs.symlink(outside,object);const spawn=spyOnSpawn();
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});expect(spawn).not.toHaveBeenCalled();
    await fs.unlink(object);await fs.rename(outside,object);
    await fs.writeFile(outside,'synthetic');await fs.symlink(outside,path.join(checkout,'.git','objects','pack','pack-'+id+'.idx'));
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});expect(spawn).not.toHaveBeenCalled();
  });
  it('changes revision when commits, remote, runtime identity, draft, metadata or choices change',async()=>{
    const revisions=[(await validate()).revision];
    await runGit('-C',checkout,'commit','--quiet','--allow-empty','-m','Second synthetic fixture');revisions.push((await validate()).revision);
    await runGit('-C',checkout,'remote','set-url','origin','git@github.com:example/demo.git');revisions.push((await validate()).revision);
    selected.repository.id='another-synthetic-repo';selected.repository.key=JSON.stringify([selected.hostId,selected.repository.id]);
    revisions.push((await validate()).revision);
    draft.input.description='Updated synthetic draft';revisions.push((await validate()).revision);
    await runGit('-C',checkout,'config','note.synthetic','updated');revisions.push((await validate()).revision);
    settings.verification=['Review'];revisions.push((await validate()).revision);
    settings.projectPath='example/demo/a-different-explicit-name';revisions.push((await validate()).revision);
    expect(new Set(revisions).size).toBe(revisions.length);
  });
  it('keeps the same source revision across identical observation refresh handles',async()=>{
    const initial=await validate();
    selected.fingerprint='3'.repeat(64);selected.optionId='project-workspace-'+'4'.repeat(64);selected.repository.label='Refreshed display label';
    expect(await validate()).toEqual(initial);
  });
  it('honors cancellation before IO and during validation',async()=>{
    const before=new AbortController();before.abort();
    const realpath=vi.spyOn(fs,'realpath');
    await expect(validate(before.signal)).rejects.toMatchObject({reason:'cancelled'});expect(realpath).not.toHaveBeenCalled();
    realpath.mockRestore();
    const during=new AbortController(),pending=validate(during.signal);during.abort();
    await expect(pending).rejects.toMatchObject({reason:'cancelled'});
  });
  it('rejects a ref changed between independent Git observations',async()=>{
    const original=gitReads.gitRead;let moved=false;
    vi.spyOn(gitReads,'gitRead').mockImplementation(async(...args)=>{
      const output=await original(...args);
      if(!moved&&args[2].at(-1)==='refs/heads/main^{commit}'){
        moved=true;await runGit('-C',checkout,'commit','--quiet','--allow-empty','-m','Concurrent synthetic fixture');
      }
      return output;
    });
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});expect(moved).toBe(true);
  });
  it('rejects metadata changed after the final Git observation',async()=>{
    const original=gitReads.gitRead;let reads=0;
    vi.spyOn(gitReads,'gitRead').mockImplementation(async(...args)=>{
      const output=await original(...args);
      if(args[2].at(-1)==='refs/heads/main^{commit}'&&++reads===2)await fs.appendFile(path.join(checkout,'.git','config'),'\n# concurrent synthetic change\n');
      return output;
    });
    await expect(validate()).rejects.toMatchObject({reason:'source_changed'});expect(reads).toBe(2);
  });
  it('bounds an unresponsive filesystem read by the shared source deadline',async()=>{
    vi.useFakeTimers();vi.spyOn(fs,'realpath').mockImplementationOnce(()=>new Promise<string>(()=>{}));
    const rejected=expect(validate()).rejects.toMatchObject({reason:'timeout'});
    await vi.advanceTimersByTimeAsync(5001);await rejected;
  });
  it('retains the original filesystem operation after the public source timeout',async()=>{
    vi.useFakeTimers();let release!:(value:string)=>void;const original=new Promise<string>(resolve=>{release=resolve;});
    vi.spyOn(fs,'realpath').mockImplementationOnce(()=>original);const owner=pendingOperations();
    const rejected=expect(validateProjectDagSource(draft,selected,settings,config,new AbortController().signal,decisionDate,owner.track))
      .rejects.toMatchObject({reason:'timeout'});
    await vi.advanceTimersByTimeAsync(5001);await rejected;expect(owner.pending.has(original)).toBe(true);
    release(checkout);await original;await Promise.resolve();expect(owner.pending.size).toBe(0);
  });
  it('retains the original descriptor close after bounded cleanup returns',async()=>{
    vi.useFakeTimers();let release!:()=>void;const original=new Promise<void>(resolve=>{release=resolve;});
    const owner=pendingOperations(),budget=new owner.TrackedBudget(10);
    const closing=closeBounded({close:()=>original} as unknown as FileHandle,budget);
    await vi.advanceTimersByTimeAsync(11);expect(await closing).toBe(false);expect(owner.pending.has(original)).toBe(true);
    release();await original;await Promise.resolve();expect(owner.pending.size).toBe(0);
  });
  it('retains a timed-out Git child until its actual close event',async()=>{
    vi.useFakeTimers();const owner=pendingOperations(),budget=new owner.TrackedBudget(10);
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(()=>true)});
    spyOnSpawn().mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>);
    const rejected=expect(gitReads.gitRead(git,checkout,['rev-parse','HEAD'],budget)).rejects.toMatchObject({code:'timeout'});
    await vi.advanceTimersByTimeAsync(11);await rejected;expect(child.kill).toHaveBeenCalledWith('SIGKILL');expect(owner.pending.size).toBe(1);
    child.emit('close',null);await Promise.resolve();expect(owner.pending.size).toBe(0);
  });
  it('rejects accessors and untrusted executable syntax without invoking accessors or resolving paths',async()=>{
    const get=vi.fn(()=>settings.projectPath);Object.defineProperty(settings,'projectPath',{get,enumerable:true});
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});expect(get).not.toHaveBeenCalled();
    settings={projectPath:'example/demo/name',baseBranch:'main',verification:['Review']};
    config.gitExecutablePath='git';const realpath=vi.spyOn(fs,'realpath');
    await expect(validate()).rejects.toMatchObject({reason:'invalid_source'});expect(realpath).not.toHaveBeenCalled();
  });
});
