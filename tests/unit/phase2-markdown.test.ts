import { describe, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, h, nextTick, reactive, ssrContextKey, type ComponentPublicInstance, type Component } from 'vue';
import { renderToString } from '@vue/server-renderer';
import SafeMarkdown from '../../src/renderer/components/SafeMarkdown.vue';
import { extractDocumentReferences, MARKDOWN_LIMITS, markdownHeadingAnchor, parseSafeMarkdown, type MarkdownBlock, type MarkdownInline, type MarkdownReference } from '../../src/phase2/markdown';
import { parseEvidenceTarget } from '../../src/phase2/evidence';

function references(blocks: MarkdownBlock[]): MarkdownReference[] {
  const results: MarkdownReference[] = [];
  const visit = (nodes: MarkdownInline[]) => { for (const node of nodes) { if (node.type === 'reference') results.push(node); else if ('children' in node) visit(node.children); } };
  for (const node of blocks) {
    if (node.type === 'quote') results.push(...references(node.children));
    else if (node.type === 'list') node.items.forEach(visit);
    else if ('children' in node) visit(node.children);
  }
  return results;
}

describe('bounded safe Markdown subset', () => {
  it('parses headings, paragraphs, fences, single-level lists, quotes and inline text formatting', () => {
    const parsed = parseSafeMarkdown('# 설계 **요약**\n\n문단 *강조*와 `code`\n다음 줄\n\n- 첫 항목\n- 두 항목\n\n3. 순서\n4. 다음\n\n> 인용\n>\n> ## 인용 제목\n\n```ts\nconst raw = "<script>";\n```');
    expect(parsed.issues).toEqual([]);
    expect(parsed.blocks.map(node => node.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code']);
    expect(parsed.blocks[0]).toMatchObject({ level: 1, anchor: '설계-요약', children: [{ type: 'text', text: '설계 ' }, { type: 'strong' }] });
    expect(parsed.blocks[1]).toMatchObject({ children: [{ type: 'text', text: '문단 ' }, { type: 'emphasis' }, { type: 'text' }, { type: 'code', text: 'code' }, { type: 'text', text: '\n다음 줄' }] });
    expect(parsed.blocks[3]).toMatchObject({ ordered: true, start: 3 });
    expect(parsed.blocks[5]).toEqual({ type: 'code', language: 'ts', text: 'const raw = "<script>";' });
  });
  it('normalizes line endings and keeps unsupported syntax literal', () => {
    const parsed = parseSafeMarkdown('Title\r\n===\r\n[a][ref]\r\n| A | B |\r\n| --- | --- |\r\n$math$\r\n\r\n[ref]: doc.md');
    expect(parsed.targets).toEqual([]);
    expect(parsed.blocks).toMatchObject([{ type: 'paragraph', children: [{ type: 'text', text: 'Title\n===\n[a][ref]\n| A | B |\n| --- | --- |\n$math$' }] }, { type: 'paragraph' }]);
    expect(parseSafeMarkdown('my_identifier and \\*literal\\*').blocks).toMatchObject([{ children: [{ type: 'text', text: 'my_identifier and *literal*' }] }]);
  });
  it('extracts local links, angle destinations, image placeholders and wiki aliases with exact hrefs', () => {
    const result = extractDocumentReferences('[설계](docs/design.md#결정 "설명") ![도표](<assets/my chart.png>) [[notes/design#제목|논의]] ![[images/screen.jpg|화면]] [숨김](.hidden.md)');
    expect(result.unsupportedCount).toBe(0);
    expect(result.targets).toEqual([
      { href: 'docs/design.md#결정', relativePath: 'docs/design.md', anchor: '결정', label: '설계', kind: 'link' },
      { href: 'assets/my chart.png', relativePath: 'assets/my chart.png', anchor: null, label: '도표', kind: 'image' },
      { href: '[[notes/design#제목|논의]]', relativePath: 'notes/design.md', anchor: '제목', label: '논의', kind: 'link' },
      { href: '[[images/screen.jpg|화면]]', relativePath: 'images/screen.jpg', anchor: null, label: '화면', kind: 'image' },
      { href: '.hidden.md', relativePath: '.hidden.md', anchor: null, label: '숨김', kind: 'link' },
    ]);
    for (const target of result.targets) expect(parseEvidenceTarget(target.href)).toMatchObject({ relativePath: target.relativePath, anchor: target.anchor });
  });
  it('never extracts references inside code or escaped link declarations', () => {
    const parsed = parseSafeMarkdown('`[inline](a.md)`\n\n~~~md\n![code](a.png)\n[[notes]]\n~~~\n\n\\[escaped](a.md)');
    expect(parsed.targets).toEqual([]);
    expect(parsed.unsupportedCount).toBe(0);
  });
  it.each([
    'https://example.invalid/a(b)', 'http://example.invalid', '//example.invalid/a.md',
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,YQ==', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'blob:https://example.invalid/x', 'mailto:person@example.invalid',
    '../outside.md', '/outside.md', './same.md', 'dir/../outside.md', 'dir//same.md', 'C:\\secret.md', 'dir\\secret.md',
    '%2e%2e/outside.md', 'doc.md?download=1', 'java&#x73;cript:alert(1)', 'doc.md#', 'doc.md#one#two', 'image.svg', 'page.html', 'script.js',
  ])('disables unsupported or unsafe target %s with a visible reason', href => {
    const parsed = parseSafeMarkdown(`[label](${href})`);
    expect(parsed.targets).toEqual([]);
    expect(references(parsed.blocks)[0]).toMatchObject({ disposition: 'blocked', href, reason: expect.any(String) });
    expect(parsed.unsupportedCount).toBe(1);
  });
  it('rejects controls, overlong UTF-8 labels and default path labels without truncating a usable destination', () => {
    for (const href of ['a\u0000.md', `dir/${'한'.repeat(180)}.md`]) {
      const parsed = parseSafeMarkdown(`[short](${href})`);
      expect(parsed.targets).toEqual([]);
      expect(parsed.unsupportedCount).toBe(1);
    }
    const parsed = parseSafeMarkdown(`[${'한'.repeat(180)}](safe.md)`);
    expect(parsed.targets).toEqual([]); expect(parsed.unsupportedCount).toBe(1);
    expect(extractDocumentReferences(`[long](${'a'.repeat(5000)}.md)`).targets).toEqual([]);
  });
  it('preserves same-document anchors literally, including unknown names, without registering a file', () => {
    const parsed = parseSafeMarkdown('# Hello *World*!\n# Hello World\n# Hello World-1\n\n[known](#hello-world) [unknown](#%ED%95%9C)');
    expect(parsed.blocks.slice(0, 3)).toMatchObject([{ anchor: 'hello-world', id: 'heading-1' }, { anchor: 'hello-world-1', id: 'heading-2' }, { anchor: 'hello-world-1-1', id: 'heading-3' }]);
    expect(references(parsed.blocks)).toMatchObject([{ disposition: 'anchor', anchor: 'hello-world' }, { disposition: 'anchor', anchor: '%ED%95%9C' }]);
    expect(parsed.targets).toEqual([]);
    expect(markdownHeadingAnchor('한글 제목! & 기호')).toBe('한글-제목-기호');
  });
  it('deduplicates identical declaration kinds and bounds registration candidates', () => {
    const input = '[one](same.md) [two](same.md) ![image](same.png) [file](same.png)';
    expect(extractDocumentReferences(input).targets).toHaveLength(3);
    const parsed = parseSafeMarkdown(Array.from({ length: MARKDOWN_LIMITS.references + 2 }, (_, index) => `[file](doc-${index}.md)`).join('\n\n'));
    expect(parsed.targets).toHaveLength(MARKDOWN_LIMITS.references);
    expect(parsed.unsupportedCount).toBe(2);
    expect(references(parsed.blocks).slice(-2).every(item => item.disposition === 'blocked')).toBe(true);
  });
  it('fails closed on source limits, including multibyte UTF-8 and non-string runtime values', () => {
    expect(parseSafeMarkdown('x'.repeat(MARKDOWN_LIMITS.sourceBytes + 1))).toMatchObject({ blocks: [], targets: [], limited: true, issues: ['source-limit'] });
    expect(parseSafeMarkdown('한'.repeat(Math.floor(MARKDOWN_LIMITS.sourceBytes / 3) + 1)).issues).toEqual(['source-limit']);
    expect(parseSafeMarkdown(null as unknown as string).issues).toEqual(['invalid-source']);
    expect(parseSafeMarkdown('x'.repeat(MARKDOWN_LIMITS.sourceBytes)).issues).toEqual(['inline-limit']);
  });
  it('falls back to inert complete text for line, node and scan-work limits', () => {
    const cases = [
      ['\n'.repeat(MARKDOWN_LIMITS.lines), 'line-limit'],
      ['# A\n'.repeat(Math.ceil(MARKDOWN_LIMITS.nodes / 2) + 1), 'node-limit'],
      ['['.repeat(MARKDOWN_LIMITS.inlineChars), 'work-limit'],
    ] as const;
    for (const [input, issue] of cases) {
      const parsed = parseSafeMarkdown(input);
      expect(parsed.issues).toEqual([issue]); expect(parsed.targets).toEqual([]); expect(parsed.limited).toBe(true);
      expect(parsed.blocks).toEqual([{ type: 'code', text: input, language: null }]);
    }
  });
  it('handles source-sized whitespace in headings without ambiguous regex backtracking', () => {
    const spaces = ' '.repeat(MARKDOWN_LIMITS.sourceBytes - 16);
    for (const input of [`# a${spaces}b`, `# a${spaces}#`]) {
      const parsed = parseSafeMarkdown(input);
      expect(parsed.blocks[0].type).toBe('heading');
      expect(parsed.targets).toEqual([]);
    }
  });
  it('bounds quote nesting, preserves unmatched fences, and does not parse very long inline sequences', () => {
    expect(parseSafeMarkdown('> '.repeat(MARKDOWN_LIMITS.quoteDepth + 2) + '[a](safe.md)').issues).toContain('depth-limit');
    expect(parseSafeMarkdown('```\n<script>\n[code](file.md)').blocks).toEqual([{ type: 'code', text: '<script>\n[code](file.md)', language: null }]);
    const parsed = parseSafeMarkdown('x'.repeat(MARKDOWN_LIMITS.inlineChars + 1) + '[tail](safe.md)');
    expect(parsed.issues).toEqual(['inline-limit']); expect(parsed.targets).toEqual([]);
  });
});

describe('safe Vue Markdown rendering', () => {
  it('renders structure while escaping hostile HTML, SVG, template text, labels and fence language', async () => {
    const html = await renderToString(createSSRApp(SafeMarkdown, { text: '# Heading\n\n<script>alert(1)</script> <img src=x onerror=alert(2)> <svg/onload=alert(3)> {{danger}}\n\n**strong** and *emphasis*\n\n[<img src=x>](safe.md)\n\n```"><img src=x>\n</code><iframe src="x">\n```' }));
    expect(html).toContain('<h1'); expect(html).toContain('<strong>strong</strong>'); expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).toContain('{{danger}}');
    expect(html).not.toMatch(/<(?:script|img|svg|iframe)\b/iu);
    expect(html).not.toMatch(/<[a-z][^>]*\s(?:href|src|srcdoc)=/iu);
  });
  it('renders every image as a placeholder and external links as disabled buttons without network APIs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const html = await renderToString(createSSRApp(SafeMarkdown, { text: '![local](image.png) ![tracking](https://example.invalid/x.png) [danger](javascript:alert(1))' }));
      expect(html).toContain('이미지 확인 · local'); expect(html).toContain('disabled'); expect(html).toContain('외부 연결은 열거나 요청하지 않습니다');
      expect(html).not.toContain('<img'); expect(html).not.toContain('<a '); expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});

interface HostNode {
  type: string; parent: HostNode | null; children: HostNode[]; props: Record<string, unknown>; text: string;
  scrollIntoView: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>;
}
function host(type: string, text = ''): HostNode { return { type, parent: null, children: [], props: {}, text, scrollIntoView: vi.fn(), focus: vi.fn() }; }
function mount(text: string, anchor: string | null = null) {
  const insert = (child: HostNode, parent: HostNode, before?: HostNode | null) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = parent;
    const index = before ? parent.children.indexOf(before) : -1;
    if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child);
  };
  const renderer = createRenderer<HostNode, HostNode>({
    patchProp: (node, key, _before, value) => { node.props[key] = value; },
    insert, remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
    createElement: type => host(type), createText: text => host('text', text), createComment: text => host('comment', text),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insertStaticContent: (content, parent, before) => { const node = host('static', content); insert(node, parent, before); return [node, node]; },
  });
  // Vitest loads SFCs in SSR mode. Reuse the real setup/render helpers with a tiny host template;
  // the production template and escaping are independently exercised by renderToString above.
  const clientComponent = { ...SafeMarkdown, render(this: ComponentPublicInstance) {
    const state = (this.$ as unknown as { setupState: { DocumentBody: Component; anchorMessage: string } }).setupState;
    return h('section', [h(state.DocumentBody), h('p', state.anchorMessage)]);
  } };
  const onReference = vi.fn(), root = host('root'), state = reactive({ text, anchor, disabled: false });
  let component!: ComponentPublicInstance & { scrollToAnchor(anchor: string): boolean };
  const app = renderer.createApp({ render: () => h(clientComponent as Component, { ...state, 'onOpen-reference': onReference, ref: (value: unknown) => { component = value as typeof component; } }) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  const all = (): HostNode[] => { const result: HostNode[] = []; const visit = (node: HostNode) => { result.push(node); node.children.forEach(visit); }; visit(root); return result; };
  return { app, root, component, state, all, onReference };
}
describe('local-only Markdown interactions', () => {
  it('emits declarations only for local link/image buttons and never activates blocked links', async () => {
    const mounted = mount('[local](doc.md#anchor) ![image](a.png) [external](https://example.invalid)');
    await nextTick();
    const buttons = mounted.all().filter(node => node.type === 'button');
    for (const button of buttons) (button.props.onClick as () => void)();
    expect(mounted.onReference.mock.calls).toEqual([
      [{ href: 'doc.md#anchor', relativePath: 'doc.md', anchor: 'anchor', label: 'local', kind: 'link' }],
      [{ href: 'a.png', relativePath: 'a.png', anchor: null, label: 'image', kind: 'image' }],
    ]);
    expect(buttons[2].props.disabled).toBe(true); mounted.app.unmount();
  });
  it('scrolls and focuses only its own heading, preserves unknown anchors and never emits an IPC candidate for #links', async () => {
    const first = mount('# Title\n\n[here](#title) [unknown](#unknown)'), second = mount('# Title');
    await nextTick();
    const title = first.all().find(node => node.type === 'h1')!, otherTitle = second.all().find(node => node.type === 'h1')!;
    const buttons = first.all().filter(node => node.type === 'button');
    (buttons[0].props.onClick as () => void)();
    expect(title.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' }); expect(title.focus).toHaveBeenCalledWith({ preventScroll: true }); expect(otherTitle.scrollIntoView).not.toHaveBeenCalled();
    (buttons[1].props.onClick as () => void)(); await nextTick();
    expect(first.all().some(node => node.text.includes('앵커 #unknown의 위치를 찾지 못했습니다'))).toBe(true);
    expect(first.onReference).not.toHaveBeenCalled(); first.app.unmount(); second.app.unmount();
  });
  it('retains heading refs for anchor-only changes and replaces refs when a document changes', async () => {
    const mounted = mount('# First\n# Second');
    await nextTick();
    const second = mounted.all().filter(node => node.type === 'h1')[1];
    mounted.state.anchor = 'second'; await nextTick(); await nextTick();
    expect(second.scrollIntoView).toHaveBeenCalledTimes(1);
    mounted.state.text = '# Replacement'; mounted.state.anchor = 'replacement';
    await nextTick(); await nextTick();
    expect(mounted.all().find(node => node.type === 'h1')!.props['data-markdown-anchor']).toBe('replacement');
    expect(mounted.component.scrollToAnchor('second')).toBe(false);
    expect(second.scrollIntoView).toHaveBeenCalledTimes(1); mounted.app.unmount();
  });
  it('blocks repeated activation while disabled and re-enables only the current document buttons', async () => {
    const mounted = mount('[first](one.md)'); await nextTick();
    const click = () => (mounted.all().find(node => node.type === 'button')!.props.onClick as () => void)();
    mounted.state.disabled = true; await nextTick(); click(); click();
    expect(mounted.onReference).not.toHaveBeenCalled();
    mounted.state.text = '[second](two.md)'; mounted.state.disabled = false; await nextTick(); click();
    expect(mounted.onReference).toHaveBeenCalledExactlyOnceWith({ href: 'two.md', relativePath: 'two.md', anchor: null, label: 'second', kind: 'link' }); mounted.app.unmount();
  });
  it('handles an initial exact anchor and cancels an initial scroll when unmounted', async () => {
    const mounted = mount('# Title', 'title');
    await nextTick(); expect(mounted.all().find(node => node.type === 'h1')!.scrollIntoView).toHaveBeenCalledTimes(1); mounted.app.unmount();
    const closed = mount('# Title', 'title'), title = closed.all().find(node => node.type === 'h1')!;
    closed.app.unmount(); await nextTick(); expect(title.scrollIntoView).not.toHaveBeenCalled();
  });
});
