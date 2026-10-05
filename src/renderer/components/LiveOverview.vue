<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import {computed,ref,watch} from 'vue';
import {environment,liveState,livePending,filter,search,liveWorkstreams,liveConnectedCount,visibleLiveWorkstreams,connectLive,refreshDemo,busy} from '../store';
import LiveWorkstreamCard from './LiveWorkstreamCard.vue';
import LiveStatus from './LiveStatus.vue';
import LiveDag from './LiveDag.vue';
import LiveCodeBurn from './LiveCodeBurn.vue';
import {configurationLabels} from '../live-labels';
const visibleLimit=ref(40);
watch([filter,search],()=>{visibleLimit.value=40;});
const shownWorkstreams=computed(()=>visibleLiveWorkstreams.value.slice(0,visibleLimit.value));
const ready=computed(()=>liveState.value?.configuration.state==='ready');
const connected=computed(()=>liveState.value?.connection==='connected');
const dagById=computed(()=>new Map(liveState.value?.dags.map(dag=>[dag.dagId,dag])??[]));
const unlinkedDags=computed(()=>liveState.value?.dags.filter(dag=>!liveState.value?.workstreams.some(workstream=>workstream.noteMapping.dagId===dag.dagId))??[]);
const observed=computed(()=>liveState.value?.observedAt!==null&&liveState.value?.observedAt!==undefined);
</script>
<template>
  <LiveStatus v-if="connected||observed||liveState?.lastError"/>
  <section v-if="!connected&&!observed" class="welcome-panel">
    <div class="welcome-icon">↗</div><p class="eyebrow">로컬 소스 관측 작업 공간</p><h2>아직 연결된 데이터가 없어요</h2>
    <p v-if="ready">설정된 Orca와 명시된 노트 범위만 읽습니다.<br>연결하면 실제 작업과 DAG 선언을 확인할 수 있어요.</p>
    <p v-else-if="liveState?.configuration.state==='invalid'">시작 설정을 사용할 수 없습니다.<br>연결 및 설정에서 오류와 준비 방법을 확인해 주세요.</p>
    <p v-else>실제 소스를 사용하려면 시작 설정 파일이 필요합니다.<br>가상의 세 작업으로 화면의 흐름을 먼저 살펴볼 수도 있어요.</p>
    <div class="welcome-actions"><Button v-if="ready" label="설정된 소스 연결" data-testid="live-connect" :loading="livePending" :disabled="busy" @click="connectLive"/><Button label="샘플로 살펴보기" :outlined="ready" :loading="busy" @click="refreshDemo"/></div>
    <RouterLink to="/settings" class="subtle-link">연결 상태 확인{{liveState?' · '+configurationLabels[liveState.configuration.state]:''}}</RouterLink><div class="welcome-note">{{environment?.capabilities.noteWrites?'노트 연결은 별도 미리보기·확인 후 적용':'노트 연결 변경 미설정'}} · 실제 요약 생성 차단 · 모델 호출 없음</div>
  </section>
  <template v-else>
    <div v-if="!connected" class="notice warning"><strong>연결 해제됨</strong><span>보관된 마지막 관측입니다. 연결하기 전까지 갱신되지 않습니다.</span><Button v-if="ready" label="설정된 소스 연결" data-testid="live-connect" size="small" :loading="livePending" @click="connectLive"/></div>
    <div class="overview-toolbar"><div class="filter-group" aria-label="실제 워크스트림 표시 범위"><button :class="{selected:filter==='connected'}" :aria-pressed="filter==='connected'" @click="filter='connected'">터미널 연결 <span>{{liveConnectedCount}}</span></button><button :class="{selected:filter==='all'}" :aria-pressed="filter==='all'" @click="filter='all'">전체 비보관·미확인 <span>{{liveWorkstreams.length}}</span></button></div><InputText v-model="search" placeholder="작업·프로젝트·브랜치 찾기" aria-label="작업 검색"/></div>
    <div class="observation"><span>{{visibleLiveWorkstreams.length}}개 중 {{shownWorkstreams.length}}개 표시 · 보관 상태 미확인 포함</span><span>워크트리별 관측 · 같은 DAG는 동일 근거를 공유</span></div>
    <div v-if="visibleLiveWorkstreams.length" class="workstream-grid"><LiveWorkstreamCard v-for="workstream in shownWorkstreams" :key="workstream.id" :workstream="workstream" :dag="workstream.noteMapping.dagId?dagById.get(workstream.noteMapping.dagId):undefined"/></div>
    <section v-else class="empty-state" data-testid="live-empty"><h2>{{search?'검색 결과가 없어요':liveState?.refreshing&&!observed?'실제 소스를 확인하고 있어요':!observed&&liveState?.lastError?'조회에 실패해 작업을 표시할 수 없어요':filter==='connected'&&liveWorkstreams.length?'터미널이 연결된 작업이 없어요':observed?'관측 범위에 표시할 작업이 없어요':'아직 작업 관측이 없습니다'}}</h2><p>{{search?'다른 이름으로 검색하거나 검색어를 지워 주세요.':observed?'확인된 관측 범위의 결과입니다. 부분 관측이나 미확인 범위에는 다른 작업이 있을 수 있습니다.':'조회 실패나 미확인은 작업이 없다는 뜻이 아닙니다.'}}</p><Button v-if="search" label="검색어 지우기" outlined @click="search=''"/><Button v-else-if="filter==='connected'&&liveWorkstreams.length" label="전체 비보관 보기" outlined @click="filter='all'"/></section>
    <div v-if="visibleLiveWorkstreams.length>shownWorkstreams.length" class="show-more"><Button :label="'작업 더 보기 ('+(visibleLiveWorkstreams.length-shownWorkstreams.length)+'개 남음)'" outlined @click="visibleLimit+=40"/></div>
    <section v-if="unlinkedDags.length" class="retained-dags"><h2>연결이 재확인되지 않은 이전 DAG</h2><p class="muted">현재 워크스트림과의 연결을 추측하지 않습니다. 마지막으로 읽은 선언과 저장 요약을 별도로 유지합니다.</p><details v-for="dag in unlinkedDags" :key="dag.dagId" class="retained-dag"><summary>{{dag.dagId}} · 이전 관측</summary><LiveDag :dag="dag"/></details></section>
    <LiveCodeBurn v-if="liveState" :codeburn="liveState.codeburn" :stale="!connected"/>
  </template>
</template>
