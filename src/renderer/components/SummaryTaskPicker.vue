<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import MultiSelect from 'primevue/multiselect';
import InputText from 'primevue/inputtext';
import type {LiveDagView} from '../../shared/live';
import {setSummaryPrefix,liveBusy} from '../store';
const props=defineProps<{dag:LiveDagView;workstreamId:string;disabled:boolean}>();
const visible=ref(false),draft=ref<string[]>([]),extra=ref(''),error=ref('');
const scope=computed(()=>props.dag.summaryScope!);
const choices=computed(()=>props.dag.tasks.map(t=>({value:t.id,label:t.id+' · '+(t.title??'제목 미선언')+' · '+(t.status??'상태 미선언')})));
const ids=computed(()=>[...new Set([...draft.value,...extra.value.split(/[\s,]+/).filter(Boolean)])]);
function open(){draft.value=[...scope.value.taskSelection.taskIds];extra.value='';error.value='';visible.value=true;}
async function apply(){error.value='';if(await setSummaryPrefix(props.workstreamId,scope.value.selected,ids.value))visible.value=false;else error.value='선택을 저장하지 못했습니다. 이 접두사의 현재 DAG에 존재하는 ID인지 확인해 주세요.';}
watch(()=>[props.dag.dagId,scope.value.selected],()=>{visible.value=false;});
</script>
<template>
  <div class="summary-task-picker" data-testid="summary-task-picker">
    <p><strong>{{scope.taskSelection.mode==='explicit'?'직접 선택':'대표 작업'}} {{scope.taskSelection.taskIds.length}}개</strong> · 접두사 안에서 {{scope.taskSelection.omittedCount}}개 생략 · 규칙·AI 공통 범위</p>
    <p class="muted">대표 작업은 진행·차단·검토 등 상태 범주를 고루 살피고, 기다리는 미완료 후속 작업이 많은 항목을 먼저 담습니다. 동률은 원문 순서이며 최신 순서가 아닙니다.</p>
    <p v-if="scope.taskSelection.missingIds.length" role="alert" class="notice warning">현재 DAG에서 찾을 수 없는 직접 선택: {{scope.taskSelection.missingIds.join(', ')}}. 선택을 다시 확인해 주세요.</p>
    <div class="task-picker-actions"><Button label="요약할 작업 선택" outlined size="small" data-testid="summary-task-open" :disabled="disabled||!scope.selectedCount" @click="open"/><Button v-if="scope.taskSelection.mode==='explicit'" label="대표 작업으로 돌아가기" text size="small" data-testid="summary-task-auto" :disabled="disabled" @click="setSummaryPrefix(workstreamId,scope.selected)"/></div>
    <details><summary>선정 작업과 이유 {{scope.taskSelection.taskIds.length}}개</summary><ul><li v-for="item in scope.taskSelection.reasons" :key="item.id">{{item.id}} · {{item.reason}} · 기다리는 후속 작업 {{item.waitingCount}}개</li></ul></details>
    <Dialog v-model:visible="visible" modal header="요약할 작업 선택" :style="{width:'40rem',maxWidth:'95vw'}" :closable="!liveBusy" :close-on-escape="!liveBusy">
      <div class="task-picker-dialog">
        <p>{{scope.selected}} 접두사의 작업을 1~20개 선택하세요. 적용하면 규칙 설명과 다음 수동 AI 입력이 함께 바뀝니다. 모델은 호출하지 않습니다.</p>
        <label :for="'tasks-'+workstreamId">작업 이름 또는 ID로 찾기</label>
        <MultiSelect v-model="draft" :input-id="'tasks-'+workstreamId" :options="choices" option-label="label" option-value="value" filter :show-toggle-all="false" :selection-limit="20" :max-selected-labels="3" selected-items-label="{0}개 선택" placeholder="작업 선택" data-testid="summary-task-select" :disabled="liveBusy"/>
        <p class="muted">목록은 최대 200개입니다. 목록 밖의 작업은 아래에 정확한 ID를 입력할 수 있습니다. 대표 선정 작업은 목록에 포함됩니다.</p>
        <label :for="'task-ids-'+workstreamId">추가 작업 ID · 쉼표 또는 공백으로 구분</label>
        <InputText v-model="extra" :id="'task-ids-'+workstreamId" data-testid="summary-task-ids" placeholder="예: T-227, T-228" :disabled="liveBusy"/>
        <p v-if="error" role="alert" class="notice warning">{{error}}</p><p role="status">선택 {{ids.length}} / 20개</p><p v-if="ids.length>20" class="notice warning">20개를 넘었습니다. 선택을 줄여 주세요.</p>
        <div class="task-picker-actions"><Button label="선택 비우기" text :disabled="liveBusy" @click="draft=[];extra=''"/><Button label="취소" outlined :disabled="liveBusy" @click="visible=false"/><Button label="선택 적용" data-testid="summary-task-apply" :disabled="liveBusy||disabled||!ids.length||ids.length>20" :loading="liveBusy" @click="apply"/></div>
      </div>
    </Dialog>
  </div>
</template>
<style scoped>
.summary-task-picker,.task-picker-dialog{display:grid;gap:10px;min-width:0}.task-picker-actions{display:flex;gap:8px;flex-wrap:wrap}.task-picker-dialog p{margin:0;overflow-wrap:anywhere}.task-picker-dialog :deep(.p-multiselect){width:100%;min-width:0}.summary-task-picker ul{padding-left:20px;overflow-wrap:anywhere}
</style>
