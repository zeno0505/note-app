/** A response/abort is not a cleanup receipt. Owners must retain the original
 * promise, or supply a separate cleanup proof for adapters with bounded replies. */
export type UpdateCleanupProof = 'verified' | 'pending' | 'unverified';

export class UpdateCleanupError extends Error {
  readonly code = 'update-cleanup-unverified';
  constructor(readonly reason: 'pending' | 'unverified', readonly areas: readonly string[]) {
    super('Update installation is delayed until owned work has verified cleanup.');
    this.name = 'UpdateCleanupError';
  }
}

export function createUpdateCleanupGate() {
  const pending = new Map<Promise<unknown>, string>();
  // Sticky: these adapters have no later receipt capable of clearing uncertainty.
  const unverified = new Set<string>();
  function markUnverified(area: string): void { unverified.add(area); }
  function track<T>(area: string, operation: () => Promise<T>, proof?: {
    fulfilled?: (value: T) => boolean;
    rejected?: (error: unknown) => boolean;
  }): Promise<T> {
    let started: Promise<T>;
    try { started = Promise.resolve(operation()); }
    catch (error) { started = Promise.reject(error); }
    const owned = started.then(value => {
      if (proof?.fulfilled && !proof.fulfilled(value)) markUnverified(area);
      return value;
    }, error => {
      if (proof?.rejected && !proof.rejected(error)) markUnverified(area);
      throw error;
    }).finally(() => { pending.delete(owned); });
    pending.set(owned, area);
    return owned;
  }
  async function settle(options: {
    timeoutMs?: number;
    verify?: () => ReadonlyArray<{ area: string; cleanup: UpdateCleanupProof }>;
  } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error('Invalid cleanup wait');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const proofs = options.verify?.() ?? [];
      const failed = [...unverified, ...proofs.filter(p => p.cleanup === 'unverified').map(p => p.area)];
      if (failed.length) throw new UpdateCleanupError('unverified', [...new Set(failed)]);
      const remaining = [...pending.values(), ...proofs.filter(p => p.cleanup === 'pending').map(p => p.area)];
      if (!remaining.length) return;
      if (Date.now() >= deadline) throw new UpdateCleanupError('pending', [...new Set(remaining)]);
      // A deadline refuses installation; it never discards ownership or kills work.
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    }
  }
  return { track, markUnverified, settle };
}
