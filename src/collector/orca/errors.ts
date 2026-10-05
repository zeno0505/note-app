import type { OrcaFailureKind, OrcaQuery, OrcaResult } from './types';
const messages: Record<OrcaFailureKind, string> = {
  forbidden_query: 'This Orca query is not allowed.',
  busy: 'An Orca read is already in progress.',
  cancelled: 'The Orca read was cancelled.',
  timeout: 'The Orca read exceeded its time limit.',
  output_limit: 'The Orca read exceeded its output limit.',
  unavailable: 'Orca is unavailable or its runtime is not ready.',
  access_denied: 'Access to the Orca runtime was denied.',
  spawn_failed: 'The Orca read process could not be started.',
  command_failed: 'The Orca read process did not complete successfully.',
  invalid_json: 'Orca returned invalid JSON.',
  invalid_schema: 'Orca returned an unsupported or inconsistent response.',
  remote_error: 'Orca reported a read failure.',
  runtime_unidentified: 'The Orca runtime identity was not observed.',
  runtime_changed: 'The Orca runtime changed during collection.',
  ambiguous_identity: 'Orca returned ambiguous record identities.',
  cleanup_unverified: 'Orca query cleanup could not be verified; this collector is disabled.',
};
export function failure<T = never>(kind: OrcaFailureKind, query: OrcaQuery | null, runtimeId: string | null = null): OrcaResult<T> {
  return { ok: false, error: { kind, query, message: messages[kind], runtimeId } };
}
