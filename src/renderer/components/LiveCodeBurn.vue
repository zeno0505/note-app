<script setup lang="ts">
import type {CodeBurnResult} from '../../summary/budget/codeburn';
import type {LiveWorkspaceView} from '../../shared/live';
import {formatTime} from '../store';
const props=defineProps<{codeburn:LiveWorkspaceView['codeburn'];stale?:boolean}>();
function isRetained(result:CodeBurnResult):boolean {
  if(!result.ok) return false;
  const query=result.value.kind==='quota'?'quota':result.value.provider+'-status';
  return props.stale===true||props.codeburn.results.some(other=>!other.ok&&other.error.query===query);
}
</script>
<template>
  <section class="codeburn-panel" data-testid="live-codeburn">
    <div class="section-heading"><div><p class="eyebrow">OPTIONAL OBSERVATION</p><h2>CodeBurn 사용량 · 쿼터</h2></div><span class="state-badge">에이전트 실행 가능 여부 미확인</span></div>
    <p v-if="codeburn.state==='unconfigured'" class="muted">선택 항목입니다. CodeBurn이 설정되지 않아 사용량·쿼터를 확인하지 않았습니다.</p>
    <p v-else-if="codeburn.state==='idle'" class="muted">CodeBurn이 설정되었습니다. 연결 후 첫 사용량·쿼터 관측을 기다리고 있습니다.</p>
    <p v-else-if="!codeburn.results.length" class="muted">아직 사용량·쿼터 관측 결과가 없습니다.</p>
    <div v-else class="codeburn-grid">
      <article v-for="(result,index) in codeburn.results" :key="index" class="codeburn-result" :class="{failed:!result.ok}">
        <template v-if="!result.ok"><h3>{{result.error.query??'조회 종류 미확인'}} · 조회 실패</h3><p>{{result.error.kind}}</p><p class="muted">실패한 시도 {{formatTime(result.observedAt)}}</p><p class="muted">함께 표시된 이전 관측값이 현재 값임을 보장하지 않습니다</p></template>
        <template v-else>
          <h3>{{result.value.kind==='status'?result.value.provider+' 사용량':'쿼터 관측'}}</h3>
          <p class="muted">{{isRetained(result)?'이전 관측 · ':''}}{{formatTime(result.value.observedAt)}}</p>
          <template v-if="result.value.kind==='status'"><div v-for="period in result.value.periods" :key="period.label" class="usage-period"><strong>{{period.label==='today'?'오늘 (원본 라벨)':'이번 달 (원본 라벨)'}}</strong><p>비용 약 {{period.cost.toLocaleString('ko-KR')}} {{result.value.currency}} · {{period.calls.toLocaleString('ko-KR')}}회</p><p>절감 추정 {{period.savings.toLocaleString('ko-KR')}} {{result.value.currency}}</p></div><p class="muted">기간 경계·시간대 미확인 · 예산 상한과 비교하지 않습니다</p></template>
          <template v-else><div v-for="provider in result.value.providers" :key="provider.provider" class="quota-provider"><strong>{{provider.provider}}</strong><p>쿼터 데이터: {{provider.quotaData==='available'?'확인됨':provider.quotaData==='unavailable'?'사용 불가':'미확인'}} · 에이전트 실행 가능 여부: 미확인</p><p v-if="provider.error!=='none'" class="warning-text">{{provider.error==='reported-error'?'조회에서 오류 보고됨':'오류 유무 미확인'}}</p><ul v-if="provider.windows.length"><li v-for="(window,index) in provider.windows" :key="index">{{window.label}} · 사용 {{window.usedPct}}%<span v-if="window.resetsAt!==null"> · 초기화 원본값 {{window.resetsAt}} (시각 형식 미검증)</span><span v-else> · 초기화 시각 미확인</span></li></ul><p v-else class="muted">확인된 쿼터 구간 없음</p></div></template>
        </template>
      </article>
    </div>
    <p class="scope-note">사용량, 쿼터 데이터, 에이전트 실행 가능 여부는 각각 다른 정보입니다. 미확인 값을 0이나 사용 가능으로 바꾸지 않습니다.</p>
  </section>
</template>
