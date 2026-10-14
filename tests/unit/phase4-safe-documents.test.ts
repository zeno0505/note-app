import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createEvidenceReader, EVIDENCE_LIMITS, parseEvidenceTarget } from '../../src/phase2/evidence';
import { extractDocumentReferences, findTextOffsets, parseDocumentTarget, parseSafeMarkdown } from '../../src/phase2/markdown';
import { layoutSafeMermaid, MERMAID_LIMITS, parseSafeMermaid } from '../../src/phase2/mermaid';
import SafeMarkdown from '../../src/renderer/components/SafeMarkdown.vue';

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
function dagFixture(bytes: number): string {
  let source = 'schema: 2\ntasks:\n', index = 0;
  while (source.length + 256 < bytes) source += `  - id: T-${++index}\n    title: Synthetic acceptance review ${index}\n    status: pending\n    dependencies: []\n`;
  const tail = '\n# END-OF-DAG';
  return source + '# ' + 'x'.repeat(bytes - Buffer.byteLength(source + '# ' + tail)) + tail;
}

describe('Phase 4 safe document targets', () => {
  it('preserves relative dot segments as declarations but never accepts them as reader registrations', () => {
    for (const href of ['./design.md', '../context.md#Requirements', 'inbox/../context.md']) {
      const parsed = parseDocumentTarget(href);
      expect(parsed.syntax).toBe('markdown'); expect(extractDocumentReferences(`[open](${href})`).targets).toHaveLength(1);
      expect(() => parseEvidenceTarget(href)).toThrow();
    }
  });
  it('handles escaped wikilink aliases in tables without allowing path backslashes', () => {
    const source = '| Task | Document |\n| --- | --- |\n| T-001 | [[project/inbox/T-001/assignment#Acceptance\\|T-001]] |';
    const parsed = parseSafeMarkdown(source);
    expect(parsed.blocks[0].type).toBe('table'); expect(parsed.unsupportedCount).toBe(0);
    expect(parsed.targets).toEqual([{ href: '[[project/inbox/T-001/assignment#Acceptance\\|T-001]]', relativePath: 'project/inbox/T-001/assignment.md', anchor: 'Acceptance', label: 'T-001', kind: 'link' }]);
    expect(parseEvidenceTarget(parsed.targets[0].href)).toEqual({ relativePath: 'project/inbox/T-001/assignment.md', anchor: 'Acceptance', label: 'T-001' });
    expect(() => parseDocumentTarget('[[project\\secret\\|label]]')).toThrow();
    expect(() => parseDocumentTarget('[[project\\\\|label]]')).toThrow();
  });
  it('keeps source anchors and unsupported blocks distinct without registering same-document targets', () => {
    expect(parseDocumentTarget('[[#한글 제목\\|현재 문서]]')).toEqual({ syntax: 'wiki', relativePath: '', label: '현재 문서', anchor: '한글 제목', anchorKind: 'heading' });
    expect(parseDocumentTarget('[[notes/design#^block]]')).toMatchObject({ relativePath: 'notes/design.md', anchor: '^block', anchorKind: 'block' });
    const parsed = parseSafeMarkdown('[[#^block]] [unknown](#not-present)');
    expect(parsed.targets).toEqual([]);
    expect(JSON.stringify(parsed.blocks)).toContain('블록 참조 위치 이동은 지원하지 않습니다');
  });
  it.each(['/private.md', '//host/private.md', 'https://host/doc.md', 'file:///private.md', 'C:\\private.md', 'dir//doc.md', '%2e%2e/private.md', 'dir\\doc.md', 'doc.md?query', 'doc.md#one#two', 'doc.md#'])('rejects unsafe syntax %s', href => {
    expect(() => parseDocumentTarget(href)).toThrow();
  });
  it('searches literal punctuation and Unicode without evaluating a regex or losing source offsets', () => {
    expect(findTextOffsets('a.b aXb A.B', 'a.b')).toEqual({ offsets: [0, 8], limited: false });
    expect(findTextOffsets('İ test 한글 한글', '한글')).toEqual({ offsets: [7, 10], limited: false });
    expect(findTextOffsets('aaaa', 'a', 2)).toEqual({ offsets: [0, 1], limited: true });
    expect(findTextOffsets('anything', '')).toEqual({ offsets: [], limited: false });
    expect(findTextOffsets('aaaa', '[')).toEqual({ offsets: [], limited: false });
  });
});

describe('Phase 4 complete bounded document reads', () => {
  it('reads a 520 KiB Markdown, 2.14 MiB YAML DAG and JSON with exact tails and source hashes', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-readable-'))); temporary.push(root);
    const paragraph = 'Review the acceptance criteria and preserve this synthetic evidence. '.repeat(12);
    let markdown = '# Synthetic review\n\n';
    while (Buffer.byteLength(markdown) < 520 * 1024) markdown += `${paragraph}\n\n`;
    markdown += '\n## Final acceptance\n\nEND-OF-MARKDOWN';
    const yaml = dagFixture(Math.ceil(2.14 * 1024 * 1024));
    const json = '{"review":"END-OF-JSON","items":[]}';
    const samples = [{ name: 'review.md', text: markdown }, { name: 'dag.yaml', text: yaml }, { name: 'review.json', text: json }];
    for (const sample of samples) await fs.writeFile(path.join(root, sample.name), sample.text);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const reader = await createEvidenceReader({ scopeId: 'synthetic-phase4', canonicalRootPath: root, registrations: samples.map((sample, index) => ({ id: `sample-${index}`, relativePath: sample.name })) });
    for (const [index, descriptor] of reader.list().entries()) {
      const result = await reader.read({ evidenceId: descriptor.evidenceId, expectedSourceHash: null });
      expect(result.ok).toBe(true);
      if (!result.ok || result.content.kind !== 'text') throw new Error('Expected full text');
      expect(result.content.text).toBe(samples[index].text);
      expect(result.byteLength).toBe(Buffer.byteLength(samples[index].text));
      expect(result.sourceHash).toBe(`sha256:${createHash('sha256').update(samples[index].text).digest('hex')}`);
    }
    const rendered = parseSafeMarkdown(markdown);
    expect(rendered.issues).toEqual([]);
    expect(rendered.headings.at(-1)).toEqual({ anchor: 'final-acceptance', text: 'Final acceptance', level: 2 });
    expect(JSON.stringify(rendered.blocks)).toContain('END-OF-MARKDOWN');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns an explicit size error above 8 MiB rather than a truncated success', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-limit-'))); temporary.push(root);
    await fs.writeFile(path.join(root, 'large.json'), Buffer.alloc(EVIDENCE_LIMITS.textBytes + 1, 32));
    const reader = await createEvidenceReader({ scopeId: 'limit', canonicalRootPath: root, registrations: [{ id: 'large', relativePath: 'large.json' }] });
    const open = vi.spyOn(fs, 'open');
    expect(await reader.read({ evidenceId: reader.list()[0].evidenceId, expectedSourceHash: null })).toEqual({ ok: false, code: 'source-limit', omitted: true });
    expect(open).not.toHaveBeenCalled();
  });
  it('retains the entire Markdown source when a rendering budget is exceeded', () => {
    const source = '# Heading\n\n'.repeat(3000) + 'FINAL SOURCE MARKER';
    const parsed = parseSafeMarkdown(source);
    expect(parsed.limited).toBe(true); expect(parsed.issues).toEqual(['node-limit']);
    expect(parsed.blocks).toEqual([{ type: 'code', text: source, language: null }]);
  });
});

describe('inert Mermaid flowcharts', () => {
  it('parses bounded shapes, labels, chains and directions into inert data', () => {
    const graph = parseSafeMermaid('flowchart LR\nA[요구사항] --> B{검토}\nB -->|통과| C("완료")\nB -.-> D((다시 확인))\nD ==> A\nC---E[기록]');
    expect(graph.ok).toBe(true); if (!graph.ok) throw new Error('Expected diagram');
    expect(graph.nodes).toHaveLength(5); expect(graph.edges).toHaveLength(5);
    expect(graph.nodes.map(node => node.shape)).toEqual(['rectangle', 'diamond', 'rounded', 'circle', 'rectangle']);
    const layout = layoutSafeMermaid(graph);
    expect(layout.nodes).toHaveLength(5); expect(layout.edges).toHaveLength(5);
    expect(layout.width).toBeGreaterThan(0); expect(layout.height).toBeGreaterThan(0);
    expect(JSON.stringify(layout)).not.toContain('NaN');
  });
  it('supports semicolon declarations and self-loop geometry without an unbounded layout', () => {
    const graph = parseSafeMermaid('graph TD; A["a; b"]-->B; B-->B');
    expect(graph.ok).toBe(true); if (!graph.ok) throw new Error('Expected diagram');
    expect(graph.nodes[0].label).toBe('a; b');
    expect(layoutSafeMermaid(graph).edges[1].path).toContain(' C ');
  });
  it.each([
    'flowchart TD\nA --> B\nclick A "https://example.invalid"',
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA --> B',
    'flowchart TD\nA --> B\nstyle A fill:url(https://example.invalid)',
    'sequenceDiagram\nA->>B: hello',
    'flowchart TD\nA@{ img: "https://example.invalid" }',
  ])('falls back explicitly for unsupported/executable syntax without partial graph %s', source => {
    expect(parseSafeMermaid(source)).toMatchObject({ ok: false, reason: 'unsupported-syntax' });
  });
  it('bounds source, nodes and edges', () => {
    expect(parseSafeMermaid('x'.repeat(MERMAID_LIMITS.sourceChars + 1))).toMatchObject({ ok: false, reason: 'source-limit' });
    expect(parseSafeMermaid('graph TD\n' + Array.from({ length: 65 }, (_, index) => `N${index}`).join('\n'))).toMatchObject({ ok: false, reason: 'graph-limit' });
    expect(parseSafeMermaid('graph TD\n' + 'A-->B\n'.repeat(129))).toMatchObject({ ok: false, reason: 'graph-limit' });
  });
  it('renders only escaped SVG text and fixed elements, with the complete source fallback', async () => {
    const source = 'flowchart TD\nA["<img src=https://example.invalid onerror=alert(1)>"] --> B[Done]';
    const html = await renderToString(createSSRApp({ render: () => h(SafeMarkdown, { text: '```mermaid\n' + source + '\n```' }) }));
    expect(html).toContain('<svg'); expect(html).toContain('Mermaid 원문');
    expect(html).not.toMatch(/<(?:img|script|iframe|foreignObject|a)\b/u);
    for (const tag of html.match(/<[^>]+>/gu) ?? []) expect(tag).not.toMatch(/\s(?:src|href|xlink:href|onload|onclick)=/u);
    expect(html).toContain('&lt;img src=https://example.invalid onerror=alert(1)&gt;');
    const unsupported = await renderToString(createSSRApp({ render: () => h(SafeMarkdown, { text: '```mermaid\nsequenceDiagram\nA->>B: SECRET-TAIL\n```' }) }));
    expect(unsupported).not.toContain('<svg'); expect(unsupported).toContain('전체 원문'); expect(unsupported).toContain('SECRET-TAIL');
  });
});

describe('observed Mermaid syntax families with synthetic content', () => {
  it.each(['TD', 'LR'])('renders a synthetic %s task flow with task IDs and dotted references', async direction => {
    const source = `flowchart ${direction}\nT-001["T-001 Requirements"] --> T-002{Acceptance}\nT-002 -->|pass| T-003(Implementation)\nT-003 -.->|evidence| T-001`;
    const parsed = parseSafeMermaid(source);
    expect(parsed).toMatchObject({ ok: true, direction });
    const html = await renderToString(createSSRApp({ render: () => h(SafeMarkdown, { text: `\`\`\`mermaid\n${source}\n\`\`\`` }) }));
    expect(html).toContain('<svg'); expect(html).toContain('stroke-dasharray="6 4"');
    expect(html).toContain('제한된 Mermaid 흐름도');
  });
  it.each([
    ['ER diagram', 'erDiagram\nREQUIREMENT ||--o{ TASK : informs\nTASK {\n  string id\n  string title\n}'],
    ['alternate dotted label', 'flowchart TD\nT-001 -. evidence .-> T-002'],
    ['multiple target shorthand', 'flowchart LR\nT-001 --> T-002 & T-003'],
  ])('preserves the complete synthetic %s source and identifies the unsupported subset', async (_kind, diagram) => {
    const source = `${diagram}\n%% COMPLETE-SOURCE-END`;
    expect(parseSafeMermaid(source)).toMatchObject({ ok: false, reason: 'unsupported-syntax' });
    const html = await renderToString(createSSRApp({ render: () => h(SafeMarkdown, { text: `\`\`\`mermaid\n${source}\n\`\`\`` }) }));
    const escaped = source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    expect(html).not.toContain('<svg'); expect(html).toContain('전체 원문'); expect(html).toContain(escaped);
    expect(html).toContain('ER 등 지원하지 않는 도식·문법'); expect(html).toMatch(/<details\b[^>]*\bopen/u);
  });
});


describe('bounded inert Mermaid groups and visible class metadata', () => {
  function taskFixture() {
    const lines = ['flowchart TD'];
    let next = 1;
    for (let group = 0; group < 3; group++) {
      lines.push(`subgraph Phase-${group}["Synthetic phase ${group + 1}"]`);
      const start = next;
      for (let i = 0; i < (group === 2 ? 7 : 6); i++, next++) lines.push(`T-${next}["Synthetic task ${next}<br/>Acceptance"]`);
      for (let i = start; i < next - 1; i++) lines.push(`T-${i} --> T-${i + 1}`);
      lines.push('end');
    }
    lines.push('T-6 --> T-7', 'T-12 --> T-13', 'T-19 -.->|review reference| T-1');
    for (let i = 0; i < 8; i++) lines.push(`classDef state${i} fill:#eeeeff,color:#112233`);
    for (let i = 1; i <= 19; i++) lines.push(`class T-${i} state${i % 8}`);
    return lines.join('\n');
  }
  it('preserves a representative 19-task/19-edge/3-group DAG and exposes omitted styles', async () => {
    const source = taskFixture(), graph = parseSafeMermaid(source);
    expect(graph.ok).toBe(true); if (!graph.ok) throw new Error('Expected representative DAG');
    expect(graph.nodes).toHaveLength(19); expect(graph.edges).toHaveLength(19); expect(graph.groups).toHaveLength(3);
    expect(graph.notices).toEqual(['styles-omitted']);
    expect(graph.nodes[0]).toMatchObject({ label: 'Synthetic task 1\nAcceptance', groupId: 'Phase-0', classes: ['state1'] });
    const layout = layoutSafeMermaid(graph);
    for (const node of layout.nodes) {
      const group = layout.groups.find(group => group.id === node.groupId)!;
      expect(node.x).toBeGreaterThan(group.x); expect(node.y).toBeGreaterThan(group.y);
      expect(node.x + node.width).toBeLessThan(group.x + group.width);
      expect(node.y + node.height).toBeLessThan(group.y + group.height);
      for (const other of layout.groups.filter(other => other.id !== node.groupId)) expect(node.x + node.width <= other.x || node.x >= other.x + other.width || node.y + node.height <= other.y || node.y >= other.y + other.height).toBe(true);
    }
    const html = await renderToString(createSSRApp({ render: () => h(SafeMarkdown, { text: `\`\`\`mermaid\n${source}\n\`\`\`` }) }));
    expect(html).toContain('<svg'); expect(html).toContain('색상·서식은 적용하지 않았습니다');
    expect(html).toContain('분류: state1'); expect(html).toContain('Synthetic phase 1');
    expect(html).not.toContain('fill="#eeeeff"'); expect(html).not.toContain('style="');
  });
  it('preserves nested groups, plain labels, class ordering and first-declaration membership', () => {
    const graph = parseSafeMermaid('graph LR\nOutside[Existing]\nclass A ready\nsubgraph Outer[Outer group]\nsubgraph Inner["Inner<br>group"]\nA["Line one<br/>Line two"] --> B\nOutside --> A\nend\nend\nclassDef ready fill:#eef,color:black');
    expect(graph.ok).toBe(true); if (!graph.ok) throw new Error('Expected nested DAG');
    expect(graph.nodes.find(node => node.id === 'Outside')?.groupId).toBe(null);
    expect(graph.nodes.find(node => node.id === 'A')).toMatchObject({ groupId: 'Inner', classes: ['ready'], label: 'Line one\nLine two' });
    expect(graph.groups[1]).toMatchObject({ parentId: 'Outer', label: 'Inner\ngroup' });
    const layout = layoutSafeMermaid(graph), outer = layout.groups[0], inner = layout.groups[1];
    expect(inner.x).toBeGreaterThan(outer.x); expect(inner.y).toBeGreaterThan(outer.y);
    expect(inner.x + inner.width).toBeLessThan(outer.x + outer.width);
    expect(inner.y + inner.height).toBeLessThan(outer.y + outer.height);
  });
  it.each([
    'graph TD\nsubgraph A[Open]\nN[Node]',
    'graph TD\nN[Node]\nend',
    'graph TD\nsubgraph Group[Label]\nN[Node]\nend\nN --> Group',
    'graph TD\nA[Node]\nclass A missing',
    'graph TD\nA[Node]\nclassDef ready fill:url(https://example.invalid)',
    'graph TD\nA[Node]\nclassDef ready fill:expression(alert(1))',
    'graph TD\nA[Node]\nclassDef ready background-image:remote',
  ])('does not silently skip malformed groups or unsafe styling: %s', source => {
    expect(parseSafeMermaid(source)).toMatchObject({ ok: false, reason: 'unsupported-syntax' });
  });
  it('bounds groups, nested groups and class definitions', () => {
    expect(parseSafeMermaid('graph TD\n' + Array.from({ length: 17 }, (_, i) => `subgraph G${i}[Group]\nN${i}\nend`).join('\n'))).toMatchObject({ ok: false, reason: 'graph-limit' });
    expect(parseSafeMermaid('graph TD\n' + Array.from({ length: 5 }, (_, i) => `subgraph G${i}[Group]`).join('\n') + '\nN\n' + 'end\n'.repeat(5))).toMatchObject({ ok: false, reason: 'graph-limit' });
    expect(parseSafeMermaid('graph TD\nN\n' + Array.from({ length: 33 }, (_, i) => `classDef state${i} fill:#eef`).join('\n'))).toMatchObject({ ok: false, reason: 'graph-limit' });
  });
});
