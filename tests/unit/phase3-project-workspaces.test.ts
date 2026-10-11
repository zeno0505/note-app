import {describe,expect,it,vi} from 'vitest';
import {createProjectWorkspaceSelector,type ObservedProjectWorkspace,type ProjectWorkspaceSnapshot} from '../../src/main/project-workspaces';
import {createSnapshotStore} from '../../src/collector/snapshot/store';
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
  it.each(['connected','disposed','refreshing','stale','unknown'] as const)('fails closed for unavailable %s state',field=>{
    const f=setup(),request=f.selection();
    if(field==='connected')f.snapshot.connected=false;
    else if(field==='disposed')f.snapshot.disposed=true;
    else if(field==='refreshing')f.snapshot.refreshing=true;
    else f.snapshot.freshness=field;
    expect(f.selector.getProjectWorkspaceOptions()).toMatchObject({state:'unavailable',options:[]});
    expect(()=>f.selector.resolveProjectWorkspace(request)).toThrow();
  });
  it('requires a configured local host, identified runtime, successful revision and bounded observations',()=>{
    for(const override of [{localHostId:null},{runtimeId:null},{revision:0},{observedAt:null},{observedAt:'invalid'},
      {observedAt:'x'.repeat(4096)},{currentWorktrees:Array.from({length:1001},(_,i)=>workspace(String(i)))}]){
      const f=setup(),request=f.selection();Object.assign(f.snapshot,override);expect(f.selector.getProjectWorkspaceOptions()).toMatchObject({state:'unavailable',options:[]});
      expect(()=>f.selector.resolveProjectWorkspace(request)).toThrow();
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
  it.each(['revision','observedAt','both'] as const)('revalidates unchanged full identity across a benign %s refresh',field=>{
    const f=setup(),original=f.selector.getProjectWorkspaceOptions().options[0],request=f.selection();
    if(field!=='observedAt')f.snapshot.revision++;
    if(field!=='revision')f.snapshot.observedAt='2026-10-08T18:00:20.000Z';
    f.snapshot.currentWorktrees=structuredClone(f.rows);
    const reads=f.read.mock.calls.length;
    expect(f.selector.resolveProjectWorkspace(request)).toEqual(original);
    expect(f.read).toHaveBeenCalledTimes(reads+1);
    expect(f.selector.getProjectWorkspaceOptions().observedAt).toBe(f.snapshot.observedAt);
  });
  it('does not invalidate an unchanged choice for unrelated rows or row ordering',()=>{
    const f=setup([workspace('one'),workspace('two')]),request=f.selection();
    f.rows[1].branch='unrelated-change';f.snapshot.currentWorktrees=[f.rows[1],f.rows[0],workspace('three')];
    f.snapshot.revision++;f.snapshot.observedAt='2026-10-08T18:00:20.000Z';
    expect(f.selector.resolveProjectWorkspace(request)).toMatchObject({worktreeId:'one',branch:'feature/one'});
  });
  it('survives a real same-content foreground poll but still rejects failed, aged and in-flight observations',async()=>{
    vi.useFakeTimers();vi.setSystemTime('2026-10-08T18:00:00.000Z');
    let failed=false;
    const rows=[workspace()],store=createSnapshotStore({intervalMs:20_000,staleAfterMs:40_000,backgroundIntervalMs:300_000,
      load:async()=>failed?{kind:'failure' as const,error:{kind:'synthetic-failure',message:'Synthetic collector failed'}}:
        {kind:'success' as const,runtimeId:'runtime-one',observedAt:new Date().toISOString(),coverage:null,value:rows}});
    const selector=createProjectWorkspaceSelector(()=>{const s=store.getState();return {connected:true,disposed:s.disposed,
      refreshing:s.refreshing,freshness:s.freshness,localHostId:'local',runtimeId:s.runtimeId,revision:s.revision,
      observedAt:s.observedAt,currentWorktrees:s.value??[]};});
    try{
      await store.start();const original=selector.getProjectWorkspaceOptions().options[0],request={optionId:original.optionId,expectedFingerprint:original.fingerprint};
      await vi.advanceTimersByTimeAsync(20_000);
      expect(store.getState()).toMatchObject({revision:2,freshness:'current',refreshing:false,value:rows});
      expect(selector.resolveProjectWorkspace(request)).toEqual(original);
      failed=true;await store.refresh();
      expect(store.getState()).toMatchObject({revision:2,freshness:'stale',lastAttempt:{outcome:'error'}});
      expect(()=>selector.resolveProjectWorkspace(request)).toThrow();
      failed=false;await store.refresh();expect(selector.resolveProjectWorkspace(request)).toEqual(original);
      store.setActivity({active:false});await vi.advanceTimersByTimeAsync(40_000);
      expect(selector.getProjectWorkspaceOptions()).toMatchObject({state:'unavailable',reason:'stale'});
      expect(()=>selector.resolveProjectWorkspace(request)).toThrow();
      const refresh=store.refresh();expect(()=>selector.resolveProjectWorkspace(request)).toThrow();await refresh;
      expect(selector.resolveProjectWorkspace(request)).toEqual(original);
    }finally{store.dispose();vi.useRealTimers();}
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
      f=>{f.rows[0].repository={...f.rows[0].repository,label:'Changed name'};},
      f=>{f.rows[0].repository={...f.rows[0].repository,hostId:'foreign'};},
      f=>{f.rows[0].branch=null;},f=>{f.snapshot.localHostId='foreign';},f=>{f.snapshot.runtimeId='runtime-restarted';},
      f=>{f.snapshot.currentWorktrees=[...f.rows,{...f.rows[0],instanceId:'duplicate'}];},
    ];
    for(const mutate of mutations){const f=setup(),request=f.selection();mutate(f);f.snapshot.revision++;f.snapshot.observedAt='2026-10-08T18:00:20.000Z';expect(()=>f.selector.resolveProjectWorkspace(request)).toThrow();}
  });
  it('requires the new token after material change even when the displayed path and branch match',()=>{
    const f=setup(),old=f.selection();f.rows[0].instanceId='new-instance';f.snapshot.revision++;
    const current=f.selection();expect(current).not.toEqual(old);
    expect(()=>f.selector.resolveProjectWorkspace(old)).toThrow();
    expect(f.selector.resolveProjectWorkspace(current)).toMatchObject({path:f.rows[0].path,branch:f.rows[0].branch});
  });
  it('rejects a previously eligible choice excluded by the current response bound',()=>{
    const f=setup(),request=f.selection();f.snapshot.currentWorktrees=[...Array.from({length:128},(_,i)=>workspace('other-'+i)),...f.rows];
    expect(f.selector.getProjectWorkspaceOptions().omittedCount).toBe(1);
    expect(()=>f.selector.resolveProjectWorkspace(request)).toThrow();
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
  it('rejects forged, cross-option and mixed old/new tokens after benign refresh',()=>{
    const f=setup([workspace('one'),workspace('two')]),[one,two]=f.selector.getProjectWorkspaceOptions().options;
    f.snapshot.revision++;f.snapshot.observedAt='2026-10-08T18:00:20.000Z';
    const request={optionId:one.optionId,expectedFingerprint:one.fingerprint};
    for(const forged of [{...request,optionId:'project-workspace-'+'0'.repeat(64)},
      {...request,expectedFingerprint:two.fingerprint},{...request,optionId:two.optionId}])expect(()=>f.selector.resolveProjectWorkspace(forged)).toThrow();
    f.rows[0].instanceId='replacement';const next=f.selector.getProjectWorkspaceOptions().options[0];
    for(const mixed of [{...request,optionId:next.optionId},{...request,expectedFingerprint:next.fingerprint}])expect(()=>f.selector.resolveProjectWorkspace(mixed)).toThrow();
  });
});
