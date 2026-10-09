<script setup lang="ts">
import { computed } from 'vue';
import type { Workstream } from '../../domain';
import { hasConnection,connectionStatus,formatTime } from '../store';
import ClaimList from './ClaimList.vue';
const props=defineProps<{workstream:Workstream}>();
const connectionLabel=computed(()=>({connected:'터미널 연결',disconnected:'터미널 미연결',unknown:'터미널 연결 미확인'}[connectionStatus(props.workstream)]));
const agentLabels:Record<string,string>={working:'작업 중으로 관측',done:'완료 상태로 관측',idle:'대기 상태로 관측',unknown:'미확인'};
</script>
<template><article class="workstream-card">
  <div class="card-top"><span class="eyebrow">WORKSTREAM</span><span class="connection-pill" :class="{connected:hasConnection(workstream)}"><span class="status-dot"></span>{{connectionLabel}}</span></div>
  <h2><RouterLink :to="'/workstream/'+encodeURIComponent(workstream.id)">{{workstream.title}} <span aria-hidden="true" class="arrow">↗</span></RouterLink></h2>
  <p class="goal"><span v-if="workstream.goal.freshness==='stale'" class="claim-tag stale-tag">이전 관측</span>{{workstream.goal.text}}</p>
  <div class="summary-grid">
    <section><h3><span class="section-dot green"></span>어디까지 했나요</h3><ClaimList :claims="workstream.summary.implemented" /></section>
    <section><h3><span class="section-dot blue"></span>현재 상황</h3><ClaimList :claims="workstream.summary.current" /></section>
    <section><h3><span class="section-dot gray"></span>남은 일</h3><ClaimList :claims="workstream.summary.remaining" /></section>
    <section><h3><span class="section-dot amber"></span>막힘 · 판단할 일</h3><ClaimList :claims="workstream.summary.blockers" empty-text="기록된 막힘이 없습니다. 다른 막힘의 부재를 보장하지는 않습니다." /></section>
  </div>
  <section class="next-step"><div class="next-label">다음 제안<span>실행 승인 아님</span></div><ClaimList :claims="workstream.summary.next" /></section>
  <details class="evidence"><summary>근거와 연결 상태 <span>{{workstream.sources.length}}개 출처</span></summary>
    <div class="evidence-body"><p v-if="workstream.noteMapping.status!=='mapped'" class="warning-text">노트 연결 미확인 · {{workstream.noteMapping.reason}}</p><p v-else>노트: {{workstream.noteMapping.notePath}}</p><p>DAG 선언: {{workstream.dagState}} · 테스트·배포 여부와 별개</p>
      <ul><li v-for="tree in workstream.worktrees" :key="tree.id">{{tree.title}} · 선택 {{tree.isSelected?'됨':'안 됨'}} · 터미널 {{tree.terminalConnected===null?'미확인':tree.terminalConnected?'연결':'미연결'}} · 에이전트 {{agentLabels[tree.agentState]}}</li></ul>
      <p v-for="source in workstream.sources" :key="source.id" class="source-line"><strong>{{source.id}}</strong><br>{{source.locator}}<br><span>{{formatTime(source.observedAt)}} · {{source.hash}}</span></p>
    </div>
  </details>
</article></template>
