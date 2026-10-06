<script setup lang="ts">
import {ref,computed,onMounted,onUnmounted} from 'vue';
import Button from 'primevue/button';
import type {PublicModelView} from '../../main/public-model';
import type {LatestModelReadingView} from '../../summary/reading/model-reading-storage';
const props=defineProps<{initialView?:LatestModelReadingView;selectedContext?:boolean}>();
const view=ref<LatestModelReadingView>(props.initialView??{state:'empty',message:'저장된 결과 확인 중입니다.'});
const review=computed(()=>'latest' in view.value?view.value.latest:null);
const model=ref<PublicModelView|null>(null),running=ref(false);let generation=0,disposed=false;
async function run(){if(running.value||!model.value||model.value.state==='disabled')return;const own=++generation;running.value=true;try{const next=await window.noteApp.summarizePublicModel();if(!disposed&&generation===own){model.value=next;view.value=next.latest;}}catch{if(!disposed&&generation===own)view.value={state:'unavailable',message:'실행 상태를 확인하지 못했습니다. 기존 저장 결과와 호출 방지 기록을 보존합니다.'};}finally{if(generation===own)running.value=false;}}
async function cancel(){generation++;running.value=false;try{const next=await window.noteApp.cancelPublicModel();if(!disposed){model.value=next;view.value=next.latest;}}catch{}}
const titles:Record<string,string>={implemented:'현재 어디까지 구현되었나요?',next:'다음에는 무엇을 구현하나요?',evidence:'완료 판단에 어떤 근거가 있나요?',decisions:'논의하거나 결정할 일이 있나요?'};
onMounted(async()=>{const own=generation;try{const next=await window.noteApp.getPublicModelState();if(!disposed&&generation===own){model.value=next;view.value=next.latest;}}catch{try{view.value=await window.noteApp.getPublicModelReview();}catch{view.value={state:'unavailable',message:'저장 결과를 읽지 못했습니다. 모델을 호출하지 않습니다.'};}}});
onUnmounted(()=>{disposed=true;generation++;if(running.value)void window.noteApp.cancelPublicModel().catch(()=>{});});
</script>
<template>
  <details class="public-model-review" data-testid="public-model-review" :open="selectedContext"><summary>{{selectedContext?'공개 note-app · AI 요약':'공개 note-app 모델 요약 검증 결과'}}</summary>
    <p class="muted">승인된 공개 소스의 저장 결과입니다. 현재 프로젝트 전체의 요약과 별개이며 이 화면을 열어도 모델을 호출하지 않습니다.</p>
    <template v-if="model"><p class="muted">선별 공개 입력 {{model.sourceSha.slice(0,7)}} · 기존 Claude 구독 · 수동 실행 · 동시 1개 · 생성 1회/검증 실패 수정 최대 1회</p><p class="muted" data-testid="public-model-action-state">{{running?'요약 생성 중입니다.':model.message}}</p><Button label="지금 요약 · 공개 note-app AI" outlined size="small" data-testid="public-model-run" :disabled="running||model.state==='disabled'" @click="run"/><Button v-if="running" label="요약 취소" outlined size="small" data-testid="public-model-cancel" @click="cancel"/></template>
    <p :class="view.state==='stale'||view.state==='unavailable'?'notice warning':'muted'" data-testid="public-model-storage-state">{{view.message}}</p>
    <template v-if="review">
      <p class="notice warning" data-testid="public-model-input-scope">공개 입력 {{review.sourceSha.slice(0,7)}} · 생성 {{review.generatedAt}} · 지정된 입력 시점의 저장 결과입니다. 이후 브랜치·노트 갱신은 자동으로 포함하지 않습니다. 입력 SHA와 실행 앱 SHA를 구분해 주세요.</p>
      <p class="muted">{{review.provider}} · 생성 요청 1회 · 검증 수정 {{review.attempts-1}}회 · {{(review.runtimeMs/1000).toFixed(1)}}초</p>
      <section v-for="section in review.answer.sections" :key="section.id"><h3>{{titles[section.id]}}</h3><p>{{section.text}}</p><small class="muted">공개 근거 {{section.sourceIds.join(' · ')}}</small></section>
      <p class="notice warning">형식·필수 근거 검사 통과 · {{review.validation.semantic==='reviewed-with-scope-note'?'문맥 검수 주석 있음':'문맥 검수 필요'}}. {{review.validation.note}}</p>
      <details><summary>입력과 사용량·저장 근거</summary><dl><dt>공개 입력 SHA</dt><dd>{{review.sourceSha}}</dd><dt>입력 해시</dt><dd>{{review.inputHash}}</dd><dt>생성 시각</dt><dd>{{review.generatedAt}}</dd><dt>실측 token</dt><dd>일반 입력 {{review.usage.inputTokens??'미관측'}} · 캐시 생성 입력 {{review.usage.cacheCreationInputTokens??'미관측'}} · 출력 {{review.usage.outputTokens??'미관측'}}</dd><dt>응답 기록</dt><dd>{{review.usage.reportedTurns??'미관측'}} turns · 앱 요청 {{review.attempts}}회 (생성 1회/검증 수정 {{review.attempts-1}}회). 사용량은 반환 관측이며 구독 청구액을 보장하지 않습니다.</dd><dt>보관 방식</dt><dd>앱 저장소 model-reading · 프로젝트별 최신 성공 본문 1개 · 최소 호출 방지 기록 별도. 노트·DAG에 쓰지 않습니다.</dd></dl><ul><li v-for="source in review.sources" :key="source.id">{{source.id}} · {{source.path}} · {{source.lineStart}}–{{source.lineEnd}}행</li></ul></details>
    </template>
  </details>
</template>
