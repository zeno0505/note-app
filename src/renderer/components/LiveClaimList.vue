<script setup lang="ts">
import type { ClaimView } from '../../summary/claims';
import {aspectLabels,freshnessLabels} from '../live-labels';
import {formatTime} from '../store';
defineProps<{claims:ClaimView[];emptyText:string;historical?:boolean}>();
</script>
<template>
  <ul v-if="claims.length" class="live-claim-list">
    <li v-for="view in claims" :key="view.claim.claimId">
      <div class="claim-meta"><span>{{aspectLabels[view.claim.aspect]}}</span><span class="claim-tag" :class="{'stale-tag':historical||view.freshness!=='current'}">{{historical&&view.freshness==='current'?'이전 관측 기준 일치':freshnessLabels[view.freshness]}}</span><span class="claim-tag">{{view.claim.kind==='fact'?'출처 인용':view.claim.kind==='inference'?'추론':'미확인'}}</span><span v-if="view.claim.intent==='proposal'" class="claim-tag">제안 · 실행 승인 아님</span></div>
      <p>{{view.claim.text}}</p>
      <p v-if="view.reasons.length" class="muted claim-reasons">최신성 근거: {{view.reasons.join(' · ')}}</p>
      <details v-if="view.claim.citations.length" class="claim-citations"><summary>인용 근거 {{view.claim.citations.length}}개</summary><div v-for="(citation,index) in view.claim.citations" :key="index" class="citation"><p>{{citation.quote}}</p><p class="muted">{{citation.sourceId}} · {{formatTime(citation.observedAt)}}</p><p class="muted">{{citation.sourceHash}}</p></div></details>
    </li>
  </ul>
  <p v-else class="muted">{{emptyText}}</p>
</template>
