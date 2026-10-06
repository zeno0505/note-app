<script setup lang="ts">
import type {ReadingSummary} from '../../shared/reading-summary';
import {formatTime} from '../store';
defineProps<{summary:ReadingSummary;historical:boolean}>();
</script>
<template>
  <section class="reading-summary" data-testid="reading-summary">
    <h3>프로젝트 읽기 요약</h3>
    <p class="muted">규칙 기반 설명 · 모델 호출 없음 · 사용자 승인 요약과 별도</p>
    <p v-if="historical" class="warning-text">현재 근거 재확인 안 됨 · 아래 설명은 이전 관측입니다</p>
    <p v-else class="muted">{{summary.changed?'관측 내용 변경으로 설명을 갱신했습니다':'내용 변경이 없어 이전 설명을 유지했습니다'}}</p>
    <p class="muted">설명 갱신 {{formatTime(summary.generatedAt)}} · 마지막 확인 {{formatTime(summary.checkedAt)}}</p>
    <p v-if="summary.partial" class="warning-text">부분 관측 또는 미확인 근거가 있습니다</p>
    <section v-for="section in summary.sections" :key="section.id" class="claim-section">
      <h4>{{section.title}}</h4>
      <div v-for="(paragraph,index) in section.paragraphs" :key="index">
        <p>{{paragraph.text}}</p>
        <details v-if="paragraph.sources.length" class="claim-citations"><summary>출처 · {{paragraph.basis==='declaration'?'원문 선언':paragraph.basis==='proposal'?'제안':paragraph.basis==='unknown'?'미확인':'관측'}}</summary>
          <p v-for="(source,sourceIndex) in paragraph.sources" :key="sourceIndex" class="muted">{{source.kind}} · {{source.id}}<br/>SHA {{source.sha??'미확인'}} · 출처 해시 {{source.sourceHash??'미확인'}}<br/>관측 {{source.observedAt?formatTime(source.observedAt):'미확인'}}<template v-if="source.document"><br/>등록 문서 {{source.document.relativePath}} · {{source.document.lineStart}}–{{source.document.lineEnd}}행<br/>검증 환경 {{source.document.environment??'미등록'}} · 문서 보고 결과 {{source.document.result??'검증 기록 없음'}}<br/>문서의 참조 선언 {{source.document.references.join(', ')||'없음'}}</template></p>
        </details>
      </div>
    </section>
    <p class="scope-note">{{summary.limitation}}</p>
  </section>
</template>
