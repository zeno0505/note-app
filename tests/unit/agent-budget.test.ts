import { describe, expect, it } from 'vitest';
import { chooseAgent, type AgentBudgetInput, type AgentProvider } from '../../src/summary/budget';

function fixture(): AgentBudgetInput {
  const provider = (amount: number) => ({
    availability: 'available' as const,
    usage: { state: 'observed' as const, value: {
      amount, unit: 'approximate-cost' as const, currency: 'USD', window: { start: 0, end: 1000 },
      observedAt: 90, provenance: { source: 'synthetic-test-only' },
    } },
    budget: { source: 'user-defined' as const, amount: 100, unit: 'approximate-cost' as const,
      currency: 'USD', window: { start: 0, end: 1000 } },
  });
  return { requestId: 'summary-1', now: 100, maxObservationAgeMs: 20,
    providers: { claude: provider(20), codex: provider(40) } };
}
function override(input: AgentBudgetInput, provider: AgentProvider = 'claude') {
  input.override = { provider, requestId: input.requestId, expiresAt: 120 };
}
function observed(input: AgentBudgetInput, provider: AgentProvider = 'claude') {
  const usage = input.providers[provider].usage;
  if (usage.state !== 'observed') throw new Error('Test fixture must be observed');
  return usage.value;
}

describe('pure agent budget recommendation', () => {
  it('recommends lower comparable user-cap utilization without authorizing execution', () => {
    const input = fixture();
    const original = structuredClone(input);
    expect(chooseAgent(input)).toMatchObject({ state: 'recommendation', provider: 'claude',
      basis: 'lower-cap-utilization', executionAuthorized: false });
    expect(input).toEqual(original);
  });
  it('uses user caps rather than assuming lower observed cost is cheaper next time', () => {
    const input = fixture();
    input.providers.claude.budget!.amount = 25;
    expect(chooseAgent(input).provider).toBe('codex');
    delete input.providers.codex.budget;
    expect(chooseAgent(input).state).toBe('choice-required');
  });
  it.each(['missing', 'failed'] as const)('surfaces %s usage without changing availability', (state) => {
    const input = fixture();
    input.providers.claude.usage = state === 'missing' ? { state } : { state, reason: 'synthetic read failure' };
    const result = chooseAgent(input);
    expect(result.state).toBe('choice-required');
    expect(result.assessments[0]).toMatchObject({ usage: state, availability: 'available', budget: 'unknown' });
    expect(result.assessments[0].capFraction).toBeUndefined();
  });
  it('surfaces stale and elapsed-window observations', () => {
    const input = fixture();
    observed(input).observedAt = 79;
    expect(chooseAgent(input).assessments[0].usage).toBe('stale');
    observed(input).observedAt = 90;
    input.now = 1000;
    input.maxObservationAgeMs = 2000;
    expect(chooseAgent(input).assessments[0].usage).toBe('stale');
  });
  it('accepts exact freshness boundary and rejects future observations', () => {
    const input = fixture();
    observed(input).observedAt = 80;
    expect(chooseAgent(input).assessments[0].usage).toBe('fresh');
    observed(input).observedAt = 101;
    expect(chooseAgent(input).assessments[0].usage).toBe('invalid');
  });
  it.each(['currency', 'window'] as const)('refuses %s mismatch against a user cap', (field) => {
    const input = fixture();
    if (field === 'currency') input.providers.claude.budget!.currency = 'EUR';
    else input.providers.claude.budget!.window.end = 2000;
    expect(chooseAgent(input)).toMatchObject({ state: 'choice-required' });
    expect(chooseAgent(input).assessments[0].reasons).toContain('cap-basis-mismatch');
  });
  it.each(['currency', 'window'] as const)('refuses cross-provider %s mismatch', (field) => {
    const input = fixture();
    if (field === 'currency') {
      input.providers.claude.budget!.currency = 'EUR'; observed(input).currency = 'EUR';
    } else {
      input.providers.claude.budget!.window.end = 2000; observed(input).window.end = 2000;
    }
    expect(chooseAgent(input).reasons).toContain('provider-budget-basis-mismatch');
  });
  it.each([100, 101])('excludes reached or exceeded user cap (%s)', (amount) => {
    const input = fixture();
    observed(input).amount = amount;
    expect(chooseAgent(input)).toMatchObject({ provider: 'codex', basis: 'only-within-cap' });
    override(input);
    expect(chooseAgent(input).state).toBe('choice-required');
    expect(chooseAgent(input).provider).toBeUndefined();
  });
  it('requires a choice at equality and when both caps are reached', () => {
    const input = fixture();
    observed(input).amount = 40;
    expect(chooseAgent(input).reasons).toContain('equal-cap-utilization');
    observed(input).amount = 100;
    observed(input, 'codex').amount = 100;
    expect(chooseAgent(input).reasons).toContain('no-available-provider-below-cap');
  });
  it('treats a zero cap and zero usage as reached without a nonfinite fraction', () => {
    const input = fixture();
    observed(input).amount = 0; input.providers.claude.budget!.amount = 0;
    expect(chooseAgent(input).assessments[0]).toMatchObject({ budget: 'cap-reached' });
    expect(chooseAgent(input).assessments[0].capFraction).toBeUndefined();
  });
  it('honors only current request-scoped overrides and does not silently fall back', () => {
    const input = fixture(); override(input, 'codex');
    expect(chooseAgent(input)).toMatchObject({ provider: 'codex', basis: 'user-override' });
    input.providers.codex.availability = 'unavailable';
    expect(chooseAgent(input).state).toBe('choice-required');
    input.providers.codex.availability = 'available'; input.override!.expiresAt = input.now;
    expect(chooseAgent(input).state).toBe('choice-required');
    input.override!.expiresAt = 120; input.override!.requestId = 'other-request';
    expect(chooseAgent(input).state).toBe('choice-required');
  });
  it('surfaces unknown budget on an explicit override, without claiming affordability', () => {
    const input = fixture(); override(input);
    input.providers.claude.usage = { state: 'missing' };
    const result = chooseAgent(input);
    expect(result).toMatchObject({ provider: 'claude', executionAuthorized: false });
    expect(result.reasons).toContain('override-budget-unknown');
    expect(result.assessments[0].capFraction).toBeUndefined();
  });
  it('distinguishes actual unavailability from unknown availability', () => {
    const input = fixture();
    input.providers.claude.availability = 'unavailable';
    input.providers.claude.usage = { state: 'missing' };
    expect(chooseAgent(input).provider).toBe('codex');
    input.providers.claude.availability = 'unknown';
    expect(chooseAgent(input).state).toBe('choice-required');
  });
  it.each([NaN, Infinity, -1])('rejects malformed amounts (%s)', (amount) => {
    const input = fixture(); observed(input).amount = amount; override(input);
    expect(chooseAgent(input)).toMatchObject({ state: 'choice-required' });
    expect(chooseAgent(input).assessments[0].usage).toBe('invalid');
  });
  it('rejects absent provenance, malformed units, caps, and top-level values', () => {
    const input = fixture(); override(input);
    observed(input).provenance.source = ' ';
    expect(chooseAgent(input).state).toBe('choice-required');
    observed(input).provenance.source = 'synthetic';
    (observed(input) as unknown as { unit: string }).unit = 'tokens';
    expect(chooseAgent(input).state).toBe('choice-required');
    input.providers.claude.usage = { state: 'missing' };
    input.providers.claude.budget!.amount = NaN;
    expect(chooseAgent(input).reasons).toContain('override-invalid-input');
    expect(chooseAgent(null as unknown as AgentBudgetInput).reasons).toContain('invalid-input');
    input.maxObservationAgeMs = -1;
    expect(chooseAgent(input).reasons).toContain('invalid-input');
  });
});
