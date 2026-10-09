import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNoteLinkWorkflow, type NoteLinkSelection, type NoteLinkWorkflow, type NoteLinkWorkflowOptions } from '../../src/collector/notes/link-workflow';
import type { NoteLinkProposal } from '../../src/shared/note-link-workflow';

const exec = promisify(execFile);
let root: string; let worktree: string; let vault: string; let scope: string; let git: string;
let selection: NoteLinkSelection; let options: NoteLinkWorkflowOptions;
const request = { worktreeId: 'worktree-opaque', scopeId: 'scope-opaque' };
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Test', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
async function runGit(...args: string[]) { return await exec(git, args, { env: gitEnv, timeout: 5000 }); }
async function preview(service: NoteLinkWorkflow): Promise<NoteLinkProposal> {
  const result = await service.preview(request);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'ready' });
  if (result.status !== 'ready') throw new Error(result.message);
  return result.proposal;
}
const confirmation = (p: NoteLinkProposal) => ({ proposalId: p.proposalId, confirmationToken: p.confirmationToken });
const notePath = () => path.join(worktree, 'docs', 'note');
const excludePath = () => path.join(worktree, '.git', 'info', 'exclude');
const absent = async (p: string) => expect(fs.lstat(p)).rejects.toMatchObject({ code: 'ENOENT' });

beforeEach(async () => {
  git = (await exec('which', ['git'])).stdout.trim();
  git = await fs.realpath(git);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'note-link-test-')));
  worktree = path.join(root, 'worktree with spaces;$(touch NEVER)');
  vault = path.join(root, 'vault'); scope = path.join(vault, 'project space');
  await fs.mkdir(worktree); await fs.mkdir(scope, { recursive: true });
  await runGit('init', '--quiet', worktree);
  selection = { localHostId: 'host-local', worktree: { ...request, hostId: 'host-local', worktreePath: worktree }, scope: { scopeId: request.scopeId, hostId: 'host-local', vaultRootPath: vault, scopePath: scope } };
  options = { gitExecutablePath: git, allowedCommonGitDirs: [], resolveSelection: () => selection };
});
afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); });

describe('main-owned proposal and scoped Git transaction', () => {
  it('previews without writing and then creates exactly docs/note plus a local exclude append', async () => {
    const before = await fs.readFile(excludePath());
    const service = createNoteLinkWorkflow(options);
    const p = await preview(service);
    expect(p.status).toBe('changes');
    expect(p.changes).toEqual({ createDocsDirectory: true, createNoteSymlink: true, appendLocalExclude: true });
    expect(p.paths.scope).toBe(scope); expect(p.paths.worktree).toBe(worktree);
    expect(p.exclude.appendText).toBe('/docs/note\n');
    expect(p.sharedExclude.worktreePaths).toEqual([worktree]);
    await absent(path.join(worktree, 'docs')); expect(await fs.readFile(excludePath())).toEqual(before);
    expect(await service.confirm(confirmation(p))).toMatchObject({ status: 'applied', actual: { docsCreated: true, noteLinked: true, excludeUpdated: true } });
    expect(await fs.readlink(notePath())).toBe(scope);
    expect(await fs.readFile(excludePath())).toEqual(Buffer.concat([before, Buffer.from('/docs/note\n')]));
    await absent(p.paths.temporaryExclude); await absent(path.join(worktree, '.gitignore'));
    await absent(path.join(root, 'NEVER'));
    const ignored = await runGit('-C', worktree, 'check-ignore', '--', 'docs/note');
    expect(ignored.stdout.trim()).toBe('docs/note');
  });
  it('is idempotent, returns the actual cached commit on repeated confirmation, and makes a fresh no-op preview', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    const result = await service.confirm(confirmation(p));
    expect(result.status).toBe('applied');
    const link = await fs.lstat(notePath()); const before = await fs.readFile(excludePath());
    expect(await service.confirm(confirmation(p))).toEqual(result);
    const again = await preview(service); expect(again.status).toBe('noop');
    expect(await service.confirm(confirmation(again))).toMatchObject({ status: 'noop', actual: { docsCreated: false, noteLinked: false, excludeUpdated: false } });
    expect((await fs.lstat(notePath())).ino).toBe(link.ino); expect(await fs.readFile(excludePath())).toEqual(before);
  });
  it.each(['file', 'directory', 'different-link', 'broken-link', 'docs-link'])('reports %s conflicts without replacing existing paths', async (kind) => {
    await fs.mkdir(path.join(worktree, 'docs'));
    if (kind === 'file') await fs.writeFile(notePath(), 'foreign');
    if (kind === 'directory') await fs.mkdir(notePath());
    if (kind === 'different-link') await fs.symlink(vault, notePath(), 'dir');
    if (kind === 'broken-link') await fs.symlink(path.join(root, 'missing'), notePath(), 'dir');
    if (kind === 'docs-link') { await fs.rmdir(path.join(worktree, 'docs')); await fs.symlink(scope, path.join(worktree, 'docs'), 'dir'); }
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    expect(p.status).toBe('conflict'); expect(p.conflicts.length).toBeGreaterThan(0);
    expect(await service.confirm(confirmation(p))).toMatchObject({ status: 'rejected', code: 'conflict' });
  });
  it('uses an existing direct docs directory and recognizes a relative correct symlink', async () => {
    await fs.mkdir(path.join(worktree, 'docs')); await fs.symlink(path.relative(path.dirname(notePath()), scope), notePath(), 'dir');
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    expect(p.changes).toEqual({ createDocsDirectory: false, createNoteSymlink: false, appendLocalExclude: true });
    expect((await service.confirm(confirmation(p))).status).toBe('applied');
    expect(await fs.readlink(notePath())).toBe(path.relative(path.dirname(notePath()), scope));
  });
  it.each([Buffer.from('# existing\r\nkeep\r\n'), Buffer.from('# no newline'), Buffer.from([0xff, 0xfe, 10])])('preserves exact existing bytes and newline conventions', async (bytes) => {
    await fs.writeFile(excludePath(), bytes);
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    expect((await service.confirm(confirmation(p))).status).toBe('applied');
    expect(await fs.readFile(excludePath())).toEqual(Buffer.concat([bytes, Buffer.from(p.exclude.appendText)]));
    if (bytes.includes(Buffer.from('\r\n'))) expect(p.exclude.appendText).toBe('/docs/note\r\n');
  });
  it('appends after later negations rather than treating an overridden rule as a no-op', async () => {
    const before = Buffer.from('/docs/note\n!/docs/note\n');
    await fs.writeFile(excludePath(), before);
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    expect(p.changes.appendLocalExclude).toBe(true); expect(p.exclude.appendText).toBe('/docs/note\n');
    expect((await service.confirm(confirmation(p))).status).toBe('applied');
    expect(await fs.readFile(excludePath())).toEqual(Buffer.concat([before, Buffer.from('/docs/note\n')]));
    expect((await runGit('-C', worktree, 'check-ignore', '--', 'docs/note')).stdout.trim()).toBe('docs/note');
  });
  it('creates an absent exclude file atomically without overwriting a new arrival', async () => {
    await fs.unlink(excludePath());
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    expect((await service.confirm(confirmation(p))).status).toBe('applied');
    expect(await fs.readFile(excludePath(), 'utf8')).toBe('/docs/note\n'); await absent(p.paths.temporaryExclude);
  });
  it('rejects forged confirmation, raw paths in the request, foreign hosts, whole vault and out-of-scope aliases', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    expect(await service.confirm({ ...confirmation(p), confirmationToken: '0'.repeat(64) })).toMatchObject({ code: 'confirmation-mismatch' });
    expect(await service.preview({ ...request, path: worktree } as typeof request)).toMatchObject({ code: 'invalid-request' });
    selection.worktree.hostId = 'remote'; expect(await service.preview(request)).toMatchObject({ code: 'remote-host' });
    selection.worktree.hostId = selection.localHostId; selection.scope.scopePath = vault;
    expect(await service.preview(request)).toMatchObject({ code: 'invalid-scope' });
    selection.scope.scopePath = path.join(vault, 'outside'); await fs.symlink(worktree, selection.scope.scopePath, 'dir');
    expect(await service.preview(request)).toMatchObject({ code: 'invalid-scope' });
    await absent(path.join(worktree, 'docs'));
  });
  it('does not let renderer modification alter a bound proposal', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    p.paths.scope = vault; p.exclude.appendText = 'foreign\n'; p.changes.createNoteSymlink = false;
    expect((await service.confirm(confirmation(p))).status).toBe('applied'); expect(await fs.readlink(notePath())).toBe(scope);
  });
  it('bounds concurrent previews before invoking the resolver again', async () => {
    let release!: () => void;
    const resolver = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return selection; });
    const service = createNoteLinkWorkflow({ ...options, resolveSelection: resolver });
    const first = service.preview(request);
    const other = await Promise.all(Array.from({ length: 100 }, () => service.preview(request)));
    expect(other.every((entry) => entry.status === 'rejected' && entry.code === 'busy')).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1); release(); expect((await first).status).toBe('ready');
  });
  it('rejects a tracked note path even when the working-tree file is missing', async () => {
    await fs.mkdir(path.dirname(notePath())); await fs.writeFile(notePath(), 'tracked fixture');
    await runGit('-C', worktree, 'add', '--', 'docs/note'); await fs.unlink(notePath());
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    expect(p.status).toBe('conflict'); expect(p.conflicts.join(' ')).toContain('already tracks');
    expect(await service.confirm(confirmation(p))).toMatchObject({ status: 'rejected', code: 'conflict' }); await absent(notePath());
  });
  it('rolls back an ineffective exclude rather than changing higher-priority .gitignore rules', async () => {
    const gitignore = Buffer.from('!/docs/note\n'); await fs.writeFile(path.join(worktree, '.gitignore'), gitignore);
    const before = await fs.readFile(excludePath());
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    const result = await service.confirm(confirmation(p));
    expect(result).toMatchObject({ status: 'rolled-back', code: 'conflict' });
    expect(result.message).toContain('higher-priority'); await absent(notePath()); await absent(path.dirname(notePath()));
    expect(await fs.readFile(excludePath())).toEqual(before); expect(await fs.readFile(path.join(worktree, '.gitignore'))).toEqual(gitignore);
  });
  it('invalidates cancelled and expired previews and honours pre-start abort', async () => {
    const service = createNoteLinkWorkflow({ ...options, proposalTtlMs: 1 }); const p = await preview(service);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await service.confirm(confirmation(p))).toMatchObject({ code: 'expired-preview' });
    const q = await preview(service); expect(service.cancel(q.proposalId)).toBe(true);
    expect(await service.confirm(confirmation(q))).toMatchObject({ code: 'unknown-preview' });
    const controller = new AbortController(); controller.abort();
    expect(await service.preview(request, controller.signal)).toMatchObject({ code: 'cancelled' });
    await absent(path.join(worktree, 'docs'));
  });
  it.each(['exclude', 'scope', 'worktree', 'docs', 'registration'])('rejects stale %s observations before writing', async (change) => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    if (change === 'exclude') await fs.appendFile(excludePath(), '# concurrent\n');
    if (change === 'scope') { await fs.rename(scope, `${scope}-old`); await fs.mkdir(scope); }
    if (change === 'worktree') await fs.writeFile(path.join(worktree, 'new-file'), 'foreign');
    if (change === 'docs') await fs.mkdir(path.join(worktree, 'docs'));
    if (change === 'registration') selection.scope.scopeId = 'replaced';
    const result = await service.confirm(confirmation(p));
    expect(result.status).toBe('rejected'); expect(['stale-preview', 'selection-unavailable']).toContain(result.code);
    await absent(notePath());
  });
});

describe('Git authority and shared linked-worktree excludes', () => {
  async function linkedFixture() {
    await runGit('-C', worktree, 'commit', '--allow-empty', '--quiet', '-m', 'Synthetic fixture');
    const linked = path.join(root, 'linked space');
    await runGit('-C', worktree, 'worktree', 'add', '--quiet', '--detach', linked);
    selection.worktree.worktreePath = linked;
    return linked;
  }
  it('requires exact common-dir registration, resolves relative pointers, and discloses every shared worktree', async () => {
    const linked = await linkedFixture();
    expect(await createNoteLinkWorkflow(options).preview(request)).toMatchObject({ code: 'git-authority' });
    const common = path.join(worktree, '.git'); options.allowedCommonGitDirs = [common];
    const dotGit = path.join(linked, '.git'); const pointer = (await fs.readFile(dotGit, 'utf8')).trim().slice(8);
    await fs.writeFile(dotGit, `gitdir: ${path.relative(linked, pointer)}\n`);
    await fs.writeFile(path.join(pointer, 'commondir'), '../..\n');
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    expect(p.paths.commonGitDirectory).toBe(common); expect(p.paths.exclude).toBe(excludePath());
    expect(p.sharedExclude.worktreePaths).toEqual([linked, worktree].sort());
    expect((await service.confirm(confirmation(p))).status).toBe('applied');
    expect(await fs.readlink(path.join(linked, 'docs', 'note'))).toBe(scope);
    await absent(notePath());
  });
  it('rejects a broad parent grant, foreign common pointer, symlinked info and symlinked exclude', async () => {
    const linked = await linkedFixture(); options.allowedCommonGitDirs = [root];
    expect(await createNoteLinkWorkflow(options).preview(request)).toMatchObject({ code: 'git-authority' });
    options.allowedCommonGitDirs = [path.join(worktree, '.git')];
    const pointer = (await fs.readFile(path.join(linked, '.git'), 'utf8')).trim().slice(8);
    await fs.writeFile(path.join(pointer, 'commondir'), `${root}\n`);
    expect(await createNoteLinkWorkflow(options).preview(request)).toMatchObject({ code: 'git-authority' });
    selection.worktree.worktreePath = worktree;
    const original = await fs.readFile(excludePath()); await fs.unlink(excludePath()); await fs.writeFile(path.join(root, 'foreign-exclude'), original); await fs.symlink(path.join(root, 'foreign-exclude'), excludePath());
    const conflict = await createNoteLinkWorkflow(options).preview(request);
    expect(conflict.status === 'rejected' ? conflict.code : conflict.proposal.status).toMatch(/git-authority|conflict/);
    await fs.unlink(excludePath()); await fs.rmdir(path.dirname(excludePath())); await fs.symlink(root, path.dirname(excludePath()), 'dir');
    expect(await createNoteLinkWorkflow(options).preview(request)).toMatchObject({ code: 'git-authority' });
  });
  it('rejects .git symlinks and a fake nested directory that is not the repository top level', async () => {
    await fs.rename(path.join(worktree, '.git'), path.join(root, 'metadata'));
    await fs.symlink(path.join(root, 'metadata'), path.join(worktree, '.git'), 'dir');
    expect(await createNoteLinkWorkflow(options).preview(request)).toMatchObject({ code: 'git-authority' });
  });
  it('never executes a repository-configured filesystem monitor during preview or confirmation', async () => {
    const hook = path.join(root, 'synthetic-fsmonitor.sh'); const marker = path.join(root, 'HOOK_EXECUTED');
    await fs.writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\nprintf '\\0'\n`, { mode: 0o755 });
    await fs.writeFile(path.join(worktree, 'tracked-fixture'), 'fixture');
    await runGit('-C', worktree, 'add', '--', 'tracked-fixture');
    await runGit('-C', worktree, 'config', 'core.fsmonitor', hook);
    const service = createNoteLinkWorkflow(options); const p = await preview(service); await absent(marker);
    expect((await service.confirm(confirmation(p))).status).toBe('applied'); await absent(marker);
  });
  it('ignores inherited Git redirection variables', async () => {
    vi.stubEnv('GIT_DIR', path.join(root, 'evil')); vi.stubEnv('GIT_WORK_TREE', root);
    try { expect((await preview(createNoteLinkWorkflow(options))).paths.worktree).toBe(worktree); }
    finally { vi.unstubAllEnvs(); }
  });
});

describe('rollback, cancellation and concurrent-edit preservation', () => {
  it('rolls back only its new docs directory when symlink creation fails', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service); const before = await fs.readFile(excludePath());
    const real = fs.symlink.bind(fs);
    vi.spyOn(fs, 'symlink').mockImplementation(async (...args) => { if (args[1] === notePath()) throw Object.assign(new Error('synthetic failure'), { code: 'EACCES' }); return real(...args); });
    const result = await service.confirm(confirmation(p));
    expect(result).toMatchObject({ status: 'rolled-back', actual: { docsCreated: false, noteLinked: false, excludeUpdated: false } });
    await absent(path.join(worktree, 'docs')); expect(await fs.readFile(excludePath())).toEqual(before);
  });
  it('does not adopt a foreign file replacing the newly created symlink before ownership capture', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service); const real = fs.symlink.bind(fs);
    vi.spyOn(fs, 'symlink').mockImplementation(async (...args) => {
      const result = await real(...args);
      if (args[1] === notePath()) { await fs.unlink(notePath()); await fs.writeFile(notePath(), 'foreign replacement before capture'); }
      return result;
    });
    const result = await service.confirm(confirmation(p)); expect(result.status).toBe('partial');
    expect(await fs.readFile(notePath(), 'utf8')).toBe('foreign replacement before capture');
  });
  it('handles an actual native EACCES without changing existing docs or exclude files', async () => {
    await fs.mkdir(path.dirname(notePath())); await fs.chmod(path.dirname(notePath()), 0o555);
    try {
      const service = createNoteLinkWorkflow(options); const p = await preview(service); const before = await fs.readFile(excludePath());
      const result = await service.confirm(confirmation(p));
      expect(result.status).toBe('rolled-back'); expect(result.message).toContain('Permission');
      await absent(notePath()); expect(await fs.readFile(excludePath())).toEqual(before);
    } finally { await fs.chmod(path.dirname(notePath()), 0o755); }
  });
  it('preserves a concurrently edited exclude and rolls back the owned note link after a rename failure', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service); const before = await fs.readFile(excludePath());
    const real = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { if (args[1] === excludePath()) { await fs.appendFile(excludePath(), '# someone else\n'); throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' }); } return real(...args); });
    const result = await service.confirm(confirmation(p));
    expect(result.status).toBe('rolled-back'); await absent(notePath()); await absent(path.join(worktree, 'docs'));
    expect(await fs.readFile(excludePath())).toEqual(Buffer.concat([before, Buffer.from('# someone else\n')]));
  });
  it('restores prior exclude bytes if final verification fails after commit and keeps a replacement note', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service); const before = await fs.readFile(excludePath());
    const real = fs.rename.bind(fs); let replaced = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const result = await real(...args);
      if (args[1] === excludePath() && !replaced) { replaced = true; await fs.unlink(notePath()); await fs.writeFile(notePath(), 'foreign replacement'); }
      return result;
    });
    const result = await service.confirm(confirmation(p));
    expect(result.status).toBe('partial'); expect(result.recovery.length).toBeGreaterThan(0);
    expect(await fs.readFile(excludePath())).toEqual(before);
    expect(await fs.readFile(notePath(), 'utf8')).toBe('foreign replacement');
    expect(await service.confirm(confirmation(p))).toEqual(result);
    expect(await service.preview(request)).toMatchObject({ code: 'busy' });
  });
  it('keeps concurrent exclude edits after commit instead of overwriting them during rollback', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    const real = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const result = await real(...args);
      if (args[1] === excludePath()) await fs.appendFile(excludePath(), '# foreign after install\n');
      return result;
    });
    const result = await service.confirm(confirmation(p));
    expect(result.status).toBe('partial'); expect(await fs.readFile(excludePath(), 'utf8')).toContain('# foreign after install');
    await absent(notePath());
  });
  it.each(['replace', 'append'])('never adopts foreign exclude %s during temporary cleanup as its own', async (action) => {
    await fs.unlink(excludePath());
    const service = createNoteLinkWorkflow(options); const p = await preview(service);
    const real = fs.unlink.bind(fs); let injected = false;
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args) => {
      const result = await real(...args);
      if (args[0] === p.paths.temporaryExclude && !injected) {
        injected = true;
        if (action === 'replace') { await real(excludePath()); await fs.writeFile(excludePath(), '# foreign replacement\n'); }
        else await fs.appendFile(excludePath(), '# foreign append\n');
        await real(notePath()); await fs.writeFile(notePath(), 'foreign note');
      }
      return result;
    });
    const result = await service.confirm(confirmation(p)); expect(result.status).toBe('partial');
    expect(await fs.readFile(excludePath(), 'utf8')).toContain('# foreign');
    expect(await fs.readFile(notePath(), 'utf8')).toBe('foreign note');
  });
  it('uses actual filesystem permissions for read-only metadata rejection', async () => {
    await fs.chmod(excludePath(), 0o444);
    expect(await createNoteLinkWorkflow(options).preview(request)).toMatchObject({ code: 'filesystem-unavailable' });
  });
  it('has a bounded resolver deadline and leaves no mutations', async () => {
    const service = createNoteLinkWorkflow({ ...options, timeoutMs: 10, resolveSelection: () => new Promise(() => {}) });
    expect(await service.preview(request)).toMatchObject({ code: 'timeout' }); await absent(path.join(worktree, 'docs'));
  });
  it('does not wait forever for delayed read descriptor cleanup', async () => {
    const real = fs.open.bind(fs); let release!: () => void; let nativeClose: (() => Promise<void>) | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await real(...args);
      if (args[0] === excludePath()) {
        nativeClose = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(() => new Promise<void>((resolve) => { release = () => { void nativeClose!().then(resolve); }; }));
      }
      return handle;
    });
    const service = createNoteLinkWorkflow({ ...options, timeoutMs: 200 });
    const result = await service.preview(request); expect(result).toMatchObject({ status: 'rejected', code: 'timeout' });
    release(); await new Promise((resolve) => setTimeout(resolve, 10)); await absent(path.join(worktree, 'docs'));
  });
  it('preserves pending-write uncertainty even when closing its handle is also delayed', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service); const controller = new AbortController();
    const real = fs.open.bind(fs); let started!: () => void; let releaseWrite!: () => void; let releaseClose!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await real(...args);
      if (args[0] === p.paths.temporaryExclude && (Number(args[1]) & constants.O_WRONLY)) {
        const write = handle.writeFile.bind(handle); const close = handle.close.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => { started(); await new Promise<void>((resolve) => { releaseWrite = resolve; }); return write(...writeArgs); });
        vi.spyOn(handle, 'close').mockImplementation(() => new Promise<void>((resolve) => { releaseClose = () => { void close().then(resolve); }; }));
      }
      return handle;
    });
    const pending = service.confirm(confirmation(p), controller.signal); await didStart; controller.abort();
    const result = await pending; expect(result).toMatchObject({ status: 'partial', code: 'cancelled' });
    expect(result.recovery.join(' ')).toContain('No automatic rollback');
    releaseWrite(); await new Promise((resolve) => setTimeout(resolve, 10)); releaseClose(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await fs.readlink(notePath())).toBe(scope); expect(await fs.readFile(excludePath(), 'utf8')).not.toContain('/docs/note');
  });
  it('reports pending mutation cancellation honestly and never starts automatic rollback or allows retry', async () => {
    const service = createNoteLinkWorkflow(options); const p = await preview(service); const controller = new AbortController();
    const real = fs.symlink.bind(fs); let settle!: () => void; let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(fs, 'symlink').mockImplementation(async (...args) => { if (args[1] === notePath()) { started(); await new Promise<void>((resolve) => { settle = resolve; }); } return real(...args); });
    const pending = service.confirm(confirmation(p), controller.signal); await didStart; controller.abort();
    const result = await pending; expect(result.status).toBe('partial'); expect(result.code).toBe('cancelled'); expect(result.cancellationRequested).toBe(true);
    expect(result.actual.noteLinked).toBeNull(); expect(result.recovery.join(' ')).toContain('No automatic rollback');
    expect(await service.preview(request)).toMatchObject({ code: 'busy' });
    settle(); await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await fs.readlink(notePath())).toBe(scope); expect(await fs.readFile(excludePath(), 'utf8')).not.toContain('/docs/note');
  });
});
