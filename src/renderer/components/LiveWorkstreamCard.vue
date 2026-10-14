<script setup lang="ts">
import {computed,ref,watch,onUnmounted,nextTick} from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Select from 'primevue/select';
import type {LiveWorkstreamView,LiveDagView} from '../../shared/live';
import {noteState} from '../note-state';
import {branchLabel,mappingLabel} from '../live-labels';
import {liveState,livePending,liveBusy,refreshLive,setProjectStatus,confirmProjectConnection,openProjectDocument} from '../store';
import NoteReconnect from './NoteReconnect.vue';
import LiveDag from './LiveDag.vue';
import SummaryJourney from './SummaryJourney.vue';
import NoteLinkJourney from './NoteLinkJourney.vue';
import SummaryReview from './SummaryReview.vue';
import SummaryHistory from './SummaryHistory.vue';
import {isApprovedPublicPreview} from '../public-model-preview';
const props=defineProps<{workstream:LiveWorkstreamView;dag?:LiveDagView;detail?:boolean}>();
const reconnectOpen=ref(false),settingsOpen=ref(false),selectedConnection=ref(''),settingsTrigger=ref<HTMLButtonElement|null>(null);
const summaryReview=ref<InstanceType<typeof SummaryReview>|null>(null);
defineExpose({openTasks:(ids:string[])=>summaryReview.value?.openTasks(ids)});
const noteStatus=computed(()=>noteState(props.workstream,liveState.value,props.dag));
function restoreFocus(){void nextTick(()=>settingsTrigger.value?.focus({preventScroll:true}));}
// Legacy detail routes do not mount ProjectWorkspace, so they own the same active-project boundary here.
watch(()=>props.detail?props.workstream.id:null,id=>{if(id&&typeof window!=='undefined')void window.noteApp.selectActiveSummaryProject({workstreamId:id}).catch(()=>{});},{immediate:true});
onUnmounted(()=>{if(props.detail)void window.noteApp.selectActiveSummaryProject({workstreamId:null}).catch(()=>{});});
</script>
<template>
 <article class="summary-project" data-testid="live-workstream">
  <header class="summary-project-heading"><h2>{{workstream.title}}</h2><button ref="settingsTrigger" class="summary-button" data-testid="summary-project-settings" @click="settingsOpen=true">프로젝트 설정</button></header>
  <SummaryReview ref="summaryReview" :key="workstream.id" :workstream-id="workstream.id" :project-title="workstream.title" :blocked-reason="noteStatus.block"/>
  <Dialog v-model:visible="settingsOpen" :close-on-escape="!reconnectOpen" modal header="프로젝트 설정" class="summary-dialog" :style="{width:'760px',maxWidth:'calc(100vw - 40px)'}" @after-hide="restoreFocus">
   <div class="summary-settings-content"><h3>{{workstream.title}}</h3><p class="summary-caption">{{workstream.repository?.label??workstream.projectName??'저장소 미확인'}} · {{branchLabel(workstream.branch)}}</p>
    <section class="summary-project-connection" data-testid="note-connection"><div class="summary-card-heading"><h4>노트 연결</h4><strong data-testid="note-connection-status">{{noteStatus.label}}</strong></div><p v-if="noteStatus.block" class="summary-state-message summary-warning" data-testid="note-connection-recovery">{{noteStatus.block}}</p><p v-if="workstream.noteMapping.context" class="summary-root" data-testid="note-context">{{workstream.noteMapping.context.noteRootPath}}<br>{{workstream.noteMapping.context.dagPath}}</p><div class="summary-inline-actions"><NoteReconnect :workstream-id="workstream.id" :disabled="livePending||liveState?.connection!=='connected'" @changed="refreshLive" @visible-change="reconnectOpen=$event"/><Button label="소스 새로고침" outlined :disabled="livePending||liveState?.connection!=='connected'" :loading="livePending" data-testid="project-summary-button" @click="refreshLive"/></div><p class="summary-caption">로컬 읽기 범위는 연결 설정에서 관리합니다.</p></section>
    <section v-if="workstream.connectionOptions?.length" class="summary-settings-content" data-testid="project-dag-choice"><label :for="'dag-choice-'+workstream.id">연결할 DAG</label><Select v-model="selectedConnection" :input-id="'dag-choice-'+workstream.id" :options="workstream.connectionOptions" option-label="label" option-value="id" placeholder="DAG 선택" :disabled="liveBusy"/><Button label="연결 확인" :disabled="liveBusy||!selectedConnection" @click="confirmProjectConnection(workstream.id,selectedConnection)"/></section>
    <section v-if="workstream.project" class="summary-settings-content" data-testid="project-lifecycle"><div class="summary-card-heading"><h4>{{workstream.project.status==='completed'?'완료한 프로젝트':'진행 중인 프로젝트'}}</h4><Button :label="workstream.project.status==='active'?'프로젝트 완료':'프로젝트 재개'" outlined :disabled="livePending" data-testid="project-status-button" @click="setProjectStatus(workstream.id,workstream.project.status==='active'?'completed':'active',workstream.project.status)"/></div><p class="summary-caption">앱의 프로젝트 상태만 변경합니다. DAG·에이전트 상태는 유지합니다.</p><details><summary>프로젝트 이력 {{workstream.project.history.length}}건</summary><ul><li v-for="(event,index) in workstream.project.history" :key="index">{{event.at}} · {{event.status==='completed'?'완료':'진행 중'}}</li></ul></details></section>
    <nav v-if="workstream.documentLinks?.length" class="summary-inline-actions" aria-label="프로젝트 문서"><button v-for="link in workstream.documentLinks" :key="link.id" class="summary-button" :disabled="liveBusy||liveState?.connection!=='connected'||liveState?.freshness!=='current'" @click="openProjectDocument(workstream.id,link.id)">{{link.role==='inbox'?'인박스':link.role==='discussion'?'논의':'설계'}} · {{link.label}}</button></nav>
    <SummaryHistory :workstream-id="workstream.id" :allow-public-preview="isApprovedPublicPreview(workstream)"/>
    <details class="summary-diagnostics"><summary>연결 진단</summary><p>워크스트림 {{workstream.id}}<br>DAG {{workstream.noteMapping.dagId??'미확인'}}<br>프로젝트 연결 {{mappingLabel(workstream.projectMapping)}}<br>터미널 {{workstream.terminalConnected===null?'미확인':workstream.terminalConnected?'연결':'미연결'}}</p></details>
   </div>
  </Dialog>
  <template v-if="detail"><details class="summary-legacy-details"><summary>태스크·DAG와 이전 검토 기록</summary><LiveDag v-if="dag" :dag="dag" :show-summary="false"/><SummaryJourney v-if="dag" :key="dag.dagId" :workstream-id="workstream.id" :dag="dag" :current="false"/><NoteLinkJourney :worktree-id="workstream.id" :current="!noteStatus.block" @changed="refreshLive"/></details></template>
 </article>
</template>
