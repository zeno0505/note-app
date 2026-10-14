import {computed,ref,shallowRef} from 'vue';
import type {SummaryReviewBridge,SummaryReviewView,SummarySelectionRequest,SummaryRunAuthority} from '../shared/summary-review';
import type {ProjectModelView} from '../main/project-model';

/** A selection owns its preflight, run and display. Read-only refreshes never start a model. */
export type {SummaryRunAuthority} from '../shared/summary-review';
export function createSummaryReviewState(bridge:SummaryReviewBridge,request:SummarySelectionRequest){
 const view=shallowRef<SummaryReviewView|null>(null),busy=ref(false),loading=ref(false),actionError=ref(''),readError=ref('');
 // A successful background read does not establish that a rejected action succeeded.
 const error=computed({get:()=>actionError.value||readError.value,set:(value:string)=>{actionError.value=value;}});
 function dismissError(){actionError.value='';readError.value='';}
 let generation=0,readSequence=0,disposed=false;
 const selection=structuredClone(request);
 const running=computed(()=>busy.value||view.value?.model.state==='running');
 async function refresh(){if(disposed)return;const own=generation,read=++readSequence;loading.value=true;try{const next=await bridge.getSummaryReview(selection);if(!disposed&&own===generation&&read===readSequence){view.value=next;readError.value='';}}catch{if(!disposed&&own===generation&&read===readSequence)readError.value='요약 상태를 확인하지 못했습니다. 다시 확인해 주세요.';}finally{if(read===readSequence)loading.value=false;}}
 async function run(authority:SummaryRunAuthority){if(disposed||busy.value)return;const own=++generation;++readSequence;loading.value=false;busy.value=true;dismissError();try{const next=await bridge.summarizeSelection({...selection,transferConfirmed:true,...authority});if(!disposed&&own===generation){++readSequence;loading.value=false;view.value=next;dismissError();}}catch{if(!disposed&&own===generation)error.value='요약을 완료하지 못했습니다. 전송 상태와 진단을 확인해 주세요.';}finally{if(own===generation)busy.value=false;}}
 async function cancel(){const own=++generation;++readSequence;loading.value=false;busy.value=false;try{const next=await bridge.cancelSummarySelection(selection);if(!disposed&&own===generation){++readSequence;loading.value=false;view.value=next;dismissError();}}catch{if(!disposed&&own===generation)error.value='취소 상태를 확인하지 못했습니다. 상태를 다시 확인해 주세요.';}}
 function acceptModel(model:ProjectModelView){if(!disposed&&view.value){view.value={...view.value,model};if(model.state==='idle')dismissError();}}
 function dispose(){if(disposed)return;const needsCancel=running.value;disposed=true;generation++;readSequence++;loading.value=false;busy.value=false;if(needsCancel)void bridge.cancelSummarySelection(selection).catch(()=>{});}
 return {request:selection,view,busy,loading,error,running,refresh,run,cancel,acceptModel,dismissError,dispose};
}
export type SummaryReviewState=ReturnType<typeof createSummaryReviewState>;
export function selectionKey(request:SummarySelectionRequest){return request.workstreamId+'\0'+request.selection.purpose+'\0'+[...(request.selection.taskIds??[])].sort().join('\0');}
export function summaryTaskStatus(status:string|null){
 const s=(status??'').toLowerCase();
 if(['done','completed','complete','완료'].includes(s))return {kind:'success',label:'완료 선언',shape:'check'};
 if(['in-progress','in_progress','doing','running','active','진행 중'].includes(s))return {kind:'info',label:'진행 중',shape:'progress'};
 if(['blocked','failed','error','차단'].includes(s))return {kind:'error',label:'차단·확인 필요',shape:'alert'};
 if(['review','in-review','in_review','검토'].includes(s))return {kind:'warning',label:'검토 중',shape:'clock'};
 if(['pending','todo','planned','대기'].includes(s))return {kind:'warning',label:'대기',shape:'clock'};
 return {kind:'muted',label:status?'선언 상태: '+status:'상태 미확인',shape:'unknown'};
}
