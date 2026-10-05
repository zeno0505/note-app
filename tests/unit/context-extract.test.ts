import { describe, expect, it } from 'vitest';
import type { DagReadModel, DagTask } from '../../src/facts/dag-read-model/types';
import { buildContextPack } from '../../src/summary/context';
import { contextScopeId, extractContextInput, taskContextSourceId, type ContextExtractionRequest } from '../../src/summary/context/extract';
const at = '2026-10-02T00:00:00.000Z';
const task = (id: string): DagTask => ({ id, title: `Synthetic ${id}`, status: 'running', dependencies: [], e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitVerification:'not-performed' });
function request(): ContextExtractionRequest {
  const a=task('A'), b=task('B'), c=task('C'); a.dependencies=[{id:'B',scope:'internal'}]; b.dependencies=[{id:'C',scope:'internal'}];
  const dag: DagReadModel = {dagId:'synthetic-dag',sourceHash:'a'.repeat(64),sourceMtimeMs:1,observedAt:at,doneStatus:'done',tasks:[a,b,c],statusCounts:[{status:'running',count:3}],coverage:{tasksTotal:3,declared:0,required:0,uncoveredDone:[],uncoveredOpen:[],malformed:[]},verifiedFacts:[]};
  return {schemaVersion:1,dagId:dag.dagId,dag,requestedTaskIds:['A'],excerpts:[],previousSources:[],priorApprovedSummary:null,limits:{maxBytes:32768,maxApproxTokens:32768,maxRecords:256}};
}
describe('explicit DAG slice to bounded context',()=>{
  it('includes explicit tasks and only minimal direct dependency declarations',()=>{
    const r=request(), input=extractContextInput(r);
    expect(input.records).toHaveLength(2);
    expect(input.records.map(x=>x.sourceId)).not.toContain(taskContextSourceId(r.dagId,'C'));
    const dep=input.records.find(x=>x.sourceId===taskContextSourceId(r.dagId,'B'))!;
    expect(dep.dependencies).toEqual([]); expect(dep.text).not.toContain('Synthetic B');
    expect(input.records.every(x=>x.sourceHash===`sha256:${r.dag.sourceHash}`)).toBe(true);
    expect(buildContextPack(input).records).toHaveLength(2);
  });
  it('is deterministic for reordered tasks, requests, dependencies and excerpts',()=>{
    const a=request(); a.requestedTaskIds=['B','A'];
    const b=structuredClone(a); b.dag.tasks.reverse(); b.requestedTaskIds.reverse();
    expect(extractContextInput(a)).toEqual(extractContextInput(b));
    expect(contextScopeId('synthetic-dag')).not.toBe(contextScopeId('other'));
    expect(taskContextSourceId('/synthetic/private','/synthetic/task')).not.toContain('/');
    expect(taskContextSourceId('a','bc')).not.toBe(taskContextSourceId('ab','c'));
  });
  it('keeps subset coverage honest and goal absent explicitly unknown',()=>{
    const r=request(); const result=extractContextInput(r);
    expect(result.coverage).toMatchObject({complete:false,totalCount:null});
    expect(result.coverage.unknowns.join(' ')).toContain('full DAG task count is 3');
    expect(result.coverage.unknowns.join(' ')).toContain('Goal document excerpt not supplied');
    r.requestedTaskIds=['A','B','C'];
    expect(extractContextInput(r).coverage.complete).toBe(false);
  });
  it('preserves unfamiliar status exactly in text, maps to unknown without using custom done as proof',()=>{
    const r=request(); r.dag.tasks[0].status='completed-ish';r.dag.doneStatus='completed-ish';
    const selected=extractContextInput(r).records.find(x=>x.sourceId===taskContextSourceId(r.dagId,'A'))!;
    expect(selected.declaredStatus).toBe('unknown');expect(selected.text).toContain('completed-ish');
  });
  it('carries E2E and commits as declarations, never testing/deployment/permission evidence',()=>{
    const r=request();r.dag.tasks[0].status='done';r.dag.tasks[0].commitReferences=['abc123'];r.dag.tasks[0].e2e={state:'declared',required:true,coveredBy:[],coverage:'unmet'};
    const selected=extractContextInput(r).records.find(x=>x.sourceId===taskContextSourceId(r.dagId,'A'))!;
    expect(selected.declaredStatus).toBe('done');expect(selected.text).toContain('unmet');expect(selected.text).toContain('abc123');
    expect(selected).not.toHaveProperty('tested');expect(selected.text).toContain('do not establish tests passed or deployment');
  });
  it('leaves missing and external dependencies unresolved, without inventing source records',()=>{
    const r=request();r.dag.tasks[0].dependencies=[{id:'external-1',scope:'external'},{id:'missing-1',scope:'internal'}];
    r.requestedTaskIds.push('missing-request');
    const pack=buildContextPack(extractContextInput(r));expect(pack.records).toHaveLength(1);
    expect(pack.records[0].dependencies.every(d=>d.declaredStatus==='unknown')).toBe(true);
    expect(pack.unresolvedDependencyIds).toHaveLength(2);
    expect(pack.coverage.unknowns.join(' ')).toContain('1 explicitly requested task IDs');
  });
  it('accepts only explicit scoped excerpts with separate provenance',()=>{
    const r=request();r.excerpts=[{scopeDagId:r.dagId,id:'goal-1',kind:'goal-document',sourceHash:`sha256:${'b'.repeat(64)}`,observedAt:at,text:'Synthetic goal\nOnly this excerpt'}];
    const result=extractContextInput(r);expect(result.records).toHaveLength(3);
    expect(result.coverage.unknowns.join(' ')).not.toContain('Goal document excerpt not supplied');
    expect(result.records.find(x=>x.sourceId.startsWith('excerpt-'))?.text).toContain('goal-document-excerpt');
    r.excerpts[0].scopeDagId='other';expect(()=>extractContextInput(r)).toThrow(/scope/);
  });
  it('fails closed for oversized selections, dependencies, text and mismatched identity',()=>{
    const mutations:Array<(r:ContextExtractionRequest)=>void>=[
      r=>{r.requestedTaskIds=Array.from({length:33},(_,i)=>String(i));},
      r=>{r.requestedTaskIds=['A','A'];}, r=>{r.dagId='other';},r=>{r.dag.sourceHash='bad';},
      r=>{r.dag.tasks[0].dependencies=Array.from({length:33},(_,i)=>({id:String(i),scope:'external'}));},
      r=>{r.dag.tasks[0].title='a'.repeat(4097);},
      r=>{r.dag.tasks.push(task('A'));r.dag.coverage.tasksTotal++;},
      r=>{r.dag.tasks[0].dependencies=[{id:'B',scope:'external'}];},
    ];
    for(const mutate of mutations){const r=request();mutate(r);expect(()=>extractContextInput(r)).toThrow();}
    expect(()=>extractContextInput({...request(),path:'/private'} as ContextExtractionRequest)).toThrow();
  });
  it('never inspects unselected task payload or follows direct dependency dependencies',()=>{
    const r=request();Object.defineProperty(r.dag.tasks[2],'title',{get(){throw new Error('unselected body touched');}});
    Object.defineProperty(r.dag.tasks[1],'dependencies',{get(){throw new Error('recursive walk attempted');}});
    expect(()=>extractContextInput(r)).not.toThrow();
  });
  it('conservatively invalidates every selected DAG record after an unrelated upstream edit',()=>{
    const r=request();
    const previous=extractContextInput(r);
    // C is not requested or a direct dependency, so its content is never packed.
    r.dag.tasks[2].title='Unrelated unselected task changed';
    r.dag.sourceHash='b'.repeat(64);
    r.previousSources=previous.records.map(({sourceId,sourceHash})=>({sourceId,sourceHash}));
    const next=extractContextInput(r);
    expect(next.records.map(x=>x.text)).toEqual(previous.records.map(x=>x.text));
    expect(next.records.map(x=>x.sourceId)).toEqual(previous.records.map(x=>x.sourceId));
    expect(buildContextPack(next).sources.every(x=>x.change==='changed')).toBe(true);
    expect(buildContextPack(next).packHash).not.toBe(buildContextPack(previous).packHash);
  });
  it('does not mutate caller data and permits a deliberately empty requested slice as unknown',()=>{
    const r=request(),before=structuredClone(r);extractContextInput(r);expect(r).toEqual(before);
    r.requestedTaskIds=[];const empty=extractContextInput(r);expect(empty.records).toEqual([]);expect(empty.coverage.totalCount).toBeNull();
  });
});
