import { createHash, randomUUID } from 'node:crypto';
import { computeContextPackHash, CONTEXT_SCHEMA_HASH, parseContextInput, type ContextPack, type ContextRecord } from '../context';

export const ASPECTS = ['goal', 'implemented', 'remaining', 'current', 'next', 'blockers'] as const;
export type Aspect = typeof ASPECTS[number];
export interface Citation { sourceId: string; sourceHash: string; observedAt: string; quote: string }
export interface DeclaredStatusAssertion { type: 'declared-status'; sourceId: string; status: ContextRecord['declaredStatus'] }
export interface SummaryClaim {
  claimId: string; aspect: Aspect; kind: 'fact' | 'inference' | 'unknown'; text: string;
  intent: 'informational' | 'proposal'; citations: Citation[]; assertions: DeclaredStatusAssertion[];
}
export interface SummaryBinding { scopeId: string; schemaHash: string; packHash: string }
export interface SummaryResponse extends SummaryBinding { schemaVersion: 1; generatedAt: string; claims: SummaryClaim[] }
export interface SummaryCandidate extends SummaryResponse { status: 'candidate'; candidateHash: string }
export class SummaryValidationError extends Error {}
function fail(message: string): never { throw new SummaryValidationError(message); }
const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
/** Versioned application contract identifier, not an Orca-owned schema. Change on contract changes. */
export const SUMMARY_RESPONSE_SCHEMA_HASH = digest('note-app/summary-response/v1:bounded-quotes;declared-status-only;proposal-next;candidate-only');
export const MAX_RESPONSE_BYTES = 131072;
const bytes = (value: string): number => new TextEncoder().encode(value).length;
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('Expected plain data object');
  const properties = Reflect.ownKeys(input);
  if (properties.length !== keys.length || properties.some(k => typeof k !== 'string' || !keys.includes(k))) fail('Unexpected or missing fields');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !('value' in property)) fail('Accessors are not data');
    result[key] = property.value;
  }
  return result;
}
function list(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length > maximum || Reflect.ownKeys(input).length !== input.length + 1) fail('Invalid bounded array');
  const result: unknown[] = [];
  for (let i = 0; i < input.length; i++) {
    const p = Object.getOwnPropertyDescriptor(input, String(i));
    if (!p || !('value' in p)) fail('Expected dense data array');
    result.push(p.value);
  }
  return result;
}
function text(input: unknown, maximum = 4096): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || bytes(input) > maximum) fail('Invalid or oversized text');
  return input;
}
function id(input: unknown): string {
  const value = text(input, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) fail('Invalid opaque ID');
  return value;
}
function hash(input: unknown): string {
  const value = text(input, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) fail('Invalid SHA-256 hash');
  return value;
}
function time(input: unknown): string {
  const value = text(input, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Invalid canonical UTC time');
  return value;
}
function oneOf<T extends string>(input: unknown, values: readonly T[]): T {
  if (typeof input !== 'string' || !values.includes(input as T)) fail('Unsupported enum or assertion');
  return input as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function detached<T>(value: T): T { return freeze(structuredClone(value)); }
export function bindSummaryContext(pack: ContextPack): SummaryBinding {
  if (computeContextPackHash(pack) !== pack.packHash) fail('Context pack hash mismatch');
  return { scopeId: pack.scopeId, schemaHash: SUMMARY_RESPONSE_SCHEMA_HASH, packHash: pack.packHash };
}
/** This checks provenance and bounded structure, not semantic truth or execution permission. */
export function parseSummaryResponse(input: unknown, pack: ContextPack): SummaryCandidate {
  if (typeof input === 'string') {
    if (input.length > MAX_RESPONSE_BYTES || bytes(input) > MAX_RESPONSE_BYTES) fail('Response exceeds byte budget');
    try { input = JSON.parse(input); } catch { fail('Invalid JSON response'); }
  }
  const v = object(input, ['schemaVersion', 'scopeId', 'schemaHash', 'packHash', 'generatedAt', 'claims']);
  const binding = bindSummaryContext(pack);
  if (v.schemaVersion !== 1 || id(v.scopeId) !== binding.scopeId || hash(v.schemaHash) !== binding.schemaHash || hash(v.packHash) !== binding.packHash) fail('Response binding mismatch');
  const generatedAt = time(v.generatedAt);
  const sources = new Map(pack.records.map(r => [r.sourceId, r]));
  const claims = list(v.claims, 48).map(inputClaim => {
    const c = object(inputClaim, ['claimId', 'aspect', 'kind', 'text', 'intent', 'citations', 'assertions']);
    const claimId = id(c.claimId);
    const aspect = oneOf(c.aspect, ASPECTS);
    const kind = oneOf(c.kind, ['fact', 'inference', 'unknown'] as const);
    const intent = oneOf(c.intent, ['informational', 'proposal'] as const);
    if (intent !== (aspect === 'next' ? 'proposal' : 'informational') || (aspect === 'next' && kind === 'fact')) fail('Next steps must remain proposals');
    const claimText = text(c.text);
    const citations = list(c.citations, 16).map(inputCitation => {
      const x = object(inputCitation, ['sourceId', 'sourceHash', 'observedAt', 'quote']);
      const citation = { sourceId: id(x.sourceId), sourceHash: hash(x.sourceHash), observedAt: time(x.observedAt), quote: text(x.quote, 8192) };
      const source = sources.get(citation.sourceId);
      if (!source || source.sourceHash !== citation.sourceHash || source.observedAt !== citation.observedAt || !source.text.includes(citation.quote)) fail('Citation must exactly reference an included source and excerpt');
      if (citation.observedAt > generatedAt) fail('Response predates cited observation');
      return citation;
    });
    if (new Set(citations.map(c => c.sourceId)).size !== citations.length) fail('Duplicate citation source');
    if (kind !== 'unknown' && !citations.length) fail('Fact or inference requires evidence');
    // A fact is only a reported verbatim excerpt, never a model paraphrase promoted to truth.
    if (kind === 'fact' && !citations.some(c => c.quote === claimText)) fail('Fact text must be a cited verbatim excerpt');
    const assertions = list(c.assertions, 16).map(inputAssertion => {
      const a = object(inputAssertion, ['type', 'sourceId', 'status']);
      const type = oneOf(a.type, ['declared-status'] as const);
      const sourceId = id(a.sourceId);
      const status = oneOf(a.status, ['pending', 'running', 'done', 'blocked', 'unknown'] as const);
      if (kind === 'unknown' || !citations.some(c => c.sourceId === sourceId) || sources.get(sourceId)?.declaredStatus !== status) fail('Unsupported declared status assertion');
      return { type, sourceId, status };
    });
    if (new Set(assertions.map(a => a.sourceId)).size !== assertions.length) fail('Duplicate status assertion');
    return { claimId, aspect, kind, text: claimText, intent, citations, assertions };
  });
  if (!claims.length || new Set(claims.map(c => c.claimId)).size !== claims.length) fail('Expected distinct nonempty claims');
  const response: SummaryResponse = { schemaVersion: 1, ...binding, generatedAt, claims };
  const serialized = JSON.stringify(response);
  if (bytes(serialized) > MAX_RESPONSE_BYTES) fail('Response exceeds byte budget');
  return detached({ ...response, status: 'candidate', candidateHash: digest(serialized) });
}

export type Freshness = 'current' | 'stale' | 'unknown';
export interface ClaimView { claim: SummaryClaim; freshness: Freshness; reasons: string[] }
export interface UserSummaryApproval {
  kind: 'user-summary-approval'; incarnation: string; scopeId: string; candidateHash: string; expectedVersion: number;
  approvalId: string; approvedAt: string;
}
export interface ApprovedSummary { status: 'approved'; approvalId: string; approvedAt: string; summary: SummaryCandidate }
export interface SummaryRequest { incarnation: string; requestId: number; version: number; binding: SummaryBinding; claimIds: string[] | null }
export interface SummaryStoreSnapshot {
  incarnation: string; version: number; binding: SummaryBinding; candidate: SummaryCandidate | null; approved: ApprovedSummary | null;
  candidateClaims: ClaimView[]; approvedClaims: ClaimView[]; lastFailure: string | null;
}
function recordIdentity(record: ContextRecord | undefined): string | null {
  return record ? JSON.stringify({ text: record.text, declaredStatus: record.declaredStatus, dependencies: record.dependencies }) : null;
}
function view(claim: SummaryClaim, pack: ContextPack, basis: ContextPack): ClaimView {
  const current = new Map(pack.sources.map(s => [s.sourceId, s.sourceHash]));
  const reasons = claim.citations.flatMap(c => !current.has(c.sourceId) ? [`${c.sourceId}:not-observed`] : current.get(c.sourceId) !== c.sourceHash ? [`${c.sourceId}:changed`] : []);
  for (const c of claim.citations) {
    const before = basis.records.find(r => r.sourceId === c.sourceId);
    const after = pack.records.find(r => r.sourceId === c.sourceId);
    if (!before || !after) reasons.push(`${c.sourceId}:extraction-unavailable`);
    else if (recordIdentity(before) !== recordIdentity(after)) reasons.push(`${c.sourceId}:extraction-changed`);
  }
  // Without a declared aggregate dependency model, scope growth/coverage changes affect every aspect.
  if (pack.sources.some(s => !basis.sources.some(old => old.sourceId === s.sourceId))) reasons.push('scope:sources-added');
  if (JSON.stringify(pack.coverage) !== JSON.stringify(basis.coverage)) reasons.push('scope:coverage-changed');
  const uncertain = claim.kind === 'unknown' || reasons.some(r => r.endsWith(':not-observed') || r.endsWith(':extraction-unavailable')) || (!pack.coverage.complete && reasons.includes('scope:coverage-changed'));
  return { claim, freshness: uncertain ? 'unknown' : reasons.length ? 'stale' : 'current', reasons };
}
function identity(pack: ContextPack): string {
  // Observation clock alone does not schedule another summary. Extracted semantics and coverage do.
  return JSON.stringify({ scopeId: pack.scopeId, sources: [...pack.sources].map(s => [s.sourceId, s.sourceHash]).sort(),
    records: [...pack.records].map(r => [r.sourceId, recordIdentity(r)]).sort(), coverage: pack.coverage });
}
/** In-memory contract only. The host must authenticate user approval events separately. */
export function createSummaryStore(initialPack: ContextPack, localState?: SummaryStoreState) {
  bindSummaryContext(initialPack);
  const incarnation = randomUUID();
  let pack = detached(initialPack);
  let candidateBases = new Map<string, ContextPack>();
  let approvedBases = new Map<string, ContextPack>();
  let version = 0;
  let requestId = 0;
  let activeRequest: SummaryRequest | null = null;
  let candidate: SummaryCandidate | null = null;
  let approved: ApprovedSummary | null = null;
  let lastFailure: string | null = null;
  let pendingClaimIds: string[] | null = null;
  if (localState) {
    const restored = parseSummaryStoreState(localState);
    if (restored.currentPackHash !== pack.packHash) fail('Restore context mismatch');
    const packs = new Map(restored.packs.map(p => [p.packHash, p]));
    candidate = restored.candidate; approved = restored.approved;
    candidateBases = new Map(restored.candidateBases.map(b => [b.claimId, packs.get(b.packHash)!]));
    approvedBases = new Map(restored.approvedBases.map(b => [b.claimId, packs.get(b.packHash)!]));
    version = restored.version + 1; lastFailure = restored.lastFailure;
    pendingClaimIds = candidate || approved ? (candidate?.claims ?? approved!.summary.claims).filter(c => view(c, pack, (candidate ? candidateBases : approvedBases).get(c.claimId)!).freshness !== 'current').map(c => c.claimId) : null;
    if (pendingClaimIds?.length === 0 && (candidate ?? approved?.summary)?.packHash !== pack.packHash) pendingClaimIds = null;
  }
  const snapshot = (): SummaryStoreSnapshot => detached({ incarnation, version, binding: bindSummaryContext(pack), candidate, approved,
    candidateClaims: candidate?.claims.map(c => view(c, pack, candidateBases.get(c.claimId) ?? pack)) ?? [], approvedClaims: approved?.summary.claims.map(c => view(c, pack, approvedBases.get(c.claimId) ?? pack)) ?? [], lastFailure });
  return {
    snapshot,
    exportState(): SummaryStoreState {
      const packs = new Map<string, ContextPack>([[pack.packHash, pack]]);
      for (const basis of [...candidateBases.values(), ...approvedBases.values()]) packs.set(basis.packHash, basis);
      return parseSummaryStoreState({ schemaVersion: 1, version, currentPackHash: pack.packHash, packs: [...packs.values()], candidate, approved,
        candidateBases: [...candidateBases].map(([claimId, p]) => ({ claimId, packHash: p.packHash })),
        approvedBases: [...approvedBases].map(([claimId, p]) => ({ claimId, packHash: p.packHash })), lastFailure });
    },
    updateContext(next: ContextPack): { changed: boolean; affectedClaimIds: string[] } {
      bindSummaryContext(next);
      if (next.scopeId !== pack.scopeId) fail('Cannot change store scope');
      if (identity(next) === identity(pack)) return { changed: false, affectedClaimIds: [] };
      pack = detached(next); version++; activeRequest = null;
      const claims = candidate?.claims ?? approved?.summary.claims ?? [];
      pendingClaimIds = candidate || approved ? claims.filter(c => view(c, pack, (candidate ? candidateBases : approvedBases).get(c.claimId) ?? pack).freshness !== 'current').map(c => c.claimId) : null;
      // A changed uncited source still changes the reviewed context. Request a complete
      // replacement instead of stranding an old candidate behind a new pack binding.
      if (pendingClaimIds?.length === 0 && (candidate ?? approved?.summary)?.packHash !== pack.packHash) pendingClaimIds = null;
      return { changed: true, affectedClaimIds: pendingClaimIds ?? [] };
    },
    beginUpdate(): SummaryRequest | null {
      const claimIds = pendingClaimIds;
      if (claimIds?.length === 0) return null;
      activeRequest = detached({ incarnation, requestId: ++requestId, version, binding: bindSummaryContext(pack), claimIds });
      return detached(activeRequest);
    },
    acceptResponse(ticket: SummaryRequest, input: unknown): boolean {
      if (!activeRequest || ticket.incarnation !== incarnation || ticket.requestId !== activeRequest.requestId || ticket.version !== version || JSON.stringify(ticket) !== JSON.stringify(activeRequest)) return false;
      try {
        const parsed = parseSummaryResponse(input, pack);
        const expected = activeRequest.claimIds;
        if (expected && (parsed.claims.length !== expected.length || parsed.claims.some(c => !expected.includes(c.claimId)))) fail('Incremental response must replace only the requested affected claims');
        const prior = candidate?.claims ?? approved?.summary.claims ?? [];
        if (expected && parsed.claims.some(c => prior.find(p => p.claimId === c.claimId)?.aspect !== c.aspect)) fail('Cannot change an existing claim aspect');
        const merged = expected ? prior.map(c => parsed.claims.find(p => p.claimId === c.claimId) ?? c) : parsed.claims;
        if (ASPECTS.some(aspect => !merged.some(c => c.aspect === aspect))) fail('Initial summary must cover all six aspects');
        // Unaffected claims keep their original observedAt/source provenance; they need not be resent.
        const response: SummaryResponse = { schemaVersion: 1, scopeId: parsed.scopeId, schemaHash: parsed.schemaHash, packHash: parsed.packHash, generatedAt: parsed.generatedAt, claims: merged };
        const serialized = JSON.stringify(response);
        if (bytes(serialized) > MAX_RESPONSE_BYTES || merged.some(c => c.citations.some(citation => citation.observedAt > response.generatedAt))) fail('Merged summary exceeds budget or predates cited observation');
        const nextBases = expected ? new Map(candidate ? candidateBases : approvedBases) : new Map<string, ContextPack>();
        for (const claim of parsed.claims) nextBases.set(claim.claimId, pack);
        candidateBases = nextBases;
        candidate = detached({ ...response, status: 'candidate', candidateHash: digest(serialized) });
        version++; activeRequest = null; lastFailure = null; pendingClaimIds = [];
        return true;
      } catch (error) {
        lastFailure = error instanceof SummaryValidationError ? error.message : 'Invalid response';
        activeRequest = null;
        return false;
      }
    },
    failRequest(ticket: SummaryRequest, reason: string): boolean {
      if (!activeRequest || ticket.incarnation !== incarnation || ticket.requestId !== activeRequest.requestId || ticket.version !== version) return false;
      lastFailure = text(reason, 500); activeRequest = null; return true;
    },
    approve(event: UserSummaryApproval): boolean {
      // Deliberately separate from model parsing. A model-supplied approval field is rejected.
      const e = object(event, ['kind', 'incarnation', 'scopeId', 'candidateHash', 'expectedVersion', 'approvalId', 'approvedAt']);
      if (e.kind !== 'user-summary-approval' || e.incarnation !== incarnation || e.scopeId !== pack.scopeId || !candidate || e.candidateHash !== candidate.candidateHash || e.expectedVersion !== version) return false;
      if (candidate.packHash !== pack.packHash) return false;
      if (candidate.claims.some(c => c.kind !== 'unknown' && view(c, pack, candidateBases.get(c.claimId) ?? pack).freshness !== 'current')) return false;
      const approvedAt = time(e.approvedAt);
      if (approvedAt < candidate.generatedAt) fail('Approval predates candidate');
      approvedBases = new Map(candidateBases);
      approved = detached({ status: 'approved', approvalId: id(e.approvalId), approvedAt, summary: candidate });
      version++; activeRequest = null; return true;
    },
  };
}

/** LOCAL HOST STATE ONLY. Integrity is not evidence of a real user action. Never accept from a renderer/model/import. */
export interface SummaryStoreState {
  schemaVersion: 1; version: number; currentPackHash: string; packs: ContextPack[];
  candidate: SummaryCandidate | null; approved: ApprovedSummary | null;
  candidateBases: Array<{ claimId: string; packHash: string }>;
  approvedBases: Array<{ claimId: string; packHash: string }>;
  lastFailure: string | null;
}
export const MAX_SUMMARY_STATE_BYTES = 3 * 1024 * 1024;
function boundedNumber(input: unknown, max = Number.MAX_SAFE_INTEGER - 2): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > max) fail('Invalid stored number');
  return input;
}
function storedPack(input: unknown): ContextPack {
  const p = object(input, ['schemaVersion', 'schemaHash', 'packHash', 'scopeId', 'coverage', 'sources', 'absentPreviousSources', 'priorApprovedSummary', 'records', 'exclusions', 'unresolvedDependencyIds', 'truncated', 'usage', 'limits']);
  if (p.schemaVersion !== 1 || p.schemaHash !== CONTEXT_SCHEMA_HASH) fail('Unsupported stored context schema');
  const sourceRefs = (input: unknown) => list(input, 256).map(x => { const s = object(x, ['sourceId', 'sourceHash', 'change']); return { sourceId: id(s.sourceId), sourceHash: hash(s.sourceHash), change: oneOf(s.change, ['new', 'changed', 'unchanged'] as const) }; });
  const sources = sourceRefs(p.sources);
  if (new Set(sources.map(s => s.sourceId)).size !== sources.length) fail('Duplicate stored sources');
  const absent = list(p.absentPreviousSources, 256).map(x => { const s = object(x, ['sourceId', 'sourceHash', 'state']); return { sourceId: id(s.sourceId), sourceHash: hash(s.sourceHash), state: oneOf(s.state, ['removed', 'not-observed'] as const) }; });
  if (new Set(absent.map(s => s.sourceId)).size !== absent.length || absent.some(a => sources.some(s => s.sourceId === a.sourceId))) fail('Conflicting stored absence');
  const coverage = object(p.coverage, ['complete', 'totalCount', 'unknowns']);
  if (typeof coverage.complete !== 'boolean') fail('Invalid stored coverage');
  const totalCount = coverage.totalCount === null ? null : boundedNumber(coverage.totalCount);
  const unknowns = list(coverage.unknowns, 32).map(x => text(x, 500));
  if ((coverage.complete && (totalCount !== sources.length || unknowns.length)) || (totalCount !== null && totalCount < sources.length) || (!coverage.complete && totalCount === 0)) fail('Invalid stored coverage accounting');
  if (absent.some(a => a.state !== (coverage.complete ? 'removed' : 'not-observed'))) fail('Incorrect absence state');
  const rawRecords = list(p.records, 256);
  // Reuse the strict record/input parser; actual scope coverage is checked against the full source manifest above.
  const parsed = parseContextInput({ schemaVersion: 1, scopeId: p.scopeId, records: rawRecords, coverage: { complete: true, totalCount: rawRecords.length, unknowns: [] }, previousSources: [], priorApprovedSummary: null, limits: p.limits });
  if (parsed.records.length > parsed.limits.maxRecords) fail('Stored record limit exceeded');
  if (parsed.records.some(r => !sources.some(s => s.sourceId === r.sourceId && s.sourceHash === r.sourceHash))) fail('Stored record missing from manifest');
  const exclusions = list(p.exclusions, 256).map(x => { const s = object(x, ['sourceId', 'reason']); return { sourceId: id(s.sourceId), reason: oneOf(s.reason, ['budget', 'record-limit'] as const) }; });
  if (new Set(exclusions.map(e => e.sourceId)).size !== exclusions.length || exclusions.some(e => !sources.some(s => s.sourceId === e.sourceId) || parsed.records.some(r => r.sourceId === e.sourceId)) || exclusions.length + parsed.records.length !== sources.length || p.truncated !== !!exclusions.length) fail('Invalid stored exclusions');
  const unresolved = list(p.unresolvedDependencyIds, 256).map(id);
  if (JSON.stringify(unresolved) !== JSON.stringify([...new Set(parsed.records.flatMap(r => r.dependencies.map(d => d.sourceId)).filter(sourceId => !sources.some(s => s.sourceId === sourceId)))].sort())) {
    fail('Cannot restore unproven unresolved dependency set');
  }
  const usage = object(p.usage, ['bytes', 'approximateTokens', 'method']);
  if (usage.method !== 'utf8-byte-proxy-not-model-tokenizer' || usage.bytes !== usage.approximateTokens || boundedNumber(usage.bytes, 131072) > parsed.limits.maxBytes || (usage.bytes as number) > parsed.limits.maxApproxTokens) fail('Invalid stored usage');
  let prior: ContextPack['priorApprovedSummary'] = null;
  if (p.priorApprovedSummary !== null) {
    const a = object(p.priorApprovedSummary, ['text', 'approvedAt', 'approvalId', 'sources', 'freshness']);
    const refs = list(a.sources, 256).map(x => { const r = object(x, ['sourceId', 'sourceHash']); return { sourceId: id(r.sourceId), sourceHash: hash(r.sourceHash) }; });
    if (!refs.length || new Set(refs.map(r => r.sourceId)).size !== refs.length) fail('Invalid prior summary sources');
    for (const ref of refs) {
      const source = sources.find(s => s.sourceId === ref.sourceId);
      const missing = absent.find(s => s.sourceId === ref.sourceId);
      if ((!source && !missing) || (missing && missing.sourceHash !== ref.sourceHash) || (source && source.change !== 'changed' && source.sourceHash !== ref.sourceHash)) fail('Prior summary source is outside stored provenance');
    }
    prior = { text: text(a.text, 8192), approvedAt: time(a.approvedAt), approvalId: id(a.approvalId), sources: refs, freshness: oneOf(a.freshness, ['current', 'stale'] as const) };
    const fresh = coverage.complete && refs.every(r => sources.some(s => s.sourceId === r.sourceId && s.sourceHash === r.sourceHash));
    if (prior.freshness !== (fresh ? 'current' : 'stale')) fail('Incorrect stored prior freshness');
  }
  // Preserve canonical builder ordering, including rank-ordered records; input parser sorts its copy.
  const pack = { schemaVersion: 1, schemaHash: CONTEXT_SCHEMA_HASH, packHash: hash(p.packHash), scopeId: id(p.scopeId), coverage: { complete: coverage.complete, totalCount, unknowns }, sources, absentPreviousSources: absent, priorApprovedSummary: prior, records: rawRecords, exclusions, unresolvedDependencyIds: unresolved, truncated: p.truncated, usage, limits: parsed.limits } as ContextPack;
  if (computeContextPackHash(pack) !== pack.packHash || bytes(JSON.stringify(pack)) !== usage.bytes) fail('Stored context integrity mismatch');
  return detached(pack);
}
/** Parses bounded inert local data. Not an import or authorization endpoint. */
export function parseSummaryStoreState(input: unknown): SummaryStoreState {
  // This entry point accepts inert JSON-compatible data only, never arbitrary JS objects/Proxies.
  input = boundedStoredData(input);
  const s = object(input, ['schemaVersion', 'version', 'currentPackHash', 'packs', 'candidate', 'approved', 'candidateBases', 'approvedBases', 'lastFailure']);
  if (s.schemaVersion !== 1) fail('Unsupported summary state schema');
  const version = boundedNumber(s.version);
  const packs = list(s.packs, 97).map(storedPack);
  const packMap = new Map(packs.map(p => [p.packHash, p]));
  const currentPackHash = hash(s.currentPackHash);
  const current = packMap.get(currentPackHash);
  if (!current || packMap.size !== packs.length || packs.some(p => p.scopeId !== current.scopeId)) fail('Invalid stored pack set');
  const bases = (input: unknown) => list(input, 48).map(x => { const b = object(x, ['claimId', 'packHash']); return { claimId: id(b.claimId), packHash: hash(b.packHash) }; });
  const candidateBases = bases(s.candidateBases); const approvedBases = bases(s.approvedBases);
  function candidate(input: unknown, evidence: typeof candidateBases): SummaryCandidate | null {
    if (input === null) { if (evidence.length) fail('Unexpected stored claim basis'); return null; }
    const c = object(input, ['schemaVersion', 'scopeId', 'schemaHash', 'packHash', 'generatedAt', 'claims', 'status', 'candidateHash']);
    if (c.schemaVersion !== 1 || c.status !== 'candidate' || c.scopeId !== current!.scopeId || c.schemaHash !== SUMMARY_RESPONSE_SCHEMA_HASH || !packMap.has(hash(c.packHash))) fail('Stored candidate binding mismatch');
    const claims = list(c.claims, 48);
    if (claims.length !== evidence.length || new Set(evidence.map(b => b.claimId)).size !== evidence.length) fail('Invalid stored claim bases');
    const generatedAt = time(c.generatedAt);
    const validated = claims.map(raw => {
      const claimId = id(object(raw, ['claimId', 'aspect', 'kind', 'text', 'intent', 'citations', 'assertions']).claimId);
      const basis = packMap.get(evidence.find(b => b.claimId === claimId)?.packHash ?? '');
      if (!basis) fail('Missing stored claim basis');
      return parseSummaryResponse({ schemaVersion: 1, ...bindSummaryContext(basis), generatedAt, claims: [raw] }, basis).claims[0];
    });
    if (new Set(validated.map(c => c.claimId)).size !== validated.length || ASPECTS.some(a => !validated.some(c => c.aspect === a))) fail('Incomplete stored summary');
    const response: SummaryResponse = { schemaVersion: 1, scopeId: current!.scopeId, schemaHash: SUMMARY_RESPONSE_SCHEMA_HASH, packHash: c.packHash as string, generatedAt, claims: validated };
    if (bytes(JSON.stringify(response)) > MAX_RESPONSE_BYTES || digest(JSON.stringify(response)) !== hash(c.candidateHash)) fail('Stored candidate integrity mismatch');
    return { ...response, status: 'candidate', candidateHash: c.candidateHash as string };
  }
  const parsedCandidate = candidate(s.candidate, candidateBases);
  let approved: ApprovedSummary | null = null;
  if (s.approved !== null) {
    const a = object(s.approved, ['status', 'approvalId', 'approvedAt', 'summary']);
    if (a.status !== 'approved') fail('Invalid historical approval');
    const summary = candidate(a.summary, approvedBases);
    if (!summary) fail('Missing approved summary');
    const approvedAt = time(a.approvedAt);
    if (approvedAt < summary.generatedAt) fail('Stored approval predates generation');
    approved = { status: 'approved', approvalId: id(a.approvalId), approvedAt, summary };
  } else if (approvedBases.length) fail('Unexpected approved basis');
  const lastFailure = s.lastFailure === null ? null : text(s.lastFailure, 500);
  const result: SummaryStoreState = { schemaVersion: 1, version, currentPackHash, packs, candidate: parsedCandidate, approved, candidateBases, approvedBases, lastFailure };
  if (bytes(JSON.stringify(result)) > MAX_SUMMARY_STATE_BYTES) fail('Stored summary exceeds byte budget');
  return detached(result);
}
export function restoreSummaryStoreFromLocalCache(input: unknown, currentPack: ContextPack) {
  const state = parseSummaryStoreState(input);
  const store = createSummaryStore(state.packs.find(p => p.packHash === state.currentPackHash)!, state);
  store.updateContext(currentPack);
  return store;
}

function boundedStoredData(input: unknown): unknown {
  let nodes = 0; let stringBytes = 0;
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 32) fail('Stored data exceeds structural budget');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { if (value.length > MAX_SUMMARY_STATE_BYTES - stringBytes) fail('Stored data exceeds byte budget'); stringBytes += bytes(value); if (stringBytes > MAX_SUMMARY_STATE_BYTES) fail('Stored data exceeds byte budget'); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return list(value, 100000).map(x => copy(x, depth + 1));
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const keys = Reflect.ownKeys(value);
      if (keys.length > 100) fail('Oversized stored object');
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== 'string') fail('Invalid stored key');
        if (key.length > MAX_SUMMARY_STATE_BYTES - stringBytes) fail('Stored key exceeds byte budget');
        stringBytes += bytes(key); if (stringBytes > MAX_SUMMARY_STATE_BYTES) fail('Stored key exceeds byte budget');
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !('value' in property)) fail('Stored accessors are forbidden');
        result[key] = copy(property.value, depth + 1);
      }
      return result;
    }
    fail('Stored data is not inert JSON');
  }
  const result = copy(input, 0);
  if (bytes(JSON.stringify(result)) > MAX_SUMMARY_STATE_BYTES) fail('Stored data exceeds byte budget');
  return result;
}
