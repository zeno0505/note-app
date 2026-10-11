/** Offline contract for the observed Orca 1.4.221 Node/shell responses only.
 * No subprocess, transport, ownership discovery or AI completion is implemented.
 * The envelope carries no version: callers must pin the installed version separately.
 */
export const ORCA_NONMODEL_VERSION = '1.4.221' as const;
export const NONMODEL_LIMITS = Object.freeze({ envelopeBytes: 65536, payloadBytes: 16384,
  readLines: 128, outputBytes: 131072, reads: 256, frameBytes: 16384 });
export type NonmodelOperation = 'send' | 'interrupt' | 'read' | 'wait-exit' | 'close';
interface Receipt { id: string; runtimeId: string }
export type NonmodelResult = Receipt & (
  | { kind: 'error'; code: 'timeout' }
  | { kind: 'send'; handle: string; requestId: string; incarnation: string; generation: number;
      baselineWorkingSequence: number; bytesWritten: number; replayed: boolean; delivery: 'unsupported' }
  | { kind: 'interrupt'; handle: string; bytesWritten: number }
  | { kind: 'read'; handle: string; source: 'stream' | 'screen'; status: 'running'; tail: string[];
      oldestCursor: string; nextCursor: string; latestCursor: string; truncated: boolean; limited: boolean }
  | { kind: 'wait-exit'; handle: string; satisfied: true; status: 'exited'; exitCode: -1; exitCause: 'stop_unverified' }
  | { kind: 'close'; handle: string; tabId: string; ptyKilled: true }
);
function fail(message: string): never { throw new Error(message); }
const bytes = (value: string) => new TextEncoder().encode(value).length;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected contract object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('Unobserved contract fields');
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || bytes(value) > max || value.includes('\0')) fail('Invalid bounded contract text');
  return value;
}
function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result)) fail('Invalid contract UUID');
  return result;
}
function handle(value: unknown): string {
  const result = text(value); uuid(result.slice(5));
  if (!result.startsWith('term_')) fail('Invalid terminal handle'); return result;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail('Invalid contract integer'); return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') fail('Invalid contract boolean'); return value; }
function cursor(value: unknown): string {
  const result = text(value, 32); if (!/^(0|[1-9][0-9]*)$/.test(result)) fail('Invalid decimal cursor'); return result;
}
export function decodeOrcaNonmodelResult(operation: NonmodelOperation, raw: string, version: string, exitCode: number): NonmodelResult {
  if (version !== ORCA_NONMODEL_VERSION) fail('Unverified Orca version');
  if (typeof raw !== 'string' || bytes(raw) > NONMODEL_LIMITS.envelopeBytes) fail('Envelope byte budget exceeded');
  const envelope = object(JSON.parse(raw));
  keys(envelope, ['id', 'ok', '_meta'], envelope.ok === true ? ['result'] : ['error']);
  const meta = object(envelope._meta); keys(meta, ['runtimeId']);
  const receipt = { id: uuid(envelope.id), runtimeId: uuid(meta.runtimeId) };
  if (envelope.ok === false) {
    const error = object(envelope.error); keys(error, ['code', 'message']);
    if (operation !== 'wait-exit' || exitCode !== 1 || error.code !== 'timeout' || error.message !== 'timeout') fail('Unobserved failure contract');
    return { ...receipt, kind: 'error', code: 'timeout' };
  }
  if (envelope.ok !== true || exitCode !== 0) fail('Envelope/process outcome mismatch');
  const result = object(envelope.result);
  if (operation === 'send' || operation === 'interrupt') {
    keys(result, ['send'], operation === 'send' ? ['mutation', 'warnings'] : []);
    const send = object(result.send); keys(send, ['handle', 'accepted', 'bytesWritten'], operation === 'send' ? ['prompt'] : []);
    if (send.accepted !== true) fail('Unobserved acceptance contract');
    const common = { ...receipt, handle: handle(send.handle), bytesWritten: integer(send.bytesWritten, NONMODEL_LIMITS.payloadBytes + 2) };
    if (operation === 'interrupt') {
      if (common.bytesWritten !== 1) fail('Unobserved interrupt bytes'); return { ...common, kind: 'interrupt' };
    }
    const prompt = object(send.prompt); keys(prompt, ['requestId', 'stages', 'provider', 'observation', 'processIncarnation', 'generation', 'baselineWorkingSequence']);
    if (!Array.isArray(prompt.stages) || prompt.stages.length !== 1 || prompt.stages[0] !== 'input_accepted'
      || prompt.provider !== 'unsupported' || prompt.observation !== 'unsupported') fail('Unobserved provider/delivery stages');
    const mutation = object(result.mutation); keys(mutation, ['requestId', 'replayed']);
    const requestId = uuid(prompt.requestId);
    if (uuid(mutation.requestId) !== requestId) fail('Conflicting durable receipt');
    // Replayed=true is not an observed success shape; never promote it to a fresh send.
    if (mutation.replayed !== false || !Array.isArray(result.warnings) || result.warnings.length !== 1
      || result.warnings[0] !== 'input was accepted, but this provider cannot report delivery. Inspect the terminal before retrying.') fail('Unobserved send contract');
    return { ...common, kind: 'send', requestId, incarnation: uuid(prompt.processIncarnation),
      generation: integer(prompt.generation), baselineWorkingSequence: integer(prompt.baselineWorkingSequence), replayed: false, delivery: 'unsupported' };
  }
  if (operation === 'read') {
    keys(result, ['terminal']); const terminal = object(result.terminal);
    keys(terminal, ['handle', 'status', 'tail', 'truncated', 'limited', 'oldestCursor', 'nextCursor', 'latestCursor', 'returnedLineCount', 'source']);
    if (terminal.status !== 'running' || !['stream', 'screen'].includes(String(terminal.source))) fail('Unobserved read contract');
    if (!Array.isArray(terminal.tail) || terminal.tail.some(line => typeof line !== 'string' || line.includes('\0'))
      || terminal.tail.length !== integer(terminal.returnedLineCount, NONMODEL_LIMITS.readLines)) fail('Invalid read lines');
    return { ...receipt, kind: 'read', handle: handle(terminal.handle), status: 'running', source: terminal.source as 'stream' | 'screen',
      tail: [...terminal.tail] as string[], truncated: boolean(terminal.truncated), limited: boolean(terminal.limited),
      oldestCursor: cursor(terminal.oldestCursor), nextCursor: cursor(terminal.nextCursor), latestCursor: cursor(terminal.latestCursor) };
  }
  if (operation === 'wait-exit') {
    keys(result, ['wait']); const wait = object(result.wait); keys(wait, ['handle', 'condition', 'satisfied', 'status', 'exitCode', 'exitCause']);
    const cause = object(wait.exitCause); keys(cause, ['kind', 'reason']);
    if (wait.condition !== 'exit' || wait.satisfied !== true || wait.status !== 'exited' || wait.exitCode !== -1
      || cause.kind !== 'unknown' || cause.reason !== 'stop_unverified') fail('Unobserved exit contract');
    return { ...receipt, kind: 'wait-exit', handle: handle(wait.handle), satisfied: true, status: 'exited', exitCode: -1, exitCause: 'stop_unverified' };
  }
  if (operation !== 'close') fail('Unsupported operation');
  keys(result, ['close']); const close = object(result.close); keys(close, ['handle', 'tabId', 'ptyKilled']);
  if (close.ptyKilled !== true) fail('PTY termination unverified');
  return { ...receipt, kind: 'close', handle: handle(close.handle), tabId: uuid(close.tabId), ptyKilled: true };
}

/** Application-authored identity, NOT wire fields. Caller must attest current
 * incarnation before consuming reads (read envelopes contain no incarnation).
 * This seam has no renderer IPC, executable argv or production factory wiring.
 */
export interface NonmodelBinding { ownerId: string; ticketId: string; runId: string; runtimeId: string; handle: string; incarnation: string }
export function createNonmodelContractSession(ownedBy: string, input: NonmodelBinding) {
  keys(object(input), ['ownerId', 'ticketId', 'runId', 'runtimeId', 'handle', 'incarnation']);
  const binding = Object.freeze({ ...input });
  for (const key of ['ownerId', 'ticketId', 'runId'] as const) text(binding[key]);
  uuid(binding.runtimeId); handle(binding.handle); uuid(binding.incarnation);
  if (ownedBy !== binding.ownerId) fail('Explicit ownership required');
  let active = true, pending = false, sent = false, accepted = false, requestId: string | null = null;
  let nextCursor = '0', outputBytes = 0, reads = 0;
  const receiptIds = new Set<string>();
  function retire(message: string): never { active = false; pending = false; return fail(message); }
  function identity(actual: NonmodelBinding) {
    if (!active) fail('Contract session retired');
    if (Object.keys(actual).length !== 6 || Object.keys(binding).some(key => actual[key as keyof NonmodelBinding] !== binding[key as keyof NonmodelBinding])) retire('Ownership/request/runtime/incarnation changed');
  }
  return {
    planSend(actual: NonmodelBinding, payload: string) {
      identity(actual); if (sent || pending) fail('No resend or automatic retry; reconcile original receipt');
      text(payload, NONMODEL_LIMITS.payloadBytes); sent = true;
      return Object.freeze({ kind: 'nonmodel-contract-only' as const, binding, payload });
    },
    acceptSend(actual: NonmodelBinding, raw: string, version: string, exitCode: number) {
      identity(actual); if (!sent || accepted) fail('Unexpected send receipt');
      let receipt: NonmodelResult;
      try { receipt = decodeOrcaNonmodelResult('send', raw, version, exitCode); } catch { return retire('Unverified send outcome; no resend'); }
      if (receipt.runtimeId !== binding.runtimeId || receipt.kind !== 'send' || receipt.handle !== binding.handle || receipt.incarnation !== binding.incarnation) retire('Foreign send receipt');
      if (receiptIds.has(receipt.id)) retire('Reused receipt ID');
      receiptIds.add(receipt.id); requestId = receipt.requestId; accepted = true; return receipt;
    },
    planRead(actual: NonmodelBinding) {
      identity(actual); if (pending || reads >= NONMODEL_LIMITS.reads) fail('Read pending or budget exhausted');
      pending = true; return Object.freeze({ kind: 'nonmodel-contract-only' as const, cursor: nextCursor, limit: NONMODEL_LIMITS.readLines });
    },
    acceptRead(actual: NonmodelBinding, raw: string, version: string, exitCode: number) {
      identity(actual); if (!pending) fail('Unbound or duplicate read');
      let receipt: NonmodelResult;
      try { receipt = decodeOrcaNonmodelResult('read', raw, version, exitCode); } catch { return retire('Unverified read outcome'); }
      if (receipt.kind !== 'read' || receipt.runtimeId !== binding.runtimeId || receipt.handle !== binding.handle) retire('Foreign read receipt');
      if (receiptIds.has(receipt.id)) retire('Reused receipt ID');
      if (receipt.source !== 'stream' || receipt.truncated || receipt.limited) retire('Screen/history/gap is not a request response');
      const oldest = BigInt(receipt.oldestCursor), next = BigInt(receipt.nextCursor), latest = BigInt(receipt.latestCursor), current = BigInt(nextCursor);
      if (oldest > current || next < current || next > latest || (receipt.tail.length > 0 && next === current)) retire('Cursor reset/gap/nonadvance');
      const size = bytes(receipt.tail.join('\n'));
      if (outputBytes + size > NONMODEL_LIMITS.outputBytes) retire('Output byte budget exhausted');
      receiptIds.add(receipt.id); outputBytes += size; reads++; nextCursor = receipt.nextCursor; pending = false;
      // Cursor output is still uncorrelated with a model request, even after acceptance.
      return Object.freeze({ receipt, requestCorrelation: 'unverified' as const });
    },
    invalidate() { active = false; pending = false; },
    snapshot() { return Object.freeze({ binding, active, sent, accepted, requestId, nextCursor, outputBytes, reads,
      automaticRetry: false as const, turnStarted: false as const, semanticCompletion: false as const, remoteCancellationVerified: false as const }); },
  };
}

/** Authored JSONL protocol for non-model unit fixtures, NOT observed Orca fields
 * or an AI response decoder. Only exact request+sequence frames may complete it.
 */
export function createNonmodelFrameCollector(requestId: string) {
  text(requestId); let sequence = 0, output = '', done = false, active = true;
  return {
    consume(line: string) {
      if (!active || done) { active = false; output = ''; fail('Frame collector closed'); }
      try {
        if (bytes(line) > NONMODEL_LIMITS.frameBytes) fail('Frame byte budget');
        const frame = object(JSON.parse(line)); keys(frame, ['protocol', 'requestId', 'sequence', 'body', 'done']);
        if (frame.protocol !== 'note-app-nonmodel-frame-v1' || frame.requestId !== requestId || frame.sequence !== sequence
          || typeof frame.body !== 'string' || frame.body.includes('\0') || typeof frame.done !== 'boolean') fail('Unbound/out-of-order frame');
        if (sequence >= NONMODEL_LIMITS.reads || bytes(output) + bytes(frame.body) > NONMODEL_LIMITS.outputBytes) fail('Frame output budget');
        output += frame.body; sequence++; done = frame.done;
      } catch { active = false; output = ''; throw new Error('Rejected nonmodel frame; no completion'); }
    },
    result(): string | null { return active && done ? output : null; },
    invalidate() { active = false; output = ''; },
  };
}
