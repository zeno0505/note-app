import { createHash } from 'node:crypto';
import type { DagReadModel } from '../facts/dag-read-model';
import { TASK_GRAPH_LIMITS, type LinkedCommitEvidence } from '../shared/task-graph-contract';
import type { GraphDateReadResult } from '../shared/task-graph-dates';
import { parseGraphReadRequest, parseGraphCancelRequest } from '../shared/task-graph-transport';
import { produceTaskGraph, type GraphAuthority } from './task-graph';
import type { GitMetadataReadAuthority } from './git-metadata-grants';
import { createLocalLinkedCommitAdapter } from './local-linked-commit-adapter';
import { LinkedCommitDateResolver, summarizeLinkedDates, type LinkedDateTask } from './linked-commit-dates';

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('cancelled'));
    if (signal.aborted) { reject(new Error('cancelled')); void promise.catch(() => {}); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

type Repository = LinkedCommitEvidence['repository'];
export function createTaskGraphDateService(options: {
  source: (projectId: string, signal: AbortSignal) => Promise<{ authority: GraphAuthority; dag: DagReadModel }>;
  current: (projectId: string) => GraphAuthority | null;
  repository: (projectId: string) => Repository | null;
  authority: (projectId: string, signal: AbortSignal) => Promise<GitMetadataReadAuthority | null>;
}) {
  let physical = 0;
  const bounded = <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) return Promise.reject(new Error('cancelled'));
    if (physical >= 1) return Promise.reject(new Error('unsupported'));
    physical++;
    const work = Promise.resolve().then(operation).finally(() => { physical--; });
    return abortable(work, signal);
  };
  let active: { requestId: string; controller: AbortController } | null = null;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  return {
    cancel(requestId?: string): void { if (!requestId || active?.requestId === requestId) active?.controller.abort(); },
    async read(input: unknown): Promise<GraphDateReadResult> {
      let request;
      try { request = parseGraphReadRequest(input); } catch { return { state: 'unavailable', requestId: '', reason: 'invalid-request' }; }
      if (active || physical >= 1) return { state: 'unavailable', requestId: request.requestId, reason: 'unsupported' };
      const controller = new AbortController(); const owned = { requestId: request.requestId, controller }; active = owned;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TASK_GRAPH_LIMITS.timeoutMs);
      const fail = (reason: Extract<GraphDateReadResult, {state:'unavailable'}>['reason']): GraphDateReadResult => ({ state: 'unavailable', requestId: request.requestId, reason });
      try {
        const expected = { projectId: request.projectId, dagId: request.dagId, sessionKey: request.sessionKey };
        if (!same(options.current(request.projectId), expected)) return fail('stale-session');
        const source = await bounded(() => options.source(request.projectId, controller.signal), controller.signal);
        if (!same(source.authority, expected)) return fail('stale-session');
        const identity = produceTaskGraph(source.dag, expected).metadata.identity;
        if (request.expectedRevision && request.expectedRevision !== identity.revision) return fail('source-changed');
        const repository = options.repository(request.projectId);
        const authority = repository ? await bounded(() => options.authority(request.projectId, controller.signal), controller.signal) : null;
        const local = createLocalLinkedCommitAdapter(repository && authority ? [{ repository, authority }] : []);
        const adapter = { ...local, commit: (repo: Repository, sha: string, signal: AbortSignal) => bounded(() => local.commit(repo, sha, signal), signal),
          pull: (repo: Repository, number: number, signal: AbortSignal) => bounded(() => local.pull(repo, number, signal), signal) };
        const resolver = new LinkedCommitDateResolver(adapter);
        if (source.dag.tasks.some(t => !Number.isSafeInteger(t.commitReferencesUnsupported ?? 0) || (t.commitReferencesUnsupported ?? 0) < 0) || source.dag.tasks.reduce((n, t) => n + t.commitReferences.length + (t.commitReferencesUnsupported ?? 0), 0) > 20_000) return fail('unsupported');
        const tasks: LinkedDateTask[] = source.dag.tasks.map(t => {
          const references = [...t.commitReferences], known = new Set(references);
          let candidate = 0;
          for (let i = 0; i < (t.commitReferencesUnsupported ?? 0); i++) {
            let placeholder: string;
            do { placeholder = `unsupported-declaration:${candidate++}`; } while (known.has(placeholder));
            known.add(placeholder); references.push(placeholder);
          }
          return { id: t.id, references, inspection: 'complete', ...(repository ? { repository } : {}) };
        });
        const result = await resolver.resolve(identity, tasks, controller.signal);
        // Rehash the registered source, and recheck grant/provider association before publish.
        const fresh = await bounded(() => options.source(request.projectId, controller.signal), controller.signal);
        if (controller.signal.aborted) return fail('cancelled');
        if (fresh.dag.sourceHash !== source.dag.sourceHash || !same(fresh.authority, expected)
          || !same(options.current(request.projectId), expected) || !same(options.repository(request.projectId), repository)) return fail('source-changed');
        if (authority && !await bounded(() => authority.validate(controller.signal), controller.signal)) return fail('unauthorized');
        const projected = result.tasks.map((task, i) => ({ id: task.id, summary: summarizeLinkedDates([tasks[i]!], [task]) }));
        const metadataRevision = createHash('sha256').update(JSON.stringify([identity, result.resolverRevision, result.summary, projected])).digest('hex');
        const response: GraphDateReadResult = { state: 'dates', requestId: request.requestId, identity, metadataRevision, summary: result.summary, tasks: projected };
        if (Buffer.byteLength(JSON.stringify(response)) > TASK_GRAPH_LIMITS.chunkBytes) return fail('unsupported');
        if (controller.signal.aborted || !same(options.current(request.projectId), expected)) return fail('stale-session');
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        return fail(timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : message === 'unsupported' ? 'unsupported' : message === 'timeout' ? 'timeout' : 'source-unavailable');
      } finally { clearTimeout(timer); if (active === owned) active = null; }
    },
  };
}

/** Production handler registration is shared by IPC integration tests. */
export function registerTaskGraphDatesIpc<Event>(ipc: { handle: (channel: string, handler: (event: Event, ...args: unknown[]) => unknown) => unknown },
  service: ReturnType<typeof createTaskGraphDateService>, check: (event: Event) => void,
  available: () => boolean, track: <T>(promise: Promise<T>) => Promise<T>): void {
  ipc.handle('note-app:graph-dates', (event, ...args) => { check(event); if (args.length !== 1 || !available()) throw new Error('Graph dates unavailable'); return track(service.read(args[0])); });
  ipc.handle('note-app:graph-dates-cancel', (event, ...args) => { check(event); if (args.length !== 1) throw new Error('Invalid graph dates cancellation'); const request = parseGraphCancelRequest(args[0]); service.cancel(request); });
}
