import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import type {DagTask} from '../../src/facts/dag-read-model/types';
import {buildContextPack,serializeContextPack,type ContextPack} from '../../src/summary/context';
import {extractContextInput,type ContextExtractionRequest} from '../../src/summary/context/extract';
import {extractProjectionContext,projectionTaskSourceId,validateProjectionContext} from '../../src/summary/context/projection';
import {ASPECTS,bindSummaryContext,createSummaryStore,type SummaryResponse} from '../../src/summary/claims';
const at='2026-10-02T00:00:00.000Z';
const task=(id:string):DagTask=>({id,title:`Synthetic ${id}`,status:'running',dependencies:[],e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitVerification:'not-performed'});
function request():ContextExtractionRequest {
  return {schemaVersion:1,dagId:'synthetic-dag',dag:{dagId:'synthetic-dag',sourceHash:'a'.repeat(64),sourceMtimeMs:1,observedAt:at,doneStatus:'done',tasks:[task('A'),task('B'),task('C')],statusCounts:[{status:'running',count:3}],coverage:{tasksTotal:3,declared:0,required:0,uncoveredDone:[],uncoveredOpen:[],malformed:[]},verifiedFacts:[]},requestedTaskIds:['A','B'],excerpts:[],previousSources:[],priorApprovedSummary:null,limits:{maxBytes:32768,maxApproxTokens:32768,maxRecords:256}};
}
function response(pack:ContextPack):SummaryResponse {
  return {schemaVersion:1,...bindSummaryContext(pack),generatedAt:at,claims:ASPECTS.map((aspect,i)=>{
    const source=pack.records[i<3?0:1];
    return {claimId:aspect,aspect,kind:aspect==='next'?'inference':'fact',text:source.text,intent:aspect==='next'?'proposal':'informational',citations:[{sourceId:source.sourceId,sourceHash:source.sourceHash,observedAt:source.observedAt,quote:source.text}],assertions:[]};
  })};
}
function storeFor(pack:ContextPack){const store=createSummaryStore(pack);expect(store.acceptResponse(store.beginUpdate()!,response(pack))).toBe(true);return store;}
const digest=(text:string)=>`sha256:${createHash('sha256').update(text).digest('hex')}`;
describe('versioned immutable per-record projection evidence',()=>{
  it('hashes exact supplied artifact bytes and keeps upstream DAG provenance local',()=>{
    const result=extractProjectionContext(request());
    for(const e of result.provenance.entries){
      const record=result.input.records.find(r=>r.sourceId===e.sourceId)!;
      expect(record.text).toBe(e.artifact);expect(record.sourceHash).toBe(digest(e.artifact));
      expect(e.upstream.sourceHash).toBe(`sha256:${'a'.repeat(64)}`);
      expect(record.text).not.toContain(e.upstream.sourceHash);expect(record.text).not.toContain('synthetic-dag');
      expect(record.sourceId).toMatch(/^projection-v1-/);
    }
    expect(Object.isFrozen(result.provenance.entries)).toBe(true);
    expect(validateProjectionContext(result)).toEqual(result);
  });
  it('canonicalizes ordering and hashes UTF-8 exactly without leaking the local manifest to packs',()=>{
    const a=request();a.dag.tasks[0].title='합성 목표 🌱';a.dag.tasks[0].dependencies=[{id:'C',scope:'internal'},{id:'B',scope:'internal'}];
    a.dag.tasks[0].commitReferences=['ccc','aaa'];
    a.dag.tasks[0].e2e={state:'declared',required:true,coveredBy:['test-z','test-a'],coverage:'references-declared'};
    const b=structuredClone(a);b.requestedTaskIds.reverse();b.dag.tasks[0].dependencies.reverse();b.dag.tasks[0].commitReferences.reverse();b.dag.tasks[0].e2e.coveredBy!.reverse();b.dag.tasks.reverse();
    const first=extractProjectionContext(a),second=extractProjectionContext(b);
    expect(first).toEqual(second);
    expect(first.provenance.entries.every(e=>digest(e.artifact)===e.sourceHash)).toBe(true);
    const serialized=serializeContextPack(buildContextPack(first.input));
    expect(serialized).not.toContain('upstream');expect(serialized).not.toContain('provenance');expect(serialized).not.toContain(`sha256:${a.dag.sourceHash}`);
  });
  it('preserves hashes and summary-store no-op on unrelated unselected edits, while updating local provenance',()=>{
    const r=request(),first=extractProjectionContext(r),pack=buildContextPack(first.input),store=storeFor(pack);
    r.dag.tasks[2].title='Unselected synthetic change';r.dag.sourceHash='b'.repeat(64);r.dag.observedAt='2026-10-02T01:00:00.000Z';
    const second=extractProjectionContext(r);
    expect(second.input.records.map(r=>r.sourceHash)).toEqual(first.input.records.map(r=>r.sourceHash));
    expect(second.provenance.entries[0].upstream.sourceHash).not.toBe(first.provenance.entries[0].upstream.sourceHash);
    expect(store.updateContext(buildContextPack(second.input))).toEqual({changed:false,affectedClaimIds:[]});
    expect(store.beginUpdate()).toBeNull();
  });
  it.each(['title','status'] as const)('selected %s change invalidates only corresponding source and claims',field=>{
    const r=request(),first=extractProjectionContext(r),pack=buildContextPack(first.input),store=storeFor(pack);
    r.dag.tasks[0][field]=field==='title'?'Changed selected declaration':'blocked';r.dag.sourceHash='b'.repeat(64);
    const next=buildContextPack(extractProjectionContext(r).input);
    const changed=projectionTaskSourceId(r.dagId,'A');
    expect(next.sources.filter(s=>s.sourceHash!==pack.sources.find(p=>p.sourceId===s.sourceId)!.sourceHash).map(s=>s.sourceId)).toEqual([changed]);
    const expected=store.snapshot().candidate!.claims.filter(c=>c.citations.some(x=>x.sourceId===changed)).map(c=>c.claimId);
    expect(store.updateContext(next).affectedClaimIds).toEqual(expected);
  });
  it('dependency changes affect dependent artifact and only necessary dependency evidence',()=>{
    const r=request();const first=extractProjectionContext(r);
    r.dag.tasks[0].dependencies=[{id:'C',scope:'internal'},{id:'external',scope:'external'}];
    const second=extractProjectionContext(r);
    const a=projectionTaskSourceId(r.dagId,'A'),b=projectionTaskSourceId(r.dagId,'B');
    expect(second.input.records.find(x=>x.sourceId===a)!.sourceHash).not.toBe(first.input.records.find(x=>x.sourceId===a)!.sourceHash);
    expect(second.input.records.find(x=>x.sourceId===b)!.sourceHash).toBe(first.input.records.find(x=>x.sourceId===b)!.sourceHash);
    expect(second.input.records).toHaveLength(3);
    expect(validateProjectionContext(second)).toEqual(second);
    const c=second.input.records.find(x=>x.sourceId===projectionTaskSourceId(r.dagId,'C'))!;
    expect(c.dependencies).toEqual([]);expect(c.text).not.toContain('Synthetic C');
  });
  it('changing a dependency fact between already selected tasks refreshes only its dependent claims',()=>{
    const r=request(),first=buildContextPack(extractProjectionContext(r).input),store=storeFor(first);
    r.dag.tasks[0].dependencies=[{id:'B',scope:'internal'}];r.dag.sourceHash='b'.repeat(64);
    const next=buildContextPack(extractProjectionContext(r).input),a=projectionTaskSourceId(r.dagId,'A');
    const expected=store.snapshot().candidate!.claims.filter(c=>c.citations.some(x=>x.sourceId===a)).map(c=>c.claimId);
    expect(store.updateContext(next).affectedClaimIds).toEqual(expected);
    expect(next.sources.find(s=>s.sourceId===projectionTaskSourceId(r.dagId,'B'))!.sourceHash).toBe(first.sources.find(s=>s.sourceId===projectionTaskSourceId(r.dagId,'B'))!.sourceHash);
  });
  it('global source additions and coverage changes still invalidate aggregate claims',()=>{
    const r=request(),store=storeFor(buildContextPack(extractProjectionContext(r).input));
    r.dag.tasks.push(task('D'));r.dag.coverage.tasksTotal++;r.dag.sourceHash='b'.repeat(64);
    expect(store.updateContext(buildContextPack(extractProjectionContext(r).input)).affectedClaimIds).toHaveLength(6);
    const r2=request(),store2=storeFor(buildContextPack(extractProjectionContext(r2).input));r2.requestedTaskIds.push('C');
    expect(store2.updateContext(buildContextPack(extractProjectionContext(r2).input)).affectedClaimIds).toHaveLength(6);
  });
  it('keeps old contract approvals stale rather than silently migrating IDs',()=>{
    const r=request(),legacy=extractContextInput(r);
    r.previousSources=legacy.records.map(({sourceId,sourceHash})=>({sourceId,sourceHash}));
    r.priorApprovedSummary={text:'Previously approved synthetic legacy summary',approvedAt:at,approvalId:'decision-1',sources:r.previousSources};
    const pack=buildContextPack(extractProjectionContext(r).input);
    expect(pack.sources.every(s=>!r.previousSources.some(old=>old.sourceId===s.sourceId))).toBe(true);
    expect(pack.absentPreviousSources).toHaveLength(2);expect(pack.priorApprovedSummary!.freshness).toBe('stale');
  });
  it('rejects tampered artifacts, IDs, source hashes, upstream linkage and missing entries',()=>{
    const original=extractProjectionContext(request());
    const changes:Array<(x:ReturnType<typeof extractProjectionContext>)=>void>=[
      x=>{x.provenance.entries[0].artifact+=' ';},x=>{x.provenance.entries[0].sourceHash=`sha256:${'f'.repeat(64)}`;},
      x=>{x.provenance.entries[0].upstream.taskId='different';},x=>{x.provenance.entries[0].upstream.dagId='different';},
      x=>{x.provenance.entries[0].upstream.observedAt='2026-10-02T01:00:00.000Z';},x=>{x.provenance.entries.pop();},
      x=>{x.provenance.entries.push(x.provenance.entries[0]);},x=>{x.input.records[0].text='tampered';},
    ];
    for(const change of changes){const value=structuredClone(original);change(value);expect(()=>validateProjectionContext(value)).toThrow();}
  });
  it('rejects rehashed malformed and contradictory inner declarations',()=>{
    const original=extractProjectionContext(request());
    const changes:Array<(d:Record<string,any>)=>void>=[
      d=>{d.declaredStatusRaw='done';},d=>{d.extra='unsupported';},d=>{d.title='x'.repeat(4097);},
      d=>{d.selection='agent-chosen';},d=>{d.evidence='Verified deployed';},
      d=>{d.commitReferences=Array.from({length:33},(_,i)=>String(i));},
      d=>{d.e2eDeclaration.required=true;},d=>{d.e2eDeclaration.extra=true;},
    ];
    for(const change of changes){
      const result=structuredClone(original),entry=result.provenance.entries[0];
      const outer=JSON.parse(entry.artifact),inner=JSON.parse(outer.declaration);change(inner);
      outer.declaration=JSON.stringify(inner);entry.artifact=JSON.stringify(outer);entry.sourceHash=digest(entry.artifact);
      const record=result.input.records.find(r=>r.sourceId===entry.sourceId)!;record.text=entry.artifact;record.sourceHash=entry.sourceHash;
      expect(()=>validateProjectionContext(result)).toThrow();
    }
  });
  it('rejects rehashed recursive dependencies on minimal direct-dependency evidence',()=>{
    const r=request();r.requestedTaskIds=['A'];r.dag.tasks[0].dependencies=[{id:'B',scope:'internal'}];
    const result=structuredClone(extractProjectionContext(r));
    const entry=result.provenance.entries.find(e=>e.upstream.taskId==='B')!;
    const record=result.input.records.find(r=>r.sourceId===entry.sourceId)!;
    record.dependencies=[{sourceId:projectionTaskSourceId(r.dagId,'A'),declaredStatus:'running'}];
    const outer=JSON.parse(entry.artifact);outer.dependencies=record.dependencies;
    entry.artifact=JSON.stringify(outer);entry.sourceHash=digest(entry.artifact);record.text=entry.artifact;record.sourceHash=entry.sourceHash;
    expect(()=>validateProjectionContext(result)).toThrow(/recursive dependencies/);
  });
  it('rejects rehashed dependencies outside the projection source contract',()=>{
    const result=structuredClone(extractProjectionContext(request())),entry=result.provenance.entries[0];
    const record=result.input.records.find(r=>r.sourceId===entry.sourceId)!;
    record.dependencies=[{sourceId:'excerpt-arbitrary',declaredStatus:'unknown'}];
    const outer=JSON.parse(entry.artifact);outer.dependencies=record.dependencies;
    entry.artifact=JSON.stringify(outer);entry.sourceHash=digest(entry.artifact);record.text=entry.artifact;record.sourceHash=entry.sourceHash;
    expect(()=>validateProjectionContext(result)).toThrow(/wrong provenance contract/);
  });
  it('preserves conservative excerpt hashes and enforces existing bounds',()=>{
    const r=request();r.excerpts=[{scopeDagId:r.dagId,id:'document-1',kind:'goal-document',sourceHash:`sha256:${'c'.repeat(64)}`,observedAt:at,text:'Only explicitly selected synthetic excerpt'}];
    const result=extractProjectionContext(r);expect(result.input.records.find(r=>r.sourceId.startsWith('excerpt-'))!.sourceHash).toBe(r.excerpts[0].sourceHash);expect(result.provenance.entries).toHaveLength(2);
    r.requestedTaskIds=Array.from({length:33},(_,i)=>String(i));expect(()=>extractProjectionContext(r)).toThrow();
  });
});
