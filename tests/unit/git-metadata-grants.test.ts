import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rename,symlink,link,rm,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalSummaryCache,type SummaryCacheRecord} from '../../src/summary/storage';
import {createGitMetadataReadGrants,gitMetadataReadGrantsCodec,type GitMetadataReadGrantsPersistence,type GitMetadataReadGrantsPayload,type ExistingGitMetadataReadAuthority} from '../../src/main/git-metadata-grants';
import * as metadata from '../../src/summary/reading/git-activity-metadata';
import {parseGetGitMetadataReadStateRequest,parseSelectGitMetadataReadScopeRequest,parseConfirmGitMetadataReadScopeRequest,parseCancelGitMetadataReadScopeRequest,parseRevokeGitMetadataReadScopeRequest} from '../../src/shared/git-metadata-grants';

let base:string,worktree:string,common:string,gitdir:string,cache:string,projectIdentity:string,available:boolean;
beforeEach(async()=>{
  base=await realpath(await mkdtemp(path.join(tmpdir(),'metadata-grant-fixture-')));
  worktree=path.join(base,'linked');common=path.join(base,'origin','.git');gitdir=path.join(common,'worktrees','linked');cache=path.join(base,'cache');
  for(const directory of [worktree,gitdir,path.join(common,'objects','pack'),path.join(common,'objects','info'),path.join(common,'info'),path.join(common,'refs'),cache])await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(path.join(worktree,'.git'),`gitdir: ${gitdir}\n`);
  await writeFile(path.join(gitdir,'commondir'),'../..\n');
  await writeFile(path.join(gitdir,'gitdir'),path.join(worktree,'.git')+'\n');
  await writeFile(path.join(gitdir,'HEAD'),'ref: refs/heads/synthetic\n');
  await writeFile(path.join(common,'config'),'[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
  projectIdentity='synthetic-host:project-a:worktree-a';available=true;
});
afterEach(async()=>{vi.restoreAllMocks();await rm(base,{recursive:true,force:true});});
function persistence(){return createLocalSummaryCache({directory:cache,codec:gitMetadataReadGrantsCodec});}
function service(options:{now?:()=>number;persistence?:GitMetadataReadGrantsPersistence;existingAuthority?:()=>Promise<ExistingGitMetadataReadAuthority|null>;onInvalidate?:(id?:string)=>void}={}){
  return createGitMetadataReadGrants({persistence:persistence(),resolveProject:id=>available&&['project-a','project-b'].includes(id)?{worktree,projectIdentity}:null,...options});
}
async function grant(s:ReturnType<typeof service>,id='project-a',directory=common){const selected=await s.prepare(id,directory);return s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true});}
function gate(){let enter!:()=>void,release!:()=>void;return {entered:new Promise<void>(resolve=>{enter=resolve;}),wait:new Promise<void>(resolve=>{release=resolve;}),enter:()=>enter(),release:()=>release()};}

describe('project-bound metadata-only Git grants',()=>{
  it('does not inspect .git/config/objects during ungranted views, native prepare, or cancel',async()=>{
    const inspect=vi.spyOn(metadata,'inspectGitActivityMetadata'),s=service();
    expect(await s.resolve('project-a')).toBeNull();expect((await s.view('project-a')).state).toBe('ungranted');
    await writeFile(path.join(worktree,'.git'),'SYNTHETIC_INVALID_POINTER');
    const selected=await s.prepare('project-a',common);
    expect(selected).toMatchObject({workstreamId:'project-a',worktree,commonDirectory:common,purpose:'local-commit-identity-time'});
    expect(inspect).not.toHaveBeenCalled();expect(await s.resolve('project-a')).toBeNull();
    s.cancel({proposalId:selected.proposalId});
    await expect(s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).rejects.toThrow();expect(inspect).not.toHaveBeenCalled();
    expect(await persistence().read()).toBeNull();
  });
  it('requires exact confirmation and expires a proposal at two minutes using the injected clock',async()=>{
    let clock=100;const inspect=vi.spyOn(metadata,'inspectGitActivityMetadata'),s=service({now:()=>clock}),selected=await s.prepare('project-a',common);
    for(const request of [{proposalId:selected.proposalId,metadataReadConfirmed:false},{proposalId:selected.proposalId,metadataReadConfirmed:true,path:common},{proposalId:'forged',metadataReadConfirmed:true}])await expect(s.confirm(request)).rejects.toThrow();
    clock=120100;await expect(s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();expect(await s.resolve('project-a')).toBeNull();
  });
  it('persists exact linked Git identities, restarts safely, and exposes no read-file method or contents',async()=>{
    const s=service(),state=await grant(s);expect(state).toMatchObject({state:'granted',revision:1,revocable:true,worktree,commonDirectory:common,gitDirectory:gitdir});
    const authority=(await s.resolve('project-a'))!;expect(authority.descriptor.kind).toBe('linked');expect(authority.revision).toBe(1);expect(await authority.validate()).toBe(true);
    expect((await service().resolve('project-a'))?.identity).toBe(authority.identity);expect(await s.resolve('project-b')).toBeNull();
    expect(Object.keys(s).sort()).toEqual(['cancel','confirm','dispose','hasUnresolvedRecovery','invalidate','load','prepare','resolve','revoke','settle','view']);
    expect(JSON.stringify(state)).not.toContain('repositoryformatversion');expect(JSON.stringify(state)).not.toContain('ref: refs/heads');
    expect(JSON.stringify((await persistence().read())!.payload)).not.toContain('repositoryformatversion');
  });
  it('rejects unrelated and ancestor common directories instead of expanding the selected scope',async()=>{
    const s=service();for(const selected of [base,path.dirname(common),worktree]){
      const proposal=await s.prepare('project-a',selected);await expect(s.confirm({proposalId:proposal.proposalId,metadataReadConfirmed:true})).rejects.toThrow();
    }
    expect(await s.resolve('project-a')).toBeNull();expect(await persistence().read()).toBeNull();
  });
  it('requires the exact common .git directory for an ordinary worktree too',async()=>{
    await rm(path.join(worktree,'.git'));const local=path.join(worktree,'.git');
    for(const directory of [path.join(local,'objects','pack'),path.join(local,'objects','info'),path.join(local,'info'),path.join(local,'refs')])await mkdir(directory,{recursive:true});
    await writeFile(path.join(local,'config'),'[core]\n\trepositoryformatversion = 0\n');await writeFile(path.join(local,'HEAD'),'ref: refs/heads/synthetic\n');
    const s=service();await expect(grant(s,'project-a',common)).rejects.toThrow();expect(await persistence().read()).toBeNull();
    expect(await grant(s,'project-a',local)).toMatchObject({state:'granted',commonDirectory:local,gitDirectory:local});expect((await s.resolve('project-a'))?.descriptor.kind).toBe('ordinary');
  });
  it('requires the linked registration back-pointer to name the exact registered worktree',async()=>{
    await writeFile(path.join(gitdir,'gitdir'),path.join(base,'another-worktree','.git')+'\n');
    await expect(grant(service())).rejects.toThrow();expect(await persistence().read()).toBeNull();
  });
  it('never inherits metadata authority from a directory, note scope, or another project',async()=>{
    const s=service();await grant(s);expect(await s.resolve('project-b')).toBeNull();
    projectIdentity='synthetic-new-project-binding';expect(await s.resolve('project-a')).toBeNull();expect((await s.view('project-a')).state).toBe('unavailable');
    expect((await s.view('project-a')).revocable).toBe(true);expect(await service().resolve('project-a')).toBeNull();
    available=false;expect((await s.view('project-a')).editable).toBe(false);await expect(s.prepare('project-a',common)).rejects.toThrow();
  });
  it('checks the registered project again before any confirmed Git inspection',async()=>{
    const inspect=vi.spyOn(metadata,'inspectGitActivityMetadata'),s=service(),selected=await s.prepare('project-a',common);projectIdentity='replacement-project';
    await expect(s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).rejects.toThrow();expect(inspect).not.toHaveBeenCalled();
  });
  it('rejects replaced directories before confirmation and replaced pointers on every later query',async()=>{
    const s=service(),selected=await s.prepare('project-a',common);await rename(worktree,worktree+'-old');await mkdir(worktree);
    await expect(s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).rejects.toThrow();
    await rm(worktree,{recursive:true});await rename(worktree+'-old',worktree);await grant(s);const authority=(await s.resolve('project-a'))!;
    await writeFile(path.join(worktree,'.git'),`gitdir: ${gitdir}\n\n`);
    expect(await authority.validate()).toBe(false);expect(await s.resolve('project-a')).toBeNull();expect((await s.view('project-a')).state).toBe('unavailable');
  });
  it('binds ancestor identities even when selected directory inodes are retained',async()=>{
    const s=service();await grant(s);const authority=(await s.resolve('project-a'))!,parent=path.dirname(common);
    await rename(parent,parent+'-old');await mkdir(parent);await rename(path.join(parent+'-old','.git'),common);
    expect(await authority.validate()).toBe(false);expect(await s.resolve('project-a')).toBeNull();
  });
  it('shows a native alias canonically and rejects subsequent symlink replacement',async()=>{
    const alias=path.join(base,'picked-alias');await symlink(common,alias);const s=service(),selected=await s.prepare('project-a',alias);expect(selected.commonDirectory).toBe(common);
    await s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true});const authority=(await s.resolve('project-a'))!;
    await rename(common,common+'-old');await symlink(common+'-old',common);expect(await authority.validate()).toBe(false);expect(await s.resolve('project-a')).toBeNull();
  });
  it('invalidates older proposals, cancellation, and concurrent confirmation without duplicate writes',async()=>{
    const s=service(),first=await s.prepare('project-a',common),second=await s.prepare('project-b',common);
    await expect(s.confirm({proposalId:first.proposalId,metadataReadConfirmed:true})).rejects.toThrow();
    const results=await Promise.allSettled([s.confirm({proposalId:second.proposalId,metadataReadConfirmed:true}),s.confirm({proposalId:second.proposalId,metadataReadConfirmed:true})]);
    expect(results.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect((await persistence().read())?.revision).toBe(1);
    const pending=await s.prepare('project-a',common);s.invalidate();await expect(s.confirm({proposalId:pending.proposalId,metadataReadConfirmed:true})).rejects.toThrow();
  });
  it('retires an older selection that finishes asynchronously after a newer proposal',async()=>{
    const delayed=gate();let first=true;
    const s=createGitMetadataReadGrants({persistence:persistence(),resolveProject:async()=>{if(first){first=false;delayed.enter();await delayed.wait;}return {worktree,projectIdentity};}});
    const old=s.prepare('project-a',common),result=expect(old).rejects.toThrow();await delayed.entered;
    const selected=await s.prepare('project-b',common);delayed.release();await result;
    expect(await s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).toMatchObject({workstreamId:'project-b',state:'granted'});
  });
  it('rejects a late metadata inspection after cancellation',async()=>{
    const original=metadata.inspectGitActivityMetadata,blocked=gate();
    vi.spyOn(metadata,'inspectGitActivityMetadata').mockImplementation(async(...args)=>{const result=await original(...args);blocked.enter();await blocked.wait;return result;});
    const s=service(),selected=await s.prepare('project-a',common),confirming=s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true});
    const result=expect(confirming).rejects.toThrow();await blocked.entered;s.cancel({proposalId:selected.proposalId});blocked.release();await result;
    expect(await s.resolve('project-a')).toBeNull();expect(await persistence().read()).toBeNull();
  });
  it('compensates a persistence adapter completing late after a proposal cancellation',async()=>{
    const delayed=gate();let record:SummaryCacheRecord<GitMetadataReadGrantsPayload>|null=null,calls=0;
    const storage:GitMetadataReadGrantsPersistence={read:async()=>record,write:async(payload,expected)=>{if(calls++===0){delayed.enter();await delayed.wait;}record={revision:(expected??0)+1,payload:structuredClone(payload)};return record;}};
    const s=service({persistence:storage}),selected=await s.prepare('project-a',common),confirming=s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true});
    const result=expect(confirming).rejects.toThrow();await delayed.entered;s.cancel({proposalId:selected.proposalId});delayed.release();await result;
    expect(calls).toBe(2);expect((await storage.read())?.payload.grants).toEqual([]);expect(await s.resolve('project-a')).toBeNull();
    expect(await service({persistence:storage}).resolve('project-a')).toBeNull();
  });
  it('reconciles committed-then-rejected cancellation even when rollback cleanup also rejects',async()=>{
    let record:SummaryCacheRecord<GitMetadataReadGrantsPayload>|null=null,calls=0,cancel:()=>void=()=>undefined;
    const storage:GitMetadataReadGrantsPersistence={read:async()=>record,write:async(payload,expected)=>{
      record={revision:(expected??0)+1,payload:structuredClone(payload)};
      if(calls++===0)cancel();throw Object.assign(Error('committed cleanup failed'),{code:'committed-cleanup-failed',committedRevision:record.revision});
    }};
    const s=service({persistence:storage}),selected=await s.prepare('project-a',common);cancel=()=>s.cancel({proposalId:selected.proposalId});
    await expect(s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).rejects.toThrow('committed cleanup failed');
    expect(calls).toBe(2);expect((await storage.read())?.payload.grants).toEqual([]);expect(await service({persistence:storage}).resolve('project-a')).toBeNull();
  });
  it('permits bounded compensation after disposal races a committed confirmation',async()=>{
    let record:SummaryCacheRecord<GitMetadataReadGrantsPayload>|null=null,calls=0,dispose:()=>void=()=>undefined;
    const storage:GitMetadataReadGrantsPersistence={read:async()=>record,write:async(payload,expected)=>{record={revision:(expected??0)+1,payload:structuredClone(payload)};if(calls++===0)dispose();return record;}};
    const s=service({persistence:storage}),selected=await s.prepare('project-a',common);dispose=()=>s.dispose();
    await expect(s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).rejects.toThrow();await s.settle();
    expect(calls).toBe(2);expect((await storage.read())?.payload.grants).toEqual([]);expect(await service({persistence:storage}).resolve('project-a')).toBeNull();
  });
  it('remains cancellable during final state revalidation after persistence committed',async()=>{
    const real=persistence(),delayed=gate();let finalView=false;
    const s=createGitMetadataReadGrants({persistence:{read:real.read,write:async(...args)=>{const saved=await real.write(...args);finalView=true;return saved;}},
      resolveProject:async()=>{if(finalView){finalView=false;delayed.enter();await delayed.wait;}return {worktree,projectIdentity};}});
    const selected=await s.prepare('project-a',common),confirming=s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true}),result=expect(confirming).rejects.toThrow();
    await delayed.entered;s.cancel({proposalId:selected.proposalId});delayed.release();await result;
    expect((await persistence().read())?.payload.grants).toEqual([]);expect(await service().resolve('project-a')).toBeNull();
  });
  it('surfaces unprovable durable cancellation and can explicitly revoke after storage recovers',async()=>{
    let record:SummaryCacheRecord<GitMetadataReadGrantsPayload>|null=null,calls=0,writable=true,cancel:()=>void=()=>undefined;
    const storage:GitMetadataReadGrantsPersistence={read:async()=>record,write:async(payload,expected)=>{
      if(!writable)throw Error('synthetic unavailable disk');record={revision:(expected??0)+1,payload:structuredClone(payload)};
      if(calls++===0){writable=false;cancel();}return record;
    }};
    const s=service({persistence:storage}),selected=await s.prepare('project-a',common);cancel=()=>s.cancel({proposalId:selected.proposalId});
    await expect(s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).rejects.toThrow('저장됐을 수');
    const state=await s.view('project-a');expect(state).toMatchObject({state:'unavailable',editable:false,revocable:true,recoveryRequired:true});expect(state.error).toContain('다시 실행');
    expect(s.hasUnresolvedRecovery()).toBe(true);await expect(s.settle()).rejects.toThrow('복구가 완료되지');
    expect(await s.resolve('project-a')).toBeNull();await expect(s.prepare('project-a',common)).rejects.toThrow();
    await expect(s.revoke({workstreamId:'project-b',expectedRevision:state.revision})).rejects.toThrow();
    writable=true;expect(await s.revoke({workstreamId:'project-a',expectedRevision:state.revision})).toMatchObject({state:'ungranted',revocable:false,recoveryRequired:false});
    expect(s.hasUnresolvedRecovery()).toBe(false);await expect(s.settle()).resolves.toBeUndefined();
    expect((await storage.read())?.payload.grants[0].state).toBe('revoked');expect(await service({persistence:storage}).resolve('project-a')).toBeNull();
  });
  it('never overwrites a changed durable revision while recovering an uncertain confirmation',async()=>{
    let record:SummaryCacheRecord<GitMetadataReadGrantsPayload>|null=null,calls=0,cancel:()=>void=()=>undefined;
    const storage:GitMetadataReadGrantsPersistence={read:async()=>record,write:async(payload,expected)=>{if(calls++>0)throw Error('storage blocked');record={revision:(expected??0)+1,payload:structuredClone(payload)};cancel();return record;}};
    const s=service({persistence:storage}),selected=await s.prepare('project-a',common);cancel=()=>s.cancel({proposalId:selected.proposalId});
    await expect(s.confirm({proposalId:selected.proposalId,metadataReadConfirmed:true})).rejects.toThrow();const state=await s.view('project-a');
    const saved=(await storage.read())!;saved.revision+=10;const before=JSON.stringify(saved),writes=calls;
    await expect(s.revoke({workstreamId:'project-a',expectedRevision:state.revision})).rejects.toThrow();expect(calls).toBe(writes);expect(JSON.stringify(await storage.read())).toBe(before);
    expect((await s.view('project-a')).recoveryRequired).toBe(true);expect(await s.resolve('project-a')).toBeNull();
  });
  it('retries a failed explicit revocation after storage recovery without restoring read authority',async()=>{
    const real=persistence();let writable=true;
    const storage:GitMetadataReadGrantsPersistence={read:real.read,write:async(...args)=>{if(!writable)throw Error('synthetic unavailable disk');return real.write(...args);}};
    const s=service({persistence:storage}),state=await grant(s),authority=(await s.resolve('project-a'))!;writable=false;
    await expect(s.revoke({workstreamId:'project-a',expectedRevision:state.revision})).rejects.toThrow();expect((await s.view('project-a')).recoveryRequired).toBe(true);expect(await authority.validate()).toBe(false);
    writable=true;expect(await s.revoke({workstreamId:'project-a',expectedRevision:state.revision})).toMatchObject({state:'ungranted',recoveryRequired:false});expect(await authority.validate()).toBe(false);expect(await service().resolve('project-a')).toBeNull();
  });
  it('revokes immediately before persistence completes, prevents late validation and never revives old authority on regrant',async()=>{
    const real=persistence(),delayed=gate(),changed=vi.fn();let block=false;
    const s=service({onInvalidate:changed,persistence:{read:real.read,write:async(...args)=>{if(block){delayed.enter();await delayed.wait;}return real.write(...args);}}});
    const state=await grant(s),authority=(await s.resolve('project-a'))!;block=true;
    const revoking=s.revoke({workstreamId:'project-a',expectedRevision:state.revision});await delayed.entered;
    expect(changed).toHaveBeenLastCalledWith('project-a');expect(await authority.validate()).toBe(false);expect(await s.resolve('project-a')).toBeNull();
    delayed.release();expect((await revoking).state).toBe('ungranted');expect(await service().resolve('project-a')).toBeNull();
    block=false;await grant(s);expect(await authority.validate()).toBe(false);expect((await s.resolve('project-a'))?.identity).not.toBe(authority.identity);
    await expect(s.revoke({workstreamId:'project-a',expectedRevision:state.revision})).rejects.toThrow();
  });
  it('rejects late successful project revalidation when revoke happens during its final await',async()=>{
    const delayed=gate();let count:number|null=null;
    const s=createGitMetadataReadGrants({persistence:persistence(),resolveProject:async()=>{if(count!==null&&count--===0){count=null;delayed.enter();await delayed.wait;}return {worktree,projectIdentity};}});
    const state=await grant(s),authority=(await s.resolve('project-a'))!;count=1;
    const validating=authority.validate();await delayed.entered;await s.revoke({workstreamId:'project-a',expectedRevision:state.revision});delayed.release();expect(await validating).toBe(false);
  });
  it('requires proof for exact existing authority and persists revocation over that fallback',async()=>{
    let allowed=false,readRevision=7;const validate=vi.fn(async()=>allowed),existing=vi.fn(async()=>({worktree,approvedCommonPaths:[common],revision:readRevision,validate}));
    const s=service({existingAuthority:existing});expect(await s.resolve('project-a')).toBeNull();allowed=true;
    const authority=(await s.resolve('project-a'))!;expect(authority.revision).toBe(7);expect(await authority.validate()).toBe(true);
    const state=await s.view('project-a');expect(state).toMatchObject({state:'granted',revocable:true,revision:null});
    allowed=false;expect(await authority.validate()).toBe(false);allowed=true;
    await s.revoke({workstreamId:'project-a',expectedRevision:null});expect(await s.resolve('project-a')).toBeNull();
    expect(await service({existingAuthority:existing}).resolve('project-a')).toBeNull();expect((await s.view('project-a')).revocable).toBe(false);
    readRevision=8;await grant(s);expect((await s.resolve('project-a'))!.revision).toBe(2);
  });
  it('rejects existing proof for another worktree, broad ancestors, empty paths, and invalid revisions',async()=>{
    for(const proof of [
      {worktree:base,approvedCommonPaths:[common],revision:1},
      {worktree,approvedCommonPaths:[base],revision:1},
      {worktree,approvedCommonPaths:[],revision:1},
      {worktree,approvedCommonPaths:[common],revision:0},
    ])expect(await service({existingAuthority:async()=>({...proof,validate:async()=>true})}).resolve('project-a')).toBeNull();
  });
  it('fails closed on corrupt or unsafe persistence and uncertain writes without changing source metadata',async()=>{
    const file=path.join(cache,'summary-cache-v1.json');await writeFile(file,'SYNTHETIC_CORRUPT');
    const corrupt=service();expect(await corrupt.resolve('project-a')).toBeNull();expect((await corrupt.view('project-a')).editable).toBe(false);expect(await readFile(file,'utf8')).toBe('SYNTHETIC_CORRUPT');
    await rm(file);await grant(service());const saved=await readFile(file);await rename(file,file+'.original');await symlink(file+'.original',file);
    expect(await service().resolve('project-a')).toBeNull();await rm(file);await link(file+'.original',file);expect(await service().resolve('project-a')).toBeNull();await rm(file);await rename(file+'.original',file);
    const pointer=await readFile(path.join(worktree,'.git'),'utf8'),s=service({persistence:{read:persistence().read,write:async()=>{throw Error('synthetic uncertain write');}}}),authority=(await s.resolve('project-a'))!;
    await expect(s.revoke({workstreamId:'project-a',expectedRevision:1})).rejects.toThrow('저장됐을 수');expect(await authority.validate()).toBe(false);expect(await s.resolve('project-a')).toBeNull();
    expect(await readFile(file)).toEqual(saved);expect(await readFile(path.join(worktree,'.git'),'utf8')).toBe(pointer);
  });
  it('rejects mutable returned authority, observes aborted signals, and retires on disposal',async()=>{
    const s=service();await grant(s);const authority=(await s.resolve('project-a'))!;
    (authority.descriptor as {commonDirectory:string}).commonDirectory=base;expect(await authority.validate()).toBe(false);expect((await s.resolve('project-a'))!.descriptor.commonDirectory).toBe(common);
    const controller=new AbortController();controller.abort();await expect(s.resolve('project-a',controller.signal)).rejects.toThrow();
    const fresh=(await s.resolve('project-a'))!;s.dispose();expect(await fresh.validate()).toBe(false);expect(await s.resolve('project-a')).toBeNull();await s.settle();
  });
  it('rejects malformed persisted descriptors, duplicate projects, over-limit grants, and getter payloads',async()=>{
    await grant(service());const payload=(await persistence().read())!.payload,first=payload.grants[0];
    for(const value of [
      {...payload,schemaVersion:2},{...payload,notesAllowed:true},
      {...payload,grants:[{...first,purpose:'arbitrary-file-read'}]},
      {...payload,grants:[{...first,projectBinding:'forged'}]},
      {...payload,grants:[{...first,revision:0}]},
      {...payload,grants:[{...first,descriptor:{...first.descriptor,commonDirectory:base}}]},
      {...payload,grants:[first,first]},
      {...payload,grants:Array.from({length:129},(_,i)=>({...first,grantId:'git-metadata-grant-'+randomUUID(),workstreamId:'project-'+i}))},
    ])expect(()=>gitMetadataReadGrantsCodec.parse(value)).toThrow();
    const getter=vi.fn();expect(()=>gitMetadataReadGrantsCodec.parse(Object.defineProperty({},'grants',{enumerable:true,get:getter}))).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it('caps durable project entries without making a new Git inspection or disabling existing authority',async()=>{
    await grant(service());const saved=(await persistence().read())!,first=saved.payload.grants[0];
    const entries=[first,...Array.from({length:127},(_,index)=>({...first,grantId:'git-metadata-grant-'+randomUUID(),workstreamId:'reserved-'+index}))];
    const s=service({persistence:{read:async()=>({revision:1,payload:gitMetadataReadGrantsCodec.parse({schemaVersion:1,grants:entries})}),write:async()=>{throw Error('unexpected write');}}});
    const inspect=vi.spyOn(metadata,'inspectGitActivityMetadata');await expect(s.prepare('project-b',common)).rejects.toThrow('한도');expect(inspect).not.toHaveBeenCalled();
    expect(await s.resolve('project-a')).not.toBeNull();
  });
  it('never offers filesystem roots, relative paths, missing paths, or files as grant scopes',async()=>{
    const s=service();for(const selected of [path.parse(base).root,'relative',path.join(base,'missing'),path.join(gitdir,'HEAD')])await expect(s.prepare('project-a',selected)).rejects.toThrow();
    expect(await persistence().read()).toBeNull();
    const unavailable=createGitMetadataReadGrants({resolveProject:()=>({worktree,projectIdentity})});expect((await unavailable.view('project-a')).editable).toBe(false);await expect(unavailable.prepare('project-a',common)).rejects.toThrow();
  });
});

describe('metadata grant renderer request parsers',()=>{
  it('accepts exact inert fields and rejects caller paths, getters, inherited properties and symbol extras',()=>{
    const id='git-metadata-proposal-'+randomUUID();
    expect(parseGetGitMetadataReadStateRequest({workstreamId:'legacy:a'})).toEqual({workstreamId:'legacy:a'});
    expect(parseSelectGitMetadataReadScopeRequest({workstreamId:'legacy:a'})).toEqual({workstreamId:'legacy:a'});
    expect(parseConfirmGitMetadataReadScopeRequest({proposalId:id,metadataReadConfirmed:true})).toEqual({proposalId:id,metadataReadConfirmed:true});
    expect(parseCancelGitMetadataReadScopeRequest({proposalId:id})).toEqual({proposalId:id});expect(parseRevokeGitMetadataReadScopeRequest({workstreamId:'a',expectedRevision:null})).toEqual({workstreamId:'a',expectedRevision:null});
    const getter=vi.fn();expect(()=>parseGetGitMetadataReadStateRequest(Object.defineProperty({},'workstreamId',{enumerable:true,get:getter}))).toThrow();expect(getter).not.toHaveBeenCalled();
    for(const value of [{workstreamId:'a',path:common},{workstreamId:'a',[Symbol('extra')]:true},Object.assign(Object.create({inherited:true}),{workstreamId:'a'}),{workstreamId:'x'.repeat(1025)}])expect(()=>parseGetGitMetadataReadStateRequest(value)).toThrow();
    expect(()=>parseConfirmGitMetadataReadScopeRequest({proposalId:id,metadataReadConfirmed:false})).toThrow();expect(()=>parseCancelGitMetadataReadScopeRequest({proposalId:'forged'})).toThrow();
    expect(()=>parseRevokeGitMetadataReadScopeRequest({workstreamId:'a',expectedRevision:0})).toThrow();expect(()=>parseRevokeGitMetadataReadScopeRequest({workstreamId:'a',expectedRevision:1,path:common})).toThrow();
  });
});
