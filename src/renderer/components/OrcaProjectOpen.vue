<script setup lang="ts">
import {ref,watch,onUnmounted} from 'vue';
import Button from 'primevue/button';
import type {OrcaProjectOpenAvailability,OrcaProjectOpenAvailabilityReason} from '../../shared/orca-project-open';
import {liveState} from '../store';
const props=defineProps<{workstreamId:string}>();
const availability=ref<OrcaProjectOpenAvailability|null>(null),busy=ref(false),message=ref('');let generation=0,disposed=false;
watch([()=>props.workstreamId,()=>liveState.value?.observedAt,()=>liveState.value?.connection,()=>liveState.value?.refreshing,()=>liveState.value?.freshness,()=>JSON.stringify(liveState.value?.workstreams.find(w=>w.id===props.workstreamId)?.noteMapping)],async()=>{const current=++generation;availability.value=null;try{const result=await window.noteApp.getOrcaProjectOpenAvailability({workstreamId:props.workstreamId});if(!disposed&&current===generation)availability.value=result;}catch{if(!disposed&&current===generation)availability.value={available:false,reason:'unavailable'};}},{immediate:true});
const reasonText:Record<OrcaProjectOpenAvailabilityReason,string>={
 ready:'',unavailable:'로컬 대상 정보를 확인할 수 없습니다. 소스를 새로고침해 주세요.',
 'external-note':'노트 파일의 경로 검증이 필요합니다.',disconnected:'소스 연결이 해제돼 있습니다. 연결 후 다시 확인해 주세요.',
 collecting:'워크트리 정보를 조회 중입니다. 완료 후 다시 확인합니다.',
 'mapping-unverified':'이 프로젝트의 노트·DAG 연결이 검증되지 않았습니다. 프로젝트 설정에서 연결을 확인해 주세요.',
 'ambiguous-worktree':'정확한 로컬 워크트리를 하나로 확인할 수 없습니다. 프로젝트 연결을 확인해 주세요.',
 'permission-denied':'이 노트 폴더의 읽기 허용이 필요합니다. 연결 및 설정에서 확인해 주세요.',
 'unsafe-path':'노트 파일 또는 링크 경로가 안전한 연결과 일치하지 않습니다. 프로젝트 연결을 확인해 주세요.',
 'binding-changed':'프로젝트·워크트리 연결이 변경됐습니다. 소스를 새로고침해 주세요.'};
watch([()=>props.workstreamId,()=>liveState.value?.connection,()=>JSON.stringify(liveState.value?.workstreams.find(w=>w.id===props.workstreamId)?.noteMapping)],()=>{message.value='';});
onUnmounted(()=>{disposed=true;generation++;});
async function open(){if(busy.value||!availability.value?.available)return;busy.value=true;message.value='';const id=props.workstreamId;try{const result=await window.noteApp.openProjectInOrca({workstreamId:id});if(disposed||id!==props.workstreamId)return;message.value=result.ok?'Orca가 이 워크트리의 DAG 열기 요청을 확인했습니다. AI 모델은 실행하지 않았습니다.':result.reason==='access_denied'?'Orca가 이 노트 경로의 접근을 거절했습니다. Orca에 허용된 폴더인지 확인해 주세요.':result.reason==='runtime_changed'?'Orca 실행 상태가 변경됐습니다. 소스를 새로고침한 뒤 다시 시도하세요.':result.reason==='selection_changed'?'워크트리 또는 파일 연결이 변경됐습니다. 소스를 다시 확인해 주세요.':result.attempted?'Orca 열기 결과를 확인하지 못했어요. Orca 화면을 먼저 확인한 뒤 다시 시도하세요.':result.reason==='unsupported_version'?'현재 Orca 버전의 안전한 이동 계약을 확인하지 못했습니다.':'현재 대상과 Orca 연결을 확인하지 못했어요. 소스를 새로 조회한 뒤 다시 시도하세요.';}catch{message.value='Orca 대상 상태를 확인하지 못했어요.';}finally{busy.value=false;}}
</script>
<template><div class="orca-project-open"><Button label="Orca에서 DAG 열기" outlined size="small" :disabled="!availability?.available" :loading="busy" @click="open"/><span v-if="!availability?.available" class="muted">{{availability?reasonText[availability.reason]:'파일 경로를 확인하고 있습니다.'}}</span><p v-if="message" role="status">{{message}}</p><small v-else-if="availability?.available" class="muted">클릭할 때 Orca 대상 재확인 · AI 실행 별도</small></div></template>
<style scoped>.orca-project-open{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}.orca-project-open>span,.orca-project-open>small,.orca-project-open>p{font-size:.8rem}.orca-project-open>p{flex-basis:100%;margin:0}</style>
