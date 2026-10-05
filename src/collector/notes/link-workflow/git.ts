import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { Budget, LinkError, realDirectory, snapshot, type Snapshot } from './safe-io';

export const inside = (root: string, child: string): boolean => { const rel = path.relative(root, child); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
export const validPath = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= 4096 && path.isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p);
export interface GitAuthority { gitDirectory: string; commonDirectory: string; exclude: string; snapshots: Snapshot[]; worktreePaths: string[] }

export async function gitRead(executable: string, worktree: string, argv: string[], budget: Budget, fixedInput?: Buffer, allowNoMatch = false): Promise<Buffer> {
  budget.check();
  const environment: NodeJS.ProcessEnv = {};
  // Never inherit GIT_DIR, injected config, alternate object dirs, or executable search settings.
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
  return await new Promise<Buffer>((resolve, reject) => {
    let done = false; let bytes = 0; const chunks: Buffer[] = [];
    const child = spawn(executable, ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-C', worktree, ...argv], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment });
    const finish = (error?: LinkError, value?: Buffer) => {
      if (done) return; done = true; clearTimeout(timer); budget.signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(value!);
    };
    const abort = () => finish(new LinkError('cancelled', 'The Git read was cancelled.'));
    const timer = setTimeout(() => finish(new LinkError('timeout', 'The Git read exceeded its deadline.')), Math.max(1, budget.deadline - Date.now()));
    for (const [stream, keep] of [[child.stdout, true], [child.stderr, false]] as const) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262_144) finish(new LinkError('git-output-limit', 'Git metadata exceeds the bounded output limit.'));
      else if (keep) chunks.push(chunk);
    });
    child.stdin.on('error', () => { /* early Git exit is handled by close; no raw stderr escapes */ });
    child.stdin.end(fixedInput);
    child.once('error', () => finish(new LinkError('git-failed', 'The trusted Git executable could not run.')));
    child.once('close', (code) => code === 0 || (allowNoMatch && code === 1) ? finish(undefined, Buffer.concat(chunks)) : finish(new LinkError('git-failed', 'Git could not verify the selected worktree.')));
    budget.signal?.addEventListener('abort', abort, { once: true });
    if (budget.signal?.aborted) abort();
  });
}
function onePath(output: Buffer): string {
  const value = output.toString('utf8').replace(/\r?\n$/, '');
  if (!validPath(value)) throw new LinkError('git-authority', 'Git returned an invalid canonical path.');
  return path.resolve(value);
}
async function metadataFile(p: string, budget: Budget): Promise<{ stamp: Snapshot; text: string }> {
  const result = await snapshot(p, budget, true, 16_384);
  if (result.snapshot.kind !== 'file' || !result.bytes) throw new LinkError('git-authority', 'Repository metadata must be a regular file without symlinks.');
  return { stamp: result.snapshot, text: result.bytes.toString('utf8') };
}
export async function inspectGit(executable: string, worktree: string, approvedCommonPaths: readonly string[], budget: Budget): Promise<GitAuthority> {
  const snapshots: Snapshot[] = [];
  const executableCanonical = await budget.run(() => fs.realpath(executable));
  const executableStat = (await snapshot(executableCanonical, budget)).snapshot;
  if (executableStat.kind !== 'file') throw new LinkError('git-authority', 'The trusted Git executable is not a regular file.');
  await budget.run(() => fs.access(executableCanonical, constants.X_OK));
  snapshots.push(executableStat);
  if (executableCanonical !== executable) snapshots.push((await snapshot(executable, budget)).snapshot);
  const dotGit = path.join(worktree, '.git');
  const dotStat = (await snapshot(dotGit, budget, true, 16_384)).snapshot;
  snapshots.push(dotStat);
  let gitDirectory: string;
  let commonDirectory: string;
  if (dotStat.kind === 'directory') {
    gitDirectory = await realDirectory(dotGit, budget);
    if (gitDirectory !== dotGit) throw new LinkError('git-authority', 'Ordinary repository metadata must remain inside the selected worktree.');
    commonDirectory = gitDirectory;
    const common = (await snapshot(path.join(gitDirectory, 'commondir'), budget, true, 16_384)).snapshot;
    snapshots.push(common);
    if (common.exists) throw new LinkError('git-authority', 'Relocated common metadata needs an explicitly registered linked-worktree authority.');
  } else if (dotStat.kind === 'file') {
    const pointer = await metadataFile(dotGit, budget);
    const match = /^gitdir: ([^\r\n\x00]+)\r?\n?$/.exec(pointer.text);
    if (!match) throw new LinkError('git-authority', 'The worktree Git pointer is invalid.');
    const lexicalGitDirectory = path.resolve(worktree, match[1]!);
    if (!validPath(lexicalGitDirectory)) throw new LinkError('git-authority', 'The Git metadata pointer is invalid.');
    // Before traversing a pointer, require it inside a specific trusted common directory.
    const authorities: string[] = [];
    for (const approved of approvedCommonPaths) {
      const canonical = await realDirectory(approved, budget);
      authorities.push(canonical);
      snapshots.push((await snapshot(approved, budget)).snapshot);
      if (canonical !== approved) snapshots.push((await snapshot(canonical, budget)).snapshot);
    }
    if (!authorities.some((root) => inside(root, lexicalGitDirectory))) throw new LinkError('git-authority', 'This linked worktree needs explicit authorization for its common Git directory.');
    gitDirectory = await budget.run(() => fs.realpath(lexicalGitDirectory));
    if (!authorities.some((root) => inside(root, gitDirectory))) throw new LinkError('git-authority', 'The linked metadata path escapes its registered Git authority.');
    await realDirectory(gitDirectory, budget);
    const common = await metadataFile(path.join(gitDirectory, 'commondir'), budget);
    snapshots.push(common.stamp);
    if (!/^[^\r\n\x00]+\r?\n?$/.test(common.text)) throw new LinkError('git-authority', 'The common Git pointer is invalid.');
    const lexicalCommon = path.resolve(gitDirectory, common.text.replace(/\r?\n$/, ''));
    if (!authorities.includes(lexicalCommon)) throw new LinkError('git-authority', 'The common Git pointer is not an exact registered authority.');
    commonDirectory = await realDirectory(lexicalCommon, budget);
    if (!authorities.includes(commonDirectory)) throw new LinkError('git-authority', 'Git common metadata is not an exact registered authority.');
    snapshots.push((await snapshot(gitDirectory, budget)).snapshot);
    snapshots.push((await snapshot(commonDirectory, budget)).snapshot);
    // Bind the back-pointer too, so a foreign registration cannot impersonate this worktree.
    const back = await metadataFile(path.join(gitDirectory, 'gitdir'), budget);
    snapshots.push(back.stamp);
    const backPath = path.resolve(gitDirectory, back.text.replace(/\r?\n$/, ''));
    if (backPath !== dotGit) throw new LinkError('git-authority', 'The linked Git registration does not point back to this worktree.');
  } else throw new LinkError('git-authority', 'The selected worktree has no authorized ordinary or linked Git metadata.');

  const top = onePath(await gitRead(executableCanonical, worktree, ['rev-parse', '--path-format=absolute', '--show-toplevel'], budget));
  const common = onePath(await gitRead(executableCanonical, worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], budget));
  const exclude = onePath(await gitRead(executableCanonical, worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], budget));
  if (top !== worktree || await realDirectory(common, budget) !== commonDirectory || common !== commonDirectory || exclude !== path.join(commonDirectory, 'info', 'exclude')) throw new LinkError('git-authority', 'Git reports relocated metadata outside the selected repository authority.');
  const info = path.dirname(exclude);
  const infoStat = (await snapshot(info, budget)).snapshot;
  if (infoStat.kind !== 'directory' || await realDirectory(info, budget) !== info) throw new LinkError('git-authority', 'The Git info directory must be an existing direct directory.');
  snapshots.push(infoStat);
  const listed = await gitRead(executableCanonical, worktree, ['worktree', 'list', '--porcelain', '-z'], budget);
  const worktreePaths: string[] = [];
  for (const field of listed.toString('utf8').split('\0')) {
    if (field.startsWith('worktree ')) {
      const p = field.slice(9);
      if (!validPath(p) || worktreePaths.length >= 1000) throw new LinkError('git-output-limit', 'The worktree inventory is invalid or exceeds its bounded limit.');
      worktreePaths.push(p);
    }
  }
  if (!worktreePaths.includes(worktree)) throw new LinkError('git-authority', 'Git did not list the selected worktree in this repository.');
  return { gitDirectory, commonDirectory, exclude, snapshots, worktreePaths: [...new Set(worktreePaths)].sort() };
}

/** Fixed path input only; this never accepts renderer paths or dynamic pathspecs. */
export async function noteIsTracked(executable: string, worktree: string, budget: Budget): Promise<boolean> {
  return (await gitRead(executable, worktree, ['ls-files', '-z', '--', 'docs/note'], budget)).length > 0;
}
export async function noteIsIgnored(executable: string, worktree: string, budget: Budget): Promise<boolean> {
  const output = await gitRead(executable, worktree, ['check-ignore', '--no-index', '--non-matching', '--verbose', '-z', '--stdin'], budget, Buffer.from('docs/note\0'), true);
  const fields = output.toString('utf8').split('\0');
  if (fields.length !== 5 || fields[3] !== 'docs/note' || fields[4] !== '') throw new LinkError('git-failed', 'Git returned invalid ignore verification metadata.');
  const pattern = fields[2]!;
  return pattern.length > 0 && !pattern.startsWith('!');
}
