import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ScopedExcerpt } from './extract';

export const REGISTERED_EXCERPT_LIMITS = Object.freeze({ files: 8, fileBytes: 128 * 1024, readBytes: 512 * 1024, excerptBytes: 2 * 1024, totalExcerptBytes: 12 * 1024, excerpts: 32 });
/** Trusted startup data only. Lines are inclusive and 1-based. No renderer path input. */
export interface ExcerptRegistration { id: string; kind: ScopedExcerpt['kind']; relativePath: string; startLine: number; endLine: number }
export interface ExcerptProvenance {
  excerptId: string; kind: ScopedExcerpt['kind']; sourceHash: string; observedAt: string;
  registration: ExcerptRegistration;
  /** Local only. Never serialize this manifest into a prompt or renderer message. */
  canonicalPath: string; fileHash: string; fileBytes: number;
  byteStart: number; byteEnd: number; lineStart: number; lineEnd: number;
}
export interface RegisteredExcerptContext { schemaVersion: 1; scopeDagId: string; excerpts: ScopedExcerpt[]; provenance: ExcerptProvenance[] }
export class ExcerptReadError extends Error {
  constructor(readonly code: 'invalid-registration' | 'unsafe-source' | 'source-limit' | 'source-changed' | 'source-unavailable' | 'cancelled' | 'timeout' | 'busy' | 'retired') { super(`Registered excerpt read failed (${code}).`); }
}
function fail(code: ExcerptReadError['code']): never { throw new ExcerptReadError(code); }
const hash = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) fail('invalid-registration');
  const result: Record<string, unknown> = {};
  for (const key of keys) { const p = Object.getOwnPropertyDescriptor(value, key); if (!p || !('value' in p)) fail('invalid-registration'); result[key] = p.value; }
  return result;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-registration');
  return value;
}
function relative(value: unknown): string { const v = text(value); if (path.isAbsolute(v) || v.includes('\\') || v.split('/').some(p => !p || p === '.' || p === '..')) fail('invalid-registration'); return v; }
function absolute(value: unknown): string { const v = text(value); if (!path.isAbsolute(v) || path.normalize(v) !== v || path.parse(v).root === v) fail('invalid-registration'); return v; }
function inside(root: string, target: string): boolean { const r = path.relative(root, target); return !!r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); }
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('invalid-registration'); return value as number; }
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail('invalid-registration');
  return Array.from({ length: value.length }, (_, i) => { const p = Object.getOwnPropertyDescriptor(value, String(i)); if (!p || !('value' in p)) fail('invalid-registration'); return p.value; });
}
export function parseExcerptRegistrations(value: unknown): ExcerptRegistration[] {
  const entries = list(value, REGISTERED_EXCERPT_LIMITS.excerpts).map(raw => {
    const r = object(raw, ['id', 'kind', 'relativePath', 'startLine', 'endLine']);
    const id = text(r.id, 128); if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id) || !['goal-document', 'document', 'inbox'].includes(r.kind as string)) fail('invalid-registration');
    const startLine = integer(r.startLine, 1, REGISTERED_EXCERPT_LIMITS.fileBytes), endLine = integer(r.endLine, startLine, REGISTERED_EXCERPT_LIMITS.fileBytes);
    return { id, kind: r.kind as ScopedExcerpt['kind'], relativePath: relative(r.relativePath), startLine, endLine };
  });
  if (new Set(entries.map(e => e.id)).size !== entries.length || new Set(entries.map(e => e.relativePath)).size > REGISTERED_EXCERPT_LIMITS.files) fail('invalid-registration');
  return entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export const registeredExcerptId = (dagId: string, registration: ExcerptRegistration): string => `registered-${hash(JSON.stringify([text(dagId, 1024), registration.id, registration.kind, registration.relativePath, registration.startLine, registration.endLine])).slice(7)}`;
const stamp = (s: Stats) => `${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
/** Exact known path checks only; no directory enumeration or fallback traversal. */
async function checkedPath(filename: string, active: () => void, finalFile: boolean): Promise<Stats> {
  let current = path.parse(filename).root; let last: Stats | undefined;
  for (const component of filename.slice(current.length).split('/')) {
    active(); current = path.join(current, component); last = await fs.lstat(current); active();
    if (last.isSymbolicLink() || (current === filename && finalFile ? !last.isFile() || last.nlink !== 1 : !last.isDirectory())) fail('unsafe-source');
  }
  if (!last || await fs.realpath(filename) !== filename) fail('unsafe-source'); active(); return last;
}
/** Main-only source reader. A cancelled in-flight read keeps ownership until cleanup settles. */
export function createRegisteredExcerptReader(options: { dagId: string; canonicalScopePath: string; canonicalNotePath: string; registrations: ExcerptRegistration[]; now?: () => number; timeoutMs?: number }) {
  const dagId = text(options.dagId, 1024), scope = absolute(options.canonicalScopePath), note = absolute(options.canonicalNotePath);
  if (note !== scope && !inside(scope, note)) fail('invalid-registration');
  const registrations = parseExcerptRegistrations(options.registrations);
  for (const r of registrations) if (!inside(note, path.join(scope, r.relativePath))) fail('invalid-registration');
  const timeoutMs = options.timeoutMs ?? 5_000; integer(timeoutMs, 1, 60_000);
  let busy = false; let retired = false;
  const readOnce = async (requestedDagId: string, signal?: AbortSignal): Promise<RegisteredExcerptContext> => {
      if (requestedDagId !== dagId) fail('invalid-registration');
      if (retired) fail('retired'); if (busy) fail('busy');
      const active = () => { if (signal?.aborted) { retired = true; fail('cancelled'); } };
      active(); busy = true;
      try {
        const observedAt = new Date((options.now ?? Date.now)()).toISOString();
        const rootBefore = stamp(await checkedPath(scope, active, false));
        const noteBefore = stamp(await checkedPath(note, active, false));
        const filenames = [...new Set(registrations.map(r => path.join(scope, r.relativePath)))];
        const expected = new Map<string, Stats>(); let expectedBytes = 0;
        for (const filename of filenames) { const stat = await checkedPath(filename, active, true); if (stat.size > REGISTERED_EXCERPT_LIMITS.fileBytes) fail('source-limit'); expectedBytes += stat.size; if (expectedBytes > REGISTERED_EXCERPT_LIMITS.readBytes) fail('source-limit'); expected.set(filename, stat); }
        const excerpts: ScopedExcerpt[] = []; const provenance: ExcerptProvenance[] = []; let excerptBytes = 0;
        for (const filename of filenames) {
          active(); const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let bytes: Buffer | undefined;
          try {
            active(); const before = await handle.stat(); active();
            if (!before.isFile() || before.nlink !== 1 || stamp(before) !== stamp(expected.get(filename)!)) fail('source-changed');
            bytes = Buffer.alloc(before.size); let offset = 0;
            while (offset < bytes.length) { active(); const result = await handle.read(bytes, offset, bytes.length - offset, offset); active(); if (!result.bytesRead) fail('source-changed'); offset += result.bytesRead; }
            const after = await handle.stat(); active();
            if (stamp(before) !== stamp(after) || stamp(after) !== stamp(await checkedPath(filename, active, true))) fail('source-changed');
            // Decode all bounded bytes only to establish valid UTF-8 and exact line boundaries.
            const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            if (decoded.includes('\0')) fail('unsafe-source');
            const starts = [0]; for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10 && i + 1 < bytes.length) starts.push(i + 1);
            for (const registration of registrations.filter(r => path.join(scope, r.relativePath) === filename)) {
              if (!bytes.length || registration.endLine > starts.length) fail('source-unavailable');
              const byteStart = starts[registration.startLine - 1], byteEnd = starts[registration.endLine] ?? bytes.length;
              const slice = bytes.subarray(byteStart, byteEnd); if (slice.length > REGISTERED_EXCERPT_LIMITS.excerptBytes) fail('source-limit');
              excerptBytes += slice.length; if (excerptBytes > REGISTERED_EXCERPT_LIMITS.totalExcerptBytes) fail('source-limit');
              const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice); if (!content.trim()) fail('source-unavailable');
              const id = registeredExcerptId(dagId, registration), sourceHash = hash(slice);
              excerpts.push({ scopeDagId: dagId, id, kind: registration.kind, sourceHash, observedAt, text: content });
              provenance.push({ excerptId: id, kind: registration.kind, sourceHash, observedAt, registration, canonicalPath: filename, fileHash: hash(bytes), fileBytes: bytes.length, byteStart, byteEnd, lineStart: registration.startLine, lineEnd: registration.endLine });
            }
          } finally { bytes?.fill(0); await handle.close(); }
        }
        for (const filename of filenames) if (stamp(expected.get(filename)!) !== stamp(await checkedPath(filename, active, true))) fail('source-changed');
        if (rootBefore !== stamp(await checkedPath(scope, active, false)) || noteBefore !== stamp(await checkedPath(note, active, false))) fail('source-changed');
        active(); return validateRegisteredExcerptContext({ schemaVersion: 1, scopeDagId: dagId, excerpts, provenance });
      } catch (error) { if (signal?.aborted) { retired = true; fail('cancelled'); } if (error instanceof ExcerptReadError) throw error; fail('source-unavailable'); }
      finally { busy = false; }
  };
  return {
    async read(requestedDagId: string, signal?: AbortSignal): Promise<RegisteredExcerptContext> {
      if (requestedDagId !== dagId) fail('invalid-registration');
      if (retired) fail('retired'); if (busy) fail('busy');
      if (signal?.aborted) { retired = true; fail('cancelled'); }
      const deadline = new AbortController();
      const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      let stop: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        stop = () => { retired = true; reject(new ExcerptReadError(deadline.signal.aborted ? 'timeout' : 'cancelled')); };
        combined.addEventListener('abort', stop, { once: true });
        if (combined.aborted) stop();
      });
      try { return await Promise.race([readOnce(requestedDagId, combined), stopped]); }
      finally { clearTimeout(timer); if (stop) combined.removeEventListener('abort', stop); }
      // readOnce retains busy ownership and eventual descriptor cleanup after this response.
    },
  };
}
/** Inert local cache integrity, never source authenticity or authority to read a path. */
export function validateRegisteredExcerptContext(value: unknown): RegisteredExcerptContext {
  const r = object(value, ['schemaVersion', 'scopeDagId', 'excerpts', 'provenance']); if (r.schemaVersion !== 1) fail('invalid-registration');
  const scopeDagId = text(r.scopeDagId, 1024); const rawExcerpts = list(r.excerpts, REGISTERED_EXCERPT_LIMITS.excerpts); const rawProvenance = list(r.provenance, REGISTERED_EXCERPT_LIMITS.excerpts);
  if (rawExcerpts.length !== rawProvenance.length) fail('invalid-registration');
  const time = (v: unknown): string => { const s = text(v, 24); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) fail('invalid-registration'); return s; };
  const digest = (v: unknown): string => { const s = text(v, 71); if (!/^sha256:[a-f0-9]{64}$/.test(s)) fail('invalid-registration'); return s; };
  const excerpts = rawExcerpts.map(raw => { const e = object(raw, ['scopeDagId', 'id', 'kind', 'sourceHash', 'observedAt', 'text']); if (e.scopeDagId !== scopeDagId || !['goal-document', 'document', 'inbox'].includes(e.kind as string) || typeof e.text !== 'string' || !e.text.trim() || Buffer.byteLength(e.text) > REGISTERED_EXCERPT_LIMITS.excerptBytes || e.text.includes('\0')) fail('invalid-registration'); return { scopeDagId, id: text(e.id, 100), kind: e.kind as ScopedExcerpt['kind'], sourceHash: digest(e.sourceHash), observedAt: time(e.observedAt), text: e.text }; });
  if (new Set(excerpts.map(e => e.id)).size !== excerpts.length || excerpts.reduce((n, e) => n + Buffer.byteLength(e.text), 0) > REGISTERED_EXCERPT_LIMITS.totalExcerptBytes) fail('invalid-registration');
  const provenance = rawProvenance.map(raw => {
    const p = object(raw, ['excerptId', 'kind', 'sourceHash', 'observedAt', 'registration', 'canonicalPath', 'fileHash', 'fileBytes', 'byteStart', 'byteEnd', 'lineStart', 'lineEnd']);
    const registration = parseExcerptRegistrations([p.registration])[0]; const excerptId = text(p.excerptId, 100); const e = excerpts.find(e => e.id === excerptId);
    const fileBytes = integer(p.fileBytes, 1, REGISTERED_EXCERPT_LIMITS.fileBytes), byteStart = integer(p.byteStart, 0, fileBytes - 1), byteEnd = integer(p.byteEnd, byteStart + 1, fileBytes);
    const sourceHash = digest(p.sourceHash), observedAt = time(p.observedAt);
    if (!e || excerptId !== registeredExcerptId(scopeDagId, registration) || p.kind !== registration.kind || e.kind !== registration.kind || sourceHash !== e.sourceHash || hash(e.text) !== sourceHash || observedAt !== e.observedAt || byteEnd - byteStart !== Buffer.byteLength(e.text) || p.lineStart !== registration.startLine || p.lineEnd !== registration.endLine) fail('invalid-registration');
    return { excerptId, kind: registration.kind, sourceHash, observedAt, registration, canonicalPath: absolute(p.canonicalPath), fileHash: digest(p.fileHash), fileBytes, byteStart, byteEnd, lineStart: registration.startLine, lineEnd: registration.endLine };
  });
  if (new Set(provenance.map(p => p.excerptId)).size !== provenance.length || new Set(provenance.map(p => p.canonicalPath)).size > REGISTERED_EXCERPT_LIMITS.files) fail('invalid-registration');
  parseExcerptRegistrations(provenance.map(p => p.registration));
  const files = new Map<string, ExcerptProvenance>();
  for (const p of provenance) { const prior = files.get(p.canonicalPath); if (prior && (prior.fileHash !== p.fileHash || prior.fileBytes !== p.fileBytes)) fail('invalid-registration'); files.set(p.canonicalPath, p); }
  if ([...files.values()].reduce((n, p) => n + p.fileBytes, 0) > REGISTERED_EXCERPT_LIMITS.readBytes) fail('invalid-registration');
  return structuredClone({ schemaVersion: 1, scopeDagId, excerpts, provenance });
}
