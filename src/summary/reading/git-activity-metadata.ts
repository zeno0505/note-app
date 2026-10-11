import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Budget, closeBounded } from '../../collector/notes/link-workflow/safe-io';

export const GIT_ACTIVITY_METADATA_CONTRACT = 'git-activity-metadata-v1' as const;
export const GIT_ACTIVITY_RESOLVER_CONTRACT = 'exact-declared-commit-v1' as const;
const CONTRACT = GIT_ACTIVITY_METADATA_CONTRACT;
const TIMEOUT = 5_000;
const OUTPUT_LIMIT = 65_536;
const CONFIG_LIMIT = 65_536;
const POINTER_LIMIT = 16_384;
const PACKED_REFS_LIMIT = 1_048_576;
const SYMBOLIC_REF_LIMIT = 8;
const PACK_LIMIT = 256;
export const GIT_ACTIVITY_REFERENCE_LIMIT = 128;
/** Cache proof is deliberately unavailable for exceptionally large loose stores. */
export const GIT_ACTIVITY_LOOSE_ENTRY_LIMIT = 16_384;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

export interface GitActivityIdentity { readonly path: string; readonly dev: number; readonly ino: number }
interface GuardedPath extends GitActivityIdentity {
  readonly kind: 'directory' | 'file' | 'missing';
  readonly mode?: number;
  readonly nlink?: number;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly ctimeMs?: number;
  readonly sha256?: string;
}
export interface GitActivityDescriptor {
  readonly contract: typeof CONTRACT;
  readonly kind: 'ordinary' | 'linked';
  readonly worktree: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly identities: {
    readonly worktree: GitActivityIdentity;
    readonly gitDirectory: GitActivityIdentity;
    readonly commonDirectory: GitActivityIdentity;
  };
  readonly pointerHashes: { readonly dotGit?: string; readonly commondir?: string; readonly gitdir?: string };
  /** Local authority bindings only. Never include these paths in a model input. */
  readonly guards: readonly GuardedPath[];
}
export interface GitActivityReference {
  declaredReference: string;
  status: 'resolved' | 'ambiguous' | 'missing' | 'noncommit' | 'unsupported';
  fullSha?: string;
  at?: string;
}

function validPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    path.isAbsolute(value) && path.resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value);
}
function inside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function stamp(file: string, stat: Stats, directoryIdentityOnly = false): GuardedPath {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
    throw Error('Unsafe Git metadata path');
  }
  const identity = { path: file, dev: stat.dev, ino: stat.ino, kind: stat.isDirectory() ? 'directory' as const : 'file' as const, mode: stat.mode };
  return directoryIdentityOnly && stat.isDirectory() ? identity : {
    ...identity, nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  };
}
async function directory(file: string, budget: Budget): Promise<GuardedPath> {
  if (!validPath(file)) throw Error('Git metadata paths must be canonical');
  const stat = await budget.run(() => lstat(file));
  if (!stat.isDirectory() || stat.isSymbolicLink() || await budget.run(() => realpath(file)) !== file) {
    throw Error('Git metadata directories must be canonical without symlinks');
  }
  return stamp(file, stat, true);
}
async function absent(file: string, budget: Budget): Promise<GuardedPath> {
  try { await budget.run(() => lstat(file)); }
  catch (error) { if (missing(error)) return { path: file, kind: 'missing', dev: 0, ino: 0 }; throw error; }
  throw Error('External or unsupported Git storage excluded');
}
async function metadata(file: string, limit: number, budget: Budget): Promise<{ guard: GuardedPath; text: string }> {
  const initial = stamp(file, await budget.run(() => lstat(file)));
  if (initial.kind !== 'file' || initial.size! > limit || await budget.run(() => realpath(file)) !== file) throw Error('Unsafe Git metadata file');
  let abandoned = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await budget.run(async () => {
      const opened = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (abandoned) { await opened.close(); throw Error('Cancelled Git metadata read'); }
      return opened;
    });
    if (!same(initial, stamp(file, await budget.run(() => handle!.stat())))) throw Error('Git metadata changed while opening');
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await budget.run(() => handle!.read(bytes, used, bytes.length - used, used));
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used > limit || !same(initial, stamp(file, await budget.run(() => handle!.stat()))) ||
      !same(initial, stamp(file, await budget.run(() => lstat(file))))) throw Error('Git metadata changed while reading');
    const content = bytes.subarray(0, used);
    const text = content.toString('utf8');
    if (!Buffer.from(text).equals(content) || text.includes('\0')) throw Error('Invalid Git metadata encoding');
    return { guard: { ...initial, sha256: hash(content) }, text };
  } finally {
    abandoned = true;
    if (handle && !await closeBounded(handle, budget)) throw Error('Git metadata cleanup exceeded its deadline');
  }
}
function pointer(text: string, prefix = ''): string {
  if (!text.startsWith(prefix)) throw Error('Invalid Git metadata pointer');
  const value = text.slice(prefix.length).replace(/\r?\n$/, '');
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value !== value.trim() || value.length > 4096) throw Error('Invalid Git metadata pointer');
  return value;
}
function validateConfig(text: string): void {
  // Reject continuations as well as every spelling of external storage/config directives.
  // Normal core/remote/user sections are inert for the fixed object-metadata commands below.
  if (/\\\r?\n/.test(text) || /\[\s*include(?:if)?\b/i.test(text) ||
    /\[\s*extensions\b/i.test(text) || /\b(?:promisor|partialclone|worktreeconfig)\s*=/i.test(text)) {
    throw Error('External Git configuration excluded');
  }
}
function safeRef(ref: string): boolean {
  return ref.startsWith('refs/') && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.') &&
    ref.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}
function safeHead(text: string): boolean {
  const value = text.replace(/\r?\n$/, '');
  return /^[a-fA-F0-9]{40}$/.test(value) || (value.startsWith('ref: ') && safeRef(value.slice(5)));
}

/** Ref paths are mutable safety proofs, never durable authority or activity selection. */
async function mutableHeadState(gitDirectory: string, commonDirectory: string, budget: Budget): Promise<GuardedPath[]> {
  const result: GuardedPath[] = [];
  // Repository setup consults the common refs root even for detached HEAD.
  const refsRoot = path.join(commonDirectory, 'refs');
  await directory(refsRoot, budget);
  result.push(stamp(refsRoot, await budget.run(() => lstat(refsRoot))));
  const head = await metadata(path.join(gitDirectory, 'HEAD'), POINTER_LIMIT, budget);
  if (!safeHead(head.text)) throw Error('Unsupported Git HEAD');
  result.push(head.guard);
  let value = head.text.replace(/\r?\n$/, '');
  const visited = new Set<string>();
  for (let depth = 0; value.startsWith('ref: '); depth++) {
    if (depth >= SYMBOLIC_REF_LIMIT) throw Error('Git symbolic ref depth limit exceeded');
    const ref = value.slice(5);
    if (!safeRef(ref) || visited.has(ref)) throw Error('Unsafe or cyclic Git symbolic ref');
    visited.add(ref);
    // Git keeps these namespaces per worktree; ordinary branches/tags use common refs.
    const root = /^(?:refs\/bisect\/|refs\/worktree\/|refs\/rewritten\/)/.test(ref) ? gitDirectory : commonDirectory;
    const components = ref.split('/');
    let parent = root;
    let absentParent = false;
    for (const component of components.slice(0, -1)) {
      parent = path.join(parent, component);
      try {
        const current = await budget.run(() => lstat(parent));
        if (!current.isDirectory() || current.isSymbolicLink() || await budget.run(() => realpath(parent)) !== parent) throw Error('Unsafe Git ref directory');
        result.push(stamp(parent, current));
      } catch (error) {
        if (!missing(error)) throw error;
        result.push({ path: parent, kind: 'missing', dev: 0, ino: 0 });
        absentParent = true;
        break;
      }
    }
    const file = path.join(root, ref);
    let loose: Awaited<ReturnType<typeof metadata>> | undefined;
    if (!absentParent) {
      try { loose = await metadata(file, POINTER_LIMIT, budget); }
      catch (error) { if (!missing(error)) throw error; }
    }
    if (loose) {
      if (!safeHead(loose.text)) throw Error('Unsupported Git symbolic ref target');
      result.push(loose.guard);
      value = loose.text.replace(/\r?\n$/, '');
      continue;
    }
    result.push({ path: file, kind: 'missing', dev: 0, ino: 0 });
    // A missing loose ref may be unborn or packed. Validate the entire bounded
    // packed-ref syntax so it cannot hide a further filesystem/symbolic pointer.
    for (const packed of [...new Set([path.join(commonDirectory, 'packed-refs'), path.join(gitDirectory, 'packed-refs')])]) {
      let content: Awaited<ReturnType<typeof metadata>>;
      try { content = await metadata(packed, PACKED_REFS_LIMIT, budget); }
      catch (error) { if (missing(error)) { result.push({ path: packed, kind: 'missing', dev: 0, ino: 0 }); continue; } throw error; }
      let entries = 0;
      let previous = false;
      for (const line of content.text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        if (++entries > GIT_ACTIVITY_LOOSE_ENTRY_LIMIT) throw Error('Git packed ref entry limit exceeded');
        if (/^\^[a-fA-F0-9]{40}$/.test(line) && previous) { previous = false; continue; }
        const match = /^([a-fA-F0-9]{40}) (.+)$/.exec(line);
        if (!match || !safeRef(match[2]!)) throw Error('Unsafe Git packed ref entry');
        previous = true;
      }
      result.push(content.guard);
    }
    break;
  }
  return result;
}

/** These mutable acceleration caches are never opened: all commands disable them. */
async function safeOptimizationCaches(commonDirectory: string, budget: Budget): Promise<void> {
  for (const [name, kind] of [['commit-graph', 'file'], ['commit-graphs', 'directory']] as const) {
    const file = path.join(commonDirectory, 'objects', 'info', name);
    let current: Stats;
    try { current = await budget.run(() => lstat(file)); }
    catch (error) { if (missing(error)) continue; throw error; }
    if (current.isSymbolicLink() || (kind === 'file' ? !current.isFile() || current.nlink !== 1 : !current.isDirectory())) throw Error('Unsafe Git optimization cache entry');
    // Do not open, hash, enumerate, or bind these optimization caches into a grant.
  }
}

function identity(guard: GitActivityIdentity): GitActivityIdentity {
  return Object.freeze({ path: guard.path, dev: guard.dev, ino: guard.ino });
}
async function inspect(worktree: string, approvedCommonPaths: readonly string[], budget: Budget): Promise<GitActivityDescriptor> {
  const guards: GuardedPath[] = [];
  const worktreeGuard = await directory(worktree, budget);
  guards.push(worktreeGuard);
  const dotGit = path.join(worktree, '.git');
  const dotStat = await budget.run(() => lstat(dotGit));
  let gitDirectory: string;
  let commonDirectory: string;
  let kind: GitActivityDescriptor['kind'];
  const pointerHashes: { dotGit?: string; commondir?: string; gitdir?: string } = {};
  if (dotStat.isDirectory() && !dotStat.isSymbolicLink()) {
    kind = 'ordinary';
    gitDirectory = commonDirectory = dotGit;
    if (!approvedCommonPaths.includes(commonDirectory)) throw Error('Git metadata requires exact common-directory authority');
    guards.push(await directory(dotGit, budget));
    guards.push(await absent(path.join(dotGit, 'commondir'), budget));
  } else if (dotStat.isFile() && !dotStat.isSymbolicLink()) {
    kind = 'linked';
    const dot = await metadata(dotGit, POINTER_LIMIT, budget);
    guards.push(dot.guard);
    pointerHashes.dotGit = dot.guard.sha256;
    const lexicalGit = path.resolve(worktree, pointer(dot.text, 'gitdir: '));
    // Do not stat/realpath/traverse a pointer until its lexical target is in a grant.
    const approved = [...new Set(approvedCommonPaths)].filter(root => validPath(root) && inside(root, lexicalGit));
    if (!approved.length) throw Error('Linked Git metadata requires explicit common-directory authority');
    for (const root of approved) await directory(root, budget);
    gitDirectory = lexicalGit;
    const gitGuard = await directory(gitDirectory, budget);
    guards.push(gitGuard);
    const common = await metadata(path.join(gitDirectory, 'commondir'), POINTER_LIMIT, budget);
    guards.push(common.guard);
    pointerHashes.commondir = common.guard.sha256;
    commonDirectory = path.resolve(gitDirectory, pointer(common.text));
    if (!approved.includes(commonDirectory)) throw Error('Git common directory is not an exact approved authority');
    // Ordinary linked worktree registrations reside directly under common/worktrees.
    if (path.dirname(gitDirectory) !== path.join(commonDirectory, 'worktrees')) throw Error('Unsupported linked Git registration');
    guards.push(await directory(path.dirname(gitDirectory), budget));
    const back = await metadata(path.join(gitDirectory, 'gitdir'), POINTER_LIMIT, budget);
    guards.push(back.guard);
    pointerHashes.gitdir = back.guard.sha256;
    if (path.resolve(gitDirectory, pointer(back.text)) !== dotGit) throw Error('Git registration belongs to another worktree');
  } else throw Error('Worktree has no ordinary or authorized linked Git metadata');

  const gitGuard = await directory(gitDirectory, budget);
  const commonGuard = await directory(commonDirectory, budget);
  guards.push(gitGuard, commonGuard);
  for (const root of [...new Set([gitDirectory, commonDirectory])]) {
    guards.push(await absent(path.join(root, 'config.worktree'), budget));
    guards.push(await absent(path.join(root, 'shallow'), budget));
  }
  const config = await metadata(path.join(commonDirectory, 'config'), CONFIG_LIMIT, budget);
  validateConfig(config.text);
  guards.push(config.guard);
  // Git may consult HEAD while establishing a repository, even for exact object IDs.
  await mutableHeadState(gitDirectory, commonDirectory, budget);
  // HEAD is mutable repository state, not durable grant authority. Each lookup binds
  // a fresh safe HEAD snapshot only for the duration of that metadata read.
  const objects = path.join(commonDirectory, 'objects');
  guards.push(await directory(objects, budget));
  guards.push(await directory(path.join(objects, 'pack'), budget));
  guards.push(await directory(path.join(objects, 'info'), budget));
  for (const name of ['alternates', 'http-alternates']) guards.push(await absent(path.join(objects, 'info', name), budget));
  await safeOptimizationCaches(commonDirectory, budget);
  const info = path.join(commonDirectory, 'info');
  guards.push(await directory(info, budget));
  guards.push(await absent(path.join(info, 'grafts'), budget));
  // Check pack safety now, before any possible subprocess. Snapshot again per read.
  await packs(commonDirectory, budget);
  const uniqueGuards = [...new Map(guards.map(guard => [guard.path, guard])).values()].sort((a, b) => a.path.localeCompare(b.path));
  return Object.freeze({
    contract: CONTRACT, kind, worktree, gitDirectory, commonDirectory,
    identities: Object.freeze({ worktree: identity(worktreeGuard), gitDirectory: identity(gitGuard), commonDirectory: identity(commonGuard) }),
    pointerHashes: Object.freeze(pointerHashes), guards: Object.freeze(uniqueGuards.map(guard => Object.freeze(guard))),
  });
}

/** The caller must approve the worktree and the exact common metadata paths first. No Git process runs here. */
export async function inspectGitActivityMetadata(worktree: string, approvedCommonPaths: readonly string[], signal: AbortSignal): Promise<GitActivityDescriptor> {
  return inspect(worktree, approvedCommonPaths, new Budget(TIMEOUT, signal));
}
/** Parse persisted authority data structurally; filesystem authority still requires validation. */
export function parseGitActivityDescriptor(value: unknown): GitActivityDescriptor {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const keys = (item: Record<string, unknown>, expected: string[]) => same(Object.keys(item).sort(), [...expected].sort());
  const number = (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0;
  const isIdentity = (item: unknown): boolean => object(item) && keys(item, ['path', 'dev', 'ino']) && typeof item.path === 'string' && validPath(item.path) && number(item.dev) && number(item.ino);
  if (!object(value) || !keys(value, ['contract', 'kind', 'worktree', 'gitDirectory', 'commonDirectory', 'identities', 'pointerHashes', 'guards']) ||
    value.contract !== CONTRACT || !['ordinary', 'linked'].includes(String(value.kind)) ||
    !['worktree', 'gitDirectory', 'commonDirectory'].every(key => typeof value[key] === 'string' && validPath(value[key] as string)) ||
    !object(value.identities) || !keys(value.identities, ['worktree', 'gitDirectory', 'commonDirectory']) || !Object.values(value.identities).every(isIdentity) ||
    !object(value.pointerHashes) || !keys(value.pointerHashes, value.kind === 'linked' ? ['dotGit', 'commondir', 'gitdir'] : []) ||
    !Object.values(value.pointerHashes).every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) ||
    !Array.isArray(value.guards) || value.guards.length < 1 || value.guards.length > 64) throw Error('Invalid Git activity descriptor');
  for (const guard of value.guards) {
    if (!object(guard) || typeof guard.path !== 'string' || !validPath(guard.path) || !number(guard.dev) || !number(guard.ino) || !['directory', 'file', 'missing'].includes(String(guard.kind))) throw Error('Invalid Git metadata guard');
    const expected = guard.kind === 'missing' ? ['path', 'dev', 'ino', 'kind'] : guard.kind === 'directory' || guard.sha256 === undefined ? ['path', 'dev', 'ino', 'kind', 'mode'] : ['path', 'dev', 'ino', 'kind', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs', 'sha256'];
    if (!keys(guard, expected) || expected.filter(key => !['path', 'kind', 'sha256'].includes(key)).some(key => !number(guard[key])) ||
      (guard.sha256 !== undefined && (typeof guard.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(guard.sha256)))) throw Error('Invalid Git metadata guard');
  }
  const descriptor = JSON.parse(JSON.stringify(value)) as GitActivityDescriptor;
  if (descriptor.identities.worktree.path !== descriptor.worktree || descriptor.identities.gitDirectory.path !== descriptor.gitDirectory || descriptor.identities.commonDirectory.path !== descriptor.commonDirectory ||
    (descriptor.kind === 'ordinary' && (descriptor.gitDirectory !== path.join(descriptor.worktree, '.git') || descriptor.commonDirectory !== descriptor.gitDirectory)) ||
    (descriptor.kind === 'linked' && (path.dirname(descriptor.gitDirectory) !== path.join(descriptor.commonDirectory, 'worktrees') || !inside(descriptor.commonDirectory, descriptor.gitDirectory))) ||
    new Set(descriptor.guards.map(guard => guard.path)).size !== descriptor.guards.length ||
    descriptor.guards.some(guard => guard.path !== descriptor.worktree && guard.path !== path.join(descriptor.worktree, '.git') && guard.path !== descriptor.commonDirectory && !inside(descriptor.commonDirectory, guard.path))) throw Error('Invalid Git activity descriptor topology');
  const required = new Map<string, GuardedPath['kind']>();
  for (const file of [descriptor.worktree, descriptor.gitDirectory, descriptor.commonDirectory, path.join(descriptor.commonDirectory, 'objects'), path.join(descriptor.commonDirectory, 'objects', 'pack'), path.join(descriptor.commonDirectory, 'objects', 'info'), path.join(descriptor.commonDirectory, 'info')]) required.set(file, 'directory');
  for (const root of [descriptor.gitDirectory, descriptor.commonDirectory]) for (const name of ['config.worktree', 'shallow']) required.set(path.join(root, name), 'missing');
  for (const name of ['alternates', 'http-alternates']) required.set(path.join(descriptor.commonDirectory, 'objects', 'info', name), 'missing');
  required.set(path.join(descriptor.commonDirectory, 'info', 'grafts'), 'missing');
  required.set(path.join(descriptor.commonDirectory, 'config'), 'file');
  if (descriptor.kind === 'linked') {
    required.set(path.dirname(descriptor.gitDirectory), 'directory');
    required.set(path.join(descriptor.worktree, '.git'), 'file');
    required.set(path.join(descriptor.gitDirectory, 'commondir'), 'file');
    required.set(path.join(descriptor.gitDirectory, 'gitdir'), 'file');
  } else required.set(path.join(descriptor.gitDirectory, 'commondir'), 'missing');
  const byPath = new Map(descriptor.guards.map(guard => [guard.path, guard]));
  if (required.size !== byPath.size || [...required].some(([file, kind]) => byPath.get(file)?.kind !== kind) ||
    Object.values(descriptor.identities).some(value => byPath.get(value.path)?.dev !== value.dev || byPath.get(value.path)?.ino !== value.ino) ||
    !byPath.get(path.join(descriptor.commonDirectory, 'config'))?.sha256 ||
    (descriptor.kind === 'linked' && (byPath.get(path.join(descriptor.worktree, '.git'))?.sha256 !== descriptor.pointerHashes.dotGit || byPath.get(path.join(descriptor.gitDirectory, 'commondir'))?.sha256 !== descriptor.pointerHashes.commondir || byPath.get(path.join(descriptor.gitDirectory, 'gitdir'))?.sha256 !== descriptor.pointerHashes.gitdir))) throw Error('Incomplete Git activity authority guards');
  Object.freeze(descriptor.identities.worktree); Object.freeze(descriptor.identities.gitDirectory); Object.freeze(descriptor.identities.commonDirectory);
  Object.freeze(descriptor.identities); Object.freeze(descriptor.pointerHashes);
  descriptor.guards.forEach(Object.freeze); Object.freeze(descriptor.guards);
  return Object.freeze(descriptor);
}

async function validate(descriptor: GitActivityDescriptor, budget: Budget): Promise<void> {
  parseGitActivityDescriptor(descriptor);
  // Retire a replaced directory before reading any file in that new identity.
  // Inspecting first and comparing afterward would already have crossed that boundary.
  for (const expected of descriptor.guards) if (expected.kind === 'directory') {
    if (!same(expected, await directory(expected.path, budget))) throw Error('Git activity directory identity changed');
  }
  for (const expected of descriptor.guards) if (expected.kind !== 'directory') {
    if (expected.kind === 'missing') { await absent(expected.path, budget); continue; }
    const actual = stamp(expected.path, await budget.run(() => lstat(expected.path)));
    if (Object.entries(expected).some(([key, value]) => key !== 'sha256' && actual[key as keyof GuardedPath] !== value)) throw Error('Git activity metadata identity changed');
  }
  const current = await inspect(descriptor.worktree, [descriptor.commonDirectory], budget);
  if (!same(descriptor, current)) throw Error('Git activity metadata identity or configuration changed');
}
export async function validateGitActivityDescriptor(descriptor: GitActivityDescriptor, signal: AbortSignal): Promise<void> {
  await validate(descriptor, new Budget(TIMEOUT, signal));
}

async function boundedNames(directoryPath: string, budget: Budget, limit: number, message: string): Promise<string[]> {
  let abandoned = false;
  let handle: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    handle = await budget.run(async () => {
      const opened = await opendir(directoryPath);
      if (abandoned) { await opened.close(); throw Error('Cancelled Git directory read'); }
      return opened;
    });
    const names: string[] = [];
    for (;;) {
      const entry = await budget.run(() => handle!.read());
      if (!entry) break;
      if (names.length >= limit) throw Error(message);
      names.push(entry.name);
    }
    return names.sort();
  } finally {
    abandoned = true;
    if (handle) {
      const closing = handle.close();
      if (budget.signal?.aborted || Date.now() >= budget.deadline) void closing.catch(() => {});
      else await budget.run(() => closing);
    }
  }
}

async function packs(commonDirectory: string, budget: Budget): Promise<GuardedPath[]> {
  const packDirectory = path.join(commonDirectory, 'objects', 'pack');
  const result = [stamp(packDirectory, await budget.run(() => lstat(packDirectory)))];
  const names = await boundedNames(packDirectory, budget, PACK_LIMIT, 'Git pack entry limit exceeded');
  if (names.length > PACK_LIMIT) throw Error('Git pack entry limit exceeded');
  for (const name of names) {
    if (!/^(?:pack-[a-fA-F0-9]{40}\.(?:pack|idx|rev|bitmap|keep)|multi-pack-index|multi-pack-index-[a-fA-F0-9]{40}\.bitmap)$/.test(name)) {
      throw Error('Unsupported Git pack entry');
    }
    const file = path.join(packDirectory, name);
    const guard = stamp(file, await budget.run(() => lstat(file)));
    if (guard.kind !== 'file') throw Error('Unsafe Git pack entry');
    result.push(guard);
  }
  return result;
}
/** Include every fanout so a newly added prefix collision invalidates the local index. */
async function objectInventory(commonDirectory: string, budget: Budget, proof?: { references?: readonly string[] }): Promise<GuardedPath[]> {
  const objects = path.join(commonDirectory, 'objects');
  const before = stamp(objects, await budget.run(() => lstat(objects)));
  const names = await boundedNames(objects, budget, 258, 'Git object directory entry limit exceeded');
  if (names.length > 258 || names.some(name => name !== 'pack' && name !== 'info' && !/^[a-f0-9]{2}$/.test(name))) throw Error('Unsupported Git object store entry');
  const result = [before, ...await packs(commonDirectory, budget)];
  let looseEntries = 0;
  for (const name of names) {
    const file = path.join(objects, name);
    await directory(file, budget);
    const beforeBucket = stamp(file, await budget.run(() => lstat(file)));
    result.push(beforeBucket);
    const prefixes = proof?.references?.filter(ref => ref.startsWith(name)).map(ref => ref.slice(2));
    if (proof && /^[a-f0-9]{2}$/.test(name) && (prefixes === undefined || prefixes.length > 0)) {
      const enumerated = await boundedNames(file, budget, GIT_ACTIVITY_LOOSE_ENTRY_LIMIT - looseEntries, 'Git loose object proof limit exceeded');
      looseEntries += enumerated.length;
      const looseNames = prefixes === undefined ? enumerated : enumerated.filter(looseName => prefixes.some(prefix => looseName.startsWith(prefix)));
      if (looseEntries > GIT_ACTIVITY_LOOSE_ENTRY_LIMIT) throw Error('Git loose object proof limit exceeded');
      for (const looseName of looseNames) {
        if (!/^[a-f0-9]{38}$/.test(looseName)) throw Error('Unsupported loose Git object entry');
        const loose = path.join(file, looseName);
        const guard = stamp(loose, await budget.run(() => lstat(loose)));
        if (guard.kind !== 'file') throw Error('Unsafe loose Git object entry');
        result.push(guard);
      }
      if (!same(beforeBucket, stamp(file, await budget.run(() => lstat(file))))) throw Error('Git loose object store changed while inspecting');
    }
  }
  if (!same(before, stamp(objects, await budget.run(() => lstat(objects))))) throw Error('Git object store changed while inspecting');
  return result;
}
/** Bounded cache invalidation fingerprint; no loose object content is read. */
export async function gitActivityObjectRevision(descriptor: GitActivityDescriptor, signal: AbortSignal, declaredReferences?: readonly string[]): Promise<string> {
  if (declaredReferences !== undefined && (!Array.isArray(declaredReferences) || declaredReferences.length > GIT_ACTIVITY_LOOSE_ENTRY_LIMIT || declaredReferences.some(ref => typeof ref !== 'string' || ref.length > 4096))) throw Error('Git object revision reference limit exceeded');
  const proof = declaredReferences === undefined ? {} : { references: [...new Set(declaredReferences.filter(ref => /^[a-fA-F0-9]{4,40}$/.test(ref)).map(ref => ref.toLowerCase()))] };
  const budget = new Budget(TIMEOUT, signal);
  await validate(descriptor, budget);
  const state = await objectInventory(descriptor.commonDirectory, budget, proof);
  await validate(descriptor, budget);
  if (!same(state, await objectInventory(descriptor.commonDirectory, budget, proof))) throw Error('Git object store changed while inspecting');
  return hash(JSON.stringify(state));
}

/** Metadata only: never read/decompress an object or walk commit history ourselves. */
async function objectState(descriptor: GitActivityDescriptor, refs: readonly string[], budget: Budget): Promise<GuardedPath[]> {
  const result: GuardedPath[] = [];
  for (const guard of descriptor.guards) if (guard.kind === 'directory') result.push(stamp(guard.path, await budget.run(() => lstat(guard.path))));
  result.push(...await mutableHeadState(descriptor.gitDirectory, descriptor.commonDirectory, budget));
  result.push(...await objectInventory(descriptor.commonDirectory, budget));
  const prefixes = [...new Set(refs.map(ref => ref.slice(0, 2)))].sort();
  let enumeratedEntries = 0;
  for (const prefix of prefixes) {
    const bucket = path.join(descriptor.commonDirectory, 'objects', prefix);
    let stat: Stats;
    try { stat = await budget.run(() => lstat(bucket)); }
    catch (error) { if (missing(error)) { result.push({ path: bucket, kind: 'missing', dev: 0, ino: 0 }); continue; } throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await budget.run(() => realpath(bucket)) !== bucket) throw Error('Unsafe loose object directory');
    result.push(stamp(bucket, stat));
    const matching = refs.filter(ref => ref.startsWith(prefix)).map(ref => ref.slice(2));
    const enumerated = await boundedNames(bucket, budget, GIT_ACTIVITY_LOOSE_ENTRY_LIMIT - enumeratedEntries, 'Git loose object metadata limit exceeded');
    enumeratedEntries += enumerated.length;
    const names = enumerated.filter(name => matching.some(ref => name.startsWith(ref)));
    if (names.length > 4096) throw Error('Git loose object metadata limit exceeded');
    for (const name of names) {
      if (!/^[a-fA-F0-9]{38}$/.test(name)) throw Error('Unsafe loose object name');
      const file = path.join(bucket, name);
      const guard = stamp(file, await budget.run(() => lstat(file)));
      if (guard.kind !== 'file') throw Error('Unsafe loose object');
      result.push(guard);
    }
  }
  return result;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, LC_ALL: 'C', LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullDevice, GIT_CONFIG_GLOBAL: nullDevice,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1',
  };
  if (process.env.SYSTEMROOT) environment.SYSTEMROOT = process.env.SYSTEMROOT;
  return environment;
}
async function gitRead(descriptor: GitActivityDescriptor, args: string[], input: string | undefined, budget: Budget, output: { bytes: number }): Promise<string> {
  budget.check();
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', [
      '--no-pager', '--no-optional-locks', '--no-replace-objects',
      `--git-dir=${descriptor.gitDirectory}`, `--work-tree=${descriptor.worktree}`,
      '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullDevice}`,
      '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false',
      '-c', 'log.mailmap=false', '-c', 'core.warnAmbiguousRefs=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      '-c', 'protocol.allow=never', ...args,
    ], { cwd: descriptor.worktree, env: gitEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      budget.signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const abort = () => finish(Error('Cancelled Git activity read'));
    const timer = setTimeout(() => finish(Error('Git activity read exceeded its aggregate deadline')), Math.max(1, budget.deadline - Date.now()));
    for (const [stream, keep] of [[child.stdout, true], [child.stderr, false]] as const) stream.on('data', (chunk: Buffer) => {
      output.bytes += chunk.length;
      if (output.bytes > OUTPUT_LIMIT) finish(Error('Git activity aggregate output limit exceeded'));
      else if (keep) chunks.push(chunk);
    });
    child.stdin.on('error', () => { /* bounded child exit is handled below */ });
    child.once('error', () => finish(Error('Git activity executable unavailable')));
    child.once('close', code => finish(code === 0 ? undefined : Error('Git object metadata unavailable')));
    budget.signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(input);
    if (budget.signal?.aborted) abort();
  });
}
function objectNames(output: string): string[] {
  const lines = output.trimEnd() ? output.trimEnd().split('\n') : [];
  if (lines.some(line => !/^[a-f0-9]{40}$/.test(line))) throw Error('Invalid Git object identity output');
  return [...new Set(lines)];
}
function validCommitTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

/** Resolve only declared SHA-1 IDs, never refs, tags, paths, commit text, or history. */
export async function readGitActivityReferences(
  descriptor: GitActivityDescriptor, refs: string[], signal: AbortSignal, validateAuthority: () => Promise<void>,
): Promise<GitActivityReference[]> {
  if (!Array.isArray(refs) || refs.length > GIT_ACTIVITY_REFERENCE_LIMIT || refs.some(ref => typeof ref !== 'string' || ref.length > 4096)) throw Error('Git activity reference limit exceeded');
  const budget = new Budget(TIMEOUT, signal);
  const output = { bytes: 0 };
  const canonical = [...new Set(refs.filter(ref => /^[a-fA-F0-9]{4,40}$/.test(ref)).map(ref => ref.toLowerCase()))];
  await budget.run(validateAuthority);
  await validate(descriptor, budget);
  const initial = await objectState(descriptor, canonical, budget);
  const guard = async () => {
    await budget.run(validateAuthority);
    await validate(descriptor, budget);
    if (!same(initial, await objectState(descriptor, canonical, budget))) throw Error('Git object store changed during activity read');
    await budget.run(validateAuthority);
    budget.check();
  };
  const read = async (args: string[], input?: string) => {
    await guard();
    const result = await gitRead(descriptor, args, input, budget, output);
    await guard();
    return result;
  };
  const prefixes = canonical.filter(ref => ref.length < 40);
  const candidates = prefixes.length ? objectNames(await read(['rev-parse', ...prefixes.map(ref => `--disambiguate=${ref}`)])) : [];
  const resolutions = new Map<string, GitActivityReference>();
  for (const ref of canonical) {
    const matches = ref.length === 40 ? [ref] : candidates.filter(sha => sha.startsWith(ref));
    resolutions.set(ref, matches.length === 1 ? { declaredReference: ref, status: 'missing', fullSha: matches[0] } : { declaredReference: ref, status: matches.length ? 'ambiguous' : 'missing' });
  }
  const shas = [...new Set([...resolutions.values()].flatMap(result => result.fullSha ? [result.fullSha] : []))];
  const commits = new Set<string>();
  if (shas.length) {
    const rows = (await read(['cat-file', '--batch-check=%(objectname) %(objecttype)'], shas.join('\n') + '\n')).trimEnd().split('\n');
    if (rows.length !== shas.length) throw Error('Invalid Git object type output');
    for (let i = 0; i < rows.length; i++) {
      const [sha, type, ...rest] = rows[i]!.split(' ');
      if (sha !== shas[i] || rest.length || !['commit', 'tree', 'blob', 'tag', 'missing'].includes(type!)) throw Error('Invalid Git object type output');
      if (type === 'commit') commits.add(sha!);
      else for (const resolution of resolutions.values()) if (resolution.fullSha === sha) { resolution.status = type === 'missing' ? 'missing' : 'noncommit'; delete resolution.fullSha; }
    }
  }
  if (commits.size) {
    const times = await read(['show', '--no-patch', '--no-walk=unsorted', '--no-notes', '--no-decorate', '--no-use-mailmap', '--no-show-signature', '--format=%H%x00%cI', ...commits, '--']);
    const seen = new Set<string>();
    for (const row of times.trimEnd().split('\n')) {
      const [sha, at, ...rest] = row.split('\0');
      if (!sha || !commits.has(sha) || seen.has(sha) || rest.length || !at || !validCommitTime(at)) throw Error('Invalid Git commit timestamp output');
      seen.add(sha);
      for (const resolution of resolutions.values()) if (resolution.fullSha === sha) { resolution.status = 'resolved'; resolution.at = new Date(at).toISOString(); }
    }
    if (seen.size !== commits.size) throw Error('Incomplete Git commit timestamp output');
  }
  await guard();
  return refs.map(declaredReference => ({ ...(resolutions.get(declaredReference.toLowerCase()) ?? { status: 'unsupported' as const }), declaredReference }));
}
