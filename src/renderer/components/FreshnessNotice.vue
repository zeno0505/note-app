<script setup lang="ts">
import {snapshot,formatTime} from '../store';
</script>
<template><div v-if="snapshot?.freshness==='stale'" role="alert" class="notice warning freshness-notice"><strong>갱신 실패 · 이전 내용 유지</strong><div><p>{{snapshot.lastAttempt.reason}}</p><p class="attempt-time">마지막 성공 {{formatTime(snapshot.observedAt)}} · 실패한 시도 {{formatTime(snapshot.lastAttempt.observedAt)}}</p></div></div></template>
