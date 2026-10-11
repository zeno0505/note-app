<script setup lang="ts">
import type {LiveWorkstreamView} from '../../shared/live';
import {branchLabel,projectLabel} from '../live-labels';
defineProps<{workstream:LiveWorkstreamView;selected:boolean}>();
</script>
<template>
  <li class="project-list-item" data-testid="project-list-item">
    <RouterLink class="project-select" :class="{selected}" :to="{path:'/',query:{project:workstream.id}}" :aria-current="selected?'true':undefined" aria-controls="project-summary-pane">
      <div class="project-row-heading"><strong>{{workstream.title}}</strong><span aria-hidden="true">→</span></div>
      <div class="project-row-identity"><span>{{workstream.repository?.label??projectLabel(workstream)}}</span><span class="project-row-branch" :title="branchLabel(workstream.branch)">{{branchLabel(workstream.branch)}}</span></div>
      <div class="project-row-status"><span v-if="workstream.project">{{workstream.project.status==='completed'?'사용자 완료':'진행 중'}}</span><span>{{workstream.observation?.worktree==='not-observed'?'현재 미관측 · 보존':workstream.observation?.sidebarActivity===true?'활동 관측':workstream.observation?.sidebarActivity===false?'활동 미관측':'활동 미확인'}}</span><span>{{workstream.noteMapping.state==='resolved'?'노트 연결':'노트 미확인'}}</span></div>
    </RouterLink>
  </li>
</template>
