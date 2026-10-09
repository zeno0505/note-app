<script setup lang="ts">
import {computed,ref,watch,nextTick,onMounted,onUnmounted} from 'vue';
import Button from 'primevue/button';
import InfoDialog from './InfoDialog.vue';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import Dialog from 'primevue/dialog';
import type {LiveWorkstreamView,LiveDagView} from '../../shared/live';
import {interpretTasks,filterTasks,taskFilterOptions,TASK_STATUS_OPTIONS,type TaskStatusFilter} from '../../phase2/tasks';
import {layoutTaskGraph} from '../../phase2/graph';
import {taskPage,pageConnections,TASK_PAGE_SIZES} from '../../phase2/task-pages';
import {taskPageState} from '../task-page-state';
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
const idCounts=computed(()=>{const counts=new Map<string,number>();for(const row of rows.value)counts.set(row.task.id,(counts.get(row.task.id)??0)+1);return counts;});
const selected=computed(()=>idCounts.value.get(props.state.selected)===1?rows.value.find(r=>r.task.id===props.state.selected):undefined);
const pagination=taskPageState(props.state),page=computed(()=>taskPage(visible.value,pagination.page,pagination.size));
const pageIds=computed(()=>new Set(page.value.items.map(row=>row.task.id)));
const fullGraph=computed(()=>layoutTaskGraph(tasks.value,visible.value.map(r=>r.task.id)));
const connections=computed(()=>pageConnections(fullGraph.value,pageIds.value));
const connectionPage=ref(1),connectionSlice=computed(()=>taskPage(connections.value,connectionPage.value,25));
const graph=computed(()=>layoutTaskGraph(tasks.value,pageIds.value));
const graphBounds=computed(()=>{const left=graph.value.nodes.length?Math.min(...graph.value.nodes.map(n=>n.x))-24:0;return {left,width:graph.value.width-left,height:graph.value.height};});
const graphZoom=ref(1),graphPane=ref<HTMLElement|null>(null);
const rowById=computed(()=>new Map(rows.value.map(row=>[row.task.id,row])));
function fitGraph(){const pane=graphPane.value;if(!pane)return;graphZoom.value=Math.min(1,(pane.clientWidth-20)/graphBounds.value.width,420/graph.value.height);pane.scrollTo({left:0,top:0});}
function centerGraphSelection(){const node=graph.value.nodes.find(n=>n.id===props.state.selected),pane=graphPane.value;if(node&&pane)pane.scrollTo({left:Math.max(0,(node.x-graphBounds.value.left+node.width/2)*graphZoom.value-pane.clientWidth/2),top:Math.max(0,(node.y+node.height/2)*graphZoom.value-pane.clientHeight/2),behavior:'smooth'});}

const list=ref<HTMLElement|null>(null),detail=ref<HTMLElement|null>(null),summaryOpen=ref(false),selectionBusy=ref(false),summaryError=ref('');
const sourceAtSelection=ref(props.dag?.sourceHash),stale=computed(()=>!!selected.value&&sourceAtSelection.value!==props.dag?.sourceHash);
const current=computed(()=>liveState.value?.connection==='connected'&&liveState.value?.freshness==='current'&&props.dag?.state==='ready');
async function choose(id:string){props.state.selected=id;props.state.detailScroll=0;sourceAtSelection.value=props.dag?.sourceHash;await nextTick();detail.value?.focus();}
function resetScroll(){props.state.scroll=0;if(list.value)list.value.scrollTop=0;if(graphPane.value)graphPane.value.scrollTo({left:0,top:0});}
async function changePage(value:number){pagination.page=taskPage(visible.value,value,pagination.size).page;connectionPage.value=1;await nextTick();resetScroll();}
function enterPage(event:Event){const input=event.target as HTMLInputElement;const target=taskPage(visible.value,Number(input.value),pagination.size).page;input.value=String(target);void changePage(target);}
async function reveal(id:string,focus=true){const index=visible.value.findIndex(row=>row.task.id===id&&idCounts.value.get(id)===1);if(index<0)return false;await changePage(Math.floor(index/pagination.size)+1);await nextTick();if(focus)Array.from(list.value?.querySelectorAll<HTMLElement|SVGElement>('[data-task-id]')??[]).find(el=>el.dataset.taskId===id)?.focus();return true;}
async function close(){const id=props.state.selected;props.state.selected='';summaryOpen.value=false;await nextTick();if(!await reveal(id)){document.querySelector<HTMLInputElement>('[data-testid=task-search]')?.focus();}}
async function rowKeyboard(event:KeyboardEvent,id:string){if(!['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(event.key))return;event.preventDefault();const index=visible.value.findIndex(row=>row.task.id===id);let next=event.key==='Home'?0:event.key==='End'?visible.value.length-1:index+(event.key==='PageDown'?pagination.size:event.key==='PageUp'?-pagination.size:event.key==='ArrowDown'?1:-1);const direction=['ArrowUp','PageUp','End'].includes(event.key)?-1:1;next=Math.max(0,Math.min(visible.value.length-1,next));while(next>=0&&next<visible.value.length&&idCounts.value.get(visible.value[next].task.id)!==1)next+=direction;if(next>=0&&next<visible.value.length)await reveal(visible.value[next].task.id);}
watch(()=>[props.state.status,props.state.search,props.state.type,props.state.phase,props.state.prefix,props.state.feature].join('\0'),()=>{pagination.page=1;connectionPage.value=1;resetScroll();});
watch(()=>pagination.size,(_,prior)=>{pagination.page=Math.floor((pagination.page-1)*prior/pagination.size)+1;connectionPage.value=1;resetScroll();});
watch(()=>page.value.page,value=>{pagination.page=value;});
watch(()=>rows.value.map(r=>r.task.id).join('\0'),()=>{if(props.state.selected&&idCounts.value.get(props.state.selected)!==1)props.state.selected='';});
watch(()=>page.value.items,()=>{connectionPage.value=1;});
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
  <div class="section-heading"><p role="status" data-testid="task-count">필터 결과 {{visible.length}}개 · 현재 페이지 {{page.items.length}}개 · 수집된 {{tasks.length}}개 · 필터로 숨김 {{tasks.length-visible.length}}개<span v-if="(dag?.workspaceTaskCount??dag?.taskCount??0)>tasks.length"> · 표시 상한 밖 {{(dag?.workspaceTaskCount??dag?.taskCount??0)-tasks.length}}개</span></p><div class="filter-group"><button :aria-pressed="state.view==='list'" @click="state.view='list'">목록</button><button :aria-pressed="state.view==='dag'" data-testid="task-dag-toggle" @click="state.view='dag'">읽기 전용 DAG</button></div></div>
  <nav class="task-pagination" aria-label="태스크 페이지" data-testid="task-pagination">
   <span role="status" data-testid="task-page-range">{{visible.length?page.start+1:0}}–{{page.end}} / {{visible.length}}개 · {{page.page}} / {{page.count}}페이지</span>
   <Button label="처음" outlined :disabled="page.page===1" aria-label="첫 태스크 페이지" @click="changePage(1)"/><Button label="이전" outlined :disabled="page.page===1" aria-label="이전 태스크 페이지" @click="changePage(page.page-1)"/>
   <label>페이지<input type="number" :value="page.page" min="1" :max="page.count" aria-label="태스크 페이지 번호" @change="enterPage"/></label>
   <Button label="다음" outlined :disabled="page.page===page.count" aria-label="다음 태스크 페이지" @click="changePage(page.page+1)"/><Button label="마지막" outlined :disabled="page.page===page.count" aria-label="마지막 태스크 페이지" @click="changePage(page.count)"/>
   <label>페이지당<Select v-model="pagination.size" :options="[...TASK_PAGE_SIZES]" aria-label="페이지당 태스크 수"/></label>
  </nav>
  <p v-if="omittedDependencies" class="notice warning">의존 참조 {{omittedDependencies}}개가 표시 상한으로 생략됐습니다. 현재 그래프가 전체 연결을 보여 준다고 판단하지 않습니다.</p>
  <div class="compact-help"><span class="muted">원본 상태 · 정책 해석</span><InfoDialog label="태스크 상태와 건수 해석" hint="상태·건수 기준"><p class="muted">논의·검증 필요는 완료 상태와 겹칠 수 있습니다. 필터별 수의 합은 전체 작업 수가 아닙니다. 검토 대기는 명시된 태스크 완료 리뷰와 실제 관측한 PR 리뷰를 포함합니다. 명시 상태 매핑 정책이 없으면 해석 미확인으로 남깁니다.</p></InfoDialog></div>
  <div class="task-split" :class="{'task-selected':!!selected}">
   <div ref="list" class="task-list-scroll" @scroll="state.scroll=($event.target as HTMLElement).scrollTop">
    <p v-if="!visible.length" class="empty-state">{{tasks.length?'현재 필터에 맞는 작업이 없습니다. 필터를 바꿔 주세요.':'표시할 작업 선언을 확인하지 못했습니다.'}}</p>
    <ol v-if="state.view==='list'" class="phase2-task-list" aria-label="태스크 목록"><li v-for="(row,index) in page.items" :key="JSON.stringify([row.task.id,page.start+index])" :aria-posinset="page.start+index+1" :aria-setsize="visible.length"><button :data-task-id="row.task.id" :aria-pressed="state.selected===row.task.id" :disabled="idCounts.get(row.task.id)!==1" @keydown="rowKeyboard($event,row.task.id)" @click="choose(row.task.id)"><strong>{{row.task.id}}<span v-if="idCounts.get(row.task.id)!==1"> · 중복 ID · 상세 대상 미확인</span> · {{row.task.title??'제목 미선언'}}</strong><span>{{row.rawType??'타입 미선언'}} · {{row.rawStatus??'상태 미선언'}} → {{lifecycleLabels[row.lifecycle]}}</span><small>의존 {{row.task.dependencies.length}}개 · E2E {{row.task.e2e.coverage}} · 실행 검증 미수행</small></button></li></ol>
    <section v-else data-testid="readonly-dag">
     <div class="evidence-tools graph-tools"><Button label="페이지 맞춤" outlined @click="fitGraph"/><Button label="100%" outlined @click="graphZoom=1"/><Button label="−" outlined aria-label="DAG 축소" @click="graphZoom=Math.max(.05,graphZoom/1.4)"/><Button label="+" outlined aria-label="DAG 확대" @click="graphZoom=Math.min(2,Math.max(.1,graphZoom*1.4))"/><Button label="선택 작업으로" text :disabled="!selected||!pageIds.has(state.selected)" @click="centerGraphSelection"/><span data-testid="graph-zoom-status">{{Math.round(graphZoom*1000)/10}}%</span></div>
     <p>현재 페이지의 노드와 페이지 안 연결을 표시합니다. 다른 페이지·필터 밖·외부 연결은 아래 연결 안내에서 확인합니다. 전체 관계가 사라진 것으로 판단하지 않습니다.</p><p v-if="graphZoom<.3" class="muted">관계 개요를 축소해 보고 있습니다. 제목·상태를 읽으려면 확대하거나 목록으로 바꿔 주세요.</p>
     <div ref="graphPane" class="dag-scroll"><svg :viewBox="`${graphBounds.left} 0 ${graphBounds.width} ${graphBounds.height}`" :style="{width:graphBounds.width*graphZoom+'px',height:graph.height*graphZoom+'px'}" role="group" aria-label="현재 페이지 태스크 의존 그래프"><g v-for="edge in graph.edges.filter(e=>e.path)" :key="edge.id"><path :d="edge.path??undefined" fill="none" stroke="currentColor" opacity=".4"/></g><g v-for="node in graph.nodes" :key="node.id" role="button" tabindex="0" :data-task-id="node.id" :aria-label="node.id+' '+(node.task.title??'제목 미선언')+' 원본 상태 '+(node.task.status??'미선언')+' 선택'" @keydown="rowKeyboard($event,node.id)" @click="choose(node.id)" @keydown.enter="choose(node.id)" @keydown.space.prevent="choose(node.id)"><rect :x="node.x" :y="node.y" :width="node.width" :height="node.height" rx="8" :class="['node-'+(rowById.get(node.id)?.lifecycle??'unknown'),{'selected-node':state.selected===node.id,'cyclic-node':node.cycle}]"/><text :x="node.x+12" :y="node.y+21">{{node.id}}</text><text class="node-description" :x="node.x+12" :y="node.y+43">{{(node.task.title??'제목 미선언').slice(0,16)}}{{(node.task.title?.length??0)>16?'…':''}}</text><text class="node-description" :x="node.x+12" :y="node.y+63">{{(node.task.status??'미선언').slice(0,14)}} · {{lifecycleLabels[rowById.get(node.id)?.lifecycle??'unknown']}}</text></g></svg></div>
     <section class="page-connections" data-testid="page-connections" aria-label="페이지 밖 연결 안내"><h3>현재 페이지 밖 연결</h3><p role="status">{{connections.length}}개 · 이 중 {{connections.length?connectionSlice.start+1:0}}–{{connectionSlice.end}} 표시<span v-if="!connections.length"> (연결 선언 없음)</span>. 다른 페이지 참조도 원래 의존 관계에 포함됩니다.</p>
      <ul><li v-for="edge in connectionSlice.items" :key="edge.id">{{edge.from}} → {{edge.to}} · {{edge.direction==='incoming'?'현재 페이지로 들어오는 연결':'현재 페이지에서 나가는 연결'}} · <template v-if="(edge.kind==='internal'||edge.kind==='cycle')&&visible.some(row=>row.task.id===(edge.direction==='incoming'?edge.from:edge.to))"><Button :label="'다른 페이지 작업 '+(edge.direction==='incoming'?edge.from:edge.to)+' 보기'" text @click="reveal(edge.direction==='incoming'?edge.from:edge.to)"/></template><span v-else>{{edge.kind==='external'?'외부 참조·충족 미확인':edge.kind==='unknown'?'연결 대상 미확인':'현재 필터 밖'}}</span></li></ul>
      <Button label="이전 연결" text :disabled="connectionSlice.page===1" @click="connectionPage--"/><span>{{connectionSlice.page}} / {{connectionSlice.count}}</span><Button label="다음 연결" text :disabled="connectionSlice.page===connectionSlice.count" @click="connectionPage++"/>
     </section>
     <p class="muted">순환 {{fullGraph.diagnostics.cycles.length}}개 · 외부 의존 {{fullGraph.diagnostics.externalDependencies.length}}개 · 필터 밖 의존 {{fullGraph.diagnostics.hiddenDependencies.length}}개 · 연결 미확인 {{fullGraph.diagnostics.unknownDependencies.length}}개</p>
     <details class="graph-diagnostics"><summary>연결 진단 상세</summary><p v-if="!fullGraph.diagnostics.cycles.length&&!fullGraph.diagnostics.externalDependencies.length&&!fullGraph.diagnostics.hiddenDependencies.length&&!fullGraph.diagnostics.unknownDependencies.length">현재 표시 범위에서 추가 연결 진단이 없습니다.</p><ul><li v-for="(cycle,i) in fullGraph.diagnostics.cycles.slice(0,20)" :key="'cycle-'+i">순환: {{cycle.join(' → ')}}</li><li v-for="(dep,i) in fullGraph.diagnostics.externalDependencies.slice(0,20)" :key="'external-'+i">{{dep.taskId}} → {{dep.dependencyId}} · 외부, 충족 미확인</li><li v-for="(dep,i) in fullGraph.diagnostics.hiddenDependencies.slice(0,20)" :key="'hidden-'+i">{{dep.taskId}} → {{dep.dependencyId}} · 현재 필터 밖</li><li v-for="(dep,i) in fullGraph.diagnostics.unknownDependencies.slice(0,20)" :key="'unknown-'+i">{{dep.taskId}} → {{dep.dependencyId}} · 연결 미확인</li></ul><p>각 진단은20개까지 표시합니다. 중복ID {{fullGraph.diagnostics.duplicateTaskIds.length}}개 · 숨긴 노드 {{fullGraph.diagnostics.hiddenNodeCount}}개</p></details>
    </section>
   </div>
   <aside v-if="selected" ref="detail" class="task-detail" tabindex="-1" aria-label="선택 태스크 상세" data-testid="task-detail" @scroll="state.detailScroll=($event.target as HTMLElement).scrollTop">
    <header class="task-detail-header"><Button label="태스크 요약" text :disabled="!current||selectionBusy||livePending||!taskPrefix(selected.task.id)" :loading="selectionBusy" data-testid="task-summary-open" @click="summarize"/><span class="muted" title="태스크 단위 직접 이동은 지원하지 않습니다. 프로젝트 상단에서 검증된 DAG 파일 열기를 확인할 수 있습니다.">태스크 직접 이동 미지원</span><Button label="×" text aria-label="태스크 상세 닫기" title="닫기" data-testid="task-detail-close" @click="close"/></header>
    <p v-if="!pageIds.has(state.selected)" class="notice warning" data-testid="task-selection-outside">선택한 작업은 {{visible.some(row=>row.task.id===state.selected)?'다른 페이지':'현재 필터 밖'}}에 있습니다. 상세는 선택한 작업을 유지합니다.<Button v-if="visible.some(row=>row.task.id===state.selected)" label="선택 작업 페이지 보기" text @click="reveal(state.selected)"/></p>
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
  <Dialog v-model:visible="summaryOpen" modal header="선택 태스크 수동 AI 요약" :style="{width:'min(780px,94vw)'}"><p>현재 프로젝트의 요약 선택 범위를 {{selected?.task.id}} 하나로 지정했습니다. 실제 모델 호출은 아래 전송 확인 후에만 실행됩니다.</p><ProjectModelReview v-if="selected&&summaryOpen" :key="selected.task.id+':'+dag?.summaryScope?.sourceHash" :inline-controls="true" :workstream-id="workstream.id" :workstream-title="workstream.title" :summary-prefix="dag?.summaryScope?.selected" :current="current&&dag?.summaryScope?.taskSelection.taskIds.length===1&&dag.summaryScope.taskSelection.taskIds[0]===selected.task.id"/></Dialog>
 </section>
</template>
