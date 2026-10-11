import {beforeEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import * as https from 'node:https';
import type {ClientRequest, IncomingMessage} from 'node:http';
import * as dns from 'node:dns';
import {requestSourceReleaseHttps, SOURCE_RELEASE_FEED_URL} from '../../src/main/update/source-feed';

vi.mock('node:https', () => ({request: vi.fn()}));
vi.mock('node:dns', () => ({lookup: vi.fn()}));
class FakeRequest extends EventEmitter {
  closed = false;
  end = vi.fn();
  destroy = vi.fn();
  finishClose() { this.closed = true; this.emit('close'); }
}
beforeEach(() => { vi.mocked(https.request).mockReset(); vi.mocked(dns.lookup).mockReset(); });
describe('production source-feed HTTPS backend', () => {
  it('uses verified TLS and public DNS without ambient auth, cookies, proxy agent or session headers', async () => {
    const request = new FakeRequest(), body = new PassThrough(), controller = new AbortController();
    vi.mocked(https.request).mockImplementation(((_url: URL, _options: https.RequestOptions, received: (response: IncomingMessage) => void) => {
      queueMicrotask(() => received(Object.assign(body, {statusCode: 200, headers: {}}) as unknown as IncomingMessage));
      return request as unknown as ClientRequest;
    }) as typeof https.request);
    const item = await requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: controller.signal});
    const options = vi.mocked(https.request).mock.calls[0][1] as https.RequestOptions;
    expect(options).toMatchObject({method: 'GET', agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16 * 1024, signal: controller.signal});
    expect(options.headers).toEqual({'user-agent': 'note-app-source-updater/1', accept: 'application/json', 'accept-encoding': 'identity', 'cache-control': 'no-cache'});
    const callback = vi.fn();
    vi.mocked(dns.lookup).mockImplementation(((_host: string, _opts: unknown, resolved: (error: null, addresses: dns.LookupAddress[]) => void) => {
      resolved(null, [{address: '140.82.114.3', family: 4}, {address: '127.0.0.1', family: 4}]);
    }) as typeof dns.lookup);
    options.lookup!('github.com', {all: true}, callback);
    expect(callback.mock.calls[0][0]).toMatchObject({code: 'EUPDATEADDRESS'});
    callback.mockClear();
    vi.mocked(dns.lookup).mockImplementation(((_host: string, _opts: unknown, resolved: (error: null, addresses: dns.LookupAddress[]) => void) => {
      resolved(null, [{address: '140.82.114.3', family: 4}, {address: '2606:50c0:8000::154', family: 6}]);
    }) as typeof dns.lookup);
    options.lookup!('github.com', {all: true, family: 6}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [{address: '2606:50c0:8000::154', family: 6}]);
    options.lookup!('github.com', {family: 4}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, '140.82.114.3', 4);
    let closed = false; const closing = item.close().then(() => { closed = true; });
    expect(item.close()).toBe(item.close());
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
    expect(body.closed).toBe(true); request.finishClose(); await closing; expect(request.destroy).toHaveBeenCalledTimes(1);
  });
  it('fails closed on DNS errors, empty answers or an unavailable address family', async () => {
    const request = new FakeRequest(), body = new PassThrough();
    vi.mocked(https.request).mockImplementation(((_url: URL, _options: https.RequestOptions, received: (response: IncomingMessage) => void) => {
      queueMicrotask(() => received(Object.assign(body, {statusCode: 200, headers: {}}) as unknown as IncomingMessage));
      return request as unknown as ClientRequest;
    }) as typeof https.request);
    const item = await requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: new AbortController().signal});
    const options = vi.mocked(https.request).mock.calls[0][1] as https.RequestOptions;
    for (const [error, addresses] of [[new Error('secret DNS server'), []], [null, []], [null, [{address: '140.82.114.3', family: 4}]]] as const) {
      vi.mocked(dns.lookup).mockImplementation(((_host: string, _opts: unknown, resolved: (error: Error | null, addresses: readonly dns.LookupAddress[]) => void) => {
        resolved(error, addresses);
      }) as typeof dns.lookup);
      const callback = vi.fn(); options.lookup!('github.com', {family: 6}, callback);
      expect(callback.mock.calls[0][0]).toMatchObject({message: 'The source update connection failed', code: 'EUPDATEADDRESS'});
    }
    const closing = item.close(); request.finishClose(); await closing;
  });
  it('owns response errors before consumption and reports them only after both closures', async () => {
    const request = new FakeRequest(), body = new PassThrough();
    vi.mocked(https.request).mockImplementation(((_url: URL, _options: https.RequestOptions, received: (response: IncomingMessage) => void) => {
      queueMicrotask(() => received(Object.assign(body, {statusCode: 200, headers: {}}) as unknown as IncomingMessage));
      return request as unknown as ClientRequest;
    }) as typeof https.request);
    const item = await requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: new AbortController().signal});
    body.emit('error', new Error('secret response URL'));
    let settled = false;
    const closing = item.close().finally(() => { settled = true; });
    const assertion = expect(closing).rejects.toThrow(/^The source update connection failed$/);
    await new Promise(resolve => setImmediate(resolve)); expect(body.closed).toBe(true); expect(settled).toBe(false);
    request.finishClose(); await assertion;
  });
  it('waits for request close after abort error and sanitizes the failure', async () => {
    const request = new FakeRequest(), controller = new AbortController();
    vi.mocked(https.request).mockReturnValue(request as unknown as ClientRequest);
    let settled = false;
    const pending = requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: controller.signal}).finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError', message: 'Source update check cancelled'});
    controller.abort(); request.emit('error', new Error('secret URL token must not escape'));
    await Promise.resolve(); expect(settled).toBe(false); request.finishClose(); await assertion;
  });
  it('suppresses a response racing failure and joins both original closures', async () => {
    const request = new FakeRequest(), body = new PassThrough(); let receive!: (message: IncomingMessage) => void;
    vi.mocked(https.request).mockImplementation(((_url: URL, _options: https.RequestOptions, received: (response: IncomingMessage) => void) => {
      receive = received; return request as unknown as ClientRequest;
    }) as typeof https.request);
    let settled = false;
    const pending = requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: new AbortController().signal}).finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toThrow(/^The source update connection failed$/);
    request.emit('error', new Error('TLS error with credential query'));
    receive(Object.assign(body, {statusCode: 200, headers: {}}) as unknown as IncomingMessage);
    request.finishClose(); expect(settled).toBe(false); await assertion; expect(body.closed).toBe(true);
  });
  it('suppresses a response racing abort even before the request emits its abort error', async () => {
    const request = new FakeRequest(), body = new PassThrough(), controller = new AbortController(); let receive!: (message: IncomingMessage) => void;
    vi.mocked(https.request).mockImplementation(((_url: URL, _options: https.RequestOptions, received: (response: IncomingMessage) => void) => {
      receive = received; return request as unknown as ClientRequest;
    }) as typeof https.request);
    const pending = requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: controller.signal});
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    controller.abort(); receive(Object.assign(body, {statusCode: 200, headers: {}}) as unknown as IncomingMessage);
    request.finishClose(); await assertion; expect(body.closed).toBe(true);
  });
  it('does not start an already-cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(https.request).not.toHaveBeenCalled();
  });
  it('sanitizes synchronous request-creation and end errors and joins created requests', async () => {
    vi.mocked(https.request).mockImplementation(() => { throw new Error('secret creation URL'); });
    await expect(requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: new AbortController().signal})).rejects.toThrow(/^The source update connection failed$/);
    const request = new FakeRequest(); request.end.mockImplementation(() => { throw new Error('secret end URL'); });
    vi.mocked(https.request).mockReturnValue(request as unknown as ClientRequest);
    let settled = false;
    const pending = requestSourceReleaseHttps(new URL(SOURCE_RELEASE_FEED_URL), {signal: new AbortController().signal}).finally(() => { settled = true; });
    const assertion = expect(pending).rejects.toThrow(/^The source update connection failed$/);
    await Promise.resolve(); expect(settled).toBe(false); expect(request.destroy).toHaveBeenCalledTimes(1); request.finishClose(); await assertion;
  });
});
