import normal from '../../fixtures/normal.json';
import failure from '../../fixtures/refresh-failure.json';
import empty from '../../fixtures/empty.json';
import partial from '../../fixtures/partial.json';
import type { WorkspaceSnapshot } from './types';
import { parseFixtureSnapshot } from './validation';

/** Each factory validates a detached copy. Never a live observation or CLI call. */
export const createDemoSnapshot = (): WorkspaceSnapshot => parseFixtureSnapshot(normal);
export const createFailureSnapshot = (): WorkspaceSnapshot => parseFixtureSnapshot(failure);
export const createEmptySnapshot = (): WorkspaceSnapshot => parseFixtureSnapshot(empty);
export const createPartialSnapshot = (): WorkspaceSnapshot => parseFixtureSnapshot(partial);

/** A failed attempt never erases known workstreams or rewrites their observedAt. */
export function retainLastGoodSnapshot(
  previous: WorkspaceSnapshot,
  attemptedAt: string,
  reason: string,
): WorkspaceSnapshot {
  const snapshot = parseFixtureSnapshot(previous);
  snapshot.freshness = 'stale';
  snapshot.lastAttempt = { observedAt: attemptedAt, outcome: 'error', reason };
  for (const stream of snapshot.workstreams) {
    stream.goal.freshness = 'stale';
    for (const claims of Object.values(stream.summary)) {
      for (const claim of claims) claim.freshness = 'stale';
    }
  }
  return parseFixtureSnapshot(snapshot);
}
