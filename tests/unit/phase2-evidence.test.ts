import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createEvidenceReader, EVIDENCE_LIMITS, extractEvidenceImageReferences, parseEvidenceTarget, type EvidenceRegistration } from '../../src/phase2/evidence';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const hash = (text: string | Buffer) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
async function fixture(registrations: EvidenceRegistration[] = [{ id: 'design', relativePath: 'design.md' }]) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-evidence-'))); roots.push(root);
  await fs.writeFile(path.join(root, 'design.md'), '# 설계\n<script>alert(1)</script>\n![outside](https://example.invalid/tracking.png)');
  const options = { scopeId: 'project-synthetic', canonicalRootPath: root, registrations, now: () => Date.parse('2026-10-07T00:00:00.000Z') };
  return { root, options };
}
async function request(reader: Awaited<ReturnType<typeof createEvidenceReader>>, expectedSourceHash: string | null = null) {
  return reader.read({ evidenceId: reader.list()[0].evidenceId, expectedSourceHash });
}
const images = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z',
  gif: 'R0lGODdhAgADAIEAAP8AAAAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7',
  webp: 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
};
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, body: Buffer) { const result = Buffer.alloc(body.length + 12); result.writeUInt32BE(body.length); result.write(name, 4); body.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result; }
function pngFixture(width: number, height: number, raw: Buffer, interlace = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; header[12] = interlace;
  return Buffer.concat([Buffer.from(images.png, 'base64').subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
describe('Phase 2 registered evidence boundary', () => {
  it('returns detached bounded plain text, source hash, provenance and no filesystem paths or scans', async () => {
    const f = await fixture([{ id: 'design', relativePath: 'design.md', label: '설계', anchor: '선택', origin: 'synthetic' }]);
    const scan = vi.spyOn(fs, 'readdir'), fetch = vi.spyOn(globalThis, 'fetch'); const reader = await createEvidenceReader(f.options);
    const first = reader.list(); expect(first[0].evidenceId).toMatch(/^evidence-[a-f0-9-]+$/);
    first[0].label = 'tampered'; first[0].evidenceId = 'tampered'; f.options.registrations[0].relativePath = 'outside.txt';
    const result = await request(reader); expect(result).toMatchObject({ ok: true, label: '설계', anchor: '선택', origin: 'synthetic', verification: 'not-assessed', observedAt: '2026-10-07T00:00:00.000Z' });
    if (!result.ok || result.content.kind !== 'text') throw new Error('Expected text');
    expect(result.content.rendering).toBe('plain-text'); expect(result.content.text).toContain('<script>alert(1)</script>');
    expect(result.sourceHash).toBe(hash(result.content.text)); expect(result.content.imageReferences.unsupportedCount).toBe(1); expect(result.omissions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(f.root); expect(scan).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    result.content.text = 'tampered'; expect(await request(reader)).toMatchObject({ content: { text: expect.stringContaining('# 설계') } });
  });
  it('requires exact opaque IDs and rejects renderer paths, getters, prototype objects and cross-reader IDs', async () => {
    const f = await fixture(); const reader = await createEvidenceReader(f.options), other = await createEvidenceReader(f.options); const open = vi.spyOn(fs, 'open');
    expect(await reader.read({ evidenceId: other.list()[0].evidenceId, expectedSourceHash: null })).toMatchObject({ code: 'unregistered' });
    for (const value of [{ path: '/etc/passwd' }, { evidenceId: reader.list()[0].evidenceId, expectedSourceHash: null, relativePath: 'design.md' }, { evidenceId: 'design' }, Object.create({ evidenceId: 'x', expectedSourceHash: null })]) expect(await reader.read(value)).toMatchObject({ code: 'invalid-request' });
    const getter = { expectedSourceHash: null, get evidenceId() { throw new Error('Accessor must not run'); } }; expect(await reader.read(getter)).toMatchObject({ code: 'invalid-request' });
    expect(await reader.read({ evidenceId: 'design', expectedSourceHash: null })).toMatchObject({ code: 'unregistered' }); expect(open).not.toHaveBeenCalled();
  });
  it('validates registration shape, counts, and relative paths before any read', async () => {
    const f = await fixture(); const open = vi.spyOn(fs, 'open');
    for (const relativePath of ['../outside.md', '/outside.md', 'a/../design.md', 'a//b', 'a\\b', 'file:///tmp/a', 'https://example.invalid/x', 'design.md?x', 'percent%2foutside', './design.md']) {
      await expect(createEvidenceReader({ ...f.options, registrations: [{ id: 'one', relativePath }] })).rejects.toMatchObject({ code: 'invalid-registration' });
    }
    await expect(createEvidenceReader({ ...f.options, registrations: new Array(1) })).rejects.toMatchObject({ code: 'invalid-registration' });
    await expect(createEvidenceReader({ ...f.options, registrations: [f.options.registrations[0], f.options.registrations[0]] })).rejects.toMatchObject({ code: 'invalid-registration' });
    await expect(createEvidenceReader({ ...f.options, registrations: Array.from({ length: EVIDENCE_LIMITS.registrations + 1 }, (_, i) => ({ id: `x${i}`, relativePath: 'design.md' })) })).rejects.toMatchObject({ code: 'invalid-registration' });
    const getter = { ...f.options.registrations[0] }; Object.defineProperty(getter, 'relativePath', { get() { throw new Error('Do not invoke'); } });
    await expect(createEvidenceReader({ ...f.options, registrations: [getter] })).rejects.toMatchObject({ code: 'invalid-registration' }); expect(open).not.toHaveBeenCalled();
  });
  it('checks permission at creation and on both sides of a read', async () => {
    const f = await fixture(); await expect(createEvidenceReader({ ...f.options, authorize: () => false })).rejects.toMatchObject({ code: 'permission-denied' });
    let calls = 0; const reader = await createEvidenceReader({ ...f.options, authorize: () => ++calls < 3 });
    expect(await request(reader)).toEqual({ ok: false, code: 'permission-denied', omitted: true });
    const open = vi.spyOn(fs, 'open'); expect(await request(reader)).toMatchObject({ code: 'permission-denied' }); expect(open).not.toHaveBeenCalled();
  });
  it('rejects final/ancestor symlinks and hardlinks without opening them', async () => {
    const f = await fixture(); await fs.symlink('design.md', path.join(f.root, 'alias.md')); await fs.symlink('.', path.join(f.root, 'linked'));
    const open = vi.spyOn(fs, 'open');
    for (const relativePath of ['alias.md', 'linked/design.md']) { const reader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'link', relativePath }] }); expect(await request(reader)).toMatchObject({ code: 'unsafe-source' }); }
    await fs.link(path.join(f.root, 'design.md'), path.join(f.root, 'hard.md')); const hard = await createEvidenceReader(f.options); expect(await request(hard)).toMatchObject({ code: 'unsafe-source' }); expect(open).not.toHaveBeenCalled();
  });
  it('rejects noncanonical roots and changed root identities', async () => {
    const f = await fixture(); const rootAlias = `${f.root}-alias`; roots.push(rootAlias); await fs.symlink(f.root, rootAlias);
    await expect(createEvidenceReader({ ...f.options, canonicalRootPath: rootAlias })).rejects.toMatchObject({ code: 'unsafe-source' });
    const reader = await createEvidenceReader(f.options), moved = `${f.root}-moved`; roots.push(moved); await fs.rename(f.root, moved); await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, 'design.md'), 'replacement');
    expect(await request(reader)).toMatchObject({ code: 'source-changed' });
  });
  it('refuses directories and FIFOs before open; missing evidence remains unavailable', async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, 'directory.txt'));
    await promisify(execFile)('mkfifo', [path.join(f.root, 'pipe.txt')]);
    const open = vi.spyOn(fs, 'open');
    for (const relativePath of ['directory.txt', 'pipe.txt', 'missing.md']) { const reader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'file', relativePath }] }); expect(await request(reader)).toMatchObject({ ok: false, code: relativePath === 'missing.md' ? 'source-unavailable' : 'unsafe-source', omitted: true }); }
    expect(open).not.toHaveBeenCalled();
  });
  it('rejects stale expected/pinned hashes while allowing an explicit fresh observation', async () => {
    const f = await fixture(); const reader = await createEvidenceReader(f.options), original = await request(reader); if (!original.ok) throw new Error('Expected original');
    await fs.writeFile(path.join(f.root, 'design.md'), 'changed'); expect(await request(reader, original.sourceHash)).toEqual({ ok: false, code: 'stale-source', omitted: true });
    expect(await request(reader)).toMatchObject({ ok: true, sourceHash: hash('changed') });
    const pinned = await createEvidenceReader({ ...f.options, registrations: [{ id: 'design', relativePath: 'design.md', sourceHash: original.sourceHash }] }); expect(await request(pinned)).toMatchObject({ code: 'stale-source' });
  });
  it('detects changes between bounded reads and closes its descriptor without partial content', async () => {
    const f = await fixture(); const reader = await createEvidenceReader(f.options), original = fs.open.bind(fs), closed = vi.fn();
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => { const handle = await original(...args), read = handle.read.bind(handle), close = handle.close.bind(handle); let changed = false;
      handle.read = (async (...readArgs: any[]) => { const result = await (read as any)(...readArgs); if (!changed) { changed = true; await fs.writeFile(path.join(f.root, 'design.md'), 'x'.repeat(result.bytesRead)); } return result; }) as typeof handle.read;
      handle.close = async () => { closed(); return close(); }; return handle;
    });
    expect(await request(reader)).toEqual({ ok: false, code: 'source-changed', omitted: true }); expect(closed).toHaveBeenCalledTimes(1);
  });
  it('rejects a final symlink substituted immediately before open', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.root, 'alternate.md'), 'alternate'); const reader = await createEvidenceReader(f.options), original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => { await fs.unlink(path.join(f.root, 'design.md')); await fs.symlink('alternate.md', path.join(f.root, 'design.md')); return original(...args); });
    expect(await request(reader)).toMatchObject({ ok: false, omitted: true });
  });
  it('bounds UTF-8 text and raster bytes before opening, with no truncated success', async () => {
    const f = await fixture(); const reader = await createEvidenceReader(f.options); await fs.writeFile(path.join(f.root, 'design.md'), Buffer.alloc(EVIDENCE_LIMITS.textBytes + 1, 'x'));
    const open = vi.spyOn(fs, 'open'); expect(await request(reader)).toMatchObject({ code: 'source-limit' }); expect(open).not.toHaveBeenCalled(); open.mockRestore();
    await fs.writeFile(path.join(f.root, 'image.png'), Buffer.alloc(EVIDENCE_LIMITS.imageBytes + 1)); const imageReader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'image', relativePath: 'image.png' }] }); expect(await request(imageReader)).toMatchObject({ code: 'source-limit' });
    await fs.writeFile(path.join(f.root, 'design.md'), '한'.repeat(Math.floor(EVIDENCE_LIMITS.textBytes / 3))); expect(await request(reader)).toMatchObject({ ok: true });
  });
  it('rejects binary masquerading as text, SVG, HTML and invalid UTF-8', async () => {
    const f = await fixture(); const reader = await createEvidenceReader(f.options);
    for (const bytes of [Buffer.from([255]), Buffer.from('text\0binary'), Buffer.from([1, 65]), Buffer.from(images.png, 'base64')]) { await fs.writeFile(path.join(f.root, 'design.md'), bytes); expect(await request(reader)).toMatchObject({ code: 'invalid-content' }); }
    for (const relativePath of ['image.svg', 'page.html', 'script.js', 'file.bin']) { await fs.writeFile(path.join(f.root, relativePath), '<svg onload="alert(1)"/>'); const r = await createEvidenceReader({ ...f.options, registrations: [{ id: 'one', relativePath }] }); expect(await request(r)).toMatchObject({ code: 'unsupported-type' }); }
  });
  it.each(Object.entries(images))('sniffs %s and returns only bounded data-image content', async (extension, encoded) => {
    const f = await fixture(); const relativePath = `image.${extension}`; await fs.writeFile(path.join(f.root, relativePath), Buffer.from(encoded, 'base64'));
    const reader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'image', relativePath }] });
    const result = await request(reader); expect(result).toMatchObject({ ok: true, verification: 'not-assessed', content: { kind: 'image', width: 2, height: 3, mime: `image/${extension}`, validation: 'bounded-format' } });
    if (!result.ok || result.content.kind !== 'image') throw new Error('Expected image'); expect(result.content.dataUrl).toBe(`data:image/${extension};base64,${encoded}`);
  });
  it.each(Object.entries(images))('rejects truncated, wrong-MIME and trailing-polyglot %s bytes', async (extension, encoded) => {
    const f = await fixture(); const relativePath = `image.${extension}`, reader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'image', relativePath }] }); const bytes = Buffer.from(encoded, 'base64');
    for (const content of [bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from('<script/>')]), Buffer.from('<svg onload="alert(1)"/>')]) { await fs.writeFile(path.join(f.root, relativePath), content); expect(await request(reader)).toMatchObject({ code: 'invalid-content' }); }
  });
  it('checks image dimensions and PNG CRC/inflate/filter bounds', async () => {
    const f = await fixture(); const reader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'image', relativePath: 'image.png' }] });
    const cases = [
      [pngFixture(EVIDENCE_LIMITS.imageSide + 1, 1, Buffer.from([0])), 'source-limit'],
      [pngFixture(1, 1, Buffer.from([0, 255, 0, 0])), null],
      [pngFixture(1, 1, Buffer.from([5, 255, 0, 0])), 'invalid-content'],
      [pngFixture(1, 1, Buffer.alloc(10_000)), 'invalid-content'],
      [pngFixture(1, 1, Buffer.from([0, 255, 0, 0]), 1), 'unsupported-type'],
    ] as const;
    for (const [bytes, code] of cases) { await fs.writeFile(path.join(f.root, 'image.png'), bytes); expect(await request(reader)).toMatchObject(code ? { ok: false, code } : { ok: true }); }
    const damaged = Buffer.from(images.png, 'base64'); damaged[30] ^= 1; await fs.writeFile(path.join(f.root, 'image.png'), damaged); expect(await request(reader)).toMatchObject({ code: 'invalid-content' });
  });
  it('bounds initialization and sanitizes unavailable-root failures', async () => {
    const f = await fixture();
    await expect(createEvidenceReader({ ...f.options, timeoutMs: 10, authorize: () => new Promise<boolean>(() => {}) })).rejects.toMatchObject({ code: 'timeout' });
    try { await createEvidenceReader({ ...f.options, canonicalRootPath: path.join(f.root, 'missing') }); throw new Error('Expected unavailable root'); }
    catch (error) { expect(error).toMatchObject({ code: 'source-unavailable' }); expect(String(error)).not.toContain(f.root); }
  });
  it('rejects excessive GIF/JPEG/WebP dimensions and animated WebP', async () => {
    const f = await fixture();
    for (const extension of ['gif', 'jpeg', 'webp'] as const) {
      const bytes = Buffer.from(images[extension], 'base64');
      if (extension === 'gif') bytes.writeUInt16LE(EVIDENCE_LIMITS.imageSide + 1, 6);
      if (extension === 'jpeg') bytes.writeUInt16BE(EVIDENCE_LIMITS.imageSide + 1, bytes.indexOf(Buffer.from([255, 192])) + 7);
      if (extension === 'webp') bytes.writeUInt16LE(EVIDENCE_LIMITS.imageSide + 1, 26);
      const relativePath = `large.${extension}`; await fs.writeFile(path.join(f.root, relativePath), bytes);
      const reader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'large', relativePath }] }); expect(await request(reader)).toMatchObject({ code: 'source-limit' });
    }
    const vp8x = Buffer.alloc(18); vp8x.write('VP8X'); vp8x.writeUInt32LE(10, 4); vp8x[8] = 2;
    const bytes = Buffer.concat([Buffer.from(images.webp, 'base64').subarray(0, 12), vp8x]); bytes.writeUInt32LE(bytes.length - 8, 4);
    await fs.writeFile(path.join(f.root, 'animated.webp'), bytes); const reader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'animated', relativePath: 'animated.webp' }] }); expect(await request(reader)).toMatchObject({ code: 'unsupported-type' });
  });
  it('omits compressed PNG metadata instead of passing an ancillary decompression bomb to the renderer', async () => {
    const f = await fixture(); const image = Buffer.from(images.png, 'base64');
    const bytes = Buffer.concat([image.subarray(0, 33), chunk('iCCP', Buffer.from('compressed metadata')), image.subarray(33)]);
    await fs.writeFile(path.join(f.root, 'image.png'), bytes); const reader = await createEvidenceReader({ ...f.options, registrations: [{ id: 'image', relativePath: 'image.png' }] }); expect(await request(reader)).toMatchObject({ code: 'unsupported-type' });
  });
  it('honors cancellation before open and retires the request lifetime', async () => {
    const f = await fixture(); const reader = await createEvidenceReader(f.options), c = new AbortController(); c.abort(); const open = vi.spyOn(fs, 'open');
    expect(await reader.read({ evidenceId: reader.list()[0].evidenceId, expectedSourceHash: null }, c.signal)).toMatchObject({ code: 'cancelled' }); expect(await request(reader)).toMatchObject({ code: 'retired' }); expect(open).not.toHaveBeenCalled();
  });
  it('bounds stalled open, refuses overlapping requests and closes a late descriptor', async () => {
    const f = await fixture(); const reader = await createEvidenceReader({ ...f.options, timeoutMs: 50 }), original = fs.open.bind(fs), closed = vi.fn(); let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), opened = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => { const handle = await original(...args), close = handle.close.bind(handle); handle.close = async () => { closed(); await close(); }; reached(); await gate; return handle; });
    const pending = request(reader); await opened; expect(await request(reader)).toMatchObject({ code: 'busy' }); expect(await pending).toMatchObject({ code: 'timeout' }); expect(await request(reader)).toMatchObject({ code: 'retired' }); release(); await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });
  it('does not return a late response after explicit retirement', async () => {
    const f = await fixture(); let calls = 0, retire = () => {}; const reader = await createEvidenceReader({ ...f.options, authorize: () => { if (++calls === 3) retire(); return true; } }); retire = reader.retire;
    expect(await request(reader)).toMatchObject({ code: 'retired' });
  });
});
describe('explicit evidence and inert image targets', () => {
  it('preserves explicit wikilink/anchor/label and image extensions without guessing or resolving', () => {
    expect(parseEvidenceTarget('[[plans/design#선택|설계]]')).toEqual({ relativePath: 'plans/design.md', anchor: '선택', label: '설계' });
    expect(parseEvidenceTarget('[[images/check.png|확인]]')).toEqual({ relativePath: 'images/check.png', anchor: null, label: '확인' });
    expect(parseEvidenceTarget('notes/design.md#anchor')).toEqual({ relativePath: 'notes/design.md', anchor: 'anchor', label: 'notes/design.md' });
    for (const value of ['[[../outside]]', '[[file:///outside]]', '[[https://remote.test/file]]', '[[design#]]', '[[design|]]', '/absolute.png', '[[a#b#c]]', '[[a%2fb]]']) expect(() => parseEvidenceTarget(value)).toThrow();
  });
  it('extracts only bounded explicit raster declarations and counts unsupported forms honestly', () => {
    const result = extractEvidenceImageReferences('![확인](images/check.png)\n![[images/diagram.webp|그림]]\n![same](images/check.png "duplicate")\n![remote](https://example.invalid/a.png)\n![escape](../a.png)\n![SVG](safe.svg)\n![broken](\n<img src="inline.png">');
    expect(result.targets).toEqual([{ relativePath: 'images/check.png', anchor: null, label: '확인' }, { relativePath: 'images/diagram.webp', anchor: null, label: '그림' }]); expect(result.unsupportedCount).toBe(5);
    const many = extractEvidenceImageReferences(Array.from({ length: EVIDENCE_LIMITS.imageReferences + 1 }, (_, i) => `![x](image${i}.png)`).join('\n')); expect(many.targets).toHaveLength(EVIDENCE_LIMITS.imageReferences); expect(many.unsupportedCount).toBe(1);
  });
});
