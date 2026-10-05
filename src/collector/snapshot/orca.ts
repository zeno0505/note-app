import type { OrcaCoverage, OrcaFailure, OrcaObservation, OrcaReadOptions, OrcaResult } from '../orca/types';
import { createSnapshotStore } from './store';
import type { SnapshotStore, SnapshotStoreOptions } from './types';

export interface OrcaSnapshotCoverage {
  state: 'complete' | 'partial' | 'unknown';
  complete: boolean;
  projects: OrcaCoverage;
  worktrees: OrcaCoverage;
  processes: OrcaCoverage;
}
export type OrcaSnapshotStore = SnapshotStore<OrcaObservation, OrcaSnapshotCoverage, OrcaFailure>;
export type OrcaSnapshotStoreOptions = Omit<SnapshotStoreOptions<OrcaObservation, OrcaSnapshotCoverage, OrcaFailure>, 'load'> & {
  load(options: OrcaReadOptions): Promise<OrcaResult<OrcaObservation>>;
};
/** Inject an already configured/authorized adapter. This helper never creates or reconnects one. */
export function createOrcaSnapshotStore(options: OrcaSnapshotStoreOptions): OrcaSnapshotStore {
  return createSnapshotStore<OrcaObservation, OrcaSnapshotCoverage, OrcaFailure>({
    ...options,
    async load({ signal }) {
      const result = await options.load({ signal });
      if (!result.ok) return { kind: 'failure', error: result.error };
      const value = result.value;
      const scopes = [value.projects.coverage, value.worktrees.coverage, value.processes.coverage];
      return {
        kind: 'success', value, runtimeId: value.runtimeId, observedAt: value.observedAt,
        coverage: {
          state: scopes.some(scope => scope.state === 'partial') ? 'partial'
            : scopes.some(scope => scope.state === 'unknown') ? 'unknown' : 'complete',
          complete: value.complete,
          projects: value.projects.coverage,
          worktrees: value.worktrees.coverage,
          processes: value.processes.coverage,
        },
      };
    },
  });
}
