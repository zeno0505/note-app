import type {AppMemoryView} from '../shared/app-memory';
const nonnegative=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
/** Electron44 memory-info uses KB. Do not claim summed RSS equals physical memory. */
export function projectAppMemory(input:unknown,platform:string,observedAt:number):AppMemoryView {
 const base={scope:'note-app-only' as const,source:'electron-app-metrics' as const,platform,observedAt:nonnegative(observedAt)&&observedAt<=8640000000000000?new Date(observedAt).toISOString():null,systemPressure:null,swap:null};
 if(!Array.isArray(input)||input.length>128)return {...base,state:'unavailable',rows:[],omitted:0,reason:'앱 프로세스 메모리 관측을 확인하지 못했습니다.'};
 const rows:AppMemoryView['rows']=[],seen=new Set<number>();let omitted=0;
 for(const item of input){if(!item||typeof item!=='object'||!Number.isSafeInteger(item.pid)||item.pid<=0||seen.has(item.pid)||rows.length>=64){omitted++;continue;}seen.add(item.pid);const memory=item.memory;rows.push({pid:item.pid,creationTime:nonnegative(item.creationTime)&&item.creationTime>0?item.creationTime:null,type:typeof item.type==='string'&&item.type.length<80?item.type:'unknown',workingSetKB:nonnegative(memory?.workingSetSize)?memory.workingSetSize:null,peakWorkingSetKB:nonnegative(memory?.peakWorkingSetSize)?memory.peakWorkingSetSize:null});}
 return {...base,state:'observed',rows,omitted,reason:'note-app 자신의 프로세스만 관측합니다. 개발 작업·프로젝트 메모리가 아니며 공유 메모리 때문에 행의 합을 실제 물리 메모리로 사용하지 않습니다. 시스템 압력·swap은 별도 미관측입니다.'};
}
