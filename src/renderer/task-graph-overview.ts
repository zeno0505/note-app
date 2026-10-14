import {
  sameGraphIdentity,
  type LinkedCommitEvidence, type LinkedDateCoverage, type LinkedDateSummary,
} from '../shared/task-graph-contract';
import type { GraphDateReadResult } from '../shared/task-graph-dates';
import type { GraphLayout } from '../shared/task-graph-layout';
import { linkedDateCard, linkedDateKst } from '../shared/linked-date-format';

/** Pure display projections of the complete validated graph and main-owned dates.
 * No display-page rows, local clock, file times, repository reads, or hover I/O. */
export function graphGroupLabels(layout: GraphLayout): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const node of layout.index.nodeById.values()) {
    const key = layout.index.groupById.get(node.id);
    if (key === undefined || labels.has(key)) continue;
    if (layout.grouping === 'phase') {
      labels.set(key, node.phase === null ? 'Phase 미지정'
        : node.phase.title ?? node.phase.id ?? `Phase ${node.phase.index + 1}`);
    } else if (layout.grouping === 'ungrouped') labels.set(key, '전체 작업');
    else {
      // The source index supplies collision-safe tuple keys, never display labels.
      const tuple: unknown = JSON.parse(key);
      labels.set(key, Array.isArray(tuple) && tuple[1] === 'value' && typeof tuple[2] === 'string'
        ? tuple[2] : '접두사 미분류');
    }
  }
  return labels;
}

/** For many cards, compute graphGroupLabels once and use its map directly. */
export function graphGroupLabel(layout: GraphLayout, key: string): string {
  return graphGroupLabels(layout).get(key) ?? '그룹 미확인';
}

export type GraphDeclaredStatusTone = 'done' | 'deferred' | 'superseded' | 'pending' | 'running' | 'unknown';
export interface GraphDeclaredStatusDisplay { label: string; tone: GraphDeclaredStatusTone }

/** Tone is only a visual hint for declared text, never a verified lifecycle claim.
 * Translate the approved vocabulary only; arbitrary declarations stay verbatim.
 * The caller displays the original declaration separately in the evidence detail. */
export function graphDeclaredStatus(status: string | null): GraphDeclaredStatusDisplay {
  switch (status) {
    case 'done': return { label: '완료', tone: 'done' };
    case 'deferred': return { label: '보류', tone: 'deferred' };
    case 'superseded': return { label: '대체됨', tone: 'superseded' };
    case 'pending': return { label: '대기', tone: 'pending' };
    case 'running': return { label: '실행 중', tone: 'running' };
    default: return { label: status ?? '미선언', tone: 'unknown' };
  }
}

function emptyCoverage(): LinkedDateCoverage {
  return { inspection: 'complete', tasks: { total: 0, resolved: 0, noReference: 0, unresolved: 0 },
    references: { total: 0, resolved: 0, unresolved: 0 } };
}

/** Same deterministic maximum/tie order as the authoritative main summarizer. */
function compareEvidence(a: LinkedCommitEvidence, b: LinkedCommitEvidence): number {
  const time = Date.parse(b.committerAtUtc) - Date.parse(a.committerAtUtc);
  if (time) return time;
  const key = (e: LinkedCommitEvidence) => JSON.stringify([
    `${e.repository.host}/${e.repository.owner}/${e.repository.name}`.toLowerCase(),
    e.sha, e.taskId, e.declaredReference,
  ]);
  const left = key(a), right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergeCoverage(target: LinkedDateCoverage, source: LinkedDateCoverage): void {
  if (source.inspection === 'unknown' || target.inspection === 'unknown') target.inspection = 'unknown';
  else if (source.inspection === 'partial') target.inspection = 'partial';
  for (const key of ['total', 'resolved', 'noReference', 'unresolved'] as const) target.tasks[key] += source.tasks[key];
  for (const key of ['total', 'resolved', 'unresolved'] as const) target.references[key] += source.references[key];
}

function dateSummary(coverage: LinkedDateCoverage, latest: LinkedCommitEvidence | null): LinkedDateSummary {
  if (latest) return { state: coverage.inspection === 'complete'
    && coverage.tasks.resolved === coverage.tasks.total && coverage.references.unresolved === 0 ? 'resolved' : 'partial', latest, coverage };
  return { state: coverage.inspection === 'complete' && coverage.references.total === 0 ? 'no-reference' : 'unknown', latest: null, coverage };
}

/** Aggregate task-bound coverage, not unique SHAs or visible nodes. A missing or
 * duplicate task result remains uninspected; it can never become no-reference.
 * The graph-wide response summary is not substituted for an individual group. */
export function graphGroupDateSummaries(layout: GraphLayout, result: GraphDateReadResult | null | undefined): ReadonlyMap<string, LinkedDateSummary> {
  const summaries = new Map<string, LinkedDateSummary>();
  if (result?.state !== 'dates' || !sameGraphIdentity(layout.identity, result.identity)) return summaries;
  const byId = new Map<string, LinkedDateSummary>(), ambiguous = new Set<string>();
  for (const task of result.tasks) {
    if (byId.has(task.id)) ambiguous.add(task.id);
    else byId.set(task.id, task.summary);
  }
  const grouped = new Map(layout.groups.map(group => [group.key, { coverage: emptyCoverage(), latest: null as LinkedCommitEvidence | null }]));
  for (const id of layout.index.nodeById.keys()) {
    const key = layout.index.groupById.get(id), group = key === undefined ? undefined : grouped.get(key);
    if (!group) continue;
    const task = ambiguous.has(id) ? undefined : byId.get(id);
    if (!task) {
      group.coverage.inspection = 'unknown';
      group.coverage.tasks.total++;
      group.coverage.tasks.unresolved++;
      continue;
    }
    mergeCoverage(group.coverage, task.coverage);
    if (task.latest && (!group.latest || compareEvidence(task.latest, group.latest) < 0)) group.latest = task.latest;
  }
  for (const [key, group] of grouped) summaries.set(key, dateSummary(group.coverage, group.latest));
  return summaries;
}

/** MM.DD is safe only if every known displayed date shares one KST year. */
export function graphDateYearContext(summaries: Iterable<LinkedDateSummary | null | undefined>): string | undefined {
  let year: string | undefined;
  for (const summary of summaries) {
    if (!summary?.latest) continue;
    const next = linkedDateKst(summary.latest.committerAtUtc)?.slice(0, 4);
    if (!next) continue;
    if (year !== undefined && year !== next) return undefined;
    year = next;
  }
  return year;
}

export function graphDateShortLabel(summary: LinkedDateSummary | null | undefined, visibleYear?: string): string {
  if (!summary?.latest) return '미확인';
  const date = linkedDateCard(summary.latest.committerAtUtc, visibleYear);
  return date ?? '미확인';
}
