import type { GraphReadError, LinkedDateSummary, TaskGraphIdentity } from './task-graph-contract';
/** Bounded date projection. Full evidence remains main-owned, never raw declarations or paths. */
export type GraphDateReadResult =
  | { state: 'dates'; requestId: string; identity: TaskGraphIdentity; metadataRevision: string;
      summary: LinkedDateSummary; tasks: readonly { id: string; summary: LinkedDateSummary }[] }
  | { state: 'unavailable'; requestId: string; reason: GraphReadError };
