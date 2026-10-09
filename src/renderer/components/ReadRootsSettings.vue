<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue';
import {AI_TRANSFER_WARNING} from '../../shared/ai-transfer';
import type {ReadRootsView,ReadRootProposal,ReadRootView} from '../../shared/read-roots';
const state=ref<ReadRootsView|null>(null),proposal=ref<ReadRootProposal|null>(null),removing=ref<ReadRootView|null>(null);
const busy=ref(false),reviewed=ref(false),error=ref(''),message=ref('');let disposed=false;
async function load(){try{const next=await window.noteApp.getReadRoots();if(!disposed)state.value=next;}catch{error.value='읽기 허용 폴더 설정을 확인하지 못했습니다.';}}
onMounted(load);
onUnmounted(()=>{disposed=true;if(proposal.value)void window.noteApp.cancelReadRoot({proposalId:proposal.value.proposalId}).catch(()=>{});});
async function select(){if(busy.value)return;await cancel();busy.value=true;error.value='';message.value='';try{const next=await window.noteApp.selectReadRoot();if(disposed&&next){await window.noteApp.cancelReadRoot({proposalId:next.proposalId});return;}proposal.value=next;reviewed.value=false;}catch{error.value='폴더를 확인하지 못했습니다. 앱 허용 목록과 macOS 접근 권한을 각각 확인해 주세요.';}finally{busy.value=false;}}
async function cancel(){if(proposal.value)await window.noteApp.cancelReadRoot({proposalId:proposal.value.proposalId}).catch(()=>{});proposal.value=null;removing.value=null;reviewed.value=false;}
async function confirm(){if(!proposal.value||!reviewed.value||busy.value)return;busy.value=true;error.value='';try{state.value=await window.noteApp.confirmReadRoot({proposalId:proposal.value.proposalId,readOnlyConfirmed:true});proposal.value=null;reviewed.value=false;message.value='읽기 허용을 저장했습니다. 소스 연결을 중단했으며, 다시 연결하면 허용 범위만 조회합니다.';}catch{error.value='확인을 저장하지 못했습니다. 경로 변경·만료·저장 위치를 확인하고 다시 선택해 주세요.';}finally{busy.value=false;}}
async function revoke(){if(!removing.value||!reviewed.value||!state.value||busy.value)return;busy.value=true;error.value='';try{state.value=await window.noteApp.revokeReadRoot({rootId:removing.value.id,expectedRevision:state.value.revision,confirmed:true});removing.value=null;reviewed.value=false;message.value='허용을 철회하고 새 읽기를 중단했습니다. 기존 설명과 프로젝트 이력은 보존합니다.';}catch{error.value='허용 철회를 저장하지 못했습니다. 목록을 다시 확인해 주세요.';await load();}finally{busy.value=false;}}
</script>
<template>
  <section class="read-roots-settings" data-testid="read-roots-settings" aria-labelledby="read-roots-heading">
    <h2 id="read-roots-heading">노트 읽기 허용 폴더</h2><p class="notice warning" data-testid="read-root-ai-warning">{{AI_TRANSFER_WARNING}}</p>
    <p>이 목록은 앱의 읽기 허용 범위입니다. macOS의 접근 권한을 대신 부여하지 않습니다. 실행 파일과 노트 쓰기 권한은 별도입니다.</p>
    <p>허용 폴더 안을 재귀적으로 수집하지 않습니다. Orca가 지정한 <code>docs/note</code> 프로젝트와 고정 DAG, 그 프로젝트의 명시된 문서 링크만 제한적으로 확인합니다.</p>
    <p v-if="state?.error" role="alert" class="warning-text">{{state.error}}</p><p v-if="error" role="alert" class="warning-text">{{error}}</p><p v-if="message" role="status">{{message}}</p>
    <ul v-if="state?.roots.length" class="read-roots-list"><li v-for="root in state.roots" :key="root.id"><div><strong>{{root.path}}</strong><p>{{root.kind==='vault'?'하위 프로젝트 읽기 허용':'기존 시작 설정의 프로젝트 범위'}} · {{root.available?'폴더 확인됨':'현재 폴더 접근 불가 · 읽기 중단'}}</p></div><button :disabled="busy||!state.editable" @click="cancel().then(()=>{removing=root;reviewed=false})">허용 철회 검토</button></li></ul>
    <p v-else-if="state" class="muted">허용된 읽기 폴더가 없습니다. 과거 설명은 읽기 허용을 새로 부여하지 않습니다.</p>
    <button :disabled="busy||!state?.editable" @click="select">읽기 허용 폴더 선택</button>
    <div v-if="proposal" class="root-review" data-testid="read-root-review"><h3>읽기 범위 확인</h3><p><strong>{{proposal.path}}</strong></p><p>이 정규 경로 아래에서 Orca가 지정한 프로젝트 노트를 읽도록 허용합니다. 프로젝트 폴더·DAG·wikilink의 경계를 다시 검사하며, 노트를 편집하거나 전체 vault를 검색하지 않습니다. 겹치는 기존 범위는 하나로 정리합니다.</p><label><input v-model="reviewed" type="checkbox"> 이 폴더의 읽기 범위와 수동 AI 전송 안내를 확인했습니다</label><div><button :disabled="busy||!reviewed" @click="confirm">확인하고 읽기 허용 저장</button><button :disabled="busy" @click="cancel">취소</button></div></div>
    <div v-if="removing" class="root-review" data-testid="read-root-revoke-review"><h3>읽기 허용 철회</h3><p><strong>{{removing.path}}</strong></p><p>해당 범위의 새 읽기를 중단합니다. 진행 중인 소스 연결과 검토 후보를 취소하고 과거 설명·이력은 보존합니다.</p><label><input v-model="reviewed" type="checkbox"> 읽기 허용 철회 범위를 확인했습니다</label><div><button :disabled="busy||!reviewed" @click="revoke">확인하고 허용 철회</button><button :disabled="busy" @click="cancel">취소</button></div></div>
  </section>
</template>
