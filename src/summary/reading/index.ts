import { createHash } from 'node:crypto';
import type { LiveDagView, LiveWorkstreamView } from '../../shared/live';
import type { ReadingParagraph, ReadingSection, ReadingSource, ReadingSummary } from '../../shared/reading-summary';
import { parsePullObservation, type PullObservationAdapter, type PullObservationResult } from './pulls';

export interface ReadingInput { workstream: LiveWorkstreamView; dag?: LiveDagView }
type PullState = {state: 'unconfigured'} | {state: 'error'; retained?: PullObservationResult;reason?:'rate-limit'} | {state: 'observed'; value: PullObservationResult};
const LIMITATION = '고정 규칙으로 관측 기록을 설명합니다. 코드의 실제 동작·설계 합의·우선순위를 자유롭게 추론하지 않습니다. 기존 6관점의 저장 요약과 사용자 승인 기록은 별도로 유지합니다.';
const paragraph = (text: string, basis: ReadingParagraph['basis'] = 'unknown', sources: ReadingSource[] = []): ReadingParagraph => ({text, basis, sources});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function source(dag: LiveDagView): ReadingSource {
  return {kind: 'dag', id: dag.dagId, sha: null, sourceHash: dag.sourceHash ?? null, observedAt: dag.observedAt};
}
function names(tasks: LiveDagView['tasks']): string {
  return tasks.slice(0, 5).map(t => `${t.id} ${t.title ?? '(제목 미선언)'}`).join(', ') + (tasks.length > 5 ? ' 등 (문장 표시 상한 적용)' : '');
}
export function explainReading(input: ReadingInput, pulls: PullState): {sections: ReadingSection[]; partial: boolean} {
  const dag = input.workstream.noteMapping.state === 'resolved' && input.dag?.dagId === input.workstream.noteMapping.dagId ? input.dag : undefined;
  const available = dag?.state === 'ready';
  const sources = dag ? [source(dag)] : [];
  const implemented: ReadingParagraph[] = [];
  const next: ReadingParagraph[] = [];
  const evidence: ReadingParagraph[] = [];
  const decisions: ReadingParagraph[] = [];
  let partial = !available || dag?.taskCount !== dag?.displayedTaskCount || (pulls.state === 'observed' && pulls.value.coverage === 'partial');
  if (!available || !dag) {
    implemented.push(paragraph('노트·DAG 연결 또는 현재 조회를 확인하지 못해 구현 범위를 판단할 수 없습니다. 기존 기록이 있어도 현재 구현 완료로 취급하지 않습니다.', 'unknown', sources));
    next.push(paragraph('현재 작업과 의존성을 확인할 수 없어 다음 구현을 제안하지 않습니다.', 'unknown', sources));
  } else {
    const doneStatus = dag.doneStatus ?? 'done';
    const done = dag.tasks.filter(t => t.status === doneStatus);
    const running = dag.tasks.filter(t => t.status === 'running');
    const remaining = dag.tasks.filter(t => t.status !== doneStatus);
    implemented.push(done.length
      ? paragraph(`DAG는 ${names(done)}의 작업 완료를 선언합니다. 이 선언만으로 실제 구현 검수나 배포 완료를 확인할 수는 없습니다.`, 'declaration', sources)
      : paragraph('현재 표시 범위의 DAG에는 완료로 선언된 작업이 없습니다. 실제 구현이 없다는 뜻은 아닙니다.', 'declaration', sources));
    if (running.length) implemented.push(paragraph(`DAG는 ${names(running)}을 진행 중으로 기록합니다. 현재 에이전트 실행 여부와는 별개입니다.`, 'declaration', sources));
    const ready = remaining.filter(t => t.status === 'pending' && t.displayOmissions.dependencies === 0 && t.dependencies.every(d => d.scope === 'internal' && dag.tasks.some(other => other.id === d.id && other.status === doneStatus)));
    if (ready.length) next.push(paragraph(`${names(ready)}은 표시된 내부 의존성의 완료 선언을 기준으로 다음 구현 후보입니다. 설계 합의·우선순위·실행 승인은 확인하지 않았습니다.`, 'proposal', sources));
    else next.push(paragraph(remaining.length ? `남은 선언 작업은 ${names(remaining)}입니다. 다음 착수 후보를 확정할 근거는 부족합니다.` : '표시 범위에 남은 선언 작업이 없습니다. 전체 구현이 검증되었다는 뜻은 아닙니다.', 'declaration', sources));
    const blocked = dag.tasks.filter(t => t.status === 'blocked');
    if (blocked.length) decisions.push(paragraph(`${names(blocked)}은 DAG에 차단 상태로 선언되어 있습니다. 차단 이유와 필요한 결정은 별도 기록 확인이 필요합니다.`, 'declaration', sources));
    if (dag.taskCount !== dag.displayedTaskCount || dag.tasks.some(t => Object.values(t.displayOmissions).some(n => n > 0))) {
      partial = true;
      evidence.push(paragraph('작업 또는 참조 표시 상한이 적용되었습니다. 생략된 범위의 완료·의존성·검수는 판단하지 않습니다.', 'unknown', sources));
    }
  }
  decisions.push(paragraph('현재 구조화된 관측에는 설계 합의 여부가 없습니다. 논의가 필요한지, 설계가 끝나 구현만 남았는지는 미확인입니다.'));
  evidence.push(paragraph('실제 화면 검증, 테스트 코드 실행 결과, 배포 결과는 현재 관측에 연결되지 않았습니다. DAG의 E2E 참조와 커밋 참조는 실행·통과 증명이 아닙니다.', 'unknown', sources));
  if (pulls.state !== 'observed') {
    evidence.push(paragraph(pulls.state === 'error' ? 'PR·CI·리뷰 조회를 완료하지 못했습니다. 이 실패를 승인 또는 검증 완료로 바꾸지 않습니다.' : '실제 PR·CI·리뷰 조회 대상과 연결이 설정되지 않았습니다. DAG가 최신이라고 가정하지 않습니다.'));
    partial = true;
    if(pulls.state==='error'&&pulls.reason==='rate-limit')evidence.push(paragraph('GitHub 공개 조회 한도에 따라 대기 중입니다. 자동 재시도나 새 인증 시도로 우회하지 않습니다.'));
  }
  const observation = pulls.state === 'observed' ? pulls.value : pulls.state === 'error' ? pulls.retained : undefined;
  if (observation) {
    const historical = pulls.state !== 'observed';
    if (historical) evidence.push(paragraph('아래 PR·CI·리뷰는 조회 실패 전에 저장한 이전 관측입니다. 현재 상태로 재확인되지 않았습니다.'));
    if (observation.coverage === 'partial') evidence.push(paragraph('PR 관측이 부분 결과입니다. 보이지 않는 PR·CI·리뷰가 없다고 판단하지 않습니다.'));
    if (!observation.pulls.length) evidence.push(paragraph('지정된 PR 조회 범위에서 PR을 관측하지 못했습니다. 프로젝트 전체의 PR 부재나 구현 완료를 뜻하지 않습니다.'));
    if(observation.branch) {
      const branch=observation.branch;
      const ref:ReadingSource={kind:'git',id:`${observation.repository}:${branch.name}`,sha:branch.headSha,sourceHash:null,observedAt:observation.observedAt};
      evidence.push(paragraph(`${historical?'이전 관측에서 ':''}${branch.name} 브랜치의 head 커밋을 확인했습니다. 브랜치 커밋과 PR 병합 근거는 구별합니다.`,historical?'unknown':'observation',[ref]));
      const current=!historical&&branch.ciFreshness==='current';
      const runs=branch.ci;
      const ciSources:ReadingSource[]=runs.map(run=>({kind:'ci',id:`${observation.repository}:actions/${run.id}`,sha:run.sha,sourceHash:null,observedAt:branch.ciObservedAt}));
      const result=runs.length&&runs.every(run=>run.state==='success')?'조회한 workflow가 성공했습니다':runs.some(run=>run.state==='failure')?'실패한 workflow가 있습니다':runs.some(run=>run.state==='pending')?'진행 중인 workflow가 있습니다':'workflow 성공 여부가 미확인입니다';
      evidence.push(paragraph(`${current?'':'현재 재확인되지 않은 이전 또는 미확인 근거입니다. '}${branch.name} head SHA의 CI는 ${result}.${runs.some(run=>run.event==='push')?' 직접 푸시로 시작된 실행이 포함되어 있습니다.':''} PR 승인·필수 체크 전체 충족·화면 검수·배포 완료는 확인하지 않았습니다.`,current?'observation':'unknown',[ref,...ciSources]));
      evidence.push(paragraph('현재 브랜치 커밋과 DAG 작업의 대응 관계는 검증하지 않았습니다. CI 성공이나 직접 푸시를 특정 작업의 완료로 자동 연결하지 않습니다.','unknown',[...sources,ref]));
    }
    if(observation.issues?.length) evidence.push(paragraph('외부 관측에 일부 조회 실패·상한·부분 결과가 있습니다. 빠진 CI·리뷰를 완료로 추정하지 않습니다.'));
    if(observation.issues?.includes('rate-limit')) evidence.push(paragraph('GitHub 공개 조회 한도에 따라 추가 조회를 대기합니다. 관측하지 못한 근거는 미확인입니다.'));
    for (const pull of observation.pulls.slice(0, 8)) {
      const ref: ReadingSource = {kind: 'pull', id: `${observation.repository}#${pull.number}`, sha: pull.headSha, sourceHash: null, observedAt: observation.observedAt};
      const linked = !historical && available && pull.mapping === 'verified' && pull.taskIds.length > 0 && !!dag && pull.taskIds.every(id => dag.tasks.some(t => t.id === id));
      if (!linked) {
        evidence.push(paragraph(`PR #${pull.number}은 ${pull.mapping === 'squash-unverified' ? 'squash 병합과 원래 작업 커밋의 대응' : 'DAG 작업과의 연결'}이 미확인입니다. 특정 작업의 완료 근거로 사용하지 않습니다.`, 'unknown', [ref]));
        partial = true;
      } else {
        const tasks = dag!.tasks.filter(t => pull.taskIds.includes(t.id));
        const merged = pull.state === 'merged';
        implemented.push(paragraph(`PR #${pull.number}은 ${merged ? '병합된 상태' : pull.state === 'open' ? '열린 상태' : '닫힌 상태'}로 관측되었습니다. 연결된 작업은 ${names(tasks)}입니다. 병합과 검수·배포 완료는 별개의 사실입니다.`, 'observation', [ref]));
        if (merged && tasks.some(t => t.status !== (dag!.doneStatus ?? 'done'))) implemented.push(paragraph(`PR #${pull.number} 병합 관측과 DAG의 미완료 선언이 다릅니다. DAG 갱신 누락인지 추가 작업이 남았는지 확인이 필요합니다. DAG는 자동 수정하지 않습니다.`, 'observation', [...sources, ref]));
      }
      const currentCI = pull.ci.filter(c => c.sha === pull.headSha);
      const passed = currentCI.length > 0 && currentCI.every(c => c.state === 'success');
      evidence.push(paragraph(`${historical ? '이전 관측에서 ' : ''}PR #${pull.number}의 관측된 head SHA에 해당하는 CI는 ${passed ? '조회 범위의 체크가 성공했습니다' : currentCI.some(c => c.state === 'failure') ? '실패한 체크가 있습니다' : currentCI.some(c => c.state === 'pending') ? '진행 중인 체크가 있습니다' : '성공 여부가 미확인입니다'}. 필수 체크 전체 충족이나 병합 이후 SHA의 검증·배포는 확인하지 않았습니다.`, passed && !historical ? 'observation' : 'unknown', [ref, ...currentCI.map(c => ({...ref, kind: 'ci' as const, sha: c.sha}))]));
      const reviewSources = pull.reviews.map(r => ({...ref, kind: 'review' as const, id: `${ref.id}:${r.reviewer}`, sha: r.sha}));
      const currentReviews = pull.reviews.filter(r => r.sha === pull.headSha);
      evidence.push(paragraph(`${historical ? '이전 관측에서 ' : ''}PR #${pull.number}의 관측된 head SHA 리뷰는 ${currentReviews.some(r => r.state === 'changes-requested') ? '수정 요청이 관측되었습니다' : currentReviews.some(r => r.state === 'approved') ? '승인 기록이 관측되었습니다' : '완료 여부가 미확인입니다'}.${pull.reviews.some(r => r.sha !== pull.headSha) ? ' 이전 SHA의 리뷰는 현재 SHA 승인으로 사용하지 않습니다.' : ''} 리뷰 기록만으로 화면 검수나 전체 품질 기준 충족을 판단하지 않습니다.`, historical ? 'unknown' : 'observation', [ref, ...reviewSources]));
      if (pull.state === 'merged' && pull.mergeSha) evidence.push(paragraph(`${historical ? '이전 관측에서 ' : ''}PR #${pull.number}의 병합 커밋 식별자는 관측되었습니다. 해당 커밋의 검증·배포 결과는 별도 확인이 필요합니다.`, historical ? 'unknown' : 'observation', [{...ref, sha: pull.mergeSha}]));
    }
    if (observation.pulls.length > 8) {partial = true; evidence.push(paragraph('PR 설명은 8개까지 표시합니다. 추가 PR은 이 요약의 판단 범위에서 제외되었습니다.'));}
  }
  return {partial, sections: [
    {id: 'implemented', title: '현재 어디까지 구현되었나요?', paragraphs: implemented},
    {id: 'next', title: '다음에는 무엇을 구현하나요?', paragraphs: next},
    {id: 'evidence', title: '완료 판단에 어떤 근거가 있나요?', paragraphs: evidence},
    {id: 'decisions', title: '논의하거나 결정할 일이 있나요?', paragraphs: decisions},
  ]};
}

function semantics(input: ReadingInput, pulls: PullState): unknown {
  const {workstream: w, dag: d} = input;
  return {workstreamId: w.id, mapping: w.noteMapping, dag: d ? {dagId: d.dagId, state: d.state,
    doneStatus: d.doneStatus, tasks: d.tasks, taskCount: d.taskCount, displayedTaskCount: d.displayedTaskCount} : null,
    pulls: pulls.state === 'observed' ? {state: pulls.state, ...pulls.value, observedAt: undefined,
      ...(pulls.value.branch?{branch:{...pulls.value.branch,ciObservedAt:undefined}}:{})} : pulls};
}

/** Called after successful collection, using its cadence; owns no background service.
 * Only the scoped observation seam can await IO. No model, approvals or file writes.
 */
export function createReadingScheduler(options: {adapter?: PullObservationAdapter; now?: () => number; deadlineMs?: number} = {}) {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? 5_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5_000) throw new Error('Invalid reading deadline');
  let generation = 0;
  let cached = new Map<string, ReadingSummary>();
  let retainedPulls = new Map<string, PullObservationResult>();
  let adapterRetired = false;
  let controller: AbortController | null = null;
  let flight: {key: string; promise: Promise<ReadingSummary[]>} | null = null;
  function cancel(clear = false) {
    generation++; controller?.abort(); controller = null; flight = null;
    if (clear) {cached.clear(); retainedPulls.clear();}
  }
  return {
    cancel,
    update(inputs: ReadingInput[], signal: AbortSignal, intent: 'scheduled'|'manual' = 'scheduled'): Promise<ReadingSummary[]> {
      if (signal.aborted) return Promise.reject(new Error('Reading cancelled'));
      if (inputs.length > 1_000 || new Set(inputs.map(i => i.workstream.id)).size !== inputs.length) return Promise.reject(new Error('Reading scope limit'));
      inputs = structuredClone(inputs);
      const key = digest(inputs.map(i => semantics(i, {state: 'unconfigured'})));
      if (flight?.key === key) return flight.promise;
      controller?.abort(); const epoch = ++generation; const owned = new AbortController(); controller = owned;
      const abort = () => owned.abort(); signal.addEventListener('abort', abort, {once: true});
      const promise = (async () => {
        const summaries: ReadingSummary[] = [];
        const next = new Map<string, ReadingSummary>();
        const nextPulls = new Map<string, PullObservationResult>();
        let adapterReads = 0;
        const batchStarted = now();
        for (const input of inputs) {
          let pulls: PullState = {state: 'unconfigured'};
          const selection = {workstreamId: input.workstream.id, dagId: input.workstream.noteMapping.dagId};
          if (options.adapter && selection.dagId && input.workstream.noteMapping.state === 'resolved' && input.dag?.state === 'ready') {
            const query = {...selection, dagId: selection.dagId};
            const readController = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abortRead: (() => void) | undefined;
            try {
              if (adapterRetired || adapterReads >= 8 || now() - batchStarted >= deadlineMs) throw new Error('Observation adapter unavailable');
              adapterReads++;
              const pending = Promise.resolve().then(() => {
                if (owned.signal.aborted || readController.signal.aborted) throw new Error('Reading cancelled');
                return options.adapter!.read(query, readController.signal, intent);
              });
              const bounded = new Promise<never>((_, reject) => {
                abortRead = () => {adapterRetired = true; readController.abort(); reject(new Error('Reading cancelled'));};
                owned.signal.addEventListener('abort', abortRead, {once: true});
                timer = setTimeout(() => {adapterRetired = true; readController.abort(); reject(new Error('Reading timeout'));}, Math.max(1, deadlineMs - (now() - batchStarted)));
              });
              const value = parsePullObservation(await Promise.race([pending, bounded]), query);
              if (Date.parse(value.observedAt) > now() || now() - Date.parse(value.observedAt) > 300_000) throw new Error('Observation time unavailable');
              pulls = {state: 'observed', value};
            } catch(error) {pulls = {state: 'error', retained: retainedPulls.get(`${selection.workstreamId}:${selection.dagId}`),
              ...(error&&typeof error==='object'&&'kind' in error&&error.kind==='rate-limit'?{reason:'rate-limit' as const}:{})};}
            finally {if (timer) clearTimeout(timer); if (abortRead) owned.signal.removeEventListener('abort', abortRead);}
          }
          if (pulls.state === 'observed') nextPulls.set(`${selection.workstreamId}:${selection.dagId}`, pulls.value);
          else if (pulls.state === 'error' && pulls.retained) nextPulls.set(`${selection.workstreamId}:${selection.dagId}`, pulls.retained);
          if (owned.signal.aborted || signal.aborted || generation !== epoch) throw new Error('Reading cancelled');
          const fingerprint = digest(semantics(input, pulls));
          const previous = cached.get(input.workstream.id);
          const checkedAt = new Date(now()).toISOString();
          const changed = previous?.fingerprint !== fingerprint;
          const summary: ReadingSummary = changed ? {kind: 'rules-only', workstreamId: input.workstream.id, fingerprint,
            revision: (previous?.revision ?? 0) + 1, generatedAt: checkedAt, checkedAt, changed: true,
            ...explainReading(input, pulls), limitation: LIMITATION} : {...structuredClone(previous), checkedAt, changed: false};
          summaries.push(summary); next.set(input.workstream.id, structuredClone(summary));
        }
        if (owned.signal.aborted || signal.aborted || generation !== epoch) throw new Error('Reading cancelled');
        cached = next;
        retainedPulls = nextPulls;
        return structuredClone(summaries);
      })().finally(() => {
        signal.removeEventListener('abort', abort);
        if (generation === epoch) {flight = null; controller = null;}
      });
      flight = {key, promise};
      return promise;
    },
  };
}
