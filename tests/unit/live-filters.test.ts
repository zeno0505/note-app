import {describe,it,expect} from 'vitest';
import type {LiveWorkstreamView} from '../../src/shared/live';
import {filterLiveWorkstreams,inLiveScope} from '../../src/renderer/live-filters';
import {quotaGraph,costWidth} from '../../src/renderer/codeburn-graphs';
const row:LiveWorkstreamView={id:'one',title:'긴 한국어 작업 이름',projectName:'web',branch:null,archived:false,terminalConnected:false,terminalCount:0,agentState:'unknown',projectMapping:'matched',noteMapping:{state:'unresolved',reason:null,dagId:null},repository:{key:'host-a/repo-one',id:'repo-one',hostId:'host-a',projectId:null,label:'owner/web'},observation:{worktree:'observed',sidebarActivity:true,selected:false,workspaceStatus:'in-progress'}};
describe('live scope and exact repository filters',()=>{
  it('includes browser/sidebar activity without equating selected or terminal status to activity',()=>{
    expect(inLiveScope(row,'activity')).toBe(true);
    expect(inLiveScope({...row,terminalConnected:true,observation:{...row.observation!,sidebarActivity:false,selected:true}},'activity')).toBe(false);
    expect(inLiveScope({...row,observation:{...row.observation!,sidebarActivity:null}},'activity')).toBe(false);
  });
  it('keeps managed worktrees distinct from activity and missing historical projects',()=>{
    expect(inLiveScope({...row,observation:{...row.observation!,sidebarActivity:false}},'observed')).toBe(true);
    const project:NonNullable<LiveWorkstreamView['project']>={status:'active',changedAt:'2026-10-06T00:00:00Z',history:[],worktreeState:'missing',sourceState:'not-checked'};
    const missing={...row,project,observation:{...row.observation!,worktree:'not-observed' as const}};
    expect(inLiveScope(missing,'observed')).toBe(false);expect(inLiveScope(missing,'retained')).toBe(true);
    expect(inLiveScope({...row,archived:true},'observed')).toBe(false);
  });
  it('uses opaque repository identity even for same display names and applies scope to registered cards',()=>{
    const project:NonNullable<LiveWorkstreamView['project']>={status:'active',changedAt:'2026-10-06T00:00:00Z',history:[],worktreeState:'present',sourceState:'available'};
    const rows=[{...row,project},{...row,id:'other',repository:{...row.repository!,key:'host-b/repo-two'}},{...row,id:'inactive',project,observation:{...row.observation!,sidebarActivity:false}}];
    expect(filterLiveWorkstreams(rows,{scope:'activity',repository:'host-a/repo-one',project:'all',search:'한국어'}).map(w=>w.id)).toEqual(['one']);
    expect(rows).toHaveLength(3);
  });
});
describe('observed graphs',()=>{
  it('preserves exhausted/over-100 raw observations while bounding meter and computed remaining',()=>{
    expect(quotaGraph(100)).toEqual({width:100,remaining:0});expect(quotaGraph(125)).toEqual({width:100,remaining:0});expect(quotaGraph(21)).toEqual({width:21,remaining:79});
  });
  it('compares actual period costs without inventing a monetary budget',()=>{
    expect(costWidth(2,[2,8])).toBe(25);expect(costWidth(0,[0,0])).toBe(0);
  });
});
