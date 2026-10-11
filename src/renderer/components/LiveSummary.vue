<script setup lang="ts">
import type {LiveSummaryView} from '../../shared/live';
import {diagnosticText,summaryLabels} from '../live-labels';
import {formatTime} from '../store';
import LiveClaimList from './LiveClaimList.vue';
defineProps<{summary:LiveSummaryView;historical?:boolean}>();
</script>
<template>
  <section class="live-summary" data-testid="live-summary">
    <div class="section-heading"><h3>저장된 요약</h3><span class="state-badge">모델 요약 생성 비활성</span></div>
    <p v-if="historical" class="warning-text muted">현재 근거 재확인 안 됨 · 최신성 표시는 마지막 관측 기준입니다</p>
    <p class="summary-state" :class="{'warning-text':summary.state==='error'}">{{summaryLabels[summary.state]}}</p>
    <p class="muted">{{diagnosticText(summary.reason)}}</p>
    <p v-if="summary.revision!==null" class="muted">로컬 캐시 리비전 {{summary.revision}}</p>
    <template v-if="summary.state==='restored'||summary.candidateClaims.length||summary.approvedClaims.length">
      <p class="historical-note">이전 저장 기록입니다. 현재 모델 호출이나 새 승인 없이 읽어 왔습니다. 승인 기록은 실행 권한이나 테스트·배포 검증을 뜻하지 않습니다.</p>
      <section class="claim-section"><h4>이전 후보 요약 <span>미승인</span></h4><LiveClaimList :claims="summary.candidateClaims" :historical="historical" empty-text="저장된 후보가 없습니다"/></section>
      <section class="claim-section"><h4>이전 승인 요약 <span>과거 승인 기록</span></h4><p v-if="summary.approvedAt" class="muted">저장된 승인 시각 {{formatTime(summary.approvedAt)}}</p><LiveClaimList :claims="summary.approvedClaims" :historical="historical" empty-text="저장된 승인 요약이 없습니다"/></section>
    </template>
    <details v-if="summary.context" class="context-details"><summary>선택된 읽기 컨텍스트 · 기술 정보</summary><p>선택 작업 {{summary.context.selectedTaskCount}}개 · 기록 {{summary.context.recordCount}}개 · {{summary.context.bytes.toLocaleString('ko-KR')}} bytes</p><p>{{summary.context.truncated?'상한에 따라 일부 내용이 제외되었습니다':'제공된 선택 범위 안에서 구성되었습니다'}}</p><ul v-if="summary.context.unknowns.length"><li v-for="(unknown,index) in summary.context.unknowns" :key="index">{{unknown}}</li></ul><p>모델에 전송하지 않습니다.</p></details>
  </section>
</template>
