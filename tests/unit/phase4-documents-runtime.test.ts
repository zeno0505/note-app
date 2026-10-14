import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLiveRuntime, type LiveRuntimeDependencies } from '../../src/main/live-runtime';
import type { LoadedLiveConfiguration } from '../../src/main/live-config-types';
import type { OrcaObservation } from '../../src/collector/orca';
import type { AllowedNoteScope } from '../../src/collector/notes';
import type { DagReadModel } from '../../src/facts/dag-read-model';
import type { EvidenceList } from '../../src/shared/evidence';
const roots: string[] = [], runtimes: ReturnType<typeof createLiveRuntime>[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) runtime.dispose(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==', 'base64');
function observation(tree: string): OrcaObservation {
  const coverage = { state: 'complete' as const, returnedCount: 1, totalCount: 1, truncated: false, hostIds: ['synthetic-host'], omittedHostIds: [] };
  const worktree = { id: 'tree', identity: { hostId: 'synthetic-host', instanceId: 'one', sourceKey: null }, repoId: 'repo', projectId: 'project', path: tree, branch: 'test', displayName: 'Synthetic evidence', isArchived: false, isMainWorktree: false };
  const project = { id: 'project', displayName: 'Synthetic evidence', sourceRepoIds: ['repo'] };
  return { runtimeId: 'synthetic-runtime', observedAt: new Date().toISOString(), status: { appRunning: true, runtimeReachable: true, runtimeState: 'ready', connectionState: 'connected', graphState: 'ready' }, projects: { records: [project], coverage }, worktrees: { records: [worktree], coverage }, processes: { records: [], coverage: { ...coverage, returnedCount: 0, totalCount: 0 } }, joined: [{ key: 'synthetic', worktree, project, projectMapping: 'matched', process: null, processMapping: 'not-observed' }], unmatchedProcesses: [], complete: true };
}
async function trustedPython():Promise<string>{
  const configured=process.env.DAG_QUERY_PYTHON??process.env.NOTE_APP_PYTHON??'/usr/bin/python3';
  if(!path.isAbsolute(configured)||/[\u0000-\u001f\u007f]/u.test(configured))throw Error('Use an absolute trusted DAG_QUERY_PYTHON or NOTE_APP_PYTHON for metadata tests.');
  const executable=await fs.realpath(configured);await fs.access(executable,constants.X_OK);return executable;
}
async function fixture(image = false) {
  // The DAG reader is injected, but macOS still executes the genuine inherited-fd
  // metadata helper. A nonexistent synthetic interpreter hides that integration.
  const pythonPath=await trustedPython();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-documents-runtime-'))); roots.push(root);
  const note = path.join(root, 'vault', 'project'), tree = path.join(root, 'tree'), document = path.join(note, 'docs', 'design.md');
  await fs.mkdir(path.join(note, 'docs', 'images'), { recursive: true }); await fs.mkdir(path.join(tree, 'docs'), { recursive: true });
  await fs.writeFile(path.join(note, 'dag.yaml'), 'phases: []\n'); await fs.symlink(note, path.join(tree, 'docs', 'note'));
  await fs.writeFile(document, image ? '# Synthetic design\n![check](images/check.png)\n![remote](https://example.invalid/remote.png)' : '# Synthetic design\nSafe local text');
  await fs.writeFile(path.join(note, 'docs', 'images', 'check.png'), png);
  const scope: AllowedNoteScope = { scopeId: 'scope', hostId: 'synthetic-host', scopePath: note, vaultRootPath: path.join(root, 'vault'), dagRelativePaths: ['dag.yaml'] };
  const configuration: LoadedLiveConfiguration = { configuration: { schemaVersion: 1, orcaExecutablePath: '/synthetic/orca', localHostId: 'synthetic-host', noteScopes: [scope], summarySelections: [], dagQuery: { pythonPath, queryScriptPath: '/synthetic/query' } }, view: { state: 'ready', message: 'Synthetic test', orcaExecutable: '/synthetic/orca', codeburnExecutable: null, noteScopeCount: 1, dagQueryConfigured: true, summaryTransport: 'blocked' } };
  let sourceHash = 'a'.repeat(64);
  const readDag = vi.fn<ReturnType<LiveRuntimeDependencies['dagReader']>['read']>(async dagId => {
    const value: DagReadModel = { dagId, sourceHash, sourceMtimeMs: 1, observedAt: new Date().toISOString(), doneStatus: 'done', tasks: [{ id: 'T-042', title: 'Synthetic evidence', status: 'pending', dependencies: [], e2e: { state: 'undeclared', required: null, coveredBy: null, coverage: 'undeclared' }, commitReferences: [], commitVerification: 'not-performed', details: { description: null, acceptanceCriteria: [], targetFiles: [], design: ['[[docs/design|Design]]'], discussion: [], omissions: 0 } }], statusCounts: [{ status: 'pending', count: 1 }], coverage: { tasksTotal: 1, declared: 0, required: 0, uncoveredDone: [], uncoveredOpen: [], malformed: [] }, verifiedFacts: [] };
    return { ok: true, value, unchanged: false };
  });
  const filterScopes = vi.fn(async (scopes: readonly AllowedNoteScope[]) => [...scopes]);
  const runtime = createLiveRuntime({ configuration, cacheRoot: path.join(root, 'unused-cache'), readRoots: { filterScopes, scopesFor: async () => [scope] }, dependencies: { orca: () => ({ collect: async () => ({ ok: true, value: observation(tree) }), read: vi.fn() }), dagReader: () => ({ read: readDag }), summaryCache: () => ({ read: async () => null }) } }); runtimes.push(runtime);
  const view = await runtime.connect(); expect(view.freshness).toBe('current'); expect(view.workstreams[0].noteMapping.context?.state).toBe('verified');
  const selection = { workstreamId: view.workstreams[0].id, taskId: 'T-042', sourceHash };
  const prepare = () => runtime.prepareTaskEvidence(selection);
  const read = (list: EvidenceList, expectedSourceHash: string | null = null) => runtime.readTaskEvidence({ sessionId: list.sessionId, evidenceId: list.items[0].evidenceId, expectedSourceHash });
  return { root, note, tree, document, runtime, filterScopes, readDag, selection, prepare, read, changeDag: () => { sourceHash = 'b'.repeat(64); } };
}
describe('Phase4 document service integration',()=>{
  it('preserves task declaration, contract record, project common provenance and anchors separately',async()=>{
    const f=await fixture();await fs.mkdir(path.join(f.note,'inbox','T-042'),{recursive:true});for(const name of ['assignment.md','implementation.md','review-10.md','review-2.md','final.md'])await fs.writeFile(path.join(f.note,'inbox','T-042',name),'# Synthetic record');await fs.writeFile(path.join(f.note,'context.md'),'# Context');
    const direct=await f.prepare();expect(direct.items).toHaveLength(1);expect(direct.items[0].relationships).toEqual([expect.objectContaining({kind:'task-declaration',field:'design',taskId:'T-042',originalReference:'[[docs/design|Design]]',dagSourceHash:f.selection.sourceHash,verification:'not-assessed'})]);
    const list=await f.runtime.prepareTaskEvidence({...f.selection,discoverTaskRecords:true});expect(list.items.map(i=>i.relativePath)).toEqual(['docs/design.md','inbox/T-042/assignment.md','inbox/T-042/implementation.md','inbox/T-042/review-2.md','inbox/T-042/review-10.md','inbox/T-042/final.md','context.md']);expect(list.items[1].relationships?.[0].kind).toBe('task-record');expect(list.items.at(-1)?.relationships?.[0]).toMatchObject({kind:'project-context',verification:'not-assessed'});expect(list.items.at(-1)?.relationships?.[0].taskId).toBeUndefined();
  });
  it('resolves document-relative links, flags ambiguous/missing/out-of-scope, and preserves parent proof',async()=>{
    const f=await fixture();await fs.writeFile(path.join(f.note,'context.md'),'# Requirements\nContext');await fs.writeFile(path.join(f.note,'review.md'),'# Root review');await fs.writeFile(path.join(f.note,'docs','review.md'),'# Local review');await fs.writeFile(f.document,'# Design\n[Requirements](../context.md#requirements)\n[[review]]\n[Missing](missing.md)\n[Outside](../../private.md)');
    const list=await f.prepare(),view=await f.read(list),refs=view.references!;expect(refs.targets.find(r=>r.href==='../context.md#requirements')).toMatchObject({status:'resolved'});const ambiguous=refs.targets.find(r=>r.href==='[[review]]')!;expect(ambiguous.status).toBe('ambiguous');expect(ambiguous.candidates?.map(c=>c.relativePath)).toEqual(['docs/review.md','review.md']);expect(refs.targets.find(r=>r.href==='missing.md')?.status).toBe('missing');expect(refs.targets.find(r=>r.href==='../../private.md')?.status).toBe('out-of-scope');
    const target=refs.targets[0];const result=await f.runtime.readTaskEvidence({sessionId:refs.session.sessionId,evidenceId:target.evidenceId,expectedSourceHash:null});expect(result.result).toMatchObject({ok:true,anchor:'requirements'});await fs.writeFile(f.document,'# Changed parent');await expect(f.runtime.readTaskEvidence({sessionId:refs.session.sessionId,evidenceId:target.evidenceId,expectedSourceHash:null})).rejects.toThrow();
  });
  it('resolves verified vault-qualified wikilinks without guessed project-prefix fallback',async()=>{
    const f=await fixture();await fs.writeFile(path.join(f.note,'context.md'),'# Context');await fs.writeFile(f.document,'[[project/context|Context]]\n[[other-project/context]]');const list=await f.prepare(),view=await f.read(list);expect(view.references?.targets[0]).toMatchObject({status:'resolved'});const next=await f.runtime.readTaskEvidence({sessionId:view.references!.session.sessionId,evidenceId:view.references!.targets[0].evidenceId,expectedSourceHash:null});expect(next.result).toMatchObject({ok:true,label:'Context'});expect(view.references?.targets[1].status).toBe('missing');
  });
  it('catalog opens complete large Markdown/YAML/JSON and preserves pinned stale-source snapshots',async()=>{
    const f=await fixture();const markdown='# Large\n'+'synthetic paragraph\n'.repeat(31000)+'MARKDOWN-END',yaml='tasks:\n'+'  # synthetic\n'.repeat(170000)+'YAML-END',json=JSON.stringify({synthetic:'x'.repeat(2300000),end:'JSON-END'});await fs.writeFile(path.join(f.note,'large.md'),markdown);await fs.writeFile(path.join(f.note,'large.yaml'),yaml);await fs.writeFile(path.join(f.note,'large.json'),json);
    const catalog=await f.runtime.prepareProjectDocuments({workstreamId:f.selection.workstreamId}),top=await f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:catalog.rootDirectoryId}),page=await f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:top.entries[0].id});
    for(const [name,text]of [['large.md',markdown],['large.yaml',yaml],['large.json',json]]){const entry=page.entries.find(e=>e.name===name)!,list=await f.runtime.openCatalogDocument({catalogId:catalog.catalogId,documentId:entry.id}),first=await f.read(list);expect(first.result).toMatchObject({ok:true,content:{text},byteLength:Buffer.byteLength(text),verification:'not-assessed'});if(!first.result.ok)throw Error('Expected complete body');await fs.writeFile(path.join(f.note,name),text+'\nchanged');expect((await f.read(list,first.result.sourceHash)).result).toMatchObject({ok:false,code:'stale-source'});expect((await f.read(list)).result.ok).toBe(true);}
  });
  it('does not require any task to explore project documents and rejects prior catalog IDs after disconnect',async()=>{
    const f=await fixture();const original=f.readDag.getMockImplementation()!;f.readDag.mockImplementation(async(...args)=>{const result=await original(...args);if(result.ok){result.value.tasks=[];result.value.coverage.tasksTotal=0;}return result;});await f.runtime.refresh();const catalog=await f.runtime.prepareProjectDocuments({workstreamId:f.selection.workstreamId});expect((await f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:catalog.rootDirectoryId})).entries).toHaveLength(1);await f.runtime.disconnect();await expect(f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:catalog.rootDirectoryId})).rejects.toThrow();
  });
  it('keeps the selected body readable when the bounded proof chain cannot derive deeper links',async()=>{const f=await fixture();for(let i=0;i<10;i++)await fs.writeFile(path.join(f.note,'docs',`${i}.md`),`# Document ${i}\n[Next](${i+1}.md)`);await fs.writeFile(f.document,'# Design\n[Next](0.md)');let list=await f.prepare(),view=await f.read(list);for(let depth=1;depth<=8;depth++){const refs=view.references!;expect(refs).toBeDefined();view=await f.runtime.readTaskEvidence({sessionId:refs.session.sessionId,evidenceId:refs.targets[0].evidenceId,expectedSourceHash:null});}expect(view.result).toMatchObject({ok:true,content:{text:'# Document 7\n[Next](8.md)'}});expect(view.references).toBeUndefined();if(view.result.ok)expect(view.result.omissions.join(' ')).toContain('8단계');});
  it('distinguishes an unsupported in-scope file from an out-of-scope link',async()=>{const f=await fixture();await fs.writeFile(path.join(f.note,'docs','table.csv'),'a,b');await fs.writeFile(f.document,'[Table](table.csv)\n[Outside](../../outside.csv)');const view=await f.read(await f.prepare());expect(view.references?.targets.map(target=>target.status)).toEqual(['unsupported','out-of-scope']);});
  it('does not let document-folder grants become known vault/worktree or project-ancestor scans',async()=>{const f=await fixture();expect(f.runtime.projectDocumentDirectoryAllowed(f.selection.workstreamId,path.join(f.root,'vault'))).toBe(false);expect(f.runtime.projectDocumentDirectoryAllowed(f.selection.workstreamId,f.tree)).toBe(false);expect(f.runtime.projectDocumentDirectoryAllowed(f.selection.workstreamId,f.root)).toBe(false);expect(f.runtime.projectDocumentDirectoryAllowed(f.selection.workstreamId,path.join(f.tree,'docs'))).toBe(true);});
  it('caps unresolved catalog operations across timeout and retry, then closes late directory handles',async()=>{
    const f=await fixture(),original=fs.open.bind(fs),pending:(()=>Promise<void>)[]=[];const closed=vi.fn();
    // Both native Linux enumeration and the macOS helper first acquire this
    // main-owned directory fd. Stall the shared boundary, not Linux-only opendir.
    vi.spyOn(fs,'open').mockImplementation((...args)=>{
      if(args[0]!==f.note||typeof args[1]!=='number'||!(args[1]&constants.O_DIRECTORY))return original(...args);
      return new Promise((resolve,reject)=>{pending.push(async()=>{try{const directory=await original(...args),close=directory.close.bind(directory);directory.close=async()=>{closed();return close();};resolve(directory);}catch(error){reject(error);}});});
    });
    vi.useFakeTimers();try{
      for(let attempt=0;attempt<4;attempt++){const catalog=await f.runtime.prepareProjectDocuments({workstreamId:f.selection.workstreamId}),top=await f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:catalog.rootDirectoryId});const request=f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:top.entries[0].id}),rejection=expect(request).rejects.toThrow('5초');await vi.waitFor(()=>expect(pending).toHaveLength(attempt+1));await vi.advanceTimersByTimeAsync(5001);await rejection;}
      await expect(f.runtime.prepareProjectDocuments({workstreamId:f.selection.workstreamId})).rejects.toThrow('정리 중');expect(pending).toHaveLength(4);
      await Promise.all(pending.map(resolve=>resolve()));await vi.waitFor(()=>expect(closed.mock.calls.length).toBeGreaterThanOrEqual(4));
    }finally{vi.useRealTimers();}
  });
  it('revalidates revocation during listing, catalog open, and evidence rereads',async()=>{
    const f=await fixture();const catalog=await f.runtime.prepareProjectDocuments({workstreamId:f.selection.workstreamId}),top=await f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:catalog.rootDirectoryId}),page=await f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:top.entries[0].id,query:'design.md'}),list=await f.runtime.openCatalogDocument({catalogId:catalog.catalogId,documentId:page.entries[0].id});f.filterScopes.mockResolvedValue([]);await expect(f.read(list)).rejects.toThrow();await expect(f.runtime.listProjectDocuments({catalogId:catalog.catalogId,directoryId:top.entries[0].id})).rejects.toThrow();await expect(f.runtime.openCatalogDocument({catalogId:catalog.catalogId,documentId:page.entries[0].id})).rejects.toThrow();
  });
});
