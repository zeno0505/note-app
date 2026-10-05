import { randomUUID } from 'node:crypto';
import type { DagReadModel } from '../../facts/dag-read-model';
import type { CodeBurnResult } from '../budget/codeburn';
import type { AgentProvider } from '../budget';
import { createSummaryStore, restoreSummaryStoreFromLocalCache } from '../claims';
import { buildContextPack } from '../context';
import { extractProjectionContext, type ProjectionContext } from '../context/projection';
import { compileSummaryPrompt, type SummaryPrompt } from '../instructions';
import { createLocalSummaryCache, SummaryCacheError, type SummaryCacheRecord } from '../storage';
import { summaryCacheCodec, type SummaryCachePayload } from '../storage/payload';
import type { SummaryPrepareRequest, SummaryWorkflowView, SummaryProviderChoice } from '../../shared/summary-workflow';
import { parseSummaryPrepareRequest, parseSummaryReviewRequest, parseSummaryRunRequest, parseSummaryTicketRequest, SummaryWorkflowError } from './requests';
import { ensureSummaryCacheDirectory } from './cache-path';
import { contextPreview, reviewBudget } from './preview';
import { SUMMARY_TRANSPORT_GATE, type SyntheticSummaryTransport } from './transport';
export { SummaryWorkflowError, parseSummaryPrepareRequest, parseSummaryReviewRequest, parseSummaryRunRequest, parseSummaryTicketRequest } from './requests';
export { SUMMARY_TRANSPORT_GATE } from './transport';

export interface SummaryWorkflowSource {
  /** Currently verified canonical reader model and mapping, supplied by trusted main code. */
  dag: DagReadModel;
  /** Binds canonical path, mapped scope and live workstream identity. Local only. */
  mappingIdentity: string;
  codeburn: CodeBurnResult[];
}
export interface SummaryWorkflowOptions {
  /** Existing canonical private app-owned root. Not a vault, note directory or renderer setting. */
  cacheRoot: string;
  resolveSource(workstreamId: string, signal: AbortSignal): Promise<SummaryWorkflowSource>;
  now?: () => number;
  ioDeadlineMs?: number;
  runDeadlineMs?: number;
}
type Store = ReturnType<typeof createSummaryStore>;
type Cache = ReturnType<typeof createLocalSummaryCache<SummaryCachePayload>>;
interface Session {
  id: string; request: SummaryPrepareRequest; controller: AbortController; view: SummaryWorkflowView;
  mappingIdentity: string | null; projection: ProjectionContext | null; prompt: SummaryPrompt | null;
  store: Store | null; manifests: ProjectionContext[]; cache: Cache | null; scopeId: string | null;
  operation: boolean; runUsed: boolean; reviewUsed: boolean; retired: boolean; sourceVerified: boolean;
}
const CONTEXT_LIMITS = Object.freeze({ maxBytes: 32_768, maxApproxTokens: 32_768, maxRecords: 64 });
const PROMPT_LIMITS = Object.freeze({ maxInputBytes: 65_536, maxInputApproxTokens: 65_536, maxResponseBytes: 131_072 });
const ACTIVE = new Set(['preparing', 'submitting', 'submitted', 'waiting', 'approving']);
const clone = <T>(value: T): T => structuredClone(value);
const maxTickets = 64;

/** Production entry point: there is deliberately no transport/configuration activation option. */
export function createSummaryWorkflow(options: SummaryWorkflowOptions) { return createWorkflow(options, null); }
/** Synthetic tests only. Never import this factory from main/preload/renderer. */
export function createSyntheticSummaryWorkflowForTests(options: SummaryWorkflowOptions & { transport: SyntheticSummaryTransport }) {
  if (options.transport.kind !== 'synthetic-test-only') throw new Error('Synthetic transport required.');
  return createWorkflow(options, options.transport);
}
function createWorkflow(options: SummaryWorkflowOptions, transport: SyntheticSummaryTransport | null) {
  const now = options.now ?? Date.now;
  const timeout = options.ioDeadlineMs ?? 5_000; const runTimeout = options.runDeadlineMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 || !Number.isSafeInteger(runTimeout) || runTimeout < 1 || runTimeout > 300_000) throw new Error('Invalid workflow deadline.');
  const sessions = new Map<string, Session>(); const current = new Map<string, string>();
  const retiredScopes = new Set<string>(); const listeners = new Set<(view: SummaryWorkflowView) => void>();
  let disposed = false;
  function active(s: Session): boolean { return !disposed && current.get(s.request.workstreamId) === s.id && !s.controller.signal.aborted && !s.retired; }
  function assertActive(s: Session): void { if (!active(s)) throw new SummaryWorkflowError('stale-ticket', 'This summary ticket is cancelled, replaced or retired.'); }
  function update(s: Session): SummaryWorkflowView {
    const snapshot = s.store?.snapshot();
    if (snapshot) { s.view.candidateHash = snapshot.candidate?.candidateHash ?? null; s.view.approvedCandidateHash = snapshot.approved?.summary.candidateHash ?? null; s.view.candidateClaims = clone(snapshot.candidateClaims); s.view.approvedClaims = clone(snapshot.approvedClaims); s.view.approvedAt = snapshot.approved?.approvedAt ?? null; }
    if (snapshot && !s.sourceVerified) {
      const uncertain = (claims: typeof snapshot.candidateClaims) => claims.map(view => ({ ...view, freshness: 'unknown' as const, reasons: [...view.reasons, 'observation:unavailable'] }));
      s.view.candidateClaims = uncertain(s.view.candidateClaims); s.view.approvedClaims = uncertain(s.view.approvedClaims);
    }
    const unapproved = !!snapshot?.candidate && snapshot.approved?.summary.candidateHash !== snapshot.candidate.candidateHash;
    const saved = ['candidate-saved', 'restored'].includes(s.view.persistence.state) && ['prepared', 'candidate'].includes(s.view.state);
    s.view.canRun = active(s) && !s.operation && !s.runUsed && !!transport && s.view.state === 'prepared';
    s.view.canApprove = active(s) && !s.operation && !s.reviewUsed && unapproved && saved && s.sourceVerified && snapshot!.candidate!.packHash === snapshot!.binding.packHash && !snapshot!.candidateClaims.some(c => c.claim.kind !== 'unknown' && c.freshness !== 'current');
    s.view.canReject = active(s) && !s.operation && !s.reviewUsed && unapproved && saved;
    s.view.canCancel = active(s) && (ACTIVE.has(s.view.state) || ['prepared', 'blocked', 'candidate'].includes(s.view.state));
    s.view.sequence++;
    return clone(s.view);
  }
  function publish(s: Session): SummaryWorkflowView {
    const view = update(s);
    if (!disposed) for (const listener of [...listeners]) { try { listener(clone(view)); } catch { /* Consumer isolation. */ } }
    return view;
  }
  function session(id: string): Session {
    if (disposed) throw new SummaryWorkflowError('disposed', 'Summary workflow is closed.');
    const s = sessions.get(id); if (!s) throw new SummaryWorkflowError('unknown-ticket', 'Unknown summary ticket.'); return s;
  }
  function begin(s: Session): void { assertActive(s); if (s.operation) throw new SummaryWorkflowError('busy', 'A summary operation is already active.'); s.operation = true; }
  function fail(s: Session, error: unknown): void {
    if (disposed || current.get(s.request.workstreamId) !== s.id || s.view.state === 'cancelled') return;
    s.view.state = 'error';
    s.view.message = error instanceof SummaryWorkflowError && error.code === 'deadline' ? 'The operation exceeded its deadline. Late results cannot authorize another run.'
      : error instanceof SummaryWorkflowError && error.code === 'stale-ticket' ? 'The selected context or mapping changed. Prepare a new review; this ticket cannot approve the old candidate.'
      : error instanceof SummaryCacheError ? 'The summary cache could not be updated. Existing disk state was not assumed to be replaced.'
      : 'Summary preparation or review failed. No new approval was recorded.';
  }
  /** Deadline releases UI response, but never pretends that an outstanding kernel write rolled back. */
  async function bounded<T>(s: Session, action: (signal: AbortSignal) => Promise<T>, milliseconds: number, onLate?: (value: T | null, error: unknown | null) => void): Promise<T> {
    assertActive(s); const controller = new AbortController(); const signal = AbortSignal.any([s.controller.signal, controller.signal]);
    return await new Promise<T>((resolve, reject) => {
      let finished = false;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { if (finished) return; finished = true; cleanup(); reject(new SummaryWorkflowError(controller.signal.aborted ? 'deadline' : 'cancelled', 'Summary operation stopped.')); };
      const timer = setTimeout(() => controller.abort(), milliseconds); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void Promise.resolve().then(() => { if (signal.aborted) throw new SummaryWorkflowError('cancelled', 'Summary operation cancelled.'); return action(signal); }).then(value => {
        if (finished) { onLate?.(value, null); return; }
        finished = true; cleanup(); resolve(value);
      }, error => { if (finished) { onLate?.(null, error); return; } finished = true; cleanup(); reject(error); });
    });
  }
  async function resolve(s: Session): Promise<{source: SummaryWorkflowSource; projection: ProjectionContext; prompt: SummaryPrompt}> {
    const source = await bounded(s, signal => options.resolveSource(s.request.workstreamId, signal), timeout);
    assertActive(s);
    if (!source || typeof source.mappingIdentity !== 'string' || !source.mappingIdentity || source.mappingIdentity.length > 16_384 || !Array.isArray(source.codeburn) || source.codeburn.length > 12) throw new SummaryWorkflowError('source-unavailable', 'Verified summary source is unavailable.');
    const known = new Set(source.dag.tasks.map(task => task.id));
    if (s.request.taskIds.some(id => !known.has(id))) throw new SummaryWorkflowError('invalid-request', 'A selected task is not in the verified workstream.');
    const projection = extractProjectionContext({ schemaVersion: 1, dagId: source.dag.dagId, dag: source.dag,
      requestedTaskIds: s.request.taskIds, excerpts: [], previousSources: [], priorApprovedSummary: null, limits: CONTEXT_LIMITS });
    const prompt = compileSummaryPrompt(projection.input, PROMPT_LIMITS);
    return { source: clone(source), projection, prompt };
  }
  function refreshBudget(s: Session, source: SummaryWorkflowSource, choice: SummaryProviderChoice): void {
    s.view.providerChoice = choice; s.view.codeburn = clone(source.codeburn); s.view.budget = reviewBudget(source.codeburn, s.id, now(), choice);
  }
  /** Delegate all semantic freshness to the existing store, including timestamp-only no-ops. */
  async function revalidate(s: Session): Promise<void> {
    let resolved: Awaited<ReturnType<typeof resolve>>;
    try { resolved = await resolve(s); } catch (error) { s.sourceVerified = false; throw error; }
    const { source, projection, prompt } = resolved;
    if (source.mappingIdentity !== s.mappingIdentity || prompt.pack.scopeId !== s.scopeId) { s.retired = true; s.sourceVerified = false; throw new SummaryWorkflowError('stale-ticket', 'Canonical workstream mapping changed. Prepare a new review.'); }
    s.sourceVerified = true; refreshBudget(s, source, s.view.providerChoice);
    const changed = s.store!.updateContext(prompt.pack).changed;
    if (changed) {
      s.projection = projection; s.prompt = prompt; s.view.preview = contextPreview(prompt, projection, s.request.taskIds.length);
      s.manifests.push(projection); s.retired = true;
      throw new SummaryWorkflowError('stale-ticket', 'Selected context changed. Prepare a new review.');
    }
  }
  function payload(s: Session, store: Store): SummaryCachePayload {
    const state = store.exportState();
    const needed = new Map(state.packs.flatMap(pack => pack.records.filter(r => r.sourceId.startsWith('projection-v1-')).map(record => [JSON.stringify(record), record] as const)));
    const projectionContexts: ProjectionContext[] = [];
    for (const context of s.manifests) {
      if (!context.provenance.entries.length || !context.input.records.every(record => state.packs.some(pack => pack.sources.some(source => source.sourceId === record.sourceId && source.sourceHash === record.sourceHash)))) continue;
      if (!context.input.records.some(record => needed.has(JSON.stringify(record)))) continue;
      projectionContexts.push(context); for (const record of context.input.records) needed.delete(JSON.stringify(record));
    }
    if (needed.size) throw new SummaryWorkflowError('cache-failed', 'Exact historical projection evidence is unavailable.');
    return summaryCacheCodec.parse({ state, projectionContexts });
  }
  async function persist(s: Session, proposed: Store, kind: 'candidate' | 'approval' | 'rejection'): Promise<void> {
    assertActive(s);
    if (!s.cache || !s.scopeId || retiredScopes.has(s.scopeId)) throw new SummaryWorkflowError('cache-failed', 'The cache is retired until restart.');
    const next = payload(s, proposed); const previousRevision = s.view.persistence.revision;
    s.view.persistence = { state: kind === 'approval' ? 'saving-approval' : 'saving-candidate', revision: previousRevision, message: kind === 'approval' ? 'Saving the explicit user approval.' : kind === 'rejection' ? 'Saving candidate rejection; prior approval is retained.' : 'Saving an unapproved candidate.' }; publish(s);
    const accept = (record: SummaryCacheRecord<SummaryCachePayload>, late: boolean): void => {
      s.store = proposed; s.manifests = record.payload.projectionContexts;
      s.view.persistence = { state: late ? 'committed-after-cancel' : kind === 'approval' ? 'approval-saved' : kind === 'rejection' ? 'rejection-saved' : 'candidate-saved', revision: record.revision,
        message: late ? 'The write committed after cancellation or its deadline. No rollback was attempted; read the cache before further changes.' : kind === 'approval' ? 'User approval saved locally.' : kind === 'rejection' ? 'Candidate rejection saved; prior approved summary retained.' : 'Unapproved candidate saved locally; this is not approval.' };
      if (late) { s.retired = true; s.view.state = 'error'; s.view.message = 'The late cache write committed. This ticket is retired; restart before another write.'; publish(s); }
    };
    try {
      const record = await bounded(s, async signal => {
        await ensureSummaryCacheDirectory(options.cacheRoot, s.scopeId!, signal, false);
        return s.cache!.write(next, previousRevision, signal);
      }, timeout, (record, error) => {
        if (record) accept(record, true);
        else if (error instanceof SummaryCacheError && error.code === 'committed-cleanup-failed') {
          s.view.persistence = { state: 'commit-unknown', revision: previousRevision, message: `The adapter reports committed revision ${error.committedRevision}; cleanup failed. Restart and read the cache before any retry.` }; publish(s);
        }
      });
      accept(record, false);
    } catch (error) {
      if ((error instanceof SummaryWorkflowError && ['deadline', 'cancelled'].includes(error.code)) || (error instanceof SummaryCacheError && error.code === 'committed-cleanup-failed')) {
        retiredScopes.add(s.scopeId); s.retired = true;
        s.view.persistence = { state: 'commit-unknown', revision: previousRevision, message: error instanceof SummaryCacheError && error.code === 'committed-cleanup-failed'
          ? `The adapter reports committed revision ${error.committedRevision}, but cleanup failed. Restart and read the cache before any retry.`
          : 'A cache write may have committed. This cache is retired; no automatic retry or rollback is allowed.' };
      } else s.view.persistence = { state: 'failed', revision: previousRevision, message: 'Local save failed. The previous cache revision has not been replaced successfully by this operation.' };
      throw error;
    }
  }
  function fork(s: Session): Store { const state = s.store!.exportState(); return restoreSummaryStoreFromLocalCache(state, state.packs.find(p => p.packHash === state.currentPackHash)!); }
  function cancelSession(s: Session, message: string): SummaryWorkflowView {
    s.controller.abort(); s.view.state = 'cancelled'; s.view.message = message;
    return publish(s);
  }
  return {
    async prepare(input: unknown): Promise<SummaryWorkflowView> {
      if (disposed) throw new SummaryWorkflowError('disposed', 'Summary workflow is closed.');
      const request = parseSummaryPrepareRequest(input);
      const previous = current.get(request.workstreamId); if (previous) cancelSession(sessions.get(previous)!, 'Replaced by a newer summary preparation.');
      if (sessions.size >= maxTickets) {
        for (const [id, session] of sessions) if (!session.operation && !active(session)) { sessions.delete(id); if (sessions.size < maxTickets) break; }
        if (sessions.size >= maxTickets) throw new SummaryWorkflowError('busy', 'Summary ticket limit reached.');
      }
      const id = `summary-${randomUUID()}`;
      const s: Session = { id, request, controller: new AbortController(), mappingIdentity: null, projection: null, prompt: null, store: null,
        manifests: [], cache: null, scopeId: null, operation: true, runUsed: false, reviewUsed: false, retired: false, sourceVerified: false,
        view: { ticketId: id, sequence: 0, workstreamId: request.workstreamId, taskIds: request.taskIds, state: 'preparing', message: 'Preparing the explicit bounded task slice.', providerChoice: request.provider,
          selectedProvider: null, transport: transport ? 'synthetic-test-only' : 'blocked', executionAuthorized: false, preview: null, budget: null, codeburn: [],
          candidateHash: null, approvedCandidateHash: null, candidateClaims: [], approvedClaims: [], approvedAt: null, persistence: { state: 'not-saved', revision: null, message: 'No summary has been saved by this preparation.' }, canRun: false, canApprove: false, canReject: false, canCancel: true } };
      sessions.set(id, s); current.set(request.workstreamId, id); publish(s);
      try {
        const { source, projection, prompt } = await resolve(s);
        s.sourceVerified = true; s.mappingIdentity = source.mappingIdentity; s.scopeId = prompt.pack.scopeId; s.projection = projection; s.prompt = prompt; s.manifests = [projection];
        s.view.preview = contextPreview(prompt, projection, request.taskIds.length); refreshBudget(s, source, request.provider);
        if (retiredScopes.has(s.scopeId)) throw new SummaryWorkflowError('cache-failed', 'The scope has an unsettled cache operation.');
        const directory = await bounded(s, signal => ensureSummaryCacheDirectory(options.cacheRoot, s.scopeId!, signal), timeout);
        s.cache = createLocalSummaryCache({ directory, codec: summaryCacheCodec });
        let cached: SummaryCacheRecord<SummaryCachePayload> | null;
        try { cached = await bounded(s, signal => s.cache!.read(signal), timeout); }
        catch (error) { if (error instanceof SummaryWorkflowError && ['deadline', 'cancelled'].includes(error.code)) retiredScopes.add(s.scopeId); throw error; }
        assertActive(s);
        s.store = cached ? restoreSummaryStoreFromLocalCache(cached.payload.state, prompt.pack) : createSummaryStore(prompt.pack);
        if (cached) {
          s.manifests = [...cached.payload.projectionContexts, projection];
          s.view.persistence = { state: 'restored', revision: cached.revision, message: 'Historical local candidate and approval restored separately. Restoration is not a new approval.' };
          // A timestamp-only refresh retains the exact earlier response binding and evidence.
          const binding = s.store.snapshot().binding;
          if (binding.packHash !== prompt.pack.packHash) {
            const prior = s.manifests.find(context => buildContextPack(context.input).packHash === binding.packHash);
            if (prior) { s.projection = prior; s.prompt = compileSummaryPrompt(prior.input, PROMPT_LIMITS); s.view.preview = contextPreview(s.prompt, prior, request.taskIds.length); }
          }
        }
        s.view.state = 'prepared'; s.view.message = transport ? 'Bounded synthetic test context is ready for review.' : SUMMARY_TRANSPORT_GATE.reason;
      } catch (error) { fail(s, error); }
      finally { s.operation = false; }
      return publish(s);
    },
    async run(input: unknown): Promise<SummaryWorkflowView> {
      const request = parseSummaryRunRequest(input); const s = session(request.ticketId); begin(s);
      try {
        if (s.runUsed || s.reviewUsed || s.view.state !== 'prepared') throw new SummaryWorkflowError('stale-ticket', 'This ticket cannot start another run.');
        s.runUsed = true; s.view.providerChoice = request.provider;
        await revalidate(s); assertActive(s);
        if (!transport) { s.view.state = 'blocked'; s.view.message = SUMMARY_TRANSPORT_GATE.reason; return update(s); }
        if (request.provider === 'auto') { s.view.state = 'blocked'; s.view.message = 'Agent availability and comparable budget basis are unknown. Choose a provider explicitly for the synthetic test.'; return update(s); }
        s.view.selectedProvider = request.provider;
        const working = fork(s); const ticket = working.beginUpdate();
        if (!ticket) { const snap = working.snapshot(); s.view.state = snap.approved?.summary.candidateHash === snap.candidate?.candidateHash ? 'approved' : 'candidate'; s.view.message = 'The selected evidence has no affected claims to regenerate.'; return update(s); }
        if (!s.prompt || ticket.binding.packHash !== s.prompt.pack.packHash) throw new SummaryWorkflowError('stale-ticket', 'The exact reviewed prompt binding is unavailable.');
        s.view.state = 'submitting'; s.view.message = 'Submitting a synthetic test request.'; publish(s);
        let responseAccepted = false; let submissionUnknown = false;
        await bounded(s, signal => transport.run({ ticketId: s.id, provider: request.provider as AgentProvider, prompt: clone(s.prompt!), claimIds: ticket.claimIds, signal }, async event => {
          if (!active(s) || signal.aborted || responseAccepted || submissionUnknown) return;
          if (event.type === 'submitted') { if (s.view.state !== 'submitting') throw new Error('Unexpected synthetic submission.'); s.view.state = 'submitted'; s.view.message = 'Submission acknowledged; no semantic response has been accepted.'; publish(s); }
          else if (event.type === 'waiting' || event.type === 'tui-idle') {
            if (!['submitted', 'waiting'].includes(s.view.state)) throw new Error('Unexpected synthetic wait.');
            s.view.state = 'waiting'; s.view.message = event.type === 'tui-idle' ? 'The terminal is idle; a valid semantic response is still required.' : 'Waiting for a bounded semantic response.'; publish(s);
          } else if (event.type === 'submission-unknown') { submissionUnknown = true; s.view.state = 'error'; s.view.message = 'Submission is ambiguous. No blind resend or automatic retry was attempted.'; publish(s); }
          else if (event.type === 'error') throw new Error('Synthetic transport error.');
          else if (event.type === 'response') {
            if (!['submitted', 'waiting'].includes(s.view.state)) throw new Error('Response arrived before verified submission.');
            responseAccepted = true; await revalidate(s); assertActive(s);
            if (!working.acceptResponse(ticket, event.response)) throw new Error('Invalid summary response.');
            s.store = working; s.view.state = 'candidate'; s.view.message = 'Unreviewed candidate received. It is not an approved summary.'; publish(s);
            await persist(s, working, 'candidate');
          }
        }), runTimeout);
        if (!responseAccepted && !submissionUnknown) { working.failRequest(ticket, 'No bounded semantic response was received.'); s.view.state = 'error'; s.view.message = 'The run ended without a validated summary candidate. Idle does not mean completion.'; }
      } catch (error) {
        if (error instanceof SummaryWorkflowError && error.code === 'deadline') { s.retired = true; s.controller.abort(); }
        fail(s, error);
      }
      finally { s.operation = false; }
      return publish(s);
    },
    async read(input: unknown): Promise<SummaryWorkflowView> {
      const request = parseSummaryTicketRequest(input); return update(session(request.ticketId));
    },
    async approve(input: unknown): Promise<SummaryWorkflowView> {
      const request = parseSummaryReviewRequest(input); const s = session(request.ticketId);
      if (!update(s).canApprove) throw new SummaryWorkflowError('stale-ticket', 'This candidate cannot be approved.');
      begin(s);
      try {
        s.reviewUsed = true; await revalidate(s); assertActive(s);
        const working = fork(s); const snapshot = working.snapshot();
        if (snapshot.candidate?.candidateHash !== request.candidateHash) throw new SummaryWorkflowError('stale-ticket', 'Candidate review changed.');
        // This event is constructed only here, from the trusted narrow UI approval handler.
        // No model/renderer approval object, timestamp, incarnation or version is accepted.
        if (!working.approve({ kind: 'user-summary-approval', incarnation: snapshot.incarnation, scopeId: snapshot.binding.scopeId,
          candidateHash: request.candidateHash, expectedVersion: snapshot.version, approvalId: `approval-${randomUUID()}`, approvedAt: new Date(now()).toISOString() })) throw new SummaryWorkflowError('stale-ticket', 'Candidate freshness changed.');
        s.view.state = 'approving'; s.view.message = 'Recording the explicit summary approval.'; publish(s);
        await persist(s, working, 'approval');
        if (active(s)) { s.view.state = 'approved'; s.view.message = 'Summary approval saved locally. Proposals remain proposals; no task execution is authorized.'; }
      } catch (error) { fail(s, error); }
      finally { s.operation = false; }
      return publish(s);
    },
    async reject(input: unknown): Promise<SummaryWorkflowView> {
      const request = parseSummaryReviewRequest(input); const s = session(request.ticketId);
      if (!update(s).canReject) throw new SummaryWorkflowError('stale-ticket', 'This candidate cannot be rejected.');
      begin(s);
      try {
        s.reviewUsed = true;
        const state = clone(s.store!.exportState()); if (state.candidate?.candidateHash !== request.candidateHash) throw new SummaryWorkflowError('stale-ticket', 'Candidate review changed.');
        state.candidate = null; state.candidateBases = []; state.version++;
        const retained = new Set([state.currentPackHash, ...state.approvedBases.map(b => b.packHash)]); state.packs = state.packs.filter(pack => retained.has(pack.packHash));
        const working = restoreSummaryStoreFromLocalCache(state, state.packs.find(p => p.packHash === state.currentPackHash)!);
        await persist(s, working, 'rejection');
        if (active(s)) { s.view.state = 'rejected'; s.view.message = 'Candidate rejected. The previous approved summary is retained.'; }
      } catch (error) { fail(s, error); }
      finally { s.operation = false; }
      return publish(s);
    },
    async cancel(input: unknown): Promise<SummaryWorkflowView> {
      const request = parseSummaryTicketRequest(input); const s = session(request.ticketId);
      return cancelSession(s, 'Summary workflow cancelled. No new run or approval can use this ticket.');
    },
    subscribe(listener: (view: SummaryWorkflowView) => void): () => void {
      if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); };
    },
    dispose(): void {
      if (disposed) return; disposed = true;
      for (const s of sessions.values()) {
        if (s.operation) { s.view.state = 'cancelled'; s.view.message = 'Summary workflow closed. Any unsettled cache write requires restart readback.'; }
        s.controller.abort();
      }
      listeners.clear();
    },
  };
}
