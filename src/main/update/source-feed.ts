import * as https from 'node:https';
import * as dns from 'node:dns';
import {isIP, type LookupFunction} from 'node:net';
import type {IncomingHttpHeaders} from 'node:http';
import type {Readable} from 'node:stream';
import {parseApprovedDemoManifest, type ApprovedDemoManifest} from './manifest';

/** Trusted main selects this one source feed; renderer/config/environment cannot supply a URL. */
export const SOURCE_RELEASE_FEED_URL = 'https://github.com/zeno0505/note-app/releases/latest/download/note-app-source-update.json' as const;
export const SOURCE_RELEASE_MAX_BYTES = 64 * 1024;
export const SOURCE_RELEASE_TIMEOUT_MS = 30_000;
export const SOURCE_RELEASE_MAX_REDIRECTS = 3;
export const SOURCE_RELEASE_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const MAX_LOCATION_BYTES = 8192;
const abortError = () => Object.assign(new Error('Source update check cancelled'), {name: 'AbortError'});
class SourceFeedFailure extends Error {}
const transportError = () => new SourceFeedFailure('The source update connection failed');
const checkAborted = (signal: AbortSignal) => { if (signal.aborted) throw abortError(); };

export class SourceReleaseUnavailableError extends Error {
  readonly code = 'SOURCE_RELEASE_UNAVAILABLE' as const;
  constructor() { super('No source update has been published'); this.name = 'SourceReleaseUnavailableError'; }
}
export interface SourceReleaseResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
  /** Destroy and join the original request and response, including on failure/cancellation. */
  close(): Promise<void>;
}
/** Main/test-only injection. Rejection must also wait for all original network activity to close. */
export type SourceReleaseRequest = (url: URL, options: {signal: AbortSignal}) => Promise<SourceReleaseResponse>;
export interface SourceReleaseFeedOptions {request?: SourceReleaseRequest; now?: () => Date}

/** Reject loopback, LAN, metadata, documentation, transition and reserved address ranges. */
export function isPublicSourceReleaseAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6 && !address.includes('%')) {
    const words = address.split(':'), first = Number.parseInt(words[0], 16), second = Number.parseInt(words[1] || '0', 16);
    return first >= 0x2000 && first < 0x3ffe && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002;
  }
  return false;
}
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, {all: true, verbatim: true}, (error, addresses) => {
    if (error || !addresses.length || addresses.some(item => !isPublicSourceReleaseAddress(item.address))) {
      callback(Object.assign(transportError(), {code: 'EUPDATEADDRESS'}), ''); return;
    }
    const compatible = options.family === 4 || options.family === 6 ? addresses.filter(item => item.family === options.family) : addresses;
    if (!compatible.length) { callback(Object.assign(transportError(), {code: 'EUPDATEADDRESS'}), ''); return; }
    if (options.all) callback(null, compatible); else callback(null, compatible[0].address, compatible[0].family);
  });
};
const waitForClose = (stream: {closed: boolean; once(event: 'close', listener: () => void): unknown}): Promise<void> =>
  stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve));

/** Fresh non-proxy agent, public-address DNS pinning, verified TLS, and no inherited session/credential headers. */
export const requestSourceReleaseHttps: SourceReleaseRequest = (url, {signal}) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(abortError()); return; }
  let delivered = false, failure: Error | undefined, undeliveredResponseClose = Promise.resolve();
  let request: ReturnType<typeof https.request>;
  try {
    request = https.request(url, {method: 'GET', agent: false, lookup: publicLookup, signal,
      rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16 * 1024,
      headers: {'user-agent': 'note-app-source-updater/1', accept: 'application/json',
        'accept-encoding': 'identity', 'cache-control': 'no-cache'}}, response => {
      response.on('error', () => { failure ??= signal.aborted ? abortError() : transportError(); });
      // Keep ownership if a response races cancellation/error. It can never become a late success.
      if (signal.aborted || failure) { undeliveredResponseClose = waitForClose(response); response.destroy(); request.destroy(); return; }
      delivered = true;
      let closing: Promise<void> | undefined;
      resolve({statusCode: response.statusCode ?? 0, headers: response.headers, body: response,
        close: () => closing ??= (async () => {
          const joined = Promise.all([waitForClose(request), waitForClose(response)]);
          response.destroy(); request.destroy(); await joined;
          if (failure) throw failure;
        })()});
    });
  } catch { reject(transportError()); return; }
  request.on('error', () => { failure ??= signal.aborted ? abortError() : transportError(); });
  request.once('close', () => { if (!delivered) void undeliveredResponseClose.then(() => reject(signal.aborted ? abortError() : failure ?? transportError())); });
  try { request.end(); } catch { failure ??= transportError(); request.destroy(); }
});

const cdnQueryKeys = new Set(['sp', 'sv', 'sr', 'spr', 'se', 'rscd', 'rsct', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv', 'sig', 'jwt',
  'response-content-disposition', 'response-content-type']);
/** Every hop must remain an exact source-feed release path or GitHub's signed release-assets CDN. */
export function validateSourceReleaseUrl(value: string, previous?: URL): URL {
  if (typeof value !== 'string' || value.length > MAX_LOCATION_BYTES || /[\u0000-\u0020\u007f\\]/.test(value)) throw transportError();
  let url: URL;
  try { url = new URL(value); } catch { throw transportError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href !== value
    || (url.hostname !== 'github.com' && url.hostname !== 'release-assets.githubusercontent.com')) throw transportError();
  if (!previous && value !== SOURCE_RELEASE_FEED_URL) throw transportError();
  if (url.hostname === 'github.com') {
    if (previous?.hostname === 'release-assets.githubusercontent.com' || url.search) throw transportError();
    if (value !== SOURCE_RELEASE_FEED_URL
      && !/^\/zeno0505\/note-app\/releases\/download\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/note-app-source-update\.json$/.test(url.pathname)) throw transportError();
  } else {
    if (!previous || previous.hostname !== 'github.com'
      || !/^\/github-production-release-asset\/\d+\/[a-fA-F0-9-]+$/.test(url.pathname)) throw transportError();
    const seen = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (!cdnQueryKeys.has(key) || seen.has(key) || /[\u0000-\u001f\u007f]/.test(value)) throw transportError();
      seen.add(key);
    }
    if (url.searchParams.has('spr') && url.searchParams.get('spr') !== 'https') throw transportError();
  }
  return url;
}
function responseLength(headers: IncomingHttpHeaders): number | null {
  const value = headers['content-length'];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,12})$/.test(value) || !Number.isSafeInteger(Number(value))) throw transportError();
  return Number(value);
}

export class SourceReleaseFeed {
  private readonly request: SourceReleaseRequest;
  private readonly now: () => Date;
  constructor(options: SourceReleaseFeedOptions = {}) { this.request = options.request ?? requestSourceReleaseHttps; this.now = options.now ?? (() => new Date()); }

  private async open(signal: AbortSignal): Promise<SourceReleaseResponse> {
    let url = validateSourceReleaseUrl(SOURCE_RELEASE_FEED_URL);
    for (let redirects = 0; ; redirects++) {
      checkAborted(signal);
      const response = await this.request(url, {signal});
      let accepted = false;
      try {
        checkAborted(signal);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          if (redirects >= SOURCE_RELEASE_MAX_REDIRECTS || typeof location !== 'string') throw transportError();
          url = validateSourceReleaseUrl(location, url);
        } else {
          if (response.statusCode === 404) throw new SourceReleaseUnavailableError();
          if (response.statusCode !== 200 || (response.headers['content-encoding'] !== undefined && response.headers['content-encoding'] !== 'identity')) throw transportError();
          accepted = true; return response;
        }
      } finally { if (!accepted) await response.close(); }
    }
  }

  private async consume(response: SourceReleaseResponse, signal: AbortSignal): Promise<Buffer> {
    const abort = () => response.body.destroy(abortError());
    signal.addEventListener('abort', abort, {once: true});
    let total = 0; const chunks: Buffer[] = [];
    try {
      checkAborted(signal);
      const length = responseLength(response.headers);
      if (length !== null && length > SOURCE_RELEASE_MAX_BYTES) throw new SourceFeedFailure('The source update manifest exceeds its size limit');
      for await (const data of response.body) {
        checkAborted(signal);
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        total += chunk.length;
        if (total > SOURCE_RELEASE_MAX_BYTES) throw new SourceFeedFailure('The source update manifest exceeds its size limit');
        chunks.push(chunk);
      }
      checkAborted(signal);
      if (length !== null && total !== length) throw new SourceFeedFailure('The source update manifest was truncated');
      return Buffer.concat(chunks, total);
    } finally { signal.removeEventListener('abort', abort); await response.close(); }
  }

  async fetchSourceRelease(outer: AbortSignal): Promise<ApprovedDemoManifest> {
    checkAborted(outer);
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort();
    outer.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SOURCE_RELEASE_TIMEOUT_MS); timer.unref();
    if (outer.aborted) abort();
    try {
      const bytes = await this.consume(await this.open(controller.signal), controller.signal);
      checkAborted(controller.signal);
      let target: ApprovedDemoManifest;
      try { target = parseApprovedDemoManifest(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))); }
      catch { throw new SourceFeedFailure('The source update manifest is invalid'); }
      const now = this.now().getTime(), published = Date.parse(target.publishedAt);
      if (!Number.isFinite(now) || published > now || now - published > SOURCE_RELEASE_MAX_AGE_MS) {
        throw new SourceFeedFailure('The source update manifest is not current');
      }
      checkAborted(controller.signal);
      return target;
    } catch (error) {
      if (outer.aborted) throw abortError();
      if (timedOut) throw new SourceFeedFailure('The source update check timed out');
      if (error instanceof SourceReleaseUnavailableError || error instanceof SourceFeedFailure) throw error;
      throw transportError(); // Do not expose DNS/TLS errors or signed redirect query strings.
    } finally { clearTimeout(timer); outer.removeEventListener('abort', abort); }
  }
}

const sourceReleaseFeed = new SourceReleaseFeed();
export const fetchSourceRelease = (signal: AbortSignal): Promise<ApprovedDemoManifest> => sourceReleaseFeed.fetchSourceRelease(signal);
