<script setup lang="ts">
import {computed,watch,onUnmounted,onMounted,ref,nextTick} from 'vue';
import type {LiveWorkstreamView,LiveDagView} from '../../shared/live';
import OrcaProjectOpen from './OrcaProjectOpen.vue';
import LiveWorkstreamCard from './LiveWorkstreamCard.vue';
import TaskWorkspace from './TaskWorkspace.vue';
import ProjectDocuments from './ProjectDocuments.vue';
import {liveState} from '../store';
import ResourceWorkspace from './ResourceWorkspace.vue';
import {workspaceState,loadWorkspaceState,saveWorkspaceState,documentScopeState,type WorkspaceTab} from '../phase2-state';
const props=defineProps<{workstream:LiveWorkstreamView;dag?:LiveDagView}>();
const state=workspaceState(props.workstream.id);
const tabs:{id:WorkspaceTab;label:string}[]=[{id:'summary',label:'요약'},{id:'usage',label:'사용량'},{id:'tasks',label:'태스크·DAG'},{id:'documents',label:'문서'}];
const ready=ref(false),saveError=ref(''),summarySelectionError=ref(''),tasksVisited=ref(false),documentsVisited=ref(false);let disposed=false,saveTimer:ReturnType<typeof setTimeout>|undefined;
const summaryCard=ref<InstanceType<typeof LiveWorkstreamCard>|null>(null);
async function summarizeTask(taskId:string){state.tab='summary';await nextTick();await summaryCard.value?.openTasks([taskId]);}
const scope=documentScopeState(props.workstream.id);
// Keep the user-selected project active across all four tabs, independent of Orca's selection.
watch(()=>props.workstream.id,id=>{summarySelectionError.value='';if(typeof window==='undefined')return;void window.noteApp.selectActiveSummaryProject({workstreamId:id}).catch(()=>{if(!disposed&&props.workstream.id===id)summarySelectionError.value='요약 프로젝트 선택을 확인하지 못했습니다. 프로젝트를 다시 선택해 주세요.';});},{immediate:true});
const documentCurrent=computed(()=>liveState.value?.connection==='connected'&&props.workstream.noteMapping.state==='resolved'&&props.workstream.noteMapping.context?.state!=='retained');
watch(()=>[props.workstream.id,props.workstream.noteMapping.dagId,props.workstream.noteMapping.context?.noteRootPath].join('\0'),key=>{if(scope.mappingKey!==key){scope.accepted=false;scope.mappingKey=key;}},{immediate:true});
watch(()=>state.tab,tab=>{if(tab==='tasks')tasksVisited.value=true;if(tab==='documents')documentsVisited.value=true;},{immediate:true});
onMounted(async()=>{try{await loadWorkspaceState(props.workstream.id,state);}catch{saveError.value='이전 화면 상태를 복원하지 못했습니다.';}finally{if(!disposed)ready.value=true;}});
function save(){void saveWorkspaceState(props.workstream.id,state).catch(()=>{saveError.value='화면 상태를 저장하지 못했습니다. 재시작 후 유지되지 않을 수 있습니다.';});}
watch(state,()=>{if(ready.value){if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(save,180);}},{deep:true});
onUnmounted(()=>{disposed=true;void window.noteApp.selectActiveSummaryProject({workstreamId:null}).catch(()=>{});if(saveTimer){clearTimeout(saveTimer);if(ready.value)save();}});
function keys(event:KeyboardEvent){if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const i=tabs.findIndex(t=>t.id===state.tab);state.tab=tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length].id;requestAnimationFrame(()=>document.getElementById('workspace-tab-'+state.tab)?.focus());}
</script>
<template>
 <section class="phase2-workspace" data-testid="phase2-workspace">
  <OrcaProjectOpen :workstream-id="workstream.id"/>
  <p v-if="summarySelectionError" class="notice warning" role="alert">{{summarySelectionError}}</p>
  <p v-if="!ready" role="status">화면 상태를 복원 중입니다</p><p v-if="saveError" class="notice warning">{{saveError}}</p><template v-if="ready"><nav role="tablist" aria-label="프로젝트 내부 보기" class="workspace-tabs" @keydown="keys"><button v-for="tab in tabs" :id="'workspace-tab-'+tab.id" :key="tab.id" role="tab" :aria-selected="state.tab===tab.id" :tabindex="state.tab===tab.id?0:-1" :aria-controls="'workspace-panel-'+tab.id" :data-testid="'workspace-tab-'+tab.id" @click="state.tab=tab.id">{{tab.label}}</button></nav>
  <div v-show="state.tab==='summary'" id="workspace-panel-summary" role="tabpanel" aria-labelledby="workspace-tab-summary"><LiveWorkstreamCard ref="summaryCard" :workstream="workstream" :dag="dag"/></div>
  <div v-if="state.tab==='usage'" id="workspace-panel-usage" role="tabpanel" aria-labelledby="workspace-tab-usage"><ResourceWorkspace :workstream="workstream" :dag="dag"/></div>
  <div v-if="tasksVisited" v-show="state.tab==='tasks'" id="workspace-panel-tasks" role="tabpanel" aria-labelledby="workspace-tab-tasks"><TaskWorkspace :workstream="workstream" :dag="dag" :state="state" :active="state.tab==='tasks'" @documents="state.tab='documents'" @summarize="summarizeTask"/></div>
  <div v-if="documentsVisited" v-show="state.tab==='documents'" id="workspace-panel-documents" role="tabpanel" aria-labelledby="workspace-tab-documents"><ProjectDocuments :workstream-id="workstream.id" :project-title="workstream.title" :state="state" :current="documentCurrent" :picker-active="state.tab==='documents'" :active="state.tab==='documents'&&!liveState?.refreshing"/></div>
 </template></section>
</template>
