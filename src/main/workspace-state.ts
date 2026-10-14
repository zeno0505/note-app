import {parseWorkspaceState,type TaskWorkspaceState} from '../shared/workspace-state';
export interface WorkspaceStatePayload {entries:{id:string;state:TaskWorkspaceState}[]}
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\u0000-\u001f\u007f]/u.test(v);
export const workspaceStateCodec={parse(value:unknown):WorkspaceStatePayload{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='entries')throw Error('Invalid workspace cache');const entries=(value as WorkspaceStatePayload).entries;
 if(!Array.isArray(entries)||entries.length>100)throw Error('Invalid workspace cache');const ids=new Set<string>();
 return {entries:entries.map(entry=>{if(!entry||Object.keys(entry).sort().join(',')!=='id,state'||!validId(entry.id)||ids.has(entry.id))throw Error('Invalid workspace cache');ids.add(entry.id);return {id:entry.id,state:parseWorkspaceState(entry.state)};})};
}};
interface Persistence {read():Promise<{revision:number;payload:WorkspaceStatePayload}|null>;write(payload:WorkspaceStatePayload,revision:number|null):Promise<{revision:number;payload:WorkspaceStatePayload}>}
function bounded<T>(operation:Promise<T>):Promise<T>{return new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{settled=true;reject(Error('화면 상태 저장소 응답 시간 초과'));},5000);void operation.then(value=>{if(!settled){settled=true;clearTimeout(timer);resolve(value);}},error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});});}
/** App-owned UI state only. Serialized/coalesced writes never touch source repositories. */
export function createWorkspaceStateStore(persistence?:Persistence){
 const entries=new Map<string,TaskWorkspaceState>();let revision:number|null=null,loaded=false,loadFlight:Promise<void>|null=null,saveFlight:Promise<void>|null=null,dirty=false,failed=false;
 async function load(){if(loaded)return;if(!loadFlight)loadFlight=(async()=>{try{const saved=persistence?await bounded(persistence.read()):null;if(saved){const checked=workspaceStateCodec.parse(saved.payload);for(const entry of checked.entries)entries.set(entry.id,entry.state);revision=saved.revision;}loaded=true;}catch{failed=true;throw Error('화면 상태 저장소를 확인할 수 없습니다.');}})();await loadFlight;}
 const parseId=(v:unknown)=>{if(!validId(v))throw Error('Invalid workspace identity');return v;};
 return {
  async get(id:unknown){await load();const state=entries.get(parseId(id));return state?{...state}:null;},
  async set(id:unknown,value:unknown){const key=parseId(id),state=parseWorkspaceState(value);await load();if(!persistence||failed)throw Error('화면 상태 저장을 사용할 수 없습니다.');if(entries.size>=100&&!entries.has(key))entries.delete(entries.keys().next().value!);entries.set(key,state);dirty=true;
   if(!saveFlight)saveFlight=(async()=>{while(dirty){dirty=false;const payload={entries:[...entries].map(([id,state])=>({id,state:{...state}}))};const saved=await bounded(persistence.write(payload,revision));revision=saved.revision;}})().catch(()=>{failed=true;throw Error('화면 상태 저장에 실패했습니다.');}).finally(()=>{saveFlight=null;});await saveFlight;
  },
 };
}
