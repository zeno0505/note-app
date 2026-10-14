<script setup lang="ts">
import {ref,nextTick} from 'vue';
import Dialog from 'primevue/dialog';
defineProps<{label:string;hint:string}>();
const open=ref(false),trigger=ref<HTMLButtonElement|null>(null);
let scrollPosition={left:0,top:0};
function show(){scrollPosition={left:window.scrollX,top:window.scrollY};open.value=true;}
function restoreScroll(){window.scrollTo(scrollPosition);}
function restoreFocus(){void nextTick(()=>{trigger.value?.focus({preventScroll:true});restoreScroll();});}
</script>
<template>
 <button ref="trigger" type="button" class="info-trigger" :aria-label="label" :title="label" aria-haspopup="dialog" :aria-expanded="open" @click="show"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10v7" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="7" r="1.2" fill="currentColor"/></svg><span>{{hint}}</span></button>
 <Dialog v-model:visible="open" modal :header="label" :style="{width:'min(640px,92vw)'}" @hide="restoreFocus" @after-hide="restoreFocus"><div class="info-dialog-body"><slot/></div></Dialog>
</template>
