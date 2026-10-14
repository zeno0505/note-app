import {afterEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {deflateSync} from 'node:zlib';
import {type UpdateCommand,type UpdateFileSystem,type UpdateRunner} from '../../src/main/update/source-updater';
import {SourceReleaseUpdater,type SourceReleaseUpdaterOptions} from '../../src/main/update/source-release-updater';
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
  const create = (overrides: Partial<SourceReleaseUpdaterOptions> = {}) => new SourceReleaseUpdater({home, current, feed:{fetchSourceRelease:async()=>target() as any}, platform: 'darwin', architecture: 'arm64',
    runner, fs: fileSystem, now: () => new Date('2026-10-08T12:00:00.000Z'), ...overrides});
  return {root, home, calls, runner, fileSystem, create, get checkout() {return checkout;}, updater: create()};
}

/** Actual SourceUpdater + private filesystem + dynamic feed, with synthetic Git/npm/codesign responses.
 * This does not certify public network or Mac native installation. */
describe('source feed to prepared artifact integration',()=>{
 it('discovers, prepares, defers and revalidates stored exact source against a fresh feed',async()=>{
  const f=await fixture();expect((await f.updater.check()).status).toBe('available');const prepared=await f.updater.prepare();expect(prepared?.target.sourceSha).toBe(sha);expect(f.updater.getState().canInstall).toBe(true);
  await f.updater.defer();const priorFetches=f.calls.filter(c=>c.args.includes('fetch')).length;const restarted=f.create();await restarted.restore();expect(restarted.getPrepared()).toBeNull();expect((await restarted.check()).status).toBe('deferred');expect(restarted.getPrepared()?.appSha256).toBe(prepared?.appSha256);expect(f.calls.filter(c=>c.args.includes('fetch'))).toHaveLength(priorFetches);
 });
 it('a newly discovered target invalidates prior prepared authority before build',async()=>{
  const f=await fixture();await f.updater.check();await f.updater.prepare();const changed=f.create({feed:{fetchSourceRelease:async()=>({...target(),buildNumber:'3',sourceSha:'e'.repeat(40)} as any)}});await changed.restore();expect((await changed.check()).status).toBe('available');expect(changed.getPrepared()).toBeNull();expect(changed.getState().canInstall).toBe(false);
 });
 it('a missing tool can be repaired externally and rechecked without tool installation or stale state',async()=>{
  const f=await fixture();let missing=true;const updater=f.create({runner:async command=>{if(missing&&command.executable==='node')throw Object.assign(Error('missing'),{code:'ENOENT'});return f.runner(command);}});
  expect((await updater.check()).status).toBe('error');expect(updater.getState().canPrepare).toBe(false);missing=false;expect((await updater.check()).status).toBe('available');expect((await updater.prepare())?.target.sourceSha).toBe(sha);
 });
 it('cancelled source work settles before retry and cannot publish a late artifact',async()=>{
  let release!:()=>void,paused=false;const f=await fixture({onCommand:async command=>{if(command.args.includes('fetch')&&!paused){paused=true;await new Promise<void>(r=>{release=r;});}}});await f.updater.check();const preparing=f.updater.prepare();await vi.waitFor(()=>expect(paused).toBe(true));const cancelling=f.updater.cancel();release();expect(await preparing).toBeNull();await cancelling;expect(f.updater.getPrepared()).toBeNull();expect((await f.updater.check()).status).toBe('available');expect((await f.updater.prepare())?.target.sourceSha).toBe(sha);
 });
});
