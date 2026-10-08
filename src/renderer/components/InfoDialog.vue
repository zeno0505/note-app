<script setup lang="ts">
import {ref,nextTick} from 'vue';
import Dialog from 'primevue/dialog';
defineProps<{label:string}>();
const open=ref(false),trigger=ref<HTMLButtonElement|null>(null);
function restoreFocus(){void nextTick(()=>trigger.value?.focus());}
</script>
<template>
 <button ref="trigger" type="button" class="info-trigger" :aria-label="label" :title="label" aria-haspopup="dialog" :aria-expanded="open" @click="open=true"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10v7" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="7" r="1.2" fill="currentColor"/></svg></button>
 <Dialog v-model:visible="open" modal :header="label" :style="{width:'min(640px,92vw)'}" @hide="restoreFocus"><div class="info-dialog-body"><slot/></div></Dialog>
</template>
