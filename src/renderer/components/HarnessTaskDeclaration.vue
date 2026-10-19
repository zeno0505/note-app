<script setup lang="ts">
import type {HarnessLedgerHeader,HarnessTaskDeclaration} from '../../phase2/harness-ledger';
defineProps<{ledger?:HarnessLedgerHeader;declaration?:HarnessTaskDeclaration}>();
const checks=(value:unknown)=>value==null?[]:Array.isArray(value)?value:[value];
const makers=(value:unknown)=>[...new Set(checks(value).map(item=>{if(!item||typeof item!=='object')return '미확인';const record=item as Record<string,unknown>;const check=record.check&&typeof record.check==='object'?record.check as Record<string,unknown>:record;return typeof check.made_by==='string'?check.made_by:!record.check&&typeof record.repo==='string'&&typeof record.path==='string'?'human (짧은 참조)':'미확인';}))].join(', ');
const show=(value:unknown)=>value==null?'미선언':typeof value==='string'?value:JSON.stringify(value,null,2);
</script>
<template>
 <section v-if="ledger" class="harness-declarations" aria-label="장부 형식과 v3 선언" data-testid="harness-declarations">
  <h4>장부 형식</h4>
  <p v-if="ledger.state!=='supported'" role="status">{{ledger.state==='unsupported-format'?'형식 미지원':'schema 미확인'}} · schema {{show(ledger.schema)}}. v3 선언을 추정하지 않습니다.</p>
  <dl><dt>schema · profile</dt><dd>{{show(ledger.schema)}} · {{show(ledger.profile)}}</dd><dt>ledger_key</dt><dd>{{show(ledger.ledgerKey)}}</dd><dt>features (힌트)</dt><dd>{{ledger.features.join(', ')||'선언 없음'}}</dd></dl>
  <p v-if="ledger.unsupportedFeatures.length" role="status">기능 미지원: {{ledger.unsupportedFeatures.join(', ')}}</p>
  <details v-if="ledger.observedFeatures.length"><summary>실제 필드 관측</summary><p>{{ledger.observedFeatures.join(', ')}}</p></details>
  <template v-if="declaration">
   <h4>판정 (선언)</h4><p>leaf: {{show(declaration.judgment?.leaf)}} · verdict: {{show(declaration.judgment?.verdict)}}</p><details v-if="declaration.judgment"><summary>판정 원문</summary><pre>{{show(declaration.judgment)}}</pre></details>
   <p class="notice warning" data-testid="harness-verification-unknown">{{declaration.verificationState}}. met은 장부의 선언입니다. 실행 기록을 검사별 통과로 연결하지 않습니다.</p>
   <dl v-if="declaration.who||declaration.question"><dt>결정 담당 · who</dt><dd>{{show(declaration.who)}}</dd><dt>결정 질문 · question</dt><dd>{{show(declaration.question)}}</dd></dl>
   <details v-if="declaration.block"><summary>태스크 차단 (선언)</summary><pre>{{show(declaration.block)}}</pre></details>
   <h4>수용 기준 · AC (선언)</h4><p>검사 작성자 made_by는 작성 선언이며 실행 증거가 아닙니다.</p><p v-if="!declaration.acceptance.length">기록 미확인</p>
   <article v-for="(ac,index) in declaration.acceptance" :key="index" class="harness-ac">
    <h5>{{show(ac.id)}}</h5><p>{{show(ac.expect)}}</p><p v-if="ac.met!=null">met 선언: {{show(ac.met)}}</p>
    <p v-if="ac.forbidden!=null">금지: {{show(ac.forbidden)}}</p><p v-if="ac.observe_by!=null">관측 방법: {{show(ac.observe_by)}}</p>
    <details v-if="ac.block"><summary>AC 차단</summary><pre>{{show(ac.block)}}</pre></details>
    <details v-if="ac.exception"><summary>AC 예외</summary><pre>{{show(ac.exception)}}</pre></details>
    <details v-if="ac.verify_by!=null"><summary>검사 선언 · 작성 {{makers(ac.verify_by)}} · 연결 미확인</summary><pre>{{show(ac.verify_by)}}</pre></details><p v-else>검사 선언 · verify_by 미선언</p>
   </article>
   <h4>실행 기록 (장부에 기록된 값)</h4><p v-if="!declaration.verification.length">기록 미확인</p>
   <details v-for="(record,index) in declaration.verification" :key="index"><summary>{{index+1}} · {{show(record.kind)}} · {{show(record.verdict)}} · {{show(record.grade)}}</summary><p>검사별 결과 연결 미확인 · 아래 observes는 기록의 AC 참조입니다.</p><p>관측 대상 · observes: {{show(record.observes)}}</p><p>환경 · env.target / env.via</p><pre>{{show(record.env)}}</pre><pre>{{show(record)}}</pre></details>
   <p v-if="declaration.omissions" role="status">잘못된 형식 또는 크기 제한으로 {{declaration.omissions}}개 선언을 표시하지 못했습니다.</p>
  </template>
 </section>
</template>
<style scoped>
.harness-declarations{overflow-wrap:anywhere}.harness-declarations pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:20rem;overflow:auto}.harness-ac{border-left:2px solid var(--app-border);padding-left:12px;margin:12px 0}.harness-ac h5{font-size:inherit;margin:8px 0}.harness-declarations details{margin:8px 0}.harness-declarations summary{cursor:pointer}
</style>
