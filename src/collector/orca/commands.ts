import type { OrcaQuery } from './types';
/** Every permissible argv, including all flags, is owned by the collector. */
const commands = Object.freeze({
  status: Object.freeze(['status', '--json']),
  projects: Object.freeze(['project', 'list', '--json']),
  worktrees: Object.freeze(['worktree', 'list', '--limit', '1000', '--json']),
  processes: Object.freeze(['worktree', 'ps', '--limit', '1000', '--json']),
});
export function isOrcaQuery(value: unknown): value is OrcaQuery {
  return typeof value === 'string' && Object.hasOwn(commands, value);
}
export function orcaArguments(query: OrcaQuery): readonly string[] {
  if (!isOrcaQuery(query)) throw new Error('Unsupported Orca query.');
  return commands[query];
}
