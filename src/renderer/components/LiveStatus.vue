<script setup lang="ts">
import {liveState,formatTime} from '../store';
import {computed} from 'vue';
import InfoDialog from './InfoDialog.vue';
import {isCancelledObservation,diagnosticText,coverageLabels} from '../live-labels';
const cancelled=computed(()=>isCancelledObservation(liveState.value?.lastError));
</script>
<template>
  <section v-if="liveState" data-testid="live-status" class="live-status" aria-label="실제 소스 관측 상태" aria-live="polite">
    <div class="notice live"><strong>{{liveState.connection==='connected'?'실제 소스 · 읽기 전용 관측':'실제 소스 미연결'}}</strong><span>{{liveState.refreshing?'소스를 확인하고 있어요':liveState.observedAt?'마지막 관측 '+formatTime(liveState.observedAt):'아직 성공한 관측이 없습니다'}}</span></div>
    <div v-if="liveState.connection==='connected'" class="polling-line" data-testid="live-polling"><strong>{{liveState.polling.countdownSeconds>0?'복귀 후 '+liveState.polling.countdownSeconds+'초 뒤 새로고침':liveState.polling.activity==='background'?'백그라운드 · 5분 간격 조회':'포어그라운드 · 20초 간격 조회'}}</strong><span>{{liveState.refreshing?'조회 중 · 추가 요청은 합쳐집니다':liveState.polling.nextRefreshAt?'다음 조회 '+formatTime(liveState.polling.nextRefreshAt):'다음 조회는 진행 중인 요청이 끝나면 예약됩니다'}}</span><InfoDialog label="자동 소스 조회 정책"><p>활성 화면에서는20초, 배경에서는5분 간격으로 소스를 읽습니다. 앱으로 돌아오면 복귀 대기 후 갱신합니다. 진행 중인 요청은 합쳐지며, 실제 소스 새로고침 버튼으로 바로 요청할 수 있습니다. 모델은 호출하지 않습니다.</p></InfoDialog></div>
    <div v-if="liveState.lastError" :role="cancelled?'status':'alert'" class="notice" :class="cancelled?'warning':'error'"><strong>{{cancelled?(liveState.observedAt?'관측 중단 · 이전 관측 유지':'관측 중단 · 아직 미관측'):liveState.freshness==='stale'?'갱신 실패 · 이전 관측 유지':'실제 소스 조회 실패'}}</strong><span>{{diagnosticText(liveState.lastError)}}</span></div>
    <div v-else-if="liveState.freshness==='stale'" class="notice warning"><strong>이전 관측</strong><span>현재 상태가 확인되지 않았습니다. 새로고침으로 바로 확인할 수 있습니다.</span></div>
    <div v-if="liveState.coverage" class="coverage-strip">
      <span>프로젝트 {{coverageLabels[liveState.coverage.projects]}}</span><span>워크트리 {{coverageLabels[liveState.coverage.worktrees]}}</span><span>프로세스 {{coverageLabels[liveState.coverage.processes]}}</span><span>전체 워크트리 {{liveState.coverage.totalWorktrees===null?'미확인':liveState.coverage.totalWorktrees+'개'}}</span>
    </div>
  </section>
</template>
