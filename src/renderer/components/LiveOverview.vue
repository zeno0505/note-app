<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import {computed,ref,watch,nextTick,onUnmounted} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {createProjectSelection} from '../project-selection';
import ProjectListItem from './ProjectListItem.vue';
import {isApprovedPublicPreview} from '../public-model-preview';
import {environment,liveState,livePending,search,liveWorkstreams,liveScope,liveScopeCounts,repositoryFilter,repositoryOptions,visibleLiveWorkstreams,projectFilter,connectLive,refreshDemo,busy} from '../store';
import LiveWorkstreamCard from './LiveWorkstreamCard.vue';
import LiveStatus from './LiveStatus.vue';
import LiveDag from './LiveDag.vue';
import {configurationLabels,isCancelledObservation} from '../live-labels';
const visibleLimit=ref(40);
const route=useRoute(),router=useRouter();
const selection=createProjectSelection(route,router,visibleLiveWorkstreams);
const selected=selection.selected,selectionNotice=selection.notice;
const summaryHeading=ref<HTMLElement|null>(null);
onUnmounted(selection.dispose);
watch(selection.selectedId,async id=>{if(!id)return;const index=visibleLiveWorkstreams.value.findIndex(w=>w.id===id);if(index>=visibleLimit.value)visibleLimit.value=Math.ceil((index+1)/40)*40;await nextTick();if(selection.selectedId.value===id&&selected.value){summaryHeading.value?.focus();if(typeof window!=='undefined'&&window.innerWidth<900)summaryHeading.value?.scrollIntoView({block:'start'});}},{immediate:true});
function listKeyboard(event:KeyboardEvent){if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;const links=Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLAnchorElement>('a.project-select'));const current=links.indexOf((event.target as HTMLElement).closest('a.project-select') as HTMLAnchorElement);if(current<0)return;event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?links.length-1:event.key==='ArrowDown'?Math.min(current+1,links.length-1):Math.max(current-1,0);links[index]?.focus();}
async function closeSelection(){const id=selection.selectedId.value;await selection.close();await nextTick();Array.from(document.querySelectorAll<HTMLAnchorElement>('a.project-select')).find(link=>link.getAttribute('href')?.includes(encodeURIComponent(id??'')))?.focus();}
watch([liveScope,projectFilter,repositoryFilter,search],()=>{const index=visibleLiveWorkstreams.value.findIndex(w=>w.id===selection.selectedId.value);visibleLimit.value=index>=40?Math.ceil((index+1)/40)*40:40;});
const shownWorkstreams=computed(()=>visibleLiveWorkstreams.value.slice(0,visibleLimit.value));
const ready=computed(()=>liveState.value?.configuration.state==='ready');
const connected=computed(()=>liveState.value?.connection==='connected');
const dagById=computed(()=>new Map(liveState.value?.dags.map(dag=>[dag.dagId,dag])??[]));
const unlinkedDags=computed(()=>liveState.value?.dags.filter(dag=>!liveState.value?.workstreams.some(workstream=>workstream.noteMapping.dagId===dag.dagId))??[]);
const observed=computed(()=>liveState.value?.observedAt!==null&&liveState.value?.observedAt!==undefined);
const initialCancelled=computed(()=>!observed.value&&isCancelledObservation(liveState.value?.lastError));
const publicWorkstream=computed(()=>liveState.value?.workstreams.find(w=>w.project&&isApprovedPublicPreview(w))??liveState.value?.workstreams.find(isApprovedPublicPreview));
async function openPublicPreview(){const workstream=publicWorkstream.value;if(!workstream)return;await router.replace({path:'/',query:{...route.query,project:undefined}});liveScope.value=workstream.project?'retained':'observed';projectFilter.value='all';repositoryFilter.value='all';search.value='';await nextTick();await router.push({path:'/',query:{...route.query,project:workstream.id}});}
</script>
<template>
  <LiveStatus v-if="connected||observed||liveState?.lastError"/>
  <section v-if="!connected&&!observed" class="welcome-panel">
    <div class="welcome-icon">↗</div><p class="eyebrow">로컬 소스 관측 작업 공간</p><h2>아직 연결된 데이터가 없어요</h2>
    <p v-if="ready">설정된 Orca와 명시된 노트 범위만 읽습니다.<br>연결하면 실제 작업과 DAG 선언을 확인할 수 있어요.</p>
    <p v-else-if="liveState?.configuration.state==='invalid'">시작 설정을 사용할 수 없습니다.<br>연결 및 설정에서 오류와 준비 방법을 확인해 주세요.</p>
    <p v-else>실제 소스를 사용하려면 시작 설정 파일이 필요합니다.<br>가상의 세 작업으로 화면의 흐름을 먼저 살펴볼 수도 있어요.</p>
    <div class="welcome-actions"><Button v-if="ready" label="설정된 소스 연결" data-testid="live-connect" :loading="livePending" :disabled="busy" @click="connectLive"/><Button label="샘플로 살펴보기" :outlined="ready" :loading="busy" @click="refreshDemo"/></div>
    <RouterLink to="/settings" class="subtle-link">연결 상태 확인{{liveState?' · '+configurationLabels[liveState.configuration.state]:''}}</RouterLink><div class="welcome-note">{{environment?.capabilities.noteWrites?'노트 연결은 별도 미리보기·확인 후 적용':'노트 연결 변경 미설정'}} · 프로젝트 연결 후 수동 Claude AI 사용 가능 · 화면 조회만으로 모델 호출 없음</div>
  </section>
  <template v-else>
    <div v-if="!connected" class="notice warning"><strong>연결 해제됨</strong><span>보관된 마지막 관측입니다. 연결하기 전까지 갱신되지 않습니다.</span><Button v-if="ready" label="설정된 소스 연결" data-testid="live-connect" size="small" :loading="livePending" @click="connectLive"/></div>
    <div v-if="liveWorkstreams.some(w=>w.project)" class="filter-group" aria-label="프로젝트 상태"><button v-for="state in (['active','completed','all'] as const)" :key="state" :aria-pressed="projectFilter===state" :class="{selected:projectFilter===state}" @click="projectFilter=state">{{state==='active'?'진행 중':state==='completed'?'완료':'전체 프로젝트'}}</button></div><div v-if="observed" class="overview-toolbar"><div class="filter-group" aria-label="실제 워크스트림 표시 범위"><button v-for="scope in (['activity','observed','retained'] as const)" :key="scope" :class="{selected:liveScope===scope}" :aria-pressed="liveScope===scope" @click="liveScope=scope">{{scope==='activity'?'활동 관측':scope==='observed'?'현재 관측':'보존 프로젝트'}} <span>{{liveScopeCounts[scope]}}</span></button></div><label class="repository-filter">저장소 <select v-model="repositoryFilter" aria-label="저장소 필터"><option value="all">전체 저장소</option><option v-for="repo in repositoryOptions" :key="repo.key" :value="repo.key">{{repo.label}}</option></select></label><InputText v-model="search" placeholder="작업·프로젝트·브랜치 찾기" aria-label="작업 검색"/></div>
    <div v-if="observed" class="observation"><span>{{visibleLiveWorkstreams.length}}개 중 {{shownWorkstreams.length}}개 표시</span><span>활동은 터미널·브라우저·에이전트 등의 관측이며 실행 가능 여부와 별개</span></div>
    <div v-if="publicWorkstream" class="show-more"><Button label="공개 note-app 저장 요약 보기" outlined size="small" data-testid="public-model-shortcut" @click="openPublicPreview"/></div>
    <p v-if="selectionNotice" class="selection-notice" role="status">{{selectionNotice}}</p>
    <div v-if="visibleLiveWorkstreams.length" class="project-browser" :class="{'has-selection':!!selected}" data-testid="project-browser">
      <section class="project-list-pane" aria-labelledby="project-list-heading"><h2 id="project-list-heading">프로젝트 목록</h2><p v-if="!selected" class="muted">프로젝트를 선택하면 요약과 작업 버튼을 확인할 수 있습니다.</p><ul class="project-list" @keydown="listKeyboard"><ProjectListItem v-for="workstream in shownWorkstreams" :key="workstream.id" :workstream="workstream" :selected="selected?.id===workstream.id"/></ul><div v-if="visibleLiveWorkstreams.length>shownWorkstreams.length" class="show-more"><Button :label="'작업 더 보기 ('+(visibleLiveWorkstreams.length-shownWorkstreams.length)+'개 남음)'" outlined @click="visibleLimit+=40"/></div></section>
      <section v-if="selected" id="project-summary-pane" class="project-summary-pane" aria-labelledby="project-summary-heading" data-testid="project-summary-pane"><div class="project-summary-heading"><h2 ref="summaryHeading" id="project-summary-heading" tabindex="-1">선택한 프로젝트 요약</h2><Button label="목록으로" outlined size="small" @click="closeSelection"/></div><LiveWorkstreamCard :key="selected.id" :workstream="selected" :dag="selected.noteMapping.dagId?dagById.get(selected.noteMapping.dagId):undefined"/></section>
    </div>
    <section v-else class="empty-state" data-testid="live-empty"><h2>{{search?'검색 결과가 없어요':liveState?.refreshing&&!observed?'실제 소스를 확인하고 있어요':initialCancelled?'관측이 중단되어 아직 작업을 확인하지 못했어요':!observed&&liveState?.lastError?'조회에 실패해 작업을 표시할 수 없어요':liveScope==='activity'&&liveWorkstreams.length?'현재 활동이 관측된 작업이 없어요':observed?'관측 범위에 표시할 작업이 없어요':'아직 작업 관측이 없습니다'}}</h2><p>{{search?'다른 이름으로 검색하거나 검색어를 지워 주세요.':observed?'확인된 관측 범위의 결과입니다. 부분 관측이나 미확인 범위에는 다른 작업이 있을 수 있습니다.':'조회 실패나 미확인은 작업이 없다는 뜻이 아닙니다.'}}</p><Button v-if="search" label="검색어 지우기" outlined @click="search=''"/><Button v-else-if="liveScope==='activity'&&liveWorkstreams.length" label="현재 관측 보기" outlined @click="liveScope='observed'"/></section>
    <section v-if="unlinkedDags.length" class="retained-dags"><h2>연결이 재확인되지 않은 이전 DAG</h2><p class="muted">현재 워크스트림과의 연결을 추측하지 않습니다. 마지막으로 읽은 선언과 저장 요약을 별도로 유지합니다.</p><details v-for="dag in unlinkedDags" :key="dag.dagId" class="retained-dag"><summary>{{dag.dagId}} · 이전 관측</summary><LiveDag :dag="dag"/></details></section>
  </template>
</template>
