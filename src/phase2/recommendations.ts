import type { MemoryView, QuotaView, ResourceFreshness } from './resources';

export interface DispatchReviewSignal {
  id: string;
  kind: 'review' | 'verification' | 'discussion' | 'priority' | 'current-work';
  state: 'pending' | 'clear' | 'unknown';
  source: string;
  observedAt: number | null;
  freshness: ResourceFreshness;
  /** Required context for the policy interpretation; a link alone is not review evidence. */
  reason: string;
}
export interface DispatchAdvisoryPolicy {
  id: string;
  version: string;
  source: string;
  holdForQuotaExhausted: boolean;
  /** OS-reported pressure states, never thresholds invented from RSS or swap bytes. */
  holdForMemoryPressure: readonly ('warning' | 'critical')[];
  holdForPending: readonly DispatchReviewSignal['kind'][];
}
export const DEFAULT_DISPATCH_ADVISORY_POLICY: Readonly<DispatchAdvisoryPolicy> = Object.freeze({
  id: 'resource-review-advisory', version: '1', source: 'note-app:phase2-advisory',
  holdForQuotaExhausted: true,
  holdForMemoryPressure: Object.freeze(['warning', 'critical'] as const),
  holdForPending: Object.freeze(['review', 'verification', 'discussion', 'priority', 'current-work'] as const),
});
export interface DispatchRecommendationReason {
  code: 'quota-exhausted' | 'quota-unknown' | 'quota-stale' | 'account-coverage-unknown'
    | 'memory-pressure' | 'memory-unknown' | 'signal-pending' | 'signal-unknown' | 'review-not-observed';
  effect: 'hold' | 'uncertain';
  source: string;
  observedAt: number | null;
  detail: string;
}
export interface DispatchRecommendationInput {
  quota: QuotaView;
  memory: MemoryView;
  reviewSignals?: readonly DispatchReviewSignal[];
  policy?: Readonly<DispatchAdvisoryPolicy>;
  /** Acknowledging advice does not override the evidence or authorize execution. */
  acknowledged?: boolean;
}
export interface DispatchRecommendation {
  state: 'hold-advised' | 'insufficient-observation' | 'no-observed-hold';
  policy: { id: string; version: string; source: string };
  reasons: DispatchRecommendationReason[];
  executionAuthorized: false;
  enforcement: 'none';
  executor: 'orca';
  acknowledged: boolean;
  observationCost: 'projection-only-no-collection';
  message: string;
}

/** Advisory only: no command, process termination, dispatch, or permission result exists. */
export function evaluateDispatchRecommendation(input: DispatchRecommendationInput): DispatchRecommendation {
  const policy = input.policy ?? DEFAULT_DISPATCH_ADVISORY_POLICY;
  const reasons: DispatchRecommendationReason[] = [];
  const add = (code: DispatchRecommendationReason['code'], effect: DispatchRecommendationReason['effect'], source: string, observedAt: number | null, detail: string) => {
    reasons.push({ code, effect, source, observedAt, detail });
  };
  if (input.quota.accountCoverage !== 'complete' || !input.quota.providers.length) {
    add('account-coverage-unknown', 'uncertain', 'account-observation', null, 'Not all provider accounts are known to be observed. Account percentages cannot be combined.');
  }
  for (const provider of input.quota.providers) {
    if (!provider.accounts.length) add('quota-unknown', 'uncertain', provider.provider, null, 'No account quota observation is available.');
    for (const account of provider.accounts) {
      if (account.freshness !== 'current') {
        add(account.freshness === 'stale' ? 'quota-stale' : 'quota-unknown', 'uncertain', account.source, account.lastSuccess,
          `${provider.provider} / ${account.accountRef}: current quota is not established.`);
        continue;
      }
      if (account.identity !== 'verified-reference' || account.quotaData !== 'available' || account.error !== null || !account.windows.length) {
        add('quota-unknown', 'uncertain', account.source, account.observedAt,
          `${provider.provider} / ${account.accountRef}: account identity, quota data, or windows are unverified.`);
      }
      for (const window of account.windows) {
        if (window.usedPct === null || !Number.isFinite(window.usedPct) || window.usedPct < 0) {
          add('quota-unknown', 'uncertain', account.source, account.lastSuccess, `${window.label}: usage percentage is unknown.`);
        } else if (policy.holdForQuotaExhausted && window.usedPct >= 100 && account.quotaData === 'available' && account.error === null) {
          // This reason remains scoped to this observed window, including legacy identity unknown.
          add('quota-exhausted', 'hold', account.source, account.lastSuccess,
            `${provider.provider} / ${account.accountRef} / ${window.label}: the observed quota window is exhausted. This does not establish project usage or another account's quota.`);
        }
      }
    }
  }
  const pressure = input.memory.pressure;
  if (pressure.state === 'unknown' || pressure.freshness !== 'current' || pressure.observedAt === null || !Number.isFinite(pressure.observedAt) || pressure.observedAt < 0 || !pressure.source.trim()) {
    add('memory-unknown', 'uncertain', pressure.source, pressure.observedAt, 'Current system memory pressure is unobserved. Process RSS alone does not define a safe capacity threshold.');
  } else if (pressure.state !== 'normal' && policy.holdForMemoryPressure.includes(pressure.state)) {
    add('memory-pressure', 'hold', pressure.source, pressure.observedAt, `The supplied system observation reports ${pressure.state} pressure.`);
  }
  if (!input.reviewSignals?.length) add('review-not-observed', 'uncertain', 'task-review', null, 'No current review, verification, priority or work context is supplied.');
  for (const signal of input.reviewSignals ?? []) {
    if (signal.state === 'unknown' || signal.freshness !== 'current' || signal.observedAt === null || !Number.isFinite(signal.observedAt) || signal.observedAt < 0 || !signal.source.trim() || !signal.reason.trim()) {
      add('signal-unknown', 'uncertain', signal.source, signal.observedAt, `${signal.id}: current ${signal.kind} evidence is not established.`);
    } else if (signal.state === 'pending' && policy.holdForPending.includes(signal.kind)) {
      add('signal-pending', 'hold', signal.source, signal.observedAt, `${signal.id}: ${signal.reason}`);
    }
  }
  const state = reasons.some(reason => reason.effect === 'hold') ? 'hold-advised'
    : reasons.some(reason => reason.effect === 'uncertain') ? 'insufficient-observation' : 'no-observed-hold';
  return {
    state, policy: { id: policy.id, version: policy.version, source: policy.source }, reasons,
    executionAuthorized: false, enforcement: 'none', executor: 'orca', acknowledged: input.acknowledged === true,
    observationCost: 'projection-only-no-collection',
    message: state === 'hold-advised' ? 'Consider holding further dispatch while reviewing the cited observations. Execution remains with Orca.'
      : state === 'insufficient-observation' ? 'Insufficient current observations for a dispatch recommendation. Unknown or stale evidence is not permission to run.'
        : 'No hold reason was found in the supplied observations. This is not execution permission or a guarantee of capacity.',
  };
}
