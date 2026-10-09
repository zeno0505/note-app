/**
 * Isolated, in-memory test contract. Nothing here executes argv, reads a terminal,
 * writes a note/cache, or decodes Orca result objects. Fixture observations below
 * are application-authored test data, NOT observed Orca wire fields.
 */
export const FIXTURE_TERMINAL_ONLY = 'fixture-only' as const;
export const FIXTURE_TERMINAL_LIMITS = Object.freeze({
  payloadBytes: 16384, readUnits: 128, readBytes: 32768,
  outputBytes: 131072, events: 256, waitSubmitSeconds: 30, waitMs: 30000,
});
export interface FixtureTerminalBinding {
  ownerId: string;
  ticketId: string;
  runId: string;
  runtimeId: string;
  terminalHandle: string;
  incarnation: string;
}
const bindingKeys = ['ownerId', 'ticketId', 'runId', 'runtimeId', 'terminalHandle', 'incarnation'] as const;
export type FixtureObservation = {
  kind: typeof FIXTURE_TERMINAL_ONLY;
  eventId: string;
  binding: FixtureTerminalBinding;
} & (
  | { type: 'accepted' | 'submitted' | 'turn-start' | 'tui-idle' }
  | { type: 'submission-unknown'; returnedRetryRequestId: string }
  | { type: 'read'; readSequence: number; cursor: number; nextCursor: number; returnedUnits: number; text: string }
);
export interface FixtureReadPlan {
  kind: typeof FIXTURE_TERMINAL_ONLY;
  sequence: number;
  cursor: number;
  limit: number;
  argv: readonly string[];
}
const fail = (message: string): never => { throw new Error(message); };
const bytes = (value: string): number => new TextEncoder().encode(value).length;
function boundedText(value: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > maximum || value.includes('\0')) fail('Invalid bounded fixture text');
  return value;
}
function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('Invalid bounded fixture integer');
  return value;
}
function checkBinding(binding: FixtureTerminalBinding): void {
  if (!binding || Object.keys(binding).length !== bindingKeys.length) fail('Invalid fixture binding');
  for (const key of bindingKeys) boundedText(binding[key], 128);
}
const argv = (...values: string[]): readonly string[] => Object.freeze(values);

/** Known historical argv only. Returned arrays are inert, never execution authority. */
export function planFixtureTerminalCreate(input: { kind: typeof FIXTURE_TERMINAL_ONLY; worktreeSelector: string; command: 'claude' | 'codex' }): readonly string[] {
  if (input.kind !== FIXTURE_TERMINAL_ONLY || !['claude', 'codex'].includes(input.command)) fail('Fixture-only command required');
  return argv('terminal', 'create', '--worktree', boundedText(input.worktreeSelector, 512), '--command', input.command, '--json');
}

/** Exact terminal result fields and safe cancellation have not been verified. */
export function decodeRealOrcaTerminalResult(_envelope: unknown): never {
  return fail('UNIMPLEMENTED: real Orca terminal result decoding is blocked');
}

/**
 * Ownership is simulated by an explicit fixture owner, never discovered or
 * inferred from a terminal handle. Do not connect this seam to production IPC.
 */
export function createFixtureTerminalSession(input: {
  kind: typeof FIXTURE_TERMINAL_ONLY;
  ownedBy: string;
  binding: FixtureTerminalBinding;
}) {
  if (input.kind !== FIXTURE_TERMINAL_ONLY) fail('Fixture-only session required');
  checkBinding(input.binding);
  if (input.ownedBy !== input.binding.ownerId) fail('Fixture terminal ownership mismatch');
  const binding = Object.freeze({ ...input.binding });
  const events = new Map<string, string>();
  let active = true;
  let payload: string | null = null;
  let waitSubmit: number | undefined;
  let accepted = false;
  let submitted = false;
  let turnStarted = false;
  let idleObserved = false;
  let submissionUnknown = false;
  let returnedRetryRequestId: string | null = null;
  let retryPlanned = false;
  let cursor = 0;
  let sequence = 0;
  let pendingRead: FixtureReadPlan | null = null;
  let output = '';
  let outputBytes = 0;
  function assertBinding(actual: FixtureTerminalBinding): void {
    if (!active) fail('Fixture session invalidated; remote cancellation remains unverified');
    checkBinding(actual);
    if (bindingKeys.some(key => actual[key] !== binding[key])) fail('Fixture ownership/ticket/run/runtime/terminal/incarnation mismatch');
  }
  function sendArgv(text: string, retryId?: string): readonly string[] {
    return argv('terminal', 'send', '--terminal', binding.terminalHandle, '--text', text, '--enter',
      ...(waitSubmit === undefined ? [] : ['--wait-submit', String(waitSubmit)]),
      ...(retryId === undefined ? [] : ['--retry-request', retryId]), '--json');
  }
  return {
    kind: FIXTURE_TERMINAL_ONLY,
    planSend(actual: FixtureTerminalBinding, text: string, waitSubmitSeconds?: number): readonly string[] {
      assertBinding(actual);
      if (payload !== null) fail('No blind resubmission; reconcile the original request');
      boundedText(text, FIXTURE_TERMINAL_LIMITS.payloadBytes);
      if (waitSubmitSeconds !== undefined) integer(waitSubmitSeconds, 1, FIXTURE_TERMINAL_LIMITS.waitSubmitSeconds);
      payload = text;
      waitSubmit = waitSubmitSeconds;
      return sendArgv(payload);
    },
    planExplicitRetry(actual: FixtureTerminalBinding, retryId: string, identicalPayload: string): readonly string[] {
      assertBinding(actual);
      if (!submissionUnknown || !returnedRetryRequestId || retryId !== returnedRetryRequestId || payload !== identicalPayload || retryPlanned || submitted || turnStarted) {
        fail('Retry requires the same returned ID, payload and incarnation; no blind retry');
      }
      retryPlanned = true;
      return sendArgv(identicalPayload, retryId);
    },
    planRead(actual: FixtureTerminalBinding, requestedCursor: number, limit: number): FixtureReadPlan {
      assertBinding(actual);
      integer(requestedCursor, 0, Number.MAX_SAFE_INTEGER);
      integer(limit, 1, FIXTURE_TERMINAL_LIMITS.readUnits);
      if (requestedCursor !== cursor || pendingRead) fail('Fixture read cursor mismatch or read already pending');
      if (events.size >= FIXTURE_TERMINAL_LIMITS.events) fail('Fixture event budget exhausted');
      pendingRead = Object.freeze({ kind: FIXTURE_TERMINAL_ONLY, sequence: ++sequence, cursor, limit,
        argv: argv('terminal', 'read', '--terminal', binding.terminalHandle, '--cursor', String(cursor), '--limit', String(limit), '--json') });
      return pendingRead;
    },
    planWait(actual: FixtureTerminalBinding, timeoutMs: number): readonly string[] {
      assertBinding(actual);
      integer(timeoutMs, 1, FIXTURE_TERMINAL_LIMITS.waitMs);
      return argv('terminal', 'wait', '--terminal', binding.terminalHandle, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs), '--json');
    },
    observe(event: FixtureObservation): 'recorded' | 'duplicate' {
      assertBinding(event.binding);
      if (event.kind !== FIXTURE_TERMINAL_ONLY) fail('Only authored fixture observations are allowed');
      boundedText(event.eventId, 128);
      // This is a trusted in-memory fixture boundary, not an untrusted wire parser.
      // Bound data before retaining fingerprints; duplicates never count bytes twice.
      if (event.type === 'read' && (typeof event.text !== 'string' || bytes(event.text) > FIXTURE_TERMINAL_LIMITS.readBytes)) fail('Fixture read byte budget exceeded');
      const fingerprint = JSON.stringify(event);
      if (bytes(fingerprint) > FIXTURE_TERMINAL_LIMITS.readBytes + 2048) fail('Fixture event byte budget exceeded');
      if (events.has(event.eventId)) {
        if (events.get(event.eventId) !== fingerprint) fail('Conflicting duplicate fixture event');
        return 'duplicate';
      }
      if (events.size >= FIXTURE_TERMINAL_LIMITS.events) fail('Fixture event budget exhausted');
      switch (event.type) {
        case 'accepted':
          if (payload === null || accepted) fail('Unexpected fixture acceptance');
          accepted = true;
          break;
        case 'submitted':
          if (!accepted || submitted) fail('Fixture submission requires separate acceptance');
          submitted = true;
          submissionUnknown = false;
          break;
        case 'turn-start':
          if (!submitted || turnStarted) fail('Fixture turn start requires separate submission');
          turnStarted = true;
          break;
        case 'tui-idle':
          idleObserved = true;
          break;
        case 'submission-unknown':
          if (payload === null || submitted || turnStarted) fail('Unexpected ambiguous fixture submission');
          boundedText(event.returnedRetryRequestId, 128);
          if (returnedRetryRequestId !== null && returnedRetryRequestId !== event.returnedRetryRequestId) fail('Returned retry identity changed');
          submissionUnknown = true;
          returnedRetryRequestId = event.returnedRetryRequestId;
          break;
        case 'read': {
          const plan = pendingRead ?? fail('Unbound or stale fixture read');
          if (event.readSequence !== plan.sequence || event.cursor !== plan.cursor) fail('Unbound or stale fixture read');
          integer(event.returnedUnits, 0, plan.limit);
          integer(event.nextCursor, cursor, Number.MAX_SAFE_INTEGER);
          if ((event.text.length > 0 || event.returnedUnits > 0) && event.nextCursor === cursor) fail('Nonempty fixture read did not advance');
          const size = bytes(event.text);
          if (outputBytes + size > FIXTURE_TERMINAL_LIMITS.outputBytes) fail('Fixture output byte budget exceeded');
          output += event.text;
          outputBytes += size;
          cursor = event.nextCursor;
          pendingRead = null;
          break;
        }
        default: fail('Unsupported fixture observation');
      }
      events.set(event.eventId, fingerprint);
      return 'recorded';
    },
    snapshot() {
      return Object.freeze({ binding, active, accepted, submitted, turnStarted, idleObserved, submissionUnknown,
        returnedRetryRequestId, retryPlanned, cursor, outputBytes, eventCount: events.size,
        semanticCompletion: false as const, remoteCancellationVerified: false as const });
    },
    readFixtureOutput(actual: FixtureTerminalBinding): string { assertBinding(actual); return output; },
    /** Local invalidation only: no invented kill/close operation and no safe-cancel claim. */
    invalidate(actual: FixtureTerminalBinding): void { assertBinding(actual); active = false; pendingRead = null; output = ''; },
  };
}
