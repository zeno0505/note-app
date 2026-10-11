import { isOrcaQuery } from './commands';
import { failure } from './errors';
import { createOrcaRunner } from './runner';
import type {
  OrcaAdapterOptions, OrcaIdentity, OrcaJoinedWorktree, OrcaObservation,
  OrcaQuery, OrcaQueryData, OrcaReadOptions, OrcaResponse, OrcaResult,
} from './types';

export interface OrcaAdapter {
  read<Q extends OrcaQuery>(query: Q, options?: OrcaReadOptions): Promise<OrcaResult<OrcaResponse<OrcaQueryData[Q]>>>;
  collect(options?: OrcaReadOptions): Promise<OrcaResult<OrcaObservation>>;
}
function joinKey(runtimeId: string, identity: OrcaIdentity): string | null {
  return identity.hostId !== null && identity.instanceId !== null
    ? JSON.stringify([runtimeId, identity.hostId, identity.instanceId]) : null;
}
/** Instantiate once in the trusted main process. No live collection is enabled by this module. */
export function createOrcaAdapter(options: OrcaAdapterOptions = {}): OrcaAdapter {
  const runner = createOrcaRunner(options);
  let busy = false;
  return {
    async read<Q extends OrcaQuery>(query: Q, request: OrcaReadOptions = {}) {
      if (!isOrcaQuery(query)) return failure<OrcaResponse<OrcaQueryData[Q]>>('forbidden_query', null);
      if (busy) return failure<OrcaResponse<OrcaQueryData[Q]>>('busy', query);
      busy = true;
      try { return await runner.read(query, request); } finally { busy = false; }
    },
    async collect(request = {}): Promise<OrcaResult<OrcaObservation>> {
      if (busy) return failure('busy', null);
      if (request.signal?.aborted) return failure('cancelled', null);
      busy = true;
      try {
        const statusResult = await runner.read('status', request);
        if (!statusResult.ok) return statusResult;
        const { runtimeId, data: status } = statusResult.value;
        if (runtimeId === null) return failure('runtime_unidentified', 'status');
        if (status.appRunning === false || status.runtimeReachable !== true || status.runtimeState !== 'ready') return failure('unavailable', 'status', runtimeId);
        const projectsResult = await runner.read('projects', request);
        if (!projectsResult.ok) return projectsResult;
        if (projectsResult.value.runtimeId === null) return failure('runtime_unidentified', 'projects');
        if (projectsResult.value.runtimeId !== runtimeId) return failure('runtime_changed', 'projects');
        const worktreesResult = await runner.read('worktrees', request);
        if (!worktreesResult.ok) return worktreesResult;
        if (worktreesResult.value.runtimeId === null) return failure('runtime_unidentified', 'worktrees');
        if (worktreesResult.value.runtimeId !== runtimeId) return failure('runtime_changed', 'worktrees');
        const processesResult = await runner.read('processes', request);
        if (!processesResult.ok) return processesResult;
        if (processesResult.value.runtimeId === null) return failure('runtime_unidentified', 'processes');
        if (processesResult.value.runtimeId !== runtimeId) return failure('runtime_changed', 'processes');
        const projects = projectsResult.value.data;
        const worktrees = worktreesResult.value.data;
        const processes = processesResult.value.data;
        const projectMap = new Map(projects.records.map(project => [project.id, project]));
        const processMap = new Map<string, typeof processes.records[number]>();
        for (const process of processes.records) {
          const key = joinKey(runtimeId, process.identity);
          if (key !== null) {
            if (processMap.has(key)) return failure('ambiguous_identity', 'processes', runtimeId);
            processMap.set(key, process);
          }
        }
        const seen = new Set<string>();
        const matched = new Set<typeof processes.records[number]>();
        const joined: OrcaJoinedWorktree[] = [];
        for (const worktree of worktrees.records) {
          const key = joinKey(runtimeId, worktree.identity);
          if (key !== null && seen.has(key)) return failure('ambiguous_identity', 'worktrees', runtimeId);
          if (key !== null) seen.add(key);
          const project = worktree.projectId === null ? null : projectMap.get(worktree.projectId) ?? null;
          const process = key === null ? null : processMap.get(key) ?? null;
          // Contradictory IDs within a stable identity are an error, not a guessed association.
          if (process && (process.worktreeId !== worktree.id || (process.repoId !== null && worktree.repoId !== null && process.repoId !== worktree.repoId))) {
            return failure('ambiguous_identity', 'processes', runtimeId);
          }
          if (process) matched.add(process);
          joined.push({
            key, worktree, project,
            projectMapping: worktree.projectId === null ? 'missing-project-id' : project === null ? 'project-not-observed' : 'matched',
            process, processMapping: key === null ? 'identity-unavailable' : process === null ? 'not-observed' : 'matched',
          });
        }
        return {
          ok: true,
          value: {
            runtimeId, observedAt: new Date().toISOString(), status, projects, worktrees, processes, joined,
            unmatchedProcesses: processes.records.filter(process => !matched.has(process)),
            complete: [projects.coverage, worktrees.coverage, processes.coverage].every(scope => scope.state === 'complete'),
          },
        };
      } finally { busy = false; }
    },
  };
}
