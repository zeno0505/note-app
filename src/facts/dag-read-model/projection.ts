import type { DagCoverage, DagTask } from './types';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10000 && v.every(text);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 10000;
function invalid(): never { throw new Error('Invalid DAG query schema.'); }
/** Allowlist projection of official query output. Never reads YAML or recomputes coverage. */
export function projectDagQuery(raw: unknown): { tasks: DagTask[]; coverage: DagCoverage; statusCounts: { status: string | null; count: number }[] } {
  if (!object(raw) || !Array.isArray(raw.index) || raw.index.length > 10000 || !object(raw.coverage)) return invalid();
  const ids = new Set<string>();
  for (const row of raw.index) {
    if (!object(row) || !text(row.id) || ids.has(row.id)) return invalid();
    ids.add(row.id);
  }
  const counts = new Map<string | null, number>();
  const tasks: DagTask[] = raw.index.map((row: Record<string, unknown>) => {
    if ((row.title != null && !text(row.title)) || (row.status != null && !text(row.status))
      || (row.depends_on != null && !strings(row.depends_on))) return invalid();
    // Legacy scalar declarations are still declarations. Unsupported object
    // entries do not erase the DAG or become verified/absent commit evidence.
    if (Array.isArray(row.commits) && row.commits.length > 10000) return invalid();
    const commitItems=row.commits==null?[]:Array.isArray(row.commits)?row.commits:[row.commits];
    const commitReferences=commitItems.filter(text),commitReferencesUnsupported=commitItems.length-commitReferences.length;
    const status = typeof row.status === 'string' ? row.status : null;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    let e2e: DagTask['e2e'] = { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' };
    if (row.e2e != null) {
      if (!object(row.e2e)) return invalid();
      const spec = row.e2e;
      if (spec.required != null && typeof spec.required !== 'boolean') return invalid();
      const malformed = spec.covered_by != null && !strings(spec.covered_by);
      const required = typeof spec.required === 'boolean' ? spec.required : null;
      const coveredBy = strings(spec.covered_by) ? [...spec.covered_by] : null;
      e2e = { state: 'declared', required, coveredBy, coverage: malformed ? 'malformed' : required === null ? 'malformed' : !required ? 'not-required' : coveredBy?.length ? 'references-declared' : 'unmet' };
    }
    return { id: row.id as string, title: typeof row.title === 'string' ? row.title : null, status,
      dependencies: ((row.depends_on ?? []) as string[]).map(id => ({ id, scope: ids.has(id) ? 'internal' as const : 'external' as const })),
      e2e, commitReferences, ...(commitReferencesUnsupported?{commitReferencesUnsupported}:{}), commitVerification: 'not-performed' };
  });
  const coverage = raw.coverage;
  if (!count(coverage.tasks_total) || coverage.tasks_total !== tasks.length || !count(coverage.declared) || !count(coverage.required)
    || coverage.declared > tasks.length || coverage.required > coverage.declared) return invalid();
  const entryIds = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > tasks.length) return invalid();
    const result = v.map(entry => { if (!object(entry) || !text(entry.id) || !ids.has(entry.id)) return invalid(); return entry.id; });
    if (new Set(result).size !== result.length) return invalid();
    return result;
  };
  const uncoveredDone = entryIds(coverage.uncovered_done), uncoveredOpen = entryIds(coverage.uncovered_open), malformed = entryIds(coverage.malformed);
  const uncovered = [...uncoveredDone, ...uncoveredOpen];
  if (new Set(uncovered).size !== uncovered.length || uncovered.length > coverage.required || malformed.some(id => uncovered.includes(id))) return invalid();
  return { tasks, coverage: { tasksTotal: coverage.tasks_total, declared: coverage.declared, required: coverage.required, uncoveredDone, uncoveredOpen, malformed },
    statusCounts: [...counts].map(([status, count]) => ({ status, count })) };
}
