import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/** Main-process only. Registrations come from the current trusted project observation, never IPC paths. */
export const EVIDENCE_LIMITS = Object.freeze({ registrations: 128, textBytes: 256 * 1024, imageBytes: 4 * 1024 * 1024, imageSide: 8192, imagePixels: 16 * 1024 * 1024, imageFrames: 32, imageReferences: 64, imageDecodedBytes: 64 * 1024 * 1024 });
export type EvidenceOrigin = 'observed' | 'synthetic';
export interface EvidenceRegistration { id: string; relativePath: string; label?: string; anchor?: string | null; sourceHash?: string; origin?: EvidenceOrigin }
export interface EvidenceDescriptor { evidenceId: string; registrationId: string; label: string; anchor: string | null; origin: EvidenceOrigin }
export interface EvidenceTarget { relativePath: string; anchor: string | null; label: string }
export type EvidenceErrorCode = 'invalid-registration' | 'invalid-request' | 'unregistered' | 'permission-denied' | 'unsafe-source' | 'source-unavailable' | 'source-limit' | 'source-changed' | 'stale-source' | 'unsupported-type' | 'invalid-content' | 'cancelled' | 'timeout' | 'busy' | 'retired';
export class EvidenceReadError extends Error { constructor(readonly code: EvidenceErrorCode) { super(`Evidence read failed (${code}).`); } }
export interface EvidenceImageReferences { targets: EvidenceTarget[]; unsupportedCount: number }
export type EvidenceContent = { kind: 'text'; mime: 'text/plain' | 'text/markdown'; text: string; rendering: 'plain-text'; imageReferences: EvidenceImageReferences } | { kind: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; dataUrl: string; width: number; height: number; validation: 'bounded-format' };
export type EvidenceResult = { ok: true; scopeId: string; evidenceId: string; label: string; anchor: string | null; origin: EvidenceOrigin; sourceHash: string; observedAt: string; byteLength: number; content: EvidenceContent; verification: 'not-assessed'; omissions: string[] } | { ok: false; code: EvidenceErrorCode; omitted: true };
export interface EvidenceReaderOptions {
  scopeId: string;
  canonicalRootPath: string;
  registrations: EvidenceRegistration[];
  /** Revalidate the current main-owned read-root permission. False/throw fails closed. */
  authorize?: () => boolean | Promise<boolean>;
  now?: () => number;
  timeoutMs?: number;
}
function fail(code: EvidenceErrorCode): never { throw new EvidenceReadError(code); }
const digest = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const isDigest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
function text(value: unknown, max = 4096, code: EvidenceErrorCode = 'invalid-registration'): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}
function object(value: unknown, required: string[], optional: string[], code: EvidenceErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail(code);
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) fail(code);
  return result;
}
function relative(value: unknown): string {
  const v = text(value);
  if (path.isAbsolute(v) || /[\\:#?%\[\]|]/u.test(v) || v.split('/').some(p => !p || p === '.' || p === '..') || path.normalize(v) !== v) fail('invalid-registration');
  return v;
}
function absolute(value: unknown): string {
  const v = text(value);
  if (!path.isAbsolute(v) || path.normalize(v) !== v || v === path.parse(v).root) fail('invalid-registration');
  return v;
}
/** Explicit local target only. No basename resolution, URL decoding, link following or directory scan. */
export function parseEvidenceTarget(input: string): EvidenceTarget {
  text(input, 4096);
  const wiki = input.startsWith('[[') && input.endsWith(']]');
  const body = wiki ? input.slice(2, -2) : input;
  const parts = body.split('|');
  if ((!wiki && parts.length !== 1) || parts.length > 2 || parts.some(p => !p) || /[\[\]]/u.test(body)) fail('invalid-registration');
  const target = parts[0].split('#');
  if (target.length > 2 || target.some(p => !p)) fail('invalid-registration');
  let relativePath = relative(target[0]);
  if (wiki && !path.extname(relativePath)) relativePath += '.md';
  const anchor = target[1] === undefined ? null : text(target[1], 512);
  return { relativePath, anchor, label: text(parts[1] ?? target[0], 512) };
}
/** Inert syntactic declarations, never permission to open a link. Paths remain relative to the source document. */
export function extractEvidenceImageReferences(input: string): EvidenceImageReferences {
  if (typeof input !== 'string' || Buffer.byteLength(input) > EVIDENCE_LIMITS.textBytes) fail('source-limit');
  const targets: EvidenceTarget[] = [], seen = new Set<string>();
  let unsupportedCount = (input.match(/!\[/gu) ?? []).length + (input.match(/<img\b/giu) ?? []).length;
  const pattern = /!\[\[([^\]\r\n]*)\]\]|!\[([^\]\r\n]*)\]\(([^)\r\n]*)\)/gu;
  for (const match of input.matchAll(pattern)) {
    try {
      let target: EvidenceTarget;
      if (match[1] !== undefined) target = parseEvidenceTarget(`[[${match[1]}]]`);
      else {
        const destination = match[3].match(/^\s*(?:<([^<>]+)>|(\S+?))(?:\s+["'][^"']*["'])?\s*$/u);
        if (!destination) continue;
        target = parseEvidenceTarget(destination[1] ?? destination[2]);
        if (match[2]) target.label = text(match[2], 512);
      }
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(path.extname(target.relativePath).toLowerCase())) continue;
      const key = `${target.relativePath}#${target.anchor ?? ''}`;
      if (!seen.has(key)) { if (targets.length >= EVIDENCE_LIMITS.imageReferences) continue; seen.add(key); targets.push(target); }
      unsupportedCount--;
    } catch { /* Unsafe or unsupported declarations are counted, never fetched. */ }
  }
  return { targets, unsupportedCount };
}
function registrations(value: unknown): EvidenceRegistration[] {
  if (!Array.isArray(value) || value.length > EVIDENCE_LIMITS.registrations || Reflect.ownKeys(value).length !== value.length + 1) fail('invalid-registration');
  const result = Array.from({ length: value.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !('value' in entry)) fail('invalid-registration');
    const r = object(entry.value, ['id', 'relativePath'], ['label', 'anchor', 'sourceHash', 'origin'], 'invalid-registration');
    const id = text(r.id, 128), relativePath = relative(r.relativePath);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id)) fail('invalid-registration');
    if (r.sourceHash !== undefined && !isDigest(r.sourceHash)) fail('invalid-registration');
    if (r.origin !== undefined && r.origin !== 'observed' && r.origin !== 'synthetic') fail('invalid-registration');
    return { id, relativePath, label: r.label === undefined ? path.basename(relativePath) : text(r.label, 512), anchor: r.anchor === undefined || r.anchor === null ? null : text(r.anchor, 512), ...(r.sourceHash === undefined ? {} : { sourceHash: r.sourceHash as string }), origin: (r.origin ?? 'observed') as EvidenceOrigin };
  });
  if (new Set(result.map(r => r.id)).size !== result.length) fail('invalid-registration');
  return result;
}
const identity = (s: Stats): string => `${s.dev}:${s.ino}:${s.mode}`;
const stamp = (s: Stats): string => `${identity(s)}:${s.nlink}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
/** Check each exact component; symlinks (including inside-root aliases) and hardlinks are refused. */
async function checkedPath(filename: string, active: () => void, file: boolean): Promise<Stats> {
  let current = path.parse(filename).root, last: Stats | undefined;
  for (const component of filename.slice(current.length).split(path.sep)) {
    active(); current = path.join(current, component); last = await fs.lstat(current); active();
    if (last.isSymbolicLink() || (current === filename && file ? !last.isFile() || last.nlink !== 1 : !last.isDirectory())) fail('unsafe-source');
  }
  if (!last || await fs.realpath(filename) !== filename) fail('unsafe-source');
  active(); return last;
}
function size(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('invalid-content');
  if (width > EVIDENCE_LIMITS.imageSide || height > EVIDENCE_LIMITS.imageSide || width * height > EVIDENCE_LIMITS.imagePixels) fail('source-limit');
  return { width, height };
}
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function png(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('invalid-content');
  let offset = 8, dimensions: { width: number; height: number } | undefined, bits = 0, channels = 0, indexed = false, palette = false, ended = false, dataEnded = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) fail('invalid-content');
    const type = bytes.toString('latin1', offset + 4, offset + 8), body = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('invalid-content');
    if (!dimensions && type !== 'IHDR') fail('invalid-content');
    if (type === 'IHDR') {
      if (dimensions || length !== 13) fail('invalid-content');
      dimensions = size(body.readUInt32BE(0), body.readUInt32BE(4)); bits = body[8];
      const color = body[9]; channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color] ?? 0; indexed = color === 3;
      if (!channels || !([0, 3].includes(color) ? [1, 2, 4, 8, ...(color === 0 ? [16] : [])] : [8, 16]).includes(bits) || body[10] !== 0 || body[11] !== 0) fail('invalid-content');
      // Interlace/animation are deliberately omitted instead of claiming unbounded decode support.
      if (body[12] !== 0) fail('unsupported-type');
    } else if (type === 'PLTE') {
      if (palette || data.length || !length || length % 3 || length > 768) fail('invalid-content'); palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (indexed && !palette)) fail('invalid-content'); data.push(body);
    } else if (type === 'IEND') {
      if (length || !data.length || end !== bytes.length) fail('invalid-content'); ended = true; offset = end; break;
    } else {
      if (['acTL', 'fcTL', 'fdAT', 'iCCP', 'zTXt', 'iTXt'].includes(type)) fail('unsupported-type');
      if (type[0] === type[0].toUpperCase()) fail('unsupported-type');
      if (data.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended || !dimensions || offset !== bytes.length) fail('invalid-content');
  const stride = Math.ceil(dimensions.width * channels * bits / 8) + 1, expected = stride * dimensions.height;
  if (expected > EVIDENCE_LIMITS.imageDecodedBytes) fail('source-limit');
  // Prevent a compressed stream from allocating beyond the accepted raster dimensions.
  let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expected }); } catch { fail('invalid-content'); }
  try { if (decoded.length !== expected) fail('invalid-content'); for (let y = 0; y < dimensions.height; y++) if (decoded[y * stride] > 4) fail('invalid-content'); } finally { decoded.fill(0); }
  return dimensions;
}
function jpeg(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) fail('invalid-content');
  let offset = 2, dimensions: { width: number; height: number } | undefined, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) fail('invalid-content');
    while (bytes[offset] === 255) offset++;
    if (offset >= bytes.length) fail('invalid-content');
    const marker = bytes[offset++];
    if (marker === 217) { if (!scan || !dimensions || offset !== bytes.length) fail('invalid-content'); return dimensions; }
    if (marker === 0 || marker === 216 || marker === 1 || (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) fail('invalid-content');
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) fail('invalid-content');
    if ([192, 193, 194].includes(marker)) {
      if (dimensions || length < 8 || bytes[offset + 2] !== 8) fail('invalid-content');
      dimensions = size(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      const components = bytes[offset + 7]; if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) fail('invalid-content');
    } else if (marker >= 195 && marker <= 207 && ![196, 200, 204].includes(marker)) fail('unsupported-type');
    if (marker === 218) {
      if (!dimensions || length < 6 || bytes[offset + 2] < 1 || bytes[offset + 2] > 4 || length !== 6 + 2 * bytes[offset + 2]) fail('invalid-content'); scan = true; offset = end;
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 208 && bytes[offset + 1] <= 215)) { offset += 2; continue; }
        break;
      }
      if (offset === start) fail('invalid-content');
    } else offset = end;
  }
  fail('invalid-content');
}
function gif(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) fail('invalid-content');
  const dimensions = size(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  let offset = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0, pixels = 0;
  const blocks = () => { let length = 0; while (offset < bytes.length) { const count = bytes[offset++]; if (!count) return length; if (offset + count > bytes.length) fail('invalid-content'); length += count; offset += count; } fail('invalid-content'); };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 59) { if (!frames || offset !== bytes.length) fail('invalid-content'); return dimensions; }
    if (marker === 33) { if (offset >= bytes.length) fail('invalid-content'); offset++; blocks(); continue; }
    if (marker !== 44 || offset + 9 > bytes.length) fail('invalid-content');
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2), frame = size(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6)), packed = bytes[offset + 8];
    if (left + frame.width > dimensions.width || top + frame.height > dimensions.height) fail('invalid-content');
    if (++frames > EVIDENCE_LIMITS.imageFrames || (pixels += frame.width * frame.height) > EVIDENCE_LIMITS.imagePixels) fail('source-limit');
    offset += 9 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0);
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) fail('invalid-content');
    offset++; if (!blocks()) fail('invalid-content');
  }
  fail('invalid-content');
}
function webp(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('invalid-content');
  let offset = 12, canvas: { width: number; height: number } | undefined, image: { width: number; height: number } | undefined;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('latin1', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), end = offset + 8 + length;
    if (end > bytes.length || (length % 2 && (end >= bytes.length || bytes[end] !== 0))) fail('invalid-content');
    const body = bytes.subarray(offset + 8, end);
    if (kind === 'VP8X') {
      if (offset !== 12 || length !== 10 || body[1] || body[2] || body[3] || (body[0] & 193)) fail('invalid-content');
      if (body[0] & 2) fail('unsupported-type');
      canvas = size(body.readUIntLE(4, 3) + 1, body.readUIntLE(7, 3) + 1);
    } else if (kind === 'VP8 ') {
      if (image || length < 11 || (body[0] & 1) || body[3] !== 157 || body[4] !== 1 || body[5] !== 42) fail('invalid-content');
      image = size(body.readUInt16LE(6) & 16383, body.readUInt16LE(8) & 16383);
    } else if (kind === 'VP8L') {
      if (image || length < 6 || body[0] !== 47 || (body[4] >> 5) !== 0) fail('invalid-content');
      const bits = body.readUInt32LE(1); image = size((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1);
    } else if (['ANIM', 'ANMF'].includes(kind)) fail('unsupported-type');
    else if (!canvas || !['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(kind)) fail('unsupported-type');
    offset = end + length % 2;
  }
  if (offset !== bytes.length || !image || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) fail('invalid-content');
  return image;
}
function contentType(filename: string): { kind: 'text'; mime: 'text/plain' | 'text/markdown' } | { kind: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' } {
  const extension = path.extname(filename).toLowerCase();
  if (['.md', '.markdown'].includes(extension)) return { kind: 'text', mime: 'text/markdown' };
  if (['.txt', '.text', '.log', '.json', '.yaml', '.yml', '.csv', '.diff', '.patch'].includes(extension)) return { kind: 'text', mime: 'text/plain' };
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as const)[extension as '.png'];
  if (!mime) fail('unsupported-type'); return { kind: 'image', mime };
}
function renderContent(filename: string, bytes: Buffer): EvidenceContent {
  const type = contentType(filename);
  if (type.kind === 'text') {
    let decoded: string; try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid-content'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded)) fail('invalid-content');
    return { ...type, text: decoded, rendering: 'plain-text', imageReferences: type.mime === 'text/markdown' ? extractEvidenceImageReferences(decoded) : { targets: [], unsupportedCount: 0 } };
  }
  const dimensions = ({ 'image/png': png, 'image/jpeg': jpeg, 'image/gif': gif, 'image/webp': webp })[type.mime](bytes);
  return { ...type, ...dimensions, dataUrl: `data:${type.mime};base64,${bytes.toString('base64')}`, validation: 'bounded-format' };
}

/** Pins the canonical root lifetime and issues per-reader opaque IDs. No renderer input can name a file. */
export async function createEvidenceReader(options: EvidenceReaderOptions) {
  const scopeId = text(options.scopeId, 1024), root = absolute(options.canonicalRootPath), entries = registrations(options.registrations);
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('invalid-registration');
  const authorize = options.authorize, now = options.now ?? Date.now;
  const allowed = async () => { try { if (authorize && await authorize() !== true) fail('permission-denied'); } catch { fail('permission-denied'); } };
  let initializationExpired = false, initializationTimer: ReturnType<typeof setTimeout> | undefined;
  const initializing = () => { if (initializationExpired) fail('timeout'); };
  let rootIdentity: string;
  try {
    rootIdentity = await Promise.race([
      (async () => { await allowed(); initializing(); return identity(await checkedPath(root, initializing, false)); })(),
      new Promise<never>((_, reject) => { initializationTimer = setTimeout(() => { initializationExpired = true; reject(new EvidenceReadError('timeout')); }, timeoutMs); }),
    ]);
  } catch (error) { if (error instanceof EvidenceReadError) throw error; fail('source-unavailable'); }
  finally { clearTimeout(initializationTimer); }
  const registered = new Map(entries.map(entry => [`evidence-${randomUUID()}`, entry]));
  let busy = false, retired = false;
  const descriptors = [...registered].map(([evidenceId, r]): EvidenceDescriptor => ({ evidenceId, registrationId: r.id, label: r.label!, anchor: r.anchor!, origin: r.origin! }));
  async function readOnce(evidenceId: string, expectedSourceHash: string | null, signal: AbortSignal): Promise<EvidenceResult> {
    const active = () => { if (signal.aborted) fail('cancelled'); if (retired) fail('retired'); };
    const registration = registered.get(evidenceId)!;
    let bytes: Buffer | undefined, second: Buffer | undefined;
    try {
      active(); await allowed(); active();
      if (identity(await checkedPath(root, active, false)) !== rootIdentity) fail('source-changed');
      const filename = path.join(root, registration.relativePath), type = contentType(filename);
      const expected = await checkedPath(filename, active, true);
      if (expected.size > (type.kind === 'text' ? EVIDENCE_LIMITS.textBytes : EVIDENCE_LIMITS.imageBytes)) fail('source-limit');
      active(); const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        active(); const before = await handle.stat(); active();
        if (!before.isFile() || before.nlink !== 1 || stamp(before) !== stamp(expected)) fail('source-changed');
        const readAll = async () => {
          const buffer = Buffer.alloc(before.size); let offset = 0;
          try { while (offset < buffer.length) { active(); const result = await handle.read(buffer, offset, buffer.length - offset, offset); active(); if (!result.bytesRead) fail('source-changed'); offset += result.bytesRead; } return buffer; }
          catch (error) { buffer.fill(0); throw error; }
        };
        bytes = await readAll(); const sourceHash = digest(bytes);
        if ((registration.sourceHash && registration.sourceHash !== sourceHash) || (expectedSourceHash && expectedSourceHash !== sourceHash)) fail('stale-source');
        second = await readAll();
        if (sourceHash !== digest(second) || stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await checkedPath(filename, active, true))) fail('source-changed');
        const content = renderContent(filename, bytes);
        await allowed(); active();
        if (rootIdentity !== identity(await checkedPath(root, active, false)) || stamp(before) !== stamp(await checkedPath(filename, active, true))) fail('source-changed');
        active();
        return { ok: true, scopeId, evidenceId, label: registration.label!, anchor: registration.anchor!, origin: registration.origin!, sourceHash, observedAt: new Date(now()).toISOString(), byteLength: bytes.length, content, verification: 'not-assessed', omissions: registration.anchor ? ['Anchor is preserved as a reference; no heading match or automatic link navigation was performed.'] : [] };
      } finally { await handle.close(); }
    } catch (error) { return { ok: false, code: error instanceof EvidenceReadError ? error.code : 'source-unavailable', omitted: true }; }
    finally { bytes?.fill(0); second?.fill(0); busy = false; }
  }
  return {
    list(): EvidenceDescriptor[] { return structuredClone(descriptors); },
    retire(): void { retired = true; },
    async read(value: unknown, signal?: AbortSignal): Promise<EvidenceResult> {
      let evidenceId: string, expectedSourceHash: string | null;
      try {
        const request = object(value, ['evidenceId', 'expectedSourceHash'], [], 'invalid-request');
        evidenceId = text(request.evidenceId, 128, 'invalid-request');
        if (request.expectedSourceHash !== null && !isDigest(request.expectedSourceHash)) fail('invalid-request');
        expectedSourceHash = request.expectedSourceHash as string | null;
      } catch { return { ok: false, code: 'invalid-request', omitted: true }; }
      const error = (code: EvidenceErrorCode): EvidenceResult => ({ ok: false, code, omitted: true });
      if (retired) return error('retired');
      if (busy) return error('busy');
      if (!registered.has(evidenceId)) return error('unregistered');
      if (signal?.aborted) { retired = true; return error('cancelled'); }
      const deadline = new AbortController(), combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const timer = setTimeout(() => deadline.abort(), timeoutMs); let onAbort!: () => void;
      const stopped = new Promise<EvidenceResult>(resolve => { onAbort = () => { retired = true; resolve(error(deadline.signal.aborted ? 'timeout' : 'cancelled')); }; combined.addEventListener('abort', onAbort, { once: true }); });
      busy = true;
      try { return await Promise.race([readOnce(evidenceId, expectedSourceHash, combined), stopped]); }
      finally { clearTimeout(timer); combined.removeEventListener('abort', onAbort); }
      // readOnce retains descriptor cleanup ownership after a timeout/cancellation response.
    },
  };
}
