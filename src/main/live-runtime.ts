import type {createReadRoots} from './read-roots';
import {parseWikiTarget,resolveWikiUri} from './projects/wikilinks';
import {projectId,lifecycleView,type ProjectRegistry,type RegisteredProject} from './projects/registry';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createOrcaAdapter, type OrcaObservation } from '../collector/orca';
import { mapWorktreesToNotes, type NoteMapping, type NoteWorktree, type ResolvedNoteMapping } from '../collector/notes';
import { createSnapshotStore, type SnapshotClock } from '../collector/snapshot';
import { createDagReader, type DagReadModel } from '../facts/dag-read-model';
import { createCodeBurnReader, type CodeBurnQuery, type CodeBurnResult } from '../summary/budget/codeburn';
import { createSummaryStore, restoreSummaryStoreFromLocalCache, type ClaimView } from '../summary/claims';
import {observeProjectDocuments,type ProjectDocumentObservation} from '../summary/reading/documents';
import { createReadingScheduler } from '../summary/reading';
import type { PullObservationAdapter } from '../summary/reading/pulls';
import { createPublicGitHubObserver } from '../summary/reading/github';
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
  /** Internal observation seam only; no production GitHub transport is configured. */
  pullObservations: PullObservationAdapter;
  publicGitHubObserver: typeof createPublicGitHubObserver;
}
interface WorktreeSource {id: string; worktreeId: string; hostId: string | null; worktreePath: string | null; present?:boolean}
interface CurrentWorktree {worktreeId:string;hostId:string|null;path:string|null;archived:boolean|null;repository:NonNullable<LiveWorkstreamView['repository']>;observation:NonNullable<LiveWorkstreamView['observation']>}
interface CollectedView { workstreams: LiveWorkstreamView[]; dags: LiveDagView[]; worktreeSources: WorktreeSource[];currentWorktrees:CurrentWorktree[] }
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
  projectRegistry?:ProjectRegistry;
  readRoots?:Pick<ReturnType<typeof createReadRoots>,'filterScopes'|'scopesFor'>;
}) {
  const registry=options.projectRegistry;
  let registryError:string|null=null;
  const retainedAllowed=(p:RegisteredProject)=>config?.localHostId===p.hostId&&noteScopes.some(scope=>scope.scopeId===p.scopeId&&scope.hostId===p.hostId&&scope.dagRelativePaths.includes(path.relative(scope.scopePath,p.canonicalDagPath))&&p.canonicalDagPath.startsWith(p.canonicalNotePath+path.sep));
  const loaded = structuredClone(options.configuration);
  const config = loaded.configuration;
  let noteScopes=config?.noteScopes??[];
  const deps = options.dependencies ?? {};
  const now = deps.clock?.now ?? Date.now;
  const connectionChoices=new Map<string,{workstreamId:string;hostId:string;worktreePath:string;scopeId:string;dagRelativePath:string;canonicalDagPath:string}>();
  const documentLinks=new Map<string,{workstreamId:string;wikilink:string;canonicalNotePath:string;vaultRootPath:string}>();
  const connectionConfirmations=new Set<AbortController>();
  const publicSelections=new Map<string,{dagId:string;branch:string;worktreePath:string}>();
  const publicObservers=new Map<string,PullObservationAdapter>();
  const publicAdapter:PullObservationAdapter|undefined=config?.publicGitHub?.length?{
    read(selection,signal,intent){
      const registration=publicSelections.get(selection.workstreamId);
      if(!registration||registration.dagId!==selection.dagId)throw new Error('Public repository scope unavailable');
      let observer=publicObservers.get(registration.worktreePath);
      if(!observer){if(publicObservers.size>=8)throw new Error('Public observer lifetime limit');observer=(deps.publicGitHubObserver??createPublicGitHubObserver)({registrations:[{dagId:registration.dagId,branch:registration.branch}],now});publicObservers.set(registration.worktreePath,observer);}
      return observer.read(selection,signal,intent);
    },
  }:undefined;
  const reading = createReadingScheduler({now, adapter: deps.pullObservations??publicAdapter});
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
  const documentReaders=new Map<string,{identity:string;retired:boolean;reader:ReturnType<typeof createRegisteredExcerptReader>}>();
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
      const allowedScopes=options.readRoots?await options.readRoots.filterScopes(request.scopes,request.signal):request.scopes;
      const scopedRequest={...request,scopes:allowedScopes,...(registry?{requireNoteSymlink:true}:{}),worktrees:request.worktrees.map(worktree=>{
        const registration=config?.publicGitHub?.find(r=>r.worktreePath===worktree.worktreePath&&request.scopes.some(s=>s.scopeId===r.scopeId));
        if(!registration||worktree.hostId!==request.localHostId||(worktree.selectedDagRelativePath&&worktree.selectedDagRelativePath!==registration.dagRelativePath)){const choice=registry?.connections().find(c=>c.hostId===worktree.hostId&&c.worktreePath===worktree.worktreePath&&request.scopes.some(s=>s.scopeId===c.scopeId));return choice&&!worktree.selectedDagRelativePath?{...worktree,selectedScopeId:choice.scopeId,selectedDagRelativePath:choice.dagRelativePath}:worktree;}
        return {...worktree,registeredScopeId:registration.scopeId,selectedDagRelativePath:registration.dagRelativePath};
      })};
      const result = await mapNotes(scopedRequest);
      // Timeout/cancellation can leave one owned kernel metadata call outstanding.
      // Keep this lifetime retired instead of accumulating a fresh call each poll.
      if (request.signal?.aborted || [...result.mappings, ...result.scopeIssues].some(issue =>
        'reason' in issue && (issue.reason === 'timeout' || issue.reason === 'aborted'))) mappingRetired = true;
      return result;
    } catch { mappingRetired = true; throw new Error('Mapping unavailable'); }
  }

  async function readBoundedExcerpts(owned:{retired:boolean;reader:ReturnType<typeof createRegisteredExcerptReader>},dagId:string,signal:AbortSignal):Promise<RegisteredExcerptContext> {
    if (owned.retired || signal.aborted) throw new Error('Registered excerpt reader retired');
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
        return owned.reader.read(dagId, combined);
      }).then(value => { if (settled) return; settled = true; cleanup(); resolve(value); }, error => {
        if (settled) return; settled = true; cleanup();
        if (combined.aborted || (error && typeof error === 'object' && 'code' in error && ['timeout', 'cancelled', 'retired'].includes(String(error.code)))) owned.retired = true;
        reject(new Error('Registered excerpt read failed'));
      });
    });
  }

  async function readProjectDocuments(workstream:LiveWorkstreamView,source:WorktreeSource|undefined,dag:LiveDagView|undefined,signal:AbortSignal):Promise<ProjectDocumentObservation> {
    const registration=config?.readingDocuments?.find(d=>d.worktreePath===source?.worktreePath);
    if(!registration)return {state:'unconfigured'};
    const scope=noteScopes.find(s=>s.scopeId===registration.scopeId);
    if(!source||source.hostId!==config!.localHostId||workstream.noteMapping.state!=='resolved'||workstream.noteMapping.dagId!==dag?.dagId||dag?.state!=='ready'||!scope)return {state:'unavailable'};
    try {
      const verified=await readMapping({localHostId:config!.localHostId!,scopes:[scope],signal,worktrees:[{worktreeId:source.worktreeId,hostId:source.hostId,worktreePath:source.worktreePath!,selectedDagRelativePath:registration.dagRelativePath}]});
      const mapping=verified.mappings[0];
      if(mapping?.state!=='resolved'||mapping.scopeId!==registration.scopeId||mapping.dagId!==dag.dagId||mapping.canonicalWorktreePath!==registration.worktreePath)throw new Error('Document scope unavailable');
      const key=JSON.stringify([registration.worktreePath,dag.dagId]);
      const identity=JSON.stringify(registration);
      let entry=documentReaders.get(key);
      if(entry&&entry.identity!==identity)throw new Error('Document identity changed');
      if(!entry){if(documentReaders.size>=8)throw new Error('Document lifetime limit');entry={identity,retired:false,reader:(deps.excerptReader??createRegisteredExcerptReader)({dagId:dag.dagId,canonicalScopePath:registration.worktreePath,canonicalNotePath:registration.worktreePath,registrations:registration.excerpts,now})};documentReaders.set(key,entry);}
      const context=await readBoundedExcerpts(entry,dag.dagId,signal);
      if(signal.aborted||disposed)throw new Error('Document read cancelled');
      const documents=observeProjectDocuments(context,dag.dagId);
      if(documents.state==='ready'){
        workstream.documentLinks=[];
        for(const record of documents.records)for(const link of record.links??[]){if(workstream.documentLinks.length>=12)break;const target=parseWikiTarget(link.wikilink),id=digest(JSON.stringify([workstream.id,record.source.sourceHash,link]));documentLinks.set(id,{workstreamId:workstream.id,wikilink:link.wikilink,canonicalNotePath:mapping.canonicalNotePath,vaultRootPath:scope.vaultRootPath});workstream.documentLinks.push({id,role:link.role,label:target.label});}
      }
      return documents;
    }catch{return {state:'unavailable'};}
  }

  async function readRegistered(mapping: ResolvedNoteMapping | undefined, signal: AbortSignal): Promise<RegisteredExcerptContext | undefined> {
    if (!mapping || !config) throw new Error('Verified excerpt scope unavailable');
    const scope = noteScopes.find(s => s.scopeId === mapping.scopeId);
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
    return readBoundedExcerpts(entry,mapping.dagId,signal);
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

  async function collectView(observation: OrcaObservation, signal: AbortSignal,manual=false): Promise<CollectedView> {
    const currentWorktrees:CurrentWorktree[]=observation.joined.map(({worktree:w,project,process})=>{
      const bound=!!w.repoId&&project?.sourceRepoIds?.includes(w.repoId)===true;
      const provider=bound?project?.providerIdentity:undefined;
      return {worktreeId:w.id,hostId:w.identity.hostId,path:w.path,archived:w.isArchived,
        repository:{key:JSON.stringify([w.identity.hostId,w.repoId]),id:w.repoId,hostId:w.identity.hostId,projectId:bound?project?.id??null:null,label:provider?`${provider.owner}/${provider.repo}`:bound?project?.displayName??'저장소 이름 미확인':w.repoId??'저장소 미확인'},
        observation:{worktree:'observed',sidebarActivity:process?.hasHostSidebarActivity??null,selected:process?.isActive??null,workspaceStatus:w.workspaceStatus??'unknown'}};
    });
    const currentByWorktree=new Map(currentWorktrees.map(row=>[identity(row.hostId,row.worktreeId),row]));
    const skipped=new Set(!manual?(registry?.records().filter(p=>p.status==='completed').flatMap(p=>p.worktrees.map(w=>JSON.stringify([p.hostId,w.path])))??[]):[]);
    const observedRows=observation.joined.filter(({worktree:w})=>!skipped.has(JSON.stringify([w.identity.hostId,w.path])));
    const worktrees: NoteWorktree[] = observedRows.flatMap(({worktree: w}) => w.identity.hostId && w.path
      ? [{ worktreeId: w.id, hostId: w.identity.hostId, worktreePath: w.path }] : []);
    if(options.readRoots&&!mappingRetired){
      const deadline=new AbortController();const combined=AbortSignal.any([signal,deadline.signal]);let timer:ReturnType<typeof setTimeout>|undefined;
      try{noteScopes=await Promise.race([options.readRoots.scopesFor(worktrees,registry?.records().map(p=>({scopeId:p.scopeId,hostId:p.hostId,scopePath:p.canonicalNotePath,vaultRootPath:path.dirname(p.canonicalNotePath),dagRelativePaths:[path.relative(p.canonicalNotePath,p.canonicalDagPath)]}))??[],combined),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{deadline.abort();reject(Error('Read scope deadline'));},5000);})]);}
      catch{mappingRetired=true;noteScopes=[];}finally{if(timer)clearTimeout(timer);}
    }
    let mappings: NoteMapping[] = [];
    let canonicalDags: Awaited<ReturnType<typeof mapWorktreesToNotes>>['dags'] = [];
    let mappingFailure: string | null = !config?.localHostId ? 'Local host identity is not configured.'
      : mappingRetired ? 'Note mapping is retired after an unsettled or failed observation; restart is required.' : null;
    if (config?.localHostId && !signal.aborted && !mappingRetired) {
      try {
        const mapped = await readMapping({ localHostId: config.localHostId, worktrees, scopes: noteScopes, signal });
        mappings = mapped.mappings; canonicalDags = mapped.dags;
        if (mapped.status === 'invalid-request') mappingFailure = 'Note mapping request was rejected.';
      } catch { mappingFailure = 'Note mapping could not be refreshed.'; }
    }
    if(registry){await registry.discover(mappings.filter((m):m is ResolvedNoteMapping=>m.state==='resolved'),signal);
      for(const p of registry.records().filter(p=>(p.status==='active'||manual)&&retainedAllowed(p)))if(!canonicalDags.some(d=>d.dagId===p.dagId))canonicalDags.push({dagId:p.dagId,hostId:p.hostId,canonicalDagPath:p.canonicalDagPath,worktreeIds:[]});
    }
    const byWorktree = new Map(mappings.map(m => [identity(m.hostId, m.worktreeId), m]));
    const workstreams: LiveWorkstreamView[] = observedRows.map(({worktree: w, project, process, projectMapping}) => {
      const mapping = byWorktree.get(identity(w.identity.hostId, w.id));
      return { id: registry&&mapping?.state==='resolved'?projectId(mapping.hostId,mapping.dagId):`worktree-${digest(JSON.stringify([observation.runtimeId, w.identity.hostId, w.identity.instanceId, w.id]))}`,
        title: w.displayName || w.branch || 'Unnamed worktree', projectName: project?.displayName ?? null,
        repository:currentByWorktree.get(identity(w.identity.hostId,w.id))?.repository,
        observation:currentByWorktree.get(identity(w.identity.hostId,w.id))?.observation,
        branch: w.branch, archived: w.isArchived, terminalConnected: process?.hasAttachedPty ?? null,
        terminalCount: process?.liveTerminalCount ?? null,
        agentState: process?.agents?.length && process.agents.every(a => a.state === 'done') ? 'done' : 'unknown',
        projectMapping, noteMapping: mapping?.state === 'resolved'
          ? { state: 'resolved', reason: null, dagId: mapping.dagId,...(mapping.registration?{registration:mapping.registration}:{}) }
          : { state: 'unresolved', reason: mappingFailure ?? (mapping?.state === 'unresolved' ? mapping.reason : 'Worktree host identity or local path is unavailable.'), dagId: null } };
    });
    connectionChoices.clear();documentLinks.clear();
    if(registry){let checks=0;for(let index=0;index<observedRows.length;index++) {
      const view=workstreams[index],row=observedRows[index].worktree;
      if(view.noteMapping.state!=='unresolved'||!['ambiguous-scope','ambiguous-dag'].includes(view.noteMapping.reason??'')||!row.path||row.identity.hostId!==config?.localHostId)continue;
      view.connectionOptions=[];
      for(const scope of noteScopes)for(const dagRelativePath of scope.dagRelativePaths){if(checks++>=8||signal.aborted)break;
        const candidate=await readMapping({localHostId:config.localHostId!,scopes:[scope],signal,worktrees:[{worktreeId:row.id,hostId:row.identity.hostId!,worktreePath:row.path,selectedScopeId:scope.scopeId,selectedDagRelativePath:dagRelativePath}]});
        const resolved=candidate.mappings[0];if(resolved?.state!=='resolved')continue;
        const id=digest(JSON.stringify([view.id,scope.scopeId,dagRelativePath,resolved.canonicalDagPath]));connectionChoices.set(id,{workstreamId:view.id,hostId:row.identity.hostId!,worktreePath:row.path,scopeId:scope.scopeId,dagRelativePath,canonicalDagPath:resolved.canonicalDagPath});view.connectionOptions.push({id,label:`${scope.scopeId} · ${dagRelativePath}`});
      }
    }}
    publicSelections.clear();
    observedRows.forEach(({worktree:w},index)=>{
      const mapping=byWorktree.get(identity(w.identity.hostId,w.id));
      const registered=config?.publicGitHub?.find(r=>r.worktreePath===w.path);
      if(mapping?.state==='resolved'&&mapping.registration==='explicit-read-only'&&registered&&mapping.scopeId===registered.scopeId&&mapping.canonicalWorktreePath===registered.worktreePath) {
        publicSelections.set(workstreams[index].id,{dagId:mapping.dagId,branch:registered.branch,worktreePath:registered.worktreePath});
      }
    });

    // Resolve explicit summary registrations using the same scope-checking mapper. No path
    // guessing, directory enumeration, excerpt reads, or selection inferred from Orca activity.
    const selections = new Map<string, string[]>();
    for (const selection of config?.summarySelections ?? []) {
      if (signal.aborted || !config?.localHostId || mappingRetired) break;
      const scope = noteScopes.find(s => s.scopeId === selection.scopeId);
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
      dags.push({ dagId: mapping.dagId, sourceHash: model?.sourceHash ?? null, doneStatus: model?.doneStatus ?? null, state, reason, observedAt: model?.observedAt ?? null, unchanged,
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
    const worktreeSources:WorktreeSource[]=observedRows.map(({worktree:w},index)=>({id:workstreams[index].id,worktreeId:w.id,hostId:w.identity.hostId,worktreePath:w.path}));
    if(registry){
      for(const p of registry.records().filter(p=>(p.status==='active'||manual)&&retainedAllowed(p)))if(!workstreams.some(w=>w.id===p.id)&&p.observation){
        const retained=structuredClone(p.observation.workstream),dag=dags.find(d=>d.dagId===p.dagId);retained.archived=false;retained.terminalConnected=null;retained.terminalCount=null;retained.agentState='unknown';retained.projectMapping='retained';
        retained.noteMapping={state:dag?.state==='ready'?'resolved':'unresolved',reason:dag?.state==='ready'?null:'등록된 소스 접근 불가',dagId:p.dagId};delete retained.readingSummary;delete retained.documentLinks;
        workstreams.push(retained);const tree=p.worktrees[0];if(tree)worktreeSources.push({id:p.id,worktreeId:tree.id,hostId:p.hostId,worktreePath:tree.path,present:false});
        const registered=config?.publicGitHub?.find(r=>r.scopeId===p.scopeId&&p.worktrees.some(w=>w.path===r.worktreePath));if(registered)publicSelections.set(p.id,{dagId:p.dagId,branch:registered.branch,worktreePath:registered.worktreePath});
      }
      const unique=new Map<string,LiveWorkstreamView>();for(const w of workstreams){const prior=unique.get(w.id);if(!prior)unique.set(w.id,w);else{prior.terminalCount=prior.terminalCount===null||w.terminalCount===null?null:prior.terminalCount+w.terminalCount;prior.terminalConnected=prior.terminalConnected===true||w.terminalConnected===true?true:prior.terminalConnected===null||w.terminalConnected===null?null:false;prior.agentState=prior.agentState==='done'&&w.agentState==='done'?'done':'unknown';}}
      return {workstreams:[...unique.values()].filter(w=>manual||!registry.records().some(p=>p.id===w.id&&p.status==='completed')),dags,worktreeSources:[...new Map(worktreeSources.map(w=>[w.id,w])).values()],currentWorktrees};
    }
    return { workstreams, dags, worktreeSources,currentWorktrees };
  }

  const store = createSnapshotStore<CollectedView, LiveWorkspaceView['coverage'], {kind: string; message: string}>({
    clock: deps.clock, intervalMs: INTERVAL_MS, staleAfterMs: STALE_MS, active: false, visible: true,
    backgroundIntervalMs: 300_000, resumeDelayMs: 5_000,
    async load({signal,reason}) {
      const budgets = readCodeburn(signal);
      let result;
      try { result = await orca!.collect({signal}); }
      catch { result = { ok: false as const, error: { kind: 'load_failed', message: 'Orca observation could not be refreshed.' } }; }
      let value: CollectedView | null = null;
      let projectionFailed = false;
      if (result.ok && !signal.aborted) {
        try { value = await collectView(result.value, signal,reason==='manual'); } catch { projectionFailed = true; }
      }
      const costResults = await budgets;
      if (!signal.aborted && !disposed) acceptCodeburn(costResults);
      if (!result.ok) return {kind: 'failure', error: { kind: result.error.kind, message: `Orca observation could not be refreshed (${result.error.kind}).` }};
      if (projectionFailed || !value) return {kind: 'failure', error: {kind: 'projection_failed', message: 'The live read-only projection could not be refreshed.'}};
      const inputs=[];
      for(const workstream of value.workstreams.filter(w=>w.archived!==true)) {
        const dag=value.dags.find(d=>d.dagId===workstream.noteMapping.dagId);
        const documents=await readProjectDocuments(workstream,value.worktreeSources.find(s=>s.id===workstream.id),dag,signal);
        inputs.push({workstream,dag,documents});
      }
      const summaries = await reading.update(inputs, signal, reason==='manual'?'manual':'scheduled',registry?.records().filter(p=>p.status==='completed').map(p=>p.id)??[]);
      for (const summary of summaries) value.workstreams.find(w => w.id === summary.workstreamId)!.readingSummary = summary;
      if(registry){await registry.capture(value.workstreams,value.dags,reason==='manual',signal);registryError=null;}
      const observation = result.value;
      return {kind: 'success', value, runtimeId: observation.runtimeId, observedAt: observation.observedAt,
        coverage: { projects: observation.projects.coverage.state, worktrees: observation.worktrees.coverage.state,
          processes: observation.processes.coverage.state, totalWorktrees: observation.worktrees.coverage.totalCount }};
    },
  });

  function getState(): LiveWorkspaceView {
    const snapshot = store.getState();
    const freshness = !connected && snapshot.observedAt ? 'stale' : snapshot.freshness;
    let value = structuredClone(snapshot.value) as CollectedView | null;
    const dags = value?.dags ?? [];
    if(registry){
      const records=registry.records();
      if(!value)value={workstreams:[],dags,worktreeSources:[],currentWorktrees:[]};
      for(const p of records){let view=value.workstreams.find(w=>w.id===p.id);const observedView=!!view;if(p.status==='completed'||!view){if(!p.observation)continue;view=structuredClone(p.observation.workstream);value.workstreams=value.workstreams.filter(w=>w.id!==p.id);value.workstreams.push(view);if(!dags.some(d=>d.dagId===p.dagId)&&p.observation.dag)dags.push(structuredClone(p.observation.dag));}
        const current=value.currentWorktrees.filter(w=>w.hostId===p.hostId&&p.worktrees.some(tree=>tree.path===w.path));
        const present=current.length>0;
        const mergeBool=(values:(boolean|null)[])=>values.some(v=>v===true)?true:values.length&&values.every(v=>v===false)?false:null;
        const statuses=new Set(current.map(w=>w.observation.workspaceStatus));
        view.observation={worktree:present?'observed':snapshot.observedAt?'not-observed':'unknown',sidebarActivity:mergeBool(current.map(w=>w.observation.sidebarActivity)),selected:mergeBool(current.map(w=>w.observation.selected)),workspaceStatus:statuses.size===1?current[0].observation.workspaceStatus:'unknown'};
        if(current[0])view.repository=current[0].repository;
        view.archived=present?(current.some(w=>w.archived===false)?false:current.every(w=>w.archived===true)?true:null):null;
        view.project=lifecycleView(p,view,present);if(p.status==='completed')view.project.sourceState='not-checked';else if(!observedView||!retainedAllowed(p)||!connected||snapshot.freshness!=='current'||registryError)view.project.sourceState='not-checked';
      }
    }
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
    return structuredClone({ mode: 'live-read-only', connection: connected ? 'connected' : 'disconnected', configuration: {...loaded.view,noteScopeCount:noteScopes.length},
      refreshing: connected && snapshot.refreshing, observedAt: snapshot.observedAt, freshness,
      polling: {activity: !connected ? 'stopped' : activity.active && activity.visible ? 'foreground' : 'background',
        nextRefreshAt: connected ? snapshot.nextPollAt : null, countdownSeconds: connected ? snapshot.resumeCountdownSeconds : 0},
      lastError: registryError??snapshot.lastAttempt?.error?.message ?? null, coverage: snapshot.coverage,
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
    // A running manual request may outlive the display freshness window. Only
    // time ageing is relaxed on revalidation: mapping, root grants, DAG bytes,
    // registered excerpts, runtime identity and failed observations still gate it.
    async resolveSummarySource(workstreamId: string, signal: AbortSignal = new AbortController().signal, revalidateSnapshot=false) {
      const snapshot=store.getState();
      if(disposed || !connected || snapshot.refreshing || signal.aborted || (!revalidateSnapshot&&snapshot.freshness!=='current') || ['error','cancelled'].includes(snapshot.lastAttempt?.outcome??'') || !snapshot.value || !config?.localHostId) throw new Error('Current source unavailable');
      const workstream=snapshot.value.workstreams.find(w=>w.id===workstreamId);
      const mapping=workstream?.noteMapping;
      const dagView=mapping?.dagId?snapshot.value.dags.find(d=>d.dagId===mapping.dagId):undefined;
      const session=mapping?.dagId?dagSessions.get(mapping.dagId):undefined;
      if(registry?.records().find(p=>p.id===workstreamId)?.status==='completed'||mapping?.state!=='resolved'||dagView?.state!=='ready'||!session?.model || (!revalidateSnapshot&&now()-Date.parse(session.model.observedAt)>=STALE_MS)) throw new Error('Current DAG unavailable');
      const source=snapshot.value.worktreeSources.find(w=>w.id===workstreamId);
      if(!source?.hostId||source.hostId!==config.localHostId||!source.worktreePath||!session.reader)throw new Error('Current mapping unavailable');
      const verified=await readMapping({localHostId:config.localHostId,scopes:options.readRoots?await options.readRoots.filterScopes(noteScopes,signal):noteScopes,
        worktrees:[{worktreeId:source.worktreeId,hostId:source.hostId,worktreePath:source.worktreePath}],signal});
      const currentMapping=verified.mappings[0];
      if(signal.aborted||currentMapping?.state!=='resolved'||currentMapping.dagId!==mapping.dagId||currentMapping.canonicalDagPath!==session.canonicalPath)throw new Error('Source mapping changed');
      const currentDag=await session.reader.read(mapping.dagId!,{signal});
      if(!currentDag.ok||signal.aborted)throw new Error('Current DAG could not be verified');
      const registeredExcerpts=await readRegistered(currentMapping,signal);
      const after=store.getState();
      if(disposed||!connected||after.refreshing||(!revalidateSnapshot&&after.freshness!=='current')||['error','cancelled'].includes(after.lastAttempt?.outcome??'')||after.runtimeId!==snapshot.runtimeId||after.revision!==snapshot.revision)throw new Error('Source changed during validation');
      session.model=currentDag.value;
      return {projectKey:'project:'+digest(JSON.stringify([config.localHostId,session.canonicalPath])).replace(/^sha256:/,''),readingSummary:structuredClone(workstream?.readingSummary),dag:structuredClone(currentDag.value),mappingIdentity:JSON.stringify([snapshot.runtimeId,workstreamId,mapping.dagId,session.canonicalPath]),codeburn:structuredClone(codeburnResults),...(registeredExcerpts?{registeredExcerpts}:{})};
    },
    modelSourceRevision(workstreamId:string){const snapshot=store.getState();const w=snapshot.value?.workstreams.find(w=>w.id===workstreamId);return connected&&!disposed&&!['error','cancelled'].includes(snapshot.lastAttempt?.outcome??'')&&registry?.records().find(p=>p.id===workstreamId)?.status!=='completed'&&w?.noteMapping.state==='resolved'&&snapshot.value?.dags.find(d=>d.dagId===w.noteMapping.dagId)?.state==='ready'&&w.readingSummary?JSON.stringify([snapshot.runtimeId,w.noteMapping.dagId,w.readingSummary.fingerprint]):null;},
    identifyModelProject(workstreamId:string){const snapshot=store.getState();const w=snapshot.value?.workstreams.find(w=>w.id===workstreamId);const session=w?.noteMapping.dagId?dagSessions.get(w.noteMapping.dagId):undefined;return w?.noteMapping.state==='resolved'&&session&&config?.localHostId?'project:'+digest(JSON.stringify([config.localHostId,session.canonicalPath])).replace(/^sha256:/,''):null;},
    resolveNoteSelection(worktreeId: string, scopeId: string) {
      const snapshot=store.getState();
      if(disposed || !connected || snapshot.freshness!=='current' || !snapshot.value || !config?.localHostId) return null;
      const source=snapshot.value.worktreeSources.find(w=>w.id===worktreeId);
      const scope=noteScopes.find(s=>s.scopeId===scopeId);
      if(!source?.hostId||!source.worktreePath||!scope||!config.noteScopes.some(s=>s.scopeId===scope.scopeId)||source.hostId!==config.localHostId||scope.hostId!==source.hostId) return null;
      return {localHostId:config.localHostId,
        worktree:{worktreeId,hostId:source.hostId,worktreePath:source.worktreePath},scope:structuredClone(scope),
        knownWorktrees:snapshot.value.worktreeSources.filter(w=>w.hostId===config.localHostId&&w.worktreePath).map(w=>({worktreeId:w.id,worktreePath:w.worktreePath!}))};
    },
    async connect(): Promise<LiveWorkspaceView> {
      if (disposed || !config || loaded.view.state !== 'ready') return getState();
      if(registry)try{await registry.load();registryError=null;}catch{registryError='앱 프로젝트 상태를 읽지 못했습니다. 기존 상태 파일은 보존했습니다.';return getState();}
      connected = true;
      store.setActivity(activity);
      await store.start();
      return getState();
    },
    async refresh(): Promise<LiveWorkspaceView> {
      if (!disposed && connected) await store.refresh();
      return getState();
    },
    /** Explicit read-only summary request; joins collection already in flight. */
    async summarizeNow(): Promise<LiveWorkspaceView> {
      if (!disposed && connected) await store.refresh();
      return getState();
    },
    async disconnect(): Promise<LiveWorkspaceView> {
      connected = false;
      connectionChoices.clear();documentLinks.clear();for(const controller of connectionConfirmations)controller.abort();
      reading.cancel();
      store.stop();
      publish();
      return getState();
    },
    async resolveDocumentLink(request:unknown):Promise<string>{
      if(disposed||!connected||!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!=='linkId,workstreamId')throw new Error('문서 열기 요청 오류');
      const r=request as {linkId:string;workstreamId:string},link=documentLinks.get(r.linkId),snapshot=store.getState();
      if(!link||link.workstreamId!==r.workstreamId||snapshot.refreshing||snapshot.freshness!=='current')throw new Error('문서 연결을 다시 조회해 주세요.');
      if(options.readRoots&&!(await options.readRoots.filterScopes(noteScopes)).some(s=>s.scopePath===link.canonicalNotePath||link.canonicalNotePath.startsWith(s.scopePath+path.sep)))throw Error('문서 읽기 허용이 철회되었거나 경로가 변경되었습니다.');
      const resolved=await resolveWikiUri(link);
      if(disposed||!connected||documentLinks.get(r.linkId)!==link||store.getState().refreshing||store.getState().revision!==snapshot.revision)throw new Error('문서 연결이 변경되었습니다.');return resolved.uri;
    },
    async confirmProjectConnection(request:unknown):Promise<LiveWorkspaceView>{
      if(!registry||disposed||!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!=='candidateId,workstreamId')throw new Error('연결 확인 요청이 올바르지 않습니다.');
      const r=request as {workstreamId:string;candidateId:string},choice=connectionChoices.get(r.candidateId);
      if(!choice||choice.workstreamId!==r.workstreamId)throw new Error('연결 후보가 변경되었습니다. 다시 조회해 주세요.');
      const snapshot=store.getState();
      if(!connected||snapshot.refreshing||snapshot.freshness!=='current'||!config?.localHostId)throw new Error('현재 연결 상태에서 다시 확인해 주세요.');
      const controller=new AbortController();connectionConfirmations.add(controller);
      try {
        const scope=noteScopes.find(s=>s.hostId===choice.hostId&&s.scopeId===choice.scopeId&&s.dagRelativePaths.includes(choice.dagRelativePath));
        if(!scope)throw new Error('연결 범위가 변경되었습니다.');
        const result=await readMapping({localHostId:config.localHostId,scopes:[scope],signal:controller.signal,worktrees:[{worktreeId:r.workstreamId,hostId:choice.hostId,worktreePath:choice.worktreePath,selectedScopeId:choice.scopeId,selectedDagRelativePath:choice.dagRelativePath}]});
        const mapping=result.mappings[0],after=store.getState();
        if(controller.signal.aborted||disposed||!connected||connectionChoices.get(r.candidateId)!==choice||after.refreshing||after.revision!==snapshot.revision||mapping?.state!=='resolved'||mapping.canonicalDagPath!==choice.canonicalDagPath)throw new Error('연결 후보가 변경되었습니다. 다시 조회해 주세요.');
        const {workstreamId,canonicalDagPath,...binding}=choice;await registry.chooseConnection(binding,controller.signal);
        if(!controller.signal.aborted&&connected&&!disposed)await store.refresh();return getState();
      }finally{connectionConfirmations.delete(controller);}
    },
    async setProjectStatus(request:unknown):Promise<LiveWorkspaceView>{if(!registry||disposed)throw new Error('앱 프로젝트 상태가 준비되지 않았습니다.');await registry.setStatus(request);publish();return getState();},
    async invalidateReadRoots(){await this.disconnect();noteScopes=[];publish();},
    settleRegistry:()=>registry?.settle()??Promise.resolve(),
    setSuspended(suspended:boolean):void{if(!disposed)store.setSuspended(suspended);},
    setActivity(next: {visible: boolean; active: boolean}): void {
      activity = {...next};
      if (!disposed) store.setActivity(activity);
    },
    subscribe(listener: (view: LiveWorkspaceView) => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose(): void {
      if (disposed) return;
      connected = false; disposed = true;
      connectionChoices.clear();documentLinks.clear();for(const controller of connectionConfirmations)controller.abort();
      reading.cancel(true);
      unsubscribe(); store.dispose(); listeners.clear();
    },
  };
}
