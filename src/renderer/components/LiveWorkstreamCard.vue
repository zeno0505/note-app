<script setup lang="ts">
import {computed} from 'vue';
import type {LiveWorkstreamView,LiveDagView} from '../../shared/live';
import {diagnosticText,branchLabel,mappingLabel,projectLabel,summaryLabels} from '../live-labels';
import LiveDag from './LiveDag.vue';
import SummaryJourney from './SummaryJourney.vue';
import NoteLinkJourney from './NoteLinkJourney.vue';
import ReadingSummary from './ReadingSummary.vue';
import {liveState,refreshLive} from '../store';
const props=defineProps<{workstream:LiveWorkstreamView;dag?:LiveDagView;detail?:boolean}>();
const current=computed(()=>liveState.value?.connection==='connected'&&liveState.value?.freshness==='current');
const terminalLabel=computed(()=>props.workstream.terminalConnected===null?'터미널 연결 미확인':props.workstream.terminalConnected?'터미널 연결':'터미널 미연결');
</script>
<template>
  <article class="workstream-card live-workstream" data-testid="live-workstream">
    <div class="card-top"><span class="eyebrow">LIVE WORKSTREAM</span><span class="connection-pill" :class="{connected:workstream.terminalConnected===true}"><span class="status-dot"></span>{{terminalLabel}}</span></div>
    <h2><RouterLink :to="'/workstream/'+encodeURIComponent(workstream.id)">{{workstream.title}} <span aria-hidden="true" class="arrow">↗</span></RouterLink></h2>
    <p class="project-identity">{{projectLabel(workstream)}}<span class="branch-label">{{branchLabel(workstream.branch)}}</span></p>
    <dl class="workstream-facts"><div><dt>에이전트 관측</dt><dd>{{workstream.agentState==='done'?'완료 상태로 관측':'에이전트 상태 미확인'}}</dd></div><div><dt>터미널 수</dt><dd>{{workstream.terminalCount===null?'미확인':workstream.terminalCount+'개'}}</dd></div><div><dt>보관 상태</dt><dd>{{workstream.archived===null?'미확인':workstream.archived?'보관됨':'비보관'}}</dd></div><div><dt>프로젝트 연결</dt><dd>{{mappingLabel(workstream.projectMapping)}}</dd></div></dl>
    <div class="note-mapping" :class="{unresolved:workstream.noteMapping.state==='unresolved'}"><strong>{{workstream.noteMapping.state==='resolved'?'노트 · DAG 연결 확인':'노트 연결 미확인'}}</strong><p v-if="workstream.noteMapping.state==='unresolved'">{{mappingLabel(workstream.noteMapping.reason)}}</p><p v-else class="muted">{{workstream.noteMapping.registration==='explicit-read-only'?'명시된 읽기 등록으로 확인했습니다. docs/note 링크는 만들거나 바꾸지 않았습니다.':'명시된 로컬 노트 범위에서 연결되었습니다'}}</p></div>
    <ReadingSummary v-if="workstream.readingSummary" :summary="workstream.readingSummary" :historical="!current"/>
    <template v-if="detail"><SummaryJourney v-if="dag" :key="dag.dagId" :workstream-id="workstream.id" :dag="dag" :current="current"/><NoteLinkJourney :worktree-id="workstream.id" :current="current" @changed="refreshLive"/></template>
    <LiveDag v-if="dag&&detail" :dag="dag" :show-summary="false"/>
    <div v-else-if="dag" class="dag-preview"><div class="section-heading"><h3>DAG 선언</h3><span>{{dag.state==='ready'?(dag.taskCount===null?'작업 수 미확인':dag.taskCount+'개 작업'):dag.state==='error'?'조회 오류':'사용 불가'}}</span></div><div v-if="dag.state==='ready'" class="dag-counts"><span v-for="(item,index) in dag.statusCounts.slice(0,6)" :key="index" class="status-count">{{item.status??'상태 미선언'}} <strong>{{item.count}}</strong></span></div><p v-if="dag.statusCountsOmitted+Math.max(0,dag.statusCounts.length-6)>0" class="muted">추가 상태 범주 {{dag.statusCountsOmitted+Math.max(0,dag.statusCounts.length-6)}}개 생략</p><p v-if="dag.reason" class="muted">{{diagnosticText(dag.reason)}}</p><p class="muted">{{summaryLabels[dag.summary.state]}} · 모델 요약 생성 비활성</p><RouterLink class="detail-link" :to="'/workstream/'+encodeURIComponent(workstream.id)">요약 검토·노트 연결·작업 상세 보기 →</RouterLink></div>
    <div v-else class="dag-preview"><p class="muted">{{workstream.noteMapping.state==='resolved'?'DAG 조회 결과 미확인':'노트 연결 후 DAG를 확인할 수 있습니다'}} · 모델 요약 생성 비활성</p></div>
    <p class="scope-note">터미널 연결과 에이전트 상태는 별개입니다. 완료 선언만으로 테스트·배포 완료를 알 수 없습니다.</p>
    <details class="evidence"><summary>관측 식별자</summary><div class="evidence-body"><p>워크스트림: {{workstream.id}}</p><p>DAG: {{workstream.noteMapping.dagId??'미확인'}}</p></div></details>
  </article>
</template>
