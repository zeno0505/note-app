import {finalizeQueryGroup} from '../../collector/orca/process-group';
import * as nativeFs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {hashAppBundle} from '../../../scripts/updater/bundle-integrity.mjs';
import type {UpdateState, UpdateTarget} from '../../shared/update';
import {classifyUpdate, parseApprovedDemoManifest, UPDATE_REPOSITORY, validSha256, validSourceSha,
  type ApprovedDemoManifest, type CurrentUpdateBuild} from './manifest';
import {parsePreparedState, PREPARED_STATE_FILE, PREPARED_STATE_MAX_AGE_MS, type PersistedPreparedState} from './prepared-state';

export interface UpdateCommand {
  executable: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv;
  signal: AbortSignal; timeoutMs: number; maxOutputBytes: number;
}
export interface UpdateCommandResult { stdout: string; stderr: string }
export type UpdateRunner = (command: UpdateCommand) => Promise<UpdateCommandResult>;
export type UpdateFileSystem = Pick<typeof nativeFs, 'lstat' | 'realpath' | 'mkdir' | 'mkdtemp' | 'readFile' | 'writeFile' | 'readdir' | 'rmdir' | 'open' | 'rename'>;
export interface PreparedUpdate {
  readonly target: ApprovedDemoManifest; readonly stagePath: string; readonly appPath: string;
  readonly packageManifestPath: string; readonly sourceTree: string; readonly lockfileSha256: string;
  readonly architecture: 'arm64' | 'x64'; readonly appSha256: string; readonly nodeExecutable: string;
}
export interface SourceUpdaterOptions {
  home: string; current: CurrentUpdateBuild; approvedTarget?: unknown; recovery?: boolean;
  platform?: NodeJS.Platform; architecture?: string; runner?: UpdateRunner; fs?: UpdateFileSystem;
  onState?: (state: UpdateState) => void; now?: () => Date;
}
class UpdateFailure extends Error { constructor(readonly publicMessage: string) { super(publicMessage); } }
const failed = (message: string): never => { throw new UpdateFailure(message); };
const abortError = () => Object.assign(new Error('Update preparation cancelled'), {name: 'AbortError'});
/** No shell, no inherited credentials, bounded output/runtime, cancellation waits for child close. */
export const runBoundedUpdateCommand: UpdateRunner = command => new Promise((resolve, reject) => {
  if (command.signal.aborted) { reject(abortError()); return; }
  const child = spawn(command.executable, [...command.args], {cwd: command.cwd, env: command.env,
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true});
  let stdout = '', stderr = '', bytes = 0, failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanup:Promise<boolean>|undefined;
  const drain=()=>cleanup??=finalizeQueryGroup(child).then(verified=>{if(!verified){failure=Object.assign(new Error('Updater process cleanup unverified'),{code:'update-cleanup-unverified'});child.stdout?.destroy();child.stderr?.destroy();}return verified;});
  const signalGroup = (signal: NodeJS.Signals) => {
    try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already drained. */ }
  };
  const stop = (error: Error) => {
    if (failure) return;
    failure = error; signalGroup('SIGTERM');void drain();
    killTimer = setTimeout(() => signalGroup('SIGKILL'), 500); killTimer.unref();
  };
  const abort = () => stop(abortError());
  const timer = setTimeout(() => stop(new Error('Update command timed out')), command.timeoutMs); timer.unref();
  command.signal.addEventListener('abort', abort, {once: true});
  // A signal can arrive between the initial check and listener registration.
  if (command.signal.aborted) abort();
  const collect = (which: 'stdout' | 'stderr', chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > command.maxOutputBytes) { stop(new Error('Update command exceeded its output limit')); return; }
    if (which === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
  };
  child.stdout?.on('data', chunk => collect('stdout', chunk)); child.stderr?.on('data', chunk => collect('stderr', chunk));
  child.on('error', error => { failure ??= error;void drain(); });
  child.once('exit',()=>{void drain();});
  child.once('close', async code => {
    await drain();
    if (failure) signalGroup('SIGKILL'); // Also stop descendants that closed inherited pipes.
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer); command.signal.removeEventListener('abort', abort);
    if (failure) reject(failure); else if (code !== 0) reject(new Error('Update command failed')); else resolve({stdout, stderr});
  });
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const gitConfig = ['-c', 'credential.helper=', '-c', 'core.askPass=/usr/bin/false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'http.extraHeader=', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];

export class SourceUpdater {
  private readonly fs: UpdateFileSystem;
  private readonly runner: UpdateRunner;
  private readonly root: string;
  private readonly current: CurrentUpdateBuild;
  private target: ApprovedDemoManifest | null = null;
  private targetError = false;
  private state: UpdateState;
  private prepared: PreparedUpdate | null = null;
  private controller: AbortController | null = null;
  private active: Promise<unknown> | null = null;
  private prepareFlight: Promise<PreparedUpdate | null> | null = null;
  private nodeExecutable: string | null = null;
  private cleanupUnverified=false;
  private persisted: PersistedPreparedState | null = null;
  constructor(private readonly options: SourceUpdaterOptions) {
    this.fs = options.fs ?? nativeFs; this.runner = options.runner ?? runBoundedUpdateCommand;
    this.current = {...options.current};
    this.root = path.join(options.home, 'Library', 'Application Support', 'note-app-updater');
    if (options.approvedTarget !== undefined && options.approvedTarget !== null) {
      try { this.target = parseApprovedDemoManifest(options.approvedTarget); } catch { this.targetError = true; }
    }
    this.state = {status: 'idle', current: {...this.current}, target: this.publicTarget(), message: '승인된 데모 업데이트를 확인해 주세요',
      checkedAt: null, progress: null, prerequisites: [], canCheck: true, canPrepare: false, canCancel: false, canDefer: false, canInstall: false};
  }
  getState(): UpdateState { return structuredClone(this.state); }
  getPrepared(): PreparedUpdate | null { return ['ready', 'deferred'].includes(this.state.status) ? this.prepared : null; }
  private publicTarget(): UpdateTarget | null { return this.target ? {version: this.target.version, buildNumber: this.target.buildNumber,
    sourceSha: this.target.sourceSha, changelog: [...this.target.changelog], publishedAt: this.target.publishedAt} : null; }
  private emit(status: UpdateState['status'], message: string, step?: string, completed = 0): UpdateState {
    this.state = {...this.state, status, message, target: this.publicTarget(),
      progress: step ? {step, completed, total: 7} : null,
      canCheck: !['checking', 'preparing', 'installing'].includes(status), canPrepare: !!this.target && ['available', 'cancelled', 'error'].includes(status),
      canCancel: ['checking', 'preparing'].includes(status), canDefer: status === 'ready', canInstall: ['ready', 'deferred'].includes(status) && !!this.prepared};
    try { this.options.onState?.(this.getState()); } catch { /* A view listener cannot change the transaction. */ }
    return this.getState();
  }
  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private assertNotCancelled(signal: AbortSignal) { if (signal.aborted) throw abortError(); }
  private async regularDirectory(dir: string, privateDirectory = false) {
    const stat = await this.fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await this.fs.realpath(dir) !== dir
      || (process.geteuid && stat.uid !== process.geteuid()) || (stat.mode & 0o022) !== 0
      || (privateDirectory && (stat.mode & 0o077) !== 0)) failed('업데이트 저장 폴더가 안전하지 않아 중단했습니다');
  }
  private async ensureDirectory(dir: string, privateDirectory = false) {
    try { await this.fs.mkdir(dir, {mode: 0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await this.regularDirectory(dir, privateDirectory);
  }
  private assertInside(file: string) {
    const relative = path.relative(this.root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.resolve(file) !== file) failed('업데이트 경로를 확인할 수 없어 중단했습니다');
  }
  private async guardPath(file: string, kind: 'file' | 'directory', maxBytes = 256 * 1024) {
    this.assertInside(file); await this.regularDirectory(this.root, true);
    const parts = path.relative(this.root, file).split(path.sep); let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]); const stat = await this.fs.lstat(current);
      if (stat.isSymbolicLink() || await this.fs.realpath(current) !== current || (process.geteuid && stat.uid !== process.geteuid())) failed('업데이트 경로가 변경되어 중단했습니다');
      if (i < parts.length - 1 || kind === 'directory') { if (!stat.isDirectory() || (stat.mode & 0o022)) failed('업데이트 폴더가 안전하지 않아 중단했습니다'); }
      else if (!stat.isFile() || stat.size > maxBytes || stat.nlink !== 1 || (stat.mode & 0o022)) failed('업데이트 정보가 올바르지 않습니다');
    }
  }
  private async readBytes(file: string, maxBytes: number): Promise<Buffer> {
    await this.guardPath(file, 'file', maxBytes); const expected = await this.fs.lstat(file);
    const handle = await this.fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.ino !== expected.ino || before.dev !== expected.dev || before.size > maxBytes || before.nlink !== 1) failed('검증 중 업데이트 파일이 변경되어 중단했습니다');
      const buffer = Buffer.alloc(before.size + 1); let offset = 0;
      while (offset < buffer.length) { const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      const after = await handle.stat();
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) failed('검증 중 업데이트 파일이 변경되어 중단했습니다');
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }
  private async readJSON(file: string, maxBytes = 256 * 1024): Promise<unknown> {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await this.readBytes(file, maxBytes)));
  }
  private async initializeStorage() {
    const home = this.options.home;
    if (!path.isAbsolute(home) || path.resolve(home) !== home) failed('업데이트용 사용자 폴더를 확인할 수 없습니다');
    await this.regularDirectory(home);
    await this.ensureDirectory(path.join(home, 'Library')); await this.ensureDirectory(path.join(home, 'Library', 'Application Support'));
    let created = false;
    try { await this.fs.mkdir(this.root, {mode: 0o700}); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await this.regularDirectory(this.root, true);
    const marker = path.join(this.root, 'owner.json');
    if (created) await this.fs.writeFile(marker, JSON.stringify({schemaVersion: 1, repository: UPDATE_REPOSITORY}), {mode: 0o600, flag: 'wx'});
    const owner = await this.readJSON(marker, 1024);
    if (!record(owner) || owner.schemaVersion !== 1 || owner.repository !== UPDATE_REPOSITORY || Object.keys(owner).length !== 2) failed('이 앱이 만든 업데이트 폴더인지 확인할 수 없습니다');
    for (const name of ['stages', 'runtime-home', 'tmp']) await this.ensureDirectory(path.join(this.root, name), true);
    const npmConfig = path.join(this.root, 'npmrc');
    try { await this.fs.writeFile(npmConfig, '', {mode: 0o600, flag: 'wx'}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await this.guardPath(npmConfig, 'file', 0);

  }
  private async existingStorage() {
    if (!path.isAbsolute(this.options.home) || path.resolve(this.options.home) !== this.options.home) failed('업데이트용 사용자 폴더를 확인할 수 없습니다');
    await this.regularDirectory(this.options.home);
    await this.regularDirectory(path.join(this.options.home, 'Library'));
    await this.regularDirectory(path.join(this.options.home, 'Library', 'Application Support'));
    await this.regularDirectory(this.root, true);
    const owner = await this.readJSON(path.join(this.root, 'owner.json'), 1024);
    if (!record(owner) || owner.schemaVersion !== 1 || owner.repository !== UPDATE_REPOSITORY || Object.keys(owner).length !== 2) failed('이 앱이 만든 업데이트 폴더인지 확인할 수 없습니다');
    for (const name of ['stages', 'runtime-home', 'tmp']) await this.regularDirectory(path.join(this.root, name), true);
    await this.guardPath(path.join(this.root, 'npmrc'), 'file', 0);
  }
  private async assertPreparationFinished() {
    for (const name of ['prepare.lock', 'cleanup-unverified']) {
      try { await this.fs.lstat(path.join(this.root, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      failed('이전 업데이트 준비의 정리를 확인하지 못했습니다. 준비한 파일은 보존했습니다');
    }
  }
  private async markCleanupUnverified() {
    // Durable poison survives a restart, including failures before prepare.lock was acquired.
    // Never remove it automatically: an unverified descendant may still own staged bytes.
    await this.regularDirectory(this.root, true);
    try { await this.fs.mkdir(path.join(this.root, 'cleanup-unverified'), {mode: 0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const directory = await this.fs.open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async acquirePreparationFence() {
    if ((this.options.platform ?? process.platform) !== 'darwin') failed('소스 업데이트는 macOS에서만 준비할 수 있습니다. 현재 환경에서는 동작 계약만 시험할 수 있습니다');
    if (!['arm64', 'x64'].includes(this.options.architecture ?? process.arch)) failed('이 Mac의 아키텍처는 지원하지 않습니다');
    await this.initializeStorage();
    // Acquire and durably record the fence BEFORE any child starts. A post-failure
    // marker alone cannot protect an old descriptor when the filesystem is full.
    try { await this.fs.lstat(path.join(this.root, 'cleanup-unverified')); failed('이전 준비 프로세스 정리를 확인하지 못했습니다. 준비한 파일은 보존했습니다'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const lock = path.join(this.root, 'prepare.lock');
    try { await this.fs.mkdir(lock, {mode: 0o700}); } catch { failed('다른 업데이트 준비가 진행 중이거나 이전 정리가 끝나지 않았습니다. 중복 실행하지 않았습니다'); }
    await this.guardPath(lock, 'directory');
    const directory = await this.fs.open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async persist(saved: PersistedPreparedState, signal: AbortSignal) {
    await this.existingStorage(); await this.assertPreparationFinished(); this.assertNotCancelled(signal);
    // Re-parse our own descriptor as well: deferring must not extend the original expiry.
    parsePreparedState(saved, this.target!, this.current, this.options.architecture ?? process.arch, Date.parse(this.now()));
    const destination = path.join(this.root, PREPARED_STATE_FILE), temporary = path.join(this.root, `prepared-${randomUUID()}.pending`);
    try { await this.fs.lstat(destination); await this.guardPath(destination, 'file', 16 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const handle = await this.fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(saved)); await handle.sync(); }
    finally { await handle.close(); }
    await this.guardPath(temporary, 'file', 16 * 1024); await this.assertPreparationFinished(); this.assertNotCancelled(signal);
    await this.fs.rename(temporary, destination);
    // Persist the directory entry before claiming a restart-safe update.
    const directory = await this.fs.open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    if (signal.aborted) {
      // Preserve all bytes, but a cancelled operation must not leave a resumable pointer.
      await this.fs.rename(destination, path.join(this.root, `prepared-${randomUUID()}.cancelled`));
      throw abortError();
    }
  }
  /** Startup-only local revalidation. The descriptor can never select an update target. */
  restore(): Promise<UpdateState> {
    if (this.prepared && !this.active) return Promise.resolve(this.getState());
    if (this.active) return this.active.then(() => this.getState(), () => this.getState());
    if (!this.target) return Promise.resolve(this.emit('unavailable', this.targetError
      ? '승인된 데모 업데이트 정보가 올바르지 않습니다' : '아직 승인된 데모 업데이트가 게시되지 않았습니다'));
    const controller = new AbortController(); this.controller = controller;
    const work = (async (): Promise<{saved: PersistedPreparedState; prepared: PreparedUpdate} | null> => {
      let lockHeld = false, cleanupComplete = true;
      let result: {saved: PersistedPreparedState; prepared: PreparedUpdate} | null = null;
      try {
        // A first launch has no descriptor. Do not create storage merely by starting the app.
        try { await this.fs.lstat(this.root); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        await this.existingStorage();
        const descriptor = path.join(this.root, PREPARED_STATE_FILE);
        try { await this.fs.lstat(descriptor); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        this.emit('checking', '저장된 업데이트의 승인 정보와 파일을 다시 검증합니다', '저장된 준비 상태 검증', 0);
        this.state.checkedAt = this.now();
        if (Date.parse(this.target!.publishedAt) > Date.parse(this.now())
          || classifyUpdate(this.target!, this.current, this.options.recovery === true) !== 'available') throw new Error('Changed approval');
        const saved = parsePreparedState(await this.readJSON(descriptor, 16 * 1024), this.target!, this.current,
          this.options.architecture ?? process.arch, Date.parse(this.now()));
        await this.assertPreparationFinished();
        await this.acquirePreparationFence(); lockHeld = true;
        const stage = path.join(this.root, 'stages', saved.stageName);
        await this.guardPath(stage, 'directory'); await this.regularDirectory(stage, true);
        await this.guardPath(path.join(stage, 'source'), 'directory'); await this.guardPath(path.join(stage, 'output'), 'directory');
        await this.prerequisites(controller.signal);
        if (this.nodeExecutable !== saved.nodeExecutable) failed('저장된 업데이트의 Node.js 실행 환경이 변경되었습니다');
        const sourceTree = await this.sourceIdentity(path.join(stage, 'source'), controller.signal);
        if (sourceTree !== saved.sourceTree) throw new Error('Changed source tree');
        const prepared = await this.validateBundle(stage, sourceTree, controller.signal);
        if (prepared.appSha256 !== saved.appSha256 || prepared.architecture !== saved.architecture
          || await this.sourceIdentity(path.join(stage, 'source'), controller.signal) !== sourceTree) throw new Error('Changed prepared artifact');
        const reread = parsePreparedState(await this.readJSON(descriptor, 16 * 1024), this.target!, this.current,
          this.options.architecture ?? process.arch, Date.parse(this.now()));
        if (JSON.stringify(reread) !== JSON.stringify(saved)) throw new Error('Changed resume descriptor');
        this.assertNotCancelled(controller.signal); result = {saved, prepared};
      } catch (error) {
        this.prepared = null; this.persisted = null;
        if (controller.signal.aborted) this.handleFailure(error, controller.signal);
        else this.emit('error', '저장된 업데이트를 복원하지 못했습니다. 만료, 현재 빌드 변경, 파일 누락 또는 검증 실패를 확인해 주세요. 파일은 보존했습니다');
      } finally {
        if (lockHeld && !this.cleanupUnverified) {
          try { const lock = path.join(this.root, 'prepare.lock'); await this.guardPath(lock, 'directory'); await this.fs.rmdir(lock); }
          catch { cleanupComplete = false; this.emit('error', '복원 검증 잠금을 정리하지 못했습니다. 준비한 파일은 보존했습니다'); }
        }
      }
      return cleanupComplete ? result : null;
    })();
    const tracked = work.then(result => {
      if (controller.signal.aborted) return this.handleFailure(abortError(), controller.signal);
      if (!result) return this.getState();
      this.prepared = result.prepared; this.persisted = result.saved;
      return this.emit(result.saved.status, result.saved.status === 'deferred'
        ? '저장된 업데이트의 파일을 다시 검증했습니다. 나중에 설치할 수 있습니다'
        : '저장된 업데이트의 파일을 다시 검증했습니다. 확인 후 설치할 수 있습니다', '준비 완료', 7);
    }).finally(() => { if (this.active === tracked) this.active = null; if (this.controller === controller) this.controller = null; });
    this.active = tracked; return tracked;
  }
  private environment(): NodeJS.ProcessEnv {
    return {PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin', HOME: path.join(this.root, 'runtime-home'),
      TMPDIR: path.join(this.root, 'tmp'), LANG: 'C', LC_ALL: 'C', CI: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
      SSH_ASKPASS: '/usr/bin/false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'https',
      GIT_CONFIG_COUNT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
      NPM_CONFIG_USERCONFIG: path.join(this.root, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: '/dev/null',
      NPM_CONFIG_CACHE: path.join(this.root, 'runtime-home', '.npm'), NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_PROGRESS: 'false'};
  }
  private async run(executable: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs = 120_000) {
    this.assertNotCancelled(signal); if (cwd === this.root) await this.regularDirectory(this.root, true); else await this.guardPath(cwd, 'directory');
    let result:UpdateCommandResult;
    try{result = await this.runner({executable, args, cwd, env: this.environment(), signal, timeoutMs, maxOutputBytes: 4 * 1024 * 1024});}
    catch(error){if((error as NodeJS.ErrnoException).code==='update-cleanup-unverified'){this.cleanupUnverified=true;await this.markCleanupUnverified();}throw error;}
    this.assertNotCancelled(signal); return result.stdout.trim();
  }
  private git(args: string[], cwd: string, signal: AbortSignal) { return this.run('/usr/bin/git', [...gitConfig, ...args], cwd, signal); }
  private async prerequisites(signal: AbortSignal) {
    if(this.cleanupUnverified)failed('이전 준비 프로세스 정리를 확인하지 못했습니다. 잠금을 보존했으므로 전용 업데이트 폴더와 남은 프로세스를 점검해 주세요');
    if ((this.options.platform ?? process.platform) !== 'darwin') failed('소스 업데이트는 macOS에서만 준비할 수 있습니다. 현재 환경에서는 동작 계약만 시험할 수 있습니다');
    if (!['arm64', 'x64'].includes(this.options.architecture ?? process.arch)) failed('이 Mac의 아키텍처는 지원하지 않습니다');
    await this.initializeStorage();
    try { await this.fs.lstat(path.join(this.root, 'cleanup-unverified')); failed('이전 준비 프로세스 정리를 확인하지 못했습니다. 준비한 파일은 보존했습니다'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.state.prerequisites = [{id:'macos',label:'macOS',ready:true},{id:'node',label:'Node.js 24+',ready:false,detail:'확인 중'},
      {id:'npm',label:'npm',ready:false,detail:'확인 중'},{id:'git',label:'Git',ready:false,detail:'확인 중'},{id:'storage',label:'전용 업데이트 저장 폴더',ready:true}];
    const probe=async(id:string,run:()=>Promise<string>,message:string):Promise<string>=>{
      try{return await run();}catch(error){
        if(signal.aborted||this.cleanupUnverified)throw error;
        this.state.prerequisites=this.state.prerequisites.map(item=>item.id===id?{...item,ready:false,detail:message}:item);
        return failed(message);
      }
    };
    const ready=(id:string,detail:string)=>{this.state.prerequisites=this.state.prerequisites.map(item=>item.id===id?{...item,ready:true,detail}:item);};
    const node = await probe('node',()=>this.run('node', ['--version'], this.root, signal),'Node.js 24 이상을 찾지 못했습니다. 설치 여부와 시스템 경로를 확인한 뒤 업데이트 확인을 다시 눌러 주세요');
    if (!/^v\d+\.\d+\.\d+$/.test(node) || Number(node.slice(1).split('.')[0]) < 24) failed('업데이트 준비 전에 Node.js 24 이상을 설치해 주세요');
    const nodeExecutable = await probe('node',()=>this.run('node', ['-p', 'process.execPath'], this.root, signal),'Node.js 실행 경로를 확인하지 못했습니다. 시스템 설치를 확인해 주세요');
    if (!path.isAbsolute(nodeExecutable) || path.resolve(nodeExecutable) !== nodeExecutable || path.basename(nodeExecutable) !== 'node'
      || !['/usr/bin/', '/usr/local/', '/opt/homebrew/'].some(prefix => nodeExecutable.startsWith(prefix))) failed('Node.js를 지원되는 시스템 경로에 설치해 주세요');
    const nodeStat = await this.fs.lstat(nodeExecutable);
    if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || (nodeStat.mode & 0o022) || await this.fs.realpath(nodeExecutable) !== nodeExecutable) failed('Node.js 실행 파일의 안전성을 확인할 수 없습니다');
    this.nodeExecutable = nodeExecutable;ready('node',node);
    const npm = await probe('npm',()=>this.run('npm', ['--version'], this.root, signal),'npm을 찾지 못했습니다. Node.js 설치에 npm이 포함되어 있는지 확인해 주세요');
    if (!/^\d+\.\d+\.\d+$/.test(npm)) failed('지원되는 npm 설치가 필요합니다');
    ready('npm',npm);
    const git = await probe('git',()=>this.git(['--version'], this.root, signal),'Git 명령줄 도구를 찾지 못했습니다. Mac의 Git 설치 상태를 확인해 주세요');
    if (!/^git version \d+\.\d+/.test(git)) failed('Git 명령줄 도구가 필요합니다');
    ready('git',git);
  }
  check(): Promise<UpdateState> {
    if (this.prepared && !this.active) return Promise.resolve(this.getState());
    if (this.active) return this.active.then(() => this.getState(), () => this.getState());
    const controller = new AbortController(); this.controller = controller; this.emit('checking', '승인된 데모 업데이트를 확인합니다');
    const work = (async () => {
      let lockHeld = false;
      this.state.checkedAt = this.now();
      try {
        if (!this.target) return this.emit('unavailable', this.targetError ? '승인된 데모 업데이트 정보가 올바르지 않습니다' : '아직 승인된 데모 업데이트가 게시되지 않았습니다');
        if (Date.parse(this.target.publishedAt) > Date.parse(this.now())) return this.emit('unavailable', '승인된 데모 업데이트의 게시 시각 전입니다');
        const result = classifyUpdate(this.target, this.current, this.options.recovery === true);
        if (result === 'up-to-date') return this.emit('up-to-date', '현재 승인된 데모 빌드가 이미 설치되어 있습니다');
        await this.acquirePreparationFence(); lockHeld = true;
        await this.prerequisites(controller.signal);
        return this.emit('available', '승인된 데모 업데이트를 준비할 수 있습니다');
      } catch (error) { return this.handleFailure(error, controller.signal); }
      finally {
        if (lockHeld && !this.cleanupUnverified) {
          try { const lock = path.join(this.root, 'prepare.lock'); await this.guardPath(lock, 'directory'); await this.fs.rmdir(lock); }
          catch { this.emit('error', '업데이트 확인 잠금을 정리하지 못했습니다. 준비한 파일은 보존했습니다'); }
        }
      }
    })();
    const tracked = work.then(() => this.getState()).finally(() => { if (this.active === tracked) this.active = null; if (this.controller === controller) this.controller = null; });
    this.active = tracked; return tracked;
  }
  private handleFailure(error: unknown, signal: AbortSignal) {
    return signal.aborted ? this.emit('cancelled', '업데이트 준비를 취소했습니다. 설치된 앱은 그대로입니다')
      : this.emit('error', error instanceof UpdateFailure ? error.publicMessage : '업데이트 준비에 실패했습니다. 설치된 앱은 그대로입니다');
  }
  private async safeGitMetadata(checkout: string) {
    const git = path.join(checkout, '.git'); await this.guardPath(git, 'directory');
    // Git status can execute clean filters from local config. Never invoke Git in
    // a restored checkout until its config and indirection points are constrained.
    const config = new TextDecoder('utf-8', {fatal: true}).decode(await this.readBytes(path.join(git, 'config'), 16 * 1024));
    const allowed = new Map<string, readonly string[]>([
      ['core.repositoryformatversion', ['0']], ['core.filemode', ['true', 'false']], ['core.bare', ['false']],
      ['core.logallrefupdates', ['true']], ['core.ignorecase', ['true', 'false']], ['core.precomposeunicode', ['true', 'false']],
      ['remote.url', [UPDATE_REPOSITORY]], ['remote.fetch', ['+refs/heads/*:refs/remotes/origin/*']],
    ]);
    let section = ''; const seen = new Set<string>(), sections = new Set<string>();
    for (const raw of config.split('\n')) {
      const line = raw.trim(); if (!line) continue;
      if (line === '[core]' || line === '[remote "origin"]') {
        section = line === '[core]' ? 'core' : 'remote';
        if (sections.has(section)) failed('업데이트 Git 설정이 안전하지 않습니다'); sections.add(section); continue;
      }
      const entry = /^([a-zA-Z]+)\s*=\s*(\S+)$/.exec(line), key = `${section}.${entry?.[1].toLowerCase()}`;
      if (!entry || seen.has(key) || !allowed.get(key)?.includes(entry[2])) failed('업데이트 Git 설정이 안전하지 않습니다');
      seen.add(key);
    }
    if (['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'remote.url', 'remote.fetch'].some(key => !seen.has(key))) failed('업데이트 Git 설정이 완전하지 않습니다');
    const forbidden = new Set(['config.worktree', 'commondir', 'gitdir', 'info/attributes', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates', 'refs/replace', 'worktrees']);
    let count = 0;
    const walk = async (relative: string): Promise<void> => {
      const file = path.join(git, relative), stat = await this.fs.lstat(file);
      if (++count > 30_000 || forbidden.has(relative.toLowerCase()) || relative.toLowerCase().endsWith('.promisor') || stat.isSymbolicLink()) failed('업데이트 Git 정보에 허용되지 않은 링크나 확장 기능이 있습니다');
      if (stat.isDirectory()) {
        await this.guardPath(file, 'directory');
        for (const name of await this.fs.readdir(file)) await walk(relative ? `${relative}/${name}` : name);
      } else await this.guardPath(file, 'file', 256 * 1024 * 1024);
    };
    await walk('');
    try {
      const refs = new TextDecoder('utf-8', {fatal: true}).decode(await this.readBytes(path.join(git, 'packed-refs'), 4 * 1024 * 1024));
      if (refs.includes('refs/replace/')) failed('업데이트 Git 객체 대체 정보가 있습니다');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async sourceIdentity(checkout: string, signal: AbortSignal) {
    await this.safeGitMetadata(checkout);
    // rev-parse/ls-tree alone trust object names. Verify stored commit/tree/blob
    // object hashes too, with lazy fetching and replacement objects disabled.
    await this.git(['fsck', '--full', '--no-reflogs'], checkout, signal);
    if (await this.git(['rev-parse', 'HEAD'], checkout, signal) !== this.target!.sourceSha) failed('준비한 소스가 승인된 커밋과 일치하지 않습니다');
    if (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], checkout, signal) !== 'HEAD') failed('업데이트 소스가 승인된 커밋에 고정되지 않았습니다');
    if (await this.git(['status', '--porcelain', '--untracked-files=all'], checkout, signal)) failed('업데이트 소스 폴더에 변경 사항이 있어 중단했습니다. 변경 내용은 보존했습니다');
    if (await this.git(['remote', 'get-url', 'origin'], checkout, signal) !== UPDATE_REPOSITORY) failed('업데이트 저장소 정보가 변경되었습니다');
    const tree = await this.git(['rev-parse', 'HEAD^{tree}'], checkout, signal);
    if (!validSourceSha(tree)) failed('소스 트리 검증 정보가 없습니다');
    const tracked = await this.git(['ls-files', '-s', '-z'], checkout, signal);
    const entries = tracked.split('\0').filter(Boolean); if (!entries.length || entries.length > 20_000) failed('업데이트 소스 파일 수가 허용 범위를 벗어났습니다');
    const flags = (await this.git(['ls-files', '-v', '-z'], checkout, signal)).split('\0').filter(Boolean);
    if (flags.length !== entries.length || flags.some(entry => !entry.startsWith('H '))) failed('업데이트 Git 인덱스에 확인을 생략하는 표시가 있습니다');
    const committed = (await this.git(['ls-tree', '-r', '-z', 'HEAD'], checkout, signal)).split('\0').filter(Boolean);
    if (committed.length !== entries.length) failed('업데이트 Git 인덱스가 승인된 트리와 일치하지 않습니다');
    const committedFiles = new Map<string, {mode: string; sha: string}>();
    for (const entry of committed) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(entry);
      if (!match || committedFiles.has(match[3])) failed('승인된 소스 트리에 안전하지 않은 항목이 있습니다');
      committedFiles.set(match![3], {mode: match![1], sha: match![2]});
    }
    const trackedNames = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const match = /^(100644|100755) [a-f0-9]{40} 0\t([^\0]+)$/.exec(entry);
      if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(match[2]) || match[2].includes('\\')) failed('업데이트 소스에 안전하지 않은 경로나 링크가 있습니다');
      if (trackedNames.has(match![2]) || flags[index] !== `H ${match![2]}`) failed('업데이트 Git 인덱스가 완전하지 않습니다');
      trackedNames.add(match![2]);
      const committed = committedFiles.get(match![2]), file = path.join(checkout, match![2]);
      const bytes = await this.readBytes(file, 16 * 1024 * 1024);
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (!committed || committed.mode !== match![1] || !entry.startsWith(`${committed.mode} ${committed.sha} 0\t`)
        || blob !== committed.sha || ((await this.fs.lstat(file)).mode & 0o111 ? '100755' : '100644') !== committed.mode) failed(match![2] === 'package-lock.json'
          ? '의존성 잠금 파일이 승인된 업데이트와 일치하지 않습니다' : '소스 파일이 승인된 Git 객체와 일치하지 않습니다');
    }
    const lockPath = path.join(checkout, 'package-lock.json'); await this.guardPath(lockPath, 'file', 4 * 1024 * 1024);
    if (hash(await this.readBytes(lockPath, 4 * 1024 * 1024)) !== this.target!.lockfileSha256) failed('의존성 잠금 파일이 승인된 업데이트와 일치하지 않습니다');
    const pkg = await this.readJSON(path.join(checkout, 'package.json'));
    if (!record(pkg) || pkg.name !== 'note-app' || pkg.version !== this.target!.version || !record(pkg.scripts)
      || ['check', 'build', 'setup:electron', 'package:mac:local'].some(name => typeof (pkg.scripts as Record<string, unknown>)[name] !== 'string')) failed('소스 패키지가 승인된 업데이트와 일치하지 않습니다');
    return tree;
  }
  private async validateBundle(stage: string, sourceTree: string, signal: AbortSignal): Promise<PreparedUpdate> {
    const appPath = path.join(stage, 'output', 'note-app.app');
    await this.guardPath(appPath, 'directory');
    const packageManifestPath = appPath + '.manifest.json', manifest = await this.readJSON(packageManifestPath);
    const metadata = await this.readJSON(path.join(appPath, 'Contents', 'Resources', 'app', 'package.json'));
    if (!record(manifest) || manifest.kind !== 'local-mac-app' || manifest.sourceSha !== this.target!.sourceSha || manifest.sourceTree !== sourceTree
      || manifest.version !== this.target!.version || manifest.buildNumber !== this.target!.buildNumber || manifest.lockfileSha256 !== this.target!.lockfileSha256
      || manifest.role !== 'user' || manifest.bundleId !== 'dev.noteapp.local' || manifest.architecture !== (this.options.architecture ?? process.arch)
      || manifest.adHocSignatureVerified !== true || manifest.configuration !== 'external-private-config' || manifest.modelCalls !== 0
      || !validSha256(manifest.appSha256) || !validSha256(manifest.entrySha256) || !validSha256(manifest.preloadSha256)
      || !record(metadata) || metadata.updaterProtocolVersion !== 1 || metadata.name !== 'note-app' || metadata.version !== this.target!.version || metadata.sourceSha !== this.target!.sourceSha
      || !record(metadata.installation) || metadata.installation.role !== 'user' || metadata.installation.buildNumber !== this.target!.buildNumber) throw new UpdateFailure('준비한 앱의 빌드 정보가 올바르지 않습니다');
    for (const [relative, digest] of [['dist/main/index.cjs', manifest.entrySha256], ['dist/preload/index.cjs', manifest.preloadSha256]] as const) {
      const file = path.join(appPath, 'Contents', 'Resources', 'app', relative); await this.guardPath(file, 'file', 32 * 1024 * 1024);
      if (hash(await this.readBytes(file, 32 * 1024 * 1024)) !== digest) failed('준비한 앱 파일이 검증 정보와 일치하지 않습니다');
    }
    if (await hashAppBundle(appPath) !== manifest.appSha256) failed('준비한 앱 전체가 검증 정보와 일치하지 않습니다');
    await this.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], stage, signal, 120_000);
    if (await hashAppBundle(appPath) !== manifest.appSha256) failed('서명 검증 중 준비한 앱이 변경되었습니다');
    this.assertNotCancelled(signal);
    return Object.freeze({target: this.target!, stagePath: stage, appPath, packageManifestPath, sourceTree,
      lockfileSha256: this.target!.lockfileSha256, architecture: manifest.architecture as 'arm64' | 'x64',
      appSha256: manifest.appSha256 as string, nodeExecutable: this.nodeExecutable!});
  }
  prepare(): Promise<PreparedUpdate | null> {
    if (this.prepareFlight) return this.prepareFlight;
    if (this.active) return Promise.resolve(null);
    if (this.prepared) return Promise.resolve(this.prepared);
    const controller = new AbortController(); this.controller = controller;
    const work = (async (): Promise<PreparedUpdate | null> => {
      let lockHeld = false;
      try {
        if (!this.target || Date.parse(this.target.publishedAt) > Date.parse(this.now())) { this.emit('unavailable', '아직 유효한 승인 데모 업데이트가 게시되지 않았습니다'); return null; }
        if (classifyUpdate(this.target, this.current, this.options.recovery === true) === 'up-to-date') { this.emit('up-to-date', '현재 승인된 데모 빌드가 이미 설치되어 있습니다'); return null; }
        this.emit('preparing', '승인된 데모 업데이트를 준비합니다', '도구와 전용 저장 폴더 확인', 0);
        await this.acquirePreparationFence(); lockHeld = true;
        await this.prerequisites(controller.signal);
        const stage = await this.fs.mkdtemp(path.join(this.root, 'stages', 'build-')); await this.guardPath(stage, 'directory');
        const checkout = path.join(stage, 'source'), output = path.join(stage, 'output');
        await this.ensureDirectory(checkout, true); await this.ensureDirectory(output, true);
        this.emit('preparing', '승인된 공개 소스 커밋을 가져옵니다', '승인된 커밋 가져오기', 1);
        await this.git(['init', '--quiet'], checkout, controller.signal);
        await this.git(['remote', 'add', 'origin', UPDATE_REPOSITORY], checkout, controller.signal);
        await this.git(['fetch', '--no-tags', '--depth=1', 'origin', this.target.sourceSha], checkout, controller.signal);
        if (await this.git(['rev-parse', 'FETCH_HEAD'], checkout, controller.signal) !== this.target.sourceSha) failed('공개 저장소에서 승인된 커밋을 확인하지 못했습니다');
        await this.git(['checkout', '--detach', this.target.sourceSha], checkout, controller.signal);
        const sourceTree = await this.sourceIdentity(checkout, controller.signal);
        this.emit('preparing', '잠금 파일에 고정된 빌드 의존성을 설치합니다', '의존성 설치', 2);
        await this.run('npm', ['ci', '--no-audit', '--no-fund'], checkout, controller.signal, 600_000);
        await this.sourceIdentity(checkout, controller.signal);
        await this.run('npm', ['run', 'setup:electron'], checkout, controller.signal, 600_000);
        this.emit('preparing', '승인된 소스를 검사합니다', '소스 검사', 3);
        await this.run('npm', ['run', 'check'], checkout, controller.signal, 600_000);
        this.emit('preparing', '승인된 소스를 빌드합니다', '앱 빌드', 4);
        await this.run('npm', ['run', 'build'], checkout, controller.signal, 600_000);
        await this.sourceIdentity(checkout, controller.signal);
        this.emit('preparing', '별도 임시 폴더에 앱을 패키징합니다', '앱 패키징', 5);
        const appPath = path.join(output, 'note-app.app');
        await this.run('npm', ['run', 'package:mac:local', '--', '--output', appPath, '--build-number', this.target.buildNumber], checkout, controller.signal, 600_000);
        if (await this.sourceIdentity(checkout, controller.signal) !== sourceTree) failed('준비 중 소스 트리가 변경되었습니다');
        this.emit('preparing', '준비한 앱을 검증합니다', '빌드 정보와 서명 검증', 6);
        this.prepared = await this.validateBundle(stage, sourceTree, controller.signal);
        return this.prepared;
      } catch (error) { this.prepared = null; this.handleFailure(error, controller.signal); return null; }
      finally {
        if (lockHeld && !this.cleanupUnverified) {
          try { const lock = path.join(this.root, 'prepare.lock'); await this.guardPath(lock, 'directory'); await this.fs.rmdir(lock); }
          catch { this.prepared = null; this.emit('error', '업데이트 잠금을 정리하지 못했습니다. 전용 업데이트 폴더를 확인한 뒤 다시 시도해 주세요'); }
        }
      }
    })();
    const tracked = work.then(async result => {
      if (controller.signal.aborted && result) { this.prepared = null; this.handleFailure(abortError(), controller.signal); return null; }
      if (result && this.prepared === result) {
        try {
          const preparedAt = this.now();
          const saved: PersistedPreparedState = {schemaVersion: 1, status: 'ready', target: this.target!, current: {...this.current},
            stageName: path.basename(result.stagePath), sourceTree: result.sourceTree, appSha256: result.appSha256,
            architecture: result.architecture, nodeExecutable: result.nodeExecutable, preparedAt,
            expiresAt: new Date(Date.parse(preparedAt) + PREPARED_STATE_MAX_AGE_MS).toISOString(), cleanupComplete: true};
          await this.persist(saved, controller.signal);
          this.persisted = saved;
          this.emit('ready', '업데이트 준비가 끝났습니다. 확인 후 설치할 수 있습니다', '준비 완료', 7); return result;
        } catch (error) { this.prepared = null; this.persisted = null; this.handleFailure(error, controller.signal); }
      }
      return null;
    }).finally(() => { if (this.active === tracked) this.active = null; if (this.prepareFlight === tracked) this.prepareFlight = null; if (this.controller === controller) this.controller = null; });
    this.prepareFlight = tracked; this.active = tracked; return tracked;
  }
  async cancel(): Promise<UpdateState> {
    this.controller?.abort(); const work = this.active; if (work) await work.catch(() => undefined);
    if (work) return this.getState();
    if (!this.prepared) return this.emit('cancelled', '진행 중인 업데이트 준비가 없습니다. 설치된 앱은 그대로입니다');
    return this.getState();
  }
  async defer(): Promise<UpdateState> {
    if (this.active) { await this.active.catch(() => undefined); return this.getState(); }
    if (!this.prepared || !this.persisted) return this.getState();
    const controller = new AbortController(); this.controller = controller;
    this.emit('checking', '준비한 업데이트를 나중에 설치할 수 있도록 저장합니다', '준비 상태 저장', 7);
    const work = (async () => {
      try {
        const saved: PersistedPreparedState = {...this.persisted!, status: 'deferred'};
        await this.persist(saved, controller.signal); this.persisted = saved;
        return this.emit('deferred', '준비한 업데이트를 저장했습니다. 7일 안에 다시 열면 파일을 재검증합니다', '준비 완료', 7);
      } catch (error) { this.prepared = null; this.persisted = null; return this.handleFailure(error, controller.signal); }
    })();
    const tracked = work.finally(() => { if (this.active === tracked) this.active = null; if (this.controller === controller) this.controller = null; });
    this.active = tracked; return tracked;
  }
}
