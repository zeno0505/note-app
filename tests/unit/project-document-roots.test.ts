import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rename,symlink,link,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalSummaryCache} from '../../src/summary/storage';
import {createProjectDocumentRoots,projectDocumentRootsCodec} from '../../src/main/project-document-roots';
import type {ProjectDocumentRootsPersistence} from '../../src/main/project-document-roots';
import {
  parseGetProjectDocumentRootsRequest,parseSelectProjectDocumentRootRequest,
  parseConfirmProjectDocumentRootRequest,parseCancelProjectDocumentRootRequest,parseRevokeProjectDocumentRootRequest,
} from '../../src/shared/project-document-roots';

let base:string,docs:string,review:string,cache:string,available:boolean,binding:string;
beforeEach(async()=>{
  base=await realpath(await mkdtemp(path.join(tmpdir(),'document-root-fixture-')));
  docs=path.join(base,'source','docs');review=path.join(base,'review');cache=path.join(base,'cache');
  for(const directory of [docs,review,cache])await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(path.join(docs,'synthetic.md'),'# Synthetic document\n');available=true;binding='host:note-a:dag-a';
});
afterEach(async()=>{await rm(base,{recursive:true,force:true});});
function service(options:{now?:()=>number;persistence?:ProjectDocumentRootsPersistence}={}){
  return createProjectDocumentRoots({persistence:options.persistence??createLocalSummaryCache({directory:cache,codec:projectDocumentRootsCodec}),
    isProjectAvailable:projectId=>available&&['project-a','project-b'].includes(projectId),projectIdentity:()=>binding,now:options.now});
}
async function grant(s:ReturnType<typeof service>,directory=docs,projectId='project-a',kind:'docs'|'review'='docs'){
  const proposal=await s.prepare(projectId,directory,kind);
  return s.confirm({projectId,proposalId:proposal.proposalId,readOnlyConfirmed:true});
}
describe('project document grants',()=>{
  it('starts with no authority, and native selection alone never permits reading',async()=>{
    const s=service();expect(await s.rootsFor('project-a')).toEqual([]);
    const proposal=await s.prepare('project-a',docs,'docs');expect(proposal).toMatchObject({projectId:'project-a',path:docs,kind:'docs'});
    expect((await s.view('project-a')).roots).toEqual([]);expect(await s.rootsFor('project-a')).toEqual([]);
    s.cancel({projectId:'project-a',proposalId:proposal.proposalId});
    await expect(s.confirm({projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:true})).rejects.toThrow();
  });
  it('requires acknowledgement, matching project and current unexpired proposal',async()=>{
    let clock=100;const s=service({now:()=>clock}),proposal=await s.prepare('project-a',docs,'docs');
    for(const request of [
      {projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:false},
      {projectId:'project-b',proposalId:proposal.proposalId,readOnlyConfirmed:true},
      {projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:true,path:review},
    ])await expect(s.confirm(request)).rejects.toThrow();
    clock=120100;await expect(s.confirm({projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:true})).rejects.toThrow();
    expect(await s.rootsFor('project-a')).toEqual([]);
  });
  it('binds explicit directories only to their selected project and persists across restart',async()=>{
    const s=service(),first=await grant(s);expect(first.revision).toBe(1);expect(first.roots).toHaveLength(1);
    expect(await s.rootsFor('project-b')).toEqual([]);expect((await s.view('project-b')).roots).toEqual([]);
    const root=(await s.rootsFor('project-a'))[0];expect(await s.revalidate(root)).toBe(true);
    expect(root.path).toBe(docs);expect(root.identity).toMatch(/^\d+:\d+$/);expect(root.ancestors).toHaveLength(64);
    expect((await service().rootsFor('project-a'))[0]).toEqual(root);
    await grant(s,review,'project-b','review');expect((await s.rootsFor('project-a')).map(item=>item.path)).toEqual([docs]);
    expect((await s.rootsFor('project-b')).map(item=>item.path)).toEqual([review]);
  });
  it('does not merge ancestor, sibling, or cross-project grants',async()=>{
    const s=service();await grant(s);await grant(s,path.dirname(docs),'project-a','review');await grant(s,docs,'project-b');
    expect((await s.rootsFor('project-a')).map(root=>root.path)).toEqual([docs,path.dirname(docs)]);
    expect((await s.rootsFor('project-b')).map(root=>root.path)).toEqual([docs]);
    const before=(await s.view('project-a')).revision;await grant(s);
    expect((await s.view('project-a')).revision).toBe(before);expect((await s.rootsFor('project-a'))).toHaveLength(2);
  });
  it('revokes by project and revision and never revives a prior session after regrant',async()=>{
    const s=service(),view=await grant(s),root=(await s.rootsFor('project-a'))[0];
    await expect(s.revoke({projectId:'project-b',rootId:root.id,expectedRevision:view.revision,confirmed:true})).rejects.toThrow();
    await expect(s.revoke({projectId:'project-a',rootId:root.id,expectedRevision:999,confirmed:true})).rejects.toThrow();
    await s.revoke({projectId:'project-a',rootId:root.id,expectedRevision:view.revision,confirmed:true});
    expect(await s.revalidate(root)).toBe(false);expect(await service().rootsFor('project-a')).toEqual([]);
    await grant(s);expect((await s.rootsFor('project-a'))[0].id).not.toBe(root.id);expect(await s.revalidate(root)).toBe(false);
  });
  it('invalidates proposals on a later selection, explicit invalidation, and any committed grant mutation',async()=>{
    const s=service(),first=await s.prepare('project-a',docs,'docs'),second=await s.prepare('project-b',review,'review');
    await expect(s.confirm({projectId:'project-a',proposalId:first.proposalId,readOnlyConfirmed:true})).rejects.toThrow();
    s.cancel({projectId:'project-a',proposalId:second.proposalId}); // Another project cannot cancel it.
    await s.confirm({projectId:'project-b',proposalId:second.proposalId,readOnlyConfirmed:true});
    const third=await s.prepare('project-a',docs,'docs');s.invalidate();
    await expect(s.confirm({projectId:'project-a',proposalId:third.proposalId,readOnlyConfirmed:true})).rejects.toThrow();
  });
  it('rejects root inode replacement both before confirmation and on every later use',async()=>{
    const s=service(),pending=await s.prepare('project-a',docs,'docs');await rename(docs,docs+'-old');await mkdir(docs);
    await expect(s.confirm({projectId:'project-a',proposalId:pending.proposalId,readOnlyConfirmed:true})).rejects.toThrow();
    await grant(s);const root=(await s.rootsFor('project-a'))[0];await rename(docs,docs+'-replacement');await mkdir(docs);
    expect(await s.rootsFor('project-a')).toEqual([]);expect(await s.revalidate(root)).toBe(false);
    expect((await s.view('project-a')).roots[0].available).toBe(false);expect(await service().rootsFor('project-a')).toEqual([]);
  });
  it('rejects ancestor replacement even when the selected root inode is retained',async()=>{
    const s=service();await grant(s);const root=(await s.rootsFor('project-a'))[0],parent=path.dirname(docs);
    await rename(parent,parent+'-old');await mkdir(parent);await rename(path.join(parent+'-old','docs'),docs);
    expect(await s.rootsFor('project-a')).toEqual([]);expect(await s.revalidate(root)).toBe(false);
  });
  it('rejects symlink retargeting and presents a native alias as its canonical path for review',async()=>{
    const alias=path.join(base,'native-alias');await symlink(docs,alias);
    const s=service(),proposal=await s.prepare('project-a',alias,'docs');expect(proposal.path).toBe(docs);
    await s.confirm({projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:true});
    const root=(await s.rootsFor('project-a'))[0];await rename(docs,docs+'-old');await symlink(review,docs);
    expect(await s.rootsFor('project-a')).toEqual([]);expect(await s.revalidate(root)).toBe(false);
  });
  it('never inherits authority when a project mapping disappears or changes under the same ID',async()=>{
    const s=service();await grant(s);const root=(await s.rootsFor('project-a'))[0];
    available=false;expect(await s.rootsFor('project-a')).toEqual([]);expect(await s.revalidate(root)).toBe(false);
    expect((await s.view('project-a')).editable).toBe(false);await expect(s.prepare('project-a',docs,'docs')).rejects.toThrow();
    available=true;binding='host:another-note:another-dag';expect(await s.rootsFor('project-a')).toEqual([]);
    expect(await service().rootsFor('project-a')).toEqual([]);expect((await s.view('project-a')).roots[0].available).toBe(false);
    await grant(s);expect((await s.rootsFor('project-a'))[0].id).not.toBe(root.id);
  });
  it('rechecks the project binding before committing the confirmed selection',async()=>{
    const s=service(),proposal=await s.prepare('project-a',docs,'docs');binding='new-connection';
    await expect(s.confirm({projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:true})).rejects.toThrow();
    expect((await s.view('project-a')).roots).toEqual([]);
  });
  it('enforces a main-owned directory policy on canonical native selection and confirmation',async()=>{
    let allowed=true;const policy=vi.fn(async(projectId:string,canonicalPath:string)=>allowed&&projectId==='project-a'&&canonicalPath===docs);
    const s=createProjectDocumentRoots({persistence:createLocalSummaryCache({directory:cache,codec:projectDocumentRootsCodec}),isProjectAvailable:()=>true,isDirectoryAllowed:policy});
    await expect(s.prepare('project-a',path.dirname(docs),'docs')).rejects.toThrow('문서·검수 폴더');
    const alias=path.join(base,'document-policy-alias');await symlink(docs,alias);
    const proposal=await s.prepare('project-a',alias,'docs');expect(policy).toHaveBeenLastCalledWith('project-a',docs);
    allowed=false;await expect(s.confirm({projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:true})).rejects.toThrow('허용되지 않는');
    expect(await s.rootsFor('project-a')).toEqual([]);expect((await s.view('project-a')).roots).toEqual([]);
  });
  it('rechecks directory policy for persisted roots, views and in-flight authority, failing closed on policy errors',async()=>{
    let allowed=true,throws=false;const make=()=>createProjectDocumentRoots({persistence:createLocalSummaryCache({directory:cache,codec:projectDocumentRootsCodec}),
      isProjectAvailable:()=>true,isDirectoryAllowed:async()=>{if(throws)throw Error('synthetic policy unavailable');return allowed;}});
    const s=make();await grant(s);const root=(await s.rootsFor('project-a'))[0];expect(await s.revalidate(root)).toBe(true);
    allowed=false;expect(await s.rootsFor('project-a')).toEqual([]);expect(await s.revalidate(root)).toBe(false);
    expect((await s.view('project-a')).roots[0].available).toBe(false);expect(await make().rootsFor('project-a')).toEqual([]);
    allowed=true;throws=true;expect(await s.rootsFor('project-a')).toEqual([]);expect(await s.revalidate(root)).toBe(false);
    await expect(s.prepare('project-a',docs,'docs')).rejects.toThrow();
  });
  it('fails closed on unavailable, corrupt, symlinked, or hardlinked app persistence without altering files',async()=>{
    const unavailable=createProjectDocumentRoots({isProjectAvailable:()=>true});expect((await unavailable.view('project-a')).editable).toBe(false);
    await expect(unavailable.prepare('project-a',docs,'docs')).rejects.toThrow();
    const file=path.join(cache,'summary-cache-v1.json');await writeFile(file,'SYNTHETIC_CORRUPT',{mode:0o600});
    const corrupt=service();expect(await corrupt.rootsFor('project-a')).toEqual([]);expect((await corrupt.view('project-a')).error).toBeTruthy();
    expect(await readFile(file,'utf8')).toBe('SYNTHETIC_CORRUPT');await rm(file);
    await grant(service());const bytes=await readFile(file);await rename(file,file+'.original');await symlink(file+'.original',file);
    expect(await service().rootsFor('project-a')).toEqual([]);await rm(file);await link(file+'.original',file);
    expect(await service().rootsFor('project-a')).toEqual([]);expect(await readFile(file)).toEqual(bytes);
  });
  it('blocks all further reads after uncertain persistence and leaves prior source and permission data intact',async()=>{
    const good=createLocalSummaryCache({directory:cache,codec:projectDocumentRootsCodec});await grant(service());
    const bytes=await readFile(path.join(cache,'summary-cache-v1.json'));
    const s=service({persistence:{read:good.read,write:vi.fn(async()=>{throw Error('synthetic write failure');})}});
    const original=(await s.rootsFor('project-a'))[0],proposal=await s.prepare('project-a',review,'review');
    await expect(s.confirm({projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:true})).rejects.toThrow('synthetic write failure');
    expect(await s.rootsFor('project-a')).toEqual([]);expect(await s.revalidate(original)).toBe(false);
    expect(await readFile(path.join(cache,'summary-cache-v1.json'))).toEqual(bytes);
    expect(await readFile(path.join(docs,'synthetic.md'),'utf8')).toBe('# Synthetic document\n');
  });
  it('does not return mutable authority and observes cancellation',async()=>{
    const s=service();await grant(s);const root=(await s.rootsFor('project-a'))[0];root.path=review;
    expect(await s.revalidate(root)).toBe(false);expect((await s.rootsFor('project-a'))[0].path).toBe(docs);
    const controller=new AbortController();controller.abort();await expect(s.rootsFor('project-a',controller.signal)).rejects.toThrow();
    await expect(s.revalidate(root,controller.signal)).rejects.toThrow();
  });
  it('caps explicit roots at seven per project without disabling earlier permissions',async()=>{
    const s=service();for(let index=0;index<7;index++){const folder=path.join(base,'linked-'+index);await mkdir(folder);await grant(s,folder);}
    await expect(s.prepare('project-a',docs,'docs')).rejects.toThrow('폴더 수');
    expect(await s.rootsFor('project-a')).toHaveLength(7);expect((await s.view('project-a')).editable).toBe(true);
    await grant(s,docs,'project-b');expect(await s.rootsFor('project-b')).toHaveLength(1);
  });
  it('commits at most once when a confirmation is submitted concurrently',async()=>{
    const s=service(),proposal=await s.prepare('project-a',docs,'docs'),request={projectId:'project-a',proposalId:proposal.proposalId,readOnlyConfirmed:true};
    const results=await Promise.allSettled([s.confirm(request),s.confirm(request)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect((await s.view('project-a')).revision).toBe(1);expect(await s.rootsFor('project-a')).toHaveLength(1);
  });
  it('rejects a pending read authorization if revocation commits during its final mapping check',async()=>{
    let blockAfter:number|null=null,entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const s=createProjectDocumentRoots({persistence:createLocalSummaryCache({directory:cache,codec:projectDocumentRootsCodec}),
      isProjectAvailable:()=>true,projectIdentity:async()=>{if(blockAfter!==null&&blockAfter--===0){blockAfter=null;entered();await gate;}return binding;}});
    const view=await grant(s),root=(await s.rootsFor('project-a'))[0];blockAfter=1;
    const validating=s.revalidate(root);await started;
    await s.revoke({projectId:'project-a',rootId:root.id,expectedRevision:view.revision,confirmed:true});release();
    expect(await validating).toBe(false);
  });
  it('rejects malformed persisted scopes, IDs, identities, extra fields, and duplicate paths',async()=>{
    const s=service();await grant(s);const root=(await s.rootsFor('project-a'))[0];
    for(const bad of [
      {schemaVersion:2,roots:[root]}, {schemaVersion:1,roots:[root],readRoots:[docs]},
      {schemaVersion:1,roots:[{...root,identity:'no-identity'}]},
      {schemaVersion:1,roots:[{...root,path:path.parse(docs).root}]},
      {schemaVersion:1,roots:[{...root,kind:'vault'}]},
      {schemaVersion:1,roots:[{...root,binding:'unbound'}]},
      {schemaVersion:1,roots:[{...root,projectId:''}]},
      {schemaVersion:1,roots:[root,root]},
    ])expect(()=>projectDocumentRootsCodec.parse(bad)).toThrow();
  });
  it('never offers filesystem roots, relative paths, missing directories, or files as grants',async()=>{
    const s=service();for(const input of [path.parse(docs).root,'relative/docs',path.join(base,'missing'),path.join(docs,'synthetic.md')])await expect(s.prepare('project-a',input,'docs')).rejects.toThrow();
    expect(await s.rootsFor('project-a')).toEqual([]);
  });
});

describe('document grant renderer request boundaries',()=>{
  it('accepts only exact data fields and never accesses property getters',()=>{
    const getter=vi.fn(()=>{throw Error('getter must not run');});
    const malicious=Object.defineProperty({},'projectId',{enumerable:true,get:getter});
    expect(()=>parseGetProjectDocumentRootsRequest(malicious)).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(parseGetProjectDocumentRootsRequest({projectId:'legacy:workstream/a'})).toEqual({projectId:'legacy:workstream/a'});
    for(const value of [{projectId:'a',path:docs},{projectId:'a',[Symbol('hidden')]:'x'},Object.assign(Object.create({inherited:true}),{projectId:'a'}),{projectId:'x'.repeat(1025)}])expect(()=>parseGetProjectDocumentRootsRequest(value)).toThrow();
    expect(()=>parseSelectProjectDocumentRootRequest({projectId:'a',kind:'vault'})).toThrow();
    expect(()=>parseConfirmProjectDocumentRootRequest({projectId:'a',proposalId:'forged',readOnlyConfirmed:true})).toThrow();
    expect(()=>parseCancelProjectDocumentRootRequest({projectId:'a',proposalId:'forged'})).toThrow();
    expect(()=>parseRevokeProjectDocumentRootRequest({projectId:'a',rootId:'forged',expectedRevision:1,confirmed:true})).toThrow();
  });
});
