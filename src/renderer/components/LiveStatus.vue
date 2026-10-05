<script setup lang="ts">
import {liveState,formatTime} from '../store';
import {diagnosticText,coverageLabels} from '../live-labels';
</script>
<template>
  <section v-if="liveState" data-testid="live-status" class="live-status" aria-label="실제 소스 관측 상태" aria-live="polite">
    <div class="notice live"><strong>{{liveState.connection==='connected'?'실제 소스 · 읽기 전용 관측':'실제 소스 미연결'}}</strong><span>{{liveState.refreshing?'소스를 확인하고 있어요':liveState.observedAt?'마지막 관측 '+formatTime(liveState.observedAt):'아직 성공한 관측이 없습니다'}}</span></div>
    <div v-if="liveState.lastError" role="alert" class="notice error"><strong>{{liveState.freshness==='stale'?'갱신 실패 · 이전 관측 유지':'실제 소스 조회 실패'}}</strong><span>{{diagnosticText(liveState.lastError)}}</span></div>
    <div v-else-if="liveState.freshness==='stale'" class="notice warning"><strong>이전 관측</strong><span>현재 상태가 확인되지 않았습니다. 연결 후 새로고침해 주세요.</span></div>
    <div v-if="liveState.coverage" class="coverage-strip">
      <span>프로젝트 {{coverageLabels[liveState.coverage.projects]}}</span><span>워크트리 {{coverageLabels[liveState.coverage.worktrees]}}</span><span>프로세스 {{coverageLabels[liveState.coverage.processes]}}</span><span>전체 워크트리 {{liveState.coverage.totalWorktrees===null?'미확인':liveState.coverage.totalWorktrees+'개'}}</span>
    </div>
  </section>
</template>
