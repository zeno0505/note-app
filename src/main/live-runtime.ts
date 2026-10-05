import { createHash } from 'node:crypto';
import path from 'node:path';
import { createOrcaAdapter, type OrcaObservation } from '../collector/orca';
import { mapWorktreesToNotes, type NoteMapping, type NoteWorktree, type ResolvedNoteMapping } from '../collector/notes';
import { createSnapshotStore, type SnapshotClock } from '../collector/snapshot';
import { createDagReader, type DagReadModel } from '../facts/dag-read-model';
import { createCodeBurnReader, type CodeBurnQuery, type CodeBurnResult } from '../summary/budget/codeburn';
import { createSummaryStore, restoreSummaryStoreFromLocalCache, type ClaimView } from '../summary/claims';
import { buildContextPack } from '../summary/context';
import { contextScopeId } from '../summary/context/extract';
import { extractProjectionContext } from '../summary/context/projection';
import { createRegisteredExcerptReader, parseExcerptRegistrations, type RegisteredExcerptContext } from '../summary/context/registered';
import { createLocalSummaryCache } from '../summary/storage';
import { summaryCacheCodec, type SummaryCachePayload } from '../summary/storage/payload';
import type { SummaryCacheRecord } from '../summary/storage';
import { assertPrivateSummaryCachePath } from '../summary/workflow/cache-path';
import type { LiveDagView, LiveSummaryView, LiveWorkspaceView, LiveWorkstreamView } from '../shared/live';
import type { LoadedLiveConfiguration } from './live-config-types';

const INTERVAL_MS = 20_000;
const STALE_MS = 40_000;
const MAX_DAGS = 8;
const MAX_DISPLAY_TASKS = 200;
const MAX_DISPLAY_STATUSES = 12;
const MAX_DISPLAY_REFERENCES = 8;
const CONTEXT_LIMITS = { maxBytes: 32_768, maxApproxTokens: 32_768, maxRecords: 64 };
const CODEBURN_QUERIES: CodeBurnQuery[] = ['claude-status', 'codex-status', 'quota'];
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const identity = (hostId: string | null, worktreeId: string): string => JSON.stringify([hostId, worktreeId]);
const summaryUnavailable = (reason: string): LiveSummaryView => ({ state: 'unavailable', reason, revision: null,
  candidateClaims: [], approvedClaims: [], approvedAt: null, context: null });

/** Internal test seam only. These factories are never reachable through IPC. */
export interface LiveRuntimeDependencies {
  orca: typeof createOrcaAdapter;
  mapNotes: typeof mapWorktreesToNotes;
  dagReader: typeof createDagReader;
  codeburn: typeof createCodeBurnReader;
  summaryCache(options: {directory: string; codec: typeof summaryCacheCodec}): {
    read(signal?: AbortSignal): Promise<SummaryCacheRecord<SummaryCachePayload> | null>;
  };
  excerptReader: typeof createRegisteredExcerptReader;
  clock: SnapshotClock;
}
interface WorktreeSource {id: string; worktreeId: string; hostId: string | null; worktreePath: string | null}
interface CollectedView { workstreams: LiveWorkstreamView[]; dags: LiveDagView[]; worktreeSources: WorktreeSource[] }
interface DagSession {
  canonicalPath: string;
  reader: ReturnType<typeof createDagReader> | null;
  model: DagReadModel | null;
  summary: LiveSummaryView;
  store: ReturnType<typeof createSummaryStore> | null;
  cacheIdentity: string | null;
  cache: ReturnType<LiveRuntimeDependencies['summaryCache']> | null;
  cacheRetired: boolean;
}

/** Read-only, main-owned orchestration. Construction does no IO and starts no timers.
 * Adapter lifetimes survive disconnect/reconnect: a poisoned reader is never recreated.
 * Cache directories and files are never created or written by this runtime.
 */
export function createLiveRuntime(options: {
  configuration: LoadedLiveConfiguration;
  cacheRoot: string;
  cacheAvailable?: boolean;
  dependencies?: Partial<LiveRuntimeDependencies>;
}) {
  const loaded = structuredClone(options.configuration);
  const config = loaded.configuration;
  const deps = options.dependencies ?? {};
  const now = deps.clock?.now ?? Date.now;
  const mapNotes = deps.mapNotes ?? mapWorktreesToNotes;
  const makeCache: LiveRuntimeDependencies['summaryCache'] = deps.summaryCache ?? (cacheOptions=>{
    const cache=createLocalSummaryCache<SummaryCachePayload>(cacheOptions);
    return {async read(signal?:AbortSignal){await assertPrivateSummaryCachePath(options.cacheRoot,cacheOptions.directory,signal);return cache.read(signal);}};
  });
  const orca = config ? (deps.orca ?? createOrcaAdapter)({ executablePath: config.orcaExecutablePath }) : null;
  const codeburn = config?.codeburnExecutablePath
    ? (deps.codeburn ?? createCodeBurnReader)({ executablePath: config.codeburnExecutablePath }) : null;
  const dagSessions = new Map<string, DagSession>();
  const excerptReaders = new Map<string, { identity: string; reader: ReturnType<typeof createRegisteredExcerptReader>; retired: boolean }>();
  const codeburnLastGood = new Map<CodeBurnQuery, CodeBurnResult>();
  let codeburnResults: CodeBurnResult[] = [];
  let connected = false;
  let disposed = false;
  let mappingRetired = false;
  let activity = { visible: true, active: true };
  const listeners = new Set<(view: LiveWorkspaceView) => void>();

  async function readCodeburn(signal: AbortSignal): Promise<[CodeBurnQuery, CodeBurnResult][]> {
    if (!codeburn) return [];
    const results: [CodeBurnQuery, CodeBurnResult][] = [];
    // The reader rejects overlap. Quota errors never gate either usage query.
    for (const query of CODEBURN_QUERIES) {
      if (signal.aborted) break;
      let result: CodeBurnResult;
      try { result = await codeburn.read(query, { signal }); }
      catch { result = { ok: false, observedAt: now(), error: { kind: 'command-failed', query } }; }
      results.push([query, result]);
    }
    return results;
  }
  function acceptCodeburn(results: [CodeBurnQuery, CodeBurnResult][]): void {
    codeburnResults = [];
    for (const [query, result] of results) {
      if (result.ok) codeburnLastGood.set(query, structuredClone(result));
      else if (codeburnLastGood.has(query)) codeburnResults.push(codeburnLastGood.get(query)!);
      codeburnResults.push(result);
    }
  }

  async function readCache(session: DagSession, dagId: string, signal: AbortSignal): Promise<SummaryCacheRecord<SummaryCachePayload> | null> {
    if(options.cacheAvailable===false)throw new Error('App-owned cache is unavailable');
    if (session.cacheRetired || signal.aborted) throw new Error('Cache read unavailable');
    session.cache ??= makeCache({ directory: path.join(options.cacheRoot, contextScopeId(dagId)), codec: summaryCacheCodec });
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    // The adapter retains ownership of late filesystem IO and closes its own handles.
    // A bounded response is not kernel cancellation. Never reuse a retired cache.
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => controller.abort(), 5_000);
      const cleanup = () => { clearTimeout(timer); combined.removeEventListener('abort', abort); };
      const abort = () => {
        if (settled) return;
        settled = true; session.cacheRetired = true; cleanup(); reject(new Error('Cache response unavailable'));
      };
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) { abort(); return; }
      void Promise.resolve().then(() => {
        if (combined.aborted) throw new Error('Cache read cancelled');
        return session.cache!.read(combined);
      }).then(value => {
        if (settled) return;
        settled = true; cleanup(); resolve(value);
      }, error => {
        if (settled) return;
        settled = true; cleanup();
        reject(Object.assign(new Error('Cache read failed'), { code: error && typeof error === 'object' && 'code' in error ? error.code : undefined }));
      });
    });
  }
  async function readMapping(request: Parameters<typeof mapWorktreesToNotes>[0]): Promise<Awaited<ReturnType<typeof mapWorktreesToNotes>>> {
    if (mappingRetired) throw new Error('Mapping retired');
    try {
      const result = await mapNotes(request);
      // Timeout/cancellation can leave one owned kernel metadata call outstanding.
      // Keep this lifetime retired instead of accumulating a fresh call each poll.
      if (request.signal?.aborted || [...result.mappings, ...result.scopeIssues].some(issue =>
        'reason' in issue && (issue.reason === 'timeout' || issue.reason === 'aborted'))) mappingRetired = true;
      return result;
    } catch { mappingRetired = true; throw new Error('Mapping unavailable'); }
  }

  async function readRegistered(mapping: ResolvedNoteMapping | undefined, signal: AbortSignal): Promise<RegisteredExcerptContext | undefined> {
    if (!mapping || !config) throw new Error('Verified excerpt scope unavailable');
    const scope = config.noteScopes.find(s => s.scopeId === mapping.scopeId);
    if (!scope) throw new Error('Registered excerpt scope unavailable');
    const selections: typeof config.summarySelections = [];
    for (const selection of config.summarySelections.filter(s => s.scopeId === scope.scopeId && s.excerpts?.length)) {
      if (path.join(scope.scopePath, selection.dagRelativePath) === mapping.canonicalDagPath) { selections.push(selection); continue; }
      // Configured DAG/scope aliases need the mapper's exact selection resolution.
      // A sibling DAG outside this note is simply inapplicable; a failed applicable
      // registration must never silently become an empty excerpt selection.
      const verified = await readMapping({ localHostId: config.localHostId!, scopes: [scope], signal,
        worktrees: [{ worktreeId: mapping.worktreeId, hostId: mapping.hostId, worktreePath: mapping.canonicalWorktreePath, selectedDagRelativePath: selection.dagRelativePath }] });
      const resolved = verified.mappings[0];
      if (resolved?.state === 'resolved') {
        if (resolved.dagId === mapping.dagId && resolved.canonicalDagPath === mapping.canonicalDagPath) selections.push(selection);
      } else if (verified.scopeIssues.length || !resolved || !['dag-not-registered', 'dag-outside-note', 'invalid-dag-selection'].includes(resolved.reason)) {
        throw new Error('Configured excerpt selection could not be verified');
      }
    }
    const registrations = parseExcerptRegistrations(selections.flatMap(s => s.excerpts ?? []));
    if (!registrations.length) return undefined;
    const identity = JSON.stringify([mapping.dagId, scope.scopePath, mapping.canonicalNotePath, registrations]);
    let entry = excerptReaders.get(mapping.dagId);
    if (entry && entry.identity !== identity) throw new Error('Registered excerpt identity changed');
    if (!entry) {
      if (excerptReaders.size >= MAX_DAGS) throw new Error('Registered excerpt reader limit reached');
      entry = { identity, retired: false, reader: (deps.excerptReader ?? createRegisteredExcerptReader)({ dagId: mapping.dagId, canonicalScopePath: scope.scopePath, canonicalNotePath: mapping.canonicalNotePath, registrations, now }) };
      excerptReaders.set(mapping.dagId, entry);
    }
    if (entry.retired || signal.aborted) throw new Error('Registered excerpt reader retired');
    const owned = entry;
    const deadline = new AbortController(); const combined = AbortSignal.any([signal, deadline.signal]);
    return await new Promise<RegisteredExcerptContext>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => deadline.abort(), 5_000);
      const cleanup = () => { clearTimeout(timer); combined.removeEventListener('abort', abort); };
      const abort = () => { if (settled) return; settled = true; owned.retired = true; cleanup(); reject(new Error('Registered excerpt response unavailable')); };
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) { abort(); return; }
      void Promise.resolve().then(() => {
        if (combined.aborted) throw new Error('Registered excerpt read cancelled');
        return owned.reader.read(mapping.dagId, combined);
      }).then(value => { if (settled) return; settled = true; cleanup(); resolve(value); }, error => {
        if (settled) return; settled = true; cleanup();
        if (combined.aborted || (error && typeof error === 'object' && 'code' in error && ['timeout', 'cancelled', 'retired'].includes(String(error.code)))) owned.retired = true;
        reject(new Error('Registered excerpt read failed'));
      });
    });
  }

  async function readSummary(dag: DagReadModel, session: DagSession, taskIds: string[] | undefined, signal: AbortSignal, mapping: ResolvedNoteMapping | undefined): Promise<LiveSummaryView> {
    if (!taskIds) return session.store
      ? { ...session.summary, state: 'error', reason: 'The explicit summary selection could not be verified; retained claims are historical and current evidence is unavailable.' }
      : summaryUnavailable('No explicit summary task selection resolves to this canonical DAG.');
    if (taskIds.length > 32) return { ...session.summary, state: 'error', reason: 'The combined explicit selection exceeds the 32-task context limit; current evidence is unavailable.' };
    let context: LiveSummaryView['context'] = session.summary.context;
    try {
      const registeredExcerpts = await readRegistered(mapping, signal);
      const projected = extractProjectionContext({ schemaVersion: 1, dagId: dag.dagId, dag,
        requestedTaskIds: taskIds, excerpts: registeredExcerpts?.excerpts ?? [], previousSources: [], priorApprovedSummary: null, limits: CONTEXT_LIMITS }, registeredExcerpts);
      const pack = buildContextPack(projected.input);
      context = { selectedTaskCount: taskIds.length, recordCount: pack.records.length, bytes: pack.usage.bytes,
        truncated: pack.truncated, unknowns: [...pack.coverage.unknowns] };
      // A failed cache refresh must not prevent freshness checks on retained claims.
      session.store?.updateContext(pack);
      let cached: SummaryCacheRecord<SummaryCachePayload> | null;
      try { cached = await readCache(session, dag.dagId, signal); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && !session.store) cached = null;
        else throw error;
      }
      if (signal.aborted) return session.summary;
      if (cached) {
        if (cached.payload.state.packs.some(p => p.scopeId !== pack.scopeId)) throw new Error('Cache scope mismatch');
        const cacheIdentity = `${cached.revision}:${digest(JSON.stringify(cached.payload.state))}`;
        if (cacheIdentity !== session.cacheIdentity) {
          session.store = restoreSummaryStoreFromLocalCache(cached.payload.state, pack);
          session.cacheIdentity = cacheIdentity;
        }
        const snapshot = session.store!.snapshot();
        return { state: 'restored', reason: 'Historical local summary; claim freshness is compared with the explicit current task slice. Generation is unavailable.',
          revision: cached.revision, candidateClaims: [...snapshot.candidateClaims], approvedClaims: [...snapshot.approvedClaims],
          approvedAt: snapshot.approved?.approvedAt ?? null, context };
      }
      if (session.store) throw new Error('Previously observed cache is unavailable');
      return { ...summaryUnavailable('No existing local summary cache. Summary generation is unavailable.'), state: 'empty', context };
    } catch {
      const snapshot = session.store?.snapshot();
      return { ...session.summary, state: 'error', reason: 'Summary cache or bounded context could not be refreshed; any displayed claims are retained historical data.',
        candidateClaims: snapshot ? [...snapshot.candidateClaims] : session.summary.candidateClaims,
        approvedClaims: snapshot ? [...snapshot.approvedClaims] : session.summary.approvedClaims,
        approvedAt: snapshot?.approved?.approvedAt ?? session.summary.approvedAt, context };
    }
  }

  async function collectView(observation: OrcaObservation, signal: AbortSignal): Promise<CollectedView> {
    const worktrees: NoteWorktree[] = observation.joined.flatMap(({worktree: w}) => w.identity.hostId && w.path
      ? [{ worktreeId: w.id, hostId: w.identity.hostId, worktreePath: w.path }] : []);
    let mappings: NoteMapping[] = [];
    let canonicalDags: Awaited<ReturnType<typeof mapWorktreesToNotes>>['dags'] = [];
    let mappingFailure: string | null = !config?.localHostId ? 'Local host identity is not configured.'
      : mappingRetired ? 'Note mapping is retired after an unsettled or failed observation; restart is required.' : null;
    if (config?.localHostId && !signal.aborted && !mappingRetired) {
      try {
        const mapped = await readMapping({ localHostId: config.localHostId, worktrees, scopes: config.noteScopes, signal });
        mappings = mapped.mappings; canonicalDags = mapped.dags;
        if (mapped.status === 'invalid-request') mappingFailure = 'Note mapping request was rejected.';
      } catch { mappingFailure = 'Note mapping could not be refreshed.'; }
    }
    const byWorktree = new Map(mappings.map(m => [identity(m.hostId, m.worktreeId), m]));
    const workstreams: LiveWorkstreamView[] = observation.joined.map(({worktree: w, project, process, projectMapping}) => {
      const mapping = byWorktree.get(identity(w.identity.hostId, w.id));
      return { id: `worktree-${digest(JSON.stringify([observation.runtimeId, w.identity.hostId, w.identity.instanceId, w.id]))}`,
        title: w.displayName || w.branch || 'Unnamed worktree', projectName: project?.displayName ?? null,
        branch: w.branch, archived: w.isArchived, terminalConnected: process?.hasAttachedPty ?? null,
        terminalCount: process?.liveTerminalCount ?? null,
        agentState: process?.agents?.length && process.agents.every(a => a.state === 'done') ? 'done' : 'unknown',
        projectMapping, noteMapping: mapping?.state === 'resolved'
          ? { state: 'resolved', reason: null, dagId: mapping.dagId }
          : { state: 'unresolved', reason: mappingFailure ?? (mapping?.state === 'unresolved' ? mapping.reason : 'Worktree host identity or local path is unavailable.'), dagId: null } };
    });

    // Resolve explicit summary registrations using the same scope-checking mapper. No path
    // guessing, directory enumeration, excerpt reads, or selection inferred from Orca activity.
    const selections = new Map<string, string[]>();
    for (const selection of config?.summarySelections ?? []) {
      if (signal.aborted || !config?.localHostId || mappingRetired) break;
      const scope = config.noteScopes.find(s => s.scopeId === selection.scopeId);
      if (!scope || !scope.dagRelativePaths.includes(selection.dagRelativePath)) continue;
      const matching = mappings.filter(m => m.state === 'resolved' && m.scopeId === selection.scopeId);
      const representative = new Map<string, NoteMapping>();
      for (const mapped of matching) if (mapped.state === 'resolved' && !representative.has(mapped.dagId)) representative.set(mapped.dagId, mapped);
      const candidates = [...representative.values()].flatMap(mapped => {
        const worktree = worktrees.find(w => w.hostId === mapped.hostId && w.worktreeId === mapped.worktreeId);
        return worktree ? [{ ...worktree, selectedDagRelativePath: selection.dagRelativePath }] : [];
      });
      if (!candidates.length) continue;
      try {
        const selected = await readMapping({ localHostId: config.localHostId, scopes: [scope], worktrees: candidates, signal });
        for (const resolved of selected.mappings) {
          const original = byWorktree.get(identity(resolved.hostId, resolved.worktreeId));
          if (resolved.state === 'resolved' && original?.state === 'resolved' && resolved.dagId === original.dagId) {
            selections.set(resolved.dagId, [...new Set([...(selections.get(resolved.dagId) ?? []), ...selection.taskIds])].sort());
          }
        }
      } catch { /* The summary stays unavailable rather than borrowing another DAG. */ }
    }
    if (mappingRetired) selections.clear();
    const dags: LiveDagView[] = [];
    // The config bounds registrations too. Retained sessions never exceed eight over this
    // runtime's lifetime, so changing aliases cannot accumulate retired kernel IO/readers.
    for (const mapping of canonicalDags.slice(0, MAX_DAGS)) {
      if (signal.aborted) break;
      let session = dagSessions.get(mapping.dagId);
      let reason: string | null = !config?.dagQuery ? 'A trusted DAG query executable is not configured.' : null;
      if (!session && !reason) {
        if (dagSessions.size >= MAX_DAGS) reason = 'The lifetime DAG registration limit was reached; no additional reader was created.';
        else {
          session = { canonicalPath: mapping.canonicalDagPath, reader: null, model: null,
            summary: summaryUnavailable('No successful DAG observation.'), store: null, cacheIdentity: null, cache: null, cacheRetired: false };
          dagSessions.set(mapping.dagId, session);
          try { session.reader = (deps.dagReader ?? createDagReader)({ ...config!.dagQuery!, registrations: [{ dagId: mapping.dagId, canonicalDagPath: mapping.canonicalDagPath }] }); }
          catch { /* Retain the failed session; never silently recreate it. */ }
        }
      }
      if (session && session.canonicalPath !== mapping.canonicalDagPath) reason = 'Canonical DAG identity changed unexpectedly.';
      let unchanged = false;
      let state: LiveDagView['state'] = reason ? 'unavailable' : 'error';
      if (!reason && session?.reader) {
        try {
          const result = await session.reader.read(mapping.dagId, { signal });
          if (result.ok && !signal.aborted) { session.model = result.value; unchanged = result.unchanged; state = 'ready'; }
          else if (!result.ok) reason = `DAG observation could not be refreshed (${result.error.kind}).`;
        } catch { reason = 'DAG observation could not be refreshed.'; }
      } else if (!reason) reason = 'DAG reader could not be initialized.';
      if (session?.model && state === 'ready' && !signal.aborted) session.summary = await readSummary(session.model, session, selections.get(mapping.dagId), signal, mappings.find((m): m is ResolvedNoteMapping => m.state === 'resolved' && m.dagId === mapping.dagId));
      const model = session?.model;
      dags.push({ dagId: mapping.dagId, state, reason, observedAt: model?.observedAt ?? null, unchanged,
        taskCount: model?.coverage.tasksTotal ?? null, displayedTaskCount: Math.min(model?.tasks.length ?? 0, MAX_DISPLAY_TASKS),
        tasks: model?.tasks.slice(0, MAX_DISPLAY_TASKS).map(task => ({ ...task,
          dependencies: task.dependencies.slice(0, MAX_DISPLAY_REFERENCES),
          commitReferences: task.commitReferences.slice(0, MAX_DISPLAY_REFERENCES),
          e2e: { ...task.e2e, coveredBy: task.e2e.coveredBy?.slice(0, MAX_DISPLAY_REFERENCES) ?? null },
          displayOmissions: { dependencies: Math.max(0, task.dependencies.length - MAX_DISPLAY_REFERENCES),
            commitReferences: Math.max(0, task.commitReferences.length - MAX_DISPLAY_REFERENCES),
            e2eReferences: Math.max(0, (task.e2e.coveredBy?.length ?? 0) - MAX_DISPLAY_REFERENCES) },
        })) ?? [], statusCounts: model?.statusCounts.slice(0, MAX_DISPLAY_STATUSES) ?? [],
        statusCountTotal: model?.statusCounts.length ?? null,
        statusCountsOmitted: Math.max(0, (model?.statusCounts.length ?? 0) - MAX_DISPLAY_STATUSES),
        summary: session?.summary ?? summaryUnavailable(reason ?? 'No successful DAG observation.') });
    }
    if (canonicalDags.length > MAX_DAGS) throw new Error('DAG registration limit exceeded');
    // A mapping failure does not erase previously observed DAGs or claim successful emptiness.
    const previous = store.getState().value;
    if (mappingFailure || mappings.some(m => m.state === 'unresolved')) {
      let omittedHistorical = 0;
      for (const prior of previous?.dags ?? []) if (dagSessions.has(prior.dagId) && !dags.some(d => d.dagId === prior.dagId)) {
        if (dags.length >= MAX_DAGS) { omittedHistorical++; continue; }
        dags.push({ ...structuredClone(prior) as LiveDagView, state: 'unavailable', unchanged: false,
          reason: 'The previous DAG mapping is unavailable; retained data is historical.' });
      }
      if (omittedHistorical && dags[0]) dags[0].reason = [dags[0].reason,
        'Some historical DAGs are omitted at the eight-DAG display limit.'].filter(Boolean).join(' ');
    }
    const worktreeSources=observation.joined.map(({worktree:w},index)=>({id:workstreams[index].id,worktreeId:w.id,hostId:w.identity.hostId,worktreePath:w.path}));
    return { workstreams, dags, worktreeSources };
  }

  const store = createSnapshotStore<CollectedView, LiveWorkspaceView['coverage'], {kind: string; message: string}>({
    clock: deps.clock, intervalMs: INTERVAL_MS, staleAfterMs: STALE_MS, active: false, visible: true,
    async load({signal}) {
      const budgets = readCodeburn(signal);
      let result;
      try { result = await orca!.collect({signal}); }
      catch { result = { ok: false as const, error: { kind: 'load_failed', message: 'Orca observation could not be refreshed.' } }; }
      let value: CollectedView | null = null;
      let projectionFailed = false;
      if (result.ok && !signal.aborted) {
        try { value = await collectView(result.value, signal); } catch { projectionFailed = true; }
      }
      const costResults = await budgets;
      if (!signal.aborted && !disposed) acceptCodeburn(costResults);
      if (!result.ok) return {kind: 'failure', error: { kind: result.error.kind, message: `Orca observation could not be refreshed (${result.error.kind}).` }};
      if (projectionFailed || !value) return {kind: 'failure', error: {kind: 'projection_failed', message: 'The live read-only projection could not be refreshed.'}};
      const observation = result.value;
      return {kind: 'success', value, runtimeId: observation.runtimeId, observedAt: observation.observedAt,
        coverage: { projects: observation.projects.coverage.state, worktrees: observation.worktrees.coverage.state,
          processes: observation.processes.coverage.state, totalWorktrees: observation.worktrees.coverage.totalCount }};
    },
  });

  function getState(): LiveWorkspaceView {
    const snapshot = store.getState();
    const freshness = !connected && snapshot.observedAt ? 'stale' : snapshot.freshness;
    const value = structuredClone(snapshot.value) as CollectedView | null;
    const dags = value?.dags ?? [];
    for (const dag of dags) {
      const sourceUnavailable = dag.state !== 'ready' || dag.summary.state === 'error';
      const aged = freshness !== 'current' || !dag.observedAt || now() - Date.parse(dag.observedAt) >= STALE_MS;
      if (sourceUnavailable || aged) {
        const historical = (claims: ClaimView[]): ClaimView[] => claims.map(claim => ({ ...claim,
          freshness: claim.freshness === 'unknown' ? 'unknown' : sourceUnavailable ? 'unknown' : 'stale',
          reasons: [...claim.reasons, sourceUnavailable ? 'observation:unavailable' : 'observation:stale'] }));
        dag.summary.candidateClaims = historical(dag.summary.candidateClaims);
        dag.summary.approvedClaims = historical(dag.summary.approvedClaims);
      }
    }
    return structuredClone({ mode: 'live-read-only', connection: connected ? 'connected' : 'disconnected', configuration: loaded.view,
      refreshing: connected && snapshot.refreshing, observedAt: snapshot.observedAt, freshness,
      lastError: snapshot.lastAttempt?.error?.message ?? null, coverage: snapshot.coverage,
      workstreams: value?.workstreams ?? [], dags, codeburn: {state: codeburn ? codeburnResults.length ? 'observed' : 'idle' : 'unconfigured', results: codeburnResults} });
  }
  const publish = () => {
    if (disposed) return;
    for (const listener of [...listeners]) { try { listener(getState()); } catch { /* Isolate renderer consumers. */ } }
  };
  const unsubscribe = store.subscribe(publish);
  return {
    getState,
    /** Main-only authority resolution. These raw paths/models never cross the live view IPC. */
    async resolveSummarySource(workstreamId: string, signal: AbortSignal = new AbortController().signal) {
      const snapshot=store.getState();
      if(disposed || !connected || snapshot.refreshing || signal.aborted || snapshot.freshness!=='current' || !snapshot.value || !config?.localHostId) throw new Error('Current source unavailable');
      const workstream=snapshot.value.workstreams.find(w=>w.id===workstreamId);
      const mapping=workstream?.noteMapping;
      const dagView=mapping?.dagId?snapshot.value.dags.find(d=>d.dagId===mapping.dagId):undefined;
      const session=mapping?.dagId?dagSessions.get(mapping.dagId):undefined;
      if(mapping?.state!=='resolved'||dagView?.state!=='ready'||!session?.model || now()-Date.parse(session.model.observedAt)>=STALE_MS) throw new Error('Current DAG unavailable');
      const source=snapshot.value.worktreeSources.find(w=>w.id===workstreamId);
      if(!source?.hostId||source.hostId!==config.localHostId||!source.worktreePath||!session.reader)throw new Error('Current mapping unavailable');
      const verified=await readMapping({localHostId:config.localHostId,scopes:config.noteScopes,
        worktrees:[{worktreeId:source.worktreeId,hostId:source.hostId,worktreePath:source.worktreePath}],signal});
      const currentMapping=verified.mappings[0];
      if(signal.aborted||currentMapping?.state!=='resolved'||currentMapping.dagId!==mapping.dagId||currentMapping.canonicalDagPath!==session.canonicalPath)throw new Error('Source mapping changed');
      const currentDag=await session.reader.read(mapping.dagId!,{signal});
      if(!currentDag.ok||signal.aborted)throw new Error('Current DAG could not be verified');
      const registeredExcerpts=await readRegistered(currentMapping,signal);
      const after=store.getState();
      if(disposed||!connected||after.refreshing||after.freshness!=='current'||after.runtimeId!==snapshot.runtimeId||after.revision!==snapshot.revision)throw new Error('Source changed during validation');
      session.model=currentDag.value;
      return {dag:structuredClone(currentDag.value),mappingIdentity:JSON.stringify([snapshot.runtimeId,workstreamId,mapping.dagId,session.canonicalPath]),codeburn:structuredClone(codeburnResults),...(registeredExcerpts?{registeredExcerpts}:{})};
    },
    resolveNoteSelection(worktreeId: string, scopeId: string) {
      const snapshot=store.getState();
      if(disposed || !connected || snapshot.freshness!=='current' || !snapshot.value || !config?.localHostId) return null;
      const source=snapshot.value.worktreeSources.find(w=>w.id===worktreeId);
      const scope=config.noteScopes.find(s=>s.scopeId===scopeId);
      if(!source?.hostId||!source.worktreePath||!scope||source.hostId!==config.localHostId||scope.hostId!==source.hostId) return null;
      return {localHostId:config.localHostId,
        worktree:{worktreeId,hostId:source.hostId,worktreePath:source.worktreePath},scope:structuredClone(scope),
        knownWorktrees:snapshot.value.worktreeSources.filter(w=>w.hostId===config.localHostId&&w.worktreePath).map(w=>({worktreeId:w.id,worktreePath:w.worktreePath!}))};
    },
    async connect(): Promise<LiveWorkspaceView> {
      if (disposed || !config || loaded.view.state !== 'ready') return getState();
      connected = true;
      store.setActivity(activity);
      await store.start();
      return getState();
    },
    async refresh(): Promise<LiveWorkspaceView> {
      if (!disposed && connected) await store.refresh();
      return getState();
    },
    async disconnect(): Promise<LiveWorkspaceView> {
      connected = false;
      store.setActivity({active: false, visible: activity.visible});
      store.cancel();
      publish();
      return getState();
    },
    setActivity(next: {visible: boolean; active: boolean}): void {
      activity = {...next};
      if (!disposed) store.setActivity({visible: activity.visible, active: connected && activity.active});
    },
    subscribe(listener: (view: LiveWorkspaceView) => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose(): void {
      if (disposed) return;
      connected = false; disposed = true;
      unsubscribe(); store.dispose(); listeners.clear();
    },
  };
}
