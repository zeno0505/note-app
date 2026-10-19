<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onUnmounted, ref, watch, type ComponentPublicInstance, type VNode } from 'vue';
import SafeMermaid from './SafeMermaid.vue';
import { findTextOffsets, MARKDOWN_FIND_LIMIT, markdownHeadingAnchor, parseSafeMarkdown, type MarkdownHeading, type MarkdownFindResult, type DocumentReference, type MarkdownBlock, type MarkdownInline, type MarkdownIssue, type MarkdownReference } from '../../phase2/markdown';

const props = withDefaults(defineProps<{ text: string; harnessReferences?:boolean; anchor?: string | null; disabled?: boolean; findQuery?: string; findIndex?: number }>(), { anchor: null, disabled: false, findQuery: '', findIndex: 0 });
const emit = defineEmits<{ 'open-reference': [reference: DocumentReference]; 'anchor-change': [anchor: string]; 'anchor-result': [result: {anchor:string;found:boolean;message:string}]; outline: [headings: MarkdownHeading[]]; 'find-results': [result: MarkdownFindResult] }>();
const document = computed(() => parseSafeMarkdown(props.text,{harnessReferences:props.harnessReferences}));
const anchorMessage = ref('');
const headingElements = new Map<string, HTMLElement>();
const matchElements = new Map<number, HTMLElement>();
const headings = computed(() => document.value.headings);
let findGeneration = 0;
let generation = 0;
const issueText: Record<MarkdownIssue, string> = {
  'invalid-source': '문서 원문 형식을 확인할 수 없습니다',
  'source-limit': '문서 크기 제한을 넘어 표시하지 않았습니다',
  'line-limit': '줄 수 제한을 넘어 서식 없는 원문으로 표시합니다',
  'node-limit': '서식 수 제한을 넘어 서식 없는 원문으로 표시합니다',
  'work-limit': '분석 작업 제한을 넘어 서식 없는 원문으로 표시합니다',
  'inline-limit': '긴 문단 일부는 서식 없는 원문으로 표시합니다',
  'depth-limit': '깊게 중첩된 서식 일부는 원문으로 표시합니다',
  'table-limit': '표의 행·열 제한을 넘어 서식 없는 원문으로 표시합니다',
};
function anchorResult(anchor:string,found:boolean,message:string):boolean{anchorMessage.value=message;emit('anchor-result',{anchor,found,message});return found;}
function scrollToAnchor(anchor: string): boolean {
  if (anchor.startsWith('^')) { return anchorResult(anchor,false,`블록 참조 #${anchor} 위치 이동은 지원하지 않습니다. 전체 문서에서 원문을 확인해 주세요`); }
  let decoded = anchor;
  try { decoded = decodeURIComponent(anchor); } catch { /* Keep the source anchor on malformed escapes. */ }
  if (decoded.startsWith('^')) { return anchorResult(anchor,false,`블록 참조 #${anchor} 위치 이동은 지원하지 않습니다. 전체 문서에서 원문을 확인해 주세요`); }
  let target = headingElements.get(anchor) ?? headingElements.get(decoded);
  if (!target) {
    const exact = headings.value.filter(heading => heading.text === decoded);
    const candidates = exact.length ? exact : headings.value.filter(heading => markdownHeadingAnchor(heading.text) === markdownHeadingAnchor(decoded));
    if (candidates.length > 1) { return anchorResult(anchor,false,`앵커 #${anchor}와 같은 제목이 여러 개여서 위치를 정할 수 없습니다. 목차에서 정확한 제목을 선택해 주세요`); }
    if (candidates.length === 1) target = headingElements.get(candidates[0].anchor);
  }
  if (!target) { return anchorResult(anchor,false,`앵커 #${anchor}의 위치를 찾지 못했습니다. 연결 문자는 그대로 보존했습니다`); }
  target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  target.focus({ preventScroll: true });
  return anchorResult(anchor,true,`앵커 #${anchor}로 이동했습니다`);
}
function activate(item: MarkdownReference): void {
  if (props.disabled || item.disposition === 'blocked') return;
  if(item.disposition==='harness'){emit('open-reference',{href:item.href,relativePath:'',anchor:null,label:item.label,kind:item.kind});return;}
  if (item.disposition === 'anchor' && item.anchor !== null) { if (scrollToAnchor(item.anchor)) emit('anchor-change', item.anchor); return; }
  if (item.disposition === 'local' && item.relativePath !== null) emit('open-reference', { href: item.href, relativePath: item.relativePath, anchor: item.anchor, label: item.label, kind: item.kind });
}
interface FindMatch { offset: number; length: number; index: number }
const searchPlan = computed(() => {
  const matches = new Map<MarkdownBlock | MarkdownInline, FindMatch[]>();
  let count = 0, limited = false;
  const group = (runs: { item: MarkdownBlock | MarkdownInline; text: string }[]) => {
    const found = findTextOffsets(runs.map(run => run.text).join(''), props.findQuery, MARKDOWN_FIND_LIMIT - count);
    limited ||= found.limited;
    let start = 0;
    for (const run of runs) {
      const end = start + run.text.length, portions: FindMatch[] = [];
      found.offsets.forEach((offset, index) => {
        const from = Math.max(start, offset), to = Math.min(end, offset + props.findQuery.length);
        if (from < to) portions.push({ offset: from - start, length: to - from, index: count + index });
      });
      matches.set(run.item, portions); start = end;
    }
    count += found.offsets.length;
  };
  const inline = (nodes: MarkdownInline[]) => {
    const runs: { item: MarkdownInline; text: string }[] = [];
    const collect = (items: MarkdownInline[]) => items.forEach(item => {
      if ('children' in item) collect(item.children);
      else runs.push({ item, text: item.type === 'reference' ? item.label : item.text });
    });
    collect(nodes); group(runs);
  };
  const blocks = (nodes: MarkdownBlock[]) => nodes.forEach(item => {
    if (item.type === 'code') group([{ item, text: item.text }]);
    else if (item.type === 'quote') blocks(item.children);
    else if (item.type === 'list') item.items.forEach(entry => blocks(entry.children));
    else if (item.type === 'table') { item.header.forEach(inline); item.rows.forEach(row => row.forEach(inline)); }
    else inline(item.children);
  });
  blocks(document.value.blocks);
  return { matches, count, limited };
});
const activeMatch = computed(() => searchPlan.value.count ? Math.max(0, Math.min(searchPlan.value.count - 1, props.findIndex)) : -1);
function scrollToMatch(index: number): boolean {
  const target = matchElements.get(index);
  if (!target) return false;
  target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  return true;
}
function renderText(item: MarkdownBlock | MarkdownInline, text: string): (VNode | string)[] {
  const found = searchPlan.value.matches.get(item) ?? [];
  if (!found.length) return [text];
  const result: (VNode | string)[] = []; let cursor = 0;
  for (const match of found) {
    result.push(text.slice(cursor, match.offset));
    result.push(h('mark', {
      key: match.index, 'data-markdown-match': match.index, class: { 'markdown-find-active': activeMatch.value === match.index },
      ref: (element: Element | ComponentPublicInstance | null) => { if (element) matchElements.set(match.index, element as HTMLElement); else matchElements.delete(match.index); },
    }, text.slice(match.offset, match.offset + match.length)));
    cursor = match.offset + match.length;
  }
  result.push(text.slice(cursor)); return result;
}
function renderInline(nodes: MarkdownInline[]): (VNode | string)[] {
  return nodes.flatMap(item => {
    if (item.type === 'text') return renderText(item, item.text);
    if (item.type === 'code') return h('code', renderText(item, item.text));
    if (item.type === 'strong' || item.type === 'emphasis') return h(item.type === 'strong' ? 'strong' : 'em', renderInline(item.children));
    const reference = item as MarkdownReference;
    return h('span', { class: ['markdown-reference', { 'markdown-image-placeholder': reference.kind === 'image' }] }, [
      h('button', {
        type: 'button', class: 'markdown-reference-button', disabled: props.disabled || reference.disposition === 'blocked',
        title: reference.reason ?? reference.href, 'data-markdown-reference': reference.kind,
        onClick: () => activate(reference),
      }, [reference.kind === 'image' ? '이미지 확인 · ' : '', ...renderText(reference, reference.label)]),
      reference.reason ? h('span', { class: 'markdown-reference-reason' }, ` (${reference.reason})`) : null,
    ]);
  });
}
function renderBlocks(nodes: MarkdownBlock[]): VNode[] {
  return nodes.map(item => {
    if (item.type === 'paragraph') return h('p', renderInline(item.children));
    if (item.type === 'code' && item.language?.toLowerCase() === 'mermaid') return h(SafeMermaid, { source: item.text, showSource: Boolean(props.findQuery) }, { default: () => h('code', renderText(item, item.text)) });
    if (item.type === 'code') return h('div', { class: 'markdown-code-block' }, [
      item.language ? h('span', { class: 'markdown-code-language' }, item.language) : null,
      h('pre', [h('code', renderText(item, item.text))]),
    ]);
    if (item.type === 'quote') return h('blockquote', renderBlocks(item.children));
    if (item.type === 'list') return h(item.ordered ? 'ol' : 'ul', item.ordered ? { start: item.start } : {}, item.items.map(entry => h('li', renderBlocks(entry.children))));
    if (item.type === 'table') {
      const row = (cells: MarkdownInline[][], header = false) => h('tr', cells.map((cell, index) => h(header ? 'th' : 'td', {
        ...(header ? { scope: 'col' } : {}), class: item.alignments[index] ? `markdown-align-${item.alignments[index]}` : undefined,
      }, renderInline(cell))));
      return h('div', { class: 'markdown-table-scroll', tabindex: 0, role: 'region', 'aria-label': '문서 표' }, [
        h('table', [h('thead', [row(item.header, true)]), h('tbody', item.rows.map(cells => row(cells)))]),
      ]);
    }
    return h(`h${item.level}`, {
      key: item.id, tabindex: -1, 'data-markdown-anchor': item.anchor,
      ref: (element: Element | ComponentPublicInstance | null) => {
        if (element) headingElements.set(item.anchor, element as HTMLElement); else headingElements.delete(item.anchor);
      },
    }, renderInline(item.children));
  });
}
// All source-derived strings are Vue text children or ordinary escaped attributes. No HTML insertion or URL-bearing elements.
const DocumentBody = defineComponent({ name: 'SafeMarkdownBody', setup: () => () => h('div', { class: 'markdown-body' }, renderBlocks(document.value.blocks)) });
watch(() => [props.text, props.anchor], async (current, previous) => {
  const own = ++generation;
  if (!previous || current[0] !== previous[0]) headingElements.clear();
  anchorMessage.value = '';
  await nextTick();
  if (own === generation && props.anchor) scrollToAnchor(props.anchor);
}, { immediate: true });
watch(headings, value => emit('outline', value), { immediate: true });
watch(() => [searchPlan.value, props.findIndex], async () => {
  const own = ++findGeneration;
  emit('find-results', { count: searchPlan.value.count, limited: searchPlan.value.limited, index: activeMatch.value });
  await nextTick();
  if (own === findGeneration && props.findQuery && activeMatch.value >= 0) scrollToMatch(activeMatch.value);
}, { immediate: true });
onUnmounted(() => { generation++; findGeneration++; headingElements.clear(); matchElements.clear(); });
defineExpose({ scrollToAnchor, scrollToMatch, headings });
</script>

<template>
  <section class="safe-markdown" aria-label="근거 문서">
    <p class="markdown-subset-note">읽기 전용 Markdown · 제한된 Mermaid flowchart/graph · HTML과 외부 연결은 실행하지 않습니다</p>
    <p v-for="issue in document.issues" :key="issue" class="markdown-notice" role="status">{{ issueText[issue] }}</p>
    <DocumentBody />
    <p v-if="anchorMessage" class="markdown-notice" role="status">{{ anchorMessage }}</p>
  </section>
</template>

<style scoped>
.safe-markdown { overflow-wrap: anywhere; min-width: 0; }
.markdown-subset-note, .markdown-notice { font-size: .85rem; opacity: .8; }
.safe-markdown :deep(.markdown-body p), .safe-markdown :deep(.markdown-body li) { white-space: pre-wrap; line-height: 1.65; }
.safe-markdown :deep(.markdown-body h1), .safe-markdown :deep(.markdown-body h2), .safe-markdown :deep(.markdown-body h3) { margin: 1.2em 0 .5em; }
.safe-markdown :deep(.markdown-body blockquote) { margin: 1em 0; padding: .2em 1em; border-left: 3px solid var(--p-content-border-color, #888); }
.safe-markdown :deep(.markdown-body li > p) { margin: .2em 0; }
.safe-markdown :deep(.markdown-body li > ul), .safe-markdown :deep(.markdown-body li > ol) { margin: .2em 0; padding-left: 1.5em; }
.safe-markdown :deep(.markdown-table-scroll) { max-width: 100%; overflow-x: auto; margin: 1em 0; }
.safe-markdown :deep(.markdown-table-scroll table) { border-collapse: collapse; width: 100%; }
.safe-markdown :deep(.markdown-table-scroll th), .safe-markdown :deep(.markdown-table-scroll td) { min-width: 6rem; padding: .4em .6em; border: 1px solid var(--p-content-border-color, #888); text-align: left; vertical-align: top; }
.safe-markdown :deep(.markdown-table-scroll .markdown-align-center) { text-align: center; }
.safe-markdown :deep(.markdown-table-scroll .markdown-align-right) { text-align: right; }
.safe-markdown :deep(.markdown-table-scroll:focus-visible) { outline: 2px solid var(--p-primary-color, #2d76a8); outline-offset: 3px; }
.safe-markdown :deep(.markdown-code-block pre) { overflow: auto; max-height: 60vh; padding: .8em; border: 1px solid var(--p-content-border-color, #888); border-radius: .4em; white-space: pre; }
.safe-markdown :deep(.markdown-code-language), .safe-markdown :deep(.markdown-reference-reason) { font-size: .8rem; opacity: .8; }
.safe-markdown :deep(.markdown-reference-button) { font: inherit; color: var(--p-primary-color, #2d76a8); background: transparent; border: 0; text-decoration: underline; cursor: pointer; padding: 0 .15em; text-align: left; overflow-wrap: anywhere; }
.safe-markdown :deep(.markdown-reference-button:disabled) { color: inherit; opacity: .6; cursor: not-allowed; }
.safe-markdown :deep(.markdown-image-placeholder) { display: inline-block; padding: .35em .6em; border: 1px dashed var(--p-content-border-color, #888); border-radius: .3em; }
.safe-markdown :deep(.markdown-reference-button:focus-visible), .safe-markdown :deep([data-markdown-anchor]:focus-visible) { outline: 2px solid var(--p-primary-color, #2d76a8); outline-offset: 3px; }
.safe-markdown :deep(mark) { background: #f6dd74; color: #1c2631; border-radius: .15em; }
.safe-markdown :deep(.markdown-find-active) { outline: 2px solid var(--p-primary-color, #2d76a8); outline-offset: 1px; }
</style>
