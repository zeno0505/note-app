<script setup lang="ts">
import {computed,inject,onMounted,onUnmounted,ref,watch} from 'vue';
import {createNoteLinkActions,noteLinkActionsKey} from '../phase1-actions';
import {formatTime} from '../store';
const props=defineProps<{worktreeId:string;current:boolean}>();
const emit=defineEmits<{changed:[]}>();
const actions=inject(noteLinkActionsKey,undefined)??createNoteLinkActions(typeof window==='undefined'?undefined:window.noteApp);
const {options,proposal,result,rejection,busy,error,technicalError,notice}=actions;
const scopeId=ref('');
const now=ref(Date.now());
let timer:ReturnType<typeof setInterval>|undefined;
const expired=computed(()=>!!proposal.value&&(!Number.isFinite(Date.parse(proposal.value.expiresAt))||Date.parse(proposal.value.expiresAt)<=now.value));
const canPreview=computed(()=>props.current&&options.value?.noteLinkConfigured===true&&options.value.noteScopes.some(scope=>scope.scopeId===scopeId.value)&&!busy.value);
const resultLabels={applied:'노트 연결 적용됨',noop:'변경 없음 · 기존 연결 확인됨',rejected:'변경 요청 거절됨','rolled-back':'변경 실패 · 원상 복구됨',partial:'일부 변경 남음 · 복구 확인 필요'};
const actualLabel=(value:boolean|null)=>value===null?'미확인':value?'확인됨':'변경 없음';
function changeScope(event:Event) {scopeId.value=(event.target as HTMLSelectElement).value;actions.dismiss();}
function preview() {if(canPreview.value) return actions.preview({worktreeId:props.worktreeId,scopeId:scopeId.value});}
async function confirm() {if(!props.current||expired.value) return;await actions.confirm();if(result.value&&['applied','noop','partial','rolled-back'].includes(result.value.status)) emit('changed');}
watch(()=>props.worktreeId,()=>{actions.dismiss();scopeId.value='';});
watch(()=>props.current,current=>{if(!current&&(proposal.value||busy.value==='preview'||busy.value==='confirm')) actions.dismiss();});
onMounted(()=>{void actions.loadOptions();timer=setInterval(()=>{now.value=Date.now();},1000);});
onUnmounted(()=>{clearInterval(timer);actions.dispose();});
</script>
<template>
  <section class="phase1-journey note-link-journey" data-testid="note-link-journey" :aria-busy="!!busy">
    <div class="section-heading"><div><p class="eyebrow">LOCAL NOTE LINK</p><h3>등록된 노트 연결</h3></div><span class="state-badge">변경 전 미리보기 · 명시적 확인</span></div>
    <p class="journey-intro">등록된 노트 범위를 이 작업의 docs/note에 연결합니다. 실제 경로와 Git 로컬 제외 변경을 확인한 후에만 적용할 수 있습니다.</p>
    <p v-if="!current" class="notice warning">현재 연결에서 작업 경로를 확인해야 새 변경을 미리 볼 수 있습니다.</p>
    <p v-if="options&&!options.noteLinkConfigured" class="muted">이 시작 설정에서는 노트 연결 변경을 사용할 수 없습니다.</p>
    <p v-if="busy==='options'" class="muted" role="status">등록된 노트 범위를 확인하고 있습니다…</p>
    <div class="journey-fields"><label>등록된 노트 범위<select data-testid="note-link-scope" :value="scopeId" :disabled="!!busy||!options?.noteLinkConfigured||!current" @change="changeScope"><option value="">범위 선택</option><option v-for="scope in options?.noteScopes??[]" :key="scope.scopeId" :value="scope.scopeId">{{scope.scopePath}}</option></select></label><button type="button" data-testid="note-link-preview" :disabled="!canPreview" @click="preview">{{busy==='preview'?'미리 보는 중…':'연결 변경 미리 보기'}}</button></div>
    <p v-if="options?.noteLinkConfigured&&!options.noteScopes.length" class="muted">선택 가능한 등록 범위가 없습니다</p>
    <section v-if="proposal" class="link-proposal" data-testid="note-link-proposal">
      <h4>{{proposal.status==='conflict'?'기존 상태와 충돌합니다':proposal.status==='noop'?'이미 같은 노트에 연결되어 있습니다':'다음 로컬 변경을 확인해 주세요'}}</h4>
      <dl class="journey-paths"><div><dt>작업 디렉터리</dt><dd>{{proposal.paths.worktree}}</dd></div><div><dt>연결 생성 위치</dt><dd>{{proposal.paths.note}}</dd></div><div><dt>노트 연결 대상</dt><dd>{{proposal.paths.scope}}</dd></div><div><dt>로컬 제외 파일</dt><dd>{{proposal.paths.exclude}}</dd></div></dl>
      <ul class="link-change-list"><li>{{proposal.changes.createDocsDirectory?'docs 디렉터리 생성':'docs 디렉터리 생성 없음'}} · {{proposal.paths.docs}}</li><li>{{proposal.changes.createNoteSymlink?'위 대상에 대한 docs/note 심볼릭 링크 생성':'새 심볼릭 링크 생성 없음'}}</li><li>{{proposal.changes.appendLocalExclude?'Git 로컬 제외 파일에 /docs/note 추가':'Git 로컬 제외 파일 변경 없음'}}</li></ul>
      <section class="exclude-review"><h4>정확한 로컬 제외 변경</h4><p v-if="proposal.changes.appendLocalExclude" class="muted">기존 {{proposal.exclude.beforeBytes}} bytes → 변경 후 {{proposal.exclude.afterBytes}} bytes · 아래 텍스트만 추가</p><pre v-if="proposal.changes.appendLocalExclude">{{proposal.exclude.appendText}}</pre><p v-else class="muted">추가할 텍스트 없음</p><p class="muted">추적 파일이나 .gitignore를 편집하지 않습니다.</p></section>
      <section class="shared-exclude-review"><h4>공유 제외 설정의 영향 범위</h4><p>{{proposal.sharedExclude.scopeDescription}}</p><ul><li v-for="(path,index) in proposal.sharedExclude.worktreePaths" :key="index">{{path}}</li></ul><p v-if="!proposal.sharedExclude.worktreePaths.length" class="muted">영향을 받는 작업 디렉터리 목록이 제공되지 않았습니다</p></section>
      <ul v-if="proposal.conflicts.length" class="journey-notices conflict-list"><li v-for="(conflict,index) in proposal.conflicts" :key="index">{{conflict}}</li></ul>
      <ul v-if="proposal.warnings.length" class="journey-notices"><li v-for="(warning,index) in proposal.warnings" :key="index">{{warning}}</li></ul>
      <p class="muted">미리보기 만료: {{formatTime(proposal.expiresAt)}}</p><p v-if="expired" class="notice warning" role="status">유효 시간이 지났습니다. 새로 미리 보기를 해야 적용할 수 있습니다.</p>
      <p v-if="busy==='confirm'" class="notice warning" role="status">적용 결과를 확인하고 있습니다. 닫거나 다른 화면으로 이동해도 이미 적용된 변경이 자동으로 되돌려지지는 않습니다.</p>
      <div class="journey-actions"><button type="button" data-testid="note-link-confirm" :disabled="!!busy||!current||expired||proposal.status==='conflict'" @click="confirm">{{busy==='confirm'?'적용 결과 확인 중…':proposal.status==='noop'?'변경 없이 연결 상태 확인':'위 로컬 변경을 확인하고 적용'}}</button><button type="button" class="secondary" data-testid="note-link-cancel" @click="actions.dismiss">{{busy==='confirm'?'미리보기 닫기':'취소 · 미리보기 폐기'}}</button></div>
      <details class="context-details technical-details"><summary>경로 · 변경 검증 기술 정보</summary><p>제안 ID: {{proposal.proposalId}}</p><p>등록 범위 ID: {{proposal.scopeId}}</p><p>노트 보관 경로: {{proposal.paths.vault}}</p><p>Git 경로: {{proposal.paths.gitDirectory}}</p><p>공유 Git 경로: {{proposal.paths.commonGitDirectory}}</p><p>임시 제외 파일: {{proposal.paths.temporaryExclude}}</p><p>변경 전 해시: {{proposal.exclude.beforeSha256}}</p><p>변경 후 해시: {{proposal.exclude.afterSha256}}</p></details>
    </section>
    <section v-if="result" class="link-result" :class="{'recovery-needed':result.status==='partial'}" data-testid="note-link-result" role="status"><h4>{{resultLabels[result.status]}}</h4><p v-if="result.status==='partial'" class="notice error">일부 변경이 남아 있을 수 있습니다. 다시 적용하기 전에 아래 복구 안내와 실제 파일 상태를 확인해 주세요.</p><p v-else-if="result.status==='rolled-back'" class="notice warning">적용을 완료하지 못해 이번 요청의 변경을 원상 복구했습니다.</p><p v-if="result.cancellationRequested" class="warning-text">취소가 요청되었습니다. 아래는 확인된 실제 결과입니다.</p><ul class="link-change-list"><li>docs 생성: {{actualLabel(result.actual.docsCreated)}}</li><li>노트 연결: {{actualLabel(result.actual.noteLinked)}}</li><li>제외 파일 갱신: {{actualLabel(result.actual.excludeUpdated)}}</li></ul><ul v-if="result.recovery.length" class="journey-notices"><li v-for="(instruction,index) in result.recovery" :key="index">{{instruction}}</li></ul><details class="context-details technical-details"><summary>적용 결과 · 기술 정보</summary><p>{{result.message}}</p><p v-if="result.code">{{result.code}}</p><p v-if="result.proposalId">{{result.proposalId}}</p></details></section>
    <p v-if="rejection" class="notice warning" role="alert">변경을 미리 확인할 수 없습니다. 현재 등록 범위와 작업 연결을 확인해 주세요.</p>
    <p v-if="notice" class="notice warning" role="status">{{notice}}</p><p v-if="error" class="notice error" role="alert">{{error}}</p>
    <button v-if="busy==='preview'" type="button" class="journey-cancel secondary" data-testid="note-link-cancel" @click="actions.dismiss">미리보기 요청 취소</button>
    <details v-if="rejection||technicalError||options" class="context-details technical-details"><summary>설정 · 조회 기술 정보</summary><p v-if="options">{{options.noteLinkMessage}}</p><template v-if="rejection"><p>{{rejection.code}}</p><p>{{rejection.message}}</p></template><p v-if="technicalError">{{technicalError}}</p></details>
  </section>
</template>
