export type WorkspaceTab = 'summary' | 'usage' | 'tasks' | 'documents';
/** Only bounded presentation state. Paths are display/restore keys, never read capabilities. */
export interface TaskWorkspaceState {
 version: 2;
 tab: WorkspaceTab; status: string; search: string; type: string; phase: string; prefix: string; feature: string;
 view: 'list' | 'dag'; selected: string; scroll: number; detailScroll: number;
 page: number; pageSize: number; graphZoom: number; graphX: number; graphY: number;
 documentFolder: string; documentPath: string; documentQuery: string; documentScroll: number; documentListScroll: number;
 documentAnchor: string; documentMode: 'formatted' | 'raw';
}
export const defaultWorkspaceState = (): TaskWorkspaceState => ({
 version: 2, tab: 'summary', status: 'all', search: '', type: 'all', phase: 'all', prefix: 'all', feature: 'all', view: 'list', selected: '', scroll: 0, detailScroll: 0,
 page: 1, pageSize: 50, graphZoom: 1, graphX: 0, graphY: 0,
 documentFolder: '', documentPath: '', documentQuery: '', documentScroll: 0, documentListScroll: 0, documentAnchor: '', documentMode: 'formatted',
});
const legacyKeys = ['tab','status','search','type','phase','prefix','feature','view','selected','scroll','detailScroll'].sort().join(',');
function fail(): never { throw Error('Invalid workspace state'); }
export function parseWorkspaceState(value: unknown): TaskWorkspaceState {
 if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail();
 const keys = Reflect.ownKeys(value);
 if (keys.some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value,key)!))) fail();
 const actual = (keys as string[]).sort().join(',');
 const legacy = actual === legacyKeys;
 if (!legacy && actual !== Object.keys(defaultWorkspaceState()).sort().join(',')) fail();
 const v = {...defaultWorkspaceState(), ...value} as TaskWorkspaceState;
 if (v.version !== 2 || !['summary','usage','tasks','documents'].includes(v.tab) || (legacy && v.tab === 'documents') || !['list','dag'].includes(v.view) || !['all','before','in-progress','review','discussion','verification','done'].includes(v.status)) fail();
 for (const key of ['search','type','phase','prefix','feature','selected','documentQuery','documentAnchor'] as const) {
  if (typeof v[key] !== 'string' || v[key].length > (key === 'selected' ? 4096 : 512) || /[\u0000-\u001f\u007f]/u.test(v[key])) fail();
 }
 for (const key of ['documentFolder','documentPath'] as const) {
  const path = v[key];
  if (typeof path !== 'string' || path.length > 4096 || /[\u0000-\u001f\u007f\\:#?%]/u.test(path) || (path && (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')))) fail();
 }
 for (const key of ['scroll','detailScroll','graphX','graphY','documentScroll','documentListScroll'] as const) if (!Number.isFinite(v[key]) || v[key] < 0 || v[key] > 1e7) fail();
 if (!Number.isInteger(v.page) || v.page < 1 || v.page > 1e6 || ![25,50,100].includes(v.pageSize) || !Number.isFinite(v.graphZoom) || v.graphZoom < .01 || v.graphZoom > 2 || !['formatted','raw'].includes(v.documentMode)) fail();
 return {...v};
}
