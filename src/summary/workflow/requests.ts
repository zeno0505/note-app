import type { SummaryPrepareRequest, SummaryProviderChoice, SummaryReviewRequest, SummaryRunRequest, SummaryTicketRequest } from '../../shared/summary-workflow';

export class SummaryWorkflowError extends Error {
  constructor(public readonly code: 'invalid-request' | 'unknown-ticket' | 'stale-ticket' | 'busy' | 'source-unavailable' | 'deadline' | 'cancelled' | 'unsafe-cache' | 'cache-failed' | 'disposed', message: string) { super(message); }
}
const fail = (): never => { throw new SummaryWorkflowError('invalid-request', 'Invalid bounded summary request.'); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const p = Object.getOwnPropertyDescriptor(value, key);
    if (!p || !('value' in p)) return fail();
    result[key] = p.value;
  }
  return result;
}
function id(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) return fail();
  return value;
}
function provider(value: unknown): SummaryProviderChoice {
  if (value !== 'auto' && value !== 'claude' && value !== 'codex') return fail();
  return value;
}
export function parseSummaryPrepareRequest(input: unknown): SummaryPrepareRequest {
  const r = object(input, ['workstreamId', 'taskIds', 'provider']);
  if (!Array.isArray(r.taskIds) || r.taskIds.length > 32 || Reflect.ownKeys(r.taskIds).length !== r.taskIds.length + 1) return fail();
  const taskIds = Array.from({ length: r.taskIds.length }, (_, index) => {
    const p = Object.getOwnPropertyDescriptor(r.taskIds, String(index));
    if (!p || !('value' in p)) return fail();
    return id(p.value, 4096);
  });
  if (new Set(taskIds).size !== taskIds.length) return fail();
  return { workstreamId: id(r.workstreamId), taskIds: taskIds.sort(), provider: provider(r.provider) };
}
export function parseSummaryTicketRequest(input: unknown): SummaryTicketRequest {
  const r = object(input, ['ticketId']); return { ticketId: id(r.ticketId) };
}
export function parseSummaryRunRequest(input: unknown): SummaryRunRequest {
  const r = object(input, ['ticketId', 'provider']); return { ticketId: id(r.ticketId), provider: provider(r.provider) };
}
export function parseSummaryReviewRequest(input: unknown): SummaryReviewRequest {
  const r = object(input, ['ticketId', 'candidateHash']);
  if (typeof r.candidateHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(r.candidateHash)) return fail();
  return { ticketId: id(r.ticketId), candidateHash: r.candidateHash };
}
