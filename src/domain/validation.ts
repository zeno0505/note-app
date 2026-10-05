import type { WorkspaceSnapshot } from './types';

export class FixtureValidationError extends Error {
  constructor(public readonly location: string, message: string) {
    super(`${location}: ${message}`);
    this.name = 'FixtureValidationError';
  }
}

type RecordValue = Record<string, unknown>;
const fail = (path: string, message: string): never => {
  throw new FixtureValidationError(path, message);
};

function object(value: unknown, path: string, keys: string[]): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(path, 'expected an object');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'expected plain JSON');
  const record = value as RecordValue;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, 'unsupported field');
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, 'required field is missing');
  }
  return record;
}

function text(value: unknown, path: string, max = 800): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    return fail(path, `expected nonempty text of at most ${max} characters`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  const result = text(value, path, 80);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(result)) fail(path, 'expected a synthetic identifier');
  return result;
}

function choice(value: unknown, path: string, allowed: readonly unknown[]): void {
  if (!allowed.includes(value)) fail(path, `expected one of ${allowed.join(', ')}`);
}

function bool(value: unknown, path: string): void {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
}

function count(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, 'expected a nonnegative safe integer');
  }
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
    !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    fail(path, 'expected a valid canonical UTC ISO timestamp');
  }
  return result;
}

function hash(value: unknown, path: string): string {
  const result = text(value, path, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) fail(path, 'expected a SHA-256 content hash');
  return result;
}

function array(value: unknown, path: string, max = 1000): unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail(path, `expected an array of at most ${max} entries`);
  return value;
}

function unique(value: string, known: Set<string>, path: string): void {
  if (known.has(value)) fail(path, 'duplicate identifier or canonical DAG');
  known.add(value);
}

function syntheticPath(value: unknown, path: string): string {
  const result = text(value, path, 300);
  if (!/^\/synthetic\/[a-z0-9/._-]+$/.test(result) || result.split('/').includes('..')) {
    fail(path, 'only explicit synthetic paths are accepted');
  }
  return result;
}

/** Fail closed on extra fields, invalid references, partial-zero and stale errors. */
export function parseFixtureSnapshot(input: unknown): WorkspaceSnapshot {
  const root = object(input, '$', ['schemaVersion', 'mode', 'observedAt', 'freshness', 'lastAttempt', 'coverage', 'workstreams']);
  choice(root.schemaVersion, '$.schemaVersion', [1]);
  choice(root.mode, '$.mode', ['synthetic-fixture']);
  const observedAt = timestamp(root.observedAt, '$.observedAt');
  choice(root.freshness, '$.freshness', ['current', 'stale']);
  const attempt = object(root.lastAttempt, '$.lastAttempt', ['observedAt', 'outcome', 'reason']);
  const attemptedAt = timestamp(attempt.observedAt, '$.lastAttempt.observedAt');
  if (attemptedAt < observedAt) fail('$.lastAttempt.observedAt', 'cannot predate the last usable observation');
  choice(attempt.outcome, '$.lastAttempt.outcome', ['success', 'error']);
  if (attempt.outcome === 'error') {
    text(attempt.reason, '$.lastAttempt.reason');
    if (root.freshness !== 'stale') fail('$.freshness', 'failed refresh must keep a stale snapshot');
  } else if (attempt.reason !== null) fail('$.lastAttempt.reason', 'successful attempt has no error reason');
  const coverage = object(root.coverage, '$.coverage', ['complete', 'truncated', 'totalCount', 'omittedHostIds']);
  bool(coverage.complete, '$.coverage.complete');
  bool(coverage.truncated, '$.coverage.truncated');
  if (coverage.totalCount !== null) count(coverage.totalCount, '$.coverage.totalCount');
  const hosts = array(coverage.omittedHostIds, '$.coverage.omittedHostIds', 100);
  const hostIds = new Set<string>();
  hosts.forEach((host, index) => unique(id(host, `$.coverage.omittedHostIds[${index}]`), hostIds, '$.coverage.omittedHostIds'));
  if (coverage.complete && (coverage.truncated || hosts.length)) fail('$.coverage', 'incomplete coverage cannot be labeled complete');

  const workstreams = array(root.workstreams, '$.workstreams');
  if (!workstreams.length && (!coverage.complete || coverage.totalCount !== 0)) {
    fail('$.workstreams', 'empty data requires a complete known zero observation');
  }
  if (!workstreams.length && attempt.outcome === 'error' && attemptedAt === observedAt) {
    fail('$.workstreams', 'a failed first observation cannot create a zero result');
  }
  const streamIds = new Set<string>();
  const dagPaths = new Set<string>();
  const worktreeIds = new Set<string>();
  for (const [index, value] of workstreams.entries()) {
    const path = `$.workstreams[${index}]`;
    const stream = object(value, path, ['id', 'title', 'goal', 'summary', 'canonicalDagPath', 'dagState', 'worktrees', 'noteMapping', 'sources']);
    unique(id(stream.id, `${path}.id`), streamIds, `${path}.id`);
    text(stream.title, `${path}.title`, 100);
    if (stream.canonicalDagPath !== null) unique(syntheticPath(stream.canonicalDagPath, `${path}.canonicalDagPath`), dagPaths, `${path}.canonicalDagPath`);
    choice(stream.dagState, `${path}.dagState`, ['pending', 'running', 'done', 'unknown']);
    if (stream.canonicalDagPath === null && stream.dagState !== 'unknown') fail(`${path}.dagState`, 'no DAG mapping means unknown DAG state');
    const mapping = object(stream.noteMapping, `${path}.noteMapping`, ['status', 'notePath', 'reason']);
    choice(mapping.status, `${path}.noteMapping.status`, ['mapped', 'missing', 'ambiguous']);
    if (mapping.status === 'mapped') {
      syntheticPath(mapping.notePath, `${path}.noteMapping.notePath`);
      if (mapping.reason !== null) fail(`${path}.noteMapping.reason`, 'mapped note has no failure reason');
    } else {
      if (mapping.notePath !== null) fail(`${path}.noteMapping.notePath`, 'unresolved note mapping has no selected path');
      text(mapping.reason, `${path}.noteMapping.reason`);
    }

    const sources = new Map<string, { hash: string; observedAt: string; kind: unknown }>();
    array(stream.sources, `${path}.sources`, 100).forEach((value, sourceIndex) => {
      const sourcePath = `${path}.sources[${sourceIndex}]`;
      const source = object(value, sourcePath, ['id', 'kind', 'locator', 'hash', 'observedAt']);
      const sourceId = id(source.id, `${sourcePath}.id`);
      if (sources.has(sourceId)) fail(`${sourcePath}.id`, 'duplicate source identifier');
      choice(source.kind, `${sourcePath}.kind`, ['dag-fixture', 'orca-fixture', 'manual-fixture']);
      const locator = text(source.locator, `${sourcePath}.locator`, 200);
      if (!/^fixtures\/sources\/[a-z0-9-]+\.json$/.test(locator)) fail(`${sourcePath}.locator`, 'expected a bounded synthetic fixture source');
      const sourceObservedAt = timestamp(source.observedAt, `${sourcePath}.observedAt`);
      if (sourceObservedAt > observedAt) fail(`${sourcePath}.observedAt`, 'source cannot postdate its snapshot');
      sources.set(sourceId, { hash: hash(source.hash, `${sourcePath}.hash`), observedAt: sourceObservedAt, kind: source.kind });
    });

    const claimIds = new Set<string>();
    function claim(value: unknown, claimPath: string): void {
      const claim = object(value, claimPath, ['id', 'text', 'kind', 'sources', 'observedAt', 'reviewedAt', 'freshness', 'approval', 'evidence']);
      unique(id(claim.id, `${claimPath}.id`), claimIds, `${claimPath}.id`);
      text(claim.text, `${claimPath}.text`);
      choice(claim.kind, `${claimPath}.kind`, ['fact', 'inference', 'unknown']);
      choice(claim.freshness, `${claimPath}.freshness`, ['current', 'stale']);
      choice(claim.approval, `${claimPath}.approval`, ['not-requested', 'approved', 'rejected']);
      choice(claim.evidence, `${claimPath}.evidence`, ['source-declaration', 'manual-description', 'none']);
      const claimAt = timestamp(claim.observedAt, `${claimPath}.observedAt`);
      if (claimAt > observedAt) fail(`${claimPath}.observedAt`, 'claim cannot postdate its snapshot');
      if (claim.reviewedAt !== null && timestamp(claim.reviewedAt, `${claimPath}.reviewedAt`) < claimAt) fail(`${claimPath}.reviewedAt`, 'review cannot predate its observation');
      if (claim.approval !== 'not-requested' && claim.reviewedAt === null) fail(`${claimPath}.approval`, 'approval requires an explicit review time');
      if (root.freshness === 'stale' && claim.freshness !== 'stale') fail(`${claimPath}.freshness`, 'a stale observation cannot contain current claims');
      const references = array(claim.sources, `${claimPath}.sources`, 100);
      const referenceIds = new Set<string>();
      for (const [refIndex, value] of references.entries()) {
        const refPath = `${claimPath}.sources[${refIndex}]`;
        const ref = object(value, refPath, ['sourceId', 'sourceHash']);
        const sourceId = id(ref.sourceId, `${refPath}.sourceId`);
        unique(sourceId, referenceIds, `${refPath}.sourceId`);
        const source = sources.get(sourceId);
        if (!source) throw new FixtureValidationError(`${refPath}.sourceId`, 'source reference does not resolve within its workstream');
        if (hash(ref.sourceHash, `${refPath}.sourceHash`) !== source.hash) fail(`${refPath}.sourceHash`, 'source changed; claim must be invalidated');
        if (source.observedAt > claimAt) fail(`${refPath}.sourceId`, 'claim predates its source observation');
      }
      if (claim.kind !== 'unknown' && !references.length) fail(`${claimPath}.sources`, 'a fact or inference requires source provenance');
      if (claim.evidence === 'none' && claim.kind !== 'unknown') fail(`${claimPath}.evidence`, 'unsupported claims must be unknown');
      if (claim.kind === 'unknown' && claim.evidence !== 'none') fail(`${claimPath}.evidence`, 'unknown is not evidence');
    }
    claim(stream.goal, `${path}.goal`);
    const summary = object(stream.summary, `${path}.summary`, ['implemented', 'remaining', 'current', 'next', 'blockers']);
    for (const key of ['implemented', 'remaining', 'current', 'next', 'blockers']) {
      const entries = array(summary[key], `${path}.summary.${key}`, 30);
      if (!entries.length) fail(`${path}.summary.${key}`, 'use an explicit unknown or none-observed claim instead of an empty answer');
      entries.forEach((value, claimIndex) => claim(value, `${path}.summary.${key}[${claimIndex}]`));
    }
    const trees = array(stream.worktrees, `${path}.worktrees`, 1000);
    if (!trees.length) fail(`${path}.worktrees`, 'fixture workstream requires at least one discovered worktree');
    trees.forEach((value, treeIndex) => {
      const treePath = `${path}.worktrees[${treeIndex}]`;
      const tree = object(value, treePath, ['id', 'title', 'repositoryId', 'isArchived', 'isSelected', 'terminalConnected', 'terminalCount', 'agentState', 'agentObservedAt', 'lastOutputAt']);
      unique(id(tree.id, `${treePath}.id`), worktreeIds, `${treePath}.id`);
      text(tree.title, `${treePath}.title`, 100);
      id(tree.repositoryId, `${treePath}.repositoryId`);
      bool(tree.isArchived, `${treePath}.isArchived`);
      bool(tree.isSelected, `${treePath}.isSelected`);
      if (tree.terminalConnected !== null) bool(tree.terminalConnected, `${treePath}.terminalConnected`);
      if (tree.terminalCount !== null) count(tree.terminalCount, `${treePath}.terminalCount`);
      if (tree.terminalCount !== null && tree.terminalConnected !== (Number(tree.terminalCount) > 0)) fail(`${treePath}.terminalConnected`, 'terminal count and connection contradict each other');
      choice(tree.agentState, `${treePath}.agentState`, ['working', 'done', 'idle', 'unknown']);
      if (tree.agentObservedAt !== null && timestamp(tree.agentObservedAt, `${treePath}.agentObservedAt`) > observedAt) fail(`${treePath}.agentObservedAt`, 'agent observation cannot postdate snapshot');
      if (tree.agentState !== 'unknown' && tree.agentObservedAt === null) fail(`${treePath}.agentObservedAt`, 'known agent state requires an observation time');
      if (tree.lastOutputAt !== null && timestamp(tree.lastOutputAt, `${treePath}.lastOutputAt`) > observedAt) fail(`${treePath}.lastOutputAt`, 'output cannot postdate snapshot');
    });
  }
  if (coverage.totalCount !== null) {
    if (Number(coverage.totalCount) < worktreeIds.size) fail('$.coverage.totalCount', 'total count cannot be less than observed worktrees');
    if (coverage.complete && coverage.totalCount !== worktreeIds.size) fail('$.coverage.totalCount', 'complete total count must equal observed worktrees');
  } else if (coverage.complete) fail('$.coverage.totalCount', 'complete coverage requires a known count');
  // Return a detached JSON object; callers cannot mutate shared imported fixtures.
  return JSON.parse(JSON.stringify(input)) as WorkspaceSnapshot;
}
