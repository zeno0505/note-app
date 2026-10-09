import type {TaskGraph} from './graph';
export const TASK_PAGE_SIZES=[25,50,100] as const;
export function taskPage<T>(items:readonly T[],requestedPage:number,size:number){
 const pageSize=TASK_PAGE_SIZES.includes(size as 25|50|100)?size:50;
 const count=Math.max(1,Math.ceil(items.length/pageSize)),page=Math.min(count,Math.max(1,Math.floor(requestedPage)||1)),start=(page-1)*pageSize;
 return {page,size:pageSize,count,start,end:Math.min(items.length,start+pageSize),items:items.slice(start,start+pageSize)};
}
/** Cross-page edges remain explicit references. No source edge is removed. */
export function pageConnections(graph:TaskGraph,pageIds:ReadonlySet<string>){
 return graph.edges.filter(edge=>edge.kind==='external'||edge.kind==='unknown'?pageIds.has(edge.to):pageIds.has(edge.from)!==pageIds.has(edge.to)).map(edge=>({...edge,direction:pageIds.has(edge.to)?'incoming' as const:'outgoing' as const}));
}
