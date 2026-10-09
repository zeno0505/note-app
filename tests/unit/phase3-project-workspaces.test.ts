import {describe,expect,it,vi} from 'vitest';
import {createProjectWorkspaceSelector,type ObservedProjectWorkspace,type ProjectWorkspaceSnapshot} from '../../src/main/project-workspaces';
import {PROJECT_WORKSPACE_LIMITS,parseResolveProjectWorkspaceRequest} from '../../src/shared/project-workspaces';

function workspace(id='one',repo='repository-one'):ObservedProjectWorkspace {
  return {worktreeId:id,hostId:'local',instanceId:'instance-'+id,path:'/synthetic/worktrees/'+id,branch:'feature/'+id,archived:false,
    repository:{key:JSON.stringify(['local',repo]),id:repo,hostId:'local',projectId:'project-'+repo,label:'Synthetic '+repo}};
}
function setup(rows:ObservedProjectWorkspace[]=[workspace()]) {
  const snapshot:ProjectWorkspaceSnapshot={connected:true,disposed:false,refreshing:false,freshness:'current',localHostId:'local',runtimeId:'runtime-one',revision:1,
    observedAt:'2026-10-08T18:00:00.000Z',currentWorktrees:rows};
  const read=vi.fn(()=>snapshot),selector=createProjectWorkspaceSelector(read);
  const selection=()=>{const first=selector.getProjectWorkspaceOptions().options[0];return {optionId:first.optionId,expectedFingerprint:first.fingerprint};};
  return {snapshot,rows,read,selector,selection};
}

describe('main-owned existing Orca workspace choices',()=>{
  it('retains separate repositories and workspaces with exact, detached observed metadata',()=>{
    const f=setup([workspace('one','frontend'),workspace('two','backend'),workspace('three','frontend')]);
    const view=f.selector.getProjectWorkspaceOptions();
    expect(view).toMatchObject({state:'ready',reason:null,omittedCount:0});expect(view.options).toHaveLength(3);
    expect(new Set(view.options.map(option=>option.optionId)).size).toBe(3);
    expect(view.options.map(option=>option.repository.id)).toEqual(['frontend','backend','frontend']);
    expect(view.options[0]).toMatchObject({hostId:'local',worktreeId:'one',path:'/synthetic/worktrees/one',branch:'feature/one',repository:f.rows[0].repository});
    expect(view.options[0].optionId).toMatch(/^project-workspace-[0-9a-f]{64}$/u);
    expect(view.options[0].fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(view)).not.toContain('runtime-one');expect(JSON.stringify(view)).not.toContain('instance-one');
    const request=f.selection(),resolved=f.selector.resolveProjectWorkspace(request);
    expect(resolved).toEqual(view.options[0]);expect(resolved).not.toHaveProperty('verified');
    view.options[0].path='/synthetic/renderer-edited';resolved.repository.id='spoofed';
    expect(f.selector.resolveProjectWorkspace(request)).toMatchObject({path:'/synthetic/worktrees/one',repository:{id:'frontend'}});
    expect(f.rows[0].path).toBe('/synthetic/worktrees/one');
  });
  it.each(['connected','disposed','refreshing','freshness'] as const)('fails closed for unavailable %s state',field=>{
    const f=setup(),request=f.selection();
    if(field==='connected')f.snapshot.connected=false;
    else if(field==='disposed')f.snapshot.disposed=true;
    else if(field==='refreshing')f.snapshot.refreshing=true;
    else f.snapshot.freshness='stale';
    expect(f.selector.getProjectWorkspaceOptions()).toMatchObject({state:'unavailable',options:[]});
    expect(()=>f.selector.resolveProjectWorkspace(request)).toThrow();
  });
  it('requires a configured local host, identified runtime, successful revision and bounded observations',()=>{
    for(const override of [{localHostId:null},{runtimeId:null},{revision:0},{observedAt:null},{observedAt:'invalid'},
      {observedAt:'x'.repeat(4096)},{currentWorktrees:Array.from({length:1001},(_,i)=>workspace(String(i)))}]){
      const f=setup();Object.assign(f.snapshot,override);expect(f.selector.getProjectWorkspaceOptions()).toMatchObject({state:'unavailable',options:[]});
    }
  });
  it('never offers foreign, archived, unknown-archive or incompletely bound rows',()=>{
    const foreign=workspace('foreign');foreign.hostId='remote';foreign.repository={...foreign.repository,hostId:'remote',key:JSON.stringify(['remote',foreign.repository.id])};
    const archived=workspace('archived');archived.archived=true;
    const unknown=workspace('unknown');unknown.archived=null;
    const missingPath=workspace('path');missingPath.path=null;
    const relative=workspace('relative');relative.path='../synthetic';
    const missingHost=workspace('host');missingHost.hostId=null;
    const missingInstance=workspace('instance');missingInstance.instanceId=null;
    const missingRepo=workspace('repo');missingRepo.repository={...missingRepo.repository,id:null};
    const mismatchedRepo=workspace('mismatch');mismatchedRepo.repository={...mismatchedRepo.repository,hostId:'foreign'};
    const forgedKey=workspace('key');forgedKey.repository={...forgedKey.repository,key:'renderer-provided'};
    const branch=workspace('branch');branch.branch='x'.repeat(257);
    const f=setup([workspace('allowed'),foreign,archived,unknown,missingPath,relative,missingHost,missingInstance,missingRepo,mismatchedRepo,forgedKey,branch]);
    expect(f.selector.getProjectWorkspaceOptions().options.map(option=>option.worktreeId)).toEqual(['allowed']);
  });
  it('keeps an unavailable branch explicitly null rather than inferring a branch',()=>{
    const row=workspace();row.branch=null;expect(setup([row]).selector.getProjectWorkspaceOptions().options[0].branch).toBeNull();
  });
  it('rejects duplicate IDs even when their other occurrence is archived or foreign',()=>{
    for(const kind of ['local','archived','foreign']){
      const duplicate=workspace();duplicate.instanceId='other';duplicate.path='/synthetic/other';
      if(kind==='archived')duplicate.archived=true;
      if(kind==='foreign')duplicate.hostId='foreign';
      const f=setup([workspace(),duplicate,workspace('unambiguous')]);
      expect(f.selector.getProjectWorkspaceOptions().options.map(option=>option.worktreeId)).toEqual(['unambiguous']);
    }
  });
  it('rejects shared local paths and instance identities without collapsing the rows',()=>{
    for(const field of ['path','instanceId'] as const){
      const rows=[workspace('one'),workspace('two')];rows[1][field]=rows[0][field];
      expect(setup(rows).selector.getProjectWorkspaceOptions().options).toEqual([]);
    }
  });
  it('rejects disappearance and all exact-binding changes without trusting a previous list',()=>{
    const mutations:((f:ReturnType<typeof setup>)=>void)[]=[
      f=>{f.snapshot.currentWorktrees=[];},f=>{f.rows[0].worktreeId='replacement';},f=>{f.rows[0].instanceId='replacement';},
      f=>{f.rows[0].hostId='foreign';},f=>{f.rows[0].path='/synthetic/moved';},f=>{f.rows[0].branch='retargeted';},
      f=>{f.rows[0].repository={...f.rows[0].repository,id:'other',key:JSON.stringify(['local','other'])};},
      f=>{f.rows[0].repository={...f.rows[0].repository,projectId:'other'};},f=>{f.rows[0].archived=true;},
      f=>{f.snapshot.runtimeId='runtime-restarted';},f=>{f.snapshot.revision++;},f=>{f.snapshot.observedAt='2026-10-08T18:00:01.000Z';},
      f=>{f.snapshot.currentWorktrees=[...f.rows,{...f.rows[0],instanceId:'duplicate'}];},
    ];
    for(const mutate of mutations){const f=setup(),request=f.selection();mutate(f);expect(()=>f.selector.resolveProjectWorkspace(request)).toThrow();}
  });
  it('cannot reuse a valid selection across different main-owned selector lifetimes',()=>{
    const one=setup(),two=setup();expect(()=>two.selector.resolveProjectWorkspace(one.selection())).toThrow();
  });
  it('enforces both count and encoded-byte response bounds without truncating selected metadata',()=>{
    const f=setup(Array.from({length:140},(_,i)=>workspace(String(i))));
    expect(f.selector.getProjectWorkspaceOptions().options).toHaveLength(PROJECT_WORKSPACE_LIMITS.options);
    expect(f.selector.getProjectWorkspaceOptions().omittedCount).toBe(12);
    for(const row of f.rows){row.path='/synthetic/'+row.worktreeId+'界'.repeat(4000);}
    const result=f.selector.getProjectWorkspaceOptions();
    expect(result.options.length).toBeGreaterThan(0);expect(result.options.length).toBeLessThan(PROJECT_WORKSPACE_LIMITS.options);
    expect(result.omittedCount+result.options.length).toBe(140);
    expect(Buffer.byteLength(JSON.stringify(result),'utf8')).toBeLessThanOrEqual(PROJECT_WORKSPACE_LIMITS.responseBytes);
    expect(result.options[0].path).toBe(f.rows[0].path);
  });
});

describe('strict workspace selection request boundary',()=>{
  it('accepts only a detached opaque option ID and fingerprint',()=>{
    const f=setup(),request=f.selection(),parsed=parseResolveProjectWorkspaceRequest(request);
    expect(parsed).toEqual(request);expect(parsed).not.toBe(request);
    expect(parseResolveProjectWorkspaceRequest(Object.assign(Object.create(null),request))).toEqual(request);
  });
  it('rejects arbitrary paths, spoofed metadata, accessors, inherited fields, symbols and malformed tokens',()=>{
    const f=setup(),request=f.selection(),getter=vi.fn(()=>request.optionId);
    for(const invalid of [null,[],{},request.optionId,{...request,path:'/synthetic/arbitrary'},{...request,verified:true},{...request,worktreeId:'one'},
      {...request,optionId:'one'},{...request,expectedFingerprint:'wrong'},Object.create(request),{...request,[Symbol('hidden')]:true},
      {get optionId(){return getter();},expectedFingerprint:request.expectedFingerprint}]){
      expect(()=>parseResolveProjectWorkspaceRequest(invalid)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(()=>f.selector.resolveProjectWorkspace({...request,expectedFingerprint:'0'.repeat(64)})).toThrow();
  });
});
