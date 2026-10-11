/** Inert Mermaid flowchart subset. No Mermaid runtime, HTML, CSS, links, callbacks or code execution. */
export const MERMAID_LIMITS = Object.freeze({ sourceChars: 65536, statements: 512, nodes: 64, edges: 128, groups: 16, groupDepth: 4, classes: 32, labelChars: 256 });
export type MermaidDirection = 'TB' | 'TD' | 'BT' | 'LR' | 'RL';
export interface MermaidNode { id: string; label: string; shape: 'rectangle' | 'rounded' | 'diamond' | 'circle'; groupId: string | null; classes: string[] }
export interface MermaidGroup { id: string; label: string; parentId: string | null }
export interface MermaidEdge { from: string; to: string; label: string; style: 'solid' | 'dashed' | 'thick'; arrow: boolean }
export type SafeMermaid = { ok: true; direction: MermaidDirection; nodes: MermaidNode[]; edges: MermaidEdge[]; groups: MermaidGroup[]; notices: ('styles-omitted')[] } | { ok: false; reason: 'source-limit' | 'graph-limit' | 'unsupported-syntax'; line: number | null };
/** Split only outside labels/quotes, never interpret directives or HTML entities. */
function statements(source: string): { text: string; line: number }[] {
  const result: { text: string; line: number }[] = [];
  let pending = '', quote = '', depth = 0, line = 1, start = 1;
  for (const char of source.replace(/\r\n?/gu, '\n')) {
    if (char === '\n' || (char === ';' && !depth && !quote)) {
      if (pending.trim()) result.push({ text: pending.trim(), line: start });
      pending = ''; if (char === '\n') line++; start = line; continue;
    }
    if (char === '"') quote = quote ? '' : char;
    if (!quote) { if ('[({'.includes(char)) depth++; if ('])}'.includes(char)) depth--; }
    pending += char;
  }
  if (pending.trim()) result.push({ text: pending.trim(), line: start });
  return result;
}
export function parseSafeMermaid(source: string): SafeMermaid {
  if (typeof source !== 'string' || source.length > MERMAID_LIMITS.sourceChars) return { ok: false, reason: 'source-limit', line: null };
  const lines = statements(source);
  if (lines.length > MERMAID_LIMITS.statements) return { ok: false, reason: 'graph-limit', line: null };
  // Directives are not ignored, because doing so would silently change diagram semantics.
  if (/%%\{|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source)) return { ok: false, reason: 'unsupported-syntax', line: null };
  const active = lines.filter(line => !line.text.startsWith('%%'));
  const header = /^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)$/u.exec(active[0]?.text ?? '');
  if (!header) return { ok: false, reason: 'unsupported-syntax', line: active[0]?.line ?? 1 };
  const nodes = new Map<string, MermaidNode>(), edges: MermaidEdge[] = [], groups: MermaidGroup[] = [], groupStack: string[] = [];
  const classDefinitions = new Set<string>(), classAssignments: { ids: string[]; classes: string[] }[] = [];
  const labelText = (value: string) => value.replace(/<br\s*\/?>/giu, '\n');
  const fail = (line: number, limit = false): SafeMermaid => ({ ok: false, reason: limit ? 'graph-limit' : 'unsupported-syntax', line });
  for (const statement of active.slice(1)) {
    if (statement.text === 'end') { if (!groupStack.length) return fail(statement.line); groupStack.pop(); continue; }
    if (statement.text.startsWith('subgraph ')) {
      const declaration = statement.text.slice(9).trim();
      const explicit = /^([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\[(?:"([^"]+)"|([^\[\]"]+))\]$/u.exec(declaration);
      const bare = /^(?:"([^"]+)"|([^\[\]"]+))$/u.exec(declaration);
      if (!explicit && !bare) return fail(statement.line);
      const id = explicit?.[1] ?? `inert-group-${groups.length + 1}`, label = labelText(explicit ? explicit[2] ?? explicit[3] : bare![1] ?? bare![2]);
      if (!label || label.length > MERMAID_LIMITS.labelChars) return fail(statement.line, true);
      if (groups.some(group => group.id === id) || nodes.has(id)) return fail(statement.line);
      if (groups.length >= MERMAID_LIMITS.groups || groupStack.length >= MERMAID_LIMITS.groupDepth) return fail(statement.line, true);
      groups.push({ id, label, parentId: groupStack.at(-1) ?? null }); groupStack.push(id); continue;
    }
    if (statement.text.startsWith('classDef ')) {
      const declaration = /^classDef\s+([A-Za-z_][A-Za-z0-9_-]{0,63}(?:,[A-Za-z_][A-Za-z0-9_-]{0,63})*)\s+(.+)$/u.exec(statement.text);
      if (!declaration) return fail(statement.line);
      // Validate a deliberately small presentation grammar, but never apply source CSS.
      // Class names remain visible on nodes; the UI discloses the omitted color/format styling.
      const styles = declaration[2].split(',');
      if (styles.some(style => !/^\s*(?:fill|stroke|color|stroke-width|stroke-dasharray|opacity|font-size|font-weight|font-style|fill-opacity|stroke-opacity)\s*:\s*(?:#[a-f0-9]{3,8}|[a-z]+|[0-9.]+(?:px|em|%)?(?:\s+[0-9.]+(?:px|em|%)?)*)\s*$/iu.test(style))) return fail(statement.line);
      declaration[1].split(',').forEach(name => classDefinitions.add(name));
      if (classDefinitions.size > MERMAID_LIMITS.classes) return fail(statement.line, true);
      continue;
    }
    if (statement.text.startsWith('class ')) {
      const declaration = /^class\s+([A-Za-z_][A-Za-z0-9_-]{0,63}(?:,[A-Za-z_][A-Za-z0-9_-]{0,63})*)\s+([A-Za-z_][A-Za-z0-9_-]{0,63}(?:,[A-Za-z_][A-Za-z0-9_-]{0,63})*)$/u.exec(statement.text);
      if (!declaration) return fail(statement.line);
      classAssignments.push({ ids: declaration[1].split(','), classes: declaration[2].split(',') }); continue;
    }
    let cursor = 0, malformed = false, limit = false;
    const space = () => { while (/\s/u.test(statement.text[cursor] ?? '') && cursor < statement.text.length) cursor++; };
    const parseNode = (): string | null => {
      space(); const match = /^[A-Za-z_](?:[A-Za-z0-9_]|-(?![-.>])){0,63}/u.exec(statement.text.slice(cursor));
      if (!match || ['click', 'style', 'classDef', 'class', 'linkStyle', 'subgraph', 'end', 'direction'].includes(match[0])) return null;
      const id = match[0]; cursor += id.length; space();
      let label = id, shape: MermaidNode['shape'] = 'rectangle', explicit = false;
      const remainder = statement.text.slice(cursor);
      const token = remainder.startsWith('((') ? ['((', '))', 'circle'] : remainder.startsWith('[') ? ['[', ']', 'rectangle'] : remainder.startsWith('(') ? ['(', ')', 'rounded'] : remainder.startsWith('{') ? ['{', '}', 'diamond'] : null;
      if (token) {
        explicit = true; cursor += token[0].length;
        if (statement.text[cursor] === '"') {
          cursor++; const end = statement.text.indexOf('"', cursor);
          if (end < 0 || !statement.text.startsWith(token[1], end + 1)) return null;
          label = statement.text.slice(cursor, end); cursor = end + 1 + token[1].length;
        } else {
          const end = statement.text.indexOf(token[1], cursor);
          if (end < 0) return null;
          label = statement.text.slice(cursor, end);
          if (/[\[\]{}()"\\]/u.test(label)) return null;
          cursor = end + token[1].length;
        }
        shape = token[2] as MermaidNode['shape'];
      }
      if (!label || label.length > MERMAID_LIMITS.labelChars) { limit = label.length > MERMAID_LIMITS.labelChars; return null; }
      label = labelText(label);
      if (groups.some(group => group.id === id)) return null;
      const existing = nodes.get(id);
      if (existing && explicit && (existing.label !== label || existing.shape !== shape) && existing.label !== id) return null;
      if (!existing || explicit) nodes.set(id, { id, label, shape, groupId: existing ? existing.groupId : groupStack.at(-1) ?? null, classes: existing?.classes ?? [] });
      if (nodes.size > MERMAID_LIMITS.nodes) { limit = true; return null; }
      return id;
    };
    let from = parseNode();
    if (!from) return fail(statement.line, limit);
    while (cursor < statement.text.length) {
      space(); if (cursor === statement.text.length) break;
      const edge = /^(-->|---|-\.->|==>)/u.exec(statement.text.slice(cursor));
      if (!edge) { malformed = true; break; }
      cursor += edge[0].length; space();
      let label = '';
      if (statement.text[cursor] === '|') {
        const end = statement.text.indexOf('|', cursor + 1);
        if (end < 0) { malformed = true; break; }
        label = statement.text.slice(cursor + 1, end); cursor = end + 1;
        if (label.length > MERMAID_LIMITS.labelChars) return fail(statement.line, true);
      }
      const to = parseNode(); if (!to) { malformed = true; break; }
      edges.push({ from, to, label: labelText(label), arrow: edge[0] !== '---', style: edge[0] === '-.->' ? 'dashed' : edge[0] === '==>' ? 'thick' : 'solid' });
      if (edges.length > MERMAID_LIMITS.edges) return fail(statement.line, true);
      from = to;
    }
    if (malformed) return fail(statement.line, limit);
  }
  if (groupStack.length) return fail(active.at(-1)?.line ?? 1);
  for (const assignment of classAssignments) {
    for (const id of assignment.ids) {
      const node = nodes.get(id);
      if (!node || assignment.classes.some(name => !classDefinitions.has(name))) return fail(active.at(-1)?.line ?? 1);
      node.classes = [...new Set([...node.classes, ...assignment.classes])];
    }
  }
  if (!nodes.size) return { ok: false, reason: 'unsupported-syntax', line: null };
  return { ok: true, direction: header[1] as MermaidDirection, nodes: [...nodes.values()], edges, groups, notices: classDefinitions.size || classAssignments.length ? ['styles-omitted'] : [] };
}
export interface PositionedMermaidNode extends MermaidNode { x: number; y: number; width: number; height: number; lines: string[]; classLines: string[] }
export interface PositionedMermaidGroup extends MermaidGroup { x: number; y: number; width: number; height: number; lines: string[] }
export interface PositionedMermaidEdge extends MermaidEdge { x1: number; y1: number; x2: number; y2: number; arrowPoints: string; labelLines: string[]; path?: string }
const wrap = (text: string, columns: number) => text.split('\n').flatMap(line => {
  const chars = Array.from(line);
  return Array.from({ length: Math.max(1, Math.ceil(chars.length / columns)) }, (_, index) => chars.slice(index * columns, index * columns + columns).join(''));
});
function layoutNodes(nodes: MermaidNode[], edges: MermaidEdge[], direction: MermaidDirection): { nodes: PositionedMermaidNode[]; width: number; height: number } {
  if (!nodes.length) return { nodes: [], width: 0, height: 0 };
  const horizontal = direction === 'LR' || direction === 'RL', reverse = direction === 'BT' || direction === 'RL';
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  edges.forEach(edge => incoming.set(edge.to, incoming.get(edge.to)! + 1));
  const layers = new Map<string, number>(), queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  queue.forEach(id => layers.set(id, 0));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const edge of edges.filter(edge => edge.from === id)) {
      layers.set(edge.to, Math.max(layers.get(edge.to) ?? 0, layers.get(id)! + 1));
      incoming.set(edge.to, incoming.get(edge.to)! - 1); if (!incoming.get(edge.to)) queue.push(edge.to);
    }
  }
  let remainingLayer = Math.max(0, ...layers.values()) + 1;
  for (const node of nodes) if (!queue.includes(node.id)) layers.set(node.id, remainingLayer++);
  const counts = new Map<number, number>(), maxLayer = Math.max(...layers.values());
  const positioned = nodes.map(node => {
    const layer = layers.get(node.id)!, slot = counts.get(layer) ?? 0; counts.set(layer, slot + 1);
    const rank = reverse ? maxLayer - layer : layer;
    const x = 24 + (horizontal ? rank : slot) * 260, y = 24 + (horizontal ? slot : rank) * 170;
    const lines = wrap(node.label, 24), classLines = node.classes.length ? wrap(`분류: ${node.classes.join(', ')}`, 28) : [];
    return { ...node, x, y, width: 212, height: Math.max(86, lines.length * 18 + classLines.length * 16 + 28), lines, classLines };
  });
  const rowHeight = Math.max(170, ...positioned.map(node => node.height + 64));
  positioned.forEach(node => { node.y = 24 + ((node.y - 24) / 170) * rowHeight; });
  return { nodes: positioned, width: Math.max(...positioned.map(node => node.x + node.width)) + 80, height: Math.max(...positioned.map(node => node.y + node.height)) + 24 };
}
/** Group panels cannot enclose unrelated nodes. Each group owns only nodes declared inside it;
 * child groups are nested and cross-group edges preserve their original endpoints. Layout is approximate. */
export function layoutSafeMermaid(graph: Extract<SafeMermaid, { ok: true }>): { nodes: PositionedMermaidNode[]; edges: PositionedMermaidEdge[]; groups: PositionedMermaidGroup[]; width: number; height: number } {
  const horizontal = graph.direction === 'LR' || graph.direction === 'RL';
  const container = (parentId: string | null): { nodes: PositionedMermaidNode[]; groups: PositionedMermaidGroup[]; width: number; height: number } => {
    const members = graph.nodes.filter(node => node.groupId === parentId), ids = new Set(members.map(node => node.id));
    const own = layoutNodes(members, graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), graph.direction);
    const nodes = own.nodes, groups: PositionedMermaidGroup[] = [];
    let width = own.width, height = own.height;
    const children = graph.groups.filter(group => group.parentId === parentId);
    if (graph.direction === 'BT' || graph.direction === 'RL') children.reverse();
    for (const group of children) {
      const child = container(group.id), lines = wrap(group.label, 32), header = lines.length * 18 + 20;
      const x = horizontal ? width + (width ? 36 : 0) : 0, y = horizontal ? 0 : height + (height ? 36 : 0);
      const groupWidth = Math.max(260, child.width + 40), groupHeight = Math.max(header + 40, child.height + header + 20);
      groups.push({ ...group, x, y, width: groupWidth, height: groupHeight, lines });
      nodes.push(...child.nodes.map(node => ({ ...node, x: node.x + x + 20, y: node.y + y + header })));
      groups.push(...child.groups.map(nested => ({ ...nested, x: nested.x + x + 20, y: nested.y + y + header })));
      width = Math.max(width, x + groupWidth); height = Math.max(height, y + groupHeight);
    }
    return { nodes, groups, width, height };
  };
  const content = container(null), byId = new Map(content.nodes.map(node => [node.id, node]));
  const edges = graph.edges.map(edge => {
    const a = byId.get(edge.from)!, b = byId.get(edge.to)!;
    if (edge.from === edge.to) {
      const x = a.x + a.width, y = a.y + a.height / 2;
      return { ...edge, labelLines: wrap(edge.label, 28), x1: x, y1: y - 16, x2: x, y2: y + 16, path: `M ${x} ${y - 16} C ${x + 48} ${y - 64}, ${x + 48} ${y + 64}, ${x} ${y + 16}`, arrowPoints: `${x},${y + 16} ${x + 10},${y + 14} ${x + 5},${y + 25}` };
    }
    const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2, dx = bx - ax, dy = by - ay;
    const scalar = (node: PositionedMermaidNode) => 1 / Math.max(Math.abs(dx) / (node.width / 2), Math.abs(dy) / (node.height / 2), 1);
    const x1 = ax + dx * scalar(a), y1 = ay + dy * scalar(a), x2 = bx - dx * scalar(b), y2 = by - dy * scalar(b);
    const angle = Math.atan2(dy, dx), size = 9;
    return { ...edge, labelLines: wrap(edge.label, 28), x1, y1, x2, y2, arrowPoints: `${x2},${y2} ${x2 - size * Math.cos(angle - .5)},${y2 - size * Math.sin(angle - .5)} ${x2 - size * Math.cos(angle + .5)},${y2 - size * Math.sin(angle + .5)}` };
  });
  return { ...content, width: content.width + 24, height: content.height + 24, edges };
}
