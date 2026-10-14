<script lang="ts">
import {computed,ref,shallowRef} from 'vue';
import type {GitMetadataReadBridge,GitMetadataReadState,GitMetadataReadProposal} from '../../shared/git-metadata-grants';

/** Each open settings session owns its proposal; late picker/confirmation replies cannot reopen it. */
export function createGitMetadataReadSettings(bridge:GitMetadataReadBridge,workstreamId:string,callbacks:{changing?:()=>void;changed?:()=>void}={}){
 const state=shallowRef<GitMetadataReadState|null>(null),proposal=shallowRef<GitMetadataReadProposal|null>(null),busy=ref(false),loading=ref(false),reviewed=ref(false),actionError=ref(''),readError=ref(''),notice=ref('');
 const recoveryWarning='로컬 읽기 허용이 저장됐을 수 있습니다. 앱을 다시 시작하기 전에 저장소를 복구하고 읽기 허용 상태를 확인·철회해 주세요.';
 const error=computed(()=>state.value?.recoveryRequired?(state.value.error||recoveryWarning):actionError.value||readError.value),editing=computed(()=>busy.value||!!proposal.value);
 let active=false,disposed=false,generation=0,readSequence=0;
 const current=(own:number)=>active&&!disposed&&own===generation;
 async function cancelProposal(value:GitMetadataReadProposal){try{await bridge.cancelGitMetadataReadScope({proposalId:value.proposalId});}catch{if(!disposed)actionError.value='읽기 허용 취소 상태를 확인하지 못했습니다. 현재 범위를 다시 확인해 주세요.';}}
 async function refresh(){if(!active||disposed)return;const own=generation,read=++readSequence;loading.value=true;try{const value=await bridge.getGitMetadataReadState({workstreamId});if(current(own)&&read===readSequence){state.value=value;readError.value='';}}catch{if(current(own)&&read===readSequence)readError.value='Git 메타데이터 읽기 범위를 확인하지 못했습니다. 다시 확인해 주세요.';}finally{if(current(own)&&read===readSequence)loading.value=false;}}
 async function cancel(){++generation;++readSequence;const value=proposal.value;proposal.value=null;reviewed.value=false;busy.value=false;loading.value=false;if(value)await cancelProposal(value);}
 async function setActive(value:boolean){if(disposed)return;active=value;if(!value){await cancel();return;}++generation;await refresh();}
 async function select(){if(!active||disposed||busy.value||loading.value||!state.value?.editable)return;const cancelling=cancel(),own=generation;busy.value=true;await cancelling;if(!current(own))return;actionError.value='';notice.value='';try{const next=await bridge.selectGitMetadataReadScope({workstreamId});if(!current(own)){if(next)await cancelProposal(next);return;}proposal.value=next;reviewed.value=false;}catch{if(current(own))actionError.value='공유 Git 폴더를 확인하지 못했습니다. 등록된 프로젝트의 정확한 폴더를 다시 선택해 주세요.';}finally{if(current(own))busy.value=false;}}
 async function confirm(){const value=proposal.value;if(!active||disposed||!value||!reviewed.value||busy.value||!state.value?.editable||state.value.recoveryRequired)return;const own=++generation;++readSequence;busy.value=true;actionError.value='';callbacks.changing?.();try{const next=await bridge.confirmGitMetadataReadScope({proposalId:value.proposalId,metadataReadConfirmed:true});if(!current(own))return;state.value=next;proposal.value=null;reviewed.value=false;notice.value='로컬 커밋 ID·시각 읽기를 허용했습니다. AI 전송 범위는 별도로 다시 확인해 주세요.';callbacks.changed?.();}catch{if(current(own)){actionError.value='읽기 허용 저장 결과를 확인하지 못했습니다. 현재 범위를 다시 확인해 주세요.';reviewed.value=false;await refresh();if(current(own)&&state.value?.recoveryRequired)proposal.value=null;}}finally{if(current(own))busy.value=false;}}
 async function revoke(){const value=state.value;if(!active||disposed||busy.value||loading.value||proposal.value||!value?.revocable)return;const own=++generation;++readSequence;busy.value=true;actionError.value='';notice.value='';callbacks.changing?.();try{const next=await bridge.revokeGitMetadataReadScope({workstreamId,expectedRevision:value.revision});if(!current(own))return;state.value=next;notice.value='로컬 커밋 ID·시각 읽기 허용을 철회했습니다.';callbacks.changed?.();}catch{if(current(own)){actionError.value='읽기 허용 철회를 저장하지 못했습니다. 아직 철회된 것으로 볼 수 없습니다. 현재 범위를 다시 확인해 주세요.';await refresh();}}finally{if(current(own))busy.value=false;}}
 function dispose(){active=false;disposed=true;void cancel();}
 return {state,proposal,busy,loading,reviewed,error,notice,editing,refresh,setActive,select,cancel,confirm,revoke,dispose};
}
</script>
<script setup lang="ts">
import {watch,onUnmounted,nextTick} from 'vue';
const props=defineProps<{workstreamId:string;active:boolean;disabled?:boolean}>();
const emit=defineEmits<{changing:[];changed:[];editing:[value:boolean];recovery:[message:string];tracking:[completion:Promise<void>]}>();
const bridge=new Proxy({} as GitMetadataReadBridge,{get:(_,key)=>(...args:unknown[])=>Reflect.apply(Reflect.get(window.noteApp,key),window.noteApp,args)});
const focusTarget=ref<'select'|'heading'|null>(null);
const actions=createGitMetadataReadSettings(bridge,props.workstreamId,{changing:()=>emit('changing'),changed:()=>{focusTarget.value='heading';emit('changed');}});
const {state,proposal,busy,loading,reviewed,error,notice}=actions;
const selectTrigger=ref<HTMLButtonElement|null>(null),reviewInput=ref<HTMLInputElement|null>(null),scopeHeading=ref<HTMLElement|null>(null);
watch(()=>props.active,value=>{void actions.setActive(value);},{immediate:true,flush:'sync'});
watch(actions.editing,value=>emit('editing',value),{flush:'sync'});
watch(state,value=>{if(value)emit('recovery',value.recoveryRequired?error.value:'');},{flush:'sync'});
watch(proposal,(value,previous)=>{if(!value&&previous&&!focusTarget.value)focusTarget.value='select';void nextTick(()=>{if(props.active&&value)reviewInput.value?.focus({preventScroll:true});});});
watch(()=>[focusTarget.value,props.active,props.disabled,busy.value,proposal.value],()=>{void nextTick(()=>{if(!focusTarget.value||!props.active)return;if(focusTarget.value==='heading'){focusTarget.value=null;scopeHeading.value?.focus({preventScroll:true});return;}if(props.disabled||busy.value||proposal.value)return;focusTarget.value=null;if(selectTrigger.value&&!selectTrigger.value.disabled)selectTrigger.value.focus({preventScroll:true});else scopeHeading.value?.focus({preventScroll:true});});},{flush:'post'});
async function selectScope(){await actions.select();if(props.active&&!proposal.value)focusTarget.value='select';}
function confirmScope(){emit('tracking',actions.confirm());}
function revokeScope(){emit('tracking',actions.revoke());}
onUnmounted(actions.dispose);
</script>
<template>
 <section class="summary-metadata-settings" data-testid="git-metadata-settings" aria-label="로컬 Git 메타데이터 읽기">
  <h4 ref="scopeHeading" tabindex="-1">로컬 커밋 기록 읽기</h4>
  <p class="summary-caption">이 프로젝트가 선언한 커밋 ID·시각만 로컬에서 확인합니다. 소스 코드 본문은 읽거나 전송하지 않습니다. AI 전송 동의는 별도입니다.</p>
  <p v-if="loading" class="summary-caption" role="status">현재 읽기 범위를 확인 중입니다</p>
  <p v-if="error||state?.error" class="summary-state-message summary-error" role="alert" data-testid="git-metadata-error">{{error||state?.error}}</p>
  <p v-if="notice" class="summary-caption" role="status">{{notice}}</p>
  <template v-if="state">
   <p class="summary-caption" data-testid="git-metadata-status">{{state.state==='granted'?'로컬 읽기 허용됨':state.state==='unavailable'?'읽기 범위 확인 필요':'로컬 읽기 미허용'}}</p>
   <dl class="summary-settings-facts summary-metadata-paths">
    <div><dt>작업 폴더</dt><dd>{{state.worktree??'현재 경로 미확인'}}</dd></div>
    <div><dt>공유 Git 폴더</dt><dd>{{state.commonDirectory??'폴더 선택 후 확인'}}</dd></div>
    <div v-if="state.gitDirectory"><dt>작업 Git 폴더</dt><dd>{{state.gitDirectory}}</dd></div>
   </dl>
  </template>
  <div class="summary-inline-actions">
   <button ref="selectTrigger" class="summary-button" data-testid="git-metadata-select" :disabled="disabled||busy||loading||!!proposal||!state?.editable" @click="selectScope">공유 Git 폴더 선택</button>
   <button v-if="state?.revocable" class="summary-text-button" data-testid="git-metadata-revoke" :disabled="disabled||busy||loading||!!proposal||!state?.revocable" @click="revokeScope">로컬 읽기 허용 철회</button>
   <button v-if="error||state?.state==='unavailable'" class="summary-text-button" :disabled="disabled||busy||loading||!!proposal" @click="actions.refresh">현재 범위 다시 확인</button>
  </div>
  <p class="summary-caption">폴더 선택창에서 숨김 폴더(.git)도 표시합니다. 등록된 작업 폴더와 연결된 정확한 공유 Git 폴더를 선택해 주세요.</p>
  <div v-if="proposal" class="summary-metadata-proposal" data-testid="git-metadata-proposal" role="group" aria-label="로컬 읽기 범위 확인">
   <h4>이 경로의 커밋 기록 읽기 허용</h4>
   <dl class="summary-settings-facts summary-metadata-paths"><div><dt>작업 폴더</dt><dd>{{proposal.worktree}}</dd></div><div><dt>공유 Git 폴더</dt><dd>{{proposal.commonDirectory}}</dd></div></dl>
   <label class="summary-check"><input ref="reviewInput" v-model="reviewed" type="checkbox" data-testid="git-metadata-confirm-check" :disabled="busy||disabled"/>이 프로젝트의 커밋 ID·시각만 로컬에서 읽도록 허용합니다</label>
   <p class="summary-caption">소스 코드 본문 읽기·AI 전송·저장소 수정 권한은 부여하지 않습니다. 위 범위 밖의 폴더에는 적용되지 않습니다.</p>
   <div class="summary-inline-actions"><button class="summary-button" data-testid="git-metadata-cancel" @click="actions.cancel">취소</button><button class="summary-button summary-primary" data-testid="git-metadata-confirm" :disabled="!reviewed||busy||disabled||!state?.editable||state?.recoveryRequired" @click="confirmScope">로컬 읽기 허용</button></div>
  </div>
 </section>
</template>
