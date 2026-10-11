<script setup lang="ts">
import {computed,nextTick,onMounted,onUnmounted,ref,watch} from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import type {UpdateState,UpdateStatus} from '../../shared/update';
import {formatTime} from '../store';

const state=ref<UpdateState|null>(null),error=ref(''),pending=ref<string|null>(null);
const confirmInstall=ref(false);
let disposed=false,unsubscribe:(()=>void)|undefined,observed=0,generation=0;
const statusLabels:Record<UpdateStatus,string>={
  idle:'아직 확인하지 않음',checking:'업데이트 확인 중',unavailable:'업데이트 사용 불가',
  'up-to-date':'승인된 최신 빌드',available:'업데이트 있음',preparing:'업데이트 준비 중',
  ready:'설치 준비 완료',deferred:'나중에 설치',installing:'설치 및 재시작 중',cancelled:'업데이트 취소됨',error:'업데이트 실패',
};
const missingPrerequisites=computed(()=>state.value?.prerequisites.filter(item=>!item.ready)??[]);
const prerequisitesMissing=computed(()=>missingPrerequisites.value.length>0);
const progress=computed(()=>{
  const value=state.value?.progress;
  return value&&Number.isFinite(value.completed)&&Number.isFinite(value.total)&&value.total>0
    ?{...value,completed:Math.max(0,Math.min(value.completed,value.total))}:null;
});
const targetIdentity=computed(()=>state.value?.target?`${state.value.target.version}:${state.value.target.sourceSha}:${state.value.target.buildNumber}`:null);
watch(targetIdentity,()=>{confirmInstall.value=false;});
watch(()=>state.value?.canInstall,canInstall=>{if(!canInstall)confirmInstall.value=false;});
function receive(next:UpdateState){if(disposed)return;observed++;state.value=next;}
async function load(){
  const seen=observed;
  try{const next=await window.noteApp.getUpdateState();if(!disposed&&seen===observed)state.value=next;}
  catch{if(!disposed)error.value='업데이트 상태를 확인하지 못했습니다. 다시 상태를 불러와 주세요.';}
}
onMounted(()=>{
  try{unsubscribe=window.noteApp.onUpdateState(receive);}catch{error.value='업데이트 알림에 연결하지 못했습니다.';}
  void load();
});
onUnmounted(()=>{disposed=true;generation++;unsubscribe?.();});

type Action='check'|'prepare'|'cancel'|'defer'|'install';
async function act(action:Action){
  if(disposed||(pending.value&&(action!=='cancel'||pending.value==='cancel')))return;
  const current=state.value;
  const allowed=current&&({check:current.canCheck,prepare:current.canPrepare,cancel:current.canCancel,defer:current.canDefer,install:current.canInstall})[action];
  if(!allowed)return;
  const request=++generation,seen=observed;
  pending.value=action;error.value='';confirmInstall.value=false;
  try{
    const next=await ({check:()=>window.noteApp.checkUpdate(),prepare:()=>window.noteApp.prepareUpdate(),cancel:()=>window.noteApp.cancelUpdate(),defer:()=>window.noteApp.deferUpdate(),install:()=>window.noteApp.installUpdate()})[action]();
    if(!disposed&&request===generation&&seen===observed)state.value=next;
  }catch{
    if(!disposed&&request===generation){
      error.value=action==='install'?'설치 및 재시작 결과를 확인하지 못했습니다. 업데이트 상태와 다음 실행 시 결과 안내를 확인해 주세요.':'업데이트 요청을 완료하지 못했습니다. 현재 상태를 확인한 뒤 다시 시도해 주세요.';
      await load();
    }
  }finally{if(!disposed&&request===generation)pending.value=null;}
}
function reviewInstall(){if(state.value?.canInstall&&!pending.value)confirmInstall.value=true;}
function restoreFocus(){void nextTick(()=>{document.querySelector<HTMLButtonElement>('[data-testid=update-install]')?.focus({preventScroll:true});});}
</script>

<template>
  <section class="settings-panel update-settings" data-testid="update-settings" aria-labelledby="update-heading">
    <div class="setting-row">
      <div><h2 id="update-heading">앱 업데이트 · 데모 채널</h2><p>앱에 지정된 게시 채널에서 새 버전을 확인합니다. 업데이트 준비를 선택하면 해당 소스를 내려받아 이 Mac에서 빌드합니다.</p></div>
      <span class="state-badge" :class="{safe:state?.status==='ready'||state?.status==='up-to-date'}" data-testid="update-status">{{state?statusLabels[state.status]:'상태 불러오는 중'}}</span>
    </div>
    <p class="muted" data-testid="update-preparation-help">준비 중에도 현재 앱을 계속 사용할 수 있습니다. 준비에 필요한 Git, Node.js 24 이상, npm과 설치 환경을 먼저 확인하며, 없는 도구를 자동으로 설치하지 않습니다.</p>
    <div aria-live="polite" aria-atomic="true" role="status" data-testid="update-message">
      <p v-if="state" :class="{'warning-text':state.status==='unavailable'}">{{state.message}}</p>
      <p v-else>업데이트 상태를 불러오고 있습니다. 자동으로 업데이트를 확인하거나 설치하지 않습니다.</p>
    </div>
    <p v-if="state?.status==='error'" role="alert" class="notice error">업데이트에 실패했습니다. 아래 상태와 실행 조건을 확인한 뒤 다시 시도해 주세요.</p>
    <p v-if="error" role="alert" class="notice error" data-testid="update-error">{{error}}</p>
    <template v-if="state">
      <p v-if="state.status==='deferred'" class="notice" data-testid="update-deferred">{{state.canInstall?'저장된 준비 상태와 파일 검증이 확인되었습니다. 설치 및 재시작을 선택할 때까지 현재 앱을 계속 사용합니다.':'저장된 준비 파일의 검증이 확인되지 않아 설치할 수 없습니다. 위 상태를 확인해 주세요.'}}</p>
      <p class="update-build" data-testid="update-current">현재 {{state.current.version}} · 빌드 {{state.current.buildNumber??'미확인'}}</p>
      <div v-if="state.target" class="update-target" data-testid="update-target">
        <h3>대상 {{state.target.version}} · 빌드 {{state.target.buildNumber}}</h3>
        <p class="muted">게시 {{formatTime(state.target.publishedAt)}}</p>
        <h4>변경 사항</h4>
        <ul v-if="state.target.changelog.length" data-testid="update-changelog"><li v-for="(item,index) in state.target.changelog" :key="index">{{item}}</li></ul>
        <p v-else class="muted">게시된 변경 사항이 없습니다.</p>
      </div>
      <div v-if="state.progress" class="update-progress">
        <p>{{state.progress.step}}</p>
        <p v-if="progress" data-testid="update-progress-count">준비 단계 {{progress.completed}}/{{progress.total}}</p>
        <p v-if="progress" class="muted">단계 기준이며, 다운로드 퍼센트가 아닙니다.</p>
        <progress v-if="progress" :value="progress.completed" :max="progress.total" :aria-valuetext="`준비 단계 ${progress.completed}/${progress.total}: ${progress.step}`" aria-label="업데이트 준비 진행 단계"/>
      </div>
      <p v-if="prerequisitesMissing" class="warning-text" data-testid="update-missing-prerequisites">확인 필요: {{missingPrerequisites.map(item=>item.label).join(', ')}}. 아래 실행 조건에서 필요한 조치를 확인해 주세요.</p>
      <div class="setting-actions update-actions">
        <Button label="업데이트 확인" data-testid="update-check" outlined :loading="pending==='check'||state.status==='checking'" :disabled="!!pending||!state.canCheck" @click="act('check')"/>
        <Button v-if="state.canPrepare" label="업데이트 준비" data-testid="update-prepare" :disabled="!!pending" @click="act('prepare')"/>
        <Button v-if="state.canCancel" :label="state.status==='checking'?'확인 취소':'준비 취소'" data-testid="update-cancel" outlined :disabled="pending==='cancel'" :loading="pending==='cancel'" @click="act('cancel')"/>
        <Button v-if="state.canInstall" label="설치 및 재시작" data-testid="update-install" :disabled="!!pending" @click="reviewInstall"/>
        <Button v-if="state.canDefer" label="나중에" data-testid="update-later" outlined :disabled="!!pending" @click="act('defer')"/>
      </div>
      <details class="setting-detail update-details" :open="prerequisitesMissing">
        <summary>빌드 정보 및 실행 조건</summary>
        <dl class="configuration-list">
          <div><dt>현재 버전 / 빌드</dt><dd>{{state.current.version}} / {{state.current.buildNumber??'미확인'}}</dd></div>
          <div><dt>현재 전체 소스 SHA</dt><dd data-testid="update-current-sha">{{state.current.sourceSha??'미확인'}}</dd></div>
          <div v-if="state.target"><dt>대상 전체 소스 SHA</dt><dd data-testid="update-target-sha">{{state.target.sourceSha}}</dd></div>
          <div><dt>마지막 확인</dt><dd>{{state.checkedAt?formatTime(state.checkedAt):'아직 확인하지 않음'}}</dd></div>
        </dl>
        <p>이 소스 기반 데모 업데이트에는 지원되는 macOS 사용자 설치, Git, Node.js 24 이상 및 npm이 필요합니다. 대상 버전은 게시 채널에서 자동으로 정하므로 SHA 입력이나 별도 설정은 필요하지 않습니다. 확인과 준비는 버튼을 눌렀을 때만 실행합니다.</p>
        <ul v-if="state.prerequisites.length" class="update-prerequisites" data-testid="update-prerequisites">
          <li v-for="item in state.prerequisites" :key="item.id"><strong>{{item.ready?'준비됨':'확인 필요'}} · {{item.label}}</strong><span v-if="item.detail"> · {{item.detail}}</span></li>
        </ul>
      </details>
    </template>
    <Button v-else-if="error" label="상태 다시 불러오기" outlined @click="load"/>
  </section>
  <Dialog v-model:visible="confirmInstall" modal header="업데이트 설치 및 재시작" :style="{width:'min(560px,92vw)'}" @hide="restoreFocus" @after-hide="restoreFocus">
    <div class="update-confirm">
      <p v-if="state?.target"><strong>{{state.target.version}} · 빌드 {{state.target.buildNumber}}</strong>을 설치하고 앱을 다시 시작합니다.</p>
      <p>작업·저장·조회의 정리가 확인된 뒤 앱을 교체합니다. 정리를 확인할 수 없으면 설치가 지연되며, 정상 종료 후 다시 열어야 할 수 있습니다.</p>
      <p>로컬 설정과 기록은 유지됩니다. 설치를 마칠 때까지 앱이 잠시 닫힙니다.</p>
      <p>새 앱의 정상 시작을 확인하지 못하면 이전 앱으로 복구를 시도합니다. 자동 복구가 확인되지 않으면 업데이트 결과 안내에 따라 현재 앱과 백업을 확인해 주세요.</p>
      <p v-if="state?.target" class="update-sha">대상 전체 소스 SHA: {{state.target.sourceSha}}</p>
      <div class="setting-actions"><Button label="설치하고 재시작" data-testid="update-install-confirm" :disabled="!!pending||!state?.canInstall" @click="act('install')"/><Button label="취소" data-testid="update-install-cancel" autofocus outlined @click="confirmInstall=false"/></div>
    </div>
  </Dialog>
</template>

<style scoped>
.update-settings{margin-top:1.2rem}
.update-settings .setting-row{align-items:flex-start}
.update-settings .state-badge{white-space:normal;flex-shrink:0}
.update-target{margin:1rem 0;padding:1rem;border:1px solid var(--line);border-radius:10px}
.update-target h3,.update-target h4{margin:.1rem 0 .6rem}
.update-target li,.update-prerequisites li{margin:.45rem 0}
.update-actions{flex-wrap:wrap}
.update-progress progress{width:min(100%,28rem)}
.update-details dd,.update-sha,.update-target li{overflow-wrap:anywhere}
.update-prerequisites{padding-left:1.2rem}
.update-confirm p{line-height:1.65}
@media(max-width:800px){.update-settings .setting-row{flex-wrap:wrap}}
</style>
