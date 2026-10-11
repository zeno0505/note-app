/** Trusted main validates the fixed release feed, then pins this exact source identity. No renderer-selected repository, branch or SHA. */
export const UPDATE_REPOSITORY = 'https://github.com/zeno0505/note-app.git' as const;
export interface ApprovedDemoManifest {
  readonly schemaVersion: 1;
  readonly channel: 'demo';
  readonly repository: typeof UPDATE_REPOSITORY;
  readonly version: string;
  readonly buildNumber: string;
  readonly sourceSha: string;
  readonly lockfileSha256: string;
  readonly changelog: readonly string[];
  readonly publishedAt: string;
}
export interface CurrentUpdateBuild { version: string; buildNumber: string | null; sourceSha: string | null }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const validSourceSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const validSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validUpdateBuildNumber = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,3}$/.test(value);
export const validUpdateVersion = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value);
export function parseApprovedDemoManifest(input: unknown): ApprovedDemoManifest {
  const keys = ['schemaVersion', 'channel', 'repository', 'version', 'buildNumber', 'sourceSha', 'lockfileSha256', 'changelog', 'publishedAt'];
  if (!record(input) || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
    || Object.keys(input).some(key => !keys.includes(key)) || input.schemaVersion !== 1 || input.channel !== 'demo'
    || input.repository !== UPDATE_REPOSITORY || !validUpdateVersion(input.version) || !validUpdateBuildNumber(input.buildNumber)
    || !validSourceSha(input.sourceSha) || !validSha256(input.lockfileSha256)
    || !Array.isArray(input.changelog) || input.changelog.length < 1 || input.changelog.length > 30
    || input.changelog.some(line => typeof line !== 'string' || line.trim() !== line || line.length < 1 || line.length > 500 || /[\u0000-\u001f\u007f]/.test(line))
    || typeof input.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.publishedAt)
    || !Number.isFinite(Date.parse(input.publishedAt)) || new Date(input.publishedAt).toISOString() !== input.publishedAt) {
    throw new Error('The approved demo target is missing or invalid');
  }
  return Object.freeze({ schemaVersion: 1, channel: 'demo', repository: UPDATE_REPOSITORY, version: input.version,
    buildNumber: input.buildNumber, sourceSha: input.sourceSha, lockfileSha256: input.lockfileSha256,
    changelog: Object.freeze([...input.changelog] as string[]), publishedAt: input.publishedAt });
}
export function compareUpdateVersions(a: string, b: string): number {
  if (!validUpdateVersion(a) || !validUpdateVersion(b)) throw new Error('Invalid application version');
  const av = a.split('.').map(Number), bv = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  return 0;
}
/** Recovery is an explicit trusted-main decision, never a renderer parameter. */
export function classifyUpdate(target: ApprovedDemoManifest, current: CurrentUpdateBuild, recovery = false): 'available' | 'up-to-date' {
  if (!validUpdateVersion(current.version) || !validUpdateBuildNumber(current.buildNumber) || !validSourceSha(current.sourceSha)) {
    throw new Error('The current package has no verified build identity');
  }
  if (target.sourceSha === current.sourceSha && target.version === current.version && target.buildNumber === current.buildNumber) return 'up-to-date';
  if (!recovery && (Number(target.buildNumber) <= Number(current.buildNumber) || compareUpdateVersions(target.version, current.version) < 0)) {
    throw new Error('The approved target does not advance the installed build');
  }
  return 'available';
}
