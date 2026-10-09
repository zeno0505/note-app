<script setup lang="ts">
import {computed} from 'vue';
import {useRoute} from 'vue-router';
import {mode,workstreams,liveState} from '../store';
import WorkstreamCard from '../components/WorkstreamCard.vue';
import LiveWorkstreamCard from '../components/LiveWorkstreamCard.vue';
import FreshnessNotice from '../components/FreshnessNotice.vue';
import LiveStatus from '../components/LiveStatus.vue';
const route=useRoute();
const workstream=computed(()=>workstreams.value.find(w=>w.id===route.params.id));
const liveWorkstream=computed(()=>liveState.value?.workstreams.find(w=>w.id===route.params.id));
const dag=computed(()=>liveState.value?.dags.find(d=>d.dagId===liveWorkstream.value?.noteMapping.dagId));
</script>
<template>
  <RouterLink :to="mode==='live'?{path:'/',query:{project:String(route.params.id)}}:'/'" class="back-link">← 프로젝트 현황으로</RouterLink><div class="page-heading"><div><p class="eyebrow">WORKSTREAM DETAIL</p><h1>작업의 맥락</h1><p class="page-subtitle">{{mode==='demo'?'가상 데이터의 출처와 상태를 함께 확인하세요':'실제 관측, DAG 선언, 이전 저장 요약의 근거를 구분해서 확인하세요'}}</p></div></div>
  <template v-if="mode==='demo'"><FreshnessNotice/><WorkstreamCard v-if="workstream" :workstream="workstream"/></template>
  <template v-else><LiveStatus/><LiveWorkstreamCard v-if="liveWorkstream" :key="liveWorkstream.id" :workstream="liveWorkstream" :dag="dag" detail/></template>
  <section v-if="mode==='demo'?!workstream:!liveWorkstream" class="empty-state"><h2>이 작업을 찾을 수 없어요</h2><p>{{mode==='demo'?'샘플 모드를 종료했거나 현재 데이터에 없는 작업입니다':'아직 소스에 연결하지 않았거나 현재 관측에 없는 작업입니다'}}</p><RouterLink to="/">현황으로 돌아가기</RouterLink></section>
</template>
