<script setup lang="ts">
import {computed} from 'vue';
import type {LiveDagView} from '../../shared/live';
import {formatTime,liveState} from '../store';
import LiveSummary from './LiveSummary.vue';
import {diagnosticText} from '../live-labels';
const props=defineProps<{dag:LiveDagView;expanded?:boolean;showSummary?:boolean}>();
const historical=computed(()=>props.dag.state!=='ready'||liveState.value?.connection!=='connected'||liveState.value?.freshness!=='current');
const e2eLabels={undeclared:'선언 없음','not-required':'불필요로 선언',unmet:'필수 참조 누락','references-declared':'참조 선언 있음',malformed:'선언 형식 오류'};
</script>
<template>
  <section class="live-dag" data-testid="live-dag">
    <div class="section-heading"><h3>DAG 선언</h3><span class="state-badge" :class="{safe:dag.state==='ready'}">{{dag.state==='ready'?'읽기 성공':dag.state==='error'?'조회 오류':'사용 불가'}}</span></div>
    <p v-if="dag.reason" class="muted" :class="{'warning-text':dag.state==='error'}">{{diagnosticText(dag.reason)}}</p>
    <LiveSummary v-if="showSummary!==false" :summary="dag.summary" :historical="historical"/>
    <template v-if="dag.state==='ready'||dag.tasks.length">
      <p v-if="dag.state!=='ready'" class="notice warning">이전 DAG 관측 유지 · 아래 선언은 현재 상태로 재확인되지 않았습니다</p>
      <div class="dag-counts"><span v-for="(item,index) in dag.statusCounts" :key="index" class="status-count">{{item.status??'상태 미선언'}} <strong>{{item.count}}</strong></span><span v-if="!dag.statusCounts.length" class="muted">선언된 상태 집계 없음</span></div>
      <p v-if="dag.statusCountsOmitted" class="muted">전체 상태 범주 {{dag.statusCountTotal}}개 중 {{dag.statusCounts.length}}개 표시 · {{dag.statusCountsOmitted}}개 생략</p>
      <p class="muted">{{dag.summaryScope?dag.summaryScope.selected+' 접두사':'전체'}} {{dag.taskCount===null?'작업 수 미확인':dag.taskCount+'개 작업'}} · 표시 {{dag.displayedTaskCount}}개{{dag.taskCount!==null&&dag.displayedTaskCount<dag.taskCount?' (표시 상한 적용)':''}}<span v-if="dag.unchanged"> · 내용 변경 없음</span></p>
      <p v-if="dag.observedAt" class="muted">관측 {{formatTime(dag.observedAt)}}</p>
      <details class="task-details" data-testid="dag-task-details" :open="expanded"><summary>선언된 작업 상세 {{dag.displayedTaskCount}}개</summary>
        <p v-if="!dag.tasks.length" class="muted">{{dag.summaryScope?dag.summaryScope.selected+' 접두사의 작업이 없습니다. 다른 접두사를 직접 선택해 주세요.':'이 DAG에서 관측한 작업이 없습니다'}}</p>
        <ol v-else class="dag-task-list"><li v-for="task in dag.tasks" :key="task.id"><div class="task-heading"><strong>{{task.id}} · {{task.title??'제목 미선언'}}</strong><span class="claim-tag">{{task.status??'상태 미선언'}}</span></div><p>의존성: <template v-if="task.dependencies.length"><span v-for="(dependency,index) in task.dependencies" :key="index">{{index?', ':''}}{{dependency.id}} ({{dependency.scope==='external'?'외부 · 충족 미확인':'DAG 내부'}})</span><span v-if="task.displayOmissions.dependencies"> · 추가 {{task.displayOmissions.dependencies}}개 생략</span></template><span v-else>선언 없음</span></p><p>E2E: {{e2eLabels[task.e2e.coverage]}}<span v-if="task.e2e.coveredBy?.length"> · {{task.e2e.coveredBy.join(', ')}}</span><span v-if="task.displayOmissions.e2eReferences"> · 추가 참조 {{task.displayOmissions.e2eReferences}}개 생략</span></p><p>커밋 참조: {{task.commitReferences.length?task.commitReferences.join(', '):task.commitReferencesUnsupported?'미확인':'선언 없음'}}<span v-if="task.commitReferencesUnsupported"> · 형식 미지원 {{task.commitReferencesUnsupported}}개 미확인</span><span v-if="task.displayOmissions.commitReferences"> · 추가 {{task.displayOmissions.commitReferences}}개 생략</span> · 검증하지 않음</p></li></ol>
      </details>
    </template>
    <p class="scope-note">DAG 상태는 원문 선언입니다. 테스트 통과·배포 완료·에이전트 실행 상태를 추론하지 않습니다.</p>
  </section>
</template>
