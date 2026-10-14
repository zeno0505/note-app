import type { TaskInput } from './tasks';
import { taskPhaseKey } from './tasks';

export interface TaskGraphNode {
  id: string; task: TaskInput; x: number; y: number; width: number; height: number; layer: number;
  cycle: boolean; phase: string;
}
export interface TaskGraphEdge {
  id: string; from: string; to: string;
  kind: 'internal' | 'cycle' | 'external' | 'hidden' | 'unknown';
  /** Only edges whose endpoints are visible receive SVG geometry. */
  path: string | null;
}
export interface TaskGraph {
  readOnly: true;
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
  width: number;
  height: number;
  diagnostics: {
    cycles: string[][];
    externalDependencies: { taskId: string; dependencyId: string }[];
    hiddenDependencies: { taskId: string; dependencyId: string }[];
    unknownDependencies: { taskId: string; dependencyId: string }[];
    duplicateTaskIds: string[];
    hiddenNodeCount: number;
  };
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Dependency-free deterministic SCC/layer layout. SVG consumers receive no edit
 * operation or mutable source state. External/hidden endpoints stay diagnostics,
 * not fabricated source nodes. Costs are O(V+E) plus stable ordering. */
export function layoutTaskGraph(allTasks: readonly TaskInput[], visibleIds?: readonly string[] | ReadonlySet<string>): TaskGraph {
  const byId = new Map<string, TaskInput>(), duplicates = new Set<string>();
  for (const task of allTasks) {
    if (byId.has(task.id)) duplicates.add(task.id);
    else byId.set(task.id, task);
  }
  // Ambiguous IDs cannot represent a unique source node.
  for (const id of duplicates) byId.delete(id);
  const ids = [...byId.keys()].sort(compare), visible = visibleIds === undefined ? new Set(ids) : new Set(visibleIds);
  const forward = new Map(ids.map(id => [id, [] as string[]])), reverse = new Map(ids.map(id => [id, [] as string[]]));
  for (const id of ids) {
    for (const dependency of byId.get(id)!.dependencies) {
      if (dependency.scope !== 'internal' || !byId.has(dependency.id)) continue;
      forward.get(dependency.id)!.push(id);
      reverse.get(id)!.push(dependency.id);
    }
  }
  for (const graph of [forward, reverse]) for (const [id, edges] of graph) graph.set(id, [...new Set(edges)].sort(compare));
  // Iterative Kosaraju avoids call-stack limits for long dependency chains.
  const visited = new Set<string>(), finished: string[] = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    while (stack.length) {
      const current = stack[stack.length - 1], adjacent = forward.get(current.id)!;
      if (current.next < adjacent.length) {
        const next = adjacent[current.next++];
        if (!visited.has(next)) { visited.add(next); stack.push({ id: next, next: 0 }); }
      } else { finished.push(current.id); stack.pop(); }
    }
  }
  const componentById = new Map<string, number>(), components: string[][] = [];
  for (const start of [...finished].reverse()) {
    if (componentById.has(start)) continue;
    const index = components.length, members: string[] = [], stack = [start];
    componentById.set(start, index);
    while (stack.length) {
      const id = stack.pop()!; members.push(id);
      for (const next of reverse.get(id)!) if (!componentById.has(next)) { componentById.set(next, index); stack.push(next); }
    }
    components.push(members.sort(compare));
  }
  const cycles = components.filter(members => members.length > 1 || forward.get(members[0])!.includes(members[0])).sort((a, b) => compare(a[0], b[0]));
  const cycleIds = new Set(cycles.flat()), componentEdges = components.map(() => new Set<number>()), indegree = components.map(() => 0), layers = components.map(() => 0);
  for (const id of ids) for (const target of forward.get(id)!) {
    const from = componentById.get(id)!, to = componentById.get(target)!;
    if (from !== to && !componentEdges[from].has(to)) { componentEdges[from].add(to); indegree[to]++; }
  }
  const queue = indegree.flatMap((degree, index) => degree === 0 ? [index] : []);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const from = queue[cursor];
    for (const to of componentEdges[from]) {
      layers[to] = Math.max(layers[to], layers[from] + 1);
      if (--indegree[to] === 0) queue.push(to);
    }
  }
  const ranks = new Map<number, string[]>();
  for (const id of ids) {
    if (!visible.has(id)) continue;
    const layer = layers[componentById.get(id)!];
    const rank = ranks.get(layer) ?? []; rank.push(id); ranks.set(layer, rank);
  }
  const nodes: TaskGraphNode[] = [];
  for (const [layer, rank] of [...ranks].sort(([a], [b]) => a - b)) {
    rank.sort((a, b) => (byId.get(a)!.phase?.index ?? Number.MAX_SAFE_INTEGER) - (byId.get(b)!.phase?.index ?? Number.MAX_SAFE_INTEGER) || compare(a, b));
    rank.forEach((id, row) => nodes.push({ id, task: byId.get(id)!, x: 24 + layer * 272, y: 24 + row * 108,
      width: 224, height: 76, layer, cycle: cycleIds.has(id), phase: taskPhaseKey(byId.get(id)!) }));
  }
  const nodeById = new Map(nodes.map(node => [node.id, node])), edges: TaskGraphEdge[] = [];
  const diagnostics: TaskGraph['diagnostics'] = { cycles, externalDependencies: [], hiddenDependencies: [], unknownDependencies: [],
    duplicateTaskIds: [...duplicates].sort(compare), hiddenNodeCount: ids.filter(id => !visible.has(id)).length };
  const edgeIds = new Set<string>();
  for (const taskId of ids) {
    if (!visible.has(taskId)) continue;
    for (const dependency of [...byId.get(taskId)!.dependencies].sort((a, b) => compare(a.id, b.id) || compare(a.scope, b.scope))) {
      const id = JSON.stringify([dependency.id, taskId, dependency.scope]);
      if (edgeIds.has(id)) continue;
      edgeIds.add(id);
      const ref = { taskId, dependencyId: dependency.id };
      let kind: TaskGraphEdge['kind'];
      if (dependency.scope === 'external') { kind = 'external'; diagnostics.externalDependencies.push(ref); }
      else if (!byId.has(dependency.id)) { kind = 'unknown'; diagnostics.unknownDependencies.push(ref); }
      else if (!visible.has(dependency.id)) { kind = 'hidden'; diagnostics.hiddenDependencies.push(ref); }
      else kind = componentById.get(taskId) === componentById.get(dependency.id) && cycleIds.has(taskId) ? 'cycle' : 'internal';
      const from = nodeById.get(dependency.id), to = nodeById.get(taskId);
      let path: string | null = null;
      if ((kind === 'internal' || kind === 'cycle') && from && to) {
        const x1 = from.x + from.width, y1 = from.y + from.height / 2, x2 = to.x, y2 = to.y + to.height / 2;
        if (from.id === to.id) path = `M ${x1} ${y1} C ${x1 + 32} ${y1 - 64}, ${from.x - 32} ${y1 - 64}, ${x2} ${y2}`;
        else { const bend = kind === 'cycle' ? x1 + 32 : (x1 + x2) / 2; path = `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`; }
      }
      edges.push({ id, from: dependency.id, to: taskId, kind, path });
    }
  }
  return { readOnly: true, nodes, edges, width: nodes.length ? Math.max(...nodes.map(node => node.x + node.width)) + 56 : 320,
    height: nodes.length ? Math.max(...nodes.map(node => node.y + node.height)) + 24 : 160, diagnostics };
}
