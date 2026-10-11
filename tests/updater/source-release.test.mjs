import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, chmod, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSourceRelease, validateReleaseInput, SOURCE_RELEASE_ASSET, SOURCE_RELEASE_REPOSITORY} from '../../scripts/create-source-release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'scripts/create-source-release.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'note-app-source-release-')));
  t.after(() => rm(home, {recursive: true, force: true}));
  const repo = path.join(home, 'repository');
  await mkdir(repo, {mode: 0o700});
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Synthetic release fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic release fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'},
  }).trim();
  git('init', '-q');
  git('remote', 'add', 'origin', SOURCE_RELEASE_REPOSITORY);
  const pkg = {name: 'note-app', version: '0.1.0', private: true};
  const lock = {...pkg, lockfileVersion: 3, packages: {'': pkg}};
  await writeFile(path.join(repo, 'package.json'), JSON.stringify(pkg) + '\n');
  await writeFile(path.join(repo, 'package-lock.json'), JSON.stringify(lock) + '\n');
  await writeFile(path.join(repo, 'source.txt'), 'synthetic source\n');
  git('add', '.');
  git('commit', '-qm', 'Synthetic source fixture');
  const output = path.join(home, 'release');
  const options = {cwd: repo, output, buildNumber: '23', changelog: ['Synthetic source update']};
  return {home, repo, git, pkg, lock, output, options};
}

test('derives exactly nine manifest fields from the clean committed HEAD and writes privately', async t => {
  const f = await fixture(t), before = Date.now();
  const {manifest, manifestPath} = await createSourceRelease(f.options);
  assert.deepEqual(Object.keys(manifest).sort(), ['schemaVersion', 'channel', 'repository', 'version', 'buildNumber', 'sourceSha', 'lockfileSha256', 'changelog', 'publishedAt'].sort());
  assert.equal(manifest.sourceSha, f.git('rev-parse', 'HEAD'));
  assert.equal(manifest.lockfileSha256, hash(await readFile(path.join(f.repo, 'package-lock.json'))));
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.repository, SOURCE_RELEASE_REPOSITORY);
  assert.equal(manifest.channel, 'demo');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.buildNumber, '23');
  assert.deepEqual(manifest.changelog, ['Synthetic source update']);
  assert.ok(Date.parse(manifest.publishedAt) >= before && Date.parse(manifest.publishedAt) <= Date.now());
  assert.equal(manifestPath, path.join(f.output, SOURCE_RELEASE_ASSET));
  assert.deepEqual(JSON.parse(await readFile(manifestPath)), manifest);
  assert.equal((await lstat(f.output)).mode & 0o777, 0o700);
  assert.equal((await lstat(manifestPath)).mode & 0o777, 0o600);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('accepts the official checkout action origin form without changing the manifest repository', async t => {
  const f = await fixture(t);
  f.git('remote', 'set-url', 'origin', SOURCE_RELEASE_REPOSITORY.slice(0, -4));
  const {manifest} = await createSourceRelease(f.options);
  assert.equal(manifest.repository, SOURCE_RELEASE_REPOSITORY);
});

test('works from detached public-snapshot HEAD and derives its new source identity', async t => {
  const f = await fixture(t), original = f.git('rev-parse', 'HEAD');
  await writeFile(path.join(f.repo, 'source.txt'), 'second synthetic public snapshot\n');
  f.git('add', '.'); f.git('commit', '-qm', 'Synthetic snapshot checkpoint');
  const snapshot = f.git('rev-parse', 'HEAD');
  f.git('checkout', '--detach', snapshot);
  const {manifest} = await createSourceRelease(f.options);
  assert.equal(manifest.sourceSha, snapshot);
  assert.notEqual(manifest.sourceSha, original);
});

test('rejects dirty tracked, staged, and untracked source without creating output', async t => {
  for (const kind of ['tracked', 'staged', 'untracked']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      await writeFile(path.join(f.repo, kind === 'untracked' ? 'extra.txt' : 'source.txt'), 'changed');
      if (kind === 'staged') f.git('add', '.');
      await assert.rejects(createSourceRelease(f.options), /clean source/);
      await assert.rejects(lstat(f.output), {code: 'ENOENT'});
    });
  }
});

test('rejects hidden Git index flags even when status looks clean', async t => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    await t.test(flag, async t => {
      const f = await fixture(t);
      f.git('update-index', flag, 'package-lock.json');
      await writeFile(path.join(f.repo, 'package-lock.json'), 'tampered');
      assert.equal(f.git('status', '--porcelain'), '');
      await assert.rejects(createSourceRelease(f.options), /hidden index flags/);
    });
  }
});

test('requires a fixed origin and execution from the repository root', async t => {
  const f = await fixture(t);
  f.git('remote', 'set-url', 'origin', 'https://example.invalid/other.git');
  await assert.rejects(createSourceRelease(f.options), /fixed public/);
  f.git('remote', 'set-url', 'origin', SOURCE_RELEASE_REPOSITORY);
  await mkdir(path.join(f.repo, 'nested'));
  await assert.rejects(createSourceRelease({...f.options, cwd: path.join(f.repo, 'nested')}), /repository root/);
});

test('rejects inconsistent or invalid committed version metadata', async t => {
  for (const [version, lockVersion] of [['01.1.0', '01.1.0'], ['1.0.0-beta', '1.0.0-beta'], ['1.0.0', '0.1.0']]) {
    await t.test(`${version}/${lockVersion}`, async t => {
      const f = await fixture(t);
      await writeFile(path.join(f.repo, 'package.json'), JSON.stringify({...f.pkg, version}));
      await writeFile(path.join(f.repo, 'package-lock.json'), JSON.stringify({...f.lock, version: lockVersion, packages: {'': {...f.pkg, version: lockVersion}}}));
      f.git('add', '.'); f.git('commit', '-qm', 'Synthetic invalid metadata');
      await assert.rejects(createSourceRelease(f.options), /agree on a strict/);
    });
  }
});

test('rejects a committed symlink instead of package metadata', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'real-package.json'), JSON.stringify(f.pkg));
  await rm(path.join(f.repo, 'package.json'));
  await symlink('real-package.json', path.join(f.repo, 'package.json'));
  f.git('add', '.'); f.git('commit', '-qm', 'Synthetic symlink');
  await assert.rejects(createSourceRelease(f.options), /tracked regular/);
});

test('validates bounded maintainer input and forbids manual identity CLI arguments', async () => {
  for (const value of [undefined, 1, '', '0', '01', '10000', '-1', '1;echo bad']) assert.throws(() => validateReleaseInput(value, ['Valid']), /build-number/);
  for (const lines of [undefined, [], [''], [' space'], ['space '], ['line\nbreak'], ['x'.repeat(501)], Array(31).fill('line')]) assert.throws(() => validateReleaseInput('2', lines), /changelog/);
  validateReleaseInput('9999', ['한글 변경 기록', 'A second line']);
  for (const flag of ['--source-sha', '--sha', '--version', '--repository', '--published-at']) {
    const result = spawnSync(process.execPath, [script, flag, 'arbitrary'], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option/);
  }
});

test('applies the same 64 KiB byte limit as the discovery feed', async t => {
  const f = await fixture(t);
  await assert.rejects(createSourceRelease({...f.options, changelog: Array(30).fill('\ud800'.repeat(500))}), /64 KiB/);
  await assert.rejects(lstat(f.output), {code: 'ENOENT'});
});

test('refuses existing output and preserves all pre-existing content', async t => {
  const f = await fixture(t);
  await mkdir(f.output, {mode: 0o700});
  const sentinel = path.join(f.output, SOURCE_RELEASE_ASSET);
  await writeFile(sentinel, 'keep this');
  await assert.rejects(createSourceRelease(f.options), {code: 'EEXIST'});
  assert.equal(await readFile(sentinel, 'utf8'), 'keep this');
});

test('rejects checkout/Git metadata outputs and noncanonical or nonprivate parents', async t => {
  const f = await fixture(t);
  for (const output of [path.join(f.repo, 'release'), path.join(f.repo, '.git', 'release')]) {
    await assert.rejects(createSourceRelease({...f.options, output}), /outside the repository/);
  }
  await assert.rejects(createSourceRelease({...f.options, output: './relative'}), /absolute canonical/);
  const publicParent = path.join(f.home, 'public');
  await mkdir(publicParent); await chmod(publicParent, 0o755);
  await assert.rejects(createSourceRelease({...f.options, output: path.join(publicParent, 'release')}), /private, owned/);
  const link = path.join(f.home, 'alias');
  await symlink(f.home, link);
  await assert.rejects(createSourceRelease({...f.options, output: path.join(link, 'release')}), /without symlink/);
  await symlink(f.home, f.output);
  await assert.rejects(createSourceRelease(f.options), {code: 'EEXIST'});
  assert.ok((await lstat(f.output)).isSymbolicLink());
});

