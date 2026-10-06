<script setup lang="ts">
import {ref,computed,onMounted,onUnmounted,watch} from 'vue';
import Button from 'primevue/button';
import type {ProjectModelView} from '../../main/project-model';
import {AI_TRANSFER_WARNING} from '../../shared/ai-transfer';
const props=defineProps<{workstreamId:string;current:boolean}>();
const model=ref<ProjectModelView|null>(null),running=ref(false),confirmed=ref(false),error=ref('');let generation=0,disposed=false;
const latest=computed(()=>model.value&&'latest' in model.value.latest?model.value.latest.latest:null);
const titles={implemented:'현재 어디까지 구현되었나요?',next:'다음에는 무엇을 구현하나요?',evidence:'완료 판단에 어떤 근거가 있나요?',decisions:'논의하거나 결정할 일이 있나요?'};
async function load(){const own=generation;try{const v=await window.noteApp.getProjectModelState({workstreamId:props.workstreamId});if(!disposed&&own===generation)model.value=v;}catch{error.value='저장 상태를 확인하지 못했습니다. 모델을 호출하지 않습니다.';}}
async function run(){if(running.value||!confirmed.value||!props.current)return;const own=++generation;running.value=true;error.value='';try{const v=await window.noteApp.summarizeProjectModel({workstreamId:props.workstreamId,transferConfirmed:true});if(!disposed&&own===generation)model.value=v;}catch{if(!disposed&&own===generation)error.value='전송·실행을 확인하지 못했습니다. 자동 재전송하지 않습니다.';}finally{if(own===generation)running.value=false;}}
async function cancel(){generation++;running.value=false;try{const v=await window.noteApp.cancelProjectModel({workstreamId:props.workstreamId});if(!disposed)model.value=v;}catch{}}
watch(()=>props.current,current=>{if(!current&&running.value)void cancel();});
onMounted(load);onUnmounted(()=>{disposed=true;generation++;if(running.value)void window.noteApp.cancelProjectModel({workstreamId:props.workstreamId}).catch(()=>{});});
</script>
<template>
  <section class="public-model-review" data-testid="project-model-review">
    <h3>이 프로젝트의 Claude AI 요약</h3><p class="notice warning" data-testid="project-ai-warning">{{AI_TRANSFER_WARNING}}</p>
    <label><input v-model="confirmed" type="checkbox" data-testid="project-ai-confirm"> 전송 대상과 자료 범위·민감정보 주의사항을 확인했습니다</label>
    <p class="muted">관련 근거를 한도 안에서 선별합니다. 동시 1개 · 생성 1회/형식 검증 실패 수정 최대 1회 · 같은 입력 재호출 없음 · 프로젝트별 최신 성공 본문 1개 보존</p>
    <Button label="지금 요약 · Claude AI" data-testid="project-ai-run" :disabled="running||!current||!confirmed||model?.state==='disabled'" :loading="running" @click="run"/><Button v-if="running" label="요약 취소" outlined data-testid="project-ai-cancel" @click="cancel"/>
    <p v-if="!current" class="notice warning">현재 연결과 허용된 DAG를 다시 확인한 프로젝트만 실행할 수 있습니다.</p><p role="status">{{running?'현재 근거 검사·수동 요약 중입니다.':model?.message}}</p><p v-if="error" role="alert">{{error}}</p>
    <p :class="model?.latest.state==='stale'?'notice warning':'muted'">{{model?.latest.message}}</p>
    <template v-if="latest"><p class="muted">{{latest.provider}} · 생성 {{latest.generatedAt}} · 생성 1회/검증 수정 {{latest.attempts-1}}회 · 문맥 검수 필요</p><section v-for="s in latest.answer.sections" :key="s.id"><h4>{{titles[s.id]}}</h4><p>{{s.text}}</p><small class="muted">근거 {{s.sourceIds.join(' · ')}}</small></section><details><summary>입력·보관 근거</summary><p>입력 해시 {{latest.inputHash}}</p><p>형식·필수 근거 검사는 문맥의 진실성이나 전체 개발 완료를 보장하지 않습니다. 실패·취소 시 이전 성공 결과를 보존합니다.</p><ul><li v-for="source in latest.sources" :key="source.id">{{source.id}} · {{source.path}}</li></ul></details></template>
  </section>
</template>
