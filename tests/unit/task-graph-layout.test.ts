import {describe,it,expect} from 'vitest';
import {produceTaskGraph} from '../../src/main/task-graph';
import {assembleGraphSnapshot} from '../../src/shared/task-graph-transport';
import {graphGroupKey} from '../../src/shared/task-graph-contract';
import {layoutGraphSnapshot,visibleGraphNodes,visibleGraphRoutes,projectGraphViewport,graphDirectRelations,graphLayoutKey,graphRoutePath,isCurrentGraphLayout,graphRenderCandidates,GRAPH_LAYOUT_GEOMETRY as G,type GraphRect} from '../../src/shared/task-graph-layout';
import {syntheticChain,syntheticNode,syntheticAdversarial,syntheticHighDegree,type SyntheticGraphTask} from '../helpers/task-graph-fixtures';
import type {DagReadModel} from '../../src/facts/dag-read-model';
const base={projectId:'project',dagId:'dag',sessionKey:'session'};
function snapshot(rows:readonly SyntheticGraphTask[]) {
  const model:DagReadModel={dagId:'dag',sourceHash:'hash',sourceMtimeMs:0,observedAt:'2026-10-14T00:00:00Z',doneStatus:'done',tasks:rows.map(r=>({id:r.id,title:r.title,status:r.declaredStatus,phase:r.phase,dependencies:r.dependencies,e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitVerification:'not-performed'})),statusCounts:[],coverage:{tasksTotal:rows.length,declared:0,required:0,uncoveredDone:[],uncoveredOpen:[],malformed:[]},verifiedFacts:[]};
  const produced=produceTaskGraph(model,base);return assembleGraphSnapshot(produced.metadata,produced.chunks);
}
const all={grouping:'prefix' as const,groupKey:null};
const viewport={x:0,y:0,width:1280,height:800};
const overlap=(a:GraphRect,b:GraphRect)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
describe('complete-source deterministic layout',()=>{
  it.each([0,1,387,1001,10000])('lays out %i nodes without pagination or recursion',count=>{
    const layout=layoutGraphSnapshot(snapshot(syntheticChain(count)),all);
    expect(layout.nodes).toHaveLength(count);expect(layout.edges).toHaveLength(Math.max(0,count-1));
    if(count)expect(layout.positionById.get(`S-${count}`)?.depth).toBe(count-1);
    expect(layout.width).toBeGreaterThan(0);expect(layout.height).toBeGreaterThan(0);
    expect(visibleGraphNodes(layout,viewport).length).toBeLessThanOrEqual(6);
  });
  it('is invariant to source row/declaration ordering',()=>{
    const source=snapshot(syntheticAdversarial()),first=layoutGraphSnapshot(source,all),other=layoutGraphSnapshot({...source,nodes:[...source.nodes].reverse(),edges:[...source.edges].reverse()},all);
    expect(other).toEqual(first);
  });
  it('distinguishes bidirectional aggregate links, actual SCCs and self loops',()=>{
    const layout=layoutGraphSnapshot(snapshot(syntheticAdversarial()),all);
    expect(layout.cycles).toEqual([['C-1','C-2'],['D-1']]);
    expect(layout.nodes.filter(n=>n.cycle).map(n=>n.id)).toEqual(['C-1','C-2','D-1']);
    expect(layout.groupLinks.filter(l=>l.fromGroupKey.includes('A')||l.fromGroupKey.includes('B'))).toHaveLength(3);
    expect(layout.groupLinks.every(l=>l.semantics==='aggregate-only')).toBe(true);
    expect(layout.index.nodeById.has('E-1')).toBe(false);
  });
  it('calculates group-internal depths independently but retains global adjacency',()=>{
    const rows=[syntheticNode('A-1'),syntheticNode('B-1',['A-1']),syntheticNode('B-2',['B-1']),syntheticNode('A-2',['B-2'])],source=snapshot(rows);
    const groupKey=graphGroupKey(rows[1],'prefix'),layout=layoutGraphSnapshot(source,{grouping:'prefix',groupKey});
    expect(layout.nodes.map(n=>[n.id,n.depth])).toEqual([['B-1',0],['B-2',1]]);
    expect(graphDirectRelations(layout,'B-1')!.predecessors[0].from.id).toBe('A-1');
    expect(layout.groups.reduce((n,g)=>n+g.nodeCount,0)).toBe(4);
    expect(layout.groups.reduce((n,g)=>n+g.internalEdgeCount,0)+layout.groupLinks.reduce((n,l)=>n+l.uniqueEdgeCount,0)).toBe(3);
  });
  it('retains real source cycles spanning groups without using group links as evidence',()=>{
    const rows=[syntheticNode('A-1',['B-1']),syntheticNode('B-1',['A-1'])],source=snapshot(rows);
    const layout=layoutGraphSnapshot(source,{grouping:'prefix',groupKey:graphGroupKey(rows[0],'prefix')});
    expect(layout.cycles).toEqual([]);expect(layout.sourceCycles).toEqual([['A-1','B-1']]);
    expect(layout.nodes[0].cycle).toBe(true);expect(layout.edges).toHaveLength(0);
  });
  it('marks an internal edge of a global cross-group SCC as cyclic even when its group is locally acyclic',()=>{
    const rows=[syntheticNode('A-1',['B-1']),syntheticNode('A-2',['A-1']),syntheticNode('B-1',['A-2'])],source=snapshot(rows);
    const layout=layoutGraphSnapshot(source,{grouping:'prefix',groupKey:graphGroupKey(rows[0],'prefix')});
    expect(layout.cycles).toEqual([]);expect(layout.sourceCycles).toEqual([['A-1','A-2','B-1']]);
    expect(layout.edges).toHaveLength(1);expect(layout.edges[0].cycle).toBe(true);
    expect(layout.nodes.map(n=>n.depth)).toEqual([0,1]);
  });
  it('retains numeric slots across refreshed sessions without reusing old data or mixing projects',()=>{
    const first=layoutGraphSnapshot(snapshot([syntheticNode('S-2'),syntheticNode('S-4')]),all);
    const next=snapshot([syntheticNode('S-1'),syntheticNode('S-2'),syntheticNode('S-4')]);
    const current=layoutGraphSnapshot(next,{...all,previous:first});
    expect(current.positionById.get('S-2')).toMatchObject({x:first.positionById.get('S-2')!.x,y:first.positionById.get('S-2')!.y});
    expect(current.positionById.get('S-1')!.row).toBe(2);
    next.metadata.identity={...next.metadata.identity,sessionKey:'new-session'};
    const refreshed=layoutGraphSnapshot(next,{...all,previous:first});expect(refreshed.positionById.get('S-1')!.row).toBe(2);
    expect(refreshed.identity.sessionKey).toBe('new-session');expect(refreshed.index.nodeById.get('S-1')).toBe(next.nodes.find(n=>n.id==='S-1'));
    expect(graphLayoutKey(first.identity,'prefix',null)).toBe(graphLayoutKey(next.metadata.identity,'prefix',null));
    next.metadata.identity={...next.metadata.identity,projectId:'different-project'};
    const reset=layoutGraphSnapshot(next,{...all,previous:first});expect(reset.positionById.get('S-1')!.row).toBe(0);
    expect(graphLayoutKey(first.identity,'prefix',null)).not.toBe(graphLayoutKey(next.metadata.identity,'prefix',null));
    expect(isCurrentGraphLayout(first,next.metadata.identity)).toBe(false);
  });
  it('does not revive revoked nodes or retain slots across DAG/grouping/group changes',()=>{
    const rows=[syntheticNode('A-1'),syntheticNode('A-2'),syntheticNode('B-1')],old=layoutGraphSnapshot(snapshot(rows),all),source=snapshot([syntheticNode('A-0'),syntheticNode('A-2')]);
    source.metadata.identity={...source.metadata.identity,sessionKey:'renewed-after-revocation'};
    const current=layoutGraphSnapshot(source,{...all,previous:old});expect(current.positionById.has('A-1')).toBe(false);expect(current.index.nodeById.has('B-1')).toBe(false);
    source.metadata.identity={...source.metadata.identity,dagId:'another-dag'};
    expect(layoutGraphSnapshot(source,{...all,previous:old}).positionById.get('A-0')!.row).toBe(0);
    source.metadata.identity={...source.metadata.identity,dagId:old.identity.dagId};
    expect(layoutGraphSnapshot(source,{grouping:'ungrouped',groupKey:null,previous:old}).positionById.get('A-0')!.row).toBe(0);
    expect(layoutGraphSnapshot(source,{grouping:'prefix',groupKey:graphGroupKey(source.nodes[0],'prefix'),previous:old}).positionById.get('A-0')!.row).toBe(0);
  });
  it('releases deleted slots and moves nodes only as required by new dependency depth',()=>{
    const previous=layoutGraphSnapshot(snapshot([syntheticNode('S-1'),syntheticNode('S-2'),syntheticNode('S-3')]),all);
    const next=layoutGraphSnapshot(snapshot([syntheticNode('S-0'),syntheticNode('S-2'),syntheticNode('S-3',['S-2'])]),{...all,previous});
    expect(next.positionById.has('S-1')).toBe(false);expect(next.positionById.get('S-0')!.row).toBe(0);
    expect(next.positionById.get('S-2')!.row).toBe(1);expect(next.positionById.get('S-3')!.depth).toBe(1);
  });
  it('preserves 12 direct predecessors without fabricating unresolved/duplicate nodes',()=>{
    const layout=layoutGraphSnapshot(snapshot(syntheticHighDegree()),all);expect(graphDirectRelations(layout,'S-13')!.predecessors).toHaveLength(12);
    expect(graphDirectRelations(layout,'missing')).toBeNull();
    const bad=layoutGraphSnapshot(snapshot(syntheticAdversarial()),all);expect(graphDirectRelations(bad,'unparsed')!.predecessors.filter(e=>e.from.kind==='unresolved')).toHaveLength(3);
  });
  it('keeps cards disjoint and routes outside every unrelated card, including SCC/back/self/long edges',()=>{
    const rows=[...syntheticAdversarial(),...syntheticHighDegree(),syntheticNode('S-14',['S-1','S-13']),syntheticNode('S-15',['S-14']),syntheticNode('S-16',['S-1'])];
    const layout=layoutGraphSnapshot(snapshot(rows),all);
    for(let i=0;i<layout.nodes.length;i++)for(let j=i+1;j<layout.nodes.length;j++)expect(overlap(layout.nodes[i],layout.nodes[j])).toBe(false);
    for(const route of layout.edges)for(let p=1;p<route.points.length;p++){
      const a=route.points[p-1],b=route.points[p];expect(a.x===b.x||a.y===b.y).toBe(true);
      for(const node of layout.nodes){
        const horizontal=a.y===b.y&&a.y>node.y&&a.y<node.y+node.height&&Math.max(a.x,b.x)>node.x&&Math.min(a.x,b.x)<node.x+node.width;
        const vertical=a.x===b.x&&a.x>node.x&&a.x<node.x+node.width&&Math.max(a.y,b.y)>node.y&&Math.min(a.y,b.y)<node.y+node.height;
        expect(horizontal||vertical,`${route.id} crossed ${node.id}`).toBe(false);
      }
    }
    expect(graphRoutePath(layout.edges[0])).toMatch(/^M /);
  });
  it('handles every grouping including missing/unparsed identities and unknown selected group',()=>{
    const source=snapshot(syntheticAdversarial());for(const grouping of ['prefix','phase','ungrouped'] as const){const layout=layoutGraphSnapshot(source,{grouping,groupKey:null});expect(layout.groups.reduce((n,g)=>n+g.nodeCount,0)).toBe(source.nodes.length);}
    expect(layoutGraphSnapshot(source,{grouping:'prefix',groupKey:'not-a-group'}).nodes).toHaveLength(0);
  });
  it('rejects bypassed ambiguous/oversized input and invalid grouping',()=>{
    const source=snapshot(syntheticChain(1));expect(()=>layoutGraphSnapshot({...source,nodes:[...source.nodes,...source.nodes]},all)).toThrow('invalid-schema');
    expect(()=>layoutGraphSnapshot({...source,nodes:Array(10001).fill(source.nodes[0])},all)).toThrow('unsupported');
    expect(()=>layoutGraphSnapshot(source,{...all,grouping:'bad' as never})).toThrow('invalid-request');
  });
});
describe('viewport culling and independent semantic projection',()=>{
  it('uses both dimensions, inclusive edge intersections and exact fractional coordinates',()=>{
    const layout=layoutGraphSnapshot(snapshot(Array.from({length:1001},(_,i)=>syntheticNode(`S-${i}`))),all);
    const node=layout.nodes[0];expect(visibleGraphNodes(layout,{x:node.x+G.width-.5,y:node.y+G.height-.5,width:1,height:1}).some(n=>n.id===node.id)).toBe(true);
    expect(visibleGraphNodes(layout,{x:node.x+G.width+1,y:node.y,width:1,height:1})).toHaveLength(0);
    expect(visibleGraphNodes(layout,{x:0,y:0,width:0,height:100})).toHaveLength(0);
    expect(()=>visibleGraphNodes(layout,{x:NaN,y:0,width:1,height:1})).toThrow('invalid-viewport');
  });
  it('partitions all source nodes/unique edges and distinguishes filtered, other-group, offscreen and unresolved',()=>{
    const source=snapshot(syntheticAdversarial()),layout=layoutGraphSnapshot(source,{grouping:'prefix',groupKey:graphGroupKey(source.nodes.find(n=>n.id==='A-1')!,'prefix')});
    const p=projectGraphViewport(layout,viewport,new Set(['A-1']));
    expect(Object.entries(p.counts.nodes).filter(([key])=>key!=='total').reduce((n,[,v])=>n+v,0)).toBe(p.counts.nodes.total);
    expect(p.counts.edges.internal+p.counts.edges.boundary+p.counts.edges.outside).toBe(p.counts.edges.total);
    expect(p.edges.some(e=>e.from==='other-group')).toBe(true);expect(p.edges.some(e=>e.to==='filtered')).toBe(true);expect(p.edges.some(e=>e.from==='unresolved')).toBe(true);
    expect(p.edges.filter(e=>e.viewport==='boundary').length).toBe(p.counts.edges.boundary);
    const full=layoutGraphSnapshot(snapshot(syntheticChain(1001)),all),small=projectGraphViewport(full,viewport);expect(small.edges.some(e=>e.to==='viewport-outside')).toBe(true);
  });
  it('culls routes spatially, including edges crossing the viewport with both cards outside',()=>{
    const layout=layoutGraphSnapshot(snapshot([...syntheticChain(10),syntheticNode('S-11',['S-1','S-10'])]),all);
    const edge=layout.edges.find(e=>e.from==='S-1'&&e.to==='S-11')!,middle=edge.points[2],view={x:600,y:middle.y-1,width:20,height:2};
    expect(visibleGraphNodes(layout,view)).toHaveLength(0);expect(visibleGraphRoutes(layout,view).map(e=>e.id)).toContain(edge.id);
    expect(visibleGraphRoutes(layout,view,new Set(['S-1']))).toHaveLength(0);
    expect(visibleGraphRoutes(layout,{x:-100,y:-100,width:1,height:1})).toHaveLength(0);
    expect(visibleGraphRoutes(layout,{x:0,y:0,width:0,height:1})).toHaveLength(0);
  });
  it('reports dense-route budgets without silently truncating source or visible connections',()=>{
    const layout=layoutGraphSnapshot(snapshot(Array.from({length:1001},(_,i)=>syntheticNode(`S-${i}`,i?['S-0']:[]))),all);
    const result=graphRenderCandidates(layout,viewport,{nodeBudget:100,routeBudget:200});
    expect(result.nodes.length).toBeLessThan(100);expect(result.routes).toHaveLength(1000);
    expect(result.counts.sourceEdges).toBe(1000);expect(result.exceeded).toEqual({nodes:false,routes:true});
    expect(()=>graphRenderCandidates(layout,viewport,{nodeBudget:NaN,routeBudget:200})).toThrow('invalid-budget');
  });
  it('matches brute-force card intersection at many deterministic viewports without changing positions',()=>{
    const rows=Array.from({length:387},(_,i)=>syntheticNode(`S-${i}`,i>12?[`S-${i-13}`]:[])),layout=layoutGraphSnapshot(snapshot(rows),all),before=JSON.stringify(layout.nodes);
    for(let i=0;i<50;i++){const view={x:i*81,y:i*17,width:419,height:213};const actual=visibleGraphNodes(layout,view).map(n=>n.id).sort(),expected=layout.nodes.filter(n=>n.x<=view.x+view.width&&n.x+n.width>=view.x&&n.y<=view.y+view.height&&n.y+n.height>=view.y).map(n=>n.id).sort();expect(actual).toEqual(expected);}
    projectGraphViewport(layout,viewport,new Set(['S-1']));graphDirectRelations(layout,'S-1');expect(JSON.stringify(layout.nodes)).toBe(before);
  });
});
