import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { NoteLinkConfirmRequest, NoteLinkConfirmResult, NoteLinkFailureCode, NoteLinkPreviewRequest, NoteLinkPreviewResult, NoteLinkProposal } from '../../../shared/note-link-workflow';
import { Budget, LinkError, closeBounded, assertSnapshot, hash, identity, publicError, realDirectory, snapshot, stamp, type Snapshot } from './safe-io';
import { inside, inspectGit, validPath, noteIsTracked, noteIsIgnored } from './git';

export const NOTE_LINK_LIMITS = Object.freeze({ timeoutMs: 10_000, maxTimeoutMs: 30_000, proposalTtlMs: 120_000, maxProposalTtlMs: 300_000, maxPendingProposals: 32, maxExcludeBytes: 1_048_576, maxCommonGitDirs: 64 });
export interface NoteLinkSelection {
  localHostId: string;
  worktree: { worktreeId: string; hostId: string; worktreePath: string };
  scope: { scopeId: string; hostId: string; vaultRootPath: string; scopePath: string };
}
export interface NoteLinkWorkflowOptions {
  gitExecutablePath: string;
  /** Exact, main-owned common Git directories for linked worktrees; never learned from .git. */
  allowedCommonGitDirs: readonly string[];
  resolveSelection: (worktreeId: string, scopeId: string) => NoteLinkSelection | null | Promise<NoteLinkSelection | null>;
  timeoutMs?: number;
  proposalTtlMs?: number;
}
export interface NoteLinkWorkflow {
  preview(request: NoteLinkPreviewRequest, signal?: AbortSignal): Promise<NoteLinkPreviewResult>;
  confirm(request: NoteLinkConfirmRequest, signal?: AbortSignal): Promise<NoteLinkConfirmResult>;
  /** Invalidates an unconsumed preview. Cancellation never means undoing a commit. */
  cancel(proposalId: string): boolean;
}
interface Observation {
  selection: NoteLinkSelection;
  snapshots: Snapshot[];
  excludeBytes: Buffer;
  afterBytes: Buffer;
  view: Omit<NoteLinkProposal, 'proposalId' | 'confirmationToken' | 'expiresAt'>;
}
interface Proposal { request: NoteLinkPreviewRequest; expiresAt: number; confirmationToken: string; observation: Observation; view: NoteLinkProposal }
interface Owned { docs?: Snapshot; note?: Snapshot; exclude?: Snapshot; temporary?: Snapshot; unknown: boolean }
const rule = '/docs/note' as const;
const zeros = () => ({ docsCreated: false, noteLinked: false, excludeUpdated: false });
const id = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key)); }
function copySelection(value: NoteLinkSelection | null, request: NoteLinkPreviewRequest): NoteLinkSelection {
  if (!value || !record(value) || !record(value.worktree) || !record(value.scope) || !id(value.localHostId) || value.worktree.worktreeId !== request.worktreeId || value.scope.scopeId !== request.scopeId || !id(value.worktree.hostId) || !id(value.scope.hostId) || !validPath(value.worktree.worktreePath) || !validPath(value.scope.vaultRootPath) || !validPath(value.scope.scopePath)) throw new LinkError('selection-unavailable', 'The selected worktree and note scope are not available from trusted main-process registrations.');
  const selected: NoteLinkSelection = { localHostId: value.localHostId, worktree: { worktreeId: value.worktree.worktreeId, hostId: value.worktree.hostId, worktreePath: path.resolve(value.worktree.worktreePath) }, scope: { scopeId: value.scope.scopeId, hostId: value.scope.hostId, vaultRootPath: path.resolve(value.scope.vaultRootPath), scopePath: path.resolve(value.scope.scopePath) } };
  if (selected.localHostId !== selected.worktree.hostId || selected.localHostId !== selected.scope.hostId) throw new LinkError('remote-host', 'Only a verified worktree and note scope on this local host can be linked.');
  return selected;
}
function appendDelta(before: Buffer): Buffer {
  // Exact byte comparisons preserve arbitrary pre-existing bytes and every existing line ending.
  const lines = before.toString('latin1').split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  const lastRule = lines.lastIndexOf(rule);
  // A later negation can override an existing entry. Append our exact rule last rather
  // than interpreting arbitrary Git wildmatch syntax or silently claiming a no-op.
  if (lastRule >= 0 && !lines.slice(lastRule + 1).some((line) => line.startsWith('!'))) return Buffer.alloc(0);
  const newline = before.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const separator = before.length && before[before.length - 1] !== 10 ? newline : '';
  return Buffer.from(`${separator}${rule}${newline}`, 'ascii');
}
async function observe(options: NoteLinkWorkflowOptions, request: NoteLinkPreviewRequest, temporaryName: string, budget: Budget): Promise<Observation> {
  const selection = copySelection(await budget.run(async () => options.resolveSelection(request.worktreeId, request.scopeId)), request);
  const { worktree: w, scope: s } = selection;
  if (!inside(s.vaultRootPath, s.scopePath)) throw new LinkError('invalid-scope', 'The selected scope must be strictly inside its explicitly registered vault. Whole-vault links are forbidden.');
  const worktree = await realDirectory(w.worktreePath, budget);
  const vault = await realDirectory(s.vaultRootPath, budget);
  const scope = await budget.run(() => fs.realpath(s.scopePath));
  if (!inside(vault, scope)) throw new LinkError('invalid-scope', 'The canonical selected scope must be strictly inside its registered vault.');
  await realDirectory(scope, budget);
  const snapshots: Snapshot[] = [];
  for (const p of new Set([w.worktreePath, worktree, s.vaultRootPath, vault, s.scopePath, scope])) snapshots.push((await snapshot(p, budget)).snapshot);
  const docs = path.join(worktree, 'docs');
  const note = path.join(docs, 'note');
  if (scope === docs || inside(scope, note)) throw new LinkError('invalid-scope', 'The selected source would introduce a recursive note link.');
  const docsStat = (await snapshot(docs, budget)).snapshot;
  snapshots.push(docsStat);
  const conflicts: string[] = [];
  if (docsStat.exists && docsStat.kind !== 'directory') conflicts.push('docs already exists and is not a direct directory; it will not be replaced or followed.');
  if (docsStat.kind === 'directory' && await realDirectory(docs, budget) !== docs) throw new LinkError('unsafe-path', 'The docs path changed during canonical validation.');
  let noteStat: Snapshot = { path: note, exists: false };
  let correctLink = false;
  if (docsStat.kind === 'directory') {
    noteStat = (await snapshot(note, budget)).snapshot;
    if (noteStat.kind === 'symlink') {
      try { correctLink = await budget.run(() => fs.realpath(note)) === scope; }
      catch (error) { if (error instanceof LinkError) throw error; }
      if (!correctLink) conflicts.push('docs/note is a different or broken symlink; it will not be replaced.');
    } else if (noteStat.exists) conflicts.push('docs/note already exists as a file or directory; it will not be replaced.');
  }
  if (!docsStat.exists || docsStat.kind === 'directory') snapshots.push(noteStat);
  const git = await inspectGit(options.gitExecutablePath, worktree, options.allowedCommonGitDirs, budget);
  snapshots.push(...git.snapshots);
  if (await noteIsTracked(options.gitExecutablePath, worktree, budget)) conflicts.push('Git already tracks docs/note or entries below it. Linking would change a tracked path.');
  const excludeRead = await snapshot(git.exclude, budget, true, NOTE_LINK_LIMITS.maxExcludeBytes);
  const exclude = excludeRead.snapshot;
  snapshots.push(exclude);
  if (exclude.exists && exclude.kind !== 'file') conflicts.push('The local Git exclude target is not a direct regular file; it will not be followed or replaced.');
  if (exclude.kind === 'file' && (exclude.mode! & 0o222) === 0) throw new LinkError('filesystem-unavailable', 'The local Git exclude file is read-only.');
  if (exclude.kind === 'file' && (await budget.run(() => fs.lstat(git.exclude))).nlink !== 1) throw new LinkError('unsafe-path', 'A hard-linked exclude file cannot be safely replaced.');
  const before = excludeRead.bytes ?? Buffer.alloc(0);
  const delta = appendDelta(before);
  const after = Buffer.concat([before, delta]);
  if (after.length > NOTE_LINK_LIMITS.maxExcludeBytes) throw new LinkError('unsafe-path', 'The proposed exclude file exceeds the bounded size limit.');
  const temporaryExclude = path.join(path.dirname(git.exclude), temporaryName);
  const temp = (await snapshot(temporaryExclude, budget)).snapshot;
  if (temp.exists) throw new LinkError('conflict', 'The transaction temporary path already exists. Create another preview.');
  snapshots.push(temp);
  // Recheck originals after resolving all paths; this also binds symlink aliases in main-owned registrations.
  for (const expected of snapshots) await assertSnapshot(expected, budget);
  const changes = { createDocsDirectory: !docsStat.exists, createNoteSymlink: !correctLink, appendLocalExclude: delta.length > 0 };
  return { selection, snapshots, excludeBytes: before, afterBytes: after, view: {
    worktreeId: request.worktreeId, scopeId: request.scopeId,
    status: conflicts.length ? 'conflict' : Object.values(changes).some(Boolean) ? 'changes' : 'noop',
    paths: { worktree, vault, scope, docs, note, gitDirectory: git.gitDirectory, commonGitDirectory: git.commonDirectory, exclude: git.exclude, temporaryExclude },
    changes, exclude: { rule, appendText: delta.toString('utf8'), beforeSha256: hash(before), afterSha256: hash(after), beforeBytes: before.length, afterBytes: after.length },
    sharedExclude: { worktreePaths: git.worktreePaths, scopeDescription: 'This local exclude file applies to every worktree sharing this common Git directory. Listed paths are the current Git registrations; stale registrations may remain.' },
    conflicts,
    warnings: ['No tracked .gitignore is changed. The rule is /docs/note, without a trailing slash, because the destination is a symlink. Higher-priority .gitignore rules or tracked files may override local exclude behavior.', 'Portable filesystem checks detect observed changes but cannot exclude adversarial replacement races or guarantee power-loss atomicity.', 'A pending native filesystem call cannot be forcibly cancelled. An uncertain or partial result needs inspection before retrying.', ...(delta.length ? ['The preview includes a temporary exclude file in the same Git info directory, removed after commit or safe rollback.'] : [])],
  } };
}
function fingerprint(observation: Observation): string {
  return hash(JSON.stringify({ selection: observation.selection, snapshots: observation.snapshots, view: observation.view }));
}
function getStamp(observation: Observation, p: string): Snapshot {
  const result = observation.snapshots.find((entry) => entry.path === p);
  if (!result) throw new LinkError('unsafe-path', 'A required preview identity is missing.');
  return result;
}
async function validateAnchors(observation: Observation, owned: Owned, budget: Budget): Promise<void> {
  const p = observation.view.paths;
  // Directory identity remains stable through our own mkdir/temp operations; contents are checked independently.
  for (const expected of observation.snapshots) {
    if ([p.note, p.exclude, p.temporaryExclude, p.docs].includes(expected.path)) continue;
    await assertSnapshot(expected, budget, expected.kind !== 'directory');
  }
  if (owned.docs) await assertSnapshot(owned.docs, budget, false);
  else await assertSnapshot(getStamp(observation, p.docs), budget, falseIfDirectory(getStamp(observation, p.docs)));
  if (await realDirectory(p.worktree, budget) !== p.worktree || await realDirectory(p.vault, budget) !== p.vault || await realDirectory(p.scope, budget) !== p.scope) throw new LinkError('stale-preview', 'A canonical source path changed.');
}
function falseIfDirectory(s: Snapshot): boolean { return s.kind !== 'directory'; }
async function writeTemporary(observation: Observation, bytes: Buffer, budget: Budget, owned: Owned, mode: number): Promise<Snapshot> {
  const p = observation.view.paths.temporaryExclude;
  let handle: FileHandle | undefined;
  let abandoned = false;
  let failed = false;
  try {
    handle = await budget.run(async () => {
      const h = await fs.open(p, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
      if (abandoned) { await h.close(); throw new LinkError('timeout', 'A late temporary file creation needs inspection.', true); }
      try { owned.temporary = stamp(p, await h.stat()); } catch (error) { void h.close().catch(() => {}); throw error; }
      if (abandoned) { void h.close().catch(() => {}); throw new LinkError('timeout', 'A late temporary file creation needs inspection.', true); }
      return h;
    }, true);
    owned.temporary = stamp(p, await budget.run(() => handle!.stat()));
    await budget.run(() => handle!.chmod(mode), true);
    await budget.run(() => handle!.writeFile(bytes), true);
    await budget.run(() => handle!.sync(), true);
    const final = stamp(p, await budget.run(() => handle!.stat()));
    final.sha256 = hash(bytes);
    owned.temporary = final;
    return final;
  } catch (error) { failed = true; throw error; }
  finally {
    abandoned = true;
    if (handle && !(await closeBounded(handle, budget)) && !failed) throw new LinkError(budget.signal?.aborted ? 'cancelled' : 'timeout', 'Temporary-file descriptor cleanup is still pending. Inspect transaction paths before retrying.', true);
  }
}
async function cleanTemporary(observation: Observation, owned: Owned, budget: Budget): Promise<void> {
  if (!owned.temporary) return;
  await assertSnapshot(owned.temporary, budget);
  await budget.run(() => fs.unlink(observation.view.paths.temporaryExclude), true);
  owned.temporary = undefined;
}
async function rollback(observation: Observation, owned: Owned): Promise<{ ok: boolean; recovery: string[]; actual: NoteLinkConfirmResult['actual'] }> {
  const budget = new Budget(NOTE_LINK_LIMITS.timeoutMs);
  const p = observation.view.paths;
  const recovery: string[] = [];
  const actual = { docsCreated: Boolean(owned.docs) as boolean | null, noteLinked: Boolean(owned.note) as boolean | null, excludeUpdated: Boolean(owned.exclude) as boolean | null };
  // An in-flight native mutation could still happen. Do not race it with rollback or claim it was undone.
  if (owned.unknown) return { ok: false, actual: { docsCreated: owned.docs ? true : null, noteLinked: owned.note ? true : null, excludeUpdated: owned.exclude ? true : null }, recovery: [`A native change may still settle. Inspect ${p.docs}, ${p.note}, ${p.exclude}, and ${p.temporaryExclude} before taking further action. No automatic rollback was attempted.`] };
  let anchorsSafe = true;
  try { await validateAnchors(observation, owned, budget); } catch { anchorsSafe = false; }
  if (!anchorsSafe) return { ok: false, actual: { docsCreated: null, noteLinked: null, excludeUpdated: null }, recovery: ['The authority or parent-directory identity changed. Automatic rollback was stopped to preserve foreign paths. Inspect the paths from the preview.'] };
  if (owned.exclude) {
    try {
      await assertSnapshot(owned.exclude, budget);
      if (getStamp(observation, p.exclude).exists) {
        await cleanTemporary(observation, owned, budget);
        const restored = await writeTemporary(observation, observation.excludeBytes, budget, owned, getStamp(observation, p.exclude).mode! & 0o777);
        await assertSnapshot(owned.exclude, budget);
        await validateAnchors(observation, owned, budget);
        await budget.run(() => fs.rename(p.temporaryExclude, p.exclude), true);
        owned.temporary = undefined;
        const restoredNow = (await snapshot(p.exclude, budget, true)).snapshot;
        if (!identity(restored, restoredNow) || restoredNow.sha256 !== restored.sha256) throw new LinkError('stale-preview', 'Restored exclude bytes changed.');
      } else await budget.run(() => fs.unlink(p.exclude), true);
      actual.excludeUpdated = false; owned.exclude = undefined;
    } catch (error) {
      if (error instanceof LinkError && error.pendingWrite) return { ok: false, actual: { ...actual, excludeUpdated: null }, recovery: [`An exclude rollback write is still pending. No further rollback was attempted. Inspect ${p.exclude} and ${p.temporaryExclude} before retrying.`] };
      actual.excludeUpdated = null; recovery.push(`Local exclude rollback could not prove ownership: ${p.exclude}. Preserve concurrent edits and compare its bytes with the preview.`); }
  }
  if (owned.note) {
    try { await assertSnapshot(owned.note, budget); await validateAnchors(observation, owned, budget); await budget.run(() => fs.unlink(p.note), true); owned.note = undefined; actual.noteLinked = false; }
    catch (error) {
      if (error instanceof LinkError && error.pendingWrite) return { ok: false, actual: { ...actual, noteLinked: null }, recovery: [...recovery, `Note-link removal is still pending. No further rollback was attempted. Inspect ${p.note} and ${p.docs}.`] };
      actual.noteLinked = null; recovery.push(`The note link changed or could not be removed safely: ${p.note}. Do not remove a replacement made by someone else.`); }
  }
  if (owned.docs) {
    try { await assertSnapshot(owned.docs, budget, false); await budget.run(() => fs.rmdir(p.docs), true); owned.docs = undefined; actual.docsCreated = false; }
    catch (error) {
      if (error instanceof LinkError && error.pendingWrite) return { ok: false, actual: { ...actual, docsCreated: null }, recovery: [...recovery, `Directory removal is still pending. No further rollback was attempted. Inspect ${p.docs}.`] };
      actual.docsCreated = null; recovery.push(`The created docs directory is changed or nonempty: ${p.docs}. Preserve any new contents.`); }
  }
  try { await cleanTemporary(observation, owned, budget); } catch { recovery.push(`Temporary exclude bytes could not be safely removed: ${p.temporaryExclude}. Inspect ownership before cleanup.`); }
  return { ok: recovery.length === 0, recovery, actual };
}
async function transact(options: NoteLinkWorkflowOptions, proposal: Proposal, proposalId: string, budget: Budget): Promise<NoteLinkConfirmResult> {
  const observation = proposal.observation;
  const p = observation.view.paths;
  const changes = observation.view.changes;
  const owned: Owned = { unknown: false };
  let committed = false;
  try {
    budget.check();
    if (changes.createDocsDirectory) {
      await validateAnchors(observation, owned, budget);
      await assertSnapshot(getStamp(observation, p.docs), budget);
      await budget.run(async () => { await fs.mkdir(p.docs, { mode: 0o755 }); owned.docs = stamp(p.docs, await fs.lstat(p.docs)); }, true);
      if (owned.docs?.kind !== 'directory') throw new LinkError('stale-preview', 'The newly created docs directory changed.');
    }
    await validateAnchors(observation, owned, budget);
    if (changes.createNoteSymlink) {
      await assertSnapshot(getStamp(observation, p.note), budget);
      await budget.run(async () => {
        await fs.symlink(p.scope, p.note, 'dir');
        const created = stamp(p.note, await fs.lstat(p.note));
        if (created.kind !== 'symlink') throw new LinkError('stale-preview', 'The newly created note link was replaced before ownership could be recorded.');
        created.link = await fs.readlink(p.note);
        if (created.link !== p.scope) throw new LinkError('stale-preview', 'The newly created note link target changed before ownership could be recorded.');
        owned.note = created;
      }, true);
      if (owned.note?.kind !== 'symlink' || owned.note.link !== p.scope || await budget.run(() => fs.realpath(p.note)) !== p.scope) throw new LinkError('stale-preview', 'The new symlink changed before it could be verified.');
    } else await assertSnapshot(getStamp(observation, p.note), budget);
    if (changes.appendLocalExclude) {
      const before = getStamp(observation, p.exclude);
      await validateAnchors(observation, owned, budget);
      await assertSnapshot(before, budget);
      const temporary = await writeTemporary(observation, observation.afterBytes, budget, owned, before.exists ? before.mode! & 0o777 : 0o600);
      await validateAnchors(observation, owned, budget);
      await assertSnapshot(owned.note ?? getStamp(observation, p.note), budget);
      await assertSnapshot(before, budget);
      await assertSnapshot(temporary, budget);
      if (before.exists) {
        await budget.run(() => fs.rename(p.temporaryExclude, p.exclude), true);
        owned.temporary = undefined;
      } else {
        // link is an atomic create-if-absent: do not replace a file that appeared after preview.
        await budget.run(() => fs.link(p.temporaryExclude, p.exclude), true);
      }
      owned.exclude = { ...temporary, path: p.exclude };
      // Rename/link can legitimately change ctime; capture and bind actual inode plus exact bytes.
      const installed = (await snapshot(p.exclude, budget, true)).snapshot;
      if (!identity(owned.exclude, installed) || installed.sha256 !== observation.view.exclude.afterSha256) throw new LinkError('stale-preview', 'The installed exclude bytes changed before verification.');
      owned.exclude = installed;
      if (owned.temporary) {
        const tempNow = (await snapshot(p.temporaryExclude, budget, true)).snapshot;
        if (!identity(temporary, tempNow) || tempNow.sha256 !== temporary.sha256) throw new LinkError('stale-preview', 'The temporary exclude file changed.');
        owned.temporary = tempNow;
        await cleanTemporary(observation, owned, budget);
        const afterCleanup = (await snapshot(p.exclude, budget, true)).snapshot;
        if (!identity(installed, afterCleanup) || afterCleanup.sha256 !== observation.view.exclude.afterSha256) throw new LinkError('stale-preview', 'The installed exclude changed during temporary-file cleanup.');
        owned.exclude = afterCleanup;
      }
    }
    await validateAnchors(observation, owned, budget);
    await assertSnapshot(owned.note ?? getStamp(observation, p.note), budget);
    await assertSnapshot(owned.exclude ?? getStamp(observation, p.exclude), budget);
    if (await noteIsTracked(options.gitExecutablePath, p.worktree, budget)) throw new LinkError('conflict', 'The note destination became tracked by Git during the transaction.');
    if (!(await noteIsIgnored(options.gitExecutablePath, p.worktree, budget))) throw new LinkError('conflict', 'Git reports that higher-priority ignore rules override the local note exclusion. No .gitignore changes are authorized.');
    await validateAnchors(observation, owned, budget);
    await assertSnapshot(owned.note ?? getStamp(observation, p.note), budget);
    await assertSnapshot(owned.exclude ?? getStamp(observation, p.exclude), budget);
    committed = true;
    return { status: observation.view.status === 'noop' ? 'noop' : 'applied', proposalId, message: observation.view.status === 'noop' ? 'The exact note link and local exclude rule already exist. No changes were made.' : 'The confirmed note link and local Git exclude changes were applied and verified.', actual: { docsCreated: Boolean(owned.docs), noteLinked: changes.createNoteSymlink, excludeUpdated: changes.appendLocalExclude }, recovery: [], cancellationRequested: Boolean(budget.signal?.aborted) };
  } catch (error) {
    const failure = publicError(error, 'write-failed');
    owned.unknown = failure.pendingWrite;
    if (committed) return { status: 'applied', proposalId, message: 'The changes committed before cancellation. They were not rolled back.', actual: { docsCreated: Boolean(owned.docs), noteLinked: Boolean(owned.note), excludeUpdated: Boolean(owned.exclude) }, recovery: [], cancellationRequested: Boolean(budget.signal?.aborted) };
    const result = await rollback(observation, owned);
    return { status: result.ok ? 'rolled-back' : 'partial', proposalId, code: failure.code, message: result.ok ? `${failure.message} Transaction-owned changes were rolled back.` : `${failure.message} Some paths need manual inspection; foreign changes were preserved.`, actual: result.actual, recovery: result.recovery, cancellationRequested: Boolean(budget.signal?.aborted) };
  }
}
export function createNoteLinkWorkflow(input: NoteLinkWorkflowOptions): NoteLinkWorkflow {
  if (!validPath(input.gitExecutablePath) || !Array.isArray(input.allowedCommonGitDirs) || input.allowedCommonGitDirs.length > NOTE_LINK_LIMITS.maxCommonGitDirs || !input.allowedCommonGitDirs.every(validPath) || typeof input.resolveSelection !== 'function') throw new Error('Invalid main-owned note-link configuration.');
  const timeoutMs = input.timeoutMs ?? NOTE_LINK_LIMITS.timeoutMs;
  const ttl = input.proposalTtlMs ?? NOTE_LINK_LIMITS.proposalTtlMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NOTE_LINK_LIMITS.maxTimeoutMs || !Number.isInteger(ttl) || ttl < 1 || ttl > NOTE_LINK_LIMITS.maxProposalTtlMs) throw new Error('Invalid note-link time bound.');
  const options: NoteLinkWorkflowOptions = { gitExecutablePath: path.resolve(input.gitExecutablePath), allowedCommonGitDirs: input.allowedCommonGitDirs.map((p) => path.resolve(p)), resolveSelection: input.resolveSelection, timeoutMs };
  const proposals = new Map<string, Proposal>();
  const completed = new Map<string, { confirmationToken: string; result: NoteLinkConfirmResult }>();
  let writing = false;
  let previewing = false;
  let needsInspection = false;
  const reject = (code: NoteLinkFailureCode, message: string): NoteLinkPreviewResult => ({ status: 'rejected', code, message });
  return {
    async preview(request, signal) {
      if (!record(request) || !keys(request, ['worktreeId', 'scopeId']) || !id(request.worktreeId, 4096) || !id(request.scopeId)) return reject('invalid-request', 'Choose a registered worktree and narrow note scope.');
      if (needsInspection) return reject('busy', 'A previous partial transaction needs local inspection before this workflow can be reopened.');
      if (writing || previewing) return reject('busy', 'A note-link preview or transaction is already running.');
      previewing = true;
      const copiedRequest = { worktreeId: request.worktreeId, scopeId: request.scopeId };
      try {
        const proposalId = randomBytes(24).toString('hex');
        const confirmationToken = randomBytes(32).toString('hex');
        const observation = await observe(options, copiedRequest, `exclude.note-app-${proposalId}.tmp`, new Budget(timeoutMs, signal));
        const expiresAt = Date.now() + ttl;
        const view: NoteLinkProposal = { ...observation.view, proposalId, confirmationToken, expiresAt: new Date(expiresAt).toISOString() };
        for (const [key, value] of proposals) if (value.expiresAt <= Date.now()) proposals.delete(key);
        while (proposals.size >= NOTE_LINK_LIMITS.maxPendingProposals) proposals.delete(proposals.keys().next().value!);
        proposals.set(proposalId, { request: copiedRequest, expiresAt, confirmationToken, observation, view });
        // The consumer never receives references to the main-owned proposal snapshot.
        return { status: 'ready', proposal: structuredClone(view) };
      } catch (error) { const failure = publicError(error); return reject(failure.code, failure.message); }
      finally { previewing = false; }
    },
    async confirm(request, signal) {
      const rejected = (code: NoteLinkFailureCode, message: string): NoteLinkConfirmResult => ({ status: 'rejected', code, message, actual: zeros(), recovery: [], cancellationRequested: Boolean(signal?.aborted) });
      if (!record(request) || !keys(request, ['proposalId', 'confirmationToken']) || typeof request.proposalId !== 'string' || typeof request.confirmationToken !== 'string' || !/^[a-f0-9]{48}$/.test(request.proposalId) || !/^[a-f0-9]{64}$/.test(request.confirmationToken)) return rejected('invalid-request', 'Confirm one exact preview issued by main.');
      const proposalId = request.proposalId;
      const done = completed.get(proposalId);
      if (done && done.confirmationToken === request.confirmationToken) return structuredClone(done.result);
      const proposal = proposals.get(proposalId);
      if (!proposal) return rejected('unknown-preview', 'This preview is no longer available. Create a new one.');
      if (!timingSafeEqual(Buffer.from(proposal.confirmationToken), Buffer.from(request.confirmationToken))) return rejected('confirmation-mismatch', 'The confirmation does not match the displayed preview.');
      if (needsInspection) return rejected('busy', 'A previous partial transaction needs local inspection before this workflow can be reopened.');
      if (writing || previewing) return rejected('busy', 'Another confirmed note-link transaction is running.');
      if (proposal.expiresAt <= Date.now()) { proposals.delete(proposalId); return rejected('expired-preview', 'This preview expired. Create and review a fresh one.'); }
      if (proposal.view.status === 'conflict') return rejected('conflict', 'This preview has a conflict. Existing paths will not be replaced.');
      writing = true;
      proposals.delete(proposalId);
      let result: NoteLinkConfirmResult;
      try {
        const budget = new Budget(timeoutMs, signal);
        const current = await observe(options, proposal.request, path.basename(proposal.view.paths.temporaryExclude), budget);
        if (fingerprint(current) !== fingerprint(proposal.observation)) throw new LinkError('stale-preview', 'The selected paths, registration, file identity, or exclude bytes changed. Create and review a new preview.');
        budget.check();
        if (proposal.expiresAt <= Date.now()) throw new LinkError('expired-preview', 'This preview expired during revalidation. No change was started.');
        result = await transact(options, proposal, proposalId, budget);
      } catch (error) { const failure = publicError(error); result = rejected(failure.code, failure.message); }
      finally { writing = false; }
      if (result.status === 'partial') needsInspection = true;
      completed.set(proposalId, { confirmationToken: proposal.confirmationToken, result: structuredClone(result) });
      while (completed.size > NOTE_LINK_LIMITS.maxPendingProposals) completed.delete(completed.keys().next().value!);
      return result;
    },
    cancel(proposalId) { return typeof proposalId === 'string' && proposals.delete(proposalId); },
  };
}
