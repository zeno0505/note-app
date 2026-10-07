<script setup lang="ts">
import {ref,onUnmounted} from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import type {NoteReconnectProposal} from '../../shared/note-reconnect';
const props=defineProps<{workstreamId:string;disabled:boolean}>();
const emit=defineEmits<{changed:[]}>();
const proposal=ref<NoteReconnectProposal|null>(null),busy=ref(false),confirmed=ref(false),error=ref(''),result=ref('');let disposed=false,generation=0;
async function cancel(){generation++;const p=proposal.value;proposal.value=null;confirmed.value=false;if(p)await window.noteApp.cancelNoteReconnect({proposalId:p.proposalId}).catch(()=>{});}
async function choose(){if(busy.value)return;await cancel();const own=++generation;busy.value=true;error.value='';result.value='';try{const p=await window.noteApp.selectNoteReconnect({workstreamId:props.workstreamId});if(disposed||own!==generation){if(p)await window.noteApp.cancelNoteReconnect({proposalId:p.proposalId});return;}proposal.value=p;}catch(e){if(!disposed&&own===generation)error.value=e instanceof Error?e.message:'선택한 디렉토리를 확인하지 못했습니다.';}finally{busy.value=false;}}
async function apply(){const p=proposal.value;if(!p||!confirmed.value||busy.value)return;busy.value=true;error.value='';try{const r=await window.noteApp.confirmNoteReconnect({proposalId:p.proposalId,linkChangeConfirmed:true});proposal.value=null;result.value=r.backupPath?'재연결했습니다. 이전 링크 보존 경로: '+r.backupPath:'선택한 노트 디렉토리로 연결을 확인했습니다.';emit('changed');}catch(e){error.value=e instanceof Error?e.message:'재연결을 완료하지 못했습니다. 기존 자료를 보존했습니다.';proposal.value=null;}finally{busy.value=false;confirmed.value=false;}}
onUnmounted(()=>{disposed=true;void cancel();});
</script>
<template>
 <Button label="재연결" outlined data-testid="note-reconnect" :disabled="disabled||busy" :loading="busy" @click="choose"/>
 <p v-if="error" role="alert" data-testid="note-reconnect-error">{{error}}</p><p v-if="result" role="status">{{result}}</p>
 <Dialog :visible="!!proposal" modal header="노트 재연결" :closable="!busy" :style="{width:'min(640px,90vw)'}" @update:visible="value=>{if(!value&&!busy)cancel()}">
  <template v-if="proposal"><p>선택한 노트 디렉토리: {{proposal.directory}}</p><p>프로젝트 링크: {{proposal.linkPath}}</p><p v-if="proposal.previousTarget">기존 링크 대상: {{proposal.previousTarget}}</p><p>{{proposal.dag==='absent'?'선택한 디렉토리에 dag.yaml / dag.yml이 없습니다. 노트 연결 후에도 DAG 요약은 실행할 수 없습니다.':'DAG 파일이 있습니다. 내용 조회 성공 여부는 연결 후 확인합니다.'}}</p><p>읽기 허용 범위 안의 디렉토리만 연결합니다. 기존 일반 파일·디렉토리는 덮어쓰지 않으며, 다른 링크는 백업으로 보존합니다.</p><p>선택한 디렉토리의 노트 내용과 공유 링크·Git 설정은 변경하지 않습니다.</p><label><input v-model="confirmed" type="checkbox" data-testid="note-reconnect-confirm"> 이 프로젝트의 노트 디렉토리와 링크 변경을 확인했습니다</label><div><Button label="다시 선택" :disabled="busy" @click="choose"/><Button label="취소" :disabled="busy" @click="cancel"/><Button label="재연결 확인" data-testid="note-reconnect-apply" :disabled="!confirmed||busy" @click="apply"/></div></template>
 </Dialog>
</template>
