<script setup lang="ts">
import {computed,nextTick,onMounted,onUnmounted,ref,useId,watch} from 'vue';
import {createTaskVerificationReader,type TaskVerificationSources,type VerificationSourceRecord} from '../../phase2/verification-records';
import {documentScopeState} from '../phase2-state';

const props=withDefaults(defineProps<{workstreamId:string;taskId:string;sourceHash:string|null;current:boolean;active?:boolean}>(),{active:true});
const emit=defineEmits<{source:[relativePath:string]}>();
const id='verification-'+useId(),trigger=ref<HTMLButtonElement|null>(null),panel=ref<HTMLElement|null>(null);
const open=ref(false),loading=ref(false),result=ref<TaskVerificationSources|null>(null);
const scope=computed(()=>documentScopeState(props.workstreamId));
const available=computed(()=>props.current&&props.active&&!!props.sourceHash&&!scope.value.mutating);
const reader=createTaskVerificationReader({
 prepareTaskEvidence:request=>window.noteApp.prepareTaskEvidence(request),
 readTaskEvidence:request=>window.noteApp.readTaskEvidence(request),
 releaseTaskEvidence:request=>window.noteApp.releaseTaskEvidence(request),
});
let generation=0,disposed=false,interval:ReturnType<typeof setInterval>|undefined;
function invalidate(){generation++;loading.value=false;result.value=null;void reader.dispose();}
async function refresh(){
 const own=++generation;result.value=null;loading.value=false;
 if(!open.value||!available.value){void reader.dispose();return;}
 loading.value=true;
 try{
  const loaded=await reader.load({workstreamId:props.workstreamId,taskId:props.taskId,sourceHash:props.sourceHash!});
  if(!disposed&&own===generation&&open.value&&available.value)result.value=loaded;
 }catch{if(!disposed&&own===generation)result.value={taskId:props.taskId,state:'unknown',records:[],issues:['read-unavailable']};}
 finally{if(!disposed&&own===generation){loading.value=false;await nextTick();position();}}
}
function position(){
 if(!open.value||!panel.value||!trigger.value)return;
 const margin=12,rect=trigger.value.getBoundingClientRect(),height=panel.value.getBoundingClientRect().height;
 const width=Math.min(600,window.innerWidth-margin*2);
 panel.value.style.left=Math.max(margin,Math.min(rect.left,window.innerWidth-width-margin))+'px';
 const below=rect.bottom+8,above=rect.top-height-8;
 panel.value.style.top=Math.max(margin,Math.min(below+height<=window.innerHeight-margin?below:above,window.innerHeight-height-margin))+'px';
}
function toggle(event:Event){
 open.value=(event as ToggleEvent).newState==='open';
 if(open.value){void nextTick(position);void refresh();}else invalidate();
}
function close(){panel.value?.hidePopover();}
function source(record:VerificationSourceRecord){if(!available.value||loading.value)return;close();emit('source',record.relativePath);}
function onFocus(){if(open.value&&!loading.value)void refresh();}
function onVisibility(){if(document.visibilityState==='hidden')invalidate();else onFocus();}
const issues=computed(()=>{
 const values=result.value?.issues??[];const messages=new Set<string>();
 for(const issue of values){
  if(issue==='discovery-incomplete'||issue==='source-path-unavailable')messages.add('일부 문서의 탐색·출처 정보가 불완전합니다');
  else if(issue.startsWith('read-')||issue==='discovery-unavailable')messages.add('문서 읽기 또는 읽기 허용을 확인하지 못했습니다');
  else if(issue==='superseded')messages.add('선택 기준이 변경되었습니다. 다시 확인해 주세요');
  else messages.add('태스크 연결 또는 검증 구간을 명확하게 해석하지 못한 문서가 있습니다');
 }
 return [...messages];
});
function observedAt(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString('ko-KR',{dateStyle:'short',timeStyle:'medium'});}
watch(()=>[props.workstreamId,props.taskId,props.sourceHash,props.current,props.active,scope.value.epoch,scope.value.mutating],()=>{invalidate();if(!props.active)close();else if(open.value&&available.value)void refresh();},{flush:'sync'});
onMounted(()=>{window.addEventListener('focus',onFocus);window.addEventListener('resize',position);document.addEventListener('visibilitychange',onVisibility);interval=setInterval(()=>{if(open.value&&!loading.value&&document.visibilityState==='visible')void refresh();},30000);});
onUnmounted(()=>{disposed=true;invalidate();if(interval)clearInterval(interval);window.removeEventListener('focus',onFocus);window.removeEventListener('resize',position);document.removeEventListener('visibilitychange',onVisibility);});
</script>
<template>
 <button ref="trigger" type="button" class="verification-trigger" :popovertarget="id" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="id" data-testid="verification-sources-open">검증·리뷰 출처</button>
 <section :id="id" ref="panel" popover="auto" class="verification-popover" role="dialog" :aria-labelledby="id+'-title'" :aria-describedby="id+'-scope'" data-testid="verification-sources-popover" @toggle="toggle">
  <header><div><span class="verification-task">{{taskId}}</span><h4 :id="id+'-title'">검증·리뷰 출처</h4></div><button type="button" class="verification-close" aria-label="검증·리뷰 출처 닫기" data-testid="verification-sources-close" @click="close">×</button></header>
  <p :id="id+'-scope'" class="verification-scope">이 태스크에 연결된 노트 문서의 기록입니다. 검증 통과는 판정하지 않으며, 리뷰어 신원·대상 커밋 SHA·독립성은 미확인입니다.</p>
  <p v-if="!available" class="verification-warning" role="status" data-testid="verification-sources-unavailable">현재 연결·최신 근거·읽기 범위를 확인하지 못해 기록을 숨겼습니다. 연결이 복구되면 다시 확인합니다.</p>
  <p v-else-if="loading" role="status" data-testid="verification-sources-loading">현재 문서에서 기록을 읽는 중입니다…</p>
  <template v-else-if="result">
   <p v-if="result.state==='none'" role="status" data-testid="verification-sources-none">확인한 태스크 문서 범위에 검증·리뷰 기록이 없습니다. 실제 검증의 수행 여부는 알 수 없습니다.</p>
   <div v-if="result.state==='unknown'" class="verification-warning" role="status" data-testid="verification-sources-unknown"><strong>기록 확인이 불완전합니다</strong><ul><li v-for="issue in issues" :key="issue">{{issue}}</li></ul><p>기록 없음이나 검증 통과로 판단하지 않습니다.</p></div>
   <p v-if="result.records.length" class="verification-count" role="status">검증 기록 {{result.records.filter(r=>r.kind==='verification').length}}개 · 리뷰 문서 {{result.records.filter(r=>r.kind==='review').length}}개<span v-if="result.state==='unknown'"> · 확인된 일부 출처</span></p>
   <ol v-if="result.records.length" class="verification-records">
    <li v-for="record in result.records" :key="record.kind+'\0'+record.relativePath" data-testid="verification-source-record">
     <div class="verification-record-heading"><strong>{{record.kind==='verification'?'검증 기록':'리뷰 문서'}}</strong><span>검증 미판정</span></div>
     <p class="verification-path">{{record.relativePath}}</p>
     <pre class="verification-excerpt" tabindex="0" :aria-label="record.relativePath+' 기록 원문'">{{record.text}}</pre>
     <div class="verification-record-actions"><button type="button" :aria-label="record.relativePath+' 원문 열기'" data-testid="verification-source-open" @click="source(record)">원문 열기 →</button><span>읽은 시각 {{observedAt(record.observedAt)}}</span></div>
     <details class="verification-metadata"><summary>출처 식별 정보</summary><dl><dt>원문 해시</dt><dd>{{record.sourceHash}}</dd><dt>연결된 제목 위치</dt><dd>{{record.anchors.filter(Boolean).map(a=>'#'+a).join(', ')||'문서 전체'}}</dd></dl></details>
    </li>
   </ol>
  </template>
  <footer><button type="button" data-testid="verification-sources-refresh" :disabled="!available||loading" @click="refresh">다시 확인</button><span>열 때마다 현재 문서를 다시 읽습니다</span></footer>
 </section>
</template>
<style scoped>
.verification-trigger{font:inherit;font-size:12px;padding:7px 11px;min-height:34px;cursor:pointer}.verification-popover{position:fixed;inset:auto;margin:0;box-sizing:border-box;width:min(600px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;border:1px solid var(--app-control-border);border-radius:12px;padding:18px;background:var(--app-surface);color:var(--app-text);box-shadow:0 12px 36px var(--app-shadow-color);font-size:13px;line-height:1.6;overflow-wrap:anywhere}.verification-popover header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.verification-popover h4{font-size:16px;margin:1px 0 0}.verification-task{font-size:12px;color:var(--app-text-muted)}.verification-popover button{font:inherit;font-size:12px;line-height:1.5;min-height:34px;padding:7px 11px;cursor:pointer;margin:0}.verification-popover button.verification-close{font-size:22px;padding:0;min-width:34px;flex-shrink:0}.verification-popover button:disabled{cursor:not-allowed;opacity:.6}.verification-popover p{margin:10px 0}.verification-scope{color:var(--app-text-muted)}.verification-warning{background:var(--app-warning-bg);color:var(--app-warning-text);border:1px solid var(--app-warning-border);padding:10px 12px;border-radius:7px;margin:12px 0}.verification-warning ul{margin:6px 0;padding-left:18px}.verification-warning p{margin:6px 0 0}.verification-count{font-weight:600}.verification-records{list-style:none;padding:0;margin:12px 0;display:grid;gap:14px}.verification-records>li{border:1px solid var(--app-border);border-radius:8px;padding:12px;min-width:0}.verification-record-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}.verification-record-heading>span{font-size:11px;color:var(--app-text-muted);background:var(--app-surface-muted);padding:2px 6px;border-radius:4px}.verification-path{font-size:12px;color:var(--app-text-muted)}.verification-excerpt{font:inherit;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--app-surface-muted);border-radius:5px;padding:10px;margin:10px 0;max-height:176px;overflow:auto}.verification-record-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}.verification-record-actions>span{font-size:11px;color:var(--app-text-muted)}.verification-metadata{font-size:11px;margin-top:8px;color:var(--app-text-muted)}.verification-metadata summary{cursor:pointer}.verification-metadata dl{margin:8px 0 0}.verification-metadata dd{margin:0 0 6px;overflow-wrap:anywhere}.verification-popover footer{display:flex;align-items:center;flex-wrap:wrap;gap:10px;border-top:1px solid var(--app-border);padding-top:12px;margin-top:14px}.verification-popover footer span{font-size:11px;color:var(--app-text-muted)}@media(max-width:480px){.verification-popover{padding:14px}.verification-records>li{padding:10px}}
</style>
