<script setup lang="ts">
import LiveCodeBurn from '../components/LiveCodeBurn.vue';
import {mode,liveState,bridgeError} from '../store';
</script>
<template>
  <section data-testid="usage-statistics-page">
    <div class="page-heading"><div><p class="eyebrow">USAGE STATISTICS</p><h1>사용량 통계</h1><p class="page-subtitle">관측된 사용량과 계정의 시간 구간 한도를 구분해서 확인하세요</p></div><RouterLink to="/settings" class="detail-link">연결 및 설정 →</RouterLink></div>
    <div v-if="bridgeError" role="alert" class="notice error">{{bridgeError}}</div>
    <div v-if="mode==='demo'" class="notice demo" data-testid="usage-demo"><strong>샘플 모드</strong><span>샘플 프로젝트의 가상 사용량을 표시하지 않습니다. 실제 사용량은 연결 및 설정에서 소스를 연결한 뒤 확인할 수 있습니다.</span></div>
    <template v-else-if="liveState">
      <div v-if="liveState.connection!=='connected'" class="notice warning" data-testid="usage-disconnected"><strong>연결 해제됨</strong><span>마지막 관측을 표시합니다. 연결하기 전까지 갱신되지 않습니다.</span></div>
      <div v-else-if="liveState.freshness!=='current'" class="notice warning" data-testid="usage-stale"><strong>현재 상태 미확인</strong><span>이전 관측이 포함될 수 있습니다. 각 사용량·쿼터의 관측 시각과 조회 상태를 확인하세요.</span></div>
      <LiveCodeBurn :codeburn="liveState.codeburn" :stale="liveState.freshness!=='current'||liveState.connection!=='connected'"/>
    </template>
    <section v-else class="empty-state"><h2>사용량 상태를 확인하고 있어요</h2><p>아직 확인되지 않은 상태는 사용량 0을 뜻하지 않습니다.</p></section>
  </section>
</template>
