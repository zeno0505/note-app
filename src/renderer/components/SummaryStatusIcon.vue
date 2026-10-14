<script setup lang="ts">
defineProps<{kind:string;label:string;shape?:string}>();
</script>
<template>
 <span class="summary-status-icon" :class="'summary-status-'+kind" role="img" :aria-label="label" :title="label" tabindex="0">
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
   <template v-if="shape==='check'"><circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/></template>
   <template v-else-if="shape==='progress'"><path d="M20.5 14.8A9 9 0 1 1 17 4.5"/><circle cx="20" cy="5" r="2" fill="currentColor" stroke="none"/></template>
   <template v-else-if="shape==='clock'"><circle cx="12" cy="12" r="9"/><path d="M12 6v7h5"/></template>
   <template v-else-if="shape==='pause'"><circle cx="12" cy="12" r="9"/><path d="M9 8v8m6-8v8"/></template>
   <template v-else-if="shape==='alert'"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/></template>
   <template v-else><circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4m0 3h.01"/></template>
  </svg>
  <span class="summary-icon-tooltip" aria-hidden="true">{{label}}</span>
 </span>
</template>
