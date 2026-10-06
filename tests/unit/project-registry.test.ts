import {describe,it,expect} from 'vitest';
import {createProjectRegistry,projectId,projectRegistryCodec,type ProjectRegistryPayload} from '../../src/main/projects/registry';
import type {ResolvedNoteMapping} from '../../src/collector/notes';
import type {LiveWorkstreamView} from '../../src/shared/live';
const mapping:ResolvedNoteMapping={state:'resolved',hostId:'host',worktreeId:'tree',scopeId:'scope',canonicalWorktreePath:'/synthetic/tree',canonicalNotePath:'/synthetic/notes/project',canonicalDagPath:'/synthetic/notes/project/dag.yaml',dagId:'dag:synthetic'};
const id=projectId(mapping.hostId,mapping.dagId);
function view():LiveWorkstreamView{return {id,title:'Synthetic project',projectName:null,branch:null,archived:false,terminalConnected:false,terminalCount:0,agentState:'done',projectMapping:'matched',noteMapping:{state:'resolved',dagId:mapping.dagId,reason:null}};}
describe('app-owned project registry',()=>{
 it('deduplicates by canonical DAG and preserves user completion during rediscovery, worktree removal and restart',async()=>{
  let saved:{revision:number;payload:ProjectRegistryPayload}|null=null;
  const persistence={async read(){return structuredClone(saved);},async write(payload:ProjectRegistryPayload,revision:number|null){expect(revision).toBe(saved?.revision??null);return saved={revision:(revision??0)+1,payload:structuredClone(payload)};}};
  const r=createProjectRegistry({persistence});await r.load();await r.discover([mapping,{...mapping,worktreeId:'other',canonicalWorktreePath:'/synthetic/other'}]);expect(r.records()).toHaveLength(1);expect(r.records()[0].worktrees).toHaveLength(2);
  await r.capture([view()],[],false);await r.setStatus({projectId:id,status:'completed',expectedStatus:'active'});await r.discover([mapping]);await r.capture([{...view(),title:'Must not replace completed context'}],[],false);
  expect(r.records()[0]).toMatchObject({status:'completed',observation:{workstream:{title:'Synthetic project'}}});
  const reopened=createProjectRegistry({persistence});await reopened.load();expect(reopened.records()[0].status).toBe('completed');
  await reopened.capture([{...view(),title:'Explicit manual observation'}],[],true);expect(reopened.records()[0].status).toBe('completed');expect(reopened.records()[0].observation?.workstream.title).toBe('Explicit manual observation');
  await reopened.setStatus({projectId:id,status:'active',expectedStatus:'completed'});expect(reopened.records()[0].history.map(h=>h.status)).toEqual(['active','completed','active']);
 });
 it('does not report a state transition when persistence fails and rejects stale/foreign/extra requests',async()=>{
  const r=createProjectRegistry({persistence:{async read(){return null;},async write(){throw new Error('Synthetic denied');}}});await r.load();await expect(r.discover([mapping])).rejects.toThrow('Synthetic denied');expect(r.records()).toEqual([]);
  const memory=createProjectRegistry();await memory.load();await memory.discover([mapping]);
  for(const request of [{projectId:id,status:'done',expectedStatus:'active'},{projectId:'other',status:'completed',expectedStatus:'active'},{projectId:id,status:'completed',expectedStatus:'completed'},{projectId:id,status:'completed',expectedStatus:'active',path:'/private'}])await expect(memory.setStatus(request)).rejects.toThrow();expect(memory.records()[0].status).toBe('active');
 });
 it('rejects altered canonical identity and malformed cached source authority',async()=>{
  const r=createProjectRegistry();await r.load();await r.discover([mapping]);const payload={schemaVersion:1,projects:r.records()};expect(projectRegistryCodec.parse(payload)).toEqual(payload);
  for(const field of ['id','canonicalDagPath','changedAt'] as const){const corrupt=structuredClone(payload);corrupt.projects[0][field]='invalid';expect(()=>projectRegistryCodec.parse(corrupt)).toThrow();}
  await expect(r.discover([{...mapping,canonicalDagPath:'/synthetic/else/dag.yaml'}])).rejects.toThrow();
 });
});
