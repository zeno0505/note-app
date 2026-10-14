import {
  TASK_GRAPH_LIMITS, graphGroupKey, sameGraphIdentity,
  type GraphGrouping, type GraphSourceNode, type GraphSourceEdge, type GraphGroupSummary,
  type GraphGroupLink, type TaskGraphIdentity,
} from './task-graph-contract';
import type {AssembledGraphSnapshot} from './task-graph-transport';

/** Geometry is in world CSS pixels. UI state (hover, selection, filters, zoom) is
 * intentionally absent: none of those operations may move source nodes. */
export const GRAPH_LAYOUT_VERSION = 1 as const;
export const GRAPH_LAYOUT_GEOMETRY = Object.freeze({width: 184, height: 58, columnGap: 34, rowGap: 16, margin: 24});
export interface GraphPoint {x: number; y: number}
export interface GraphRect extends GraphPoint {width: number; height: number}
export interface GraphPosition extends GraphRect {id: string; depth: number; row: number; cycle: boolean; component: number}
export interface GraphRoute {id: string; from: string; to: string; cycle: boolean; points: readonly GraphPoint[]; bounds: GraphRect}
export type GraphRouteIndex = {bounds: GraphRect; routes: readonly GraphRoute[]} | {bounds: GraphRect; left: GraphRouteIndex; right: GraphRouteIndex};
export interface GraphColumn {depth: number; x: number; nodes: readonly GraphPosition[]}
export interface GraphLayout {
  version: typeof GRAPH_LAYOUT_VERSION; identity: TaskGraphIdentity; grouping: GraphGrouping; groupKey: string | null;
  nodes: readonly GraphPosition[]; edges: readonly GraphRoute[]; width: number; height: number;
  routeIndex: GraphRouteIndex | null;
  columns: readonly GraphColumn[]; positionById: ReadonlyMap<string, GraphPosition>;
  /** These SCCs are computed from real task edges, never group links. */
  cycles: readonly (readonly string[])[];
  /** Global source SCCs remain visible as diagnostics even across group boundaries. */
  sourceCycles: readonly (readonly string[])[];
  groups: readonly GraphGroupSummary[]; groupLinks: readonly GraphGroupLink[];
  index: GraphSourceIndex;
}
export interface GraphLayoutOptions {grouping: GraphGrouping; groupKey: string | null; previous?: GraphLayout}
export interface GraphSourceIndex {
  nodeById: ReadonlyMap<string, GraphSourceNode>; edgeById: ReadonlyMap<string, GraphSourceEdge>;
  incoming: ReadonlyMap<string, readonly string[]>; outgoing: ReadonlyMap<string, readonly string[]>;
  groupById: ReadonlyMap<string, string>;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Input is the validated complete transport snapshot. Reject ambiguity even for
 * callers bypassing transport; unresolved references remain evidence, not nodes. */
export function createGraphSourceIndex(snapshot: AssembledGraphSnapshot, grouping: GraphGrouping): GraphSourceIndex {
  if (snapshot.nodes.length > TASK_GRAPH_LIMITS.sourceNodes || snapshot.edges.length > TASK_GRAPH_LIMITS.sourceEdges) throw Error('unsupported');
  const nodeById = new Map<string, GraphSourceNode>(), edgeById = new Map<string, GraphSourceEdge>();
  const incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>(), groupById = new Map<string, string>();
  for (const node of [...snapshot.nodes].sort((a,b) => compare(a.id,b.id))) {
    if (nodeById.has(node.id)) throw Error('invalid-schema');
    nodeById.set(node.id,node); incoming.set(node.id,[]); outgoing.set(node.id,[]); groupById.set(node.id,graphGroupKey(node,grouping));
  }
  for (const edge of [...snapshot.edges].sort((a,b) => compare(a.id,b.id))) {
    if (edgeById.has(edge.id)) throw Error('invalid-schema');
    edgeById.set(edge.id,edge);
    for (const [endpoint, target] of [[edge.from,outgoing],[edge.to,incoming]] as const) {
      if (endpoint.kind === 'node') {
        const adjacency = target.get(endpoint.id); if (!adjacency) throw Error('invalid-schema'); adjacency.push(edge.id);
      }
    }
  }
  return {nodeById,edgeById,incoming,outgoing,groupById};
}

function aggregate(index: GraphSourceIndex, grouping: GraphGrouping) {
  const groups = new Map<string, {key: string; count: number; internal: number; statuses: Map<string|null,number>}>();
  for (const node of index.nodeById.values()) {
    const key=index.groupById.get(node.id)!;
    const group=groups.get(key)??{key,count:0,internal:0,statuses:new Map<string|null,number>()};
    group.count++; group.statuses.set(node.declaredStatus,(group.statuses.get(node.declaredStatus)??0)+1); groups.set(key,group);
  }
  const links=new Map<string,GraphGroupLink>();
  for(const edge of index.edgeById.values()) {
    if(edge.from.kind!=='node'||edge.to.kind!=='node')continue;
    const from=index.groupById.get(edge.from.id)!,to=index.groupById.get(edge.to.id)!;
    if(from===to)groups.get(from)!.internal++;
    else {const key=JSON.stringify([from,to]); const link=links.get(key)??{fromGroupKey:from,toGroupKey:to,uniqueEdgeCount:0,semantics:'aggregate-only' as const};link.uniqueEdgeCount++;links.set(key,link);}
  }
  return {
    groups:[...groups.values()].sort((a,b)=>compare(a.key,b.key)).map(g=>({key:g.key,grouping,nodeCount:g.count,internalEdgeCount:g.internal,declaredStatusCounts:[...g.statuses].sort(([a],[b])=>a===null?-1:b===null?1:compare(a,b)).map(([status,count])=>({status,count}))})),
    groupLinks:[...links.values()].sort((a,b)=>compare(a.fromGroupKey,b.fromGroupKey)||compare(a.toGroupKey,b.toGroupKey)),
  };
}

/** Iterative SCC condensation and longest-path depths on the entire chosen group,
 * not a viewport/page/filter. A 10,000-node chain never recurses or wraps columns. */
export function layoutGraphSnapshot(snapshot: AssembledGraphSnapshot, options: GraphLayoutOptions): GraphLayout {
  if(!['prefix','phase','ungrouped'].includes(options.grouping)||options.groupKey!==null&&typeof options.groupKey!=='string')throw Error('invalid-request');
  const index=createGraphSourceIndex(snapshot,options.grouping), ids=[...index.nodeById.keys()].filter(id=>options.groupKey===null||index.groupById.get(id)===options.groupKey);
  const included=new Set(ids), forward=new Map(ids.map(id=>[id,[] as string[]])), reverse=new Map(ids.map(id=>[id,[] as string[]]));
  const internal:GraphSourceEdge[]=[];
  for(const edge of index.edgeById.values())if(edge.from.kind==='node'&&edge.to.kind==='node'&&included.has(edge.from.id)&&included.has(edge.to.id)) {
    internal.push(edge);forward.get(edge.from.id)!.push(edge.to.id);reverse.get(edge.to.id)!.push(edge.from.id);
  }
  const visited=new Set<string>(),finished:string[]=[];
  for(const start of ids) {
    if(visited.has(start))continue;visited.add(start);const stack=[{id:start,next:0}];
    while(stack.length) {const current=stack[stack.length-1],adjacent=forward.get(current.id)!;
      if(current.next===adjacent.length){finished.push(current.id);stack.pop();}
      else {const next=adjacent[current.next++];if(!visited.has(next)){visited.add(next);stack.push({id:next,next:0});}}
    }
  }
  const componentById=new Map<string,number>(),components:string[][]=[];
  for(let i=finished.length-1;i>=0;i--) {
    const start=finished[i];if(componentById.has(start))continue;const number=components.length,members:string[]=[],stack=[start];componentById.set(start,number);
    while(stack.length){const id=stack.pop()!;members.push(id);for(const next of reverse.get(id)!)if(!componentById.has(next)){componentById.set(next,number);stack.push(next);}}
    components.push(members.sort(compare));
  }
  const cycles=components.filter(ids=>ids.length>1||forward.get(ids[0])!.includes(ids[0])).sort((a,b)=>compare(a[0],b[0]));
  const cyclic=new Set([...cycles.flat(),...snapshot.metadata.diagnostics.cycles.flat()]),componentEdges=components.map(()=>new Set<number>()),indegree=components.map(()=>0),depth=components.map(()=>0);
  for(const edge of internal){const a=componentById.get(edge.from.id)!,b=componentById.get(edge.to.id)!;if(a!==b&&!componentEdges[a].has(b)){componentEdges[a].add(b);indegree[b]++;}}
  const queue=indegree.flatMap((value,i)=>value===0?[i]:[]);
  for(let cursor=0;cursor<queue.length;cursor++){const from=queue[cursor];for(const to of componentEdges[from]){depth[to]=Math.max(depth[to],depth[from]+1);if(--indegree[to]===0)queue.push(to);}}
  const old=options.previous, identity=snapshot.metadata.identity;
  // Reuse geometry only, never prior source/selection/authority. Main renews the
  // session on every refresh, so numeric slots intentionally outlive a token.
  // Every retained ID and depth is recalculated from the current valid source.
  const retain=old?.version===GRAPH_LAYOUT_VERSION&&old.grouping===options.grouping&&old.groupKey===options.groupKey&&old.identity.projectId===identity.projectId&&old.identity.dagId===identity.dagId;
  const ranks=new Map<number,string[]>();for(const id of ids){const d=depth[componentById.get(id)!],rank=ranks.get(d)??[];rank.push(id);ranks.set(d,rank);}
  const nodes:GraphPosition[]=[],columns:GraphColumn[]=[],{width,height,columnGap,rowGap,margin}=GRAPH_LAYOUT_GEOMETRY;
  for(const [d,rank] of [...ranks].sort(([a],[b])=>a-b)) {
    const used=new Set<number>(),rows=new Map<string,number>();
    if(retain)for(const id of rank){const prior=old.positionById.get(id);if(prior?.depth===d&&Number.isSafeInteger(prior.row)&&prior.row>=0&&prior.row<TASK_GRAPH_LIMITS.sourceNodes&&!used.has(prior.row)){used.add(prior.row);rows.set(id,prior.row);}}
    let next=0;const column:GraphPosition[]=[];
    for(const id of rank){if(!rows.has(id)){while(used.has(next))next++;rows.set(id,next);used.add(next);}
      const row=rows.get(id)!,position={id,x:margin+d*(width+columnGap),y:margin+row*(height+rowGap),width,height,depth:d,row,cycle:cyclic.has(id),component:componentById.get(id)!};nodes.push(position);column.push(position);}
    column.sort((a,b)=>a.row-b.row);columns.push({depth:d,x:margin+d*(width+columnGap),nodes:column});
  }
  const positionById=new Map(nodes.map(node=>[node.id,node])),edges:GraphRoute[]=[];
  const sourceComponent=new Map<string,number>();
  snapshot.metadata.diagnostics.cycles.forEach((members,component)=>members.forEach(id=>sourceComponent.set(id,component)));
  for(const edge of internal) {
    const from=positionById.get(edge.from.id)!,to=positionById.get(edge.to.id)!;
    const start={x:from.x+width,y:from.y+height/2},end={x:to.x,y:to.y+height/2};
    const cycle=from.component===to.component&&from.cycle
      ||sourceComponent.has(from.id)&&sourceComponent.get(from.id)===sourceComponent.get(to.id);
    // Row-gap highways and column-gap risers never pass through another card.
    // Same-row adjacent columns need no detour; long edges use a row gap.
    const points:GraphPoint[]=to.depth===from.depth+1&&to.row===from.row?[start,end]:[
      start,{x:start.x+columnGap/3,y:start.y},{x:start.x+columnGap/3,y:from.y+height+rowGap/2},
      {x:end.x-columnGap/3,y:from.y+height+rowGap/2},{x:end.x-columnGap/3,y:end.y},end,
    ];
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);
    edges.push({id:edge.id,from:from.id,to:to.id,cycle,points,bounds:{x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y}});
  }
  let extentX=margin*2,extentY=margin*2;for(const node of nodes){extentX=Math.max(extentX,node.x+width+margin);extentY=Math.max(extentY,node.y+height+margin);}
  return {routeIndex:buildRouteIndex(edges),version:GRAPH_LAYOUT_VERSION,identity,grouping:options.grouping,groupKey:options.groupKey,nodes,edges,width:extentX,height:extentY,columns,positionById,cycles,sourceCycles:snapshot.metadata.diagnostics.cycles,index,...aggregate(index,options.grouping)};
}

function validRect(rect:GraphRect) {if(![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)||rect.width<0||rect.height<0)throw Error('invalid-viewport');}
function intersects(a:GraphRect,b:GraphRect){return a.x<=b.x+b.width&&a.x+a.width>=b.x&&a.y<=b.y+b.height&&a.y+a.height>=b.y;}
function lowerBound<T>(array:readonly T[],value:number,key:(item:T)=>number) {let low=0,high=array.length;while(low<high){const mid=(low+high)>>>1;if(key(array[mid])<value)low=mid+1;else high=mid;}return low;}

/** Viewport is in world coordinates, not screen pixels. Bounds queries use sorted
 * depth columns/rows: O(log columns + visible columns * log rows + candidates).
 * A caller may pin a focused node in its DOM separately, never alter these counts. */
export function visibleGraphNodes(layout:GraphLayout,viewport:GraphRect,filter?:ReadonlySet<string>):readonly GraphPosition[] {
  validRect(viewport);if(viewport.width===0||viewport.height===0)return [];
  const result:GraphPosition[]=[],g=GRAPH_LAYOUT_GEOMETRY;
  for(let c=lowerBound(layout.columns,viewport.x-g.width,column=>column.x);c<layout.columns.length;c++) {
    const column=layout.columns[c];if(column.x>viewport.x+viewport.width)break;
    for(let n=lowerBound(column.nodes,viewport.y-g.height,node=>node.y);n<column.nodes.length;n++) {
      const node=column.nodes[n];if(node.y>viewport.y+viewport.height)break;
      if((!filter||filter.has(node.id))&&intersects(node,viewport))result.push(node);
    }
  }
  return result;
}
export type GraphEndpointLocation = 'visible'|'viewport-outside'|'filtered'|'other-group'|'unresolved';
export interface GraphEdgeProjection {id:string;viewport:'internal'|'boundary'|'outside';from:GraphEndpointLocation;to:GraphEndpointLocation}
export interface GraphViewportProjection {
  visibleNodes:readonly GraphPosition[]; edges:readonly GraphEdgeProjection[];
  counts:{nodes:{total:number;visible:number;viewportOutside:number;filtered:number;otherGroup:number};edges:{total:number;internal:number;boundary:number;outside:number}};
}
/** Explicit diagnostic projection over every source edge. Run on viewport/filter
 * changes, not every hover. Renderer can use visibleGraphNodes alone during drag. */
export function projectGraphViewport(layout:GraphLayout,viewport:GraphRect,filter?:ReadonlySet<string>):GraphViewportProjection {
  const visibleNodes=visibleGraphNodes(layout,viewport,filter),visible=new Set(visibleNodes.map(n=>n.id));
  let filtered=0;for(const node of layout.nodes)if(filter&&!filter.has(node.id))filtered++;
  const classify=(endpoint:GraphSourceEdge['from']):GraphEndpointLocation=>endpoint.kind==='unresolved'?'unresolved':!layout.positionById.has(endpoint.id)?'other-group':filter&&!filter.has(endpoint.id)?'filtered':visible.has(endpoint.id)?'visible':'viewport-outside';
  const counts={nodes:{total:layout.index.nodeById.size,visible:visible.size,viewportOutside:layout.nodes.length-filtered-visible.size,filtered,otherGroup:layout.index.nodeById.size-layout.nodes.length},edges:{total:layout.index.edgeById.size,internal:0,boundary:0,outside:0}};
  const edges:GraphEdgeProjection[]=[];for(const edge of layout.index.edgeById.values()){const from=classify(edge.from),to=classify(edge.to),kind=from==='visible'&&to==='visible'?'internal':from==='visible'||to==='visible'?'boundary':'outside';counts.edges[kind]++;edges.push({id:edge.id,viewport:kind,from,to});}
  return {visibleNodes,edges,counts};
}

/** Direct relation lookup is degree-bounded and returns all endpoint evidence,
 * including filtered/other-group/unresolved endpoints, without rebuilding layout. */
export function graphDirectRelations(layout:GraphLayout,id:string) {
  if(!layout.index.nodeById.has(id))return null;
  return {predecessors:(layout.index.incoming.get(id)??[]).map(id=>layout.index.edgeById.get(id)!),successors:(layout.index.outgoing.get(id)??[]).map(id=>layout.index.edgeById.get(id)!)};
}
export function graphLayoutKey(identity:TaskGraphIdentity,grouping:GraphGrouping,groupKey:string|null):string {
  return JSON.stringify([identity.projectId,identity.dagId,grouping,groupKey,GRAPH_LAYOUT_VERSION]);
}
export function isCurrentGraphLayout(layout:GraphLayout,identity:TaskGraphIdentity):boolean {return layout.version===GRAPH_LAYOUT_VERSION&&sameGraphIdentity(layout.identity,identity);}
export function graphRoutePath(route:GraphRoute):string {return route.points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ');}


/** A balanced bounds hierarchy avoids a full edge scan on every pan frame. It
 * includes routes crossing the viewport even when both endpoint cards are out. */
function buildRouteIndex(routes:readonly GraphRoute[]):GraphRouteIndex|null {
  if(!routes.length)return null;
  let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
  for(const {bounds:b} of routes){x=Math.min(x,b.x);y=Math.min(y,b.y);right=Math.max(right,b.x+b.width);bottom=Math.max(bottom,b.y+b.height);}
  const bounds={x,y,width:right-x,height:bottom-y};
  if(routes.length<=16)return {bounds,routes};
  const axis=bounds.width>=bounds.height?'x':'y',size=axis==='x'?'width':'height';
  const sorted=[...routes].sort((a,b)=>(a.bounds[axis]+a.bounds[size]/2)-(b.bounds[axis]+b.bounds[size]/2)||compare(a.id,b.id)),middle=sorted.length>>>1;
  return {bounds,left:buildRouteIndex(sorted.slice(0,middle))!,right:buildRouteIndex(sorted.slice(middle))!};
}
export function visibleGraphRoutes(layout:GraphLayout,viewport:GraphRect,filter?:ReadonlySet<string>):readonly GraphRoute[] {
  validRect(viewport);if(!layout.routeIndex||viewport.width===0||viewport.height===0)return [];
  const stack=[layout.routeIndex],routes:GraphRoute[]=[];
  while(stack.length){const branch=stack.pop()!;if(!intersects(branch.bounds,viewport))continue;
    if('routes' in branch){for(const route of branch.routes){if(filter&&(!filter.has(route.from)||!filter.has(route.to)))continue;
      if(!intersects(route.bounds,viewport))continue;
      if(route.points.some((point,i)=>{if(i===0)return false;const before=route.points[i-1];return intersects({x:Math.min(before.x,point.x),y:Math.min(before.y,point.y),width:Math.abs(before.x-point.x),height:Math.abs(before.y-point.y)},viewport);}))routes.push(route);
    }}else{stack.push(branch.right,branch.left);}
  }
  return routes;
}

export interface GraphRenderBudget {nodeBudget:number;routeBudget:number}
/** Budgets are supplied by a measured renderer, not assumed frame-rate promises.
 * Exceeding a budget reports density; it never silently truncates relationships. */
export function graphRenderCandidates(layout:GraphLayout,viewport:GraphRect,budget:GraphRenderBudget,filter?:ReadonlySet<string>) {
  if(!Number.isSafeInteger(budget.nodeBudget)||budget.nodeBudget<0||!Number.isSafeInteger(budget.routeBudget)||budget.routeBudget<0)throw Error('invalid-budget');
  const nodes=visibleGraphNodes(layout,viewport,filter),routes=visibleGraphRoutes(layout,viewport,filter);
  return {nodes,routes,counts:{sourceNodes:layout.index.nodeById.size,sourceEdges:layout.index.edgeById.size,layoutNodes:layout.nodes.length,layoutRoutes:layout.edges.length,visibleNodes:nodes.length,intersectingRoutes:routes.length},
    budget:{...budget},exceeded:{nodes:nodes.length>budget.nodeBudget,routes:routes.length>budget.routeBudget}};
}
