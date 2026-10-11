<script setup lang="ts">
import InfoDialog from './InfoDialog.vue';
import type {CodeBurnResult,CodeBurnStatus,CodeBurnPeriod} from '../../summary/budget/codeburn';
import type {LiveWorkspaceView} from '../../shared/live';
import {formatTime} from '../store';
import {quotaGraph,costWidth} from '../codeburn-graphs';
const props=defineProps<{codeburn:LiveWorkspaceView['codeburn'];stale?:boolean}>();
function noRecords(status:CodeBurnStatus,period:CodeBurnPeriod){return period.hasUsage===false||status.hasUsage===false;}
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
        <p v-if="result.diagnostics?.stderrReported" class="notice warning">CLI 진단 출력 있음 · 원문은 표시하지 않습니다. 상세 원인은 미확인입니다.</p><template v-if="!result.ok"><h3>{{result.error.query??'조회 종류 미확인'}} · 조회 실패</h3><p>{{result.error.kind}}</p><p class="muted">실패한 시도 {{formatTime(result.observedAt)}}</p><p class="muted">함께 표시된 이전 관측값이 현재 값임을 보장하지 않습니다</p></template>
        <template v-else>
          <h3>{{result.value.kind==='status'?result.value.provider+' 사용량':'쿼터 관측'}}</h3>
          <p class="muted">{{isRetained(result)?'이전 관측 · ':''}}{{formatTime(result.value.observedAt)}}</p>
          <template v-if="result.value.kind==='status'"><div v-for="period in result.value.periods" :key="period.label" class="usage-period"><strong>{{period.label==='today'?'오늘 (원본 라벨)':'이번 달 (원본 라벨)'}}</strong><p v-if="noRecords(result.value,period)" class="notice warning">집계된 기록 없음 · 이 기간의 실제 사용량이 0임을 뜻하지 않습니다</p><template v-else><p>비용 약 {{period.cost.toLocaleString('ko-KR')}} {{result.value.currency}} · {{period.calls.toLocaleString('ko-KR')}}회</p><div class="cost-track" role="img" :aria-label="'기간 비용 비교: '+period.cost+' '+result.value.currency"><div class="cost-fill" :style="{width:costWidth(period.cost,result.value.periods.map(p=>p.cost))+'%'}"></div></div><p>절감 추정 {{period.savings.toLocaleString('ko-KR')}} {{result.value.currency}}</p><p v-if="period.calls===0&&period.cost===0" class="muted">집계 보고값은 0이며 실제 사용량 0 여부는 미확인입니다</p></template></div><div class="compact-help"><span>기간 비용 비교 · 실제 청구액 아님</span><InfoDialog label="비용 비교와 계정 한도의 차이" hint="비용·한도 기준"><p class="muted">집계된 기록의 기간 비용 비교 · 계정 쿼터로 사용량·청구액을 추정하지 않음 · 오늘과 월 기간은 겹칠 수 있음 · 기간 경계·시간대 미확인 · 추정액이며 청구액·예산 상한이 아님</p></InfoDialog></div></template>
          <template v-else><div v-for="provider in result.value.providers" :key="provider.provider" class="quota-provider"><strong>{{provider.provider}}</strong><p>쿼터 데이터: {{provider.quotaData==='available'?'확인됨':provider.quotaData==='unavailable'?'사용 불가':'미확인'}} · 에이전트 실행 가능 여부: 미확인</p><p v-if="provider.error!=='none'" class="warning-text">{{provider.error==='reported-error'?'조회에서 오류 보고됨':'오류 유무 미확인'}}</p><div v-if="provider.windows.length"><div v-for="(window,index) in provider.windows" :key="index" class="quota-row" :class="{retained:isRetained(result)}"><div class="quota-values"><strong>{{window.label}}</strong><span>사용 {{window.usedPct}}% · 남은 비율 {{quotaGraph(window.usedPct).remaining}}%{{window.usedPct>=100?' · 해당 구간 소진':''}}</span></div><div class="quota-track" role="meter" :aria-label="provider.provider+' '+window.label+' 사용률'" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="quotaGraph(window.usedPct).width" :aria-valuetext="'관측 사용률 '+window.usedPct+'%, 계산한 남은 비율 '+quotaGraph(window.usedPct).remaining+'%'"><div class="quota-fill" :style="{width:quotaGraph(window.usedPct).width+'%'}"></div></div><p class="muted">{{isRetained(result)?'이전 관측 · ':''}}계정의 시간 구간 한도 · 프로젝트별 예산 아님</p><p class="muted" v-if="window.resetsAt!==null">초기화 원본값 {{window.resetsAt}} (시각 형식 미검증)</p><p class="muted" v-else>초기화 시각 미확인</p></div></div><p v-else class="muted">확인된 쿼터 구간 없음</p></div></template>
        </template>
      </article>
    </div>
    <p class="scope-note">남은 비율은 관측 사용률에서 계산한 값이며 토큰·금액 잔액이나 모델 실행 가능 여부를 보장하지 않습니다. 사용량, 쿼터 데이터, 에이전트 실행 가능 여부는 각각 다른 정보입니다. 미확인 값을 0이나 사용 가능으로 바꾸지 않습니다.</p>
  </section>
</template>
