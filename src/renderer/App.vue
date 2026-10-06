<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { initialize, dispose, snapshot, mode, liveState, environment } from './store';
const route=useRoute();
onMounted(initialize);
onUnmounted(dispose);
</script>
<template>
  <div class="app-shell">
    <header class="app-header"><RouterLink to="/" class="brand"><span class="brand-mark">n</span><span>note-app<span class="brand-sub">PROJECT WORKSPACE</span></span></RouterLink>
      <nav aria-label="주 메뉴"><RouterLink to="/" data-testid="nav-overview" :class="{active:route.path!=='/settings'&&route.path!=='/usage'}">프로젝트 현황</RouterLink><RouterLink to="/usage" data-testid="nav-usage" :class="{active:route.path==='/usage'}">사용량 통계</RouterLink><RouterLink to="/settings" data-testid="nav-settings" :class="{active:route.path==='/settings'}">연결 및 설정</RouterLink></nav>
      <span class="local-badge"><span class="status-dot"></span>{{mode==='demo'?(snapshot?.freshness==='stale'?'가상 데이터 · 갱신 실패':'가상 데이터'):liveState?.connection==='connected'?'실제 소스 관측':'로컬 전용'}}</span>
    </header>
    <main class="main-content"><RouterView /></main>
    <footer class="app-footer"><span>내 작업의 맥락을 한 곳에서</span><span>{{mode==='demo'?'샘플 모드 · 실제 프로젝트 정보가 아닙니다':liveState?.connection==='connected'?'읽기 전용 소스 관측 · Claude AI는 프로젝트별 수동 전송':'데이터 소스 미연결'}} · v0.1.0<span v-if="environment?.buildSha"> · 빌드 {{environment.buildNumber??''}} / {{environment.buildSha.slice(0,7)}}</span></span><details v-if="environment?.installationPath" class="installation-info" data-testid="app-installation-info"><summary>앱 정보 · {{environment.installationRole==='verification'?'격리 검증 앱':environment.installationRole==='user'?'사용자 설치 앱':'개발 실행'}}</summary><p>실제 경로: {{environment.installationPath}}</p><p>사용자 설치 경로: {{environment.canonicalInstallationPath}}</p></details></footer>
  </div>
</template>
