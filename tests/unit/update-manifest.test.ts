import {describe, expect, it} from 'vitest';
import {classifyUpdate, compareUpdateVersions, parseApprovedDemoManifest, UPDATE_REPOSITORY} from '../../src/main/update/manifest';
const candidate = () => ({schemaVersion: 1, channel: 'demo', repository: UPDATE_REPOSITORY, version: '0.2.0', buildNumber: '2',
  sourceSha: 'b'.repeat(40), lockfileSha256: 'c'.repeat(64), changelog: ['Approved demo changes'], publishedAt: '2026-10-08T00:00:00.000Z'});
const current = {version: '0.1.0', buildNumber: '1', sourceSha: 'a'.repeat(40)};
describe('immutable approved demo target', () => {
  it('copies and deeply freezes only the main-owned approved target', () => {
    const input = candidate(), target = parseApprovedDemoManifest(input); input.changelog[0] = 'changed'; input.sourceSha = 'a'.repeat(40);
    expect(target.changelog).toEqual(['Approved demo changes']); expect(target.sourceSha).toBe('b'.repeat(40));
    expect(Object.isFrozen(target)).toBe(true); expect(Object.isFrozen(target.changelog)).toBe(true);
  });
  it('rejects absent, additional, malformed, moving, private, or unpublished manifest fields', () => {
    for (const value of [null, {}, {...candidate(), url: 'https://evil.invalid'}, {...candidate(), channel: 'latest'},
      {...candidate(), sourceSha: 'HEAD'}, {...candidate(), sourceSha: 'B'.repeat(40)}, {...candidate(), sourceSha: 'b'.repeat(39)},
      {...candidate(), repository: 'https://user:secret@github.com/zeno0505/note-app.git'}, {...candidate(), version: '01.2.0'},
      {...candidate(), version: '0.2.0-beta'}, {...candidate(), buildNumber: '02'}, {...candidate(), buildNumber: 2},
      {...candidate(), lockfileSha256: 'unknown'}, {...candidate(), publishedAt: '2026-02-30T00:00:00.000Z'},
      {...candidate(), publishedAt: 'tomorrow'}, {...candidate(), changelog: []}, {...candidate(), changelog: ['bad\nline']},
      {...candidate(), changelog: ['too long'.repeat(100)]}]) expect(() => parseApprovedDemoManifest(value)).toThrow();
    const missing = candidate() as Record<string, unknown>; delete missing.lockfileSha256; expect(() => parseApprovedDemoManifest(missing)).toThrow();
  });
  it('requires build monotonicity and nondecreasing semantic version, with explicit trusted recovery only', () => {
    expect(classifyUpdate(parseApprovedDemoManifest(candidate()), current)).toBe('available');
    expect(classifyUpdate(parseApprovedDemoManifest({...candidate(), version: current.version}), current)).toBe('available');
    for (const change of [{version: '0.0.9'}, {buildNumber: '1'}, {buildNumber: '1', sourceSha: current.sourceSha}]) {
      const target = parseApprovedDemoManifest({...candidate(), ...change}); expect(() => classifyUpdate(target, current)).toThrow();
      expect(classifyUpdate(target, current, true)).toBe('available');
    }
    expect(classifyUpdate(parseApprovedDemoManifest({...candidate(), ...current}), current)).toBe('up-to-date');
    expect(() => classifyUpdate(parseApprovedDemoManifest(candidate()), {...current, sourceSha: null})).toThrow();
    expect(compareUpdateVersions('0.10.0', '0.2.0')).toBe(1); expect(compareUpdateVersions('1.0.0', '1.0.0')).toBe(0);
  });
});
