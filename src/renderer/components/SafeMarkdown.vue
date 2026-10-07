<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onUnmounted, ref, watch, type ComponentPublicInstance, type VNode } from 'vue';
import { parseSafeMarkdown, type DocumentReference, type MarkdownBlock, type MarkdownInline, type MarkdownIssue, type MarkdownReference } from '../../phase2/markdown';

const props = withDefaults(defineProps<{ text: string; anchor?: string | null; disabled?: boolean }>(), { anchor: null, disabled: false });
const emit = defineEmits<{ 'open-reference': [reference: DocumentReference] }>();
const document = computed(() => parseSafeMarkdown(props.text));
const anchorMessage = ref('');
const headings = new Map<string, HTMLElement>();
let generation = 0;
const issueText: Record<MarkdownIssue, string> = {
  'invalid-source': '문서 원문 형식을 확인할 수 없습니다',
  'source-limit': '문서 크기 제한을 넘어 표시하지 않았습니다',
  'line-limit': '줄 수 제한을 넘어 서식 없는 원문으로 표시합니다',
  'node-limit': '서식 수 제한을 넘어 서식 없는 원문으로 표시합니다',
  'work-limit': '분석 작업 제한을 넘어 서식 없는 원문으로 표시합니다',
  'inline-limit': '긴 문단 일부는 서식 없는 원문으로 표시합니다',
  'depth-limit': '깊게 중첩된 서식 일부는 원문으로 표시합니다',
};
function scrollToAnchor(anchor: string): boolean {
  const target = headings.get(anchor);
  if (!target) { anchorMessage.value = `앵커 #${anchor}의 위치를 찾지 못했습니다. 연결 문자는 그대로 보존했습니다`; return false; }
  target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  target.focus({ preventScroll: true });
  anchorMessage.value = `앵커 #${anchor}로 이동했습니다`;
  return true;
}
function activate(item: MarkdownReference): void {
  if (props.disabled || item.disposition === 'blocked') return;
  if (item.disposition === 'anchor' && item.anchor !== null) { scrollToAnchor(item.anchor); return; }
  if (item.disposition === 'local' && item.relativePath !== null) emit('open-reference', { href: item.href, relativePath: item.relativePath, anchor: item.anchor, label: item.label, kind: item.kind });
}
function renderInline(nodes: MarkdownInline[]): (VNode | string)[] {
  return nodes.map(item => {
    if (item.type === 'text') return item.text;
    if (item.type === 'code') return h('code', item.text);
    if (item.type === 'strong' || item.type === 'emphasis') return h(item.type === 'strong' ? 'strong' : 'em', renderInline(item.children));
    const reference = item as MarkdownReference;
    return h('span', { class: ['markdown-reference', { 'markdown-image-placeholder': reference.kind === 'image' }] }, [
      h('button', {
        type: 'button', class: 'markdown-reference-button', disabled: props.disabled || reference.disposition === 'blocked',
        title: reference.reason ?? reference.href, 'data-markdown-reference': reference.kind,
        onClick: () => activate(reference),
      }, `${reference.kind === 'image' ? '이미지 확인 · ' : ''}${reference.label}`),
      reference.reason ? h('span', { class: 'markdown-reference-reason' }, ` (${reference.reason})`) : null,
    ]);
  });
}
function renderBlocks(nodes: MarkdownBlock[]): VNode[] {
  return nodes.map(item => {
    if (item.type === 'paragraph') return h('p', renderInline(item.children));
    if (item.type === 'code') return h('div', { class: 'markdown-code-block' }, [
      item.language ? h('span', { class: 'markdown-code-language' }, item.language) : null,
      h('pre', [h('code', item.text)]),
    ]);
    if (item.type === 'quote') return h('blockquote', renderBlocks(item.children));
    if (item.type === 'list') return h(item.ordered ? 'ol' : 'ul', item.ordered ? { start: item.start } : {}, item.items.map(children => h('li', renderInline(children))));
    return h(`h${item.level}`, {
      key: item.id, tabindex: -1, 'data-markdown-anchor': item.anchor,
      ref: (element: Element | ComponentPublicInstance | null) => {
        if (element) headings.set(item.anchor, element as HTMLElement); else headings.delete(item.anchor);
      },
    }, renderInline(item.children));
  });
}
// All source-derived strings are Vue text children or ordinary escaped attributes. No HTML insertion or URL-bearing elements.
const DocumentBody = defineComponent({ name: 'SafeMarkdownBody', setup: () => () => h('div', { class: 'markdown-body' }, renderBlocks(document.value.blocks)) });
watch(() => [props.text, props.anchor], async (current, previous) => {
  const own = ++generation;
  if (!previous || current[0] !== previous[0]) headings.clear();
  anchorMessage.value = '';
  await nextTick();
  if (own === generation && props.anchor) scrollToAnchor(props.anchor);
}, { immediate: true });
onUnmounted(() => { generation++; headings.clear(); });
defineExpose({ scrollToAnchor });
</script>

<template>
  <section class="safe-markdown" aria-label="근거 문서">
    <p class="markdown-subset-note">제한된 Markdown 서식 · HTML과 외부 연결은 실행하지 않습니다</p>
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
.safe-markdown :deep(.markdown-code-block pre) { overflow: auto; max-height: 60vh; padding: .8em; border: 1px solid var(--p-content-border-color, #888); border-radius: .4em; white-space: pre; }
.safe-markdown :deep(.markdown-code-language), .safe-markdown :deep(.markdown-reference-reason) { font-size: .8rem; opacity: .8; }
.safe-markdown :deep(.markdown-reference-button) { font: inherit; color: var(--p-primary-color, #2d76a8); background: transparent; border: 0; text-decoration: underline; cursor: pointer; padding: 0 .15em; text-align: left; overflow-wrap: anywhere; }
.safe-markdown :deep(.markdown-reference-button:disabled) { color: inherit; opacity: .6; cursor: not-allowed; }
.safe-markdown :deep(.markdown-image-placeholder) { display: inline-block; padding: .35em .6em; border: 1px dashed var(--p-content-border-color, #888); border-radius: .3em; }
.safe-markdown :deep(.markdown-reference-button:focus-visible), .safe-markdown :deep([data-markdown-anchor]:focus-visible) { outline: 2px solid var(--p-primary-color, #2d76a8); outline-offset: 3px; }
</style>
