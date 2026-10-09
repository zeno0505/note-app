<script setup lang="ts">
import type { SummaryClaim } from '../../domain';
defineProps<{claims:SummaryClaim[];emptyText?:string}>();
</script>
<template><ul v-if="claims.length" class="claim-list"><li v-for="claim in claims" :key="claim.id"><span v-if="claim.freshness==='stale'" class="claim-tag stale-tag">이전 관측</span><span v-if="claim.kind==='unknown'" class="claim-tag">미확인</span><span v-else-if="claim.kind==='inference'" class="claim-tag">추론</span>{{claim.text}}</li></ul><p v-else class="muted">{{emptyText??'확인된 내용이 없습니다'}}</p></template>
