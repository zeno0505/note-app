<script setup lang="ts">
import {ref,onMounted,onUnmounted,useId} from 'vue';
import Tooltip from 'primevue/tooltip';
defineProps<{label:string;hint:string;text:string}>();
const vTooltip=Tooltip,trigger=ref<HTMLButtonElement|null>(null);
const descriptionId=useId()+'-help';
// Installed PrimeVue has separate hover/focus event modes. Feed pointer hover
// and pointer activation into its public focus events, using one tooltip/ID.
function showHelp(){trigger.value?.dispatchEvent(new FocusEvent('focus'));}
function hideHelp(){trigger.value?.dispatchEvent(new FocusEvent('blur'));}
function leavePointer(event:MouseEvent){if(!(event.relatedTarget instanceof Element)||!event.relatedTarget.closest('.info-tooltip'))hideHelp();}
function escape(event:KeyboardEvent){if(event.key==='Escape')hideHelp();}
onMounted(()=>document.addEventListener('keydown',escape));
onUnmounted(()=>document.removeEventListener('keydown',escape));
</script>
<template>
 <button ref="trigger" v-tooltip.bottom.focus="{id:descriptionId,value:text,escape:true,autoHide:false,class:'info-tooltip'}" type="button" class="info-trigger" :aria-label="label" :aria-describedby="descriptionId" @mouseenter="showHelp" @mouseleave="leavePointer" @click="showHelp"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10v7" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="7" r="1.2" fill="currentColor"/></svg><span>{{hint}}</span></button>
</template>
