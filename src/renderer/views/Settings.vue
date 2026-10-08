<script setup lang="ts">
import Button from 'primevue/button';
import InfoDialog from '../components/InfoDialog.vue';
import {useRouter} from 'vue-router';
import {environment,mode,liveState,livePending,busy,bridgeError,exitDemo,refreshDemo,connectLive,disconnectLive,refreshLive} from '../store';
import {configurationLabels} from '../live-labels';
import ReadRootsSettings from '../components/ReadRootsSettings.vue';
import LiveCodeBurn from '../components/LiveCodeBurn.vue';
import PublicModelReview from '../components/PublicModelReview.vue';
const router=useRouter();
function stopDemo(){exitDemo();void router.push('/');}
</script>
<template>
  <div class="page-heading"><div><p class="eyebrow">CONNECTIONS</p><h1>연결 및 설정</h1><p class="page-subtitle">이 앱이 어떤 정보를 쓰는지 명확하게</p></div></div>
  <div v-if="bridgeError" role="alert" class="notice error">{{bridgeError}}</div>
  <section class="settings-panel" data-testid="live-configuration">
    <div class="setting-row"><div><h2>Orca와 프로젝트 노트</h2><p>{{liveState?.configuration.message??'시작 설정 확인 중입니다'}}</p><p>설정 가능 여부와 실제 연결 상태는 별개입니다. 앱을 열기만 해서는 수집을 시작하지 않습니다.</p></div><span class="state-badge" :class="{safe:liveState?.configuration.state==='ready'}">{{liveState?configurationLabels[liveState.configuration.state]:'확인 중'}}</span></div>
    <div class="configuration-details"><div class="compact-help"><strong>실제 연결: {{liveState?.connection==='connected'?'연결됨':'미연결'}}</strong><InfoDialog label="실행 파일과 연결 설정 상세"><dl class="configuration-list"><div><dt>Orca 실행 파일</dt><dd>{{liveState?.configuration.orcaExecutable??'미설정'}}</dd></div><div><dt>CodeBurn 실행 파일 (선택)</dt><dd>{{liveState?.configuration.codeburnExecutable??'미설정'}}</dd></div><div><dt>허용된 노트 범위</dt><dd>{{liveState?liveState.configuration.noteScopeCount+'개':'미확인'}}</dd></div><div><dt>DAG query.py</dt><dd>{{liveState?(liveState.configuration.dagQueryConfigured?'설정됨':'미설정'):'미확인'}}</dd></div><div><dt>실제 연결</dt><dd>{{liveState?.connection==='connected'?'연결됨':liveState?'미연결':'미확인'}}{{liveState?.refreshing?' · 확인 중':''}}</dd></div></dl></InfoDialog></div>
      <div class="setting-actions" v-if="mode==='live'"><Button v-if="liveState?.configuration.state==='ready'&&liveState.connection==='disconnected'" label="설정된 소스 연결" data-testid="live-connect" :loading="livePending" :disabled="busy" @click="connectLive"/><template v-if="liveState?.connection==='connected'"><Button label="실제 소스 새로고침" data-testid="live-refresh" outlined :loading="livePending" @click="refreshLive"/><Button label="연결 해제" data-testid="live-disconnect" outlined :disabled="busy" @click="disconnectLive"/></template></div>
    </div>
    <ReadRootsSettings v-if="mode==='live'"/>
    <details v-if="mode==='live'" class="setting-detail"><summary>기존 후보 요약과 승인 기록</summary><PublicModelReview/></details>
    <details class="setting-detail"><summary>시작 설정 파일</summary><div><p>로컬 JSON 설정 파일의 절대 경로를 NOTE_APP_CONFIG 환경 변수로 지정한 뒤 앱을 다시 시작하세요. 설정 스키마와 실행 예시는 저장소 docs/live-configuration.md를 참고하세요.</p><p>실행 파일 경로와 노트 연결 쓰기 설정은 시작 파일에서 정합니다. 노트 읽기 허용 폴더는 위 선택·확인 절차로 앱에 저장할 수 있습니다.</p></div></details>
    <div class="setting-row"><div><h2>요약 백엔드</h2><p>프로젝트 화면의 지금 요약 · Claude AI는 현재 연결된 프로젝트의 수동 모델 요약입니다. 기존 작업별 후보 검토·승인 워크플로의 새 모델 전송은 별도로 차단되어 있습니다. 이전 승인 기록은 보존됩니다.</p></div><span class="state-badge">프로젝트 수동 AI · 후보 워크플로 별도</span></div>
    <div class="setting-row"><div><h2>데이터 처리 범위</h2><p>소스 연결은 설정된 CLI와 명시된 노트·DAG를 읽기 전용으로 관측합니다. 요약 승인은 로컬 검토 기록이며 작업 실행 권한이 아닙니다. Claude 전송은 프로젝트별 수동 AI 버튼에서만 수행합니다. 자동 모델 호출과 개발 위임은 활성화하지 않습니다. 샘플 모드로 전환하면 실제 소스 수집을 중단합니다.</p></div><span class="state-badge safe">소스 관측은 읽기 전용</span></div>
    <div class="setting-row"><div><h2>로컬 노트 연결</h2><p>{{environment?.capabilities.noteWrites?'등록된 범위만 선택할 수 있습니다. 작업 상세에서 경로·공유 Git 로컬 제외 변경을 미리 본 뒤, 명시적으로 확인해야 적용됩니다.':'시작 설정에서 노트 연결 변경이 활성화되지 않았습니다. 임의의 파일 경로를 입력하거나 변경하지 않습니다.'}}</p><p>노트 내용은 편집하지 않습니다. 연결·제외 파일 변경 결과와 필요한 복구 안내를 각각 표시합니다.</p></div><span class="state-badge">{{environment?.capabilities.noteWrites?'미리보기 후 확인 필요':'변경 미설정'}}</span></div>
    <div class="setting-row"><div><h2>실행 환경</h2><p>{{environment?.platform??'확인 중'}} · {{environment?.version??'—'}}<span v-if="environment?.buildSha"> · 빌드 {{environment.buildSha.slice(0,7)}}</span> · macOS 네이티브·최종 패키지 검증은 별도입니다</p></div></div>
    <div class="setting-actions"><Button v-if="mode==='demo'" label="샘플 모드 종료" outlined @click="stopDemo"/><Button v-else label="샘플로 살펴보기" outlined :loading="busy" @click="refreshDemo().then(()=>{if(mode==='demo')router.push('/')})"/></div>
  </section>
  <LiveCodeBurn v-if="mode==='live'&&liveState" :codeburn="liveState.codeburn" :stale="liveState.connection!=='connected'"/>
</template>
