import type { AgentProvider } from '../budget';
import type { SummaryPrompt } from '../instructions';

/** Historical schema notes ONLY. This is not executable argv or security authorization.
 * create --worktree selector --command 'claude|codex' --json
 * send --terminal handle --text boundedPrompt --enter --json
 * --wait-submit seconds; --retry-request returned-id
 * read --terminal handle --cursor n --limit n --json
 * wait --terminal handle --for tui-idle --timeout-ms ms --json
 * Read confinement, restricted agent tools, safe cancellation and semantic framing
 * are unverified. No production terminal, CLI, provider, shell or network is invoked.
 */
export const SUMMARY_TRANSPORT_GATE = Object.freeze({
  state: 'blocked' as const,
  reason: 'Restricted agent tools, response confinement and safe cancellation are not verified. Production summary execution is blocked.',
  automaticRetry: false as const,
  idleMeansCompletion: false as const,
});
export type SyntheticSummaryEvent =
  | { type: 'submitted' }
  | { type: 'waiting' }
  | { type: 'tui-idle' }
  | { type: 'response'; response: unknown }
  | { type: 'submission-unknown'; retryRequestId: string }
  | { type: 'error' };
/** Test seam only. Not configurable in the production factory or renderer IPC. */
export interface SyntheticSummaryTransport {
  kind: 'synthetic-test-only';
  run(request: { ticketId: string; provider: AgentProvider; prompt: SummaryPrompt; claimIds: string[] | null; signal: AbortSignal }, emit: (event: SyntheticSummaryEvent) => Promise<void>): Promise<void>;
}
