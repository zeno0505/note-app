<script setup lang="ts">
import {watch,onUnmounted,onMounted,ref} from 'vue';
import type {LiveWorkstreamView,LiveDagView} from '../../shared/live';
import LiveWorkstreamCard from './LiveWorkstreamCard.vue';
import TaskWorkspace from './TaskWorkspace.vue';
import ResourceWorkspace from './ResourceWorkspace.vue';
import {workspaceState,loadWorkspaceState,saveWorkspaceState,type WorkspaceTab} from '../phase2-state';
const props=defineProps<{workstream:LiveWorkstreamView;dag?:LiveDagView}>();
const state=workspaceState(props.workstream.id);
const tabs:{id:WorkspaceTab;label:string}[]=[{id:'summary',label:'요약'},{id:'usage',label:'사용량'},{id:'tasks',label:'태스크·DAG'}];
const ready=ref(false),saveError=ref('');let disposed=false;
onMounted(async()=>{try{await loadWorkspaceState(props.workstream.id,state);}catch{saveError.value='이전 화면 상태를 복원하지 못했습니다.';}finally{if(!disposed)ready.value=true;}});
watch(state,()=>{if(ready.value)void saveWorkspaceState(props.workstream.id,state).catch(()=>{saveError.value='화면 상태를 저장하지 못했습니다. 재시작 후 유지되지 않을 수 있습니다.';});},{deep:true,flush:'sync'});
onUnmounted(()=>{disposed=true;});
function keys(event:KeyboardEvent){if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const i=tabs.findIndex(t=>t.id===state.tab);state.tab=tabs[event.key==='Home'?0:event.key==='End'?2:(i+(event.key==='ArrowRight'?1:2))%3].id;requestAnimationFrame(()=>document.getElementById('workspace-tab-'+state.tab)?.focus());}
</script>
<template>
 <section class="phase2-workspace" data-testid="phase2-workspace">
  <p v-if="!ready" role="status">화면 상태를 복원 중입니다</p><p v-if="saveError" class="notice warning">{{saveError}}</p><template v-if="ready"><nav role="tablist" aria-label="프로젝트 내부 보기" class="workspace-tabs" @keydown="keys"><button v-for="tab in tabs" :id="'workspace-tab-'+tab.id" :key="tab.id" role="tab" :aria-selected="state.tab===tab.id" :tabindex="state.tab===tab.id?0:-1" :aria-controls="'workspace-panel-'+tab.id" :data-testid="'workspace-tab-'+tab.id" @click="state.tab=tab.id">{{tab.label}}</button></nav>
  <div v-show="state.tab==='summary'" id="workspace-panel-summary" role="tabpanel" aria-labelledby="workspace-tab-summary"><LiveWorkstreamCard :workstream="workstream" :dag="dag"/></div>
  <div v-if="state.tab==='usage'" id="workspace-panel-usage" role="tabpanel" aria-labelledby="workspace-tab-usage"><ResourceWorkspace :workstream="workstream" :dag="dag"/></div>
  <div v-if="state.tab==='tasks'" id="workspace-panel-tasks" role="tabpanel" aria-labelledby="workspace-tab-tasks"><TaskWorkspace :workstream="workstream" :dag="dag" :state="state"/></div>
 </template></section>
</template>
