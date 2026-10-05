import {appendFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ASPECTS,bindSummaryContext,type SummaryResponse} from '../../../src/summary/claims';
import type {SyntheticSummaryTransport} from '../../../src/summary/workflow/transport';

/** Compiled only into the separate test entry, never the shipped main. */
export function fixtureTransport(controlPath:string,logPath:string):SyntheticSummaryTransport {
  const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
  return {kind:'synthetic-test-only',async run(request,emit){
    const runId=randomUUID();
    const log=(event:Record<string,unknown>)=>appendFile(logPath,JSON.stringify({at:new Date().toISOString(),...event,ticketId:request.ticketId,runId})+'\n');
    const control=JSON.parse(await readFile(controlPath,'utf8')) as {mode:string;submittedDelayMs:number;waitingDelayMs:number;responseDelayMs:number};
    await log({event:'run',provider:request.provider,mode:control.mode,selectedRecords:request.prompt.pack.records.length,claimIds:request.claimIds});
    await emit({type:'submitted'});await log({event:'submitted'});await pause(control.submittedDelayMs);
    if(control.mode==='submission-unknown'){await emit({type:'submission-unknown',retryRequestId:'fictional-submission-handle'});await log({event:'submission-unknown'});return;}
    await emit({type:'waiting'});await log({event:'waiting'});await pause(control.waitingDelayMs);
    await emit({type:'tui-idle'});await log({event:'tui-idle'});await pause(control.responseDelayMs);
    const pack=request.prompt.pack,source=pack.records[0];
    if(!source)throw new Error('Synthetic fixture requires one supplied source');
    const artifact=JSON.parse(source.text) as {declaration:string};
    const declaration=JSON.parse(artifact.declaration) as {taskId?:string;title?:string;declaredStatusRaw?:string};
    const label=declaration.title??declaration.taskId??'선택한 가상 작업';
    const textByAspect={
      goal:'목표 문서가 제공되지 않아 프로젝트의 전체 목표는 확인할 수 없습니다.',
      implemented:`${label}의 선언 상태는 ${declaration.declaredStatusRaw??'미확인'}입니다. 이 기록만으로 테스트나 배포 완료를 판단하지 않습니다.`,
      remaining:'남은 구현 범위는 이 작업 조각만으로 확정할 수 없습니다. 관련 작업과 검증 기록을 함께 확인해야 합니다.',
      current:`현재 검토 범위는 선택한 작업 ${pack.records.length}개 근거입니다. 실제 에이전트가 작업 중인지는 확인되지 않았습니다.`,
      next:'다음 단계 제안: 선언된 상태와 검증 근거를 사람이 확인하세요. 이 제안은 실행 승인이 아닙니다.',
      blockers:source.dependencies.length?'직접 의존성 선언이 있습니다. 외부 또는 미확인 의존성의 충족 여부는 별도로 확인해야 합니다.':'이 근거에 직접 의존성은 선언되지 않았습니다. 다른 차단 요인이 없다는 뜻은 아닙니다.',
    };
    const claims=ASPECTS.map(aspect=>({claimId:aspect,aspect,kind:aspect==='goal'?'unknown' as const:'inference' as const,
      text:textByAspect[aspect],intent:aspect==='next'?'proposal' as const:'informational' as const,
      citations:aspect==='goal'?[]:[{sourceId:source.sourceId,sourceHash:source.sourceHash,observedAt:source.observedAt,quote:source.text}],
      assertions:aspect==='goal'?[]:[{type:'declared-status' as const,sourceId:source.sourceId,status:source.declaredStatus}]}));
    const response:SummaryResponse={schemaVersion:1,...bindSummaryContext(pack),generatedAt:new Date().toISOString(),claims:request.claimIds?claims.filter(claim=>request.claimIds!.includes(claim.claimId)):claims};
    if(control.mode==='invalid-citation')response.claims.find(claim=>claim.citations.length)!.citations[0].quote='This sentence is not in the supplied source.';
    if(control.mode==='invalid-binding')response.packHash=`sha256:${'0'.repeat(64)}`;
    // Intentionally ignore AbortSignal to prove the host rejects a late response.
    await log({event:'response-attempt',aborted:request.signal.aborted,mode:control.mode});
    await emit({type:'response',response});await log({event:'response-emitted',aborted:request.signal.aborted});
  }};
}
