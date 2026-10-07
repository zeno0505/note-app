import {createHash} from 'node:crypto';
import type {DagReadModel} from '../../facts/dag-read-model';
import type {LiveDagView,LiveWorkstreamView} from '../../shared/live';
import type {ReadingSummary} from '../../shared/reading-summary';
import {taskPrefix,type SummaryPrefixScope} from '../../shared/summary-prefix';
import {selectSummaryTasks,SUMMARY_SELECTION_POLICY} from './task-selection';
import {explainReading} from './index';
export function prefixSelection(model:Readonly<DagReadModel>,selected='T',explicit?:readonly string[]) {
  const counts=new Map<string,number>();let unparsedCount=0;
  for(const task of model.tasks){const prefix=taskPrefix(task.id);if(prefix)counts.set(prefix,(counts.get(prefix)??0)+1);else unparsedCount++;}
  const tasks=model.tasks.filter(t=>taskPrefix(t.id)===selected);
  const taskSelection=selectSummaryTasks(tasks,model.tasks,model.doneStatus,explicit);
  const chosen=tasks.filter(t=>taskSelection.taskIds.includes(t.id));
  const ids=new Set(chosen.map(t=>t.id)),index=new Map(model.tasks.map(t=>[t.id,t]));
  const dependencies=[...new Map(chosen.flatMap(t=>t.dependencies.filter(d=>d.scope==='external'||!ids.has(d.id)).map(d=>[JSON.stringify([d.scope,d.id]),{id:d.id,scope:d.scope,status:d.scope==='internal'?index.get(d.id)?.status??null:null}] as const))).values()];
  const sourceHash='sha256:'+createHash('sha256').update(JSON.stringify({prefix:selected,tasks:chosen,taskSelection,dependencies})).digest('hex');
  const scope:SummaryPrefixScope={sourceHash,selected,available:[...counts].sort(([a],[b])=>a.localeCompare(b)).map(([prefix,count])=>({prefix,count})),total:model.tasks.length,selectedCount:tasks.length,otherCount:model.tasks.length-tasks.length-unparsedCount,unparsedCount,dependencies,taskSelection};
  return {tasks,scope};
}
export function scopedDagView(base:LiveDagView,model:Readonly<DagReadModel>,selected='T',limit=200,explicit?:readonly string[]):LiveDagView {
  const {tasks,scope}=prefixSelection(model,selected,explicit);const counts=new Map<string|null,number>();for(const t of tasks)counts.set(t.status,(counts.get(t.status)??0)+1);
  return {...base,summaryScope:scope,taskCount:tasks.length,displayedTaskCount:Math.min(tasks.length,limit),tasks:[...tasks.filter(t=>scope.taskSelection.taskIds.includes(t.id)),...tasks.filter(t=>!scope.taskSelection.taskIds.includes(t.id))].slice(0,limit).map(t=>({...t,dependencies:t.dependencies.slice(0,8),commitReferences:t.commitReferences.slice(0,8),e2e:{...t.e2e,coveredBy:t.e2e.coveredBy?.slice(0,8)??null},displayOmissions:{dependencies:Math.max(0,t.dependencies.length-8),commitReferences:Math.max(0,t.commitReferences.length-8),e2eReferences:Math.max(0,(t.e2e.coveredBy?.length??0 )-8)}})),statusCounts:[...counts].slice(0,12).map(([status,count])=>({status,count})),statusCountTotal:counts.size,statusCountsOmitted:Math.max(0,counts.size-12)};
}
export function prefixReading(workstream:LiveWorkstreamView,dag:LiveDagView):ReadingSummary {
  const scope=dag.summaryScope!,selection=scope.taskSelection;const chosen=dag.tasks.filter(t=>selection.taskIds.includes(t.id));const usable={...dag,tasks:chosen,displayedTaskCount:chosen.length,sourceHash:scope.sourceHash,...(!chosen.length?{state:'unavailable' as const}:{})};
  const explanation=explainReading({workstream,dag:usable},{state:'unconfigured'});
  for(const s of explanation.sections)for(const p of s.paragraphs)if(p.text==='실제 PR·CI·리뷰 조회 대상과 연결이 설정되지 않았습니다. DAG가 최신이라고 가정하지 않습니다.')p.text='이 접두사 작업에 대응된 PR·CI·리뷰 근거는 포함되지 않았습니다. 프로젝트 전체 근거를 선택 작업의 완료 증명으로 사용하지 않습니다.';
  explanation.sections.find(s=>s.id==='evidence')!.paragraphs.unshift({text:`요약 범위 ${scope.selected}- · 전체 ${scope.total}개 중 선택 ${scope.selectedCount}개, 다른 접두사 ${scope.otherCount}개 및 ID 형식 미지원 ${scope.unparsedCount}개 제외. 규칙·AI 공통 작업 ${selection.taskIds.length}개, 접두사 안에서 ${selection.omittedCount}개 생략. ${selection.mode==='explicit'?'사용자가 직접 선택했습니다.':SUMMARY_SELECTION_POLICY} 문장별 작업 이름은 5개까지 표시합니다. 작업별 시각이 없어 최신 순서를 판단하지 않습니다. 접두사에 대응되지 않은 프로젝트 문서·PR 본문은 포함하지 않습니다.`,basis:'declaration',sources:[]});
  if(scope.dependencies.length)explanation.sections.find(s=>s.id==='next')!.paragraphs.push({text:'선택 밖의 의존성(같은 접두사 포함, 본문 제외): '+scope.dependencies.slice(0,8).map(d=>`${d.id} (${d.scope}, ${d.status??'상태 미확인'})`).join(', ')+(scope.dependencies.length>8?` · ${scope.dependencies.length-8}개 메타데이터 표시 생략`:''),basis:'declaration',sources:[]});
  if(selection.missingIds.length)explanation.sections.find(s=>s.id==='next')!.paragraphs.unshift({text:'직접 선택한 작업 중 현재 DAG에서 확인할 수 없는 ID: '+selection.missingIds.join(', ')+'. 자동 대체하지 않습니다. 선택을 다시 확인해 주세요.',basis:'unknown',sources:[]});
  if(!scope.selectedCount)explanation.sections.find(s=>s.id==='next')!.paragraphs.unshift({text:`${scope.selected} 접두사 작업이 없습니다. 실제 접두사를 직접 선택해야 요약할 수 있습니다. 다른 범위를 자동 선택하지 않습니다.`,basis:'unknown',sources:[]});
  const fingerprint=createHash('sha256').update(JSON.stringify({prefix:scope.selected,dagId:dag.dagId,state:dag.state,tasks:chosen,dependencies:scope.dependencies,scope})).digest('hex');
  return {kind:'rules-only',summaryPrefix:scope.selected,summaryTaskIds:selection.taskIds,workstreamId:workstream.id,fingerprint,revision:1,generatedAt:dag.observedAt??'1970-01-01T00:00:00.000Z',checkedAt:dag.observedAt??'1970-01-01T00:00:00.000Z',changed:true,...explanation,limitation:'선택한 접두사의 DAG 선언만 설명합니다. 다른 작업 본문과 범위가 연결되지 않은 프로젝트 근거는 제외했습니다. 검수·배포 완료는 별도 확인이 필요합니다.'};
}
