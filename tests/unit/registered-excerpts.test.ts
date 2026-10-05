import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRegisteredExcerptReader, parseExcerptRegistrations, registeredExcerptId, validateRegisteredExcerptContext, type ExcerptRegistration } from '../../src/summary/context/registered';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const reg = (overrides: Partial<ExcerptRegistration> = {}): ExcerptRegistration => ({ id: 'goal', kind: 'goal-document', relativePath: 'goal.md', startLine: 2, endLine: 2, ...overrides });
async function fixture(registrations = [reg()]) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'registered-excerpts-'))); roots.push(root);
  await fs.writeFile(path.join(root, 'goal.md'), 'PRIVATE UNSELECTED HEADER\n목표: 안전한 요약\r\nPRIVATE UNSELECTED TAIL\n');
  return { root, options: { dagId: 'dag-test', canonicalScopePath: root, canonicalNotePath: root, registrations, now: () => Date.parse('2026-10-05T00:00:00.000Z') } };
}
describe('exact registered excerpt source boundary', () => {
  it('reads only exact registered files, with stable opaque IDs and exact Korean byte/line provenance', async () => {
    const f = await fixture(); const scan = vi.spyOn(fs, 'readdir'); const reader = createRegisteredExcerptReader(f.options);
    const read = await reader.read('dag-test'); const e = read.excerpts[0], p = read.provenance[0];
    expect(e.text).toBe('목표: 안전한 요약\r\n'); expect(e.id).toMatch(/^registered-[a-f0-9]{64}$/);
    expect(e.id).toBe(registeredExcerptId('dag-test', reg())); expect(JSON.stringify(read.excerpts)).not.toContain(f.root);
    expect(p).toMatchObject({ byteStart: Buffer.byteLength('PRIVATE UNSELECTED HEADER\n'), byteEnd: Buffer.byteLength('PRIVATE UNSELECTED HEADER\n목표: 안전한 요약\r\n'), lineStart: 2, lineEnd: 2 });
    expect(p.sourceHash).toBe(`sha256:${createHash('sha256').update(e.text).digest('hex')}`);
    expect(JSON.stringify(read.excerpts)).not.toContain('PRIVATE UNSELECTED'); expect(scan).not.toHaveBeenCalled();
    expect(validateRegisteredExcerptContext(read)).toEqual(read); await expect(reader.read('other')).rejects.toMatchObject({ code: 'invalid-registration' });
  });
  it('preserves a selected slice hash when only outside text changes, and changes it for selected bytes', async () => {
    const f = await fixture(); const reader = createRegisteredExcerptReader(f.options); const first = await reader.read('dag-test');
    await fs.writeFile(path.join(f.root, 'goal.md'), 'CHANGED HEADER\n목표: 안전한 요약\r\nCHANGED TAIL');
    const next = await reader.read('dag-test'); expect(next.excerpts[0].sourceHash).toBe(first.excerpts[0].sourceHash); expect(next.provenance[0].fileHash).not.toBe(first.provenance[0].fileHash); expect(next.provenance[0].byteStart).not.toBe(first.provenance[0].byteStart);
    await fs.writeFile(path.join(f.root, 'goal.md'), 'CHANGED HEADER\n목표: 변경됨\r\nCHANGED TAIL');
    expect((await reader.read('dag-test')).excerpts[0].sourceHash).not.toBe(first.excerpts[0].sourceHash);
  });
  it('binds registration changes into opaque identity even when selected text is unchanged', () => {
    expect(registeredExcerptId('dag-test', reg({ relativePath: 'other.md' }))).not.toBe(registeredExcerptId('dag-test', reg()));
    expect(registeredExcerptId('dag-test', reg({ startLine: 1 }))).not.toBe(registeredExcerptId('dag-test', reg()));
  });
  it('rejects broad, traversal, duplicate, sparse, accessor and oversized registrations before IO', async () => {
    const f = await fixture(); const open = vi.spyOn(fs, 'open');
    for (const relativePath of ['../outside', '/absolute', '.', '', 'a//b', 'a/../b', 'a\\b']) expect(() => createRegisteredExcerptReader({ ...f.options, registrations: [reg({ relativePath })] })).toThrow();
    expect(() => parseExcerptRegistrations([reg(), reg()])).toThrow(); expect(() => parseExcerptRegistrations(new Array(2))).toThrow();
    const getter = { ...reg() }; Object.defineProperty(getter, 'id', { get() { throw new Error('Getter must not run'); } }); expect(() => parseExcerptRegistrations([getter])).toThrow();
    expect(() => parseExcerptRegistrations(Array.from({ length: 9 }, (_, i) => reg({ id: `x${i}`, relativePath: `file${i}` })))).toThrow(); expect(open).not.toHaveBeenCalled();
  });
  it('rejects symlink final and ancestor components, hardlinks and selections outside the note', async () => {
    const f = await fixture(); await fs.symlink('goal.md', path.join(f.root, 'alias')); await fs.mkdir(path.join(f.root, 'sub')); await fs.symlink('.', path.join(f.root, 'directory-alias'));
    for (const relativePath of ['alias', 'directory-alias/goal.md']) await expect(createRegisteredExcerptReader({ ...f.options, registrations: [reg({ relativePath })] }).read('dag-test')).rejects.toMatchObject({ code: 'unsafe-source' });
    expect(() => createRegisteredExcerptReader({ ...f.options, canonicalNotePath: path.join(f.root, 'sub') })).toThrow();
    await fs.link(path.join(f.root, 'goal.md'), path.join(f.root, 'hardlink')); await expect(createRegisteredExcerptReader(f.options).read('dag-test')).rejects.toMatchObject({ code: 'unsafe-source' });
  });
  it('rejects missing lines, invalid UTF-8, blank excerpts and NUL bytes', async () => {
    const f = await fixture(); for (const content of [Buffer.from([0xff, 10, 65]), Buffer.from('one\n'), Buffer.from('one\n \n'), Buffer.from('one\nsecret\0value')]) {
      await fs.writeFile(path.join(f.root, 'goal.md'), content); await expect(createRegisteredExcerptReader(f.options).read('dag-test')).rejects.toThrow();
    }
  });
  it('enforces per-file, total-read, individual-excerpt and total-excerpt byte limits', async () => {
    const f = await fixture([reg({ startLine: 1, endLine: 1 })]);
    for (const size of [128 * 1024 + 1, 2049]) { await fs.writeFile(path.join(f.root, 'goal.md'), 'x'.repeat(size)); await expect(createRegisteredExcerptReader(f.options).read('dag-test')).rejects.toMatchObject({ code: 'source-limit' }); }
    const registrations = Array.from({ length: 5 }, (_, i) => reg({ id: `source${i}`, relativePath: `source${i}`, startLine: 1, endLine: 1 }));
    for (const r of registrations) await fs.writeFile(path.join(f.root, r.relativePath), 'a\n' + 'x'.repeat(128 * 1024 - 2));
    const open = vi.spyOn(fs, 'open'); await expect(createRegisteredExcerptReader({ ...f.options, registrations }).read('dag-test')).rejects.toMatchObject({ code: 'source-limit' }); expect(open).not.toHaveBeenCalled(); open.mockRestore();
    await fs.writeFile(path.join(f.root, 'goal.md'), 'x'.repeat(2047) + '\n');
    const many = Array.from({ length: 7 }, (_, i) => reg({ id: `slice${i}`, startLine: 1, endLine: 1 }));
    await expect(createRegisteredExcerptReader({ ...f.options, registrations: many }).read('dag-test')).rejects.toMatchObject({ code: 'source-limit' });
  });
  it('rejects changes during read, closes descriptors and never returns partial evidence', async () => {
    const f = await fixture(); const original = fs.open.bind(fs); const closed = vi.fn();
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => { const handle = await original(...args); const read = handle.read.bind(handle); const close = handle.close.bind(handle); handle.read = (async (...readArgs: any[]) => { const result = await (read as any)(...readArgs); await fs.appendFile(path.join(f.root, 'goal.md'), 'changed'); return result; }) as typeof handle.read; handle.close = async () => { closed(); return close(); }; return handle; });
    await expect(createRegisteredExcerptReader(f.options).read('dag-test')).rejects.toMatchObject({ code: 'source-changed' }); expect(closed).toHaveBeenCalledTimes(1);
  });
  it('honors cancellation without opening files and retires cancelled reader lifetimes', async () => {
    const f = await fixture(); const reader = createRegisteredExcerptReader(f.options); const c = new AbortController(); c.abort(); const open = vi.spyOn(fs, 'open');
    await expect(reader.read('dag-test', c.signal)).rejects.toMatchObject({ code: 'cancelled' }); await expect(reader.read('dag-test')).rejects.toMatchObject({ code: 'retired' }); expect(open).not.toHaveBeenCalled();
  });
  it('rejects tampered local excerpt provenance', async () => {
    const f = await fixture(); const original = await createRegisteredExcerptReader(f.options).read('dag-test');
    const changes: ((r: typeof original) => void)[] = [r => { r.excerpts[0].text += 'tampered'; }, r => { r.provenance[0].byteEnd++; }, r => { r.provenance[0].registration.relativePath = '../outside'; }, r => { r.provenance[0].lineStart++; }, r => { r.provenance[0].excerptId = 'other'; }, r => { r.provenance.push(r.provenance[0]); }];
    for (const change of changes) { const r = structuredClone(original); change(r); expect(() => validateRegisteredExcerptContext(r)).toThrow(); }
  });
});
