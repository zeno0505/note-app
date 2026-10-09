import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SOURCE_RELEASE_REPOSITORY = 'https://github.com/zeno0505/note-app.git';
export const SOURCE_RELEASE_ASSET = 'note-app-source-update.json';
const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Maintainer input only. Source identity is always derived from the checked commit. */
export function validateReleaseInput(buildNumber, changelog) {
  if (typeof buildNumber !== 'string' || !/^[1-9]\d{0,3}$/.test(buildNumber)) {
    throw new Error('Use an increasing --build-number from 1 through 9999');
  }
  if (!Array.isArray(changelog) || changelog.length < 1 || changelog.length > 30
    || changelog.some(line => typeof line !== 'string' || line !== line.trim() || !line.length
      || line.length > 500 || /[\u0000-\u001f\u007f]/.test(line))) {
    throw new Error('Use 1..30 --changelog lines, each trimmed and 1..500 characters without controls');
  }
}

export async function createSourceRelease({cwd = process.cwd(), output, buildNumber, changelog}) {
  validateReleaseInput(buildNumber, changelog);
  if (typeof output !== 'string' || !path.isAbsolute(output) || path.resolve(output) !== output) {
    throw new Error('--output must be a new absolute canonical directory outside the repository');
  }
  const root = await realpath(cwd);
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (await realpath(git('rev-parse', '--show-toplevel').trim()) !== root) {
    throw new Error('Run from the repository root');
  }
  // Official actions/checkout uses the equivalent HTTPS origin without .git.
  const origin = git('config', '--get', 'remote.origin.url').trim();
  if (![SOURCE_RELEASE_REPOSITORY, SOURCE_RELEASE_REPOSITORY.slice(0, -4)].includes(origin)) {
    throw new Error('The source must use the fixed public note-app origin');
  }
  const assertClean = () => {
    if (git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none').length
      || git('ls-files', '-v', '-z').split('\0').some(line => line && (line[0] === 'S' || /[a-z]/.test(line[0])))) {
      throw new Error('Commit and verify a clean source checkout; hidden index flags are not allowed');
    }
  };
  assertClean();
  const sourceSha = git('rev-parse', '--verify', 'HEAD^{commit}').trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Expected a full SHA-1 source commit');
  const committedFile = async name => {
    const tree = git('ls-tree', sourceSha, '--', name);
    if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(tree)) throw new Error(`Expected tracked regular ${name}`);
    const file = path.join(root, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular ${name}`);
    const committed = Buffer.from(git('show', `${sourceSha}:${name}`));
    const working = await readFile(file);
    if (!working.equals(committed)) throw new Error(`${name} differs from the committed source`);
    return working;
  };
  const packageBytes = await committedFile('package.json');
  const lockBytes = await committedFile('package-lock.json');
  const pkg = JSON.parse(packageBytes), lock = JSON.parse(lockBytes);
  if (pkg.name !== 'note-app' || typeof pkg.version !== 'string' || !versionPattern.test(pkg.version)
    || lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('The committed package and lockfile must agree on a strict note-app version');
  }
  const parent = path.dirname(output), parentReal = await realpath(parent);
  if (parentReal !== parent) throw new Error('Output parent must be canonical, without symlink components');
  const metadataRoots = ['--absolute-git-dir', '--git-common-dir'].map(flag => path.resolve(root, git('rev-parse', flag).trim()));
  const forbidden = await Promise.all([root, ...metadataRoots].map(item => realpath(item)));
  if (forbidden.some(item => inside(item, output))) throw new Error('Output must be outside the repository and Git metadata');
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077)
    || (process.getuid && parentStat.uid !== process.getuid())) {
    throw new Error('Output parent must be an existing private, owned directory (mode 0700)');
  }
  const manifest = {
    schemaVersion: 1, channel: 'demo', repository: SOURCE_RELEASE_REPOSITORY,
    version: pkg.version, buildNumber, sourceSha,
    lockfileSha256: createHash('sha256').update(lockBytes).digest('hex'),
    changelog: [...changelog], publishedAt: new Date().toISOString(),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (manifestBytes.length > 65536) throw new Error('Source manifest exceeds the 64 KiB feed limit');
  // No recursive mkdir, overwrite, or cleanup: existing/uncertain paths are preserved.
  await mkdir(output, {mode: 0o700});
  const directoryStat = await lstat(output);
  const assertOutput = async () => {
    if (!sameNode(parentStat, await lstat(parent)) || await realpath(parent) !== parent
      || !sameNode(directoryStat, await lstat(output)) || await realpath(output) !== output) {
      throw new Error('Output ownership changed; preserve the directory for inspection');
    }
  };
  const assertSource = () => {
    assertClean();
    if (git('rev-parse', '--verify', 'HEAD^{commit}').trim() !== sourceSha) throw new Error('Source HEAD changed during generation');
  };
  await assertOutput();
  assertSource();
  const manifestPath = path.join(output, SOURCE_RELEASE_ASSET);
  const handle = await open(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(manifestBytes);
    await handle.sync();
    await assertOutput();
    if (!sameNode(await handle.stat(), await lstat(manifestPath))) throw new Error('Output file identity changed');
    assertSource();
  } finally {
    await handle.close();
  }
  const directory = await open(output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  return {manifest, manifestPath};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options: {
      output: {type: 'string'}, 'build-number': {type: 'string'}, changelog: {type: 'string', multiple: true},
    }, allowPositionals: false, strict: true});
    const result = await createSourceRelease({output: values.output, buildNumber: values['build-number'], changelog: values.changelog});
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Source release not generated: ${error.message}`);
    process.exitCode = 1;
  }
}
