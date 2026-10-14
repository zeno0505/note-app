import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {UpdateState} from '../../src/shared/update';
import type {InstallPlan} from '../../scripts/updater/protocol.mjs';

// This is service orchestration only. Every filesystem operation, source updater,
// child process and receipt is synthetic; changing the platform branch is not a
// native macOS installation test and cannot launch an installer.
const mock = vi.hoisted(() => ({
  prepared: null as Record<string, unknown> | null,
  state: null as UpdateState | null,
  plan: null as InstallPlan | null,
  restore: vi.fn(), check: vi.fn(), prepare: vi.fn(), cancel: vi.fn(), defer: vi.fn(),
  read: vi.fn(), dismiss: vi.fn(), writePending: vi.fn(), recordFailure: vi.fn(),
  cp: vi.fn(), privateDirectory: vi.fn(), writeJson: vi.fn(), readJson: vi.fn(),
  spawn: vi.fn(), cleanup: vi.fn(), requestQuit: vi.fn(),
}));
vi.mock('../../src/main/update/source-release-updater', () => ({SourceReleaseUpdater: class {
  getState() { return structuredClone(mock.state!); }
  getPrepared() { return mock.prepared; }
  restore() { return mock.restore(); }
  check() { return mock.check(); }
  prepare() { return mock.prepare(); }
  cancel() { return mock.cancel(); }
  defer() { return mock.defer(); }
}}));
vi.mock('node:fs/promises', () => ({
  cp: mock.cp,
  realpath: vi.fn(async (file: string) => file),
  lstat: vi.fn(async () => ({isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, mode: 0o700})),
}));
vi.mock('node:child_process', () => ({spawn: mock.spawn}));
vi.mock('../../src/main/update-files', () => ({
  privateUpdateDirectory: mock.privateDirectory,
  writePrivateUpdateJson: mock.writeJson,
  readPrivateUpdateJson: mock.readJson,
}));
vi.mock('../../src/main/update-outcome', () => ({createUpdateOutcomeStore: () => ({
  read: mock.read, dismiss: mock.dismiss, writePending: mock.writePending, recordFailure: mock.recordFailure,
})}));
import {createUpdateService} from '../../src/main/update-service';

const options = {
  home: '/synthetic-updater-lifecycle',
  installation: {
    role: 'user' as const,
    currentPath: '/synthetic-updater-lifecycle/Applications/note-app.app',
    canonicalPath: '/synthetic-updater-lifecycle/Applications/note-app.app',
    buildSha: 'a'.repeat(40), buildNumber: '34',
  },
  version: '0.1.1', installerDirectory: '/synthetic-installer',
  cleanup: mock.cleanup, requestQuit: mock.requestQuit,
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function child(events: 'spawn' | 'error' | 'exit' = 'spawn') {
  const process = Object.assign(new EventEmitter(), {unref: vi.fn()});
  queueMicrotask(() => {
    if (events === 'error') process.emit('error', Error('Synthetic spawn failure'));
    else {
      process.emit('spawn');
      if (events === 'exit') process.emit('exit', 1);
    }
  });
  return process;
}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({toFake: ['Date', 'setTimeout', 'clearTimeout']});
  vi.setSystemTime(new Date('2026-10-13T22:00:00.000Z'));
  Object.defineProperty(process, 'platform', {...platform, value: 'darwin'});
  mock.plan = null;
  mock.prepared = {
    target: {sourceSha: 'b'.repeat(40), buildNumber: '35', version: '0.1.1'},
    sourceTree: 'c'.repeat(40), architecture: 'arm64', appSha256: 'd'.repeat(64),
    appPath: '/synthetic-prepared/note-app.app', packageManifestPath: '/synthetic-prepared/manifest.json',
    nodeExecutable: '/synthetic-node',
  };
  mock.state = {
    status: 'ready', current: {version: '0.1.1', buildNumber: '34', sourceSha: 'a'.repeat(40)},
    target: null, message: 'Synthetic prepared update', checkedAt: null, prerequisites: [],
    canCheck: true, canPrepare: false, canCancel: false, canDefer: true, canInstall: true,
  };
  for (const method of [mock.restore, mock.check, mock.prepare, mock.cancel, mock.defer]) method.mockResolvedValue(mock.state);
  for (const method of [mock.cp, mock.privateDirectory, mock.cleanup, mock.writePending]) method.mockResolvedValue(undefined);
  mock.read.mockResolvedValue(null);
  mock.dismiss.mockResolvedValue(null);
  mock.recordFailure.mockResolvedValue(null);
  mock.writeJson.mockImplementation(async (file: string, value: InstallPlan) => {
    if (file.endsWith('/plan.json')) mock.plan = value;
  });
  mock.readJson.mockImplementation(async () => ({schemaVersion: 1, transactionId: mock.plan!.transactionId, phase: 'validated'}));
  mock.spawn.mockImplementation(() => child());
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
});
async function ready() {
  const service = createUpdateService(options);
  await tick();
  return service;
}
function noHandoff() {
  expect(mock.cleanup).not.toHaveBeenCalled();
  expect(mock.requestQuit).not.toHaveBeenCalled();
  expect(mock.writeJson.mock.calls.some(([file]) => file.endsWith('/quit-ready.json'))).toBe(false);
}

describe('synthetic updater service lifecycle boundaries', () => {
  it('coalesces repeated install while staging and writes quit acknowledgement only when the quit lifecycle requests it', async () => {
    const staging = deferred<void>();
    mock.cp.mockImplementationOnce(() => staging.promise);
    const service = await ready();
    const first = service.install(), duplicate = service.install();
    await tick();
    expect(mock.cp).toHaveBeenCalledTimes(1);
    expect(mock.spawn).not.toHaveBeenCalled();
    staging.resolve();
    expect((await first).status).toBe('installing');
    expect((await duplicate).status).toBe('installing');
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    expect(mock.writePending).toHaveBeenCalledTimes(1);
    expect(mock.cleanup).toHaveBeenCalledTimes(1);
    expect(mock.requestQuit).toHaveBeenCalledTimes(1);
    expect(mock.writeJson.mock.calls.filter(([file]) => file.endsWith('/quit-ready.json'))).toHaveLength(0);
    await mock.requestQuit.mock.calls[0][0]();
    expect(mock.writeJson.mock.calls.find(([file]) => file.endsWith('/quit-ready.json'))?.[1]).toEqual({
      schemaVersion: 1, transactionId: mock.plan!.transactionId, nonce: mock.plan!.nonce,
      currentPid: process.pid, sourceSha: options.installation.buildSha, buildNumber: '34', quitSettled: true,
    });
    expect(mock.spawn.mock.calls[0][2]).toEqual({
      detached: true, stdio: 'ignore', shell: false,
      env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: options.home, LANG: 'C', LC_ALL: 'C'},
    });
    await service.settle!();
  });

  it('normal quit drains an in-flight staging copy and prevents all later installer work', async () => {
    const staging = deferred<void>();
    mock.cp.mockImplementationOnce(() => staging.promise);
    const service = await ready(), installing = service.install();
    await tick();
    let settled = false;
    const quitting = service.settle!().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    staging.resolve();
    expect((await installing).status).toBe('error');
    await quitting;
    expect(mock.cp).toHaveBeenCalledTimes(1);
    expect(mock.writePending).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
    noHandoff();
  });

  it('normal quit waits for pending intent persistence and records failure without spawning', async () => {
    const pending = deferred<void>();
    mock.writePending.mockImplementation(() => pending.promise);
    const service = await ready(), installing = service.install();
    await tick();
    expect(mock.writePending).toHaveBeenCalledTimes(1);
    let settled = false;
    const quitting = service.settle!().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    pending.resolve();
    expect((await installing).status).toBe('error');
    await quitting;
    expect(mock.recordFailure).toHaveBeenCalledTimes(1);
    expect(mock.spawn).not.toHaveBeenCalled();
    noHandoff();
  });

  it('normal quit drains a journal read and prevents cleanup even if validation arrives late', async () => {
    const journal = deferred<unknown>();
    mock.readJson.mockImplementation(() => journal.promise);
    const service = await ready(), installing = service.install();
    await tick();
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    let settled = false;
    const quitting = service.settle!().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    journal.resolve({schemaVersion: 1, transactionId: mock.plan!.transactionId, phase: 'validated'});
    expect((await installing).status).toBe('error');
    await quitting;
    expect(mock.recordFailure).toHaveBeenCalledTimes(1);
    noHandoff();
  });

  it('normal quit drains in-flight app cleanup but never starts an update-triggered quit afterward', async () => {
    const cleaning = deferred<void>();
    mock.cleanup.mockImplementation(() => cleaning.promise);
    const service = await ready(), installing = service.install();
    await tick();
    expect(mock.cleanup).toHaveBeenCalledTimes(1);
    let settled = false;
    const quitting = service.settle!().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    cleaning.resolve();
    expect((await installing).status).toBe('error');
    await quitting;
    expect(mock.requestQuit).not.toHaveBeenCalled();
    expect(mock.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('cleanup rejection cannot acknowledge quit or hand installation to the helper', async () => {
    mock.cleanup.mockRejectedValue(Error('Synthetic unverified cleanup'));
    const service = await ready();
    expect((await service.install()).status).toBe('error');
    expect(mock.cleanup).toHaveBeenCalledTimes(1);
    expect(mock.requestQuit).not.toHaveBeenCalled();
    expect(mock.recordFailure).toHaveBeenCalledTimes(1);
    expect(mock.writeJson.mock.calls.some(([file]) => file.endsWith('/quit-ready.json'))).toBe(false);
    await service.settle!();
  });

  it.each(['error', 'exit'] as const)('installer %s before validation preserves normal app ownership', async event => {
    mock.spawn.mockImplementation(() => child(event));
    const service = await ready();
    expect((await service.install()).status).toBe('error');
    expect(mock.recordFailure).toHaveBeenCalledTimes(1);
    noHandoff();
    await service.settle!();
  });

  it('missing journal is bounded by the validation deadline and cannot trigger cleanup', async () => {
    mock.readJson.mockRejectedValue(Object.assign(Error('Synthetic absent journal'), {code: 'ENOENT'}));
    const service = await ready(), installing = service.install();
    await tick();
    expect(mock.readJson).toHaveBeenCalledTimes(1);
    expect(mock.requestQuit).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-13T22:02:01.000Z'));
    await vi.advanceTimersByTimeAsync(100);
    expect((await installing).status).toBe('error');
    expect(mock.recordFailure).toHaveBeenCalledTimes(1);
    noHandoff();
    expect(vi.getTimerCount()).toBe(0);
    await service.settle!();
  });

  it.each(['deadline', 'helper-exit'] as const)('rejects validated journal returned after %s while its read was pending', async cause => {
    const journal = deferred<unknown>();
    let helper!: ReturnType<typeof child>;
    mock.spawn.mockImplementation(() => helper = child());
    mock.readJson.mockImplementation(() => journal.promise);
    const service = await ready(), installing = service.install();
    await tick();
    expect(mock.readJson).toHaveBeenCalledTimes(1);
    if (cause === 'deadline') vi.setSystemTime(new Date('2026-10-13T22:02:01.000Z'));
    else helper.emit('exit', 1);
    journal.resolve({schemaVersion: 1, transactionId: mock.plan!.transactionId, phase: 'validated'});
    expect((await installing).status).toBe('error');
    expect(mock.recordFailure).toHaveBeenCalledTimes(1);
    noHandoff();
    await service.settle!();
  });

  it.each(['deadline', 'helper-exit'] as const)('rejects final handoff when %s occurs during app cleanup', async cause => {
    const cleaning = deferred<void>();
    let helper!: ReturnType<typeof child>;
    mock.spawn.mockImplementation(() => helper = child());
    mock.cleanup.mockImplementation(() => cleaning.promise);
    const service = await ready(), installing = service.install();
    await tick();
    expect(mock.cleanup).toHaveBeenCalledTimes(1);
    if (cause === 'deadline') vi.setSystemTime(new Date('2026-10-13T22:02:01.000Z'));
    else helper.emit('exit', 1);
    cleaning.resolve();
    expect((await installing).status).toBe('error');
    expect(mock.recordFailure).toHaveBeenCalledTimes(1);
    expect(mock.requestQuit).not.toHaveBeenCalled();
    expect(mock.writeJson.mock.calls.some(([file]) => file.endsWith('/quit-ready.json'))).toBe(false);
    await service.settle!();
  });

  it('install waits for an already-owned deferral write before copying or launching', async () => {
    const saving = deferred<void>();
    mock.defer.mockImplementation(() => saving.promise);
    const service = await ready(), deferring = service.defer();
    await tick();
    const installing = service.install();
    await tick();
    expect(mock.cp).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
    saving.resolve();
    await deferring;
    expect((await installing).status).toBe('installing');
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    await service.settle!();
  });

  it('a rejected owned write remains a blocker after a successful later write', async () => {
    mock.defer.mockRejectedValueOnce(Error('Synthetic persistence failure'));
    const service = await ready();
    await expect(service.defer()).rejects.toThrow('Synthetic persistence failure');
    await service.defer();
    expect((await service.install()).status).toBe('error');
    expect(mock.cp).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
    noHandoff();
    await service.settle!();
  });

  it('successful handoff closes every new action and isolates throwing subscribers', async () => {
    const service = await ready();
    const listener = vi.fn(() => { throw Error('Synthetic observer failure'); });
    const unsubscribe = service.subscribe(listener);
    expect((await service.install()).status).toBe('installing');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    await Promise.all([service.check(), service.prepare(), service.cancel(), service.defer(), service.dismissOutcome(), service.install()]);
    for (const method of [mock.check, mock.prepare, mock.cancel, mock.defer, mock.dismiss]) expect(method).not.toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    expect(mock.requestQuit).toHaveBeenCalledTimes(1);
    await service.settle!();
  });
});
