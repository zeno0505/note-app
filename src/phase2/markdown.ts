/** A deliberately bounded Markdown subset. Browser-safe: no Node APIs, HTML parser, URL loading or filesystem authority. */
export const MARKDOWN_LIMITS = Object.freeze({
  sourceBytes: 256 * 1024, lines: 8192, nodes: 4096, workUnits: 1_500_000,
  inlineChars: 16384, inlineDepth: 6, quoteDepth: 4, listDepth: 6,
  tableColumns: 32, tableRows: 256,
  referenceBytes: 4096, labelBytes: 512, anchorBytes: 512, references: 64,
});
export type MarkdownIssue = 'invalid-source' | 'source-limit' | 'line-limit' | 'node-limit' | 'work-limit' | 'inline-limit' | 'depth-limit' | 'table-limit';
export interface DocumentReference { href: string; relativePath: string; anchor: string | null; label: string; kind: 'link' | 'image' }
export interface DocumentReferences { targets: DocumentReference[]; unsupportedCount: number }
export interface MarkdownReference {
  type: 'reference'; kind: 'link' | 'image'; href: string; label: string;
  disposition: 'local' | 'anchor' | 'blocked'; relativePath: string | null; anchor: string | null; reason: string | null;
}
export type MarkdownInline = { type: 'text' | 'code'; text: string } | { type: 'strong' | 'emphasis'; children: MarkdownInline[] } | MarkdownReference;
export interface MarkdownListItem { children: MarkdownBlock[] }
export type MarkdownAlignment = 'left' | 'center' | 'right' | null;
export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; id: string; anchor: string; children: MarkdownInline[] }
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'code'; text: string; language: string | null }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: 'table'; alignments: MarkdownAlignment[]; header: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { type: 'quote'; children: MarkdownBlock[] };
export interface MarkdownDocument extends DocumentReferences { blocks: MarkdownBlock[]; issues: MarkdownIssue[]; limited: boolean }
const utf8 = new TextEncoder();
const byteLength = (value: string) => utf8.encode(value).length;
const control = /[\u0000-\u001f\u007f]/u;
const textExtensions = new Set(['md', 'markdown', 'txt', 'text', 'log', 'json', 'yaml', 'yml', 'csv', 'diff', 'patch']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const evidenceExtensions = new Set([...textExtensions, ...imageExtensions]);
class Limit extends Error { constructor(readonly issue: MarkdownIssue) { super(issue); } }
interface Context {
  nodes: number; work: number; issues: Set<MarkdownIssue>; references: Map<string, DocumentReference>;
  unsupportedCount: number; headings: Map<string, number>; headingCount: number;
}
function consume(context: Context, count = 1): void { if ((context.work += count) > MARKDOWN_LIMITS.workUnits) throw new Limit('work-limit'); }
function node<T>(context: Context, value: T): T { if (++context.nodes > MARKDOWN_LIMITS.nodes) throw new Limit('node-limit'); return value; }
function validText(value: string, bytes: number): boolean { return Boolean(value.trim()) && value.length <= bytes && byteLength(value) <= bytes && !control.test(value); }
function extension(value: string): string { const name = value.slice(value.lastIndexOf('/') + 1), dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; }

/** Syntax classification is not authorization. Main must validate href again with parseEvidenceTarget. */
function reference(href: string, label: string, kind: 'link' | 'image', context: Context): MarkdownReference {
  const result: MarkdownReference = { type: 'reference', kind, href, label, disposition: 'blocked', relativePath: null, anchor: null, reason: null };
  const blocked = (reason: string) => { result.reason = reason; context.unsupportedCount++; return node(context, result); };
  if (!validText(href, MARKDOWN_LIMITS.referenceBytes) || !validText(label, MARKDOWN_LIMITS.labelBytes)) return blocked('연결 또는 이름이 길이·문자 제한을 벗어났습니다');
  if (href.startsWith('#')) {
    const anchor = href.slice(1);
    if (kind === 'image' || !validText(anchor, MARKDOWN_LIMITS.anchorBytes) || anchor.includes('#')) return blocked('문서 안 앵커 형식을 지원하지 않습니다');
    return node(context, { ...result, disposition: 'anchor', anchor, reason: null });
  }
  const wiki = href.startsWith('[[') && href.endsWith(']]');
  const body = wiki ? href.slice(2, -2) : href;
  const pieces = body.split('|');
  if ((!wiki && pieces.length !== 1) || pieces.length > 2 || pieces.some(piece => !piece) || /[\[\]]/u.test(body)) return blocked('연결 형식을 지원하지 않습니다');
  if (/^(?:https?:|\/\/)/iu.test(pieces[0])) return blocked('외부 연결은 열거나 요청하지 않습니다');
  const target = pieces[0].split('#');
  if (target.length > 2 || target.some(piece => !piece)) return blocked('파일 또는 앵커 형식을 지원하지 않습니다');
  let relativePath = target[0];
  if (relativePath.startsWith('/') || /[\\:#?%\[\]|]/u.test(relativePath) || relativePath.split('/').some(piece => !piece || piece === '.' || piece === '..') || control.test(relativePath)) return blocked('안전한 로컬 상대 경로만 지원합니다');
  // Same conservative default-label bound as parseEvidenceTarget, even with a short Markdown label.
  if (!validText(pieces[1] ?? target[0], MARKDOWN_LIMITS.labelBytes)) return blocked('파일 이름이 길이·문자 제한을 벗어났습니다');
  if (wiki && !extension(relativePath) && !relativePath.slice(relativePath.lastIndexOf('/') + 1).endsWith('.')) relativePath += '.md';
  const anchor = target[1] ?? null;
  if (anchor !== null && !validText(anchor, MARKDOWN_LIMITS.anchorBytes)) return blocked('앵커가 길이·문자 제한을 벗어났습니다');
  const ext = extension(relativePath);
  if (!(kind === 'image' ? imageExtensions : evidenceExtensions).has(ext)) return blocked('이 파일 형식은 근거 뷰어에서 지원하지 않습니다');
  const key = `${kind}\u0000${href}`;
  if (!context.references.has(key) && context.references.size >= MARKDOWN_LIMITS.references) return blocked('문서의 로컬 연결 수 제한을 넘었습니다');
  const local: DocumentReference = { href, relativePath, anchor, label, kind };
  if (!context.references.has(key)) context.references.set(key, local);
  return node(context, { ...result, disposition: 'local', relativePath, anchor, reason: null });
}
function find(text: string, needle: string, from: number, to: number, context: Context): number {
  const end = Math.min(text.length, to);
  for (let cursor = from; cursor < end; cursor++) {
    consume(context);
    if (text[cursor] === '\\') { cursor++; continue; }
    if (text.startsWith(needle, cursor) && cursor + needle.length <= end) return cursor;
  }
  return -1;
}
function destinationEnd(text: string, from: number, context: Context): number {
  let depth = 1;
  for (let cursor = from; cursor < Math.min(text.length, from + MARKDOWN_LIMITS.referenceBytes + 520); cursor++) {
    consume(context);
    if (text[cursor] === '\n' || text[cursor] === '\r') return -1;
    if (text[cursor] === '\\') { cursor++; continue; }
    if (text[cursor] === '(' && ++depth > 4) return -1;
    if (text[cursor] === ')' && --depth === 0) return cursor;
  }
  return -1;
}
/** Both inline code and table splitting use exact backtick runs, so their cell boundaries agree. */
function codeEnd(text: string, from: number, width: number, context: Context): number {
  for (let cursor = from; cursor < text.length;) {
    consume(context);
    if (text[cursor] !== '`') { cursor++; continue; }
    let end = cursor + 1;
    while (text[end] === '`') { consume(context); end++; }
    if (end - cursor === width) return cursor;
    cursor = end;
  }
  return -1;
}
function inline(text: string, context: Context, depth = 0): MarkdownInline[] {
  if (text.length > MARKDOWN_LIMITS.inlineChars || depth >= MARKDOWN_LIMITS.inlineDepth) {
    context.issues.add(depth >= MARKDOWN_LIMITS.inlineDepth ? 'depth-limit' : 'inline-limit');
    return [node(context, { type: 'text', text })];
  }
  const result: MarkdownInline[] = [];
  let cursor = 0, pending = '';
  const flush = () => { if (pending) { result.push(node(context, { type: 'text', text: pending })); pending = ''; } };
  while (cursor < text.length) {
    consume(context);
    const char = text[cursor];
    if (char === '\\' && cursor + 1 < text.length && /[\\`*_[\]{}()#+.!>|~-]/u.test(text[cursor + 1])) { pending += text[cursor + 1]; cursor += 2; continue; }
    if (char === '`') {
      let count = 1;
      while (text[cursor + count] === '`') { consume(context); count++; }
      const marker = '`'.repeat(count);
      const end = count <= 8 ? codeEnd(text, cursor + count, count, context) : -1;
      if (end >= 0) { flush(); result.push(node(context, { type: 'code', text: text.slice(cursor + count, end) })); cursor = end + count; continue; }
      pending += marker; cursor += count; continue;
    }
    const image = text.startsWith('![', cursor), start = image ? cursor + 1 : cursor;
    if (text[start] === '[') {
      if (text.startsWith('[[', start)) {
        const end = find(text, ']]', start + 2, start + MARKDOWN_LIMITS.referenceBytes, context);
        if (end >= 0) {
          const href = text.slice(start, end + 2), body = text.slice(start + 2, end), pieces = body.split('|');
          flush(); result.push(reference(href, pieces[1] || pieces[0], image ? 'image' : 'link', context)); cursor = end + 2; continue;
        }
      } else {
        const end = find(text, '](', start + 1, start + MARKDOWN_LIMITS.labelBytes + 4, context);
        if (end >= 0 && !text.slice(start + 1, end).includes('[')) {
          const close = destinationEnd(text, end + 2, context);
          if (close >= 0) {
            const body = text.slice(end + 2, close);
            const destination = body.match(/^[ \t]*(?:<([^<>\r\n]+)>|([^\s<>]+?))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[ \t]*$/u);
            if (destination) {
              const href = destination[1] ?? destination[2], label = text.slice(start + 1, end) || href;
              flush(); result.push(reference(href, label, image ? 'image' : 'link', context)); cursor = close + 1; continue;
            }
          }
        }
      }
    }
    if (char === '*' || char === '_') {
      const marker = text.startsWith(char + char, cursor) ? char + char : char;
      const before = text[cursor - 1] ?? '', after = text[cursor + marker.length] ?? '';
      // Underscores inside identifiers stay literal. Whitespace-adjacent openers are not emphasis.
      if (after && !/\s/u.test(after) && !(char === '_' && /[\p{L}\p{N}]/u.test(before))) {
        const end = find(text, marker, cursor + marker.length, text.length, context);
        if (end > cursor + marker.length && !/\s/u.test(text[end - 1])) {
          flush(); result.push(node(context, { type: marker.length === 2 ? 'strong' : 'emphasis', children: inline(text.slice(cursor + marker.length, end), context, depth + 1) })); cursor = end + marker.length; continue;
        }
      }
    }
    pending += char; cursor++;
  }
  flush(); return result;
}
function inlineText(nodes: MarkdownInline[]): string { return nodes.map(item => item.type === 'reference' ? item.label : 'children' in item ? inlineText(item.children) : item.text).join(''); }
/** Stable local heading names, not arbitrary DOM IDs or selector text. Percent encoding is intentionally not decoded. */
export function markdownHeadingAnchor(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').trim().replace(/\s+/gu, '-') || 'section';
}
const heading = (line: string) => /^ {0,3}(#{1,6})[ \t]+(.*)$/u.exec(line);
function headingText(input: string): string {
  const text = input.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  return end < text.length && end > 0 && /[ \t]/u.test(text[end - 1]) ? text.slice(0, end).trimEnd() : text;
}
const fence = (line: string) => /^ {0,3}(`{3,64}|~{3,64})([^`~]*)$/u.exec(line);
interface ListMarker { indent: number; contentIndent: number; marker: string; text: string }
function indentation(line: string): number {
  let columns = 0;
  for (const char of line) { if (char === ' ') columns++; else if (char === '\t') columns += 4 - columns % 4; else break; }
  return columns;
}
function listItem(line: string): ListMarker | null {
  const match = /^([ \t]*)([-+*]|\d{1,6}[.)])([ \t]+)(.*)$/u.exec(line);
  if (!match) return null;
  const indent = indentation(match[1]);
  // Count a tab after the marker at its real column, rather than as one space.
  const contentIndent = indentation(' '.repeat(indent + match[2].length) + match[3]);
  return { indent, contentIndent, marker: match[2], text: match[4] };
}
function unindent(line: string, columns: number): string {
  let cursor = 0, removed = 0;
  while (removed < columns && (line[cursor] === ' ' || line[cursor] === '\t')) {
    removed += line[cursor++] === '\t' ? 4 - removed % 4 : 1;
  }
  return ' '.repeat(Math.max(0, removed - columns)) + line.slice(cursor);
}
const quote = (line: string) => /^ {0,3}>[ \t]?(.*)$/u.exec(line);
/** No pipe inside escaped text, a closed code span or a wiki alias can create a cell. */
function tableRow(line: string, context: Context): string[] | null {
  const text = line.trim(), cells: string[] = [];
  let start = 0, boundaries = 0, lastBoundary = -1;
  for (let cursor = 0; cursor < text.length; cursor++) {
    consume(context);
    if (text[cursor] === '\\') { cursor++; continue; }
    if (text[cursor] === '`') {
      let width = 1;
      while (text[cursor + width] === '`') { consume(context); width++; }
      const end = width <= 8 ? codeEnd(text, cursor + width, width, context) : -1;
      cursor = end >= 0 ? end + width - 1 : cursor + width - 1;
      continue;
    }
    if (text.startsWith('[[', cursor)) {
      const end = find(text, ']]', cursor + 2, cursor + MARKDOWN_LIMITS.referenceBytes, context);
      if (end >= 0) { cursor = end + 1; continue; }
    }
    if (text[cursor] !== '|') continue;
    if (cursor !== 0) cells.push(text.slice(start, cursor).trim());
    if (cells.length > MARKDOWN_LIMITS.tableColumns) throw new Limit('table-limit');
    start = cursor + 1; lastBoundary = cursor; boundaries++;
  }
  if (!boundaries) return null;
  if (lastBoundary !== text.length - 1) cells.push(text.slice(start).trim());
  if (cells.length > MARKDOWN_LIMITS.tableColumns) throw new Limit('table-limit');
  return cells.length ? cells : null;
}
function tableStart(lines: string[], cursor: number, context: Context): { header: string[]; alignments: MarkdownAlignment[] } | null {
  const divider = lines[cursor + 1];
  if (!divider || !lines[cursor].includes('|') || !/^[ \t|:-]+$/u.test(divider) || !divider.includes('-')) return null;
  consume(context, divider.length + 1);
  const separators = tableRow(divider, context), header = tableRow(lines[cursor], context);
  if (!separators || !header || separators.length !== header.length || separators.some(cell => !/^:?-{3,}:?$/u.test(cell))) return null;
  return { header, alignments: separators.map(cell => cell.startsWith(':') ? cell.endsWith(':') ? 'center' : 'left' : cell.endsWith(':') ? 'right' : null) };
}
function blocks(lines: string[], context: Context, depth = 0, listDepth = 0): MarkdownBlock[] {
  const result: MarkdownBlock[] = [];
  let cursor = 0;
  const special = (line: string) => heading(line) || fence(line) || (listItem(line)?.indent ?? 4) < 4 || quote(line);
  while (cursor < lines.length) {
    const line = lines[cursor]; consume(context, line.length + 1);
    if (!line.trim()) { cursor++; continue; }
    const opened = fence(line);
    if (opened) {
      const content: string[] = [], marker = opened[1][0], width = opened[1].length;
      cursor++;
      while (cursor < lines.length) {
        const candidate = lines[cursor], trimmed = candidate.trim();
        consume(context, candidate.length + 1);
        if (/^ {0,3}[^ ]/u.test(candidate) && trimmed.length >= width && [...trimmed].every(char => char === marker)) { cursor++; break; }
        content.push(candidate); cursor++;
      }
      result.push(node(context, { type: 'code', text: content.join('\n'), language: opened[2].trim().slice(0, 64) || null })); continue;
    }
    const title = heading(line);
    if (title) {
      const children = inline(headingText(title[2]), context), base = markdownHeadingAnchor(inlineText(children));
      let anchor = base, suffix = context.headings.get(base) ?? 0;
      while (context.headings.has(anchor)) { consume(context); anchor = `${base}-${++suffix}`; }
      context.headings.set(base, suffix); context.headings.set(anchor, 0);
      result.push(node(context, { type: 'heading', level: title[1].length as 1 | 2 | 3 | 4 | 5 | 6, id: `heading-${++context.headingCount}`, anchor, children })); cursor++; continue;
    }
    const quoted = quote(line);
    if (quoted && depth < MARKDOWN_LIMITS.quoteDepth) {
      const content: string[] = [];
      while (cursor < lines.length) { const match = quote(lines[cursor]); if (!match) break; content.push(match[1]); cursor++; }
      result.push(node(context, { type: 'quote', children: blocks(content, context, depth + 1, listDepth) })); continue;
    }
    if (quoted) context.issues.add('depth-limit');
    const item = listItem(line);
    if (item && item.indent < 4) {
      const ordered = /^\d/u.test(item.marker), items: MarkdownListItem[] = [], start = cursor;
      const limited = listDepth >= MARKDOWN_LIMITS.listDepth;
      if (limited) context.issues.add('depth-limit');
      while (cursor < lines.length) {
        const match = listItem(lines[cursor]);
        if (!match || match.indent !== item.indent || /^\d/u.test(match.marker) !== ordered) break;
        consume(context, lines[cursor].length + 1);
        const content = [match.text]; cursor++;
        while (cursor < lines.length) {
          const candidate = lines[cursor]; consume(context, candidate.length + 1);
          if (!candidate.trim()) {
            let next = cursor + 1;
            while (next < lines.length && !lines[next].trim()) { consume(context, lines[next].length + 1); next++; }
            if (next === lines.length || indentation(lines[next]) < match.contentIndent) break;
            content.push(...lines.slice(cursor, next).map(() => '')); cursor = next; continue;
          }
          if (indentation(candidate) < match.contentIndent) break;
          content.push(unindent(candidate, match.contentIndent)); cursor++;
        }
        if (!limited) items.push(node(context, { children: blocks(content, context, depth, listDepth + 1) }));
      }
      if (limited) result.push(node(context, { type: 'paragraph', children: [node(context, { type: 'text', text: lines.slice(start, cursor).join('\n') })] }));
      else result.push(node(context, { type: 'list', ordered, start: ordered ? Number.parseInt(item.marker, 10) : 1, items }));
      continue;
    }
    const table = tableStart(lines, cursor, context);
    if (table) {
      const start = cursor, rows: string[][] = [];
      let malformed = false;
      cursor += 2;
      while (cursor < lines.length && lines[cursor].trim() && !special(lines[cursor])) {
        const row = tableRow(lines[cursor], context);
        if (!row) break;
        if (rows.length >= MARKDOWN_LIMITS.tableRows) throw new Limit('table-limit');
        if (row.length !== table.header.length) malformed = true;
        rows.push(row); cursor++;
      }
      if (malformed) {
        // Do not drop or move malformed cells, and do not register links from an unrendered table.
        result.push(node(context, { type: 'paragraph', children: [node(context, { type: 'text', text: lines.slice(start, cursor).join('\n') })] }));
      } else {
        const cells = (row: string[]) => { node(context, null); return row.map(cell => node(context, inline(cell, context))); };
        result.push(node(context, { type: 'table', alignments: table.alignments, header: cells(table.header), rows: rows.map(cells) }));
      }
      continue;
    }
    const paragraph = [line]; cursor++;
    while (cursor < lines.length && lines[cursor].trim() && !special(lines[cursor]) && !tableStart(lines, cursor, context)) { paragraph.push(lines[cursor]); cursor++; }
    result.push(node(context, { type: 'paragraph', children: inline(paragraph.join('\n'), context) }));
  }
  return result;
}
export function parseSafeMarkdown(input: string): MarkdownDocument {
  const failure = (issue: MarkdownIssue, text = ''): MarkdownDocument => ({ blocks: text ? [{ type: 'code', text, language: null }] : [], targets: [], unsupportedCount: 0, issues: [issue], limited: true });
  if (typeof input !== 'string') return failure('invalid-source');
  if (input.length > MARKDOWN_LIMITS.sourceBytes || byteLength(input) > MARKDOWN_LIMITS.sourceBytes) return failure('source-limit');
  const source = input.replace(/\r\n?/gu, '\n'), lines = source.split('\n');
  if (lines.length > MARKDOWN_LIMITS.lines) return failure('line-limit', source);
  const context: Context = { nodes: 0, work: 0, issues: new Set(), references: new Map(), unsupportedCount: 0, headings: new Map(), headingCount: 0 };
  try {
    const parsed = blocks(lines, context);
    return { blocks: parsed, targets: [...context.references.values()], unsupportedCount: context.unsupportedCount, issues: [...context.issues], limited: context.issues.size > 0 };
  } catch (error) { if (error instanceof Limit) return failure(error.issue, source); throw error; }
}
/** Declarations from rendered syntax only; excludes code, unknown syntax, same-document anchors and blocked destinations. */
export function extractDocumentReferences(text: string): DocumentReferences {
  const document = parseSafeMarkdown(text);
  return { targets: document.targets, unsupportedCount: document.unsupportedCount };
}
