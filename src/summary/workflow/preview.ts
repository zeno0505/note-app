import { chooseAgent, type AgentBudgetDecision } from '../budget';
import type { CodeBurnResult } from '../budget/codeburn';
import type { ProjectionContext } from '../context/projection';
import type { SummaryPrompt } from '../instructions';
import type { SummaryContextPreview, SummaryContextRecordView, SummaryProviderChoice } from '../../shared/summary-workflow';

/** CodeBurn's calendar labels and quota endpoint do not establish a comparable cap or executable agent. */
export function reviewBudget(results: CodeBurnResult[], requestId: string, now: number, choice: SummaryProviderChoice): AgentBudgetDecision {
  const usage = (provider: 'claude' | 'codex') => {
    const latest = [...results].reverse().find(result => result.ok ? result.value.kind === 'status' && result.value.provider === provider : result.error.query === `${provider}-status`);
    return latest && !latest.ok ? { state: 'failed' as const, reason: 'CodeBurn observation failed.' } : { state: 'missing' as const };
  };
  const decision = chooseAgent({ requestId, now, maxObservationAgeMs: 40_000,
    providers: { claude: { availability: 'unknown', usage: usage('claude') }, codex: { availability: 'unknown', usage: usage('codex') } } });
  return { ...decision, reasons: [...decision.reasons, 'codeburn-calendar-basis-unknown', 'agent-availability-unknown', 'quota-is-independent',
    ...(choice === 'auto' ? [] : ['explicit-provider-choice-is-not-execution-authorization'])] };
}
export function contextPreview(prompt: SummaryPrompt, projection: ProjectionContext, selectedTaskCount: number): SummaryContextPreview {
  const records: SummaryContextRecordView[] = prompt.pack.records.map(record => {
    // Generated and validated projection artifact, never raw DAG/source text.
    const artifact = JSON.parse(record.text) as { declaration: string };
    const declaration = JSON.parse(artifact.declaration) as { selection: string; title?: string | null; declaredStatusRaw: string | null; e2eDeclaration?: { coverage: string }; commitReferences?: string[] };
    const provenance = projection.provenance.entries.find(entry => entry.sourceId === record.sourceId);
    return { sourceId: record.sourceId, taskId: provenance?.upstream.taskId ?? null,
      selection: declaration.selection === 'explicit-task' ? 'selected-task' : 'direct-dependency',
      title: declaration.title ?? null, declaredStatus: declaration.declaredStatusRaw, e2eCoverage: declaration.e2eDeclaration?.coverage ?? null,
      commitReferences: declaration.commitReferences ?? [], dependencies: record.dependencies,
      observedAt: record.observedAt, suppliedText: record.text };
  });
  return { selectedTaskCount, recordCount: records.length, bytes: prompt.pack.usage.bytes,
    inputBytes: prompt.accounting.inputBytes, approximateTokens: prompt.accounting.inputApproximateTokens,
    maxResponseBytes: prompt.accounting.maximumResponseBytes, accountingMethod: prompt.accounting.method,
    truncated: prompt.pack.truncated, records, exclusions: prompt.pack.exclusions, unknowns: prompt.pack.coverage.unknowns,
    unresolvedDependencyIds: prompt.pack.unresolvedDependencyIds };
}
