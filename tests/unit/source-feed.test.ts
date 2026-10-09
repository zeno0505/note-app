import {afterEach, describe, expect, it, vi} from 'vitest';
import {PassThrough, Readable} from 'node:stream';
import type {IncomingHttpHeaders} from 'node:http';
import {UPDATE_REPOSITORY} from '../../src/main/update/manifest';
import {isPublicSourceReleaseAddress, SOURCE_RELEASE_FEED_URL, SOURCE_RELEASE_MAX_AGE_MS,
  SOURCE_RELEASE_MAX_BYTES, SOURCE_RELEASE_MAX_REDIRECTS, SOURCE_RELEASE_TIMEOUT_MS, SourceReleaseFeed, SourceReleaseUnavailableError,
  type SourceReleaseRequest, type SourceReleaseResponse} from '../../src/main/update/source-feed';

const now = new Date('2026-10-09T00:00:00.000Z');
const candidate = () => ({schemaVersion: 1, channel: 'demo', repository: UPDATE_REPOSITORY, version: '0.2.0', buildNumber: '25',
  sourceSha: 'b'.repeat(40), lockfileSha256: 'c'.repeat(64), changelog: ['Fetch the approved source and build locally'], publishedAt: '2026-10-08T00:00:00.000Z'});
const signal = () => new AbortController().signal;
function response(bytes: Buffer | string | Readable, statusCode = 200, headers: IncomingHttpHeaders = {}, gate = Promise.resolve()): SourceReleaseResponse {
  const body = bytes instanceof Readable ? bytes : Readable.from([bytes]);
  return {statusCode, headers, body, close: vi.fn(async () => {
    const closed = body.closed ? Promise.resolve() : new Promise<void>(resolve => body.once('close', resolve));
    body.destroy(); await closed; await gate;
  })};
}
const feed = (request: SourceReleaseRequest) => new SourceReleaseFeed({request, now: () => now});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('fixed HTTPS source-release discovery', () => {
  it('uses the fixed source feed and closes every redirected response before returning the exact nine-field manifest', async () => {
    const versioned = 'https://github.com/zeno0505/note-app/releases/download/build-25/note-app-source-update.json';
    // GitHub's release-assets redirect includes SAS/JWT parameters and encoded disposition, not just sig.
    const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/01234567-89ab-cdef-0123-456789abcdef?sp=r&sv=2018-11-09&sr=b&spr=https&se=2026-10-09T01%3A00%3A00Z&rscd=attachment%3B+filename%3Dnote-app-source-update.json&rsct=application%2Foctet-stream&skoid=synthetic&sktid=synthetic&skt=2026-10-09T00%3A00%3A00Z&ske=2026-10-10T00%3A00%3A00Z&sks=b&skv=2018-11-09&sig=synthetic%2Bsignature%3D&jwt=synthetic.token&response-content-disposition=attachment%3B%20filename%3Dnote-app-source-update.json&response-content-type=application%2Foctet-stream';
    const items = [response('', 302, {location: versioned}), response('', 302, {location: cdn}), response(JSON.stringify(candidate()))];
    const request = vi.fn<SourceReleaseRequest>().mockImplementation(async () => items[request.mock.calls.length - 1]);
    const target = await feed(request).fetchSourceRelease(signal());
    expect(target).toEqual(candidate()); expect(Object.keys(target)).toHaveLength(9);
    expect(Object.isFrozen(target)).toBe(true); expect(Object.isFrozen(target.changelog)).toBe(true);
    expect(request.mock.calls.map(([url]) => url.href)).toEqual([SOURCE_RELEASE_FEED_URL, versioned, cdn]);
    for (const item of items) expect(item.close).toHaveBeenCalledExactlyOnceWith();
  });
  it('does not use environment URL/proxy/credential overrides', async () => {
    vi.stubEnv('NOTE_APP_UPDATE_URL', 'https://attacker.invalid/feed');
    vi.stubEnv('SOURCE_RELEASE_FEED_URL', 'https://attacker.invalid/feed');
    vi.stubEnv('HTTPS_PROXY', 'https://user:secret@proxy.invalid');
    vi.stubEnv('GITHUB_TOKEN', 'synthetic-secret');
    const request = vi.fn<SourceReleaseRequest>().mockResolvedValue(response(JSON.stringify(candidate())));
    await feed(request).fetchSourceRelease(signal());
    expect(request.mock.calls[0][0].href).toBe(SOURCE_RELEASE_FEED_URL);
    expect(Object.keys(request.mock.calls[0][1])).toEqual(['signal']);
  });
  it('rejects downgrade, alternate repo/file, credentials, untrusted hosts, query leakage and noncanonical URLs before requesting them', async () => {
    const path = '/zeno0505/note-app/releases/download/build-25/note-app-source-update.json';
    const invalid = [`http://github.com${path}`, 'https://github.com.evil.invalid/payload', `https://user:secret@github.com${path}`,
      'https://127.0.0.1/payload', 'https://[::1]/payload', 'https://localhost/payload', `https://github.com/other${path}`,
      `https://github.com${path.replace('source-update', 'update-arm64')}`, `https://github.com${path}?token=secret`, `https://github.com${path}#fragment`,
      `https://github.com:443${path}`, `https://github.com:8443${path}`, `https://github.com${path}/../note-app-source-update.json`,
      'https://release-assets.githubusercontent.com/anything', 'https://release-assets.githubusercontent.com/github-production-release-asset/123/aa-bb?token=secret',
      'https://release-assets.githubusercontent.com/github-production-release-asset/123/aa-bb?spr=http',
      'https://release-assets.githubusercontent.com/github-production-release-asset/123/aa-bb?sig=one&sig=two',
      'https://release-assets.githubusercontent.com/github-production-release-asset/123/aa-bb?sig=bad%0D%0Aheader',
      'https://release-assets.githubusercontent.com/github-production-release-asset/123/aa-bb?sig=' + 'x'.repeat(8192),
      path, ` https://github.com${path}`, `https://github.com\\evil.invalid${path}`, `https://github.com${path}\n`];
    for (const location of invalid) {
      const item = response('', 302, {location}), request = vi.fn<SourceReleaseRequest>().mockResolvedValue(item);
      await expect(feed(request).fetchSourceRelease(signal()), location).rejects.toThrow('connection failed');
      expect(request).toHaveBeenCalledTimes(1); expect(item.close).toHaveBeenCalledTimes(1);
    }
  });
  it('accepts exactly three redirects and rejects a fourth', async () => {
    const permitted = vi.fn<SourceReleaseRequest>().mockImplementation(async () => permitted.mock.calls.length <= SOURCE_RELEASE_MAX_REDIRECTS
      ? response('', 302, {location: SOURCE_RELEASE_FEED_URL}) : response(JSON.stringify(candidate())));
    await expect(feed(permitted).fetchSourceRelease(signal())).resolves.toEqual(candidate());
    expect(permitted).toHaveBeenCalledTimes(4);
    const request = vi.fn<SourceReleaseRequest>().mockImplementation(async () => response('', 302, {location: SOURCE_RELEASE_FEED_URL}));
    await expect(feed(request).fetchSourceRelease(signal())).rejects.toThrow('connection failed');
    expect(request).toHaveBeenCalledTimes(SOURCE_RELEASE_MAX_REDIRECTS + 1);
  });
  it('forbids CDN redirects back to GitHub or to another CDN URL', async () => {
    for (const destination of [SOURCE_RELEASE_FEED_URL, 'https://release-assets.githubusercontent.com/github-production-release-asset/123/cc-dd']) {
      const request = vi.fn<SourceReleaseRequest>().mockResolvedValueOnce(response('', 302, {location: 'https://release-assets.githubusercontent.com/github-production-release-asset/123/aa-bb'}))
        .mockResolvedValueOnce(response('', 302, {location: destination}));
      await expect(feed(request).fetchSourceRelease(signal())).rejects.toThrow('connection failed'); expect(request).toHaveBeenCalledTimes(2);
    }
  });
  it('rejects oversized, malformed, compressed, truncated and unsuccessful responses after closing them', async () => {
    const items = [response('small', 200, {'content-length': String(SOURCE_RELEASE_MAX_BYTES + 1)}), response(Buffer.alloc(SOURCE_RELEASE_MAX_BYTES + 1)),
      response('{}', 200, {'content-length': '100'}), response('{}', 200, {'content-length': ['2', '2']} as unknown as IncomingHttpHeaders),
      response('{}', 200, {'content-length': '-1'}), response('{}', 200, {'content-length': '2junk'}), response('{}', 200, {'content-length': '02'}),
      response(JSON.stringify(candidate()), 200, {'content-encoding': 'gzip'}), response('{}', 204), response('{}', 500), response('', 302),
      response(Buffer.from([0xff, 0xfe])), response('{'), response('null')];
    for (const item of items) {
      await expect(feed(async () => item).fetchSourceRelease(signal())).rejects.toThrow(); expect(item.close).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds unknown-length chunked bodies and accepts exactly 64 KiB', async () => {
    const json = JSON.stringify(candidate());
    const bytes = json + ' '.repeat(SOURCE_RELEASE_MAX_BYTES - Buffer.byteLength(json));
    await expect(feed(async () => response(Readable.from([bytes.slice(0, 300), bytes.slice(300)]))).fetchSourceRelease(signal())).resolves.toEqual(candidate());
    const item = response(Readable.from([bytes, ' ']));
    await expect(feed(async () => item).fetchSourceRelease(signal())).rejects.toThrow('size limit'); expect(item.body.closed).toBe(true);
  });
  it('uses the existing exact schemaVersion 1 manifest contract and rejects package metadata', async () => {
    const cases: unknown[] = [{...candidate(), schemaVersion: 2}, {...candidate(), artifact: {url: 'https://example.invalid/app.zip'}},
      {...candidate(), sourceSha: 'main'}, {...candidate(), repository: 'https://github.com/other/repository.git'},
      {...candidate(), version: '0.2.0-beta'}, {...candidate(), buildNumber: '025'}, {...candidate(), lockfileSha256: 'short'},
      {...candidate(), publishedAt: '2026-10-08'}, {...candidate(), changelog: ['line\nbreak']}];
    const missing = {...candidate()} as Record<string, unknown>; delete missing.lockfileSha256; cases.push(missing);
    for (const value of cases) await expect(feed(async () => response(JSON.stringify(value))).fetchSourceRelease(signal())).rejects.toThrow('manifest is invalid');
  });
  it('enforces 90-day maximum age and rejects all future publication timestamps', async () => {
    for (const offset of [-SOURCE_RELEASE_MAX_AGE_MS, 0]) {
      const target = {...candidate(), publishedAt: new Date(now.getTime() + offset).toISOString()};
      await expect(feed(async () => response(JSON.stringify(target))).fetchSourceRelease(signal())).resolves.toEqual(target);
    }
    for (const offset of [-SOURCE_RELEASE_MAX_AGE_MS - 1, 1]) {
      const target = {...candidate(), publishedAt: new Date(now.getTime() + offset).toISOString()};
      await expect(feed(async () => response(JSON.stringify(target))).fetchSourceRelease(signal())).rejects.toThrow('not current');
    }
    await expect(new SourceReleaseFeed({now: () => new Date(NaN), request: async () => response(JSON.stringify(candidate()))}).fetchSourceRelease(signal())).rejects.toThrow('not current');
  });
  it('distinguishes unpublished releases only after original response/network closure', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), item = response('', 404, {}, gate);
    let settled = false;
    const pending = feed(async () => item).fetchSourceRelease(signal()).finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toMatchObject({name: 'SourceReleaseUnavailableError', code: 'SOURCE_RELEASE_UNAVAILABLE'});
    await vi.waitFor(() => expect(item.close).toHaveBeenCalledTimes(1)); expect(settled).toBe(false);
    release(); await assertion;
    await expect(feed(async () => response('', 404)).fetchSourceRelease(signal())).rejects.toBeInstanceOf(SourceReleaseUnavailableError);
  });
  it('rejects already-aborted calls without touching the network', async () => {
    const request = vi.fn<SourceReleaseRequest>(), controller = new AbortController(); controller.abort();
    await expect(feed(request).fetchSourceRelease(controller.signal)).rejects.toMatchObject({name: 'AbortError'}); expect(request).not.toHaveBeenCalled();
  });
  it('cancellation during a successful or missing response closure never becomes a late result', async () => {
    for (const status of [200, 404]) {
      let release!: () => void;
      const controller = new AbortController(), gate = new Promise<void>(resolve => { release = resolve; });
      const item = response(JSON.stringify(candidate()), status, {}, gate);
      let settled = false;
      const pending = feed(async () => item).fetchSourceRelease(controller.signal).finally(() => { settled = true; });
      const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});
      await vi.waitFor(() => expect(item.close).toHaveBeenCalledTimes(1)); controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
      release(); await assertion;
    }
  });
  it('joins a late backend response after cancellation and does not follow its redirect', async () => {
    let deliver!: (value: SourceReleaseResponse) => void, release!: () => void;
    const controller = new AbortController(), item = response('', 302, {location: SOURCE_RELEASE_FEED_URL}, new Promise<void>(resolve => { release = resolve; }));
    const request = vi.fn<SourceReleaseRequest>().mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    let settled = false;
    const pending = feed(request).fetchSourceRelease(controller.signal).finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    controller.abort(); await Promise.resolve(); expect(settled).toBe(false); deliver(item);
    await vi.waitFor(() => expect(item.close).toHaveBeenCalledTimes(1)); expect(settled).toBe(false);
    release(); await assertion; expect(request).toHaveBeenCalledTimes(1);
  });
  it('cancellation joins a stalled body and the original network closure', async () => {
    let release!: () => void;
    const controller = new AbortController(), body = new PassThrough(), item = response(body, 200, {}, new Promise<void>(resolve => { release = resolve; }));
    const request = vi.fn<SourceReleaseRequest>().mockResolvedValue(item);
    let settled = false;
    const pending = feed(request).fetchSourceRelease(controller.signal).finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(body.listenerCount('readable')).toBeGreaterThan(0));
    body.write('{'); controller.abort(); await vi.waitFor(() => expect(item.close).toHaveBeenCalledTimes(1));
    expect(body.closed).toBe(true); expect(settled).toBe(false); release(); await assertion;
  });
  it('times out a stalled body and waits for its original network closure', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const body = new PassThrough(), item = response(body, 200, {}, new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const pending = feed(async () => item).fetchSourceRelease(signal()).finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(SOURCE_RELEASE_TIMEOUT_MS); expect(body.closed).toBe(true); expect(settled).toBe(false);
    release(); await assertion; expect(item.close).toHaveBeenCalledTimes(1);
  });
  it('times out before headers without abandoning the original request promise', async () => {
    vi.useFakeTimers(); let deliver!: (value: SourceReleaseResponse) => void;
    const item = response(JSON.stringify(candidate())), request = vi.fn<SourceReleaseRequest>().mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    let settled = false;
    const pending = feed(request).fetchSourceRelease(signal()).finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(SOURCE_RELEASE_TIMEOUT_MS); expect(request.mock.calls[0][1].signal.aborted).toBe(true); expect(settled).toBe(false);
    deliver(item); await assertion; expect(item.close).toHaveBeenCalledTimes(1);
  });
  it('does not leak backend, stream or closure errors containing signed URLs', async () => {
    for (const request of [async () => { throw new Error('secret DNS proxy token'); },
      async () => response(Readable.from((async function* () { throw new Error('secret signed CDN URL'); })())),
      async () => ({...response(JSON.stringify(candidate())), close: async () => { throw new Error('secret close token'); }})]) {
      await expect(feed(request).fetchSourceRelease(signal())).rejects.toThrow(/^The source update connection failed$/);
    }
  });
  it('blocks private, reserved and IPv4-mapped DNS answers while accepting GitHub public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.2.3', '192.168.1.2', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '198.18.0.1', '198.19.0.1', '192.0.2.1', '192.0.0.9', '192.88.99.1', '198.51.100.1', '203.0.113.1',
      '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', '2001:2::1', '3fff::1', '2002:7f00:1::1', '64:ff9b::7f00:1', '2606:50c0:8000::154%lo', 'not-an-ip']) {
      expect(isPublicSourceReleaseAddress(ip), ip).toBe(false);
    }
    for (const ip of ['140.82.114.3', '185.199.108.133', '2606:50c0:8000::154']) expect(isPublicSourceReleaseAddress(ip), ip).toBe(true);
  });
});
