import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapWorktreesToNotes, NOTE_MAPPING_LIMITS } from '../../src/collector/notes';
import { parseOrcaResponse } from '../../src/collector/orca/parser';
import type { AllowedNoteScope, NoteMappingRequest, NoteWorktree } from '../../src/collector/notes';

let root: string;
let vault: string;
let project: string;
let worktree: string;
let request: NoteMappingRequest;

beforeEach(async () => {
  // macOS tmpdir can be /var/... while realpath returns /private/var/....
  // Canonicalize this trusted fixture root, not arbitrary product inputs.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'note-mapping-test-')));
  vault = path.join(root, 'vault');
  project = path.join(vault, 'project');
  worktree = path.join(root, 'worktree');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(path.join(worktree, 'docs'), { recursive: true });
  await fs.writeFile(path.join(project, 'dag.json'), '{"synthetic":true}\n');
  await fs.symlink(project, path.join(worktree, 'docs', 'note'), 'dir');
  request = {
    localHostId: 'test-host',
    worktrees: [{ worktreeId: 'worktree-a', hostId: 'test-host', worktreePath: worktree }],
    scopes: [{ scopeId: 'project-scope', hostId: 'test-host', vaultRootPath: vault, scopePath: project, dagRelativePaths: ['dag.json'] }],
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Only this test's unique temporary root is removed. Symlinks are not followed by rm.
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function scope(): AllowedNoteScope { return request.scopes[0]!; }
function row(): NoteWorktree { return request.worktrees[0]!; }
async function noteTarget(target: string): Promise<void> {
  await fs.unlink(path.join(worktree, 'docs', 'note'));
  await fs.symlink(target, path.join(worktree, 'docs', 'note'), 'dir');
}
async function reason(expected: string): Promise<void> {
  const result = await mapWorktreesToNotes(request);
  expect(result.status).toBe('partial');
  expect(result.mappings[0]).toMatchObject({ state: 'unresolved', reason: expected });
  expect(result.dags).toEqual([]);
}

describe('bounded read-only mapping and canonical identity', () => {
  it('resolves explicit read registration without creating a missing docs/note link',async()=>{
    await fs.unlink(path.join(worktree,'docs','note'));row().registeredScopeId='project-scope';row().selectedDagRelativePath='dag.json';
    const before=await fs.stat(path.join(project,'dag.json')),result=await mapWorktreesToNotes(request);
    expect(result.mappings[0]).toMatchObject({state:'resolved',registration:'explicit-read-only',canonicalDagPath:path.join(project,'dag.json')});
    await expect(fs.lstat(path.join(worktree,'docs','note'))).rejects.toMatchObject({code:'ENOENT'});
    expect((await fs.stat(path.join(project,'dag.json'))).mtimeMs).toBe(before.mtimeMs);
  });
  it('does not overwrite an existing unrelated link when an explicit read registration is used',async()=>{
    const other=path.join(root,'other');await fs.mkdir(other);await noteTarget(other);
    row().registeredScopeId='project-scope';row().selectedDagRelativePath='dag.json';
    expect((await mapWorktreesToNotes(request)).mappings[0].state).toBe('resolved');expect(await fs.readlink(path.join(worktree,'docs','note'))).toBe(other);
  });
  it('rejects an unknown scope and missing/outside exact DAG selection',async()=>{
    row().registeredScopeId='foreign';row().selectedDagRelativePath='dag.json';await reason('no-allowed-scope');
    row().registeredScopeId='project-scope';row().selectedDagRelativePath='../outside';expect((await mapWorktreesToNotes(request)).status).toBe('invalid-request');
    delete row().selectedDagRelativePath;expect((await mapWorktreesToNotes(request)).status).toBe('invalid-request');
  });
  it('maps an explicit project note to a registered regular DAG file', async () => {
    const result = await mapWorktreesToNotes(request);
    expect(result.status).toBe('complete');
    expect(result.scopeIssues).toEqual([]);
    expect(result.mappings[0]).toMatchObject({ state: 'resolved', worktreeId: 'worktree-a', scopeId: 'project-scope', canonicalWorktreePath: worktree, canonicalNotePath: project, canonicalDagPath: path.join(project, 'dag.json') });
    expect(result.dags[0]).toMatchObject({ hostId: 'test-host', canonicalDagPath: path.join(project, 'dag.json'), worktreeIds: ['worktree-a'] });
    expect(result.dags[0]!.dagId).toMatch(/^dag:[a-f0-9]{64}$/);
    expect(result.filesystemOperations).toBeGreaterThan(0);
  });

  it('uses the same canonical identity through a simulated macOS temp-parent alias', async () => {
    const original = await mapWorktreesToNotes(request);
    const alias = path.join(root, 'temp-parent-alias');
    await fs.symlink(root, alias, 'dir');
    const aliasPath = (canonical: string) => path.join(alias, path.relative(root, canonical));
    row().worktreePath = aliasPath(worktree);
    scope().vaultRootPath = aliasPath(vault);
    scope().scopePath = aliasPath(project);
    const throughAlias = await mapWorktreesToNotes(request);
    expect(throughAlias.status).toBe('complete');
    expect(throughAlias.dags).toEqual(original.dags);
    expect(throughAlias.mappings[0]).toMatchObject({ canonicalWorktreePath: worktree, canonicalNotePath: project, canonicalDagPath: path.join(project, 'dag.json') });
  });

  it('does not scan directories, read DAG bytes, run commands, or write anything', async () => {
    const before = await fs.readFile(path.join(project, 'dag.json'));
    const link = await fs.readlink(path.join(worktree, 'docs', 'note'));
    const reads = vi.spyOn(fs, 'readFile');
    const scans = vi.spyOn(fs, 'readdir');
    const writes = vi.spyOn(fs, 'writeFile');
    const symlinks = vi.spyOn(fs, 'symlink');
    expect((await mapWorktreesToNotes(request)).status).toBe('complete');
    expect(reads).not.toHaveBeenCalled();
    expect(scans).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(symlinks).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await fs.readFile(path.join(project, 'dag.json'))).toEqual(before);
    expect(await fs.readlink(path.join(worktree, 'docs', 'note'))).toBe(link);
  });

  it('deduplicates shared DAGs and sorts attached worktree identities', async () => {
    const second = path.join(root, 'second-worktree');
    await fs.mkdir(path.join(second, 'docs'), { recursive: true });
    await fs.symlink(project, path.join(second, 'docs', 'note'), 'dir');
    request.worktrees = [{ worktreeId: 'worktree-z', hostId: 'test-host', worktreePath: second }, row()];
    const result = await mapWorktreesToNotes(request);
    expect(result.mappings).toHaveLength(2);
    expect(result.dags).toHaveLength(1);
    expect(result.dags[0]!.worktreeIds).toEqual(['worktree-a', 'worktree-z']);
    expect(result.mappings.every((mapping) => mapping.state === 'resolved' && mapping.dagId === result.dags[0]!.dagId)).toBe(true);
  });

  it('keeps different registered DAGs distinct even with the same repository field', async () => {
    await fs.writeFile(path.join(project, 'other.json'), '{}');
    scope().dagRelativePaths = ['dag.json', 'other.json'];
    request.worktrees = [
      { ...row(), worktreeId: 'one', selectedDagRelativePath: 'dag.json', repoId: 'same-repo' },
      { ...row(), worktreeId: 'two', selectedDagRelativePath: 'other.json', repoId: 'same-repo' },
    ] as (NoteWorktree & { repoId: string })[];
    const result = await mapWorktreesToNotes(request);
    expect(result.dags).toHaveLength(2);
    expect(result.dags[0]!.dagId).not.toBe(result.dags[1]!.dagId);
  });

  it('derives a stable identity from canonical path and host only', async () => {
    const first = await mapWorktreesToNotes(request);
    row().worktreeId = 'renamed';
    scope().scopeId = 'scope-renamed';
    const alias = path.join(vault, 'project-alias');
    await fs.symlink(project, alias, 'dir');
    scope().scopePath = alias;
    const second = await mapWorktreesToNotes(request);
    expect(first.dags[0]!.dagId).toBe(second.dags[0]!.dagId);
    const expected = createHash('sha256').update(JSON.stringify(['note-dag-v1', 'test-host', path.join(project, 'dag.json')])).digest('hex');
    expect(second.dags[0]!.dagId).toBe(`dag:${expected}`);
    request.localHostId = row().hostId = scope().hostId = 'other-host';
    expect((await mapWorktreesToNotes(request)).dags[0]!.dagId).not.toBe(first.dags[0]!.dagId);
  });

  it('deduplicates registered DAG symlink aliases to the same canonical file', async () => {
    await fs.symlink('dag.json', path.join(project, 'alias.json'));
    scope().dagRelativePaths = ['dag.json', 'alias.json', 'dag.json'];
    expect((await mapWorktreesToNotes(request)).dags).toHaveLength(1);
  });

  it('permits an explicitly registered nested DAG without enumerating its directory', async () => {
    await fs.mkdir(path.join(project, 'nested'));
    await fs.writeFile(path.join(project, 'nested', 'flow.json'), '{}');
    scope().dagRelativePaths = ['nested/flow.json'];
    expect((await mapWorktreesToNotes(request)).dags[0]!.canonicalDagPath).toBe(path.join(project, 'nested', 'flow.json'));
  });

  it('permits a note directory without a symlink when explicitly scoped inside its vault', async () => {
    await fs.unlink(path.join(worktree, 'docs', 'note'));
    project = path.join(worktree, 'docs', 'note');
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'dag.json'), '{}');
    scope().vaultRootPath = path.join(worktree, 'docs');
    scope().scopePath = project;
    expect((await mapWorktreesToNotes(request)).status).toBe('complete');
  });
});

describe('explicit missing, broken and unresolvable evidence', () => {
  it('keeps missing note unknown without guessing an ancestor or repository match', async () => {
    await fs.unlink(path.join(worktree, 'docs', 'note'));
    await reason('note-missing');
  });
  it('reports a dangling note symlink', async () => {
    await noteTarget(path.join(project, 'does-not-exist'));
    await reason('note-broken-link');
  });
  it('reports missing docs independently', async () => {
    await fs.rm(path.join(worktree, 'docs'), { recursive: true });
    await reason('docs-unavailable');
  });
  it('reports a missing worktree independently', async () => {
    row().worktreePath = path.join(root, 'missing-worktree');
    await reason('worktree-unavailable');
  });
  it('rejects a file where a worktree directory is expected', async () => {
    row().worktreePath = path.join(project, 'dag.json');
    await reason('worktree-not-directory');
  });
  it('rejects a file where docs should be a directory', async () => {
    await fs.rm(path.join(worktree, 'docs'), { recursive: true });
    await fs.writeFile(path.join(worktree, 'docs'), 'file');
    await reason('docs-not-directory');
  });
  it('rejects a file where the note directory is expected', async () => {
    await noteTarget(path.join(project, 'dag.json'));
    await reason('note-not-directory');
  });
  it('rejects a directory registered as a DAG', async () => {
    await fs.mkdir(path.join(project, 'directory-dag'));
    scope().dagRelativePaths = ['directory-dag'];
    await reason('dag-not-file');
  });
  it('does not invent a DAG when none is registered', async () => {
    scope().dagRelativePaths = [];
    await reason('dag-not-registered');
  });
  it('reports a missing registered DAG', async () => {
    scope().dagRelativePaths = ['missing.json'];
    await reason('dag-unavailable');
  });
  it('reports a dangling registered DAG without reading the link target', async () => {
    await fs.symlink('missing.json', path.join(project, 'broken.json'));
    scope().dagRelativePaths = ['broken.json'];
    const result = await mapWorktreesToNotes(request);
    expect(result.mappings[0]).toMatchObject({ reason: 'dag-unavailable', errorCode: 'ENOENT' });
  });
  it('reports a self-referential note symlink with a safe loop code', async () => {
    await noteTarget('note');
    const result = await mapWorktreesToNotes(request);
    expect(result.mappings[0]).toMatchObject({ reason: 'note-unavailable', errorCode: 'ELOOP' });
  });
  it('reports a two-link DAG cycle with a safe loop code', async () => {
    await fs.symlink('loop-b', path.join(project, 'loop-a'));
    await fs.symlink('loop-a', path.join(project, 'loop-b'));
    scope().dagRelativePaths = ['loop-a'];
    const result = await mapWorktreesToNotes(request);
    expect(result.mappings[0]).toMatchObject({ reason: 'dag-unavailable', errorCode: 'ELOOP' });
  });
  it('reports actual unreadable DAG permission without returning raw paths or error messages', async () => {
    const dagPath = path.join(project, 'dag.json');
    await fs.chmod(dagPath, 0);
    try {
      const result = await mapWorktreesToNotes(request);
      expect(result.mappings[0]).toMatchObject({ state: 'unresolved', reason: 'dag-unavailable', errorCode: 'EACCES' });
      expect(JSON.stringify(result.mappings)).not.toContain(root);
    } finally { await fs.chmod(dagPath, 0o600); }
  });
});

describe('vault, scope and canonical containment', () => {
  it('rejects selecting the entire vault as the scope without probing it', async () => {
    scope().scopePath = vault;
    const reads = vi.spyOn(fs, 'lstat');
    const result = await mapWorktreesToNotes(request);
    expect(result.scopeIssues[0]).toMatchObject({ reason: 'scope-is-vault-root' });
    expect(result.mappings[0]).toMatchObject({ reason: 'no-allowed-scope' });
    expect(reads).not.toHaveBeenCalled();
  });
  it('rejects a vault-root symlink alias as a project scope', async () => {
    const alias = path.join(vault, 'whole-vault');
    await fs.symlink(vault, alias, 'dir');
    scope().scopePath = alias;
    expect((await mapWorktreesToNotes(request)).scopeIssues[0]).toMatchObject({ reason: 'scope-is-vault-root' });
  });
  it('rejects docs/note pointing to the whole vault including through an alias', async () => {
    const alias = path.join(root, 'vault-alias');
    await fs.symlink(vault, alias, 'dir');
    await noteTarget(alias);
    await reason('vault-root-note');
  });
  it('rejects scope paths lexically outside their explicitly configured vault', async () => {
    scope().scopePath = root;
    expect((await mapWorktreesToNotes(request)).scopeIssues[0]).toMatchObject({ reason: 'scope-outside-vault' });
  });
  it('rejects a scope symlink that canonically escapes its vault', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const escape = path.join(vault, 'escape');
    await fs.symlink(outside, escape, 'dir');
    scope().scopePath = escape;
    expect((await mapWorktreesToNotes(request)).scopeIssues[0]).toMatchObject({ reason: 'scope-outside-vault' });
  });
  it('does not confuse a shared prefix with project containment', async () => {
    const sibling = path.join(vault, 'project-secret');
    await fs.mkdir(sibling);
    await noteTarget(sibling);
    await reason('note-outside-scope');
  });
  it('rejects a note symlink pointing outside every allowed scope', async () => {
    await noteTarget(root);
    await reason('note-outside-scope');
  });
  it('rejects a docs symlink outside the worktree before looking up docs/note', async () => {
    await fs.rm(path.join(worktree, 'docs'), { recursive: true });
    await fs.symlink(project, path.join(worktree, 'docs'), 'dir');
    await reason('docs-outside-worktree');
  });
  it('rejects a DAG symlink outside the project scope', async () => {
    await fs.writeFile(path.join(vault, 'outside.json'), '{}');
    await fs.symlink('../outside.json', path.join(project, 'escape.json'));
    scope().dagRelativePaths = ['escape.json'];
    await reason('dag-outside-scope');
  });
  it('checks an intermediate DAG symlink before attempting metadata under an outside directory', async () => {
    await fs.mkdir(path.join(root, 'outside'));
    await fs.writeFile(path.join(root, 'outside', 'dag.json'), '{}');
    await fs.symlink(path.join(root, 'outside'), path.join(project, 'escape'), 'dir');
    scope().dagRelativePaths = ['escape/dag.json'];
    const lstat = vi.spyOn(fs, 'lstat');
    await reason('dag-outside-scope');
    expect(lstat.mock.calls.map(([target]) => target)).not.toContain(path.join(project, 'escape', 'dag.json'));
    expect(lstat.mock.calls.map(([target]) => target)).not.toContain(path.join(root, 'outside', 'dag.json'));
  });
  it('does not inspect registered files outside a narrower note directory', async () => {
    const narrow = path.join(project, 'narrow');
    await fs.mkdir(narrow);
    await fs.writeFile(path.join(narrow, 'dag.json'), '{}');
    await noteTarget(narrow);
    scope().dagRelativePaths = ['dag.json', 'narrow/dag.json'];
    const lstat = vi.spyOn(fs, 'lstat');
    expect((await mapWorktreesToNotes(request)).dags[0]!.canonicalDagPath).toBe(path.join(narrow, 'dag.json'));
    expect(lstat.mock.calls.map(([target]) => target)).not.toContain(path.join(project, 'dag.json'));
  });
  it('rejects a selected DAG outside the narrower note without probing the file', async () => {
    const narrow = path.join(project, 'narrow');
    await fs.mkdir(narrow);
    await noteTarget(narrow);
    row().selectedDagRelativePath = 'dag.json';
    await reason('dag-outside-note');
  });
  it('rejects a DAG symlink escaping the note but remaining in its project', async () => {
    const narrow = path.join(project, 'narrow');
    await fs.mkdir(narrow);
    await fs.symlink('../dag.json', path.join(narrow, 'escape.json'));
    await noteTarget(narrow);
    scope().dagRelativePaths = ['narrow/escape.json'];
    await reason('dag-outside-note');
  });
  it('leaves overlapping project scope matches ambiguous rather than choosing a parent', async () => {
    const nested = path.join(project, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'dag.json'), '{}');
    await noteTarget(nested);
    request.scopes = [scope(), { ...scope(), scopeId: 'nested', scopePath: nested }];
    await reason('ambiguous-scope');
  });
});

describe('multiple registered DAGs and explicit selection', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(project, 'other.json'), '{}');
    scope().dagRelativePaths = ['dag.json', 'other.json'];
  });
  it('reports multiple distinct DAGs as ambiguous', async () => { await reason('ambiguous-dag'); });
  it('honors an exact registered selection', async () => {
    row().selectedDagRelativePath = 'other.json';
    expect((await mapWorktreesToNotes(request)).dags[0]!.canonicalDagPath).toBe(path.join(project, 'other.json'));
  });
  it('rejects an unregistered selection instead of silently falling back', async () => {
    row().selectedDagRelativePath = 'guess.json';
    await reason('invalid-dag-selection');
  });
  it('does not fall back to a valid file when another unselected registration is broken', async () => {
    await fs.unlink(path.join(project, 'other.json'));
    await reason('dag-unavailable');
    row().selectedDagRelativePath = 'dag.json';
    expect((await mapWorktreesToNotes(request)).status).toBe('complete');
  });
});

describe('host boundary, bounded inputs, cancellation and safe failures', () => {
  it('never resolves a remote-host worktree locally even when its path exists', async () => {
    row().hostId = 'remote-host';
    const lstat = vi.spyOn(fs, 'lstat');
    const realpath = vi.spyOn(fs, 'realpath');
    const access = vi.spyOn(fs, 'access');
    await reason('remote-host');
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });
  it('ignores remote scope paths without local filesystem access', async () => {
    scope().hostId = 'remote-host';
    const lstat = vi.spyOn(fs, 'lstat');
    await reason('no-allowed-scope');
    expect(lstat).not.toHaveBeenCalled();
  });
  it('returns observed empty input without touching configured paths', async () => {
    request.worktrees = [];
    const result = await mapWorktreesToNotes(request);
    expect(result).toMatchObject({ status: 'complete', mappings: [], dags: [], filesystemOperations: 0 });
  });
  it('rejects traversal, absolute and malformed registered paths before filesystem calls', async () => {
    for (const invalid of ['../dag.json', '/tmp/dag.json', './dag.json', 'a//b', 'a/../b', 'a\\b', '', 'nul\0file']) {
      scope().dagRelativePaths = [invalid];
      expect(await mapWorktreesToNotes(request)).toMatchObject({ status: 'invalid-request', inputError: 'invalid-input', filesystemOperations: 0 });
    }
  });
  it('rejects sparse DAG arrays', async () => {
    scope().dagRelativePaths = Array(1) as string[];
    expect(await mapWorktreesToNotes(request)).toMatchObject({ status: 'invalid-request', inputError: 'invalid-input' });
  });
  it('rejects oversized sparse DAG arrays before touching any element getter', async () => {
    const registrations = new Array<string>(1_000_000);
    const elementRead = vi.fn(() => { throw new Error('oversized registration element was touched'); });
    Object.defineProperty(registrations, '0', { get: elementRead });
    scope().dagRelativePaths = registrations;
    expect(await mapWorktreesToNotes(request)).toMatchObject({ status: 'invalid-request', inputError: 'input-limit', filesystemOperations: 0 });
    expect(elementRead).not.toHaveBeenCalled();
  });
  it('maps a parser-accepted 289-character repo::path worktree identity unchanged', async () => {
    const parent = path.join(root, 'id-boundary');
    const longPath = path.join(parent, 'w'.repeat(283 - parent.length - 1));
    const worktreeId = `repo::${longPath}`;
    expect(worktreeId).toHaveLength(289);
    await fs.mkdir(path.join(longPath, 'docs'), { recursive: true });
    await fs.symlink(project, path.join(longPath, 'docs', 'note'), 'dir');
    const parsed = parseOrcaResponse('worktrees', JSON.stringify({
      ok: true, result: { worktrees: [{ id: worktreeId, hostId: 'test-host', path: longPath }] },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected valid synthetic Orca record');
    const record = parsed.value.data.records[0]!;
    request.worktrees = [row(), { worktreeId: record.id, hostId: record.identity.hostId!, worktreePath: record.path! }];
    const result = await mapWorktreesToNotes(request);
    expect(result.status).toBe('complete');
    expect(result.mappings[1]).toMatchObject({ state: 'resolved', worktreeId });
    expect(result.dags[0]!.worktreeIds).toContain(worktreeId);
    expect(result.dags[0]!.worktreeIds).toContain('worktree-a');
  });
  it('preserves the parser maximum 4096-character worktree identity in remote mapping state', async () => {
    const worktreeId = `repo::/${'segment/'.repeat(600)}`.slice(0, NOTE_MAPPING_LIMITS.worktreeIdCharacters);
    const parsed = parseOrcaResponse('worktrees', JSON.stringify({
      ok: true, result: { worktrees: [{ id: worktreeId, hostId: 'remote-host', path: '/remote/worktree' }] },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected valid synthetic Orca record');
    const record = parsed.value.data.records[0]!;
    request.worktrees = [{ worktreeId: record.id, hostId: record.identity.hostId!, worktreePath: record.path! }];
    const result = await mapWorktreesToNotes(request);
    expect(result).toMatchObject({ status: 'partial', filesystemOperations: 0 });
    expect(result.mappings[0]).toMatchObject({ state: 'unresolved', reason: 'remote-host', worktreeId });
  });
  it('rejects over-limit worktree identities without reading any filesystem path', async () => {
    row().worktreeId = 'w'.repeat(NOTE_MAPPING_LIMITS.worktreeIdCharacters + 1);
    expect(await mapWorktreesToNotes(request)).toMatchObject({ status: 'invalid-request', inputError: 'invalid-input', filesystemOperations: 0 });
  });
  it('rejects duplicate worktree identities without accidentally merging them', async () => {
    request.worktrees = [row(), { ...row() }];
    expect(await mapWorktreesToNotes(request)).toMatchObject({ status: 'invalid-request', inputError: 'duplicate-identity', filesystemOperations: 0 });
  });
  it('bounds registrations, input rows and timeout before accessing files', async () => {
    scope().dagRelativePaths = Array.from({ length: NOTE_MAPPING_LIMITS.dagsPerScope + 1 }, (_, i) => `dag-${i}.json`);
    expect(await mapWorktreesToNotes(request)).toMatchObject({ status: 'invalid-request', inputError: 'input-limit' });
    scope().dagRelativePaths = ['dag.json'];
    request.timeoutMs = NOTE_MAPPING_LIMITS.maximumTimeoutMs + 1;
    expect(await mapWorktreesToNotes(request)).toMatchObject({ status: 'invalid-request', inputError: 'invalid-input' });
    request.timeoutMs = 5_000;
    request.worktrees = Array.from({ length: NOTE_MAPPING_LIMITS.worktrees + 1 }, (_, i) => ({ ...row(), worktreeId: `wt-${i}` }));
    expect(await mapWorktreesToNotes(request)).toMatchObject({ status: 'invalid-request', inputError: 'input-limit' });
  });
  it('cancels before starting without any filesystem calls', async () => {
    const controller = new AbortController();
    controller.abort();
    request.signal = controller.signal;
    const result = await mapWorktreesToNotes(request);
    expect(result.filesystemOperations).toBe(0);
    expect(result.mappings[0]).toMatchObject({ reason: 'aborted' });
  });
  it('stops scheduling reads when cancelled during an asynchronous operation', async () => {
    const controller = new AbortController();
    request.signal = controller.signal;
    const original = fs.lstat;
    const lstat = vi.spyOn(fs, 'lstat').mockImplementationOnce(async (...args) => {
      controller.abort();
      return original(...args);
    });
    const result = await mapWorktreesToNotes(request);
    expect(result.mappings[0]).toMatchObject({ reason: 'aborted' });
    expect(lstat).toHaveBeenCalledTimes(1);
  });
  it('bounds a nonsettling asynchronous operation by the whole-request deadline', async () => {
    request.timeoutMs = 10;
    const lstat = vi.spyOn(fs, 'lstat').mockImplementationOnce(() => new Promise(() => {}));
    const result = await mapWorktreesToNotes(request);
    expect(result.mappings[0]).toMatchObject({ reason: 'timeout' });
    expect(result.scopeIssues[0]).toMatchObject({ reason: 'timeout' });
    expect(lstat).toHaveBeenCalledTimes(1);
  });
  it('never returns exception messages or arbitrary system codes', async () => {
    vi.spyOn(fs, 'access').mockRejectedValueOnce(Object.assign(new Error('private filesystem detail'), { code: 'SECRET_CODE', path: '/private/place' }));
    const result = await mapWorktreesToNotes(request);
    expect(result.scopeIssues[0]).toMatchObject({ reason: 'vault-unavailable', errorCode: 'UNKNOWN' });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('copies configuration before awaiting so mutation cannot expand allowed scope', async () => {
    const original = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementationOnce(async (...args) => {
      scope().scopePath = vault;
      scope().dagRelativePaths = ['other.json'];
      return original(...args);
    });
    expect((await mapWorktreesToNotes(request)).status).toBe('complete');
  });
  it('rejects a note path that changes between resolution and the final stability check', async () => {
    const original = fs.realpath;
    const notePath = path.join(worktree, 'docs', 'note');
    let seen = 0;
    vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
      if (args[0] === notePath && ++seen === 2) await noteTarget(vault);
      return original(...args);
    });
    await reason('path-changed');
  });
  it('treats remote Windows paths as opaque and never resolves them on Linux', async () => {
    row().hostId = 'remote-windows';
    row().worktreePath = 'C:\\workspaces\\demo';
    const result = await mapWorktreesToNotes(request);
    expect(result.mappings[0]).toMatchObject({ reason: 'remote-host' });
    expect(result.filesystemOperations).toBe(0);
  });
  it('caps actual metadata calls across a large batch without converting failures into empty success', async () => {
    request.timeoutMs = 30_000;
    request.worktrees = Array.from({ length: NOTE_MAPPING_LIMITS.worktrees }, (_, i) => ({ ...row(), worktreeId: `worktree-${i}` }));
    const result = await mapWorktreesToNotes(request);
    expect(result.status).toBe('partial');
    expect(result.filesystemOperations).toBe(NOTE_MAPPING_LIMITS.filesystemOperations);
    expect(result.mappings.some((mapping) => mapping.state === 'unresolved' && mapping.reason === 'operation-limit')).toBe(true);
    expect(result.mappings.some((mapping) => mapping.state === 'resolved')).toBe(true);
    expect(result.dags).toHaveLength(1);
  });
  it('reports a long actual symlink chain as unresolved rather than retrying indefinitely', async () => {
    for (let index = 0; index < 50; index += 1) {
      await fs.symlink(index === 49 ? project : `chain-${index + 1}`, path.join(root, `chain-${index}`));
    }
    await noteTarget(path.join(root, 'chain-0'));
    const result = await mapWorktreesToNotes(request);
    expect(result.mappings[0]).toMatchObject({ reason: 'note-unavailable', errorCode: 'ELOOP' });
    expect(result.filesystemOperations).toBeLessThan(50);
  });
  it('does not auto-walk up from a nested note to find a parent registered DAG', async () => {
    const nested = path.join(project, 'notes');
    await fs.mkdir(nested);
    await noteTarget(nested);
    await reason('dag-not-registered');
  });
  it('detects the scope symlink changing while its registered DAG is observed', async () => {
    const alias = path.join(vault, 'alias');
    const other = path.join(vault, 'other');
    await fs.mkdir(other);
    await fs.symlink(project, alias, 'dir');
    scope().scopePath = alias;
    const original = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (...args) => {
      if (args[0] === path.join(project, 'dag.json')) {
        await fs.unlink(alias);
        await fs.symlink(other, alias, 'dir');
      }
      return original(...args);
    });
    await reason('path-changed');
  });

});
