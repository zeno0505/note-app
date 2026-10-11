<script setup lang="ts">
import {nextTick,onUnmounted,ref,watch} from 'vue';
import Button from 'primevue/button';
import DocumentViewer from './DocumentViewer.vue';
import {documentScopeState} from '../phase2-state';
import type {EvidenceList} from '../../shared/evidence';
const props=withDefaults(defineProps<{workstreamId:string;taskId:string;taskTitle?:string;sourceHash:string|null;current:boolean;active?:boolean;expanded?:boolean}>(),{taskTitle:'',active:true,expanded:false});
const emit=defineEmits<{'update:expanded':[value:boolean];browse:[]}>();
const list=ref<EvidenceList|null>(null),selection=ref<{session:EvidenceList;id:string}|null>(null),error=ref(''),relationNotice=ref(''),busy=ref(false),preparing=ref(false),confirmed=ref(false),container=ref<HTMLElement|null>(null);
const scope=documentScopeState(props.workstreamId);
let generation=0,disposed=false,originId='',originScroll:{outer:number;detail:number}|null=null;const sessions=new Set<string>();
function release(){for(const sessionId of sessions)void window.noteApp.releaseTaskEvidence({sessionId}).catch(()=>{});sessions.clear();}
async function prepare(){
 const own=++generation;busy.value=false;release();selection.value=null;list.value=null;error.value='';emit('update:expanded',false);
 if(!props.current||!props.sourceHash||scope.mutating){preparing.value=false;return;}
 preparing.value=true;
 try{const result=await window.noteApp.prepareTaskEvidence({workstreamId:props.workstreamId,taskId:props.taskId,sourceHash:props.sourceHash,...(scope.accepted?{discoverTaskRecords:true as const}:{})});
  if(!disposed&&own===generation){sessions.add(result.sessionId);list.value=result;}
  else void window.noteApp.releaseTaskEvidence({sessionId:result.sessionId}).catch(()=>{});
 }catch{if(!disposed&&own===generation)error.value='관련 문서 목록을 확인하지 못했습니다. 현재 프로젝트 연결과 읽기 범위를 확인해 주세요.';}
 finally{if(!disposed&&own===generation)preparing.value=false;}
}
function read(id:string){if(!list.value||busy.value||!props.current)return;originScroll={outer:window.scrollY??0,detail:container.value?.closest?.<HTMLElement>('.task-detail')?.scrollTop??0};originId=id;selection.value={session:list.value,id};}
async function dismiss(){const prior=list.value?.items.find(item=>item.evidenceId===originId);selection.value=null;busy.value=false;emit('update:expanded',false);await prepare();await nextTick();if(disposed)return;if(originScroll){const detail=container.value?.closest?.<HTMLElement>('.task-detail');if(detail)detail.scrollTop=originScroll.detail;window.scrollTo?.({top:originScroll.outer,behavior:'auto'});}const restored=list.value?.items.find(item=>item.registrationId===prior?.registrationId);let focused=false;container.value?.querySelectorAll<HTMLElement>('[data-evidence-id]').forEach(button=>{if(button.dataset.evidenceId===restored?.evidenceId){button.focus?.({preventScroll:true});focused=true;}});if(!focused)container.value?.focus?.({preventScroll:true});}
function acceptScope(){if(confirmed.value)scope.accepted=true;}
watch(()=>props.sourceHash,(hash,previous)=>{if(previous&&hash!==previous)relationNotice.value='DAG 선택 기준이 변경되어 관련 문서 연결을 다시 확인했습니다. 문서가 검증됐다는 뜻은 아닙니다. 읽을 문서를 다시 선택해 주세요.';});
watch(()=>[props.workstreamId,props.taskId,props.sourceHash,props.current,scope.accepted,scope.epoch,scope.mutating],prepare,{immediate:true});
onUnmounted(()=>{disposed=true;generation++;release();selection.value=null;});
</script>
<template>
 <section ref="container" tabindex="-1" aria-label="태스크 관련 문서" class="task-evidence" data-testid="task-related-documents">
  <div v-show="!expanded" class="related-document-intro"><div class="section-heading"><h4>관련 문서</h4><Button label="프로젝트 문서 보기 →" text @click="emit('browse')"/></div><p class="muted">연결 출처를 구분합니다. 파일 존재만으로 검수 통과를 판단하지 않습니다.</p>
   <p v-if="relationNotice" class="notice warning" role="status">{{relationNotice}}</p>
   <p v-if="preparing" role="status">관련 문서 목록을 확인 중입니다</p>
   <ul v-if="list?.items.length" class="related-document-list" data-testid="task-document-list"><li v-for="item in list.items" :key="item.evidenceId"><button :data-evidence-id="item.evidenceId" :aria-label="item.label" :aria-pressed="selection?.id===item.evidenceId" :disabled="!current||busy" @click="read(item.evidenceId)"><span class="related-document-name"><strong>{{item.label}}</strong><small>{{item.relativePath??item.label}}</small></span><span class="related-document-badges"><span v-for="(relation,index) in item.relationships??[]" :key="index" :title="relation.originalReference??relation.label">{{relation.label}}<small v-if="relation.field">{{relation.field}}</small></span><span v-if="!item.relationships?.length">등록된 직접 연결</span></span></button><details v-if="item.relationships?.length" class="related-document-source"><summary>연결 기준</summary><p v-for="(relation,index) in item.relationships" :key="index">{{relation.label}}<template v-if="relation.field"> · {{relation.field}}</template><template v-if="relation.originalReference"> · 원문 {{relation.originalReference}}</template><template v-if="relation.anchor"> · #{{relation.anchor}}</template><template v-if="relation.dagSourceHash"> · DAG 선택 기준 {{relation.dagSourceHash}}</template> · 검증 미판정</p></details></li></ul>
   <p v-if="list&&!list.items.length">이 태스크에 연결된 문서를 확인하지 못했습니다. 프로젝트 문서에서 직접 찾아볼 수 있습니다.</p>
   <p v-if="list?.unsupportedCount" class="muted">지원하지 않는 근거 참조 {{list.unsupportedCount}}개 · 원문을 추측하여 연결하지 않습니다</p><p v-for="(note,index) in list?.omissions??[]" :key="index" class="muted">{{note}}</p>
   <p v-if="error" role="alert">{{error}}<Button label="목록 다시 확인" text :disabled="!current||preparing" @click="prepare"/></p>
   <details v-if="!scope.accepted&&current" class="document-discovery-consent"><summary>태스크 기록·프로젝트 공통 문서도 찾기</summary><p>현재 프로젝트에 연결된 노트 폴더 안에서 파일 이름과 상대 경로를 탐색합니다. 선택한 문서만 읽으며 전체 볼트와 다른 프로젝트는 검색하지 않습니다.</p><label><input v-model="confirmed" type="checkbox"> 프로젝트 노트의 파일 목록 탐색 범위를 확인했습니다</label><Button label="이 범위에서 관련 문서 찾기" outlined :disabled="!confirmed" @click="acceptScope"/></details>
  </div>
  <DocumentViewer v-if="selection" :selection="selection" :current="current" :active="active" :expanded="expanded" :origin-task="{id:taskId,title:taskTitle}" @busy="busy=$event" @close="dismiss" @update:expanded="emit('update:expanded',$event)" @browse="emit('browse')"/>
 </section>
</template>
<style scoped>
.task-evidence{min-width:0;margin:18px 0;border-top:1px solid var(--app-border,#d5ddd5);padding-top:14px}.related-document-intro>.section-heading{margin-bottom:6px}.related-document-intro h4{margin:0;font-size:1rem}.related-document-intro>.muted{font-size:.8rem;line-height:1.6}.related-document-list{list-style:none;padding:0;border:1px solid var(--app-border,#d5ddd5);border-radius:8px;overflow:hidden}.related-document-list>li+li{border-top:1px solid var(--app-border,#d5ddd5)}.related-document-list>li>button{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;text-align:left;font:inherit;color:inherit;background:var(--app-surface,#fff);border:0;padding:12px;cursor:pointer}.related-document-list>li>button[aria-pressed=true]{background:var(--app-success-bg,#eef6f0);box-shadow:inset 3px 0 var(--app-primary,#47785d)}.related-document-list button:focus-visible{outline:2px solid var(--app-primary,#47785d);outline-offset:-3px}.related-document-name{min-width:0;overflow-wrap:anywhere}.related-document-name strong{display:block;font-size:.85rem}.related-document-name small{display:block;font-size:.72rem;color:var(--app-text-muted,#657586);margin-top:4px}.related-document-badges{display:flex;flex-direction:column;gap:4px;text-align:right;font-size:.65rem;flex-shrink:0;max-width:40%}.related-document-badges>span{padding:4px 6px;background:var(--app-surface-muted,#eef3f1);border-radius:4px}.related-document-badges small{display:block}.related-document-source{padding:0 12px 8px;font-size:.7rem;color:var(--app-text-muted,#657586)}.related-document-source summary,.document-discovery-consent summary{cursor:pointer}.document-discovery-consent{font-size:.8rem;margin-top:12px;line-height:1.6}.document-discovery-consent label{display:flex;align-items:flex-start;gap:8px;margin:8px 0}.document-discovery-consent .p-button{margin-top:6px}
</style>
