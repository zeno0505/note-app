<script setup lang="ts">
import review from '../../shared/public-model-review.json';
const titles:Record<string,string>={implemented:'현재 어디까지 구현되었나요?',next:'다음에는 무엇을 구현하나요?',evidence:'완료 판단에 어떤 근거가 있나요?',decisions:'논의하거나 결정할 일이 있나요?'};
</script>
<template>
  <details class="public-model-review" data-testid="public-model-review"><summary>공개 note-app 모델 요약 검증 결과</summary>
    <p class="muted">승인된 공개 소스 한 건의 저장 결과입니다. 현재 프로젝트 전체의 요약과 별개이며 이 화면을 열어도 모델을 호출하지 않습니다.</p>
    <p class="muted">Claude 로그인 CLI · 생성 {{review.generationRequests}}회 · 수정 {{review.repairRequests}}회 · 동일 입력 추가 요청 {{review.duplicateAdditionalRequests}}회 · {{(review.runtimeMs/1000).toFixed(1)}}초</p>
    <section v-for="section in review.sections" :key="section.id"><h3>{{titles[section.id]}}</h3><p>{{section.text}}</p><small class="muted">공개 근거 {{section.sourceIds.join(' · ')}}</small></section>
    <p class="notice warning">{{review.manualReview.note}}</p>
    <details><summary>입력과 사용량 근거</summary><dl><dt>공개 입력 SHA</dt><dd>{{review.sourceSha}}</dd><dt>입력 해시</dt><dd>{{review.inputHash}}</dd><dt>실측 token</dt><dd>일반 입력 {{review.usage.input_tokens}} · 캐시 생성 입력 {{review.usage.cache_creation_input_tokens}} · 출력 {{review.usage.output_tokens}}</dd><dt>응답 기록</dt><dd>{{review.reportedTurns}} turns · 앱 생성 요청 {{review.generationRequests}}회. 사용량은 반환 관측이며 구독 청구액을 보장하지 않습니다.</dd></dl><ul><li v-for="source in review.sources" :key="source.id">{{source.id}} · {{source.path}} · {{source.lineStart}}–{{source.lineEnd}}행</li></ul></details>
  </details>
</template>
