import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,rename,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReadRoots,readRootsCodec} from '../../src/main/read-roots';
import {createLocalSummaryCache} from '../../src/summary/storage';
import {mapWorktreesToNotes} from '../../src/collector/notes';
import type {AllowedNoteScope} from '../../src/collector/notes';
let root:string,vault:string,note:string,tree:string,cache:string,scope:AllowedNoteScope;
beforeEach(async()=>{root=await realpath(await mkdtemp(path.join(tmpdir(),'note-read-root-')));vault=path.join(root,'vault');note=path.join(vault,'project');tree=path.join(root,'worktree');cache=path.join(root,'cache');for(const p of [note,path.join(tree,'docs'),cache])await mkdir(p,{recursive:true,mode:0o700});await writeFile(path.join(note,'dag.yaml'),'synthetic: true\n');await symlink(note,path.join(tree,'docs/note'));scope={scopeId:'project-one',hostId:'host',vaultRootPath:vault,scopePath:note,dagRelativePaths:['dag.yaml']};});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
function service(initialScopes=[scope],now?:()=>number){return createReadRoots({initialScopes,hostId:'host',persistence:createLocalSummaryCache({directory:cache,codec:readRootsCodec}),now});}
const worktree=()=>[{worktreeId:'one',hostId:'host',worktreePath:tree}];
async function allow(s:ReturnType<typeof service>,p=vault){const proposal=await s.prepare(p);return s.confirm({proposalId:proposal.proposalId,readOnlyConfirmed:true});}
describe('explicit read roots',()=>{
  it('does not authorize a selected or cancelled folder and rejects forged renderer paths',async()=>{
    const s=service([]),p=await s.prepare(vault);expect((await s.view()).roots).toEqual([]);expect(await s.scopesFor(worktree())).toEqual([]);
    expect(()=>s.cancel({proposalId:p.proposalId,path:vault})).toThrow();s.cancel({proposalId:p.proposalId});await expect(s.confirm({proposalId:p.proposalId,readOnlyConfirmed:true})).rejects.toThrow();
    const next=await s.prepare(vault);await expect(s.confirm({proposalId:next.proposalId,readOnlyConfirmed:true,path:vault})).rejects.toThrow();
  });
  it('requires explicit acknowledgement and expiry before saving',async()=>{
    let clock=100;const s=service([],()=>clock),p=await s.prepare(vault);
    await expect(s.confirm({proposalId:p.proposalId,readOnlyConfirmed:false})).rejects.toThrow();clock=120101;await expect(s.confirm({proposalId:p.proposalId,readOnlyConfirmed:true})).rejects.toThrow();expect((await s.view()).roots).toEqual([]);
  });
  it('persists canonical roots, deduplicates overlap and never revives removed startup grants',async()=>{
    const s=service();expect((await s.view()).roots[0].kind).toBe('project');let view=await allow(s);expect(view.roots).toHaveLength(1);expect(view.roots[0]).toMatchObject({path:vault,kind:'vault'});
    view=await allow(s,note);expect(view.roots).toHaveLength(1);
    const restarted=service();expect((await restarted.view()).roots[0].path).toBe(vault);
    await expect(restarted.revoke({rootId:view.roots[0].id,expectedRevision:999,confirmed:true})).rejects.toThrow();
    await restarted.revoke({rootId:view.roots[0].id,expectedRevision:view.revision,confirmed:true});
    expect((await service().view()).roots).toEqual([]);expect(await service().scopesFor(worktree(),[scope])).toEqual([]);
  });
  it('checks only designated project links and fixed DAG paths without scanning siblings',async()=>{
    const sibling=path.join(vault,'unrelated');await mkdir(sibling);await writeFile(path.join(sibling,'dag.yaml'),'PRIVATE_CANARY');
    const s=service([]);await allow(s);const scopes=await s.scopesFor(worktree());expect(scopes).toHaveLength(1);expect(scopes[0]).toMatchObject({scopePath:note,vaultRootPath:vault,dagRelativePaths:['dag.yaml']});
    expect(await s.scopesFor([])).toEqual([]);const mapped=await mapWorktreesToNotes({localHostId:'host',scopes,worktrees:worktree(),requireNoteSymlink:true});expect(mapped.mappings[0].state).toBe('resolved');
  });
  it('rejects root-as-note, escaping symlinks and foreign hosts',async()=>{
    const s=service([]);await allow(s);await rm(path.join(tree,'docs/note'));await symlink(vault,path.join(tree,'docs/note'));expect(await s.scopesFor(worktree())).toEqual([]);
    const outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'dag.yaml'),'outside');await rm(path.join(tree,'docs/note'));await symlink(outside,path.join(tree,'docs/note'));expect(await s.scopesFor(worktree())).toEqual([]);
    expect(await s.scopesFor([{...worktree()[0],hostId:'foreign'}])).toEqual([]);
  });
  it('rejects project directory retargets and root identity replacement',async()=>{
    const s=service([]);await allow(s);const scopes=await s.scopesFor(worktree());const outside=path.join(root,'outside');await rename(note,outside);await symlink(outside,note);expect(await s.filterScopes(scopes)).toEqual([]);
    await rename(vault,path.join(root,'old-vault'));await mkdir(vault);expect((await s.view()).roots[0].available).toBe(false);expect(await s.scopesFor(worktree())).toEqual([]);
  });
  it('rejects a changed selected folder before confirmation',async()=>{
    const s=service([]),p=await s.prepare(vault);await rename(vault,path.join(root,'old'));await mkdir(vault);await expect(s.confirm({proposalId:p.proposalId,readOnlyConfirmed:true})).rejects.toThrow();expect((await s.view()).roots).toEqual([]);
  });
  it('canonicalizes a chosen alias for review without silently following later changes',async()=>{
    const alias=path.join(root,'alias');await symlink(vault,alias);const s=service([]),p=await s.prepare(alias);expect(p.path).toBe(vault);await s.confirm({proposalId:p.proposalId,readOnlyConfirmed:true});expect((await s.view()).roots[0].path).toBe(vault);
  });
  it('keeps an explicitly retained project bounded after its worktree disappears',async()=>{
    const s=service([]);await allow(s);const scopes=await s.scopesFor(worktree());await rm(tree,{recursive:true});expect(await s.scopesFor([],scopes)).toEqual(scopes);const view=await s.view();await s.revoke({rootId:view.roots[0].id,expectedRevision:view.revision,confirmed:true});expect(await s.filterScopes(scopes)).toEqual([]);
  });
  it('fails closed on unavailable or corrupt persistence and preserves the file',async()=>{
    const unavailable=createReadRoots({initialScopes:[scope],unavailable:true});expect((await unavailable.view()).editable).toBe(false);expect(await unavailable.scopesFor(worktree())).toEqual([]);
    await writeFile(path.join(cache,'summary-cache-v1.json'),'corrupt',{mode:0o600});const s=service();expect((await s.view()).error).toBeTruthy();expect(await s.scopesFor(worktree())).toEqual([]);await expect(s.prepare(vault)).rejects.toThrow();
  });
  it('preserves authority if saving fails and rejects a cancelled discovery',async()=>{
    const persistence={read:async()=>null,write:vi.fn(async()=>{throw Error('write failed');})};const s=createReadRoots({initialScopes:[scope],hostId:'host',persistence});const p=await s.prepare(vault);await expect(s.confirm({proposalId:p.proposalId,readOnlyConfirmed:true})).rejects.toThrow();expect((await s.view()).roots[0].path).toBe(note);
    const aborted=new AbortController();aborted.abort();await expect(s.scopesFor(worktree(),[],aborted.signal)).rejects.toThrow();
  });
});
