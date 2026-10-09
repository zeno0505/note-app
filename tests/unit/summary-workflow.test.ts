import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ASPECTS, bindSummaryContext } from '../../src/summary/claims';
import { createSummaryWorkflow, createSyntheticSummaryWorkflowForTests, parseSummaryPrepareRequest, parseSummaryRunRequest, parseSummaryReviewRequest, type SummaryWorkflowSource } from '../../src/summary/workflow';
import type { SyntheticSummaryTransport } from '../../src/summary/workflow/transport';
import type { SummaryPrompt } from '../../src/summary/instructions';
import type { SummaryWorkflowView } from '../../src/shared/summary-workflow';
import { projectCodeBurn } from '../../src/summary/budget/codeburn';
import { createLocalSummaryCache } from '../../src/summary/storage';
import { summaryCacheCodec } from '../../src/summary/storage/payload';
import { contextScopeId } from '../../src/summary/context/extract';
import { assertPrivateSummaryCachePath } from '../../src/summary/workflow/cache-path';

const fault = vi.hoisted(() => ({ beforeRename: null as (() => Promise<void>) | null, beforeUnlink: null as (() => void) | null }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => { await fault.beforeRename?.(); return actual.rename(...args); },
    unlink: async (...args: Parameters<typeof actual.unlink>) => { fault.beforeUnlink?.(); return actual.unlink(...args); } };
});
const at = '2026-10-03T01:00:00.000Z'; const now = Date.parse('2026-10-03T02:00:00.000Z');
function source(): SummaryWorkflowSource {
  const task = (id: string) => ({ id, title: `Synthetic ${id}`, status: 'running', dependencies: [], e2e: { state: 'undeclared' as const, required: null, coveredBy: null, coverage: 'undeclared' as const }, commitReferences: [], commitVerification: 'not-performed' as const });
  return { mappingIdentity: '/private/SYNTHETIC-CANONICAL-MAPPING-ONLY', codeburn: [], dag: { dagId: 'synthetic-dag', sourceHash: 'a'.repeat(64), sourceMtimeMs: 1, observedAt: at,
    doneStatus: 'done', tasks: [task('A'), task('B')], statusCounts: [{ status: 'running', count: 2 }], coverage: { tasksTotal: 2, declared: 0, required: 0, uncoveredDone: [], uncoveredOpen: [], malformed: [] }, verifiedFacts: [] } };
}
function response(prompt: SummaryPrompt, claimIds: string[] | null = null) {
  const record = prompt.pack.records[0];
  return { schemaVersion: 1, ...bindSummaryContext(prompt.pack), generatedAt: at,
    claims: ASPECTS.filter(aspect => claimIds === null || claimIds.includes(aspect)).map(aspect => ({ claimId: aspect, aspect, kind: aspect === 'next' ? 'unknown' : 'inference', intent: aspect === 'next' ? 'proposal' : 'informational', text: aspect === 'next' ? 'Next action is unknown.' : 'The selected task declares progress.', citations: aspect === 'next' ? [] : [{ sourceId: record.sourceId, sourceHash: record.sourceHash, observedAt: record.observedAt, quote: record.text }], assertions: [] })) };
}
const successful: SyntheticSummaryTransport = { kind: 'synthetic-test-only', async run({prompt, claimIds}, emit) { await emit({type:'submitted'}); await emit({type:'waiting'}); await emit({type:'response', response: response(prompt, claimIds)}); } };
const directories: string[] = []; const workflows: ReturnType<typeof createSummaryWorkflow>[] = [];
async function setup(transport: SyntheticSummaryTransport | null = successful, extra: { ioDeadlineMs?: number; runDeadlineMs?: number } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summary-workflow-'))); directories.push(root);
  let value = source();
  const resolveSource = vi.fn(async () => value);
  const options = { cacheRoot: root, resolveSource, now: () => now, ...extra };
  const workflow = transport ? createSyntheticSummaryWorkflowForTests({ ...options, transport }) : createSummaryWorkflow(options); workflows.push(workflow);
  return { workflow, root, resolveSource, change(fn: (source: SummaryWorkflowSource) => void) { value = structuredClone(value); fn(value); }, source: () => structuredClone(value),
    prepare: () => workflow.prepare({workstreamId:'worktree-test',taskIds:['A'],provider:'claude'}) };
}
async function candidate(f: Awaited<ReturnType<typeof setup>>) { const p = await f.prepare(); expect(p.state).toBe('prepared'); return f.workflow.run({ticketId:p.ticketId,provider:'claude'}); }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve=r;}); return {promise,resolve}; }
afterEach(async () => { fault.beforeRename = null; fault.beforeUnlink = null; for (const workflow of workflows.splice(0)) workflow.dispose(); for (const directory of directories.splice(0)) await fs.rm(directory,{recursive:true,force:true}); });

describe('bounded summary workflow request boundary', () => {
  it.each([
    {workstreamId:'../vault',taskIds:['A'],provider:'claude'},
    {workstreamId:'worktree-test',taskIds:['../A'],provider:'claude'},
    {workstreamId:'worktree-test',taskIds:['A','A'],provider:'claude'},
    {workstreamId:'worktree-test',taskIds:Array.from({length:33},(_,i)=>`A${i}`),provider:'claude'},
    {workstreamId:'worktree-test',taskIds:['A'],provider:'other'},
    {workstreamId:'worktree-test',taskIds:['A'],provider:'claude',prompt:'run command'},
    {workstreamId:'worktree-test',taskIds:['A'],provider:'claude',directory:'/tmp'},
  ])('rejects invalid selection without accepting any arbitrary path/prompt', input => { expect(()=>parseSummaryPrepareRequest(input)).toThrow(); });
  it('rejects getters and sparse arrays without executing accessors', () => {
    let called=false; const input={workstreamId:'worktree-test',taskIds:['A'],provider:'claude'}; Object.defineProperty(input,'taskIds',{get(){called=true;return ['A'];}});
    expect(()=>parseSummaryPrepareRequest(input)).toThrow(); expect(called).toBe(false);
    expect(()=>parseSummaryPrepareRequest({workstreamId:'w',taskIds:new Array(2),provider:'auto'})).toThrow();
    expect(()=>parseSummaryRunRequest({ticketId:'ticket',provider:'claude',approval:true})).toThrow();
    expect(()=>parseSummaryReviewRequest({ticketId:'ticket',candidateHash:`sha256:${'a'.repeat(64)}`,approvedAt:at})).toThrow();
  });
  it('rejects unknown selected IDs without loading an alternate source or full note', async () => {
    const f=await setup(); const view=await f.workflow.prepare({workstreamId:'worktree-test',taskIds:['missing'],provider:'auto'});
    expect(view.state).toBe('error'); expect(view.preview).toBeNull(); expect(await fs.readdir(f.root)).toEqual([]); expect(f.resolveSource).toHaveBeenCalledTimes(1);
  });
});

describe('context and provider review without production execution', () => {
  it('shows useful bounded declarations and exclusions without local manifests or unselected source text', async () => {
    const f=await setup(null); const p=await f.prepare();
    expect(p.state).toBe('prepared'); expect(p.preview?.records[0]).toMatchObject({taskId:'A',title:'Synthetic A',selection:'selected-task',declaredStatus:'running',e2eCoverage:'undeclared'});
    expect(p.preview?.inputBytes).toBeGreaterThan(p.preview!.bytes); expect(p.preview?.unknowns.join(' ')).toContain('Goal document');
    expect(JSON.stringify(p)).not.toContain('SYNTHETIC-CANONICAL-MAPPING-ONLY'); expect(JSON.stringify(p)).not.toContain('Synthetic B'); expect(JSON.stringify(p)).not.toContain('upstream');
    expect(p.transport).toBe('blocked'); expect(p.executionAuthorized).toBe(false); expect(p.canRun).toBe(false);
    const r=await f.workflow.run({ticketId:p.ticketId,provider:'claude'}); expect(r.state).toBe('blocked'); expect(r.candidateClaims).toEqual([]);
    expect(await fs.readdir(path.join(f.root,contextScopeId('synthetic-dag')))).toEqual([]);
  });
  it('keeps CodeBurn calendar/cap and availability unknown while quota remains separately visible', async () => {
    const f=await setup(null); f.change(s=>{s.codeburn=[projectCodeBurn('claude-status',{currency:'USD',today:{cost:0,savings:0,calls:0},month:{cost:0,savings:0,calls:0}},now),projectCodeBurn('quota',{providers:[{id:'claude',available:true,windows:[{label:'daily',usedPct:3,resetsAt:null}]}]},now)];});
    const p=await f.prepare(); expect(p.budget?.state).toBe('choice-required'); expect(p.budget?.assessments.every(a=>a.budget==='unknown'&&a.availability==='unknown')).toBe(true);
    expect(p.codeburn).toHaveLength(2); expect(p.budget?.executionAuthorized).toBe(false);
  });
  it('never silently selects a provider from auto in synthetic runs', async () => { const run=vi.fn(successful.run); const f=await setup({...successful,run}); const p=await f.prepare(); const r=await f.workflow.run({ticketId:p.ticketId,provider:'auto'}); expect(r.state).toBe('blocked');expect(run).not.toHaveBeenCalled(); });
});

describe('candidate, user approval, atomic local save and restart', () => {
  it('records submitting/submitted/waiting/candidate and saves candidate separately from authentic approval', async () => {
    const f=await setup(); const states:string[]=[]; f.workflow.subscribe(v=>states.push(v.state));
    const c=await candidate(f); expect(c.state).toBe('candidate'); expect(c.persistence.state).toBe('candidate-saved');expect(c.persistence.revision).toBe(1);expect(c.approvedClaims).toEqual([]);expect(c.canApprove).toBe(true);
    expect(states).toEqual(expect.arrayContaining(['preparing','prepared','submitting','submitted','waiting','candidate']));
    const a=await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});expect(a.state).toBe('approved');expect(a.persistence.state).toBe('approval-saved');expect(a.persistence.revision).toBe(2);expect(a.approvedClaims).toHaveLength(6);expect(a.approvedAt).toBe(new Date(now).toISOString());expect(a.canApprove).toBe(false);
    const loaded=await createLocalSummaryCache({directory:path.join(f.root,contextScopeId('synthetic-dag')),codec:summaryCacheCodec}).read();
    expect(loaded!.payload.state.approved!.approvalId).toMatch(/^approval-/);expect(loaded!.payload.projectionContexts.length).toBeGreaterThan(0);
    await expect(f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash})).rejects.toMatchObject({code:'stale-ticket'});
  });
  it('restores exact candidate and historical approval, but no execution tickets survive restart', async () => {
    const f=await setup();const c=await candidate(f);await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});f.workflow.dispose();
    const restarted=createSummaryWorkflow({cacheRoot:f.root,resolveSource:async()=>f.source(),now:()=>now});workflows.push(restarted);
    const p=await restarted.prepare({workstreamId:'worktree-test',taskIds:['A'],provider:'auto'});expect(p.persistence.state).toBe('restored');expect(p.approvedClaims).toHaveLength(6);expect(p.canApprove).toBe(false);expect(p.ticketId).not.toBe(c.ticketId);
    await expect(restarted.read({ticketId:c.ticketId})).rejects.toMatchObject({code:'unknown-ticket'});
  });
  it('restores unapproved candidate without auto-approving it', async () => {const f=await setup();const c=await candidate(f);const p=await f.prepare();expect(p.candidateHash).toBe(c.candidateHash);expect(p.approvedClaims).toEqual([]);expect(p.persistence.state).toBe('restored');expect(p.canApprove).toBe(true);});
  it('rejects only the candidate, retains prior approval and persists this distinction after restart', async () => {
    const f=await setup();const c=await candidate(f);await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});f.change(s=>{s.dag.tasks[0].title='Changed synthetic A';});
    const next=await candidate(f);expect(next.approvedClaims.some(c=>c.freshness==='stale')).toBe(true);expect(next.candidateHash).not.toBe(c.candidateHash);
    const rejected=await f.workflow.reject({ticketId:next.ticketId,candidateHash:next.candidateHash});expect(rejected.state).toBe('rejected');expect(rejected.candidateHash).toBeNull();expect(rejected.approvedClaims).toHaveLength(6);expect(rejected.persistence.state).toBe('rejection-saved');
    const restored=await f.prepare();expect(restored.candidateHash).toBeNull();expect(restored.approvedClaims).toHaveLength(6);
  });
  it('rejects model-supplied approval, wrong binding, and unsupported completion flags', async () => {
    for(const kind of ['approval','binding','command']) {const f=await setup({kind:'synthetic-test-only',async run({prompt},emit){await emit({type:'submitted'});const r:Record<string,unknown>=response(prompt);if(kind==='approval')r.approved=true;else if(kind==='binding')r.packHash=`sha256:${'0'.repeat(64)}`;else r.command='execute task';await emit({type:'response',response:r});}});const c=await candidate(f);expect(c.state).toBe('error');expect(c.approvedClaims).toEqual([]);expect(c.persistence.revision).toBeNull();}
  });
  it('does not persist malformed candidate over the prior approved bytes', async () => {
    const f=await setup();const c=await candidate(f);await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});const filename=path.join(f.root,contextScopeId('synthetic-dag'),'summary-cache-v1.json');const bytes=await fs.readFile(filename,'utf8');
    f.workflow.dispose();const bad=createSyntheticSummaryWorkflowForTests({cacheRoot:f.root,now:()=>now,resolveSource:async()=>{const s=f.source();s.dag.tasks[0].title='New';return s;},transport:{kind:'synthetic-test-only',async run(_,emit){await emit({type:'submitted'});await emit({type:'response',response:{approved:true}});}}});workflows.push(bad);const p=await bad.prepare({workstreamId:'worktree-test',taskIds:['A'],provider:'claude'});const result=await bad.run({ticketId:p.ticketId,provider:'claude'});expect(result.state).toBe('error');expect(result.approvedClaims).toHaveLength(6);expect(await fs.readFile(filename,'utf8')).toBe(bytes);
  });
});

describe('stale, repeated, cancelled and late operations', () => {
  it('issues monotonic per-ticket sequences for events and RPC reads without trusting observer mutation', async () => {
    const f=await setup();const observations:SummaryWorkflowView[]=[];
    f.workflow.subscribe(view=>{observations.push(structuredClone(view));view.sequence=999_999;});
    const prepared=await f.prepare();expect(prepared.sequence).toBeGreaterThan(0);
    const first=await f.workflow.read({ticketId:prepared.ticketId});const second=await f.workflow.read({ticketId:prepared.ticketId});
    expect(first.sequence).toBeGreaterThan(prepared.sequence);expect(second.sequence).toBeGreaterThan(first.sequence);
    const result=await f.workflow.run({ticketId:prepared.ticketId,provider:'claude'});
    expect(result.sequence).toBe(observations.at(-1)!.sequence);expect(result.sequence).toBeLessThan(999_999);
    expect(observations.every((view,index)=>index===0||view.sequence>observations[index-1].sequence)).toBe(true);
    const replacement=await f.prepare();expect(replacement.ticketId).not.toBe(prepared.ticketId);expect(replacement.sequence).toBe(2);
  });
  it.each(['selected','mapping','missing'])('rechecks %s source identity before run', async kind => {const run=vi.fn(successful.run);const f=await setup({...successful,run});const p=await f.prepare();f.change(s=>{if(kind==='selected')s.dag.tasks[0].title='Changed';else if(kind==='mapping')s.mappingIdentity='different';else{s.dag.tasks.shift();s.dag.coverage.tasksTotal=1;}});const r=await f.workflow.run({ticketId:p.ticketId,provider:'claude'});expect(r.state).toBe('error');expect(run).not.toHaveBeenCalled();expect(r.canApprove).toBe(false);});
  it('invalidates candidate approval after selected evidence changes', async () => {const f=await setup();const c=await candidate(f);f.change(s=>{s.dag.tasks[0].status='done';});const a=await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});expect(a.state).toBe('error');expect(a.canApprove).toBe(false);expect(a.approvedClaims).toEqual([]);expect(a.persistence.revision).toBe(1);});
  it('preserves exact cited observation and approves after timestamp-only polls or unrelated task edits', async () => {const f=await setup();const c=await candidate(f);f.change(s=>{s.dag.observedAt='2026-10-03T01:30:00.000Z';s.dag.sourceHash='b'.repeat(64);s.dag.tasks[1].title='Unrelated edit';});const a=await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});expect(a.state).toBe('approved');expect(a.approvedClaims[0].claim.citations[0].observedAt).toBe(at);});
  it('old prepares/runs cannot win a newer selection and duplicate run is not resent', async () => {const run=vi.fn(successful.run);const f=await setup({...successful,run});const p=await f.prepare();const p2=await f.prepare();await expect(f.workflow.run({ticketId:p.ticketId,provider:'claude'})).rejects.toMatchObject({code:'stale-ticket'});const c=await f.workflow.run({ticketId:p2.ticketId,provider:'claude'});expect(c.state).toBe('candidate');await f.workflow.run({ticketId:p2.ticketId,provider:'claude'});expect(run).toHaveBeenCalledTimes(1);});
  it('ignores late response after cancel without claiming safe production terminal cancellation', async () => {const entered=deferred();const release=deferred();const f=await setup({kind:'synthetic-test-only',async run({prompt},emit){await emit({type:'submitted'});entered.resolve();await release.promise;await emit({type:'response',response:response(prompt)});}});const p=await f.prepare();const pending=f.workflow.run({ticketId:p.ticketId,provider:'claude'});await entered.promise;const cancelled=await f.workflow.cancel({ticketId:p.ticketId});expect(cancelled.state).toBe('cancelled');release.resolve();expect((await pending).state).toBe('cancelled');expect((await f.workflow.read({ticketId:p.ticketId})).candidateHash).toBeNull();});
  it('does not treat idle or ambiguous submission as completion and never automatically retries', async () => {for(const event of [{type:'tui-idle'} as const,{type:'submission-unknown',retryRequestId:'returned-id'} as const]) {const run=vi.fn(async(_:unknown,emit:Parameters<SyntheticSummaryTransport['run']>[1])=>{await emit({type:'submitted'});await emit(event);});const f=await setup({kind:'synthetic-test-only',run});const r=await candidate(f);expect(r.state).toBe('error');expect(r.candidateHash).toBeNull();expect(run).toHaveBeenCalledTimes(1);}});
  it('expires synthetic run and ignores delayed output rather than starting another request', async () => {const release=deferred();const f=await setup({kind:'synthetic-test-only',async run({prompt},emit){await emit({type:'submitted'});await release.promise;await emit({type:'response',response:response(prompt)});}},{runDeadlineMs:20});const p=await f.prepare();const r=await f.workflow.run({ticketId:p.ticketId,provider:'claude'});expect(r.state).toBe('error');release.resolve();await new Promise(r=>setTimeout(r,10));expect((await f.workflow.read({ticketId:p.ticketId})).candidateHash).toBeNull();});
});

describe('cache safety and honest write ambiguity', () => {
  it.each(['committed','cleanup-failed'] as const)('publishes the actual late %s cache outcome after cancellation with a newer sequence', async outcome => {
    const f=await setup();const c=await candidate(f);const reached=deferred();const release=deferred();const events:SummaryWorkflowView[]=[];
    f.workflow.subscribe(view=>events.push(view));fault.beforeRename=async()=>{reached.resolve();await release.promise;};
    if(outcome==='cleanup-failed')fault.beforeUnlink=()=>{throw new Error('Synthetic late cleanup failure');};
    const pending=f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});await reached.promise;
    const cancelled=await f.workflow.cancel({ticketId:c.ticketId});const settled=await pending;
    expect(cancelled.state).toBe('cancelled');expect(settled.persistence.state).toBe('commit-unknown');
    release.resolve();fault.beforeRename=null;
    await vi.waitFor(()=>expect(events.some(view=>view.sequence>settled.sequence&&(outcome==='committed'?view.persistence.state==='committed-after-cancel':/committed revision 2/.test(view.persistence.message)))).toBe(true));
    const late=await f.workflow.read({ticketId:c.ticketId});expect(late.sequence).toBeGreaterThan(cancelled.sequence);expect(late.canRun).toBe(false);expect(late.canApprove).toBe(false);
    fault.beforeUnlink=null;const cache=createLocalSummaryCache({directory:path.join(f.root,contextScopeId('synthetic-dag')),codec:summaryCacheCodec});
    expect((await cache.read())!.payload.state.approved).not.toBeNull();
  });
  it('rejects corrupt cache without overwriting or showing empty-success', async () => {const f=await setup();await candidate(f);const filename=path.join(f.root,contextScopeId('synthetic-dag'),'summary-cache-v1.json');await fs.writeFile(filename,'corrupt');const p=await f.prepare();expect(p.state).toBe('error');expect(await fs.readFile(filename,'utf8')).toBe('corrupt');expect(p.canRun).toBe(false);});
  it('rejects symlink roots and scope children', async () => {const f=await setup();const alias=path.join(f.root,'alias');await fs.symlink(f.root,alias);const w=createSummaryWorkflow({cacheRoot:alias,resolveSource:async()=>source()});workflows.push(w);expect((await w.prepare({workstreamId:'w',taskIds:['A'],provider:'auto'})).state).toBe('error');const scope=path.join(f.root,contextScopeId('synthetic-dag'));await fs.symlink(f.root,scope);expect((await f.prepare()).state).toBe('error');});
  it('detects concurrent edit by revision and retains the saved approval honestly', async () => {const f=await setup();const c=await candidate(f);const cache=createLocalSummaryCache({directory:path.join(f.root,contextScopeId('synthetic-dag')),codec:summaryCacheCodec});const old=(await cache.read())!;await cache.write(old.payload,old.revision);const a=await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});expect(a.state).toBe('error');expect(a.persistence.state).toBe('failed');expect(a.approvedClaims).toEqual([]);expect((await cache.read())!.revision).toBe(2);});
  it('labels a deadline during atomic rename as unknown, then reports the actual late commit without rollback', async () => {
    const f = await setup();
    const c = await candidate(f);
    expect(c).toMatchObject({ state: 'candidate', canApprove: true, persistence: { state: 'candidate-saved', revision: 1 } });
    const cache = createLocalSummaryCache({ directory: path.join(f.root, contextScopeId('synthetic-dag')), codec: summaryCacheCodec });
    const reached = deferred();
    const release = deferred();
    fault.beforeRename = async () => { reached.resolve(); await release.promise; };
    // Keep real filesystem work independent of wall-clock latency. Expire only the
    // approval write, after it has reached the atomic rename commit boundary.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = f.workflow.approve({ ticketId: c.ticketId, candidateHash: c.candidateHash });
      await Promise.race([
        reached.promise,
        pending.then(view => { throw new Error(`Approval settled before atomic rename: ${view.state} / ${view.persistence.state}`); }),
      ]);
      expect((await f.workflow.read({ ticketId: c.ticketId })).persistence.state).toBe('saving-approval');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersToNextTimerAsync();
      const timed = await pending;
      expect(timed).toMatchObject({ state: 'error', canRun: false, canApprove: false, canReject: false,
        persistence: { state: 'commit-unknown', revision: 1 } });
      expect(timed.approvedClaims).toEqual([]);
      const beforeCommit = await cache.read();
      expect(beforeCommit!.revision).toBe(1);
      expect(beforeCommit!.payload.state.approved).toBeNull();
      release.resolve();
      fault.beforeRename = null;
      vi.useRealTimers();
      await vi.waitFor(async () => expect((await f.workflow.read({ ticketId: c.ticketId })).persistence.state).toBe('committed-after-cancel'));
      const late = await f.workflow.read({ ticketId: c.ticketId });
      expect(late.sequence).toBeGreaterThan(timed.sequence);
      expect(late.approvedClaims).toHaveLength(6);
      expect(late).toMatchObject({ state: 'error', canRun: false, canApprove: false, canReject: false,
        persistence: { state: 'committed-after-cancel', revision: 2 } });
      const committed = await cache.read();
      expect(committed!.revision).toBe(2);
      expect(committed!.payload.state.approved!.summary.candidateHash).toBe(c.candidateHash);
      await expect(f.workflow.approve({ ticketId: c.ticketId, candidateHash: c.candidateHash })).rejects.toMatchObject({ code: 'stale-ticket' });
    } finally {
      release.resolve();
      fault.beforeRename = null;
      vi.useRealTimers();
    }
  });
  it('reports post-commit cleanup failure without a false rollback or duplicate approval', async () => {const f=await setup();const c=await candidate(f);fault.beforeUnlink=()=>{throw new Error('Synthetic cleanup failure');};const a=await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});expect(a.state).toBe('error');expect(a.persistence.state).toBe('commit-unknown');expect(a.canApprove).toBe(false);fault.beforeUnlink=null;const cache=createLocalSummaryCache({directory:path.join(f.root,contextScopeId('synthetic-dag')),codec:summaryCacheCodec});expect((await cache.read())!.payload.state.approved).not.toBeNull();});
});

it('does not send local provenance, canonical mapping or unselected titles even to the synthetic transport', async () => {
  const run=vi.fn(async ({prompt,claimIds}: Parameters<SyntheticSummaryTransport['run']>[0],emit:Parameters<SyntheticSummaryTransport['run']>[1])=>{
    expect(JSON.stringify(prompt)).not.toContain('SYNTHETIC-CANONICAL-MAPPING-ONLY'); expect(JSON.stringify(prompt)).not.toContain('upstream'); expect(JSON.stringify(prompt)).not.toContain('Synthetic B');
    expect(prompt.executionGate).toBe('requires-verified-restricted-orca-transport');
    await emit({type:'submitted'});await emit({type:'response',response:response(prompt,claimIds)});
  });
  const f=await setup({kind:'synthetic-test-only',run});expect((await candidate(f)).state).toBe('candidate');expect(run).toHaveBeenCalledTimes(1);
});
it('marks retained claims unknown if a fresh source cannot be verified at approval', async () => {
  const f=await setup();const c=await candidate(f);f.resolveSource.mockRejectedValueOnce(new Error('Synthetic source read unavailable'));
  const a=await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});expect(a.state).toBe('error');expect(a.candidateClaims.every(claim=>claim.freshness==='unknown')).toBe(true);expect(a.canApprove).toBe(false);expect(a.persistence.revision).toBe(1);
});
it('does not approve a restored all-unknown candidate bound to older selected evidence', async () => {
  const f=await setup({kind:'synthetic-test-only',async run({prompt},emit){await emit({type:'submitted'});const r=response(prompt);r.claims=r.claims.map(claim=>({...claim,kind:'unknown',citations:[],assertions:[]}));await emit({type:'response',response:r});}});
  const c=await candidate(f);expect(c.canApprove).toBe(true);f.change(s=>{s.dag.tasks[0].title='Changed selected evidence';});const p=await f.prepare();expect(p.candidateHash).toBe(c.candidateHash);expect(p.canApprove).toBe(false);expect(p.canReject).toBe(true);
  await expect(f.workflow.approve({ticketId:p.ticketId,candidateHash:p.candidateHash})).rejects.toMatchObject({code:'stale-ticket'});
});
it('blocks simultaneous approval and never uses a caller-provided approval event', async () => {
  const f=await setup();const c=await candidate(f);const reached=deferred();const release=deferred();fault.beforeRename=async()=>{reached.resolve();await release.promise;};
  const first=f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});await reached.promise;
  await expect(f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash})).rejects.toMatchObject({code:'stale-ticket'});
  release.resolve();expect((await first).state).toBe('approved');fault.beforeRename=null;
  await expect(f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash,kind:'user-summary-approval'})).rejects.toMatchObject({code:'invalid-request'});
});
it.skipIf(process.platform === 'win32')('rejects group/world-accessible roots, scopes and existing cache files without changing permissions', async () => {
  for (const target of ['root','scope','file']) {
    const f=await setup();if(target!=='root')await candidate(f);
    const filename=target==='root'?f.root:target==='scope'?path.join(f.root,contextScopeId('synthetic-dag')):path.join(f.root,contextScopeId('synthetic-dag'),'summary-cache-v1.json');
    await fs.chmod(filename,target==='file'?0o644:0o777);const p=await f.prepare();expect(p.state).toBe('error');expect(p.canApprove).toBe(false);expect((await fs.stat(filename)).mode&0o077).not.toBe(0);
  }
});
it.skipIf(process.platform === 'win32')('rejects a wrong POSIX cache owner rather than trusting imported approval bytes', async () => {
  const f=await setup();await candidate(f);const uid=process.geteuid!();const mocked=vi.spyOn(process,'geteuid').mockReturnValue(uid+1);
  try { const p=await f.prepare();expect(p.state).toBe('error');expect(p.approvedClaims).toEqual([]); } finally { mocked.mockRestore(); }
});
it.skipIf(process.platform === 'win32')('rechecks private cache permissions before approval write', async () => {
  const f=await setup();const c=await candidate(f);const filename=path.join(f.root,contextScopeId('synthetic-dag'),'summary-cache-v1.json');const prior=await fs.readFile(filename,'utf8');await fs.chmod(filename,0o666);
  const a=await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});expect(a.state).toBe('error');expect(a.approvedClaims).toEqual([]);expect(await fs.readFile(filename,'utf8')).toBe(prior);
});

it('read-only cache validation never creates a missing scope or follows a foreign scope path', async () => {
  const f=await setup();const directory=path.join(f.root,contextScopeId('synthetic-dag'));
  await expect(assertPrivateSummaryCachePath(f.root,directory)).rejects.toMatchObject({code:'ENOENT'});expect(await fs.readdir(f.root)).toEqual([]);
  await expect(assertPrivateSummaryCachePath(f.root,path.join(f.root,'..','outside'))).rejects.toMatchObject({code:'unsafe-cache'});
});

import { createRegisteredExcerptReader } from '../../src/summary/context/registered';
async function withRegisteredSource(f: Awaited<ReturnType<typeof setup>>) {
  const notes=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-summary-excerpts-')));directories.push(notes);
  const filename=path.join(notes,'goal.md');await fs.writeFile(filename,'PRIVATE HEADER\n목표: 근거가 있는 요약\nPRIVATE TAIL');
  const reader=createRegisteredExcerptReader({dagId:'synthetic-dag',canonicalScopePath:notes,canonicalNotePath:notes,registrations:[{id:'goal',kind:'goal-document',relativePath:'goal.md',startLine:2,endLine:2}],now:()=>now});
  f.resolveSource.mockImplementation(async()=>({...f.source(),registeredExcerpts:await reader.read('synthetic-dag')}));
  return {notes,filename};
}
describe('registered source workflow and saved checkpoint',()=>{
  it('shows bounded excerpts and byte/line provenance while preserving the production transport gate',async()=>{
    const f=await setup(null),files=await withRegisteredSource(f);const p=await f.prepare();
    const excerpt=p.preview?.records.find(r=>r.selection==='goal-document');expect(excerpt).toMatchObject({change:'new',excerpt:{lineStart:2,lineEnd:2}});
    expect(excerpt?.suppliedText).toContain('목표: 근거가 있는 요약');expect(JSON.stringify(p)).not.toContain(files.notes);expect(JSON.stringify(p)).not.toContain('PRIVATE HEADER');
    expect(p.preview?.checkpoint).toBe('new-baseline');expect(p.canRun).toBe(false);expect(p.transport).toBe('blocked');
  });
  it('blocks changed registered source approval, keeps prior approval history and restores changes after restart',async()=>{
    const f=await setup(),files=await withRegisteredSource(f);const c=await candidate(f);const approved=await f.workflow.approve({ticketId:c.ticketId,candidateHash:c.candidateHash});expect(approved.state).toBe('approved');
    await fs.writeFile(files.filename,'PRIVATE HEADER\n목표: 바뀐 요약 목표\nPRIVATE TAIL');f.workflow.dispose();
    const restarted=createSyntheticSummaryWorkflowForTests({cacheRoot:f.root,resolveSource:f.resolveSource,now:()=>now,transport:successful});workflows.push(restarted);
    const p=await restarted.prepare({workstreamId:'worktree-test',taskIds:['A'],provider:'claude'});
    expect(p.preview?.checkpoint).toBe('saved-summary');expect(p.preview?.records.find(r=>r.selection==='goal-document')?.change).toBe('changed');
    expect(p.approvedCandidateHash).toBe(approved.approvedCandidateHash);expect(p.canApprove).toBe(false);expect(p.canRun).toBe(true);
    const next=await restarted.run({ticketId:p.ticketId,provider:'claude'});expect(next.state).toBe('candidate');expect(next.canApprove).toBe(true);
    await fs.writeFile(files.filename,'PRIVATE HEADER\n목표: 검토 후 다시 변경됨\nPRIVATE TAIL');
    const stale=await restarted.approve({ticketId:next.ticketId,candidateHash:next.candidateHash});expect(stale.state).toBe('error');expect(stale.canApprove).toBe(false);expect(stale.approvedCandidateHash).toBe(approved.approvedCandidateHash);
  });
  it('starts a new baseline after unsaved preparation and preserves unchanged-source semantics after saved restart',async()=>{
    const f=await setup(),files=await withRegisteredSource(f);await f.prepare();f.workflow.dispose();await fs.writeFile(files.filename,'HEADER\n목표: 저장 전 변경\nTAIL');
    const restarted=createSyntheticSummaryWorkflowForTests({cacheRoot:f.root,resolveSource:f.resolveSource,now:()=>now,transport:successful});workflows.push(restarted);
    const p=await restarted.prepare({workstreamId:'worktree-test',taskIds:['A'],provider:'claude'});expect(p.preview?.checkpoint).toBe('new-baseline');expect(p.preview?.records.find(r=>r.selection==='goal-document')?.change).toBe('new');
    const c=await restarted.run({ticketId:p.ticketId,provider:'claude'});expect(c.state).toBe('candidate');restarted.dispose();
    const again=createSyntheticSummaryWorkflowForTests({cacheRoot:f.root,resolveSource:f.resolveSource,now:()=>now,transport:successful});workflows.push(again);
    const restored=await again.prepare({workstreamId:'worktree-test',taskIds:['A'],provider:'claude'});expect(restored.preview?.checkpoint).toBe('saved-summary');expect(restored.preview?.records.every(r=>r.change==='unchanged')).toBe(true);expect(restored.candidateHash).toBe(c.candidateHash);expect(restored.canApprove).toBe(true);
  });
});
