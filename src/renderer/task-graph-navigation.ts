import type {GraphLayout, GraphRect} from '../shared/task-graph-layout';
import {graphLayoutKey,GRAPH_LAYOUT_VERSION} from '../shared/task-graph-layout';
import type {GraphGrouping, TaskGraphIdentity} from '../shared/task-graph-contract';

export interface GraphNavigationView {
  previous: GraphLayout; zoom: number; x: number; y: number;
  selectedId: string|null; detailOpen: boolean; status: string;
}
/** Session-local geometry only: no title, source edge or authority is retained.
 * A remembered selection is merely an ID to re-admit against the new snapshot. */
export function createGraphNavigationHistory(maxEntries=100) {
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>100)throw Error('invalid-history-limit');
  const views=new Map<string,GraphNavigationView>();
  const last=new Map<string,{grouping:GraphGrouping;groupKey:string|null}>();
  const scope=(identity:Pick<TaskGraphIdentity,'projectId'|'dagId'>)=>JSON.stringify([identity.projectId,identity.dagId]);
  return {
    save(layout:GraphLayout,view:Omit<GraphNavigationView,'previous'>) {
      const previous:GraphLayout={...layout,identity:{...layout.identity,sessionKey:'',sourceHash:'',revision:''},nodes:[],edges:[],columns:[],routeIndex:null,cycles:[],sourceCycles:[],groups:[],groupLinks:[],
        index:{nodeById:new Map(),edgeById:new Map(),incoming:new Map(),outgoing:new Map(),groupById:new Map()},
        positionById:new Map(layout.positionById)};
      const key=graphLayoutKey(layout.identity,layout.grouping,layout.groupKey);views.delete(key);views.set(key,{...view,previous});
      last.set(scope(layout.identity),{grouping:layout.grouping,groupKey:layout.groupKey});
      while(views.size>maxEntries){const key=views.keys().next().value!,removed=views.get(key)!;views.delete(key);const lastKey=last.get(scope(removed.previous.identity));if(lastKey&&graphLayoutKey(removed.previous.identity,lastKey.grouping,lastKey.groupKey)===key)last.delete(scope(removed.previous.identity));}
    },
    get(identity:TaskGraphIdentity,grouping:GraphGrouping,key:string|null){return views.get(graphLayoutKey(identity,grouping,key));},
    latest(projectId:string,dagId:string){const value=last.get(scope({projectId,dagId}));return value?views.get(JSON.stringify([projectId,dagId,value.grouping,value.groupKey,GRAPH_LAYOUT_VERSION])):undefined;},
    last(identity:Pick<TaskGraphIdentity,'projectId'|'dagId'>){return last.get(scope(identity));},
    clear(){views.clear();last.clear();},
  };
}
export function admittedGraphSelection(view:GraphNavigationView|undefined,layout:GraphLayout,duplicates:readonly string[]) {
  const id=view?.selectedId;if(!view||graphLayoutKey(view.previous.identity,view.previous.grouping,view.previous.groupKey)!==graphLayoutKey(layout.identity,layout.grouping,layout.groupKey))return null;
  return layout.groupKey!==null&&id&&layout.positionById.has(id)&&layout.index.nodeById.has(id)&&!duplicates.includes(id)?id:null;
}
export function clampGraphZoom(value:number){return Number.isFinite(value)?Math.max(.00001,Math.min(2,value)):1;}
export function graphCenteredScroll(rect:GraphRect,zoom:number,width:number,height:number){return {left:Math.max(0,(rect.x+rect.width/2)*zoom-width/2),top:Math.max(0,(rect.y+rect.height/2)*zoom-height/2)};}
/** One compact horizontal segment per occupied column/row run. No 10k DOM nodes. */
export function graphMinimapPath(layout:GraphLayout){return layout.columns.map(column=>column.nodes.map(node=>`M${node.x} ${node.y+node.height/2}h${node.width}`).join(' ')).join(' ');}

/** Shared only for this renderer lifetime; nothing is written to disk. */
export const sessionGraphNavigationHistory=createGraphNavigationHistory();
