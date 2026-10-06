import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fixture from '../../fixtures/summary-quality/reading-pulls.json';
import {createReadingScheduler, explainReading, type ReadingInput} from '../../src/summary/reading';
import {parsePullObservation, type PullObservationResult} from '../../src/summary/reading/pulls';
import type {LiveDagTaskView} from '../../src/shared/live';

const at = fixture.observedAt;
function task(id: string, status = 'pending'): LiveDagTaskView {
  return {id, title: id === 'T-1' ? '프로젝트 읽기 화면' : '다음 작업', status, dependencies: [],
    commitReferences: [], commitVerification: 'not-performed', e2e: {state:'undeclared', required:null, coveredBy:null, coverage:'undeclared'},
    displayOmissions: {dependencies:0, commitReferences:0, e2eReferences:0}};
}
function input(): ReadingInput {
  return {workstream: {id:fixture.workstreamId, title:'합성 프로젝트', projectName:'합성', branch:'feature', archived:false,
    terminalConnected:false, terminalCount:0, agentState:'done', projectMapping:'matched', noteMapping:{state:'resolved',reason:null,dagId:fixture.dagId}},
    dag: {dagId:fixture.dagId, sourceHash:'d'.repeat(64), state:'ready', reason:null, observedAt:at, unchanged:false,
      taskCount:2, displayedTaskCount:2, tasks:[task('T-1','running'),task('T-2')], statusCounts:[], statusCountTotal:0,statusCountsOmitted:0,
      summary:{state:'empty',reason:'No model',revision:null,candidateClaims:[],approvedClaims:[],approvedAt:null,context:null}}};
}
const parsed = () => parsePullObservation(structuredClone(fixture), {workstreamId:fixture.workstreamId,dagId:fixture.dagId});
const text = (value: ReturnType<typeof explainReading>) => value.sections.flatMap(s=>s.paragraphs.map(p=>p.text)).join('\n');
const signal = () => new AbortController().signal;
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(at);});
afterEach(()=>vi.useRealTimers());

describe('four-section reading boundary',()=>{
  it('explains merged PR versus unchanged DAG without upgrading verification or deployment',()=>{
    const result=explainReading(input(),{state:'observed',value:parsed()});
    expect(result.sections.map(s=>s.id)).toEqual(['implemented','next','evidence','decisions']);
    expect(text(result)).toContain('PR #7 병합 관측과 DAG의 미완료 선언이 다릅니다');
    expect(text(result)).toContain('병합과 검수·배포 완료는 별개');
    expect(text(result)).toContain('설계가 끝나 구현만 남았는지는 미확인');
    expect(text(result)).toContain('이전 SHA의 리뷰는 현재 SHA 승인으로 사용하지 않습니다');
    expect(text(result)).not.toContain('리뷰는 승인 기록이 관측되었습니다');
    expect(result.sections.flatMap(s=>s.paragraphs.flatMap(p=>p.sources))).toContainEqual(expect.objectContaining({kind:'pull',sha:fixture.pulls[0].headSha,observedAt:at}));
  });
  it.each(['unresolved','squash-unverified'] as const)('does not associate %s PR with a task',mapping=>{
    const value=parsed();value.pulls[0].mapping=mapping;
    const result=explainReading(input(),{state:'observed',value});
    expect(result.partial).toBe(true);expect(text(result)).toContain('특정 작업의 완료 근거로 사용하지 않습니다');
    expect(text(result)).not.toContain('연결된 작업은');expect(text(result)).not.toContain('DAG의 미완료 선언이 다릅니다');
  });
  it.each(['open','closed'] as const)('does not report a %s PR merge preview SHA as an actual merge commit',state=>{
    const value=parsed();value.pulls[0].state=state;
    expect(text(explainReading(input(),{state:'observed',value}))).not.toContain('병합 커밋 식별자는 관측되었습니다');
  });
  it('rejects missing task mapping and current CI/review claims for older SHA',()=>{
    const value=parsed();value.pulls[0].taskIds=['foreign'];value.pulls[0].ci[0].sha='c'.repeat(40);
    const result=explainReading(input(),{state:'observed',value});
    expect(text(result)).toContain('성공 여부가 미확인');expect(text(result)).not.toContain('조회 범위의 체크가 성공');
    expect(text(result)).not.toContain('연결된 작업은');
  });
  it('preserves current changes requested independently of an approval record',()=>{
    const value=parsed();value.pulls[0].reviews=[{sha:fixture.pulls[0].headSha,state:'approved',reviewer:'human'},
      {sha:fixture.pulls[0].headSha,state:'changes-requested',reviewer:'coderabbit'}];
    expect(text(explainReading(input(),{state:'observed',value}))).toContain('수정 요청이 관측되었습니다');
  });
  it('preserves partial/empty observation and omitted dependencies as unknown',()=>{
    const data=input();data.dag!.taskCount=8;data.dag!.tasks[1].displayOmissions.dependencies=3;
    const value=parsed();value.coverage='partial';value.pulls=[];
    const result=explainReading(data,{state:'observed',value});
    expect(result.partial).toBe(true);expect(text(result)).toContain('다음 착수 후보를 확정할 근거는 부족');
    expect(text(result)).toContain('PR 부재나');
  });
  it('does not treat unknown external dependencies as ready or infer design from agent done',()=>{
    const data=input();data.dag!.tasks[1].dependencies=[{id:'outside',scope:'external'}];
    const result=explainReading(data,{state:'unconfigured'});
    expect(text(result)).not.toContain('다음 구현 후보입니다');expect(text(result)).toContain('설계 합의 여부가 없습니다');
    expect(text(result)).toContain('화면 검증');expect(text(result)).toContain('설정되지 않았습니다');
  });
  it('uses the explicitly configured completion vocabulary without upgrading it to verification',()=>{
    const data=input();data.dag!.doneStatus='accepted';data.dag!.tasks[0].status='accepted';
    data.dag!.tasks[1].dependencies=[{id:'T-1',scope:'internal'}];const result=explainReading(data,{state:'unconfigured'});
    expect(text(result)).toContain('작업 완료를 선언');expect(text(result)).toContain('다음 구현 후보입니다');
    expect(text(result)).toContain('실제 구현 검수나 배포 완료를 확인할 수는 없습니다');
  });
  it.each(['unresolved','error'] as const)('does not use historical DAG or PR linkage when mapping/reader is %s',state=>{
    const data=input();if(state==='unresolved') data.workstream.noteMapping.state='unresolved';else data.dag!.state='error';
    const result=explainReading(data,{state:'observed',value:parsed()});
    expect(text(result)).toContain('구현 범위를 판단할 수 없습니다');expect(text(result)).not.toContain('연결된 작업은');
  });
});

describe('reading scheduler',()=>{
  it('regenerates on content changes only, retaining evidence time and prior model/approval data',async()=>{
    const data=input();const before=structuredClone(data);const scheduler=createReadingScheduler();
    const first=await scheduler.update([data],signal());vi.setSystemTime(Date.parse(at)+5*60_000);data.dag!.observedAt=new Date().toISOString();data.dag!.unchanged=true;
    data.dag!.sourceHash='e'.repeat(64); // Unprojected source prose changed; the scoped explanation did not.
    const same=await scheduler.update([data],signal());expect(same[0]).toMatchObject({changed:false,revision:1,generatedAt:first[0].generatedAt,checkedAt:new Date().toISOString()});
    expect(same[0].sections).toEqual(first[0].sections);expect(data.dag!.summary).toEqual(before.dag!.summary);
    data.dag!.tasks[0].status='done';const changed=await scheduler.update([data],signal());expect(changed[0]).toMatchObject({changed:true,revision:2});
    expect(changed[0].sections[0].paragraphs[0].text).toContain('작업 완료를 선언');
  });
  it('observes PR-only changes when DAG bytes stay unchanged',async()=>{
    let value=parsed();value.pulls[0].state='open';const read=vi.fn(async()=>value);const scheduler=createReadingScheduler({adapter:{read}});
    const first=await scheduler.update([input()],signal());value=structuredClone(value);value.pulls[0].state='merged';
    const second=await scheduler.update([input()],signal());expect(second[0].revision).toBe(first[0].revision+1);
    expect(second[0].sections[0].paragraphs.some(p=>p.text.includes('미완료 선언이 다릅니다'))).toBe(true);
  });
  it('does not regenerate identical evidence on reconnect and removes departed scope history',async()=>{
    const scheduler=createReadingScheduler();const first=await scheduler.update([input()],signal());scheduler.cancel();
    const same=await scheduler.update([input()],signal());expect(same[0]).toMatchObject({changed:false,revision:1,generatedAt:first[0].generatedAt});
    await scheduler.update([],signal());const returned=await scheduler.update([input()],signal());expect(returned[0].changed).toBe(true);
  });
  it('preserves branch/CI evidence time across polls, reports stale CI and visible rate limits honestly',async()=>{
    let value=parsed();value.pulls=[];value.branch={name:'feat/phase1-foundation',headSha:'a'.repeat(40),ci:[{id:3,sha:'a'.repeat(40),state:'success',event:'push'}],ciFreshness:'current',ciObservedAt:at};
    const read=vi.fn(async()=>structuredClone(value));const scheduler=createReadingScheduler({adapter:{read}});
    const first=await scheduler.update([input()],signal());vi.setSystemTime(Date.parse(at)+20_000);value.observedAt=new Date().toISOString();value.branch.ciObservedAt=value.observedAt;
    const same=await scheduler.update([input()],signal());expect(same[0].changed).toBe(false);expect(same[0].generatedAt).toBe(first[0].generatedAt);
    value.branch.ciFreshness='historical';const stale=await scheduler.update([input()],signal());expect(stale[0].sections.flatMap(s=>s.paragraphs.map(p=>p.text)).join('\n')).toContain('현재 재확인되지 않은 이전');
    read.mockRejectedValueOnce({kind:'rate-limit'});const limited=await scheduler.update([input()],signal());
    expect(limited[0].sections.flatMap(s=>s.paragraphs.map(p=>p.text)).join('\n')).toContain('공개 조회 한도');
  });
  it('joins concurrent manual/scheduled same-scope requests and snapshots caller input',async()=>{
    const pending=deferred<unknown>();const read=vi.fn(()=>pending.promise);const scheduler=createReadingScheduler({adapter:{read}});const data=input();
    const scheduled=scheduler.update([data],signal());const manual=scheduler.update([data],signal());expect(manual).toBe(scheduled);
    data.dag!.tasks[0].status='done';pending.resolve(parsed());const result=await manual;expect(read).toHaveBeenCalledTimes(1);
    expect(result[0].sections[0].paragraphs.some(p=>p.text.includes('미완료 선언이 다릅니다'))).toBe(true);
  });
  it('keeps last good PR evidence explicitly historical on observation failure',async()=>{
    const read=vi.fn().mockResolvedValueOnce(parsed()).mockRejectedValueOnce(new Error('PRIVATE_ERROR'));const scheduler=createReadingScheduler({adapter:{read}});
    await scheduler.update([input()],signal());const result=await scheduler.update([input()],signal());const all=result[0].sections.flatMap(s=>s.paragraphs.map(p=>p.text)).join('\n');
    expect(all).toContain('조회 실패 전에 저장한 이전 관측');expect(all).toContain('이전 관측에서 PR #7');expect(all).not.toContain('PRIVATE_ERROR');
    expect(result[0].partial).toBe(true);expect(all).not.toContain('DAG의 미완료 선언이 다릅니다');
  });
  it('cancels and rejects late publication on disconnect, then excludes foreign retained scope',async()=>{
    const pending=deferred<unknown>();const read=vi.fn(()=>pending.promise);const scheduler=createReadingScheduler({adapter:{read}});const abort=new AbortController();
    const work=scheduler.update([input()],abort.signal);const rejected=expect(work).rejects.toThrow('Reading cancelled');
    await Promise.resolve();abort.abort();pending.resolve(parsed());await rejected;
    scheduler.cancel();const next=input();next.workstream.id='new';const result=await scheduler.update([next],signal());
    expect(result[0].workstreamId).toBe('new');expect(result[0].sections.flatMap(s=>s.paragraphs).some(p=>p.text.includes('이전 관측에서'))).toBe(false);
  });
  it('does not start adapter IO if cancelled before its queued invocation',async()=>{
    const read=vi.fn(async()=>parsed());const scheduler=createReadingScheduler({adapter:{read}});const abort=new AbortController();
    const work=scheduler.update([input()],abort.signal);const rejected=expect(work).rejects.toThrow('Reading cancelled');abort.abort();await rejected;
    expect(read).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('supersedes an in-flight scope/mapping change and rejects an old result',async()=>{
    const pending=deferred<unknown>();const scheduler=createReadingScheduler({adapter:{read:()=>pending.promise}});
    const old=scheduler.update([input()],signal());const rejected=expect(old).rejects.toThrow('Reading cancelled');await Promise.resolve();
    const next=input();next.workstream.noteMapping={state:'unresolved',reason:'changed',dagId:null};
    const result=await scheduler.update([next],signal());pending.resolve(parsed());await rejected;
    expect(result[0].sections[0].paragraphs[0].text).toContain('구현 범위를 판단할 수 없습니다');
  });
  it('bounds stalled adapter responses and retires them rather than accumulating retries',async()=>{
    const pending=deferred<unknown>();const read=vi.fn(()=>pending.promise);const scheduler=createReadingScheduler({adapter:{read},deadlineMs:50});
    const work=scheduler.update([input()],signal());await vi.advanceTimersByTimeAsync(51);const result=await work;
    expect(result[0].partial).toBe(true);pending.resolve(parsed());await scheduler.update([input()],signal());expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never queries a missing/foreign DAG mapping',async()=>{
    const read=vi.fn();const scheduler=createReadingScheduler({adapter:{read}});const data=input();data.workstream.noteMapping.state='unresolved';
    await scheduler.update([data],signal());expect(read).not.toHaveBeenCalled();
  });
  it('bounds per-batch fanout and rejects old/future observation time',async()=>{
    const read=vi.fn(async (selection:{workstreamId:string;dagId:string})=>({...parsed(),...selection}));const scheduler=createReadingScheduler({adapter:{read}});
    const data=Array.from({length:10},(_,i)=>{const v=input();v.workstream.id=`scope-${i}`;return v;});const result=await scheduler.update(data,signal());
    expect(read).toHaveBeenCalledTimes(8);expect(result).toHaveLength(10);expect(result[9].partial).toBe(true);
    for(const offset of [-300_001,1]) {
      const value=parsed();value.observedAt=new Date(Date.parse(at)+offset).toISOString();
      const [summary]=await createReadingScheduler({adapter:{read:async()=>value}}).update([input()],signal());
      expect(summary.sections.flatMap(s=>s.paragraphs).some(p=>p.text.includes('조회를 완료하지 못했습니다'))).toBe(true);
    }
  });
  it('rejects duplicate/excessive scopes and already cancelled requests',async()=>{
    const scheduler=createReadingScheduler();await expect(scheduler.update([input(),input()],signal())).rejects.toThrow('scope limit');
    await expect(scheduler.update(Array.from({length:1001},(_,i)=>{const v=input();v.workstream.id=String(i);return v;}),signal())).rejects.toThrow('scope limit');
    const abort=new AbortController();abort.abort();await expect(scheduler.update([input()],abort.signal)).rejects.toThrow('cancelled');
  });
});

describe('pull adapter response contract',()=>{
  it.each(['scope','sha','extra','duplicate','size','time'] as const)('rejects invalid %s rather than treating it as empty success',kind=>{
    const data:any=structuredClone(fixture);
    if(kind==='scope')data.workstreamId='foreign';if(kind==='sha')data.pulls[0].headSha='not-a-sha';if(kind==='extra')data.secret='denied';
    if(kind==='duplicate')data.pulls.push(structuredClone(data.pulls[0]));if(kind==='size')data.pulls=Array(33).fill(data.pulls[0]);if(kind==='time')data.observedAt='yesterday';
    expect(()=>parsePullObservation(data,{workstreamId:fixture.workstreamId,dagId:fixture.dagId})).toThrow();
  });
});
