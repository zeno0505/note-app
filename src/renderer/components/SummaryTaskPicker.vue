<script setup lang="ts">
import {computed,ref} from 'vue';
import type {SummaryReviewView} from '../../shared/summary-review';
import {summaryTaskStatus} from '../summary-review-state';
import SummaryStatusIcon from './SummaryStatusIcon.vue';
const props=defineProps<{tasks:SummaryReviewView['tasks'];modelValue:string[];disabled?:boolean}>();
const emit=defineEmits<{'update:modelValue':[ids:string[]];run:[]}>();
const prefix=ref(''),search=ref('');
const taskPrefix=(id:string)=>/^(.+?)[-_/]?\d+$/.exec(id)?.[1]?.replace(/[-_/]$/,'')??id.split(/[-_/]/)[0];
const prefixes=computed(()=>[...new Set(props.tasks.map(t=>taskPrefix(t.id)))].sort());
const filtered=computed(()=>props.tasks.filter(t=>(!prefix.value||taskPrefix(t.id)===prefix.value)&&(!search.value.trim()||(t.id+' '+(t.title??'')).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))));
const outside=computed(()=>props.modelValue.filter(id=>!filtered.value.some(t=>t.id===id)).length);
const missing=computed(()=>props.modelValue.filter(id=>!props.tasks.some(t=>t.id===id)));
function toggle(id:string,checked:boolean){if(props.disabled)return;const next=checked?[...props.modelValue,id]:props.modelValue.filter(value=>value!==id);if(next.length<=20)emit('update:modelValue',next);}
</script>
<template>
 <section class="summary-picker" data-testid="summary-task-picker">
  <div class="summary-picker-heading"><h4>작업 {{modelValue.length}}개 선택</h4><label class="summary-prefix-filter"><span class="summary-sr-only">접두사 필터</span><select v-model="prefix" data-testid="summary-prefix-filter" :disabled="disabled"><option value="">접두사: 전체</option><option v-for="item in prefixes" :key="item" :value="item">접두사: {{item}}</option></select></label></div>
  <label class="summary-sr-only" for="summary-task-search">이름 또는 ID 검색</label><input id="summary-task-search" v-model="search" type="search" placeholder="이름 또는 ID 검색" data-testid="summary-task-search" :disabled="disabled"/>
  <p v-if="missing.length" class="summary-inline-warning" role="alert">현재 DAG에 없는 선택: {{missing.join(' · ')}}. 선택을 비우고 다시 골라 주세요.</p>
  <ul class="summary-picker-list"><li v-for="task in filtered" :key="task.id"><label><input type="checkbox" :data-testid="'summary-task-check-'+task.id" :checked="modelValue.includes(task.id)" :disabled="disabled||!modelValue.includes(task.id)&&modelValue.length>=20" :aria-label="task.id+' '+(task.title??'제목 미선언')" @change="toggle(task.id,($event.target as HTMLInputElement).checked)"/><strong>{{task.id}}</strong><span>{{task.title??'제목 미선언'}}</span></label><SummaryStatusIcon v-bind="summaryTaskStatus(task.status)"/></li></ul>
  <p v-if="!filtered.length" class="summary-caption">{{tasks.length?'검색 결과가 없습니다.':'선택할 작업을 읽지 못했습니다.'}}</p>
  <div class="summary-inline-actions"><button type="button" class="summary-button" data-testid="summary-task-clear" :disabled="disabled||!modelValue.length" @click="emit('update:modelValue',[])">선택 비우기</button><button type="button" class="summary-button summary-primary" data-testid="summary-task-run" :disabled="disabled||!modelValue.length||modelValue.length>20||!!missing.length" @click="emit('run')">{{modelValue.length}}개 요약</button></div>
  <p class="summary-caption" role="status">{{modelValue.length}} / 20 · 필터 밖 선택 {{outside}}</p>
 </section>
</template>
