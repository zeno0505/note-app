<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue';
import Button from 'primevue/button';
import type {UpdateOutcome,UpdateState} from '../../shared/update';
import {formatTime} from '../store';

// App-level notification survives route changes. Only main owns persistence and dismissal.
const outcome=ref<UpdateOutcome|null>(null),pending=ref(false),error=ref('');
const labels:Record<UpdateOutcome['kind'],string>={
  success:'업데이트 설치 완료',rollback:'이전 앱으로 복구됨','recovery-needed':'업데이트 복구 확인 필요',
  failed:'업데이트 설치 실패',unverified:'업데이트 결과 미확인',
};
const descriptions:Record<UpdateOutcome['kind'],string>={
  success:'업데이트한 앱의 정상 시작을 확인했습니다.',
  rollback:'업데이트를 완료하지 못해 이전 앱으로 되돌렸습니다.',
  'recovery-needed':'자동 복구가 완료되었는지 확인할 수 없습니다. 현재 앱과 보관된 백업을 확인해 주세요.',
  failed:'업데이트 설치를 완료하지 못했습니다. 연결 및 설정에서 현재 빌드와 상태를 확인해 주세요.',
  unverified:'설치 완료나 복구를 확인할 근거가 부족합니다. 연결 및 설정에서 현재 빌드를 확인해 주세요.',
};
let disposed=false,observed=0,generation=0,unsubscribe:(()=>void)|undefined;
function receive(state:UpdateState){if(disposed)return;observed++;outcome.value=state.outcome??null;}
async function load(){
  const seen=observed;
  try{const state=await window.noteApp.getUpdateState();if(!disposed&&seen===observed)outcome.value=state.outcome??null;}
  catch{/* Missing state is never evidence of an update result. Settings provides manual retry. */}
}
onMounted(()=>{
  try{unsubscribe=window.noteApp.onUpdateState(receive);}catch{/* Still try the read-only initial state. */}
  void load();
});
onUnmounted(()=>{disposed=true;generation++;unsubscribe?.();});
async function dismiss(){
  if(disposed||pending.value||!outcome.value)return;
  const request=++generation,seen=observed;
  pending.value=true;error.value='';
  try{
    const state=await window.noteApp.dismissUpdateOutcome();
    if(!disposed&&request===generation&&seen===observed)outcome.value=state.outcome??null;
  }catch{
    if(!disposed&&request===generation){error.value='업데이트 결과를 닫지 못했습니다. 잠시 후 다시 시도해 주세요.';await load();}
  }finally{if(!disposed&&request===generation)pending.value=false;}
}
</script>

<template>
  <aside v-if="outcome" class="update-outcome" :class="{'update-outcome-success':outcome.kind==='success'}" role="status" aria-live="polite" aria-atomic="true" data-testid="update-outcome" :data-outcome-kind="outcome.kind">
    <div>
      <h2>{{labels[outcome.kind]}}</h2>
      <p>{{outcome.message||descriptions[outcome.kind]}}</p>
      <p class="muted">대상 {{outcome.targetVersion}} · {{formatTime(outcome.occurredAt)}}</p>
      <p v-if="error" role="alert" class="notice error" data-testid="update-outcome-error">{{error}}</p>
    </div>
    <Button label="결과 닫기" data-testid="update-outcome-dismiss" outlined :disabled="pending" :loading="pending" @click="dismiss"/>
  </aside>
</template>

<style scoped>
.update-outcome{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin:0 0 1.2rem;padding:1rem;border:1px solid var(--line);border-left:4px solid var(--warning, #b7791f);border-radius:10px}
.update-outcome-success{border-left-color:var(--success, #2d8062)}
.update-outcome h2{margin:0 0 .5rem;font-size:1.05rem}
.update-outcome p{margin:.4rem 0;overflow-wrap:anywhere}
.update-outcome button{flex-shrink:0}
@media(max-width:800px){.update-outcome{flex-wrap:wrap}}
</style>
