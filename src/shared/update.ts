/** Public updater state. Filesystem paths, commands and repository selection stay in main. */
export type UpdateStatus = 'idle' | 'checking' | 'unavailable' | 'up-to-date' | 'available' | 'preparing' | 'ready' | 'deferred' | 'installing' | 'cancelled' | 'error';
export interface UpdateBuild {
  version: string;
  buildNumber: string | null;
  sourceSha: string | null;
}
export interface UpdateTarget {
  version: string;
  buildNumber: string;
  sourceSha: string;
  changelog: string[];
  publishedAt: string;
}
export interface UpdatePrerequisite {
  id: string;
  label: string;
  ready: boolean;
  detail?: string;
}
/** Main-verified receipt only. Its identity is informational, never an IPC argument. */
export interface UpdateOutcome {
  attemptId: string;
  kind: 'success' | 'rollback' | 'recovery-needed' | 'failed' | 'unverified';
  targetVersion: string;
  message?: string;
  occurredAt: string;
}
export interface UpdateState {
  status: UpdateStatus;
  current: UpdateBuild;
  target: UpdateTarget | null;
  message: string;
  checkedAt: string | null;
  outcome?: UpdateOutcome | null;
  progress?: {step: string; completed: number; total: number} | null;
  prerequisites: UpdatePrerequisite[];
  canCheck: boolean;
  canPrepare: boolean;
  canCancel: boolean;
  canDefer: boolean;
  canInstall: boolean;
}
export interface UpdateBridge {
  getUpdateState(): Promise<UpdateState>;
  checkUpdate(): Promise<UpdateState>;
  prepareUpdate(): Promise<UpdateState>;
  cancelUpdate(): Promise<UpdateState>;
  deferUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  dismissUpdateOutcome(): Promise<UpdateState>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}
