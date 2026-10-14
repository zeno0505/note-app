<script setup lang="ts">
import {computed,ref,shallowRef,watch,onUnmounted} from 'vue';
import type {ProjectModelView} from '../../main/project-model';
import type {LatestModelReadingView} from '../../summary/reading/model-reading-storage';
import SummaryResult from './SummaryResult.vue';
const props=defineProps<{workstreamId:string;allowPublicPreview?:boolean}>();
const expanded=ref(false),loading=ref(false),error=ref(''),model=shallowRef<ProjectModelView|null>(null);
const publicExpanded=ref(false),publicLoading=ref(false),publicError=ref(''),publicLatest=shallowRef<LatestModelReadingView|null>(null);
let disposed=false,generation=0;
const publicModel=computed<ProjectModelView|null>(()=>publicLatest.value?{state:'idle',message:'이전 공개 입력의 저장 결과',latest:publicLatest.value,inputHash:null}:null);
const synthetic=computed(()=>!!publicLatest.value&&'latest' in publicLatest.value&&publicLatest.value.latest.sourceSha==='0'.repeat(40));
async function load(event:Event){expanded.value=(event.currentTarget as HTMLDetailsElement).open;if(!expanded.value||loading.value)return;const own=generation;loading.value=true;error.value='';try{const next=await window.noteApp.getProjectModelState({workstreamId:props.workstreamId});if(!disposed&&own===generation)model.value=next;}catch{if(!disposed&&own===generation)error.value='이전 저장 요약을 읽지 못했습니다. 다시 열어 확인해 주세요.';}finally{if(own===generation)loading.value=false;}}
async function loadPublic(event:Event){publicExpanded.value=(event.currentTarget as HTMLDetailsElement).open;if(!publicExpanded.value||!props.allowPublicPreview||publicLoading.value)return;const own=generation;publicLoading.value=true;publicError.value='';try{const next=await window.noteApp.getPublicModelReview();if(!disposed&&own===generation&&props.allowPublicPreview)publicLatest.value=next;}catch{if(!disposed&&own===generation)publicError.value='공개 저장 요약을 읽지 못했습니다.';}finally{if(own===generation)publicLoading.value=false;}}
watch(()=>props.workstreamId,()=>{generation++;model.value=null;publicLatest.value=null;expanded.value=false;publicExpanded.value=false;loading.value=false;publicLoading.value=false;});
onUnmounted(()=>{disposed=true;generation++;});
</script>
<template>
 <details :open="expanded" class="summary-history" data-testid="summary-history" @toggle="load"><summary>이전 범위의 저장 요약</summary><template v-if="expanded"><p class="summary-inline-warning">이전 입력 범위의 기록입니다. 현재 최근 작업 요약과 별도이며 새 모델을 호출하지 않습니다.</p><p v-if="loading" role="status">이전 저장 결과 확인 중</p><p v-if="error" role="alert">{{error}}</p><SummaryResult v-if="model" :model="model" show-heading title="이전 저장 요약" read-only/></template></details>
 <details v-if="allowPublicPreview" :open="publicExpanded" class="summary-history" data-testid="summary-public-history" @toggle="loadPublic"><summary>공개 note-app 저장 요약</summary><template v-if="publicExpanded"><p v-if="publicLoading" role="status">공개 저장 결과 확인 중</p><p v-if="publicError" role="alert">{{publicError}}</p><p v-if="synthetic" class="summary-state-message summary-warning" data-testid="summary-synthetic-history">합성 예제입니다. 본문·시각·사용량은 형식 검사용이며 실제 소스·모델 호출·계정 사용량의 근거가 아닙니다.</p><p v-else class="summary-inline-warning">승인된 공개 입력의 이전 저장 결과입니다. 현재 프로젝트의 최근 작업 요약과 별도입니다.</p><SummaryResult v-if="publicModel" :model="publicModel" :synthetic="synthetic" show-heading :title="synthetic?'공개 요약 합성 예제':'이전 공개 요약'" read-only/></template></details>
</template>
