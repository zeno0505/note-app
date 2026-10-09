import { createHash } from 'node:crypto';
/** Internal extracted-record contract, NOT an Orca CLI or authoritative DAG schema. */
export interface SourceRef { sourceId: string; sourceHash: string }
export interface ContextRecord extends SourceRef {
  observedAt: string;
  text: string;
  declaredStatus: 'pending' | 'running' | 'done' | 'blocked' | 'unknown';
  dependencies: Array<{ sourceId: string; declaredStatus: ContextRecord['declaredStatus'] }>;
}
export interface ContextInput {
  schemaVersion: 1;
  scopeId: string;
  records: ContextRecord[];
  coverage: { complete: boolean; totalCount: number | null; unknowns: string[] };
  previousSources: SourceRef[];
  priorApprovedSummary: null | {
    text: string; approvedAt: string; approvalId: string; sources: SourceRef[];
  };
  limits: { maxBytes: number; maxApproxTokens: number; maxRecords: number };
}
export interface ContextPack {
  schemaVersion: 1;
  schemaHash: string;
  packHash: string;
  scopeId: string;
  coverage: ContextInput['coverage'];
  sources: Array<SourceRef & { change: 'new' | 'changed' | 'unchanged' }>;
  absentPreviousSources: Array<SourceRef & { state: 'removed' | 'not-observed' }>;
  priorApprovedSummary: null | (NonNullable<ContextInput['priorApprovedSummary']> & { freshness: 'current' | 'stale' });
  records: ContextRecord[];
  exclusions: Array<{ sourceId: string; reason: 'budget' | 'record-limit' }>;
  unresolvedDependencyIds: string[];
  truncated: boolean;
  usage: { bytes: number; approximateTokens: number; method: 'utf8-byte-proxy-not-model-tokenizer' };
  limits: ContextInput['limits'];
}
export class ContextValidationError extends Error {}
const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
/** Versioned contract fingerprint, not a JSON Schema validator. Bump when semantics change. */
export const CONTEXT_SCHEMA_DESCRIPTOR = 'note-app/context-pack/v1:scopeId;sources(sourceId,sourceHash,change);absentPreviousSources(sourceId,sourceHash,state);priorApprovedSummary(text,approvedAt,approvalId,sources,freshness);records(sourceId,sourceHash,observedAt,text,declaredStatus,dependencies);coverage(complete,totalCount,unknowns);exclusions(sourceId,reason);unresolvedDependencyIds;truncated;limits(maxBytes,maxApproxTokens,maxRecords);usage(bytes,approximateTokens,method);schemaHash;packHash';
export const CONTEXT_SCHEMA_HASH = sha256(CONTEXT_SCHEMA_DESCRIPTOR);
/** Hash excludes only packHash; all content, limits and accounting are bound. */
export function computeContextPackHash(pack: ContextPack): string {
  const { packHash: _excluded, ...payload } = pack;
  return sha256(JSON.stringify(payload));
}
const fail = (message: string): never => { throw new ContextValidationError(message); };
const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Expected plain object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) fail('Unexpected or missing fields');
  return record;
}
function text(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || !value.trim() || utf8Bytes(value) > max) fail('Invalid or oversized text');
  return value as string;
}
function id(value: unknown): string {
  const result = text(value, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) fail('Expected opaque ID, never a path');
  return result;
}
function hash(value: unknown): string {
  const result = text(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) fail('Expected SHA-256 source hash');
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) fail('Invalid canonical UTC timestamp');
  return result;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('Invalid bounded integer');
  return value as number;
}
function array(value: unknown, max = 256): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Invalid or oversized array');
  return value as unknown[];
}
function refs(value: unknown): SourceRef[] {
  return unique(array(value).map(item => {
    const v = object(item, ['sourceId', 'sourceHash']);
    return { sourceId: id(v.sourceId), sourceHash: hash(v.sourceHash) };
  }));
}
function unique<T extends { sourceId: string }>(items: T[]): T[] {
  if (new Set(items.map(item => item.sourceId)).size !== items.length) fail('Duplicate source ID');
  return items.sort((a, b) => compare(a.sourceId, b.sourceId));
}
function status(value: unknown): ContextRecord['declaredStatus'] {
  if (!['pending', 'running', 'done', 'blocked', 'unknown'].includes(value as string)) fail('Invalid declared status');
  return value as ContextRecord['declaredStatus'];
}
/** Copies and validates every field; callers supply already extracted, bounded records. */
export function parseContextInput(input: unknown): ContextInput {
  const v = object(input, ['schemaVersion', 'scopeId', 'records', 'coverage', 'previousSources', 'priorApprovedSummary', 'limits']);
  if (v.schemaVersion !== 1) fail('Unsupported context schema');
  const coverage = object(v.coverage, ['complete', 'totalCount', 'unknowns']);
  if (typeof coverage.complete !== 'boolean') fail('Invalid coverage');
  const records = unique(array(v.records).map(item => {
    const r = object(item, ['sourceId', 'sourceHash', 'observedAt', 'text', 'declaredStatus', 'dependencies']);
    return {
      sourceId: id(r.sourceId), sourceHash: hash(r.sourceHash), observedAt: timestamp(r.observedAt), text: text(r.text), declaredStatus: status(r.declaredStatus),
      dependencies: unique(array(r.dependencies, 32).map(dep => {
        const d = object(dep, ['sourceId', 'declaredStatus']);
        return { sourceId: id(d.sourceId), declaredStatus: status(d.declaredStatus) };
      })),
    };
  }));
  const declaredStates = new Map(records.map(record => [record.sourceId, record.declaredStatus]));
  for (const record of records) {
    for (const dependency of record.dependencies) {
      if (declaredStates.has(dependency.sourceId) && declaredStates.get(dependency.sourceId) !== dependency.declaredStatus) fail('Contradictory dependency declaration');
    }
  }
  const totalCount = coverage.totalCount === null ? null : integer(coverage.totalCount, 0, Number.MAX_SAFE_INTEGER);
  const unknowns = array(coverage.unknowns, 32).map(item => text(item, 500)).sort(compare);
  if (coverage.complete && (totalCount !== records.length || unknowns.length)) fail('Complete coverage must account for all records without unknowns');
  if (totalCount !== null && totalCount < records.length) fail('Total smaller than observed records');
  if (!coverage.complete && totalCount === 0) fail('Incomplete coverage cannot establish zero');
  const previousSources = refs(v.previousSources);
  let priorApprovedSummary: ContextInput['priorApprovedSummary'] = null;
  if (v.priorApprovedSummary !== null) {
    const p = object(v.priorApprovedSummary, ['text', 'approvedAt', 'approvalId', 'sources']);
    const sources = refs(p.sources);
    if (!sources.length) fail('Approved summary requires source provenance');
    const known = new Map([...previousSources, ...records].map(r => [r.sourceId, new Set<string>()]));
    for (const r of [...previousSources, ...records]) known.get(r.sourceId)!.add(r.sourceHash);
    if (sources.some(r => !known.get(r.sourceId)?.has(r.sourceHash))) fail('Summary provenance is not in provided source manifests');
    priorApprovedSummary = { text: text(p.text), approvedAt: timestamp(p.approvedAt), approvalId: id(p.approvalId), sources };
  }
  const limits = object(v.limits, ['maxBytes', 'maxApproxTokens', 'maxRecords']);
  return { schemaVersion: 1, scopeId: id(v.scopeId), records,
    coverage: { complete: coverage.complete as boolean, totalCount, unknowns }, previousSources, priorApprovedSummary,
    limits: { maxBytes: integer(limits.maxBytes, 512, 131072), maxApproxTokens: integer(limits.maxApproxTokens, 512, 131072), maxRecords: integer(limits.maxRecords, 0, 256) } };
}
/** Usage includes the entire compact JSON object, including usage itself. */
export function serializeContextPack(pack: ContextPack): string { return JSON.stringify(pack); }
function measure(pack: ContextPack): void {
  for (let i = 0; i < 10; i++) {
    const bytes = utf8Bytes(serializeContextPack(pack));
    if (bytes === pack.usage.bytes && bytes === pack.usage.approximateTokens) return;
    pack.usage.bytes = bytes;
    pack.usage.approximateTokens = bytes;
  }
  fail('Usage calculation did not converge');
}
export function buildContextPack(input: unknown): ContextPack {
  const v = parseContextInput(input);
  const previous = new Map(v.previousSources.map(r => [r.sourceId, r.sourceHash]));
  const current = new Map(v.records.map(r => [r.sourceId, r.sourceHash]));
  const pack: ContextPack = {
    schemaVersion: 1, schemaHash: CONTEXT_SCHEMA_HASH, packHash: `sha256:${'0'.repeat(64)}`, scopeId: v.scopeId, coverage: v.coverage,
    sources: v.records.map(r => ({ sourceId: r.sourceId, sourceHash: r.sourceHash, change: !previous.has(r.sourceId) ? 'new' : previous.get(r.sourceId) === r.sourceHash ? 'unchanged' : 'changed' })),
    absentPreviousSources: v.previousSources.filter(r => !current.has(r.sourceId)).map(r => ({ ...r, state: v.coverage.complete ? 'removed' : 'not-observed' })),
    priorApprovedSummary: v.priorApprovedSummary ? { ...v.priorApprovedSummary, freshness: v.coverage.complete && v.priorApprovedSummary.sources.every(r => current.get(r.sourceId) === r.sourceHash) ? 'current' : 'stale' } : null,
    records: [], exclusions: v.records.map(r => ({ sourceId: r.sourceId, reason: 'budget' })),
    unresolvedDependencyIds: [...new Set(v.records.flatMap(r => r.dependencies.map(d => d.sourceId)).filter(sourceId => !current.has(sourceId)))].sort(compare),
    truncated: v.records.length > 0, usage: { bytes: 0, approximateTokens: 0, method: 'utf8-byte-proxy-not-model-tokenizer' }, limits: v.limits,
  };
  const fits = (): boolean => { measure(pack); return pack.usage.bytes <= v.limits.maxBytes && pack.usage.approximateTokens <= v.limits.maxApproxTokens; };
  if (!fits()) fail('Budget cannot fit required provenance and coverage metadata');
  // Changed/new records first, then blockers/running work, then opaque ID (no locale).
  const rank = (r: ContextRecord): number => (previous.get(r.sourceId) === r.sourceHash ? 4 : 0) + (r.declaredStatus === 'blocked' ? 0 : r.declaredStatus === 'running' ? 1 : 2);
  for (const r of [...v.records].sort((a, b) => rank(a) - rank(b) || compare(a.sourceId, b.sourceId))) {
    const index = pack.exclusions.findIndex(e => e.sourceId === r.sourceId);
    if (pack.records.length >= v.limits.maxRecords) { pack.exclusions[index].reason = 'record-limit'; continue; }
    const excluded = pack.exclusions.splice(index, 1)[0];
    pack.records.push(r);
    pack.truncated = pack.exclusions.length > 0;
    if (!fits()) { pack.records.pop(); pack.exclusions.splice(index, 0, excluded); pack.truncated = true; }
  }
  if (!fits()) fail('Budget cannot fit final metadata');
  pack.packHash = computeContextPackHash(pack);
  return pack;
}

export interface MissingContextRequest {
  schemaVersion: 1; scopeId: string; sourceIds: string[];
  reason: string; maxBytes: number; maxApproxTokens: number;
}
/** A request is data, not permission to fetch, traverse, browse, run commands or expand scope. */
export function validateMissingContextRequest(input: unknown, pack: ContextPack): MissingContextRequest {
  const v = object(input, ['schemaVersion', 'scopeId', 'sourceIds', 'reason', 'maxBytes', 'maxApproxTokens']);
  if (v.schemaVersion !== 1 || v.scopeId !== pack.scopeId) fail('Missing-context request scope mismatch');
  const sourceIds = array(v.sourceIds, 8).map(id).sort(compare);
  if (!sourceIds.length || new Set(sourceIds).size !== sourceIds.length) fail('Expected 1–8 distinct source IDs');
  const allowed = new Set([...pack.exclusions.map(r => r.sourceId), ...pack.unresolvedDependencyIds]);
  if (sourceIds.some(sourceId => !allowed.has(sourceId))) fail('Requested source is outside the bounded missing-context allowlist');
  return { schemaVersion: 1, scopeId: pack.scopeId, sourceIds, reason: text(v.reason, 500),
    maxBytes: integer(v.maxBytes, 1, Math.min(16384, pack.limits.maxBytes)),
    maxApproxTokens: integer(v.maxApproxTokens, 1, Math.min(16384, pack.limits.maxApproxTokens)) };
}
