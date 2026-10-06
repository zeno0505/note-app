<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import WorkstreamCard from '../components/WorkstreamCard.vue';
import FreshnessNotice from '../components/FreshnessNotice.vue';
import LiveOverview from '../components/LiveOverview.vue';
import {mode,liveState,livePending,refreshLive,summarizeNow,disconnectLive,exitDemo,snapshot,busy,bridgeError,filter,scenario,search,workstreams,connectedCount,visibleWorkstreams,refreshDemo,formatTime} from '../store';
</script>
<template>
  <div class="page-heading"><div><p class="eyebrow">PROJECT OVERVIEW</p><h1>작업의 흐름을 한눈에</h1><p class="page-subtitle">어디까지 왔는지, 무엇이 남았는지, 지금 판단할 일을 살펴보세요</p></div><div class="heading-actions"><Button v-if="mode==='demo'" label="샘플 모드 종료" outlined @click="exitDemo"/><Button v-if="snapshot" label="새로고침" outlined :loading="busy" @click="refreshDemo"/><template v-if="mode==='live'&&liveState?.connection==='connected'"><Button label="실제 소스 새로고침" data-testid="live-refresh" outlined :loading="livePending" @click="refreshLive"/><Button label="규칙 요약 갱신 · 전체 소스" title="연결된 전체 소스를 다시 읽는 규칙 기반 설명입니다. Claude AI는 프로젝트별 수동 버튼에서 실행합니다." data-testid="reading-summary-now" :loading="livePending" :disabled="busy" @click="summarizeNow"/><Button label="연결 해제" data-testid="live-disconnect" outlined :disabled="busy" @click="disconnectLive"/></template></div></div>
  <div v-if="bridgeError" role="alert" class="notice error">{{bridgeError}}</div>
  <LiveOverview v-if="mode==='live'"/>
  <section v-else-if="!snapshot" class="empty-state"><h2>{{busy?'샘플을 불러오는 중입니다':'샘플을 불러오지 못했어요'}}</h2><p>불러오기에 실패했다면 다시 시도해 주세요.</p><Button label="샘플로 살펴보기" :loading="busy" @click="refreshDemo"/></section>
  <template v-else>
    <div class="notice demo"><strong>가상 프로젝트 샘플</strong><span>직접 작성한 예시입니다. 실제 Orca 조회·AI 요약·개발 위임은 실행되지 않습니다.</span></div>
    <FreshnessNotice />
    <div class="overview-toolbar"><div class="filter-group" aria-label="워크스트림 표시 범위"><button :class="{selected:filter==='connected'}" :aria-pressed="filter==='connected'" @click="filter='connected'">터미널 연결 <span>{{connectedCount}}</span></button><button :class="{selected:filter==='all'}" :aria-pressed="filter==='all'" @click="filter='all'">전체 비보관 <span>{{workstreams.length}}</span></button></div><InputText v-model="search" placeholder="작업 이름으로 찾기" aria-label="작업 검색" /></div>
    <div class="observation"><span>{{visibleWorkstreams.length}}개 워크스트림 · 저장소가 아닌 작업 단위</span><span>샘플 관측 {{formatTime(snapshot.observedAt)}}</span></div>
    <div v-if="visibleWorkstreams.length" class="workstream-grid"><WorkstreamCard v-for="workstream in visibleWorkstreams" :key="workstream.id" :workstream="workstream"/></div>
    <section v-else class="empty-state"><h2>{{search?'검색 결과가 없어요':filter==='connected'&&workstreams.length?'터미널이 연결된 작업이 없어요':'확인된 비보관 작업이 없어요'}}</h2><p>{{search?'다른 이름으로 검색하거나 검색어를 지워 주세요.':'이 샘플 범위에서만 확인한 결과입니다.'}}</p><Button v-if="search" label="검색어 지우기" outlined @click="search=''"/><Button v-else-if="filter==='connected'&&workstreams.length" label="전체 비보관 보기" outlined @click="filter='all'"/></section>
    <p class="scope-note">터미널 연결은 에이전트 작업 중을 뜻하지 않습니다. 기록된 완료는 검증·배포 완료와 구분합니다.</p>
    <details class="demo-controls"><summary>샘플 검증 옵션</summary><label for="scenario">데이터 상태</label><select id="scenario" v-model="scenario"><option value="normal">정상 예시</option><option value="failure">갱신 실패 예시</option><option value="empty">빈 결과 예시</option></select><Button label="선택한 예시 적용" size="small" outlined :loading="busy" @click="refreshDemo" /></details>
  </template>
</template>
