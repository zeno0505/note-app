<script setup lang="ts">
import {computed,ref,watch,nextTick,onMounted,onUnmounted} from 'vue';
import Button from 'primevue/button';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import Dialog from 'primevue/dialog';
import type {LiveWorkstreamView,LiveDagView} from '../../shared/live';
import {interpretTasks,filterTasks,taskFilterOptions,TASK_STATUS_OPTIONS,type TaskStatusFilter} from '../../phase2/tasks';
import {layoutTaskGraph} from '../../phase2/graph';
import {taskPrefix} from '../../shared/summary-prefix';
import type {TaskWorkspaceState} from '../phase2-state';
import {liveState,livePending,setSummaryPrefix} from '../store';
import ProjectModelReview from './ProjectModelReview.vue';
import EvidenceViewer from './EvidenceViewer.vue';
const props=defineProps<{workstream:LiveWorkstreamView;dag?:LiveDagView;state:TaskWorkspaceState}>();
const tasks=computed(()=>props.dag?.workspaceTasks??props.dag?.tasks??[]);
const rows=computed(()=>interpretTasks(tasks.value,{projectId:props.workstream.id,dagId:props.dag?.dagId??'',sourceHash:props.dag?.sourceHash??'',observedAt:props.dag?.observedAt??'',policies:props.dag?.policies??[]}));
const options=computed(()=>taskFilterOptions(rows.value));
const visible=computed(()=>filterTasks(rows.value,{status:props.state.status as TaskStatusFilter,search:props.state.search,type:props.state.type==='all'?undefined:props.state.type.slice(5),phase:props.state.phase==='all'?undefined:props.state.phase,prefix:props.state.prefix==='all'?undefined:props.state.prefix.slice(7)}).filter(row=>props.state.feature==='all'||row.task.rawFeature===props.state.feature.slice(8)));
const features=computed(()=>[...new Set(tasks.value.flatMap(t=>t.rawFeature?[t.rawFeature]:[]))].sort());
const omittedDependencies=computed(()=>tasks.value.reduce((n,t)=>n+t.displayOmissions.dependencies,0));
const selected=computed(()=>rows.value.find(r=>r.task.id===props.state.selected));
const graph=computed(()=>layoutTaskGraph(tasks.value,visible.value.map(r=>r.task.id)));
const list=ref<HTMLElement|null>(null),detail=ref<HTMLElement|null>(null),summaryOpen=ref(false),selectionBusy=ref(false),summaryError=ref('');
const sourceAtSelection=ref(props.dag?.sourceHash),stale=computed(()=>!!selected.value&&sourceAtSelection.value!==props.dag?.sourceHash);
const current=computed(()=>liveState.value?.connection==='connected'&&liveState.value?.freshness==='current'&&props.dag?.state==='ready');
async function choose(id:string){props.state.selected=id;props.state.detailScroll=0;sourceAtSelection.value=props.dag?.sourceHash;await nextTick();detail.value?.focus();}
async function close(){const id=props.state.selected;props.state.selected='';summaryOpen.value=false;await nextTick();Array.from(list.value?.querySelectorAll<HTMLButtonElement>('[data-task-id]')??[]).find(el=>el.dataset.taskId===id)?.focus();}
async function summarize(){const task=selected.value?.task,prefix=task&&taskPrefix(task.id);if(!task||!prefix||selectionBusy.value)return;selectionBusy.value=true;summaryError.value='';try{await setSummaryPrefix(props.workstream.id,prefix,[task.id]);await nextTick();if(props.dag?.summaryScope?.taskSelection.taskIds.length===1&&props.dag.summaryScope.taskSelection.taskIds[0]===task.id)summaryOpen.value=true;else summaryError.value='선택 범위 반영을 확인한 뒤 다시 눌러 주세요.';}finally{selectionBusy.value=false;}}
watch(()=>props.state.selected,()=>{summaryOpen.value=false;});
onMounted(async()=>{await nextTick();if(list.value)list.value.scrollTop=props.state.scroll;if(detail.value)detail.value.scrollTop=props.state.detailScroll;});
onUnmounted(()=>{summaryOpen.value=false;});
const lifecycleLabels={before:'작업 전','in-progress':'진행 중',review:'검토 대기',done:'완료',unknown:'해석 미확인'};
</script>
<template>
 <section class="task-workspace" data-testid="task-workspace">
  <h2>태스크·DAG</h2><p class="muted">원문 상태와 정책 해석을 함께 봅니다. 실행과 파견은 Orca에서 수행합니다.</p>
  <p v-if="!current" class="notice warning">현재 근거를 재확인하지 못했습니다. 보존된 선언이며 최신 상태나 작업 없음으로 판단하지 않습니다.</p>
  <div class="task-filters">
   <label>상태<Select v-model="state.status" :options="[...TASK_STATUS_OPTIONS]" option-label="label" option-value="value" aria-label="태스크 상태" data-testid="task-status-filter"/></label>
   <label>검색<InputText v-model="state.search" :maxlength="512" aria-label="태스크 검색" placeholder="ID·제목·원본 상태" data-testid="task-search"/></label>
   <label>타입<Select v-model="state.type" :options="[{value:'all',label:'모든 타입'},...options.types.map(t=>({value:'type:'+t,label:t}))]" option-label="label" option-value="value" aria-label="태스크 타입"/></label>
   <label>Phase<Select v-model="state.phase" :options="[{value:'all',label:'모든 Phase'},...options.phases]" option-label="label" option-value="value" aria-label="태스크 Phase"/></label>
   <label>접두사<Select v-model="state.prefix" :options="[{value:'all',label:'모든 접두사'},...options.prefixes.map(t=>({value:'prefix:'+t,label:t}))]" option-label="label" option-value="value" aria-label="태스크 접두사"/></label>
   <label>기능<Select v-model="state.feature" :options="[{value:'all',label:features.length?'모든 기능':'기능 선언 없음'},...features.map(t=>({value:'feature:'+t,label:t}))]" option-label="label" option-value="value" aria-label="태스크 기능" :disabled="!features.length"/></label>
  </div>
  <div class="section-heading"><p role="status" data-testid="task-count">{{visible.length}}개 표시 · 수집된 {{tasks.length}}개 · 필터로 숨김 {{tasks.length-visible.length}}개<span v-if="(dag?.workspaceTaskCount??dag?.taskCount??0)>tasks.length"> · 표시 상한 밖 {{(dag?.workspaceTaskCount??dag?.taskCount??0)-tasks.length}}개</span></p><div class="filter-group"><button :aria-pressed="state.view==='list'" @click="state.view='list'">목록</button><button :aria-pressed="state.view==='dag'" data-testid="task-dag-toggle" @click="state.view='dag'">읽기 전용 DAG</button></div></div>
  <p v-if="omittedDependencies" class="notice warning">의존 참조 {{omittedDependencies}}개가 표시 상한으로 생략됐습니다. 현재 그래프가 전체 연결을 보여 준다고 판단하지 않습니다.</p>
  <p class="muted">논의·검증 필요는 완료 상태와 겹칠 수 있습니다. 필터별 수의 합은 전체 작업 수가 아닙니다. 검토 대기는 명시된 태스크 완료 리뷰와 실제 관측한 PR 리뷰를 포함합니다. 명시 상태 매핑 정책이 없으면 해석 미확인으로 남깁니다.</p>
  <div class="task-split" :class="{'task-selected':!!selected}">
   <div ref="list" class="task-list-scroll" @scroll="state.scroll=($event.target as HTMLElement).scrollTop">
    <p v-if="!visible.length" class="empty-state">{{tasks.length?'현재 필터에 맞는 작업이 없습니다. 필터를 바꿔 주세요.':'표시할 작업 선언을 확인하지 못했습니다.'}}</p>
    <ol v-if="state.view==='list'" class="phase2-task-list"><li v-for="row in visible" :key="row.task.id"><button :data-task-id="row.task.id" :aria-pressed="state.selected===row.task.id" @click="choose(row.task.id)"><strong>{{row.task.id}} · {{row.task.title??'제목 미선언'}}</strong><span>{{row.rawType??'타입 미선언'}} · {{row.rawStatus??'상태 미선언'}} → {{lifecycleLabels[row.lifecycle]}}</span><small>의존 {{row.task.dependencies.length}}개 · E2E {{row.task.e2e.coverage}} · 실행 검증 미수행</small></button></li></ol>
    <div v-else class="dag-scroll" data-testid="readonly-dag"><p>노드 선택만 가능합니다. 원문 이동·연결·삭제 기능은 없습니다.</p><svg :viewBox="`0 0 ${graph.width} ${graph.height}`" :style="{width:graph.width+'px',height:graph.height+'px'}" role="img" aria-label="태스크 의존 그래프"><g v-for="edge in graph.edges" :key="edge.id"><path :d="edge.path??undefined" fill="none" stroke="currentColor" opacity=".3"/></g><g v-for="node in graph.nodes" :key="node.id" role="button" tabindex="0" :aria-label="node.id+' 선택'" @click="choose(node.id)" @keydown.enter="choose(node.id)" @keydown.space.prevent="choose(node.id)"><rect :x="node.x" :y="node.y" :width="node.width" :height="node.height" rx="8" :class="{'selected-node':state.selected===node.id}"/><text :x="node.x+12" :y="node.y+24">{{node.id}}</text></g></svg><p class="muted">{{JSON.stringify(graph.diagnostics)}}</p></div>
   </div>
   <aside v-if="selected" ref="detail" class="task-detail" tabindex="-1" aria-label="선택 태스크 상세" data-testid="task-detail" @scroll="state.detailScroll=($event.target as HTMLElement).scrollTop">
    <header class="task-detail-header"><Button label="태스크 요약" text :disabled="!current||selectionBusy||livePending||!taskPrefix(selected.task.id)" :loading="selectionBusy" data-testid="task-summary-open" @click="summarize"/><span class="muted" title="설치 Orca의 안전한 프로젝트 이동 capability를 아직 확인하지 못했습니다">Orca 이동 미지원</span><Button label="×" text aria-label="태스크 상세 닫기" title="닫기" data-testid="task-detail-close" @click="close"/></header>
    <h3>{{selected.task.id}} · {{selected.task.title}}</h3><p v-if="stale" class="notice warning">선택 후 근거가 변경되었습니다. 현재 원문을 다시 검토하고 요약을 갱신해 주세요.</p><p v-if="summaryError" role="alert">{{summaryError}}</p>
    <dl><dt>원본 타입·상태</dt><dd>{{selected.rawType??'미선언'}} · {{selected.rawStatus??'미선언'}}</dd><dt>정책 해석</dt><dd>{{lifecycleLabels[selected.lifecycle]}}</dd><dt>Phase</dt><dd>{{selected.task.phase?.title??selected.task.phase?.id??'소속 미확인'}}</dd><dt>추가 이유·수행 설명 (선언)</dt><dd>{{selected.task.details?.description??'기록 미확인'}}</dd></dl>
    <h4>수용 기준 (선언)</h4><ul><li v-for="(value,i) in selected.task.details?.acceptanceCriteria??[]" :key="i">{{value}}</li></ul><p v-if="!selected.task.details?.acceptanceCriteria.length">기록 미확인</p>
    <h4>변경 대상 파일 (선언)</h4><ul><li v-for="(value,i) in selected.task.details?.targetFiles??[]" :key="i">{{value}}</li></ul><p>실제 파일 변경·커밋·검증 통과를 확인한 목록이 아닙니다.</p>
    <h4>의존성</h4><ul><li v-for="dep in selected.task.dependencies" :key="dep.id">{{dep.id}} · {{dep.scope==='external'?'외부·미확인':'DAG 내부'}}<span v-if="!visible.some(r=>r.task.id===dep.id)"> · 현재 목록 밖</span></li></ul>
    <p v-if="selected.task.displayOmissions.dependencies">추가 의존 참조 {{selected.task.displayOmissions.dependencies}}개 표시 생략</p><h4>검증·리뷰</h4><p>E2E {{selected.task.e2e.coverage}} · {{selected.task.e2e.coveredBy?.join(', ')||'참조 미확인'}}</p><p>커밋 {{selected.task.commitReferences.join(', ')||'참조 미확인'}} · 실제 실행 검증 미수행</p><p v-if="selected.task.displayOmissions.commitReferences||selected.task.displayOmissions.e2eReferences">표시 생략: 커밋 {{selected.task.displayOmissions.commitReferences}}개 · E2E {{selected.task.displayOmissions.e2eReferences}}개</p><p v-if="selected.task.details?.omissions">지원하지 않는 상세 필드 {{selected.task.details.omissions}}개 생략</p>
    <EvidenceViewer :key="selected.task.id" :workstream-id="workstream.id" :task-id="selected.task.id" :source-hash="dag?.sourceHash??null" :current="current"/>
    <details><summary>해석·출처 근거</summary><pre>{{JSON.stringify({reasons:selected.reasons,policy:selected.policy,provenance:selected.provenance},null,2)}}</pre></details>
   </aside>
  </div>
  <Dialog v-model:visible="summaryOpen" modal header="선택 태스크 수동 AI 요약" :style="{width:'min(780px,94vw)'}"><p>현재 프로젝트의 요약 선택 범위를 {{selected?.task.id}} 하나로 지정했습니다. 실제 모델 호출은 아래 전송 확인 후에만 실행됩니다.</p><ProjectModelReview v-if="selected&&summaryOpen" :key="selected.task.id+':'+dag?.summaryScope?.sourceHash" :workstream-id="workstream.id" :workstream-title="workstream.title" :summary-prefix="dag?.summaryScope?.selected" :current="current&&dag?.summaryScope?.taskSelection.taskIds.length===1&&dag.summaryScope.taskSelection.taskIds[0]===selected.task.id"/></Dialog>
 </section>
</template>
