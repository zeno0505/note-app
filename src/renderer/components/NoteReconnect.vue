<script setup lang="ts">
import {ref,onUnmounted} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import Checkbox from 'primevue/checkbox';
import Message from 'primevue/message';
import type {DagCandidateExclusionReason,NoteReconnectProposal} from '../../shared/note-reconnect';
const exclusionLabels:Record<DagCandidateExclusionReason,string>={document_shape_invalid:'DAG phases/tasks 구조 미지원',invalid_schema:'DAG 조회 결과 형식 미지원',source_limit:'파일 크기 상한 16MiB 초과',query_failed:'DAG 형식 검증 실행 실패',source_unavailable:'파일 접근 미확인',source_changed:'확인 중 파일 변경',output_limit:'조회 출력 상한 초과',unsafe_file:'일반 파일 또는 안전한 파일명 아님'};
const props=defineProps<{workstreamId:string;disabled:boolean}>();
const emit=defineEmits<{changed:[]}>();
const router=useRouter(),route=useRoute();
const visible=ref(false),proposal=ref<NoteReconnectProposal|null>(null),candidateId=ref<string|null>(null),busy=ref(false),confirmed=ref(false),error=ref(''),result=ref('');let disposed=false,generation=0;
async function retire(){generation++;const p=proposal.value;proposal.value=null;candidateId.value=null;confirmed.value=false;if(p)await window.noteApp.cancelNoteReconnect({proposalId:p.proposalId}).catch(()=>{});}
async function close(){visible.value=false;await retire();}
async function open(){await retire();error.value='';result.value='';visible.value=true;}
async function choose(){if(busy.value)return;await retire();const own=++generation;busy.value=true;error.value='';try{const p=await window.noteApp.selectNoteReconnect({workstreamId:props.workstreamId});if(disposed||own!==generation){if(p)await window.noteApp.cancelNoteReconnect({proposalId:p.proposalId});return;}proposal.value=p;}catch(e){if(!disposed&&own===generation)error.value=e instanceof Error?e.message:'선택한 디렉토리를 확인하지 못했습니다.';}finally{busy.value=false;}}
async function apply(){const p=proposal.value;if(!p||!confirmed.value||busy.value||(p.candidates.length&&!candidateId.value))return;busy.value=true;error.value='';try{const r=await window.noteApp.confirmNoteReconnect({proposalId:p.proposalId,candidateId:candidateId.value,linkChangeConfirmed:true});proposal.value=null;visible.value=false;result.value=r.backupPath?'노트를 재연결했습니다. 이전 링크는 백업으로 보존했습니다.':'노트 연결과 선택한 DAG를 확인했습니다.';emit('changed');if(r.workstreamId&&r.workstreamId!==props.workstreamId)await router.replace(route.path.startsWith('/workstream/')?{path:'/workstream/'+encodeURIComponent(r.workstreamId)}:{path:'/',query:{...route.query,project:r.workstreamId}});}catch(e){error.value=e instanceof Error?e.message:'재연결을 완료하지 못했습니다. 기존 자료를 보존했습니다.';await retire();}finally{busy.value=false;confirmed.value=false;}}
onUnmounted(()=>{disposed=true;void retire();});
</script>
<template>
 <Button label="노트 재연결" outlined data-testid="note-reconnect" :disabled="disabled||busy" @click="open"/>
 <Message v-if="result" severity="success" :closable="false" role="status">{{result}}</Message>
 <Dialog :visible="visible" modal header="노트 재연결" class="note-reconnect-dialog" :style="{width:'640px',maxWidth:'calc(100vw - 32px)',maxHeight:'calc(100dvh - 32px)'}" :closable="!busy" :close-on-escape="!busy" @update:visible="value=>{if(!value&&!busy)close()}">
  <div class="reconnect-content">
   <p>이 프로젝트에 연결할 노트 폴더와 DAG를 선택해 주세요. 노트 원본은 수정하지 않습니다.</p>
   <section class="reconnect-step"><h3>노트 디렉토리</h3><p v-if="proposal" data-testid="note-reconnect-directory">{{proposal.directory}}</p><p v-else class="reconnect-muted">아직 선택하지 않았습니다.</p><Button :label="proposal?'디렉토리 다시 선택':'디렉토리 선택'" data-testid="note-reconnect-choose" outlined :loading="busy" :disabled="busy" @click="choose"/></section>
   <Message v-if="error" severity="error" :closable="false" role="alert" data-testid="note-reconnect-error">{{error}}</Message>
   <template v-if="proposal">
    <section class="reconnect-step"><h3>연결할 DAG</h3><template v-if="proposal.candidates.length"><label for="note-reconnect-dag">DAG 형식 검증을 통과한 파일</label><Select v-model="candidateId" input-id="note-reconnect-dag" data-testid="note-reconnect-dag" :options="proposal.candidates" option-label="relativePath" option-value="id" placeholder="DAG 파일을 선택해 주세요" :disabled="busy" @change="confirmed=false"><template #option="{option}"><span class="reconnect-file">{{option.relativePath}}<small>작업 {{option.taskCount}}개 · DAG 형식 확인</small></span></template></Select><p class="reconnect-muted">선택한 디렉토리 안의 파일입니다. 파일 형식 확인은 작업 완료 검증과 별개입니다.</p></template><Message v-else severity="warn" :closable="false" data-testid="note-reconnect-no-dag">DAG 형식에 맞는 YAML 파일이 없습니다. 노트만 연결할 수 있으며 DAG 요약은 사용할 수 없습니다.</Message><p v-if="proposal.excludedCount" class="reconnect-muted">DAG 형식이 아니거나 안전하게 읽을 수 없는 YAML {{proposal.excludedCount}}개는 제외했습니다.</p><ul v-if="proposal.excluded.length" class="reconnect-exclusions" data-testid="note-reconnect-exclusions"><li v-for="entry in proposal.excluded" :key="entry.relativePath">{{entry.relativePath}} · {{exclusionLabels[entry.reason]}} <small>({{entry.reason}})</small></li></ul></section>
    <section class="reconnect-step"><h3>변경 확인</h3><p>프로젝트 링크: {{proposal.linkPath}}</p><p v-if="proposal.previousTarget">기존 링크 대상: {{proposal.previousTarget}}</p><p>현재 읽기 허용 범위 안에서 연결합니다. 기존 일반 파일·디렉토리는 덮어쓰지 않으며, 이전 링크는 백업으로 보존합니다. Git 설정과 노트 내용은 바꾸지 않습니다.</p><div class="reconnect-confirm"><Checkbox v-model="confirmed" binary input-id="note-reconnect-confirm" data-testid="note-reconnect-confirm" :disabled="busy||!!proposal.candidates.length&&!candidateId"/><label for="note-reconnect-confirm">{{proposal.candidates.length?'선택한 노트 디렉토리와 DAG, 링크 변경을 확인했습니다':'DAG 없이 노트 디렉토리만 연결함을 확인했습니다'}}</label></div></section>
   </template>
  </div>
  <template #footer><Button label="취소" severity="secondary" outlined :disabled="busy" @click="close"/><Button label="재연결 확인" data-testid="note-reconnect-apply" :loading="busy" :disabled="!proposal||!confirmed||busy||!!proposal.candidates.length&&!candidateId" @click="apply"/></template>
 </Dialog>
</template>
<style scoped>
.reconnect-content{display:grid;gap:20px;overflow-wrap:anywhere;color:var(--p-dialog-color)}.reconnect-step{display:grid;gap:12px;padding-top:16px;border-top:1px solid var(--p-content-border-color)}.reconnect-step h3{font-size:1rem;margin:0}.reconnect-step .p-select{width:100%;min-width:0}.reconnect-step>.p-button{justify-self:start}.reconnect-muted,.reconnect-file small{color:var(--p-text-muted-color);font-size:.875rem}.reconnect-file{display:grid;gap:4px;overflow-wrap:anywhere}.reconnect-exclusions{margin:0;padding-left:20px;font-size:.875rem;color:var(--p-text-muted-color)}.reconnect-confirm{display:flex;gap:12px;align-items:flex-start}.reconnect-confirm label{line-height:1.5;cursor:pointer}.reconnect-confirm .p-checkbox{flex-shrink:0;margin-top:2px}
</style>
