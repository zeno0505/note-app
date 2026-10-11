import { chmod, copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { OrcaQuery } from '../../src/collector/orca';
export async function fixture(query: OrcaQuery): Promise<any> {
  return JSON.parse(await readFile(resolve('fixtures/orca', `${query}.json`), 'utf8'));
}
export async function mockExecutable(): Promise<{ directory: string; executablePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'note-app-orca-'));
  for (const query of ['status', 'projects', 'worktrees', 'processes']) await copyFile(resolve('fixtures/orca', `${query}.json`), join(directory, `${query}.json`));
  const executablePath = join(directory, 'orca-fixture');
  await writeFile(executablePath, `#!${process.execPath}\n${await readFile(resolve('fixtures/orca/mock-orca.cjs'), 'utf8')}`);
  await chmod(executablePath, 0o700);
  return { directory, executablePath };
}
export async function mode(directory: string, kind: string, query?: OrcaQuery): Promise<void> {
  await writeFile(join(directory, 'mode.json'), JSON.stringify({ kind, query }));
}
export async function replaceFixture(directory: string, query: OrcaQuery, mutate: (value: any) => void): Promise<void> {
  const value = await fixture(query);
  mutate(value);
  await writeFile(join(directory, `${query}.json`), JSON.stringify(value));
}
