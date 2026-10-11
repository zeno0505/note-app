<script setup lang="ts">
import {ref,watch,onUnmounted} from 'vue';
import Button from 'primevue/button';
import type {OrcaProjectOpenAvailability} from '../../shared/orca-project-open';
import {liveState} from '../store';
const props=defineProps<{workstreamId:string}>();
const availability=ref<OrcaProjectOpenAvailability|null>(null),busy=ref(false),message=ref('');let generation=0,disposed=false;
watch([()=>props.workstreamId,()=>liveState.value?.observedAt,()=>liveState.value?.connection],async()=>{const current=++generation;message.value='';availability.value=null;try{const result=await window.noteApp.getOrcaProjectOpenAvailability({workstreamId:props.workstreamId});if(!disposed&&current===generation)availability.value=result;}catch{if(!disposed&&current===generation)availability.value={available:false,reason:'unavailable'};}},{immediate:true});
onUnmounted(()=>{disposed=true;generation++;});
async function open(){if(busy.value||!availability.value?.available)return;busy.value=true;message.value='';const id=props.workstreamId;try{const result=await window.noteApp.openProjectInOrca({workstreamId:id});if(disposed||id!==props.workstreamId)return;message.value=result.ok?'Orca에서 이 워크트리의 DAG 파일을 열었어요. AI 모델은 실행하지 않았습니다.':result.attempted?'Orca 열기 결과를 확인하지 못했어요. Orca 화면을 먼저 확인한 뒤 다시 시도하세요.':result.reason==='unsupported_version'?'현재 Orca 버전의 안전한 이동 계약을 확인하지 못했습니다.':'현재 대상과 Orca 연결을 확인하지 못했어요. 소스를 새로 조회한 뒤 다시 시도하세요.';}catch{message.value='Orca 대상 상태를 확인하지 못했어요.';}finally{busy.value=false;}}
</script>
<template><div class="orca-project-open"><Button label="Orca에서 DAG 열기" outlined size="small" :disabled="!availability?.available" :loading="busy" @click="open"/><span v-if="!availability?.available" class="muted">{{availability?.reason==='external-note'?'워크트리 밖의 노트는 Orca 이동 검증이 필요합니다':'현재 로컬 워크트리와 내부 DAG 연결 확인이 필요합니다'}}</span><p v-if="message" role="status">{{message}}</p><small v-else-if="availability?.available" class="muted">파일 화면만 엽니다 · AI 실행 별도</small></div></template>
<style scoped>.orca-project-open{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}.orca-project-open>span,.orca-project-open>small,.orca-project-open>p{font-size:.8rem}.orca-project-open>p{flex-basis:100%;margin:0}</style>
