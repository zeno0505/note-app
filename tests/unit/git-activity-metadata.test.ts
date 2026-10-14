import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir, rename, symlink, link, chmod, stat, copyFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  inspectGitActivityMetadata, validateGitActivityDescriptor, readGitActivityReferences,
  gitActivityObjectRevision, parseGitActivityDescriptor, type GitActivityDescriptor,
} from '../../src/summary/reading/git-activity-metadata';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const signal = () => new AbortController().signal;
const authority = async () => {};
let root: string;
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2026-01-02T03:04:05+09:00', GIT_COMMITTER_DATE: '2026-01-02T03:04:05+09:00',
  } }).trim();
}
async function fixture(name = 'repo') {
  const worktree = path.join(root, name);
  git(root, ['init', '-b', 'synthetic', worktree]);
  git(worktree, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic fixture']);
  const common = path.join(worktree, '.git');
  const sha = git(worktree, ['rev-parse', 'HEAD']);
  const tree = git(worktree, ['rev-parse', 'HEAD^{tree}']);
  const linked = path.join(root, `${name}-linked`);
  git(worktree, ['worktree', 'add', '--detach', linked, sha]);
  return { worktree, common, linked, sha, tree };
}
async function inspect(worktree: string, common: string) { return inspectGitActivityMetadata(worktree, [common], signal()); }
async function read(descriptor: GitActivityDescriptor, refs: string[], validate = authority) { return readGitActivityReferences(descriptor, refs, signal(), validate); }
function object(type: 'commit' | 'blob' | 'tag', content: string) {
  const raw = Buffer.from(`${type} ${Buffer.byteLength(content)}\0${content}`);
  return { sha: createHash('sha1').update(raw).digest('hex'), bytes: deflateSync(raw) };
}
async function put(common: string, value: ReturnType<typeof object>) {
  const bucket = path.join(common, 'objects', value.sha.slice(0, 2));
  await mkdir(bucket, { recursive: true });
  await writeFile(path.join(bucket, value.sha.slice(2)), value.bytes);
  return value.sha;
}
function collision(prefix: string, type: 'commit' | 'blob', tree = '') {
  for (let n = 0; n < 2_000_000; n++) {
    const body = type === 'blob' ? `Synthetic collision ${n}` : `tree ${tree}\nauthor Synthetic <synthetic@example.invalid> 1767319445 +0900\ncommitter Synthetic <synthetic@example.invalid> 1767319445 +0900\n\nSynthetic collision ${n}\n`;
    // Compress only the winner. Hashing synthetic bodies never launches a process.
    const raw = Buffer.from(`${type} ${Buffer.byteLength(body)}\0${body}`);
    const sha = createHash('sha1').update(raw).digest('hex');
    if (sha.startsWith(prefix)) return { sha, bytes: deflateSync(raw) };
  }
  throw Error('Synthetic collision search exhausted');
}
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'git-activity-metadata-'))); vi.mocked(spawn).mockClear(); });
afterEach(async () => { vi.unstubAllEnvs(); vi.mocked(spawn).mockClear(); await rm(root, { recursive: true, force: true }); });

describe('bounded declared Git activity metadata', () => {
  it('returns the same explicit commit identity/time from ordinary and real linked worktrees', async () => {
    const f = await fixture();
    const ordinary = await inspect(f.worktree, f.common), linked = await inspect(f.linked, f.common);
    expect(linked.kind).toBe('linked');
    expect(linked.identities.commonDirectory).toEqual(ordinary.identities.commonDirectory);
    expect(Object.keys(linked.pointerHashes).sort()).toEqual(['commondir', 'dotGit', 'gitdir']);
    expect(spawn).not.toHaveBeenCalled();
    const expected = [{ declaredReference: f.sha, status: 'resolved', fullSha: f.sha, at: '2026-01-01T18:04:05.000Z' }];
    expect(await read(ordinary, [f.sha])).toEqual(expected);
    expect(await read(linked, [f.sha])).toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain('Synthetic fixture');
  });
  it('keeps linked metadata authority valid across a normal detached commit that atomically replaces HEAD', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const oldHead = await stat(path.join(descriptor.gitDirectory, 'HEAD'));
    git(f.linked, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'Next synthetic commit']);
    const next = git(f.linked, ['rev-parse', 'HEAD']);
    expect((await stat(path.join(descriptor.gitDirectory, 'HEAD'))).ino).not.toBe(oldHead.ino);
    await expect(validateGitActivityDescriptor(descriptor, signal())).resolves.toBeUndefined();
    expect((await read(descriptor, [f.sha, next])).map(row => row.status)).toEqual(['resolved', 'resolved']);
  });
  it('checks mutable HEAD safety each time while retiring an in-flight HEAD replacement', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const head = path.join(descriptor.gitDirectory, 'HEAD');
    let replaced = false;
    await expect(read(descriptor, [f.sha], async () => {
      if (vi.mocked(spawn).mock.calls.length && !replaced) {
        replaced = true; await writeFile(head + '.fixture', `${f.sha}\n`); await rename(head + '.fixture', head);
      }
    })).rejects.toThrow('object store changed');
    await expect(validateGitActivityDescriptor(descriptor, signal())).resolves.toBeUndefined();
    await rm(head); await symlink(path.join(root, 'unapproved'), head);
    await expect(validateGitActivityDescriptor(descriptor, signal())).rejects.toThrow('Unsafe');
  });
  it('resolves unique short and uppercase SHA declarations while leaving unsupported, missing, tag and blob declarations unresolved', async () => {
    const f = await fixture();
    const blob = await put(f.common, object('blob', 'Synthetic body not returned'));
    const tag = await put(f.common, object('tag', `object ${f.sha}\ntype commit\ntag synthetic\ntagger Synthetic <synthetic@example.invalid> 1767319445 +0900\n\nSynthetic tag\n`));
    const descriptor = await inspect(f.linked, f.common);
    const refs = [f.sha.slice(0, 10).toUpperCase(), blob, tag, 'f'.repeat(40), 'HEAD', 'abc', '--all', f.sha + '^'];
    const result = await read(descriptor, refs);
    expect(result[0]).toEqual({ declaredReference: refs[0], status: 'resolved', fullSha: f.sha, at: '2026-01-01T18:04:05.000Z' });
    expect(result.slice(1)).toEqual(refs.slice(1).map((declaredReference, i) => ({ declaredReference, status: i < 2 ? 'noncommit' : i === 2 ? 'missing' : 'unsupported' })));
  });
  it.each(['blob', 'commit'] as const)('rejects a four-digit collision with a %s, including a new collision after descriptor creation', async type => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const prefix = f.sha.slice(0, 4);
    expect((await read(descriptor, [prefix]))[0]?.status).toBe('resolved');
    const before = await gitActivityObjectRevision(descriptor, signal());
    const colliding = collision(prefix, type, f.tree);
    await put(f.common, colliding);
    expect(await gitActivityObjectRevision(descriptor, signal())).not.toBe(before);
    expect(await read(descriptor, [prefix, f.sha])).toEqual([
      { declaredReference: prefix, status: 'ambiguous' },
      { declaredReference: f.sha, status: 'resolved', fullSha: f.sha, at: '2026-01-01T18:04:05.000Z' },
    ]);
  });
  it('invalidates scoped and default cache proofs on in-place loose-object writes and rejects hardlink changes', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const file = path.join(f.common, 'objects', f.sha.slice(0, 2), f.sha.slice(2));
    await chmod(file, 0o644);
    const scopedBefore = await gitActivityObjectRevision(descriptor, signal(), [f.sha.slice(0, 8)]);
    const allBefore = await gitActivityObjectRevision(descriptor, signal());
    const parentBefore = await stat(path.dirname(file));
    await writeFile(file, await readFile(file));
    expect((await stat(path.dirname(file))).mtimeMs).toBe(parentBefore.mtimeMs);
    expect(await gitActivityObjectRevision(descriptor, signal(), [f.sha.slice(0, 8)])).not.toBe(scopedBefore);
    expect(await gitActivityObjectRevision(descriptor, signal())).not.toBe(allBefore);
    await link(file, path.join(root, 'object-hardlink'));
    await expect(gitActivityObjectRevision(descriptor, signal(), [f.sha])).rejects.toThrow('Unsafe');
    await expect(gitActivityObjectRevision(descriptor, signal())).rejects.toThrow('Unsafe');
  });
  it('bounds loose directory enumeration, while scoped proofs avoid unrelated buckets', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const prefix = f.sha.startsWith('ff') ? 'ee' : 'ff';
    const bucket = path.join(f.common, 'objects', prefix);
    await mkdir(bucket, { recursive: true });
    for (let offset = 0; offset < 16385; offset += 256) {
      await Promise.all(Array.from({ length: Math.min(256, 16385 - offset) }, (_, index) => writeFile(path.join(bucket, (index + offset).toString(16).padStart(38, '0')), '')));
    }
    await expect(gitActivityObjectRevision(descriptor, signal(), [f.sha])).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(gitActivityObjectRevision(descriptor, signal())).rejects.toThrow('proof limit');
  }, 15000);
  it('reads packed metadata without traversing commit history or exposing messages and rejects oversized reference batches', async () => {
    const f = await fixture();
    git(f.worktree, ['repack', '-ad']);
    git(f.worktree, ['prune-packed']);
    const descriptor = await inspect(f.linked, f.common);
    expect((await read(descriptor, [f.sha.slice(0, 8)]))[0]?.fullSha).toBe(f.sha);
    const commands = vi.mocked(spawn).mock.calls.map(call => call[1] as string[]);
    expect(commands.flat()).not.toContain('--all');
    expect(commands.find(args => args.includes('show'))?.at(-1)).toBe('--');
    expect(commands.find(args => args.includes('show'))).toEqual(expect.arrayContaining(['--no-patch', '--no-walk=unsorted', '--no-notes', '--no-show-signature', '--format=%H%x00%cI']));
    await expect(read(descriptor, Array(129).fill(f.sha))).rejects.toThrow('reference limit');
  });
  it('rejects symbolic HEAD path traversal before any subprocess', async () => {
    const f = await fixture();
    await writeFile(path.join(f.common, 'HEAD'), 'ref: refs/../../outside\n');
    await expect(inspect(f.worktree, f.common)).rejects.toThrow('Unsupported Git HEAD');
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(['ref', 'directory'] as const)('rejects a symbolic HEAD %s symlink without opening its external target', async variant => {
    const f = await fixture();
    const descriptor = await inspect(f.worktree, f.common);
    const outside = path.join(root, 'outside-ref'); await mkdir(outside);
    await writeFile(path.join(outside, 'synthetic'), `${f.sha}\n`);
    const target = variant === 'ref' ? path.join(f.common, 'refs', 'heads', 'synthetic') : path.join(f.common, 'refs', 'heads');
    await rm(target, { recursive: true, force: true });
    await symlink(variant === 'ref' ? path.join(outside, 'synthetic') : outside, target);
    await expect(inspect(f.worktree, f.common)).rejects.toThrow('Unsafe');
    await expect(read(descriptor, [f.sha])).rejects.toThrow('Unsafe');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects a symlink common refs root even when the linked HEAD is detached', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const refs = path.join(f.common, 'refs');
    await rename(refs, path.join(root, 'external-refs')); await symlink(path.join(root, 'external-refs'), refs);
    await expect(inspect(f.linked, f.common)).rejects.toThrow(/canonical without symlinks/);
    await expect(read(descriptor, [f.sha])).rejects.toThrow(/canonical without symlinks/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('allows bounded ordinary symbolic ref chains but rejects cycles and depth overflow', async () => {
    const f = await fixture();
    const heads = path.join(f.common, 'refs', 'heads');
    await writeFile(path.join(heads, 'synthetic'), 'ref: refs/heads/second\n');
    await writeFile(path.join(heads, 'second'), `${f.sha}\n`);
    const descriptor = await inspect(f.worktree, f.common);
    expect((await read(descriptor, [f.sha]))[0]?.status).toBe('resolved');
    vi.mocked(spawn).mockClear();
    await writeFile(path.join(heads, 'second'), 'ref: refs/heads/synthetic\n');
    await expect(inspect(f.worktree, f.common)).rejects.toThrow('cyclic');
    for (let index = 0; index < 9; index++) await writeFile(path.join(heads, `chain-${index}`), index === 8 ? `${f.sha}\n` : `ref: refs/heads/chain-${index + 1}\n`);
    await writeFile(path.join(f.common, 'HEAD'), 'ref: refs/heads/chain-0\n');
    await expect(inspect(f.worktree, f.common)).rejects.toThrow('depth limit');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('proves per-worktree symbolic ref namespaces inside the linked Git directory', async () => {
    const f = await fixture();
    const initial = await inspect(f.linked, f.common);
    const local = path.join(initial.gitDirectory, 'refs', 'worktree');
    await mkdir(local, { recursive: true }); await writeFile(path.join(local, 'synthetic'), `${f.sha}\n`);
    await writeFile(path.join(initial.gitDirectory, 'HEAD'), 'ref: refs/worktree/synthetic\n');
    await expect(validateGitActivityDescriptor(initial, signal())).resolves.toBeUndefined();
    expect((await read(initial, [f.sha]))[0]?.status).toBe('resolved');
    await rm(path.join(local, 'synthetic')); await symlink(path.join(root, 'outside'), path.join(local, 'synthetic'));
    await expect(validateGitActivityDescriptor(initial, signal())).rejects.toThrow('Unsafe');
  });
  it('supports safe packed HEAD refs and rejects symlink, hardlink, malformed and oversized packed fallback files', async () => {
    const f = await fixture();
    git(f.worktree, ['pack-refs', '--all']);
    const packed = path.join(f.common, 'packed-refs');
    const original = await readFile(packed);
    const descriptor = await inspect(f.worktree, f.common);
    expect((await read(descriptor, [f.sha]))[0]?.status).toBe('resolved');
    vi.mocked(spawn).mockClear();
    await rename(packed, path.join(root, 'packed-external'));
    await symlink(path.join(root, 'packed-external'), packed);
    await expect(validateGitActivityDescriptor(descriptor, signal())).rejects.toThrow('Unsafe');
    await rm(packed); await link(path.join(root, 'packed-external'), packed);
    await expect(inspect(f.worktree, f.common)).rejects.toThrow('Unsafe');
    await rm(packed); await writeFile(packed, `${f.sha} refs/../../outside\n`);
    await expect(inspect(f.worktree, f.common)).rejects.toThrow('packed ref');
    await writeFile(packed, '#' + 'x'.repeat(1048576));
    await expect(inspect(f.worktree, f.common)).rejects.toThrow('Unsafe');
    await writeFile(packed, original);
    await expect(validateGitActivityDescriptor(descriptor, signal())).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('keeps ordinary branch movement mutable and retires an in-flight packed-ref replacement', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.worktree, f.common);
    git(f.worktree, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'Next ordinary commit']);
    await expect(validateGitActivityDescriptor(descriptor, signal())).resolves.toBeUndefined();
    git(f.worktree, ['pack-refs', '--all']);
    await expect(validateGitActivityDescriptor(descriptor, signal())).resolves.toBeUndefined();
    const packed = path.join(f.common, 'packed-refs');
    let changed = false;
    await expect(read(descriptor, [f.sha], async () => {
      if (vi.mocked(spawn).mock.calls.length && !changed) { changed = true; await writeFile(packed, await readFile(packed)); }
    })).rejects.toThrow('object store changed');
  });
  it('handles a complete 128-reference batch within the shared metadata budget', async () => {
    const f = await fixture();
    const references: string[] = [];
    for (let index = 0; index < 128; index++) references.push(await put(f.common, object('commit', `tree ${f.tree}\nauthor Synthetic <synthetic@example.invalid> 1767319445 +0900\ncommitter Synthetic <synthetic@example.invalid> 1767319445 +0900\n\nSynthetic fixture ${index}\n`)));
    const descriptor = await inspect(f.linked, f.common);
    const rows = await read(descriptor, references);
    expect(rows).toHaveLength(128);
    expect(rows.every(row => row.status === 'resolved')).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('resolves 128 mixed full and short references whose real Git timestamps use UTC Z', async () => {
    const f = await fixture();
    const references: string[] = [], expected: { declaredReference: string; fullSha: string; at: string; status: string }[] = [];
    for (let index = 0; index < 128; index++) {
      const seconds = Date.parse('2026-10-09T14:00:00Z') / 1000 + index * 60;
      const fullSha = await put(f.common, object('commit', `tree ${f.tree}\nauthor Synthetic <synthetic@example.invalid> ${seconds} +0000\ncommitter Synthetic <synthetic@example.invalid> ${seconds} +0000\n\nSynthetic UTC activity ${index}\n`));
      const declaredReference = index % 2 ? fullSha.slice(0, 8) : fullSha;
      references.push(declaredReference);
      expected.push({ declaredReference, fullSha, at: new Date(seconds * 1000).toISOString(), status: 'resolved' });
    }
    const descriptor = await inspect(f.linked, f.common);
    expect(await read(descriptor, references)).toEqual(expected);
    expect(spawn).toHaveBeenCalledTimes(3);
  });
  it('ignores a real monolithic commit graph while resolving exact refs in ordinary and linked stores', async () => {
    const f = await fixture();
    git(f.worktree, ['config', 'core.commitGraph', 'true']);
    const ordinary = await inspect(f.worktree, f.common), linked = await inspect(f.linked, f.common);
    git(f.worktree, ['commit-graph', 'write', '--reachable']);
    const graph = path.join(f.common, 'objects', 'info', 'commit-graph');
    expect((await stat(graph)).isFile()).toBe(true);
    await expect(validateGitActivityDescriptor(ordinary, signal())).resolves.toBeUndefined();
    await expect(validateGitActivityDescriptor(linked, signal())).resolves.toBeUndefined();
    const before = await stat(graph);
    expect((await read(ordinary, [f.sha]))[0]?.status).toBe('resolved');
    expect((await read(linked, [f.sha.slice(0, 8)]))[0]?.fullSha).toBe(f.sha);
    const after = await stat(graph);
    expect([after.ino, after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.size, before.mtimeMs, before.ctimeMs]);
    expect(vi.mocked(spawn).mock.calls.every(call => (call[1] as string[]).includes('core.commitGraph=false'))).toBe(true);
  });
  it('ignores a real split commit-graph chain, including coexisting mutable monolithic cache', async () => {
    const f = await fixture();
    git(f.worktree, ['commit-graph', 'write', '--reachable']);
    const graph = path.join(f.common, 'objects', 'info', 'commit-graph');
    const saved = path.join(root, 'synthetic-graph-copy'); await rename(graph, saved);
    git(f.worktree, ['commit-graph', 'write', '--reachable', '--split=no-merge']);
    const split = path.join(f.common, 'objects', 'info', 'commit-graphs');
    expect((await stat(path.join(split, 'commit-graph-chain'))).isFile()).toBe(true);
    await copyFile(saved, graph);
    const descriptor = await inspect(f.linked, f.common);
    expect((await read(descriptor, [f.sha]))[0]?.status).toBe('resolved');
    git(f.worktree, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-m', 'Next graph fixture']);
    const next = git(f.worktree, ['rev-parse', 'HEAD']);
    git(f.worktree, ['commit-graph', 'write', '--reachable', '--split=no-merge']);
    await copyFile(saved, graph);
    await expect(validateGitActivityDescriptor(descriptor, signal())).resolves.toBeUndefined();
    expect((await read(descriptor, [f.sha, next])).map(row => row.status)).toEqual(['resolved', 'resolved']);
    expect(descriptor.guards.some(guard => /commit-graphs?$/.test(guard.path))).toBe(false);
    expect(vi.mocked(spawn).mock.calls.every(call => (call[1] as string[]).includes('core.commitGraph=false'))).toBe(true);
  });
  it.each(['commit-graph', 'commit-graphs'] as const)('rejects a symlink %s cache entry without traversing it', async name => {
    const f = await fixture();
    await symlink(path.join(root, 'unapproved-cache'), path.join(f.common, 'objects', 'info', name));
    await expect(inspect(f.linked, f.common)).rejects.toThrow('Unsafe Git optimization cache');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('requires exact approved common metadata before reading any common config or launching Git', async () => {
    const f = await fixture();
    for (const worktree of [f.worktree, f.linked]) {
      await expect(inspectGitActivityMetadata(worktree, [], signal())).rejects.toThrow(/authority/);
      await expect(inspectGitActivityMetadata(worktree, [root], signal())).rejects.toThrow(/authority/);
    }
    expect(spawn).not.toHaveBeenCalled();
    await writeFile(path.join(f.common, 'config'), '[include]\npath = /unapproved-secret\n');
    await expect(inspectGitActivityMetadata(f.linked, [], signal())).rejects.toThrow('explicit common-directory authority');
  });
  it('rejects a cross-project registration and an in-scope registration with a foreign back-pointer before any Git process', async () => {
    const f = await fixture(), other = await fixture('other');
    const foreign = await readFile(path.join(other.linked, '.git'));
    await writeFile(path.join(f.linked, '.git'), foreign);
    await expect(inspect(f.linked, f.common)).rejects.toThrow(/authority/);
    await expect(inspect(f.linked, other.common)).rejects.toThrow('another worktree');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects pointer changes, directory replacement, and config replacement against a persisted descriptor', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    expect(parseGitActivityDescriptor(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor);
    const back = path.join(descriptor.gitDirectory, 'gitdir');
    const original = await readFile(back);
    await writeFile(back, original.toString().replace(/\n$/, '') + '\n\n');
    await expect(validateGitActivityDescriptor(descriptor, signal())).rejects.toThrow();
    await writeFile(back, original);
    await expect(validateGitActivityDescriptor(descriptor, signal())).rejects.toThrow('changed');
    const fresh = await inspect(f.linked, f.common);
    await rename(descriptor.gitDirectory, descriptor.gitDirectory + '-old');
    await mkdir(descriptor.gitDirectory);
    await expect(validateGitActivityDescriptor(fresh, signal())).rejects.toThrow('directory identity changed');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects malformed persisted shapes and path topology before consulting paths', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    for (const invalid of [null, { ...descriptor, extra: true }, { ...descriptor, commonDirectory: root }, { ...descriptor, guards: [] }, { ...descriptor, pointerHashes: {} }]) {
      expect(() => parseGitActivityDescriptor(invalid)).toThrow();
    }
  });
  it.each(['include', 'includeIf', 'partial', 'worktree', 'continuation'] as const)('rejects unsafe %s configuration without a subprocess', async variant => {
    const f = await fixture();
    const unsafe = {
      include: '[include]\npath=/unapproved\n', includeIf: '[includeIf "gitdir:*"]\npath=/unapproved\n',
      partial: '[remote "origin"]\npromisor=true\n', worktree: '[extensions]\nworktreeConfig=true\n',
      continuation: '[inclu\\\nde]\npath=/unapproved\n',
    };
    await writeFile(path.join(f.common, 'config'), unsafe[variant]);
    await expect(inspect(f.linked, f.common)).rejects.toThrow('configuration');
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(['alternates', 'http-alternates', 'config.worktree', 'promisor'] as const)('rejects %s metadata', async variant => {
    const f = await fixture();
    const file = variant === 'config.worktree' ? path.join(f.common, variant) : variant === 'promisor' ? path.join(f.common, 'objects', 'pack', 'pack-' + '0'.repeat(40) + '.promisor') : path.join(f.common, 'objects', 'info', variant);
    await writeFile(file, '/unapproved\n');
    await expect(inspect(f.linked, f.common)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(['config', 'bucket', 'object', 'pack'] as const)('rejects %s symlinks without following them', async variant => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const target = variant === 'config' ? path.join(f.common, 'config') : variant === 'bucket' ? path.join(f.common, 'objects', f.sha.slice(0, 2)) : variant === 'object' ? path.join(f.common, 'objects', f.sha.slice(0, 2), f.sha.slice(2)) : path.join(f.common, 'objects', 'pack', 'pack-' + 'a'.repeat(40) + '.idx');
    await rm(target, { recursive: true, force: true });
    await symlink(path.join(root, 'does-not-exist'), target);
    await expect(read(descriptor, [f.sha])).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects hard-linked metadata and more than 256 pack entries', async () => {
    const f = await fixture();
    await link(path.join(f.common, 'config'), path.join(root, 'config-copy'));
    await expect(inspect(f.linked, f.common)).rejects.toThrow('Unsafe');
    await rm(path.join(root, 'config-copy'));
    await Promise.all(Array.from({ length: 257 }, (_, i) => writeFile(path.join(f.common, 'objects', 'pack', `pack-${i.toString(16).padStart(40, '0')}.idx`), '')));
    await expect(inspect(f.linked, f.common)).rejects.toThrow('pack entry limit');
  });
  it('ignores inherited Git configuration, alternates, replacements and network/lazy-fetch settings', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_REPLACE_REF_BASE', 'GIT_SSH_COMMAND', 'GIT_TEST_COMMIT_GRAPH', 'GIT_TEST_MULTI_PACK_INDEX']) vi.stubEnv(key, '/synthetic-untrusted');
    vi.stubEnv('GIT_NO_LAZY_FETCH', '0');
    expect((await read(descriptor, [f.sha]))[0]?.status).toBe('resolved');
    for (const call of vi.mocked(spawn).mock.calls) {
      const environment = call[2]?.env;
      expect(environment?.GIT_DIR).toBeUndefined();
      expect(environment?.GIT_CONFIG_COUNT).toBeUndefined();
      expect(environment?.GIT_TEST_COMMIT_GRAPH).toBeUndefined();
      expect(environment?.GIT_TEST_MULTI_PACK_INDEX).toBeUndefined();
      expect(environment?.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
      expect(environment?.GIT_NO_LAZY_FETCH).toBe('1');
      expect(environment?.GIT_ALLOW_PROTOCOL).toBe('');
      expect(environment?.GIT_NO_REPLACE_OBJECTS).toBe('1');
      expect(call[2]?.shell).toBe(false);
      expect(call[1]).toEqual(expect.arrayContaining(['core.warnAmbiguousRefs=false']));
    }
  });
  it('drops results on revoked authority and performs no process when already revoked', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    await expect(read(descriptor, [f.sha], async () => { throw Error('Authority revoked'); })).rejects.toThrow('Authority revoked');
    expect(spawn).not.toHaveBeenCalled();
    await expect(read(descriptor, [f.sha], async () => { if (vi.mocked(spawn).mock.calls.length) throw Error('Authority revoked'); })).rejects.toThrow('Authority revoked');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('drops in-flight results when an existing object changes without changing its parent directory', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const file = path.join(f.common, 'objects', f.sha.slice(0, 2), f.sha.slice(2));
    await chmod(file, 0o644);
    let changed = false;
    await expect(read(descriptor, [f.sha], async () => {
      if (vi.mocked(spawn).mock.calls.length && !changed) { changed = true; const content = await readFile(file); await writeFile(file, content); }
    })).rejects.toThrow('object store changed');
  });
  it('drops in-flight results on pointer replacement and respects an already aborted signal', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const back = path.join(descriptor.gitDirectory, 'gitdir');
    let changed = false;
    await expect(read(descriptor, [f.sha], async () => {
      if (vi.mocked(spawn).mock.calls.length && !changed) { changed = true; writeFileSync(back, `${path.join(root, 'foreign', '.git')}\n`); }
    })).rejects.toThrow(/identity changed|another worktree/);
    const controller = new AbortController(); controller.abort();
    await expect(inspectGitActivityMetadata(f.worktree, [f.common], controller.signal)).rejects.toThrow(/cancelled/i);
  });
  it('enforces the 64 KiB aggregate subprocess-output cap without exposing raw output', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementationOnce((_command, _args, options) => actual.spawn(process.execPath, ['-e', 'process.stdout.write("x".repeat(65537))'], options!));
    await expect(read(descriptor, [f.sha])).rejects.toThrow('aggregate output limit');
  });
  it('rejects an oversized local config before starting a subprocess', async () => {
    const f = await fixture();
    await writeFile(path.join(f.common, 'config'), '#' + 'x'.repeat(65536));
    await expect(inspect(f.linked, f.common)).rejects.toThrow('Unsafe');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('revokes in-flight authority on signal cancellation', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    const controller = new AbortController();
    await expect(readGitActivityReferences(descriptor, [f.sha], controller.signal, async () => {
      if (vi.mocked(spawn).mock.calls.length) controller.abort();
    })).rejects.toThrow(/cancelled/i);
  });
  it('bounds a stalled authority callback within the aggregate five-second deadline', async () => {
    const f = await fixture();
    const descriptor = await inspect(f.linked, f.common);
    vi.useFakeTimers();
    try {
      const result = read(descriptor, [f.sha], async () => new Promise<void>(() => {}));
      const rejection = expect(result).rejects.toThrow(/deadline/);
      await vi.advanceTimersByTimeAsync(5001);
      await rejection;
      expect(spawn).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
