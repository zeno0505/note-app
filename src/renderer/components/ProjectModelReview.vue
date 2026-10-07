<script setup lang="ts">
import {ref,computed,onMounted,onUnmounted} from 'vue';
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
// 단순 관측시간 경과는 실행 중인 snapshot 요청을 취소하지 않습니다.
// 연결/권한/실제 근거 변경은 main이 검증하고 프로젝트 이동은 unmount가 취소합니다.
onMounted(load);onUnmounted(()=>{disposed=true;generation++;if(running.value)void window.noteApp.cancelProjectModel({workstreamId:props.workstreamId}).catch(()=>{});});
</script>
<template>
  <section class="public-model-review" data-testid="project-model-review">
    <h3>이 프로젝트의 Claude AI 요약</h3><p class="notice warning" data-testid="project-ai-warning">{{AI_TRANSFER_WARNING}}</p>
    <label><input v-model="confirmed" type="checkbox" data-testid="project-ai-confirm"> 전송 대상과 자료 범위·민감정보 주의사항을 확인했습니다</label>
    <p class="muted">관련 근거를 한도 안에서 선별합니다. 동시 1개 · 생성 1회/형식 검증 실패 수정 최대 1회 · 같은 입력 재호출 없음 · 프로젝트별 최신 성공 본문 1개 보존</p>
    <Button label="지금 요약 · Claude AI" data-testid="project-ai-run" :disabled="running||!current||!confirmed||model?.state==='disabled'" :loading="running" @click="run"/><Button v-if="running" label="요약 취소" outlined data-testid="project-ai-cancel" @click="cancel"/>
    <p v-if="!current" class="notice warning">{{running?'진행 중인 요약은 시작 시점에 확인한 근거를 사용합니다. 연결·권한·실제 근거가 바뀌면 결과를 저장하지 않습니다.':'새 요약은 현재 연결과 허용된 DAG를 다시 확인한 뒤 실행할 수 있습니다.'}}</p><p role="status">{{running?'현재 근거 검사·수동 요약 중입니다.':model?.message}}</p><p v-if="error" role="alert">{{error}}</p>
    <details v-if="model?.diagnostics" data-testid="project-model-diagnostics"><summary>요약 진단 기록 · {{model.diagnostics.records.length}}건</summary><p class="muted">원문·프롬프트·모델 출력·인증 정보는 저장하지 않습니다. 최대 {{model.diagnostics.retention.maxRecords}}건 · {{model.diagnostics.retention.days}}일, 기록 저장·조회 때 지난 기록을 정리합니다. 각 프로젝트의 최근 12건을 표시합니다.</p><p>macOS 확인 경로: ~/Library/Application Support/note-app/{{model.diagnostics.location}}</p><p v-if="!model.diagnostics.available" role="alert">진단 저장소를 확인하지 못했습니다. 새 모델 호출 전에 기록이 실패하면 실행을 중단합니다.</p><p v-if="!model.diagnostics.records.length">저장된 진단이 없습니다. 이 버전 이전의 실패 원인은 소급 기록하지 않습니다.</p><ul><li v-for="r in model.diagnostics.records" :key="r.correlationId+r.at+r.code"><time>{{r.at}}</time> · {{r.stage}} · <strong>{{r.code}}</strong> · 모델 {{r.modelCall}}<br>상관 ID {{r.correlationId}}<br>프로젝트 {{r.projectId}}<span v-if="r.attempt"> · 시도 {{r.attempt}}</span></li></ul><p class="muted">not-started=실행 전, launch-requested=실행 요청 기록(시작 확인 전), started=프로세스 시작 확인, unknown=확인 불가. 시작 확인은 응답 성공·과금 확정이 아닙니다. 마지막 기록 뒤 결과가 없으면 완료 여부를 알 수 없습니다.</p></details>
    <p :class="model?.latest.state==='stale'?'notice warning':'muted'">{{model?.latest.message}}</p>
    <template v-if="latest"><p v-if="latest.version==='connected-project-reading-v1'" class="notice warning">이전 입력 계약의 저장 결과입니다. 최근 작업 선별과 과거 승인 설명이 충분하지 않을 수 있어 현재 기준의 내용 검수가 필요합니다. 원문과 생성 시각은 보존했습니다.</p><p class="notice warning">{{latest.validation.note}}</p><p class="muted">{{latest.provider}} · 생성 {{latest.generatedAt}} · 생성 1회/검증 수정 {{latest.attempts-1}}회 · 문맥 검수 필요</p><section v-for="s in latest.answer.sections" :key="s.id"><h4>{{titles[s.id]}}</h4><p>{{s.text}}</p><small class="muted">근거 {{s.sourceIds.join(' · ')}}</small></section><details><summary>입력·보관 근거</summary><p>입력 해시 {{latest.inputHash}}</p><p>형식·필수 근거 검사는 문맥의 진실성이나 전체 개발 완료를 보장하지 않습니다. 실패·취소 시 이전 성공 결과를 보존합니다.</p><ul><li v-for="source in latest.sources" :key="source.id">{{source.id}} · {{source.path}}</li></ul></details></template>
  </section>
</template>
