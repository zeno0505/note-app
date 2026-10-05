<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { initialize, dispose, snapshot, mode, liveState } from './store';
const route=useRoute();
onMounted(initialize);
onUnmounted(dispose);
</script>
<template>
  <div class="app-shell">
    <header class="app-header"><RouterLink to="/" class="brand"><span class="brand-mark">n</span><span>note-app<span class="brand-sub">PROJECT WORKSPACE</span></span></RouterLink>
      <nav aria-label="주 메뉴"><RouterLink to="/" :class="{active:route.path!=='/settings'}">프로젝트 현황</RouterLink><RouterLink to="/settings" :class="{active:route.path==='/settings'}">연결 및 설정</RouterLink></nav>
      <span class="local-badge"><span class="status-dot"></span>{{mode==='demo'?(snapshot?.freshness==='stale'?'가상 데이터 · 갱신 실패':'가상 데이터'):liveState?.connection==='connected'?'실제 소스 관측':'로컬 전용'}}</span>
    </header>
    <main class="main-content"><RouterView /></main>
    <footer class="app-footer"><span>내 작업의 맥락을 한 곳에서</span><span>{{mode==='demo'?'샘플 모드 · 실제 프로젝트 정보가 아닙니다':liveState?.connection==='connected'?'읽기 전용 소스 관측 · 로컬 변경은 별도 확인 · 모델 호출 없음':'데이터 소스 미연결'}} · v0.1.0</span></footer>
  </div>
</template>
