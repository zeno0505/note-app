import path from 'node:path';
import {parseApprovedDemoManifest, validSha256, validSourceSha, validUpdateBuildNumber, validUpdateVersion,
  type ApprovedDemoManifest, type CurrentUpdateBuild} from './manifest';

export const PREPARED_STATE_FILE = 'prepared-state.json';
export const PREPARED_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A resume hint, never an approval source. All artifacts must be verified again. */
export interface PersistedPreparedState {
  schemaVersion: 1;
  status: 'ready' | 'deferred';
  target: ApprovedDemoManifest;
  current: CurrentUpdateBuild;
  stageName: string;
  sourceTree: string;
  appSha256: string;
  architecture: 'arm64' | 'x64';
  nodeExecutable: string;
  preparedAt: string;
  expiresAt: string;
  cleanupComplete: true;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isoTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const keys = ['schemaVersion', 'status', 'target', 'current', 'stageName', 'sourceTree', 'appSha256', 'architecture',
  'nodeExecutable', 'preparedAt', 'expiresAt', 'cleanupComplete'];

export function parsePreparedState(value: unknown, approved: ApprovedDemoManifest, current: CurrentUpdateBuild,
  architecture: string, now: number): PersistedPreparedState {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || !['ready', 'deferred'].includes(value.status as string) || value.cleanupComplete !== true
    || typeof value.stageName !== 'string' || !/^build-[A-Za-z0-9]{6}$/.test(value.stageName)
    || !validSourceSha(value.sourceTree) || !validSha256(value.appSha256)
    || !['arm64', 'x64'].includes(value.architecture as string) || value.architecture !== architecture
    || typeof value.nodeExecutable !== 'string' || !path.isAbsolute(value.nodeExecutable)
    || path.resolve(value.nodeExecutable) !== value.nodeExecutable || path.basename(value.nodeExecutable) !== 'node'
    || !['/usr/bin/', '/usr/local/', '/opt/homebrew/'].some(prefix => (value.nodeExecutable as string).startsWith(prefix))
    || !isoTime(value.preparedAt) || !isoTime(value.expiresAt) || !Number.isFinite(now)
    || Date.parse(value.preparedAt) > now || Date.parse(value.expiresAt) <= now
    || Date.parse(value.expiresAt) - Date.parse(value.preparedAt) !== PREPARED_STATE_MAX_AGE_MS
    || !object(value.current) || Object.keys(value.current).length !== 3
    || !validUpdateVersion(value.current.version) || !validUpdateBuildNumber(value.current.buildNumber) || !validSourceSha(value.current.sourceSha)
    || value.current.version !== current.version || value.current.buildNumber !== current.buildNumber || value.current.sourceSha !== current.sourceSha) {
    throw new Error('Invalid, expired, or changed prepared update');
  }
  const target = parseApprovedDemoManifest(value.target);
  // Only trusted main selects the target. Even otherwise valid local JSON cannot change it.
  if (JSON.stringify(target) !== JSON.stringify(approved)) throw new Error('Prepared update no longer matches main approval');
  return {...value, target: approved, current: {...current}} as unknown as PersistedPreparedState;
}
