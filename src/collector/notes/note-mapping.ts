import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AllowedNoteScope, CanonicalDagMapping, MappingProblem, MappingReason, MappingStage,
  NoteMapping, NoteMappingRequest, NoteMappingResult, NoteWorktree, SafeFsErrorCode,
} from './types';

export const NOTE_MAPPING_LIMITS = Object.freeze({
  worktrees: 1_000,
  scopes: 64,
  dagsPerScope: 32,
  pathCharacters: 4_096,
  idCharacters: 256,
  // Orca worktree IDs may embed repo::absolute/path and are not short display IDs.
  worktreeIdCharacters: 4_096,
  filesystemOperations: 20_000,
  defaultTimeoutMs: 5_000,
  maximumTimeoutMs: 30_000,
});

const safeCodes = new Set<SafeFsErrorCode>([
  'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EIO', 'EMFILE', 'ENFILE',
]);

class MappingFailure extends Error {
  constructor(readonly problem: MappingProblem) {
    super(problem.reason);
  }
}

function fail(reason: MappingReason, stage: MappingStage, errorCode?: SafeFsErrorCode): never {
  throw new MappingFailure({ reason, stage, ...(errorCode ? { errorCode } : {}) });
}

function safeCode(error: unknown): SafeFsErrorCode {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && safeCodes.has(code as SafeFsErrorCode) ? code as SafeFsErrorCode : 'UNKNOWN';
}

function validString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validAbsolute(value: unknown): value is string {
  return validString(value, NOTE_MAPPING_LIMITS.pathCharacters) && path.isAbsolute(value);
}

function validRelative(value: unknown): value is string {
  return validString(value, NOTE_MAPPING_LIMITS.pathCharacters) && !path.isAbsolute(value)
    && !value.includes('\\') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function within(root: string, candidate: string, strict = false): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ? !strict : relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function inputError(request: NoteMappingRequest): NoteMappingResult['inputError'] {
  if (!request || typeof request !== 'object' || !validString(request.localHostId, NOTE_MAPPING_LIMITS.idCharacters)
    || !Array.isArray(request.worktrees) || !Array.isArray(request.scopes)
    || (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1
      || request.timeoutMs > NOTE_MAPPING_LIMITS.maximumTimeoutMs))
    || (request.requireNoteSymlink !== undefined && typeof request.requireNoteSymlink !== 'boolean')
    || (request.signal !== undefined && !(request.signal instanceof AbortSignal))) return 'invalid-input';
  if (request.worktrees.length > NOTE_MAPPING_LIMITS.worktrees || request.scopes.length > NOTE_MAPPING_LIMITS.scopes) return 'input-limit';
  const worktreeIds = new Set<string>();
  const scopeIds = new Set<string>();
  for (const row of request.worktrees) {
    if (!row || typeof row !== 'object' || !validString(row.worktreeId, NOTE_MAPPING_LIMITS.worktreeIdCharacters)
      || !validString(row.hostId, NOTE_MAPPING_LIMITS.idCharacters)
      || !(row.hostId === request.localHostId ? validAbsolute(row.worktreePath) : validString(row.worktreePath, NOTE_MAPPING_LIMITS.pathCharacters))
      || (row.selectedDagRelativePath !== undefined && !validRelative(row.selectedDagRelativePath))) return 'invalid-input';
    if(row.selectedScopeId!==undefined && (!validString(row.selectedScopeId,NOTE_MAPPING_LIMITS.idCharacters)||!row.selectedDagRelativePath))return 'invalid-input';
    if(row.registeredScopeId!==undefined && (!validString(row.registeredScopeId,NOTE_MAPPING_LIMITS.idCharacters)||!row.selectedDagRelativePath))return 'invalid-input';
    const key = JSON.stringify([row.hostId, row.worktreeId]);
    if (worktreeIds.has(key)) return 'duplicate-identity';
    worktreeIds.add(key);
  }
  for (const scope of request.scopes) {
    if (!scope || typeof scope !== 'object' || !validString(scope.scopeId, NOTE_MAPPING_LIMITS.idCharacters)
      || !validString(scope.hostId, NOTE_MAPPING_LIMITS.idCharacters) || !validAbsolute(scope.vaultRootPath)
      || !validAbsolute(scope.scopePath) || !Array.isArray(scope.dagRelativePaths)) return 'invalid-input';
    // Bound length before copying or iterating, including sparse arrays with getters.
    if (scope.dagRelativePaths.length > NOTE_MAPPING_LIMITS.dagsPerScope) return 'input-limit';
    for (const entry of scope.dagRelativePaths) if (!validRelative(entry)) return 'invalid-input';
    const key = JSON.stringify([scope.hostId, scope.scopeId]);
    if (scopeIds.has(key)) return 'duplicate-identity';
    scopeIds.add(key);
  }
  return undefined;
}

/** At most one async filesystem operation is in flight; cancellation schedules no more. */
class BoundedReads {
  operations = 0;
  private readonly deadline: number;
  private stopped: 'aborted' | 'timeout' | 'operation-limit' | undefined;
  constructor(private readonly signal: AbortSignal | undefined, timeoutMs: number) {
    this.deadline = performance.now() + timeoutMs;
  }
  check(stage: MappingStage): void {
    if (this.stopped) fail(this.stopped, stage);
    if (this.signal?.aborted) fail('aborted', stage);
    if (performance.now() >= this.deadline) fail('timeout', stage);
    if (this.operations >= NOTE_MAPPING_LIMITS.filesystemOperations) fail('operation-limit', stage);
  }
  async run<T>(stage: MappingStage, operation: () => Promise<T>): Promise<T> {
    this.check(stage);
    this.operations += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.stopped = 'timeout';
            reject(new MappingFailure({ reason: 'timeout', stage }));
          }, Math.max(1, Math.ceil(this.deadline - performance.now())));
          if (this.signal) {
            abort = () => {
              this.stopped = 'aborted';
              reject(new MappingFailure({ reason: 'aborted', stage }));
            };
            this.signal.addEventListener('abort', abort, { once: true });
            if (this.signal.aborted) abort();
          }
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) this.signal?.removeEventListener('abort', abort);
    }
  }
}

interface ResolvedScope {
  source: AllowedNoteScope;
  vaultRoot: string;
  scopeRoot: string;
}

async function safely<T>(reason: MappingReason, stage: MappingStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof MappingFailure) throw error;
    fail(reason, stage, safeCode(error));
  }
}

async function canonicalDirectory(
  reads: BoundedReads, original: string, stage: MappingStage, unavailable: MappingReason,
  notDirectory: MappingReason, checkCanonical?: (canonical: string) => void,
): Promise<string> {
  return safely(unavailable, stage, async () => {
    await reads.run(stage, () => fs.lstat(original));
    const canonical = await reads.run(stage, () => fs.realpath(original));
    checkCanonical?.(canonical);
    const stat = await reads.run(stage, () => fs.lstat(canonical));
    if (!stat.isDirectory()) fail(notDirectory, stage);
    await reads.run(stage, () => fs.access(canonical, constants.R_OK | constants.X_OK));
    if (await reads.run(stage, () => fs.realpath(original)) !== canonical) fail('path-changed', stage);
    return canonical;
  });
}

async function resolveScope(reads: BoundedReads, scope: AllowedNoteScope): Promise<ResolvedScope> {
  const lexicalVault = path.resolve(scope.vaultRootPath);
  const lexicalScope = path.resolve(scope.scopePath);
  if (lexicalVault === lexicalScope) fail('scope-is-vault-root', 'scope');
  if (!within(lexicalVault, lexicalScope, true)) fail('scope-outside-vault', 'scope');
  const vaultRoot = await canonicalDirectory(reads, lexicalVault, 'vault', 'vault-unavailable', 'vault-not-directory');
  const scopeRoot = await canonicalDirectory(reads, lexicalScope, 'scope', 'scope-unavailable', 'scope-not-directory', (canonical) => {
    if (canonical === vaultRoot) fail('scope-is-vault-root', 'scope');
    if (!within(vaultRoot, canonical, true)) fail('scope-outside-vault', 'scope');
  });
  return { source: scope, vaultRoot, scopeRoot };
}

async function resolveNote(reads: BoundedReads, worktreePath: string, scopes: ResolvedScope[],requireSymlink=false): Promise<{ notePath: string; docsPath: string; scope: ResolvedScope }> {
  const docsPath = await canonicalDirectory(reads, path.join(worktreePath, 'docs'), 'docs', 'docs-unavailable', 'docs-not-directory', (canonical) => {
    if (!within(worktreePath, canonical, true)) fail('docs-outside-worktree', 'docs');
  });
  const requestedNote = path.join(docsPath, 'note');
  let linkStat: Stats;
  try { linkStat = await reads.run('note', () => fs.lstat(requestedNote)); } catch (error) {
    if (error instanceof MappingFailure) throw error;
    const code = safeCode(error);
    fail(code === 'ENOENT' ? 'note-missing' : 'note-unavailable', 'note', code);
  }
  if(requireSymlink&&!linkStat.isSymbolicLink())fail('note-not-symlink','note');
  let notePath: string;
  try { notePath = await reads.run('note', () => fs.realpath(requestedNote)); } catch (error) {
    if (error instanceof MappingFailure) throw error;
    const code = safeCode(error);
    fail(linkStat.isSymbolicLink() && (code === 'ENOENT' || code === 'ENOTDIR') ? 'note-broken-link' : 'note-unavailable', 'note', code);
  }
  if (scopes.some((scope) => notePath === scope.vaultRoot)) fail('vault-root-note', 'note');
  const matchingScopes = scopes.filter((scope) => within(scope.scopeRoot, notePath));
  if (matchingScopes.length === 0) fail('note-outside-scope', 'note');
  if (matchingScopes.length > 1) fail('ambiguous-scope', 'note');
  await safely('note-unavailable', 'note', async () => {
    const stat = await reads.run('note', () => fs.lstat(notePath));
    if (!stat.isDirectory()) fail('note-not-directory', 'note');
    await reads.run('note', () => fs.access(notePath, constants.R_OK | constants.X_OK));
    if (await reads.run('note', () => fs.realpath(requestedNote)) !== notePath) fail('path-changed', 'note');
  });
  return { notePath, docsPath, scope: matchingScopes[0]! };
}

async function resolveDag(reads: BoundedReads, scope: ResolvedScope, notePath: string, selected?: string): Promise<string> {
  const registered = [...new Set(scope.source.dagRelativePaths)];
  if (selected !== undefined && !registered.includes(selected)) fail('invalid-dag-selection', 'dag');
  const candidates = selected === undefined ? registered : [selected];
  const eligible = candidates.filter((entry) => within(notePath, path.join(scope.scopeRoot, entry), true));
  if (eligible.length === 0) fail(selected === undefined ? 'dag-not-registered' : 'dag-outside-note', 'dag');
  const canonicalDags = new Set<string>();
  for (const relative of eligible) {
    const original = path.join(scope.scopeRoot, relative);
    await safely('dag-unavailable', 'dag', async () => {
      // Walk only the components of this explicit registration. Check an intermediate
      // symlink before attempting metadata operations beneath it, never enumerate it.
      let canonical = notePath;
      const components = path.relative(notePath, original).split(path.sep);
      for (const [index, component] of components.entries()) {
        const next = path.join(canonical, component);
        await reads.run('dag', () => fs.lstat(next));
        canonical = await reads.run('dag', () => fs.realpath(next));
        if (!within(scope.scopeRoot, canonical, true)) fail('dag-outside-scope', 'dag');
        if (!within(notePath, canonical, true)) fail('dag-outside-note', 'dag');
        if (index < components.length - 1) {
          const intermediate = await reads.run('dag', () => fs.lstat(canonical));
          if (!intermediate.isDirectory()) fail('dag-unavailable', 'dag', 'ENOTDIR');
        }
      }
      const stat = await reads.run('dag', () => fs.lstat(canonical));
      if (!stat.isFile()) fail('dag-not-file', 'dag');
      await reads.run('dag', () => fs.access(canonical, constants.R_OK));
      if (await reads.run('dag', () => fs.realpath(original)) !== canonical) fail('path-changed', 'dag');
      canonicalDags.add(canonical);
    });
  }
  if (canonicalDags.size !== 1) fail('ambiguous-dag', 'dag');
  return [...canonicalDags][0]!;
}

function problemFrom(error: unknown, stage: MappingStage): MappingProblem {
  return error instanceof MappingFailure ? error.problem : { reason: 'note-unavailable', stage, errorCode: safeCode(error) };
}

async function mapWorktree(reads: BoundedReads, worktree: NoteWorktree, localHostId: string, scopes: ResolvedScope[],requireSymlink=false): Promise<NoteMapping> {
  const identity = { worktreeId: worktree.worktreeId, hostId: worktree.hostId };
  try {
    if (worktree.hostId !== localHostId) fail('remote-host', 'host');
    reads.check('worktree');
    if (scopes.length === 0) fail('no-allowed-scope', 'scope');
    const canonicalWorktreePath = await canonicalDirectory(reads, worktree.worktreePath, 'worktree', 'worktree-unavailable', 'worktree-not-directory');
    let notePath:string,docsPath:string|null,scope:ResolvedScope;
    if(worktree.registeredScopeId!==undefined) {
      const registered=scopes.filter(s=>s.source.scopeId===worktree.registeredScopeId);
      if(registered.length!==1)fail('no-allowed-scope','scope');
      scope=registered[0];notePath=scope.scopeRoot;docsPath=null;
    } else {({notePath,docsPath,scope}=await resolveNote(reads,canonicalWorktreePath,worktree.selectedScopeId?scopes.filter(s=>s.source.scopeId===worktree.selectedScopeId):scopes,requireSymlink));}
    const canonicalDagPath = await resolveDag(reads, scope, notePath, worktree.selectedDagRelativePath);
    // This is still an observation, not an atomic filesystem capability. Detect
    // replacements of the authority/link chain while resolving registered DAGs.
    for (const [original, expected, stage] of [
      [worktree.worktreePath, canonicalWorktreePath, 'worktree'],
      [scope.source.vaultRootPath, scope.vaultRoot, 'vault'],
      [scope.source.scopePath, scope.scopeRoot, 'scope'],
      ...(docsPath?[[path.join(canonicalWorktreePath,'docs'),docsPath,'docs'],[path.join(docsPath,'note'),notePath,'note']] as const:[]),
    ] as const) {
      await safely('path-changed', stage, async () => {
        if (await reads.run(stage, () => fs.realpath(original)) !== expected) fail('path-changed', stage);
      });
    }
    const dagId = `dag:${createHash('sha256').update(JSON.stringify(['note-dag-v1', localHostId, canonicalDagPath])).digest('hex')}`;
    return { state: 'resolved', ...identity, scopeId: scope.source.scopeId, canonicalWorktreePath, canonicalNotePath: notePath, canonicalDagPath, dagId,...(worktree.registeredScopeId?{registration:'explicit-read-only' as const}:{}) };
  } catch (error) {
    return { state: 'unresolved', ...identity, ...problemFrom(error, 'note') };
  }
}

/** Bounded, read-only observation. This does not parse DAG bytes, authorize future reads, or change links. */
export async function mapWorktreesToNotes(request: NoteMappingRequest): Promise<NoteMappingResult> {
  const invalid = inputError(request);
  if (invalid) return { status: 'invalid-request', mappings: [], dags: [], scopeIssues: [], inputError: invalid, filesystemOperations: 0 };
  // Copy configuration before the first await; a caller cannot change scope/host authority mid-observation.
  const localHostId = request.localHostId;
  const worktrees = request.worktrees.map((row) => ({ ...row }));
  const scopes = request.scopes.map((scope) => ({ ...scope, dagRelativePaths: [...scope.dagRelativePaths] }));
  const reads = new BoundedReads(request.signal, request.timeoutMs ?? NOTE_MAPPING_LIMITS.defaultTimeoutMs);
  const resolvedScopes: ResolvedScope[] = [];
  const scopeIssues: NoteMappingResult['scopeIssues'] = [];
  // With no local worktree, do not touch even local configured paths.
  if (worktrees.some((row) => row.hostId === localHostId)) {
    for (const scope of scopes.filter((entry) => entry.hostId === localHostId)) {
      try { resolvedScopes.push(await resolveScope(reads, scope)); } catch (error) {
        scopeIssues.push({ scopeId: scope.scopeId, hostId: scope.hostId, ...problemFrom(error, 'scope') });
      }
    }
  }
  const mappings: NoteMapping[] = [];
  const dagMap = new Map<string, CanonicalDagMapping>();
  for (const worktree of worktrees) {
    const mapping = await mapWorktree(reads, worktree, localHostId, resolvedScopes,request.requireNoteSymlink===true);
    mappings.push(mapping);
    if (mapping.state === 'resolved') {
      let dag = dagMap.get(mapping.dagId);
      if (!dag) {
        dag = { dagId: mapping.dagId, hostId: mapping.hostId, canonicalDagPath: mapping.canonicalDagPath, worktreeIds: [] };
        dagMap.set(mapping.dagId, dag);
      }
      dag.worktreeIds.push(mapping.worktreeId);
    }
  }
  const dags = [...dagMap.values()].sort((a, b) => a.dagId.localeCompare(b.dagId));
  for (const dag of dags) dag.worktreeIds.sort();
  return {
    status: scopeIssues.length || mappings.some((row) => row.state === 'unresolved') ? 'partial' : 'complete',
    mappings, dags, scopeIssues, filesystemOperations: reads.operations,
  };
}
