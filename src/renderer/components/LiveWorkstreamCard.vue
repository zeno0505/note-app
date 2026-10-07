<script setup lang="ts">
import {computed,ref} from 'vue';
import Button from 'primevue/button';
import NoteReconnect from './NoteReconnect.vue';
import {noteState} from '../note-state';
import type {LiveWorkstreamView,LiveDagView} from '../../shared/live';
import {diagnosticText,branchLabel,mappingLabel,projectLabel,summaryLabels} from '../live-labels';
import LiveDag from './LiveDag.vue';
import SummaryJourney from './SummaryJourney.vue';
import NoteLinkJourney from './NoteLinkJourney.vue';
import ReadingSummary from './ReadingSummary.vue';
import PublicModelReview from './PublicModelReview.vue';
import ProjectModelReview from './ProjectModelReview.vue';
import {isApprovedPublicPreview} from '../public-model-preview';
import {liveState,refreshLive,setProjectStatus,liveBusy,livePending,summarizeNow,confirmProjectConnection,openProjectDocument} from '../store';
const props=defineProps<{workstream:LiveWorkstreamView;dag?:LiveDagView;detail?:boolean}>();
const selectedConnection=ref('');
const publicPreview=computed(()=>isApprovedPublicPreview(props.workstream));
const current=computed(()=>liveState.value?.connection==='connected'&&liveState.value?.freshness==='current'&&(!props.workstream.project||props.workstream.project.status==='active'&&props.workstream.project.sourceState==='available'));
const noteStatus=computed(()=>noteState(props.workstream,liveState.value,props.dag));
const terminalLabel=computed(()=>props.workstream.terminalConnected===null?'터미널 연결 미확인':props.workstream.terminalConnected?'터미널 연결':'터미널 미연결');
</script>
<template>
  <article class="workstream-card live-workstream" data-testid="live-workstream">
    <div class="card-top"><span class="eyebrow">LIVE WORKSTREAM</span><span class="connection-pill" :class="{connected:workstream.terminalConnected===true}"><span class="status-dot"></span>{{terminalLabel}}</span></div>
    <h2><RouterLink :to="'/workstream/'+encodeURIComponent(workstream.id)">{{workstream.title}} <span aria-hidden="true" class="arrow">↗</span></RouterLink></h2>
    <p class="project-identity">{{workstream.repository?.label??projectLabel(workstream)}}<span class="branch-label">{{branchLabel(workstream.branch)}}</span></p>
    <div class="project-actions" data-testid="project-actions"><Button v-if="workstream.project" :label="workstream.project.status==='active'?'프로젝트 완료':'프로젝트 재개'" outlined :disabled="livePending" data-testid="project-status-button" @click="setProjectStatus(workstream.id,workstream.project.status==='active'?'completed':'active',workstream.project.status)"/><Button label="규칙 요약 갱신 · 전체 소스" :loading="livePending" :disabled="livePending||liveState?.connection!=='connected'" data-testid="project-summary-button" title="설정된 전체 소스를 조회해 규칙 기반 설명을 갱신합니다" @click="summarizeNow"/><p class="project-action-scope">규칙 기반 설명 갱신 · 설정된 전체 소스 조회 · 모델 호출 없음. AI 요약은 아래 ‘지금 요약 · Claude AI’에서 실행합니다.</p><p v-if="livePending" role="status">전체 소스 요청 처리 중</p></div>
    <p class="observation-badges"><span>{{workstream.observation?.worktree==='observed'?'현재 관측':workstream.observation?.worktree==='not-observed'?'현재 미관측 · 보존':'관측 여부 미확인'}}</span><span>{{workstream.observation?.sidebarActivity===true?'활동 관측':workstream.observation?.sidebarActivity===false?'활동 미관측':'활동 미확인'}}</span><span v-if="workstream.observation?.selected===true">Orca에서 선택 중</span><span v-if="workstream.observation?.workspaceStatus==='completed'">Orca 작업 상태: 완료</span></p><dl class="workstream-facts"><div><dt>에이전트 관측</dt><dd>{{workstream.agentState==='done'?'완료 상태로 관측':'에이전트 상태 미확인'}}</dd></div><div><dt>터미널 수</dt><dd>{{workstream.terminalCount===null?'미확인':workstream.terminalCount+'개'}}</dd></div><div><dt>보관 상태</dt><dd>{{workstream.archived===null?'미확인':workstream.archived?'보관됨':'비보관'}}</dd></div><div><dt>프로젝트 연결</dt><dd>{{mappingLabel(workstream.projectMapping)}}</dd></div></dl>
    <div class="note-mapping" :class="{unresolved:workstream.noteMapping.state==='unresolved'}"><strong>{{noteStatus.label}}</strong><NoteReconnect :workstream-id="workstream.id" :disabled="livePending||liveState?.connection!=='connected'" @changed="refreshLive"/><p v-if="workstream.noteMapping.state==='unresolved'">{{mappingLabel(workstream.noteMapping.reason)}}</p><p v-else class="muted">{{workstream.noteMapping.registration==='explicit-read-only'?'명시된 읽기 등록으로 확인했습니다. 재연결 버튼은 별도 확인 후 프로젝트 링크를 변경합니다.':'명시된 로컬 노트 범위에서 연결되었습니다'}}</p></div>
    <details v-if="workstream.noteMapping.context" class="evidence" data-testid="note-context"><summary>{{workstream.noteMapping.context.state==='verified'?'확인한 노트 맥락':'보존된 노트 맥락 · 현재 접근 미확인'}}</summary><div class="evidence-body"><p>노트 root: {{workstream.noteMapping.context.noteRootPath}}</p><p>DAG: {{workstream.noteMapping.context.dagPath}}</p><p>이 프로젝트의 실제 연결 경로입니다. 노트 저장소가 코드 저장소와 달라도 독립된 읽기 맥락으로 유지합니다. 읽기 허용은 연결 및 설정에서 확인합니다.</p></div></details>
    <section v-if="workstream.connectionOptions?.length" class="notice warning"><strong>노트 연결 확인 필요</strong><label>연결할 DAG <select v-model="selectedConnection"><option value="">선택해 주세요</option><option v-for="candidate in workstream.connectionOptions" :key="candidate.id" :value="candidate.id">{{candidate.label}}</option></select></label><button :disabled="liveBusy||!selectedConnection" @click="confirmProjectConnection(workstream.id,selectedConnection)">이 연결 확인</button><p>선택은 앱에 저장하며 심볼릭 링크와 노트 원본은 바꾸지 않습니다.</p></section>
    <section v-if="workstream.project" class="project-lifecycle" data-testid="project-lifecycle"><strong>{{workstream.project.status==='completed'?'완료 · 정기 조회 중단':'진행 중'}}</strong><p>{{workstream.project.worktreeState==='missing'?'워크트리 없음 · 프로젝트 추적 유지':'현재 관측된 워크트리 연결'}} · {{workstream.project.sourceState==='unavailable'?'등록된 소스 접근 불가':workstream.project.sourceState==='not-checked'?'현재 접근 재확인 안 됨':'등록된 소스 조회 확인'}}</p><details><summary>맥락·이력 {{workstream.project.history.length}}건</summary><section v-for="(event,index) in workstream.project.history" :key="index"><p>{{event.at}} · {{event.status==='completed'?'사용자 완료':'진행 중'}} · {{event.summary?'요약 기록':'프로젝트 상태 기록'}}</p><ReadingSummary v-if="event.summary" :summary="event.summary" historical/></section></details><p class="muted">프로젝트 완료·재개는 앱에만 저장합니다. DAG와 에이전트 상태는 바꾸지 않습니다.</p></section>
    <nav v-if="workstream.documentLinks?.length" aria-label="프로젝트 문서"><button v-for="link in workstream.documentLinks" :key="link.id" :disabled="liveBusy||liveState?.connection!=='connected'||liveState?.freshness!=='current'" @click="openProjectDocument(workstream.id,link.id)">{{link.role==='inbox'?'인박스':link.role==='discussion'?'논의':'설계'}} · {{link.label}}</button><p class="muted">명시된 wikilink 문서 열기 · 작성 날짜로 갱신 필요를 판단하지 않습니다.</p></nav>
    <ProjectModelReview :key="workstream.id" :workstream-id="workstream.id" :current="!noteStatus.block" :blocked-reason="noteStatus.block"/><PublicModelReview v-if="publicPreview" selected-context/>
    <details v-if="publicPreview&&workstream.readingSummary" class="technical-details"><summary>현재 관측의 규칙 기반 요약 보기 · 모델 호출 없음</summary><ReadingSummary :summary="workstream.readingSummary" :historical="!current"/></details>
    <ReadingSummary v-else-if="workstream.readingSummary" :summary="workstream.readingSummary" :historical="!current"/>
    <template v-if="detail"><SummaryJourney v-if="dag" :key="dag.dagId" :workstream-id="workstream.id" :dag="dag" :current="current"/><NoteLinkJourney :worktree-id="workstream.id" :current="current" @changed="refreshLive"/></template>
    <LiveDag v-if="dag&&detail" :dag="dag" :show-summary="false"/>
    <div v-else-if="dag" class="dag-preview"><div class="section-heading"><h3>DAG 선언</h3><span>{{dag.state==='ready'?(dag.taskCount===null?'작업 수 미확인':dag.taskCount+'개 작업'):dag.state==='error'?'조회 오류':'사용 불가'}}</span></div><div v-if="dag.state==='ready'" class="dag-counts"><span v-for="(item,index) in dag.statusCounts.slice(0,6)" :key="index" class="status-count">{{item.status??'상태 미선언'}} <strong>{{item.count}}</strong></span></div><p v-if="dag.statusCountsOmitted+Math.max(0,dag.statusCounts.length-6)>0" class="muted">추가 상태 범주 {{dag.statusCountsOmitted+Math.max(0,dag.statusCounts.length-6)}}개 생략</p><p v-if="dag.reason" class="muted">{{diagnosticText(dag.reason)}}</p><p class="muted">{{summaryLabels[dag.summary.state]}} · 기존 승인 워크플로 별도 · 수동 AI는 위 버튼에서 실행</p><RouterLink class="detail-link" :to="'/workstream/'+encodeURIComponent(workstream.id)">요약 검토·노트 연결·작업 상세 보기 →</RouterLink></div>
    <div v-else class="dag-preview"><p class="muted">{{workstream.noteMapping.state==='resolved'?'DAG 조회 결과 미확인':'노트 연결 후 DAG를 확인할 수 있습니다'}} · 기존 승인 워크플로 별도 · 수동 AI는 위 버튼에서 실행</p></div>
    <p class="scope-note">터미널 연결과 에이전트 상태는 별개입니다. 완료 선언만으로 테스트·배포 완료를 알 수 없습니다.</p>
    <details class="evidence"><summary>관측 식별자</summary><div class="evidence-body"><p>워크스트림: {{workstream.id}}</p><p>DAG: {{workstream.noteMapping.dagId??'미확인'}}</p></div></details>
  </article>
</template>
