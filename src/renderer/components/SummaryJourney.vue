<script setup lang="ts">
import {computed,inject,onMounted,onUnmounted,ref,watch} from 'vue';
import type {LiveDagView} from '../../shared/live';
import type {SummaryProviderChoice,SummaryWorkflowState,SummaryPersistenceState} from '../../shared/summary-workflow';
import {createSummaryActions,boundedTaskSelection,MAX_SUMMARY_TASKS,summaryActionsKey} from '../phase1-actions';
import {formatTime} from '../store';
import LiveClaimList from './LiveClaimList.vue';
import LiveSummary from './LiveSummary.vue';
import LiveCodeBurn from './LiveCodeBurn.vue';
const props=defineProps<{workstreamId:string;dag:LiveDagView;current:boolean}>();
const actions=inject(summaryActionsKey,undefined)??createSummaryActions(typeof window==='undefined'?undefined:window.noteApp);
const {view,busy,error,technicalError}=actions;
const selected=ref<string[]>([]);
const provider=ref<SummaryProviderChoice>('auto');
const available=computed(()=>props.current&&props.dag.state==='ready');
const selectedCount=computed(()=>selected.value.length);
const candidateApproved=computed(()=>!!view.value?.candidateHash&&view.value.candidateHash===view.value.approvedCandidateHash);
const states:Record<SummaryWorkflowState,string>={preparing:'컨텍스트 준비 중',prepared:'컨텍스트 준비됨',blocked:'실제 요약 생성 차단됨',submitting:'요약 요청 준비 중',submitted:'요약 요청 제출됨',waiting:'응답 대기 중',candidate:'새 후보 검토 대기',approving:'승인 기록 저장 중',approved:'요약 승인 기록 저장됨',rejected:'후보 거절됨',error:'요약 요청 확인 필요',cancelled:'요약 요청 취소됨'};
const persistence:Record<SummaryPersistenceState,string>={'not-saved':'아직 저장하지 않음',restored:'이전 저장 기록 복원됨','saving-candidate':'후보 저장 중','candidate-saved':'후보 저장됨','saving-approval':'승인 기록 저장 중','approval-saved':'승인 기록 저장됨','rejection-saved':'거절 기록 저장됨',failed:'저장 실패','commit-unknown':'저장 여부 미확인','committed-after-cancel':'취소 후 저장 완료가 확인됨'};
function changeTask(id:string,checked:boolean) {
  if(!available.value||busy.value) return;
  const next=checked?[...selected.value,id]:selected.value.filter(value=>value!==id);
  selected.value=boundedTaskSelection(next,props.dag.tasks.map(task=>task.id));actions.dismiss();
}
function changeProvider(event:Event) {provider.value=(event.target as HTMLSelectElement).value as SummaryProviderChoice;actions.dismiss();}
function prepare() {if(available.value&&selectedCount.value>0) return actions.prepare({workstreamId:props.workstreamId,taskIds:selected.value,provider:provider.value});}
watch([()=>props.workstreamId,()=>props.dag.dagId],()=>{actions.dismiss();selected.value=[];});
watch(()=>props.current,current=>{if(!current) actions.dismiss();});
watch(()=>props.dag.tasks,()=>{selected.value=boundedTaskSelection(selected.value,props.dag.tasks.map(task=>task.id));});
watch(()=>props.dag.observedAt,()=>{if(available.value&&view.value) void actions.refresh();});
onMounted(actions.subscribe);
onUnmounted(actions.dispose);
</script>
<template>
  <section class="phase1-journey summary-journey" data-testid="summary-journey" :aria-busy="busy">
    <div class="section-heading"><div><p class="eyebrow">SUMMARY REVIEW</p><h3>작업 요약 · 검토</h3></div><span class="state-badge">승인은 실행 권한이 아닙니다</span></div>
    <p class="journey-intro">선택한 작업과 직접 의존성만 읽어 요약의 근거를 준비합니다. 실제 AI 호출은 안전한 실행 경계가 검증될 때까지 차단됩니다.</p>
    <LiveSummary v-if="!view" :summary="dag.summary" :historical="!current"/>
    <template v-if="view">
      <p class="journey-status" data-testid="summary-status" role="status">{{states[view.state]}}</p>
      <p v-if="view.transport==='blocked'||view.state==='blocked'" class="notice warning">{{view.message}}</p>
      <p v-else-if="view.state==='error'" class="notice error">요약 요청을 완료하지 못했습니다. 아래 기술 정보에서 원인을 확인할 수 있습니다.</p>
      <p v-if="view.transport==='synthetic-test-only'" class="notice warning">테스트 전용 합성 응답입니다. 실제 모델 호출 결과가 아닙니다.</p>
      <section class="claim-section" data-testid="summary-approved"><h4>유지된 승인 요약 <span>승인 기록 · 실행 승인 아님</span></h4><p v-if="view.approvedAt" class="muted">승인 기록 {{formatTime(view.approvedAt)}}</p><LiveClaimList :claims="view.approvedClaims" empty-text="승인된 요약이 없습니다" :historical="!current"/></section>
      <section class="claim-section" data-testid="summary-candidate"><h4>{{candidateApproved?'이미 승인된 후보 요약':view.persistence.state==='restored'?'저장된 후보 요약':'새 후보 요약'}} <span>{{candidateApproved?'동일 후보의 승인 기록 있음':'검토 전 · 미승인'}}</span></h4><LiveClaimList :claims="view.candidateClaims" empty-text="검토할 후보가 없습니다. 누락된 요약을 만들어 채우지 않습니다." :historical="!current"/></section>
      <div v-if="view.canApprove||view.canReject" class="journey-actions"><button type="button" data-testid="summary-approve" :disabled="busy||!available||!view.canApprove" @click="actions.approve">이 후보를 요약으로 승인</button><button type="button" class="secondary" data-testid="summary-reject" :disabled="busy||!view.canReject" @click="actions.reject">이 후보 거절</button></div>
      <p class="muted">{{persistence[view.persistence.state]}}<span v-if="view.persistence.revision!==null"> · 저장 리비전 {{view.persistence.revision}}</span></p>
      <p v-if="['failed','commit-unknown','committed-after-cancel'].includes(view.persistence.state)" class="notice warning">저장 결과를 확인해야 합니다. 취소나 닫기는 이미 완료된 저장을 되돌리지 않습니다.</p>
    </template>
    <section class="journey-step"><h4>1. 요약에 포함할 작업 선택</h4>
      <p v-if="!available" class="notice warning">현재 연결에서 DAG를 다시 확인해야 요약을 준비할 수 있습니다. 이전 관측만으로 새 요청을 만들지 않습니다.</p>
      <details class="summary-selection" data-testid="summary-task-selection" :open="dag.tasks.length<=5"><summary>작업 선택 {{selectedCount}} / {{MAX_SUMMARY_TASKS}}개 <span>· 표시된 작업 {{dag.tasks.length}}개</span></summary>
        <p v-if="!dag.tasks.length" class="muted">선택할 작업이 없습니다</p>
        <ul v-else class="summary-task-options"><li v-for="task in dag.tasks" :key="task.id"><label><input type="checkbox" :data-testid="'summary-task-'+task.id" :checked="selected.includes(task.id)" :disabled="!available||busy||(!selected.includes(task.id)&&selectedCount>=MAX_SUMMARY_TASKS)" @change="changeTask(task.id,($event.target as HTMLInputElement).checked)"/><span><strong>{{task.id}}</strong> {{task.title??'제목 미선언'}}<small>{{task.status??'상태 미선언'}}</small></span></label></li></ul>
      </details>
      <p v-if="dag.taskCount!==null&&dag.taskCount>dag.tasks.length" class="muted">DAG 표시 상한에 포함된 작업만 선택할 수 있습니다. 전체 {{dag.taskCount}}개 중 {{dag.tasks.length}}개 표시</p>
      <div class="journey-fields"><label>요약 제공자<select data-testid="summary-provider" :value="provider" :disabled="busy||!available" @change="changeProvider"><option value="auto">자동 판단 · 권고만</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label><button type="button" data-testid="summary-prepare" :disabled="!available||busy||!selectedCount" @click="prepare">{{busy&&!view?'준비 중…':'선택한 근거 미리 보기'}}</button></div>
    </section>
    <section v-if="view?.preview" class="journey-step" data-testid="summary-context"><h4>2. 전달 범위와 빠진 근거 확인</h4>
      <p>선택 작업 {{view.preview.selectedTaskCount}}개 · 근거 {{view.preview.recordCount}}개 · {{view.preview.bytes.toLocaleString('ko-KR')}} bytes</p>
      <p class="muted">요청 전체 {{view.preview.inputBytes.toLocaleString('ko-KR')}} bytes · 약 {{view.preview.approximateTokens.toLocaleString('ko-KR')}} 토큰 (바이트 기반 추정, 모델 토크나이저 아님) · 응답 상한 {{view.preview.maxResponseBytes.toLocaleString('ko-KR')}} bytes</p>
      <p v-if="view.preview.truncated" class="notice warning">입력 상한에 따라 일부 근거가 제외되었습니다. 제외 항목을 확인해 주세요.</p>
      <p class="muted">명시된 목표가 없으면 추측해 채우지 않습니다. 선택하지 않은 파일과 임의의 소스 코드 본문을 추가하지 않습니다.</p>
      <ul v-if="view.preview.unknowns.length" class="journey-notices"><li v-for="(unknown,index) in view.preview.unknowns" :key="index">{{unknown}}</li></ul>
      <p v-if="view.preview.unresolvedDependencyIds.length" class="warning-text">확인되지 않은 의존성: {{view.preview.unresolvedDependencyIds.join(', ')}}</p>
      <details v-if="view.preview.exclusions.length" class="context-details"><summary>제외한 근거 {{view.preview.exclusions.length}}개</summary><ul><li v-for="(excluded,index) in view.preview.exclusions" :key="index">{{excluded.sourceId}} · {{excluded.reason}}</li></ul></details>
      <details class="context-details"><summary>실제로 포함된 읽기 근거 {{view.preview.records.length}}개</summary><article v-for="(record,index) in view.preview.records" :key="index" class="context-record"><strong>{{record.taskId??record.sourceId}} · {{record.title??'제목 미선언'}}</strong><p>{{record.selection==='selected-task'?'선택 작업':'직접 의존성'}} · {{record.declaredStatus??'상태 미선언'}}</p><pre>{{record.suppliedText}}</pre></article></details>
    </section>
    <section v-if="view" class="journey-step" data-testid="summary-budget"><h4>3. 제공자 · 비용 · 쿼터 확인</h4>
      <p>선택: {{view.providerChoice==='auto'?'자동 판단':view.providerChoice}} · 이번 요청 제공자: {{view.selectedProvider??'결정되지 않음'}}</p>
      <p class="muted">비용 관측, 사용자 예산 상한, 제공자 쿼터는 서로 다릅니다. 다음 요청 비용과 에이전트 실행 가능 여부는 확인되지 않았습니다.</p>
      <p v-if="!view.budget||view.budget.state==='choice-required'" class="warning-text">비교 가능한 근거가 부족해 제공자를 자동으로 결정하지 못했습니다.</p>
      <ul v-if="view.budget" class="budget-assessments"><li v-for="assessment in view.budget.assessments" :key="assessment.provider"><strong>{{assessment.provider}}</strong> · 실행 가능: {{assessment.availability==='available'?'확인됨':assessment.availability==='unavailable'?'불가':'미확인'}} · 예산: {{assessment.budget==='below-cap'?'상한 미만':assessment.budget==='cap-reached'?'상한 도달':'미확인'}}</li></ul>
      <details class="context-details"><summary>독립적인 사용량 · 쿼터 관측</summary><LiveCodeBurn :codeburn="{state:view.codeburn.length?'observed':'idle',results:view.codeburn}" :stale="!current"/></details>
      <div class="journey-actions"><button type="button" data-testid="summary-run" :disabled="busy||!available||!view.canRun" @click="actions.run(provider)">{{view.transport==='blocked'?'실제 요약 생성 차단됨':'테스트 요약 요청'}}</button><button v-if="view.canCancel" type="button" class="secondary" data-testid="summary-cancel" @click="actions.cancel">요청 취소</button><button type="button" class="secondary" data-testid="summary-dismiss" @click="actions.dismiss">검토 닫기</button></div>
      <p class="scope-note">요약 승인과 거절은 이 후보의 로컬 기록만 다룹니다. 작업 실행, 코드 변경, 테스트·배포 또는 유료 호출 권한을 부여하지 않습니다.</p>
    </section>
    <button v-if="busy&&!view" type="button" class="journey-cancel secondary" data-testid="summary-dismiss" @click="actions.dismiss">준비 취소</button>
    <p v-if="error" class="notice error" role="alert">{{error}}</p>
    <details v-if="view||technicalError" class="context-details technical-details"><summary>요약 요청 · 기술 정보</summary><template v-if="view"><p>요청: {{view.ticketId}}</p><p>상태: {{view.state}} · 전송: {{view.transport}}</p><p>진단: {{view.message}}</p><p>후보 해시: {{view.candidateHash??'없음'}}</p><p>승인 후보 해시: {{view.approvedCandidateHash??'없음'}}</p><p>저장 진단: {{view.persistence.message}}</p><p v-if="view.budget">예산 진단: {{view.budget.reasons.join(' · ')}}</p><p v-for="assessment in view.budget?.assessments??[]" :key="assessment.provider">{{assessment.provider}}: {{assessment.reasons.join(' · ')}}</p></template><p v-if="technicalError">{{technicalError}}</p></details>
  </section>
</template>
