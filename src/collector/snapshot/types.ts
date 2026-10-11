/** Plain, detached state; consumers must not treat historical data as a live observation. */
export type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type RefreshReason = 'initial' | 'manual' | 'poll' | 'resume';
export type Freshness = 'unknown' | 'current' | 'stale';
export interface SnapshotClock {
  /** UTC milliseconds. Must be finite and nondecreasing for a running store. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface SnapshotError { kind: string; message: string }
export interface SnapshotStoreError extends SnapshotError {
  kind: 'load_failed' | 'invalid_result' | 'cancelled';
}
export interface ObservationMetadata<C> {
  runtimeId: string;
  /** Source observation time, not render time or a failed attempt time. */
  observedAt: string;
  coverage: C;
  /** Optional caller-computed identity of value content, scoped to runtimeId. */
  sourceHash?: string | null;
  freshness?: 'current' | 'stale';
}
export type SnapshotLoadResult<T, C, E extends SnapshotError> =
  | ({ kind: 'success'; value: T } & ObservationMetadata<C>)
  | ({ kind: 'unchanged'; sourceHash: string } & ObservationMetadata<C>)
  | { kind: 'failure'; error: E };
export interface SnapshotLoadContext {
  signal: AbortSignal;
  reason: RefreshReason;
}
export interface SnapshotAttempt<E extends SnapshotError> {
  id: number;
  reason: RefreshReason;
  attemptedAt: string;
  completedAt: string | null;
  outcome: 'pending' | 'success' | 'unchanged' | 'error' | 'cancelled';
  error: E | SnapshotStoreError | null;
}
export interface SnapshotState<T, C, E extends SnapshotError> {
  status: 'unknown' | 'observed';
  value: DeepReadonly<T> | null;
  coverage: DeepReadonly<C> | null;
  runtimeId: string | null;
  sourceHash: string | null;
  observedAt: string | null;
  lastSuccessAt: string | null;
  lastAttempt: DeepReadonly<SnapshotAttempt<E>> | null;
  freshness: Freshness;
  /** Changes only when a full new value is accepted; unchanged observations reuse the cached value. */
  revision: number;
  /** Most recent accepted runtime transition; never used to merge records. */
  runtimeChange: { previousRuntimeId: string; currentRuntimeId: string; observedAt: string } | null;
  started: boolean;
  active: boolean;
  visible: boolean;
  refreshing: boolean;
  disposed: boolean;
  nextPollAt: string | null;
  nextRefreshReason: 'poll' | 'resume' | null;
  resumeCountdownSeconds: number;
}
export interface SnapshotStoreOptions<T, C, E extends SnapshotError> {
  load(context: SnapshotLoadContext): Promise<SnapshotLoadResult<T, C, E>>;
  clock?: SnapshotClock;
  /** Defaults to 20 seconds; supported active polling range is 15–30 seconds inclusive. */
  intervalMs?: number;
  /** Defaults to two refresh intervals. Elapsed source time can make a successful observation stale. */
  staleAfterMs?: number;
  active?: boolean;
  visible?: boolean;
  /** Opt-in read-only policy: continue slow background polls; delay foreground return. */
  backgroundIntervalMs?: number;
  resumeDelayMs?: number;
}
export interface SnapshotStore<T, C, E extends SnapshotError> {
  /** Starts with an immediate observation when active and visible. Idempotent. */
  start(): Promise<SnapshotState<T, C, E>>;
  /** Explicit refresh is allowed while hidden; concurrent requests coalesce. Also starts the store. */
  refresh(): Promise<SnapshotState<T, C, E>>;
  getState(): SnapshotState<T, C, E>;
  /** Emits on state transitions, not render ticks. Returns an unsubscribe function. */
  subscribe(listener: (state: SnapshotState<T, C, E>) => void): () => void;
  /** OS sleep pauses timers; wake schedules one coalesced refresh after the return delay. */
  setSuspended(suspended:boolean):void;
  setActivity(activity: { active?: boolean; visible?: boolean }): void;
  /** Cancels the current attempt; a future active poll may retry. */
  cancel(): void;
  /** Explicit disconnect: stop all timers and invalidate current/queued work. */
  stop(): void;
  dispose(): void;
}
