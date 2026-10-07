export type WorkspaceTab='summary'|'usage'|'tasks';
export interface TaskWorkspaceState {tab:WorkspaceTab;status:string;search:string;type:string;phase:string;prefix:string;feature:string;view:'list'|'dag';selected:string;scroll:number;detailScroll:number}
export const defaultWorkspaceState=():TaskWorkspaceState=>({tab:'summary',status:'all',search:'',type:'all',phase:'all',prefix:'all',feature:'all',view:'list',selected:'',scroll:0,detailScroll:0});
export function parseWorkspaceState(value:unknown):TaskWorkspaceState {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==Object.keys(defaultWorkspaceState()).sort().join(','))throw Error('Invalid workspace state');
 const v=value as TaskWorkspaceState;
 if(!['summary','usage','tasks'].includes(v.tab)||!['list','dag'].includes(v.view)||!['all','before','in-progress','review','discussion','verification','done'].includes(v.status))throw Error('Invalid workspace state');
 for(const k of ['search','type','phase','prefix','feature','selected'] as const)if(typeof v[k]!=='string'||v[k].length>(k==='selected'?4096:512)||/[\u0000-\u001f\u007f]/u.test(v[k]))throw Error('Invalid workspace state');
 for(const k of ['scroll','detailScroll'] as const)if(!Number.isFinite(v[k])||v[k]<0||v[k]>1e7)throw Error('Invalid workspace state');
 return {...v};
}
