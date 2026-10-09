/** Pure advisory policy. It never runs an agent or authorizes a paid action. */
export type AgentProvider = 'claude' | 'codex';
export interface UsageWindow { start: number; end: number }
export interface ObservedUsage {
  amount: number;
  unit: 'approximate-cost';
  currency: string;
  window: UsageWindow;
  observedAt: number;
  provenance: { source: string };
}
export type UsageObservation =
  | { state: 'observed'; value: ObservedUsage }
  | { state: 'missing' }
  | { state: 'failed'; reason: string };
export interface UserBudget {
  source: 'user-defined';
  amount: number;
  unit: 'approximate-cost';
  currency: string;
  window: UsageWindow;
}
export interface ProviderBudgetInput {
  availability: 'available' | 'unavailable' | 'unknown';
  usage: UsageObservation;
  budget?: UserBudget;
}
export interface AgentBudgetInput {
  requestId: string;
  now: number;
  maxObservationAgeMs: number;
  providers: Record<AgentProvider, ProviderBudgetInput>;
  override?: { provider: AgentProvider; requestId: string; expiresAt: number };
}
export type BudgetStatus = 'unknown' | 'below-cap' | 'cap-reached';
export interface ProviderAssessment {
  provider: AgentProvider;
  availability: ProviderBudgetInput['availability'];
  usage: 'fresh' | 'stale' | 'missing' | 'failed' | 'invalid';
  budget: BudgetStatus;
  reasons: string[];
  /** Approximate observed cost / user cap; never remaining provider quota. */
  capFraction?: number;
}
export type RecommendationBasis = 'user-override' | 'only-within-cap' | 'lower-cap-utilization';
export type AgentBudgetDecision = {
  reasons: string[];
  assessments: ProviderAssessment[];
  executionAuthorized: false;
} & (
  | { state: 'recommendation'; provider: AgentProvider; basis: RecommendationBasis }
  | { state: 'choice-required'; provider?: never; basis?: never }
);

const providers: AgentProvider[] = ['claude', 'codex'];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const windowValid = (value: unknown): value is UsageWindow => record(value)
  && finite(value.start) && finite(value.end) && value.start >= 0 && value.start < value.end;
const amountValid = (value: unknown): value is Pick<UserBudget, 'amount' | 'unit' | 'currency' | 'window'> => record(value)
  && finite(value.amount) && value.amount >= 0 && value.unit === 'approximate-cost'
  && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) && windowValid(value.window);
const sameBasis = (a: ObservedUsage | UserBudget, b: ObservedUsage | UserBudget) =>
  a.unit === b.unit && a.currency === b.currency
  && a.window.start === b.window.start && a.window.end === b.window.end;
const inWindow = (now: number, window: UsageWindow) => now >= window.start && now < window.end;

function assess(provider: AgentProvider, input: ProviderBudgetInput, now: number, maxAge: number): ProviderAssessment {
  const result: ProviderAssessment = {
    provider, availability: input.availability, usage: 'invalid', budget: 'unknown', reasons: [],
  };
  if (input.availability !== 'available') result.reasons.push(`availability-${input.availability}`);
  if (input.budget !== undefined && (!amountValid(input.budget) || input.budget.source !== 'user-defined')) {
    result.reasons.push('invalid-user-cap');
  }
  const observation = input.usage;
  if (!record(observation) || !['observed', 'missing', 'failed'].includes(observation.state)) {
    result.reasons.push('invalid-usage');
    return result;
  }
  if (observation.state === 'failed' && (typeof observation.reason !== 'string' || !observation.reason.trim())) {
    result.reasons.push('invalid-usage');
    return result;
  }
  if (observation.state !== 'observed') {
    result.usage = observation.state;
    result.reasons.push(`usage-${observation.state}`);
    return result;
  }
  const value = observation.value;
  if (!amountValid(value) || !finite(value.observedAt) || value.observedAt > now
    || !inWindow(value.observedAt, value.window) || !record(value.provenance)
    || typeof value.provenance.source !== 'string' || !value.provenance.source.trim()) {
    result.reasons.push('invalid-usage');
    return result;
  }
  if (now - value.observedAt > maxAge || !inWindow(now, value.window)) {
    result.usage = 'stale';
    result.reasons.push('usage-stale');
    return result;
  }
  result.usage = 'fresh';
  result.reasons.push('usage-is-approximate-not-quota');
  const budget = input.budget;
  if (budget === undefined) result.reasons.push('no-user-cap');
  else if (result.reasons.includes('invalid-user-cap')) { /* Keep malformed caps unknown. */ }
  else if (!sameBasis(value, budget)) result.reasons.push('cap-basis-mismatch');
  else {
    result.budget = value.amount >= budget.amount ? 'cap-reached' : 'below-cap';
    // A zero cap is reached even when observed usage is zero; avoid Infinity/NaN.
    if (budget.amount > 0) result.capFraction = value.amount / budget.amount;
    result.reasons.push(result.budget);
  }
  return result;
}

/** Inputs must be normalized by a separately verified adapter. Invalid input fails closed. */
export function chooseAgent(input: AgentBudgetInput): AgentBudgetDecision {
  const result: AgentBudgetDecision = {
    state: 'choice-required', reasons: [], assessments: [], executionAuthorized: false,
  };
  if (!record(input) || typeof input.requestId !== 'string' || !input.requestId.trim()
    || !finite(input.now) || input.now < 0 || !finite(input.maxObservationAgeMs) || input.maxObservationAgeMs < 0
    || !record(input.providers) || providers.some((provider) => !record(input.providers[provider])
      || !['available', 'unavailable', 'unknown'].includes(input.providers[provider].availability))) {
    result.reasons.push('invalid-input');
    return result;
  }
  result.assessments = providers.map((provider) => assess(provider, input.providers[provider], input.now, input.maxObservationAgeMs));
  const recommend = (provider: AgentProvider, basis: RecommendationBasis): AgentBudgetDecision => ({
    ...result, state: 'recommendation', provider, basis,
    reasons: [...result.reasons, 'recommendation-only-next-run-cost-unknown'],
  });
  if (input.override !== undefined) {
    const override = input.override;
    if (!record(override) || !providers.includes(override.provider) || override.requestId !== input.requestId
      || !finite(override.expiresAt) || override.expiresAt <= input.now) {
      result.reasons.push('invalid-or-expired-override');
      return result;
    }
    const chosen = result.assessments.find((entry) => entry.provider === override.provider)!;
    if (chosen.availability !== 'available' || chosen.budget === 'cap-reached') {
      result.reasons.push('override-unavailable-or-cap-reached');
      return result;
    }
    // Malformed input must be corrected, not silently treated as missing data.
    if (chosen.usage === 'invalid' || chosen.reasons.includes('invalid-user-cap')) {
      result.reasons.push('override-invalid-input');
      return result;
    }
    if (chosen.budget === 'unknown') result.reasons.push('override-budget-unknown');
    return recommend(override.provider, 'user-override');
  }
  const available = result.assessments.filter((entry) => entry.availability === 'available');
  const eligible = available.filter((entry) => entry.budget === 'below-cap');
  // Unknown availability or budget cannot be treated as unavailable or zero usage.
  if (result.assessments.some((entry) => entry.availability === 'unknown')
    || available.some((entry) => entry.budget === 'unknown')) {
    result.reasons.push('insufficient-comparable-budget-evidence');
    return result;
  }
  if (eligible.length === 0) {
    result.reasons.push('no-available-provider-below-cap');
    return result;
  }
  if (eligible.length === 1) return recommend(eligible[0].provider, 'only-within-cap');
  const [a, b] = eligible;
  const aBudget = input.providers[a.provider].budget!;
  const bBudget = input.providers[b.provider].budget!;
  if (!sameBasis(aBudget, bBudget)) result.reasons.push('provider-budget-basis-mismatch');
  else if (a.capFraction === b.capFraction) result.reasons.push('equal-cap-utilization');
  else return recommend(a.capFraction! < b.capFraction! ? a.provider : b.provider, 'lower-cap-utilization');
  return result;
}
