import {afterEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {deflateSync} from 'node:zlib';
import {SourceUpdater, runBoundedUpdateCommand, type UpdateCommand, type UpdateFileSystem, type UpdateRunner, type SourceUpdaterOptions} from '../../src/main/update/source-updater';
import {hashAppBundle} from '../../scripts/updater/bundle-integrity.mjs';
import {UPDATE_REPOSITORY} from '../../src/main/update/manifest';
import {PREPARED_STATE_FILE, PREPARED_STATE_MAX_AGE_MS} from '../../src/main/update/prepared-state';
const roots: string[] = [];
const sha = 'b'.repeat(40), tree = 'c'.repeat(40), digest = (value: string) => createHash('sha256').update(value).digest('hex');
const current = {version: '0.1.0', buildNumber: '1', sourceSha: 'a'.repeat(40)};
const sourcePackage = JSON.stringify({name: 'note-app', version: '0.2.0', scripts: {check: 'test', build: 'build', 'setup:electron': 'install', 'package:mac:local': 'package'}});
const gitBlob = (value: string) => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const safeGitConfig = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[remote "origin"]\n\turl = ${UPDATE_REPOSITORY}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
const lock = JSON.stringify({name: 'note-app', version: '0.2.0', lockfileVersion: 3});
const target = () => ({schemaVersion: 1, channel: 'demo', repository: UPDATE_REPOSITORY, version: '0.2.0', buildNumber: '2', sourceSha: sha,
  lockfileSha256: digest(lock), changelog: ['Demo update'], publishedAt: '2026-10-08T00:00:00.000Z'});
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true}); });
async function fixture(options: {sourceSha?: string; sourceTree?: string; dirty?: boolean; wrongFetch?: boolean; wrongPackage?: boolean; onCommand?: (command: UpdateCommand) => Promise<void>} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'note-update-'))); roots.push(root);
  const home = path.join(root, 'home'); await fs.mkdir(home, {mode: 0o700});
  const calls: UpdateCommand[] = []; let checkout = '';
  const sha = options.sourceSha ?? 'b'.repeat(40), tree = options.sourceTree ?? 'c'.repeat(40);
  const fileSystem = {...fs, lstat: async (file: string, ...args: []) => file === '/usr/local/bin/node' ? fs.lstat(process.execPath) : fs.lstat(file, ...args),
    realpath: async (file: string) => file === '/usr/local/bin/node' ? file : fs.realpath(file)} as unknown as UpdateFileSystem;
  const runner: UpdateRunner = async command => {
    calls.push(command); await options.onCommand?.(command); const args = [...command.args]; let stdout = '';
    if (command.executable === 'node') stdout = args[0] === '--version' ? 'v24.2.0' : '/usr/local/bin/node';
    else if (command.executable === '/usr/bin/git') {
      const meaningful = args.filter((arg, i) => arg !== '-c' && args[i - 1] !== '-c');
      if (meaningful[0] === '--version') stdout = 'git version 2.50.0';
      if (meaningful[0] === 'init') { checkout = command.cwd; await fs.mkdir(path.join(checkout, '.git'), {mode: 0o700}); await fs.writeFile(path.join(checkout, '.git/config'), safeGitConfig); }
      if (meaningful[0] === 'checkout') {
        await fs.writeFile(path.join(checkout, 'package.json'), JSON.stringify({name: 'note-app', version: '0.2.0', scripts: {check: 'test', build: 'build', 'setup:electron': 'install', 'package:mac:local': 'package'}}));
        await fs.writeFile(path.join(checkout, 'package-lock.json'), lock);
      }
      if (meaningful[0] === 'rev-parse') stdout = meaningful[1] === 'HEAD^{tree}' ? tree : meaningful[1] === '--abbrev-ref' ? 'HEAD'
        : meaningful[1] === 'FETCH_HEAD' && options.wrongFetch ? 'd'.repeat(40) : sha;
      if (meaningful[0] === 'status') stdout = options.dirty ? ' M package.json' : '';
      if (meaningful[0] === 'remote' && meaningful[1] === 'get-url') stdout = UPDATE_REPOSITORY;
      if (meaningful[0] === 'ls-files') stdout = meaningful[1] === '-v' ? 'H package.json\0H package-lock.json\0' : `100644 ${gitBlob(sourcePackage)} 0\tpackage.json\0` + `100644 ${gitBlob(lock)} 0\tpackage-lock.json\0`;
      if (meaningful[0] === 'ls-tree') stdout = `100644 blob ${gitBlob(sourcePackage)}\tpackage.json\0` + `100644 blob ${gitBlob(lock)}\tpackage-lock.json\0`;
    } else if (command.executable === 'npm') {
      if (args[0] === '--version') stdout = '11.9.0';
      if (args[1] === 'package:mac:local') {
        const app = args[args.indexOf('--output') + 1], appRoot = path.join(app, 'Contents/Resources/app');
        await fs.mkdir(path.join(appRoot, 'dist/main'), {recursive: true, mode: 0o700}); await fs.mkdir(path.join(appRoot, 'dist/preload'), {mode: 0o700});
        await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({name: 'note-app', version: '0.2.0', updaterProtocolVersion:1, sourceSha: options.wrongPackage ? tree : sha, installation: {role: 'user', buildNumber: '2'}}));
        await fs.writeFile(path.join(appRoot, 'dist/main/index.cjs'), 'main'); await fs.writeFile(path.join(appRoot, 'dist/preload/index.cjs'), 'preload');
        await fs.writeFile(app + '.manifest.json', JSON.stringify({kind: 'local-mac-app', version: '0.2.0', sourceSha: sha, sourceTree: tree, buildNumber: '2',
          role: 'user', bundleId: 'dev.noteapp.local', lockfileSha256: digest(lock), architecture: 'arm64', adHocSignatureVerified: true,
          configuration: 'external-private-config', modelCalls: 0, appSha256: await hashAppBundle(app), entrySha256: digest('main'), preloadSha256: digest('preload')}));
      }
    }
    return {stdout, stderr: ''};
  };
  const create = (approvedTarget: unknown = target(), overrides: Partial<SourceUpdaterOptions> = {}) => new SourceUpdater({home, current, approvedTarget, platform: 'darwin', architecture: 'arm64',
    runner, fs: fileSystem, now: () => new Date('2026-10-08T12:00:00.000Z'), ...overrides});
  return {root, home, calls, runner, fileSystem, create, get checkout() {return checkout;}, updater: create()};
}
describe('isolated source updater contract', () => {
  it('does no lookup, shell, storage creation, or HEAD fallback when no valid target is published', async () => {
    const f = await fixture();
    for (const value of [null, {}, {...target(), sourceSha: 'HEAD'}, {...target(), publishedAt: '2026-10-09T00:00:00.000Z'}]) {
      const updater = f.create(value); expect((await updater.check()).status).toBe('unavailable'); expect(await updater.prepare()).toBeNull();
    }
    expect(f.calls).toHaveLength(0); expect(await fs.readdir(f.home)).toEqual([]);
  });
  it('prepares one detached exact commit with fixed commands and credential-free owned paths', async () => {
    const f = await fixture(); expect((await f.updater.check()).status).toBe('available');
    const first = f.updater.prepare(), second = f.updater.prepare(); expect(first).toBe(second);
    const artifact = await first; expect(artifact?.target.sourceSha).toBe(sha); expect(artifact?.nodeExecutable).toBe('/usr/local/bin/node');
    expect(f.updater.getState().status).toBe('ready'); expect(f.updater.getState().canInstall).toBe(true);
    expect((await f.updater.check()).status).toBe('ready'); expect((await f.updater.defer()).status).toBe('deferred'); expect(await f.updater.prepare()).toBe(artifact);
    expect(f.calls.find(call => call.args.includes('fetch'))?.args.slice(-5)).toEqual(['fetch', '--no-tags', '--depth=1', 'origin', sha]);
    expect(f.calls.find(call => call.args.includes('checkout'))?.args.slice(-3)).toEqual(['checkout', '--detach', sha]);
    expect(f.calls.filter(call => call.args[0] === 'ci')).toHaveLength(1);
    expect(f.calls.some(call => call.args.includes('reset') || call.args.includes('clean') || call.args.includes('--force'))).toBe(false);
    for (const call of f.calls) {
      expect(call.cwd).toContain('/Library/Application Support/note-app-updater'); expect(call.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(call.env.HOME).toContain('/note-app-updater/runtime-home'); expect(call.env).not.toHaveProperty('GH_TOKEN');
      expect(call.env).not.toHaveProperty('NODE_OPTIONS'); expect(call.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(call.timeoutMs).toBeLessThanOrEqual(600_000); expect(call.maxOutputBytes).toBe(4 * 1024 * 1024);
    }
    expect(JSON.stringify(f.updater.getState())).not.toContain(f.root);
    expect(await fs.readdir(path.join(f.home, 'Library/Application Support/note-app-updater'))).not.toContain('prepare.lock');
  });
  it('rejects dirty owned checkout without reset, cleanup, or dependency execution', async () => {
    const f = await fixture({dirty: true}); expect(await f.updater.prepare()).toBeNull(); expect(f.updater.getState().message).toContain('보존했습니다');
    expect(await fs.readFile(path.join(f.checkout, 'package-lock.json'), 'utf8')).toBe(lock);
    expect(f.calls.some(call => call.args[0] === 'ci' || call.args.includes('reset') || call.args.includes('clean'))).toBe(false);
  });
  it('rejects wrong fetch commit and wrong staged package provenance', async () => {
    const fetched = await fixture({wrongFetch: true}); expect(await fetched.updater.prepare()).toBeNull();
    expect(fetched.calls.some(call => call.args.includes('checkout'))).toBe(false);
    const packaged = await fixture({wrongPackage: true}); expect(await packaged.updater.prepare()).toBeNull(); expect(packaged.updater.getState().status).toBe('error');
    expect(packaged.calls.some(call => call.executable === '/usr/bin/codesign')).toBe(false);
  });
  it('rejects symlinked updater storage and preserves the destination', async () => {
    const f = await fixture(), existing = path.join(f.root, 'developer-checkout'); await fs.mkdir(existing, {mode: 0o700}); await fs.writeFile(path.join(existing, 'sentinel'), 'unchanged');
    await fs.mkdir(path.join(f.home, 'Library/Application Support'), {recursive: true, mode: 0o700});
    await fs.symlink(existing, path.join(f.home, 'Library/Application Support/note-app-updater'));
    expect(await f.updater.prepare()).toBeNull(); expect(await fs.readdir(existing)).toEqual(['sentinel']); expect(f.calls).toHaveLength(0);
  });
  it('rejects a source lockfile symlink and never follows it into developer data', async () => {
    let foreign = ''; const f = await fixture({onCommand: async command => {
      if (command.args.includes('status')) { const file = path.join(command.cwd, 'package-lock.json'); await fs.rm(file, {force: true}); await fs.symlink(foreign, file); }
    }}); foreign = path.join(f.root, 'dev-lock'); await fs.writeFile(foreign, lock);
    expect(await f.updater.prepare()).toBeNull(); expect(await fs.readFile(foreign, 'utf8')).toBe(lock); expect(f.calls.some(call => call.args[0] === 'ci')).toBe(false);
  });
  it('rejects lockfile drift after npm before check/build/package', async () => {
    const f = await fixture({onCommand: async command => {if (command.args[0] === 'ci') await fs.writeFile(path.join(command.cwd, 'package-lock.json'), 'changed');}});
    expect(await f.updater.prepare()).toBeNull(); expect(f.updater.getState().message).toContain('잠금 파일');
    expect(f.calls.some(call => call.args[1] === 'check' || call.args[1] === 'build')).toBe(false);
  });
  it('keeps cancellation pending until an in-flight process drains and does not publish a late artifact', async () => {
    let entered!: () => void, drain!: () => void; const enteredPromise = new Promise<void>(resolve => entered = resolve), drainPromise = new Promise<void>(resolve => drain = resolve);
    const f = await fixture({onCommand: async command => { if (command.args.includes('fetch')) {entered(); await drainPromise;} }});
    const prepare = f.updater.prepare(); await enteredPromise; let settled = false; const cancel = f.updater.cancel().then(state => {settled = true; return state;});
    await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false); drain(); expect(await prepare).toBeNull();
    expect((await cancel).status).toBe('cancelled'); expect(f.calls.some(call => call.args.includes('checkout'))).toBe(false); expect(f.updater.getPrepared()).toBeNull();
  });
  it('uses a private cross-instance preparation lock', async () => {
    let entered!: () => void, drain!: () => void; const ready = new Promise<void>(resolve => entered = resolve), wait = new Promise<void>(resolve => drain = resolve);
    const f = await fixture({onCommand: async command => {if (command.args.includes('fetch')) {entered(); await wait;}}});
    const first = f.updater.prepare(); await ready; const second = f.create(); expect(await second.prepare()).toBeNull();
    expect(second.getState().message).toContain('중복 실행'); drain(); expect(await first).not.toBeNull();
  });
  it('never treats Linux contracts as macOS preparation and refuses nonmonotonic metadata', async () => {
    const f = await fixture(); const linux = new SourceUpdater({home: f.home, current, approvedTarget: target(), platform: 'linux', runner: f.runner});
    expect(await linux.prepare()).toBeNull(); expect(linux.getState().message).toContain('macOS에서만'); expect(f.calls).toHaveLength(0);
    const stale = f.create({...target(), buildNumber: '1'}); expect(await stale.prepare()).toBeNull(); expect(f.calls).toHaveLength(0);
  });
});
describe('bounded updater subprocess runner', () => {
  const command = (script: string, signal = new AbortController().signal): UpdateCommand => ({executable: process.execPath, args: ['-e', script], cwd: tmpdir(), env: {}, signal, timeoutMs: 2000, maxOutputBytes: 1024});
  it('bounds output and wall time, with no shell interpolation', async () => {
    await expect(runBoundedUpdateCommand(command('process.stdout.write("x".repeat(2048))'))).rejects.toThrow('output limit');
    await expect(runBoundedUpdateCommand({...command('setInterval(()=>{},1000)'), timeoutMs: 40})).rejects.toThrow('timed out');
    expect((await runBoundedUpdateCommand(command('process.stdout.write("safe; $(echo injected)")'))).stdout).toBe('safe; $(echo injected)');
  });
  it.skipIf(process.platform!=='linux')('verifies owned descendants after a successful parent exits',async()=>{
    const controller=new AbortController();
    const result=await runBoundedUpdateCommand(command(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref();`,controller.signal));
    const pid=Number(result.stdout.trim());expect(pid).toBeGreaterThan(1);
    try{const stat=await fs.readFile('/proc/'+pid+'/stat','utf8');expect(['Z','X']).toContain(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch(error){expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');}
  });
  it('drains an aborting process before returning', async () => {
    const controller = new AbortController(), running = runBoundedUpdateCommand(command('setInterval(()=>{},1000)', controller.signal));
    setTimeout(() => controller.abort(), 30); await expect(running).rejects.toMatchObject({name: 'AbortError'});
  });
});

describe('real isolated Git provenance on Linux', () => {
  const exec = promisify(execFile);
  async function repository() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'note-update-origin-'))); roots.push(root);
    const source = path.join(root, 'developer-source'), origin = path.join(root, 'origin.git'); await fs.mkdir(source, {mode: 0o700});
    const git = async (...args: string[]) => (await exec('/usr/bin/git', args, {cwd: source, env: {PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}})).stdout.trim();
    await git('init', '--quiet'); await git('config', 'user.name', 'Synthetic Update Test'); await git('config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({name: 'note-app', version: '0.2.0', scripts: {check: 'test', build: 'build', 'setup:electron': 'install', 'package:mac:local': 'package'}}));
    await fs.writeFile(path.join(source, 'package-lock.json'), lock); await fs.writeFile(path.join(source, 'README.md'), 'approved');
    await git('add', '.'); await git('commit', '--quiet', '-m', 'approved source'); const approvedSha = await git('rev-parse', 'HEAD'), approvedTree = await git('rev-parse', 'HEAD^{tree}');
    await fs.writeFile(path.join(source, 'README.md'), 'unapproved newer HEAD'); await git('commit', '--quiet', '-am', 'newer source'); const newestSha = await git('rev-parse', 'HEAD');
    await git('clone', '--bare', '--quiet', source, origin);
    // The development checkout is deliberately dirty, and is never given to production code.
    await fs.writeFile(path.join(source, 'README.md'), 'user development edits');
    return {root, source, origin, git, approvedSha, approvedTree, newestSha};
  }
  async function harness(repo: Awaited<ReturnType<typeof repository>>, failFetch = false) {
    const f = await fixture({sourceSha: repo.approvedSha, sourceTree: repo.approvedTree});
    const actualCommands: UpdateCommand[] = [];
    const runner: UpdateRunner = async command => {
      if (command.executable !== '/usr/bin/git') return f.runner(command);
      actualCommands.push(command);
      if (command.args.includes('fetch')) {
        expect(command.args.slice(-2)).toEqual(['origin', repo.approvedSha]);
        if (failFetch) throw new Error('Synthetic connection failure');
        const args = [...command.args], index = args.indexOf('fetch'); args.splice(index, 0, '-c', 'protocol.file.allow=always'); args[args.length - 2] = repo.origin;
        // File transport and URL remapping exist exclusively in this injected test runner.
        return runBoundedUpdateCommand({...command, args, env: {...command.env, GIT_ALLOW_PROTOCOL: 'file'}});
      }
      return runBoundedUpdateCommand(command);
    };
    const updater = new SourceUpdater({home: f.home, current, approvedTarget: {...target(), sourceSha: repo.approvedSha},
      platform: 'darwin', architecture: 'arm64', runner, fs: f.fileSystem, now: () => new Date('2026-10-08T12:00:00.000Z')});
    return {...f, updater, actualCommands, runner};
  }
  it('pins the approved commit despite newer origin HEAD and never touches an unrelated dirty checkout', async () => {
    const repo = await repository(), f = await harness(repo), prepared = await f.updater.prepare();
    expect(prepared).not.toBeNull(); expect(prepared!.target.sourceSha).toBe(repo.approvedSha); expect(prepared!.sourceTree).toBe(repo.approvedTree);
    const stagedSource = path.join(prepared!.stagePath, 'source');
    expect((await exec('/usr/bin/git', ['rev-parse', 'HEAD'], {cwd: stagedSource})).stdout.trim()).toBe(repo.approvedSha);
    expect((await exec('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD'], {cwd: stagedSource})).stdout.trim()).toBe('HEAD');
    expect(await fs.readFile(path.join(stagedSource, 'README.md'), 'utf8')).toBe('approved');
    expect(await repo.git('rev-parse', 'HEAD')).toBe(repo.newestSha);
    expect(await fs.readFile(path.join(repo.source, 'README.md'), 'utf8')).toBe('user development edits');
    expect(f.actualCommands.every(command => command.cwd.startsWith(f.home + '/Library/Application Support/note-app-updater'))).toBe(true);
    expect(f.actualCommands.find(command => command.args.includes('add'))?.args.slice(-2)).toEqual(['origin', UPDATE_REPOSITORY]);
  });
  it('rejects restored Git clean-filter configuration before any checkout Git command can execute it', async () => {
    const repo = await repository(), f = await harness(repo), prepared = (await f.updater.prepare())!;
    const checkout = path.join(prepared.stagePath, 'source'), sentinel = path.join(checkout, '.git/filter-invoked');
    await fs.writeFile(path.join(checkout, '.git/info/attributes'), 'README.md filter=review\n');
    await exec('/usr/bin/git', ['config', 'filter.review.clean', `sh -c 'printf invoked > "${sentinel}"; cat'`], {cwd: checkout});
    const time = new Date(Date.now() + 2000); await fs.utimes(path.join(checkout, 'README.md'), time, time);
    f.actualCommands.length = 0;
    const reopened = new SourceUpdater({home: f.home, current, approvedTarget: {...target(), sourceSha: repo.approvedSha},
      platform: 'darwin', architecture: 'arm64', runner: f.runner, fs: f.fileSystem, now: () => new Date('2026-10-08T12:00:00.000Z')});
    expect((await reopened.restore()).status).toBe('error'); expect(reopened.getPrepared()).toBeNull();
    expect(f.actualCommands.some(command => command.cwd === checkout)).toBe(false);
    await expect(fs.lstat(sentinel)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('rejects corrupted commit bytes stored under the otherwise approved object filename', async () => {
    const repo = await repository(), f = await harness(repo), prepared = (await f.updater.prepare())!;
    const checkout = path.join(prepared.stagePath, 'source');
    const original = (await exec('/usr/bin/git', ['cat-file', 'commit', repo.approvedSha], {cwd: checkout})).stdout;
    const forged = Buffer.from(original + 'tampered commit message\n');
    const object = path.join(checkout, '.git/objects', repo.approvedSha.slice(0, 2), repo.approvedSha.slice(2));
    await fs.mkdir(path.dirname(object), {recursive: true}); await fs.rm(object, {force: true});
    await fs.writeFile(object, deflateSync(Buffer.concat([Buffer.from(`commit ${forged.length}\0`), forged])));
    const reopened = new SourceUpdater({home: f.home, current, approvedTarget: {...target(), sourceSha: repo.approvedSha},
      platform: 'darwin', architecture: 'arm64', runner: f.runner, fs: f.fileSystem, now: () => new Date('2026-10-08T12:00:00.000Z')});
    expect((await reopened.restore()).status).toBe('error'); expect(reopened.getPrepared()).toBeNull();
    expect((await fs.lstat(prepared.appPath)).isDirectory()).toBe(true);
  });
  it('preserves the staged failure, installed app, and developer edits on fetch failure', async () => {
    const repo = await repository(), f = await harness(repo, true), app = path.join(f.home, 'Applications/note-app.app');
    await fs.mkdir(app, {recursive: true}); await fs.writeFile(path.join(app, 'sentinel'), 'old app');
    expect(await f.updater.prepare()).toBeNull(); expect(f.updater.getState().status).toBe('error');
    expect(await fs.readFile(path.join(app, 'sentinel'), 'utf8')).toBe('old app');
    expect(await fs.readFile(path.join(repo.source, 'README.md'), 'utf8')).toBe('user development edits');
    const stages = path.join(f.home, 'Library/Application Support/note-app-updater/stages');
    const staged = await fs.readdir(stages); expect(staged).toHaveLength(1);
    expect((await fs.lstat(path.join(stages, staged[0], 'source/.git'))).isDirectory()).toBe(true);
    expect(f.calls.some(command => command.args[0] === 'ci')).toBe(false);
  });
});

describe('restart-safe prepared update hints', () => {
  const storage = (home: string) => path.join(home, 'Library/Application Support/note-app-updater');
  const statePath = (home: string) => path.join(storage(home), PREPARED_STATE_FILE);
  async function saved(f: Awaited<ReturnType<typeof fixture>>) {
    return JSON.parse(await fs.readFile(statePath(f.home), 'utf8'));
  }
  async function rewrite(f: Awaited<ReturnType<typeof fixture>>, change: (value: any) => void) {
    const value = await saved(f); change(value); await fs.writeFile(statePath(f.home), JSON.stringify(value));
  }
  function failClosed(updater: SourceUpdater) {
    expect(updater.getState().canInstall).toBe(false); expect(updater.getPrepared()).toBeNull();
    expect(['ready', 'deferred']).not.toContain(updater.getState().status);
  }
  it('persists only after lock cleanup and restores ready with all seven stages complete', async () => {
    const f = await fixture(), prepared = await f.updater.prepare(); expect(prepared).not.toBeNull();
    const value = await saved(f);
    expect(value.status).toBe('ready'); expect(value.cleanupComplete).toBe(true); expect(value.target).toEqual(target());
    expect(value.current).toEqual(current); expect(value.stageName).toBe(path.basename(prepared!.stagePath));
    expect(Date.parse(value.expiresAt) - Date.parse(value.preparedAt)).toBe(PREPARED_STATE_MAX_AGE_MS);
    expect((await fs.stat(statePath(f.home))).mode & 0o777).toBe(0o600);
    expect(f.updater.getState().progress).toMatchObject({completed: 7, total: 7});
    const reopened = f.create(); expect((await reopened.restore()).status).toBe('ready');
    expect(reopened.getPrepared()).toEqual(prepared); expect(reopened.getState().progress).toMatchObject({completed: 7, total: 7});
    expect(JSON.stringify(reopened.getState())).not.toContain(f.root);
    expect(await fs.readdir(storage(f.home))).not.toContain('prepare.lock');
  });
  it('awaits a durable defer, retains the preparation expiry, and restores without fetching or rebuilding', async () => {
    const f = await fixture(); await f.updater.prepare(); const before = await saved(f);
    expect((await f.updater.defer()).status).toBe('deferred');
    expect(await saved(f)).toMatchObject({status: 'deferred', preparedAt: before.preparedAt, expiresAt: before.expiresAt});
    f.calls.length = 0; const reopened = f.create(); const state = await reopened.restore();
    expect(state.status).toBe('deferred'); expect(state.canInstall).toBe(true); expect(state.progress).toMatchObject({completed: 7, total: 7});
    expect(f.calls.some(command => command.executable === '/usr/bin/codesign')).toBe(true);
    expect(f.calls.some(command => command.args.includes('fetch') || command.args.includes('checkout')
      || command.args.includes('init') || command.args.includes('ci') || command.args.includes('run'))).toBe(false);
    expect(f.calls.filter(command => command.executable === 'npm').every(command => command.args.join(' ') === '--version')).toBe(true);
  });
  it('never treats on-disk metadata as main approval, and does not create first-launch storage', async () => {
    const fresh = await fixture(); expect((await fresh.updater.restore()).status).toBe('idle');
    expect(await fs.readdir(fresh.home)).toEqual([]); expect(fresh.calls).toHaveLength(0);
    const f = await fixture(); await f.updater.prepare(); const bytes = await fs.readFile(statePath(f.home)); f.calls.length = 0;
    const unpublished = f.create(null); expect((await unpublished.restore()).status).toBe('unavailable'); failClosed(unpublished);
    expect(f.calls).toHaveLength(0); expect(await fs.readFile(statePath(f.home))).toEqual(bytes);
  });
  it.each(['version', 'buildNumber', 'sourceSha', 'lockfileSha256', 'channel', 'repository'])('rejects a changed %s approval', async field => {
    const f = await fixture(); await f.updater.prepare();
    const values = {version: '0.3.0', buildNumber: '3', sourceSha: 'd'.repeat(40), lockfileSha256: 'e'.repeat(64), channel: 'stable', repository: 'https://example.invalid/repo.git'};
    const reopened = f.create({...target(), [field]: values[field as keyof typeof values]}); f.calls.length = 0;
    await reopened.restore(); failClosed(reopened); expect(f.calls).toHaveLength(0);
  });
  it.each(['version', 'buildNumber', 'sourceSha'])('binds the descriptor to the preparing current %s', async field => {
    const f = await fixture(); await f.updater.prepare();
    const values = {version: '0.1.1', buildNumber: '3', sourceSha: 'd'.repeat(40)};
    const reopened = f.create(target(), {current: {...current, [field]: values[field as keyof typeof values]}}); f.calls.length = 0;
    expect((await reopened.restore()).status).toBe('error'); failClosed(reopened); expect(f.calls).toHaveLength(0);
  });
  it.each(['expired', 'future', 'extended', 'unfinished', 'traversal', 'absolute', 'unknown-key'])('rejects %s state before running commands', async kind => {
    const f = await fixture(); const prepared = await f.updater.prepare();
    await rewrite(f, value => {
      if (kind === 'expired') { value.preparedAt = '2026-09-30T12:00:00.000Z'; value.expiresAt = '2026-10-07T12:00:00.000Z'; }
      if (kind === 'future') { value.preparedAt = '2026-10-09T12:00:00.000Z'; value.expiresAt = '2026-10-16T12:00:00.000Z'; }
      if (kind === 'extended') value.expiresAt = '2026-10-16T12:00:00.000Z';
      if (kind === 'unfinished') value.cleanupComplete = false;
      if (kind === 'traversal') value.stageName = '../../developer-source';
      if (kind === 'absolute') value.stageName = prepared!.stagePath;
      if (kind === 'unknown-key') value.command = 'anything';
    });
    f.calls.length = 0; const reopened = f.create(); expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
    expect(f.calls).toHaveLength(0); expect(await fs.readFile(path.join(prepared!.stagePath, 'source/package-lock.json'), 'utf8')).toBe(lock);
  });
  it('rejects expiry at the exact seven-day boundary without extending it through defer', async () => {
    const f = await fixture(); await f.updater.prepare(); await f.updater.defer();
    const reopened = f.create(target(), {now: () => new Date('2026-10-15T12:00:00.000Z')});
    expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
  });
  it.each(['deleted-stage', 'partial-app', 'tampered-bundle', 'tampered-lock', 'protocol', 'unfinished-lock', 'source-symlink', 'state-symlink', 'state-truncated'])('fails closed and preserves remaining bytes for %s', async kind => {
    const f = await fixture(), prepared = (await f.updater.prepare())!;
    const sentinel = path.join(f.root, 'developer-sentinel'); await fs.writeFile(sentinel, 'untouched');
    if (kind === 'deleted-stage') await fs.rm(prepared.stagePath, {recursive: true});
    if (kind === 'partial-app') await fs.rm(path.join(prepared.appPath, 'Contents/Resources/app/dist/main/index.cjs'));
    if (kind === 'tampered-bundle') await fs.writeFile(path.join(prepared.appPath, 'added-file'), 'tampered');
    if (kind === 'tampered-lock') await fs.writeFile(path.join(prepared.stagePath, 'source/package-lock.json'), 'tampered');
    if (kind === 'protocol') {
      const file = path.join(prepared.appPath, 'Contents/Resources/app/package.json');
      const metadata = JSON.parse(await fs.readFile(file, 'utf8')); metadata.updaterProtocolVersion = 2; await fs.writeFile(file, JSON.stringify(metadata));
    }
    if (kind === 'unfinished-lock') await fs.mkdir(path.join(storage(f.home), 'prepare.lock'), {mode: 0o700});
    if (kind === 'source-symlink') {
      await fs.rename(path.join(prepared.stagePath, 'source'), path.join(f.root, 'developer-source'));
      await fs.symlink(path.join(f.root, 'developer-source'), path.join(prepared.stagePath, 'source'));
    }
    if (kind === 'state-symlink') { await fs.rename(statePath(f.home), path.join(f.root, 'state')); await fs.symlink(path.join(f.root, 'state'), statePath(f.home)); }
    if (kind === 'state-truncated') await fs.writeFile(statePath(f.home), '{');
    const reopened = f.create(); expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
    expect(reopened.getState().message).toContain('보존했습니다'); expect(await fs.readFile(sentinel, 'utf8')).toBe('untouched');
    if (kind !== 'deleted-stage') expect((await fs.lstat(prepared.stagePath)).isDirectory()).toBe(true);
  });
  it.each(['info/attributes', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates', 'commondir', 'config.worktree', 'refs/replace/malicious', 'objects/pack/malicious.promisor'])('rejects Git indirection %s before checkout commands', async relative => {
    const f = await fixture(), prepared = (await f.updater.prepare())!, checkout = path.join(prepared.stagePath, 'source');
    const file = path.join(checkout, '.git', relative); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, 'untrusted');
    f.calls.length = 0; const reopened = f.create(); expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
    expect(f.calls.some(command => command.cwd === checkout)).toBe(false);
  });
  it('byte-compares source against committed blobs even when status incorrectly claims clean', async () => {
    const f = await fixture(), prepared = (await f.updater.prepare())!;
    await fs.writeFile(path.join(prepared.stagePath, 'source/package.json'), sourcePackage + ' ');
    const reopened = f.create(); expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
  });
  it.each(['h package.json', 'S package.json'])('rejects unsafe index flag %s', async flag => {
    const f = await fixture(); await f.updater.prepare();
    const runner: UpdateRunner = async command => command.args.includes('ls-files') && command.args.includes('-v')
      ? {stdout: flag + '\0H package-lock.json\0', stderr: ''} : f.runner(command);
    const reopened = f.create(target(), {runner}); expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
  });
  it('rechecks Node runtime and rejects an unsafe, unsupported, or changed executable', async () => {
    const f = await fixture(); await f.updater.prepare();
    for (const nodeResult of ['v22.1.0', '/opt/homebrew/bin/node']) {
      const runner: UpdateRunner = async command => command.executable === 'node'
        && command.args[0] === (nodeResult.startsWith('v') ? '--version' : '-p') ? {stdout: nodeResult, stderr: ''} : f.runner(command);
      const reopened = f.create(target(), {runner}); expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
    }
  });
  it('does not publish ready when preparation lock cleanup or persistence fails', async () => {
    for (const fail of ['cleanup', 'persistence']) {
      const f = await fixture(); const fileSystem = {...f.fileSystem,
        ...(fail === 'cleanup' ? {rmdir: async () => {throw new Error('cleanup failed');}} : {rename: async () => {throw new Error('write failed');}})} as UpdateFileSystem;
      const updater = f.create(target(), {fs: fileSystem}); expect(await updater.prepare()).toBeNull(); failClosed(updater);
      await expect(fs.lstat(statePath(f.home))).rejects.toMatchObject({code: 'ENOENT'});
      expect((await fs.readdir(path.join(storage(f.home), 'stages'))).length).toBe(1);
    }
  });
  it('waits for defer persistence, and a failed defer never claims saved or installable state', async () => {
    const f = await fixture(); let block = false, entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve), barrier = new Promise<void>(resolve => release = resolve);
    const fileSystem = {...f.fileSystem, rename: async (...args: Parameters<typeof fs.rename>) => {
      if (block) {entered(); await barrier; throw new Error('defer write failed');} return fs.rename(...args);
    }} as UpdateFileSystem;
    const updater = f.create(target(), {fs: fileSystem}); await updater.prepare(); block = true;
    let settled = false; const deferred = updater.defer().then(state => {settled = true; return state;}); await waiting;
    expect(settled).toBe(false); expect(updater.getState().canInstall).toBe(false); release();
    expect((await deferred).status).toBe('error'); failClosed(updater); expect((await saved(f)).status).toBe('ready');
  });
  it.each(['restore', 'prepare-before-lock'])('persists unverified process cleanup poison across a %s restart', async operation => {
    const f = await fixture(); const prepared = (await f.updater.prepare())!;
    const bytes = await fs.readFile(statePath(f.home));
    const runner: UpdateRunner = async command => {
      if (operation === 'restore' ? command.args.includes('status') : command.executable === 'node') {
        throw Object.assign(new Error('descendant cleanup unverified'), {code: 'update-cleanup-unverified'});
      }
      return f.runner(command);
    };
    const failedUpdater = f.create(target(), {runner});
    if (operation === 'restore') expect((await failedUpdater.restore()).status).toBe('error');
    else expect(await failedUpdater.prepare()).toBeNull();
    failClosed(failedUpdater); expect((await fs.lstat(path.join(storage(f.home), 'cleanup-unverified'))).isDirectory()).toBe(true);
    if (operation === 'restore') expect((await fs.lstat(path.join(storage(f.home), 'prepare.lock'))).isDirectory()).toBe(true);
    expect(await fs.readFile(statePath(f.home))).toEqual(bytes);
    f.calls.length = 0; const reopened = f.create(); expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
    expect(await f.create().prepare()).toBeNull(); expect(f.calls).toHaveLength(0);
    expect((await fs.lstat(prepared.appPath)).isDirectory()).toBe(true);
  });
  it.each(['check', 'prepare', 'restore'])('holds a durable fence before %s subprocesses, even when writing failure poison is impossible', async operation => {
    const f = await fixture(); await f.updater.prepare();
    let sawFence = false;
    const runner: UpdateRunner = async command => {
      sawFence = (await fs.lstat(path.join(storage(f.home), 'prepare.lock'))).isDirectory();
      throw Object.assign(new Error('descendant cleanup unverified'), {code: 'update-cleanup-unverified'});
    };
    const fileSystem = {...f.fileSystem, mkdir: async (file: string, ...args: any[]) => {
      if (String(file).endsWith('/cleanup-unverified')) throw new Error('disk full');
      return (fs.mkdir as any)(file, ...args);
    }} as UpdateFileSystem;
    const failing = f.create(target(), {runner, fs: fileSystem});
    await failing[operation as 'check' | 'prepare' | 'restore'](); failClosed(failing); expect(sawFence).toBe(true);
    expect((await fs.lstat(path.join(storage(f.home), 'prepare.lock'))).isDirectory()).toBe(true);
    f.calls.length = 0; const reopened = f.create(); expect((await reopened.restore()).status).toBe('error'); failClosed(reopened);
    expect(f.calls).toHaveLength(0);
  });
  it('does not leave a resumable descriptor if cancellation arrives during its atomic publication', async () => {
    const f = await fixture(); let updater!: SourceUpdater;
    const fileSystem = {...f.fileSystem, rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      if (String(args[1]) === statePath(f.home)) void updater.cancel();
    }} as UpdateFileSystem;
    updater = f.create(target(), {fs: fileSystem}); expect(await updater.prepare()).toBeNull();
    expect(updater.getState().status).toBe('cancelled'); failClosed(updater);
    await expect(fs.lstat(statePath(f.home))).rejects.toMatchObject({code: 'ENOENT'});
    expect((await fs.readdir(storage(f.home))).some(name => name.endsWith('.cancelled'))).toBe(true);
    expect((await f.create().restore()).status).toBe('idle');
  });
  it('keeps restore cancellation pending through command cleanup, with no late ready state', async () => {
    let restoring = false, entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve), barrier = new Promise<void>(resolve => release = resolve);
    const f = await fixture({onCommand: async command => {if (restoring && command.executable === '/usr/bin/codesign') {entered(); await barrier;}}});
    const prepared = (await f.updater.prepare())!; restoring = true;
    const reopened = f.create(), restoringState = reopened.restore(); await waiting;
    let settled = false; const cancelled = reopened.cancel().then(state => {settled = true; return state;});
    await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false); failClosed(reopened); release();
    expect((await cancelled).status).toBe('cancelled'); expect((await restoringState).status).toBe('cancelled'); failClosed(reopened);
    expect((await fs.lstat(prepared.appPath)).isDirectory()).toBe(true); expect(await fs.readdir(storage(f.home))).not.toContain('prepare.lock');
  });
});

describe('source updater missing-tool guidance',()=>{
  it.each([['node','Node.js'],['npm','npm'],['/usr/bin/git','Git']])('reports missing %s without installing tools',async(executable,label)=>{
    const f=await fixture();const updater=f.create(target(),{runner:async command=>{if(command.executable===executable)throw Object.assign(Error('not found'),{code:'ENOENT'});return f.runner(command);}});
    const state=await updater.check();expect(state.status).toBe('error');expect(state.message).toContain(label);expect(state.prerequisites.some(item=>!item.ready&&item.label.includes(label))).toBe(true);
    expect(f.calls.some(call=>call.args[0]==='ci'||call.args[0]==='install')).toBe(false);
  });
});
