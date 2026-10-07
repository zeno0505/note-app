<script setup lang="ts">
import {watch,onUnmounted} from 'vue';
import type {LiveWorkstreamView,LiveDagView} from '../../shared/live';
import LiveWorkstreamCard from './LiveWorkstreamCard.vue';
import TaskWorkspace from './TaskWorkspace.vue';
import ResourceWorkspace from './ResourceWorkspace.vue';
import {workspaceState,saveWorkspaceState,type WorkspaceTab} from '../phase2-state';
const props=defineProps<{workstream:LiveWorkstreamView;dag?:LiveDagView}>();
const state=workspaceState(props.workstream.id);
const tabs:{id:WorkspaceTab;label:string}[]=[{id:'summary',label:'요약'},{id:'usage',label:'사용량'},{id:'tasks',label:'태스크·DAG'}];
watch(state,()=>saveWorkspaceState(props.workstream.id,state),{deep:true});
onUnmounted(()=>saveWorkspaceState(props.workstream.id,state));
function keys(event:KeyboardEvent){if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const i=tabs.findIndex(t=>t.id===state.tab);state.tab=tabs[event.key==='Home'?0:event.key==='End'?2:(i+(event.key==='ArrowRight'?1:2))%3].id;requestAnimationFrame(()=>document.getElementById('workspace-tab-'+state.tab)?.focus());}
</script>
<template>
 <section class="phase2-workspace" data-testid="phase2-workspace">
  <nav role="tablist" aria-label="프로젝트 내부 보기" class="workspace-tabs" @keydown="keys"><button v-for="tab in tabs" :id="'workspace-tab-'+tab.id" :key="tab.id" role="tab" :aria-selected="state.tab===tab.id" :tabindex="state.tab===tab.id?0:-1" :aria-controls="'workspace-panel-'+tab.id" :data-testid="'workspace-tab-'+tab.id" @click="state.tab=tab.id">{{tab.label}}</button></nav>
  <div v-show="state.tab==='summary'" id="workspace-panel-summary" role="tabpanel" aria-labelledby="workspace-tab-summary"><LiveWorkstreamCard :workstream="workstream" :dag="dag"/></div>
  <div v-if="state.tab==='usage'" id="workspace-panel-usage" role="tabpanel" aria-labelledby="workspace-tab-usage"><ResourceWorkspace :workstream="workstream" :dag="dag"/></div>
  <div v-if="state.tab==='tasks'" id="workspace-panel-tasks" role="tabpanel" aria-labelledby="workspace-tab-tasks"><TaskWorkspace :workstream="workstream" :dag="dag" :state="state"/></div>
 </section>
</template>
