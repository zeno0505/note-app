import {graphDirectRelations,type GraphLayout,type GraphRect} from '../shared/task-graph-layout';
import type {GraphSourceEdge} from '../shared/task-graph-contract';
export type RelationRole='predecessor'|'successor';
export interface GraphRelation {key:string;edgeId:string;role:RelationRole;endpoint:GraphSourceEdge['from']}
/** One-hop source index only. No rendering budget, display page or transitive expansion. */
export function graphRelationSet(layout:GraphLayout,id:string){
 const direct=graphDirectRelations(layout,id);
 const relations:GraphRelation[]=direct?[...direct.predecessors.map(edge=>({key:'before:'+edge.id,edgeId:edge.id,role:'predecessor' as const,endpoint:edge.from})),...direct.successors.map(edge=>({key:'after:'+edge.id,edgeId:edge.id,role:'successor' as const,endpoint:edge.to}))]:[];
 const nodes=new Map<string,Set<RelationRole>>(),edges=new Map<string,Set<RelationRole>>();
 for(const relation of relations){if(!edges.has(relation.edgeId))edges.set(relation.edgeId,new Set());edges.get(relation.edgeId)!.add(relation.role);if(relation.endpoint.kind==='node'){if(!nodes.has(relation.endpoint.id))nodes.set(relation.endpoint.id,new Set());nodes.get(relation.endpoint.id)!.add(relation.role);}}
 return {relations,nodes,edges,predecessors:direct?.predecessors.length??0,successors:direct?.successors.length??0};
}
export function graphRelationLocation(layout:GraphLayout,relation:GraphRelation,viewport:GraphRect,filter?:ReadonlySet<string>){
 const endpoint=relation.endpoint;if(endpoint.kind==='unresolved')return {kind:'unresolved',label:`원문 참조 미해결 (${endpoint.reason})`,arrow:'',navigable:false};
 const node=layout.positionById.get(endpoint.id);
 if(!node)return {kind:'other-group',label:'다른 그룹',arrow:'↗',navigable:true};
 if(filter&&!filter.has(endpoint.id))return {kind:'filtered',label:'현재 필터 밖',arrow:'↗',navigable:true};
 const horizontal=node.x+node.width<=viewport.x?'←':node.x>=viewport.x+viewport.width?'→':'';
 const vertical=node.y+node.height<=viewport.y?'↑':node.y>=viewport.y+viewport.height?'↓':'';
 return horizontal||vertical?{kind:'viewport-outside',label:`화면 밖 · 깊이 ${node.depth}`,arrow:vertical+horizontal,navigable:true}:{kind:'visible',label:'현재 화면',arrow:'',navigable:true};
}
