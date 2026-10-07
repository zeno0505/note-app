import {reactive} from 'vue';
export type WorkspaceTab='summary'|'usage'|'tasks';
export interface TaskWorkspaceState {tab:WorkspaceTab;status:string;search:string;type:string;phase:string;prefix:string;view:'list'|'dag';selected:string;scroll:number;detailScroll:number}
const defaults=():TaskWorkspaceState=>({tab:'summary',status:'all',search:'',type:'all',phase:'all',prefix:'all',view:'list',selected:'',scroll:0,detailScroll:0});
const states=new Map<string,TaskWorkspaceState>();
export function workspaceState(id:string):TaskWorkspaceState {
 const prior=states.get(id);if(prior)return prior;const value=defaults();
 try{const raw=localStorage.getItem('note-phase2:'+id);if(raw&&raw.length<8192){const saved=JSON.parse(raw);for(const key of ['status','search','type','phase','prefix','selected'] as const)if(typeof saved[key]==='string'&&saved[key].length<512)value[key]=saved[key];if(['summary','usage','tasks'].includes(saved.tab))value.tab=saved.tab;if(['list','dag'].includes(saved.view))value.view=saved.view;for(const key of ['scroll','detailScroll'] as const)if(Number.isFinite(saved[key])&&saved[key]>=0&&saved[key]<1e7)value[key]=saved[key];}}catch{}
 const result=reactive(value);if(states.size>=100)states.delete(states.keys().next().value!);states.set(id,result);return result;
}
export function saveWorkspaceState(id:string,state:TaskWorkspaceState){try{localStorage.setItem('note-phase2:'+id,JSON.stringify(state));}catch{/* State preservation is optional; no source writes or replay. */}}
