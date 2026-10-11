import type {DagTask} from '../../facts/dag-read-model';
import type {SummaryTaskSelection} from '../../shared/summary-prefix';

export const SUMMARY_TASK_LIMIT=20;
export const SUMMARY_SELECTION_POLICY='진행·차단·검토·착수 후보·그 밖 미완료·완료 범주에서 최대 5개씩 대표를 확보한 뒤 빈 자리를 채웁니다. 범주 안에서는 기다리는 미완료 후속 작업 수, 동률은 원문 순서입니다. 최신 순서가 아닙니다.';
/** Only declarations are ranked. No ID number, mtime, inferred phase or timestamps. */
export function selectSummaryTasks(tasks:readonly DagTask[],all:readonly DagTask[],doneStatus:string,explicit?:readonly string[]):SummaryTaskSelection {
  const index=new Map(all.map(t=>[t.id,t]));
  const waiting=new Map<string,number>();
  for(const t of all)if(t.status!==doneStatus)for(const d of t.dependencies)if(d.scope==='internal')waiting.set(d.id,(waiting.get(d.id)??0)+1);
  const category=(t:DagTask)=>['running','in_progress'].includes(t.status??'')?0:t.status==='blocked'?1:t.status==='in_review'?2:t.status===doneStatus?5:t.status==='pending'&&t.dependencies.every(d=>d.scope==='internal'&&index.get(d.id)?.status===doneStatus)?3:4;
  const labels=['진행 선언','차단 선언','검토 선언','내부 의존 완료 선언의 착수 후보','그 밖의 미완료 선언','완료 선언'];
  const ranked=tasks.map((task,position)=>({task,position,group:category(task),waiting:waiting.get(task.id)??0}));
  let selected:typeof ranked;
  if(explicit){const ids=new Set(explicit);selected=ranked.filter(t=>ids.has(t.task.id));}
  else {
    const groups=Array.from({length:6},(_,g)=>ranked.filter(t=>t.group===g).sort((a,b)=>b.waiting-a.waiting||a.position-b.position));
    selected=[];
    // Round robin preserves useful minority states even in very large completed DAGs.
    for(let round=0;round<5&&selected.length<SUMMARY_TASK_LIMIT;round++)for(const group of groups)if(group[round]&&selected.length<SUMMARY_TASK_LIMIT)selected.push(group[round]);
    const ids=new Set(selected.map(t=>t.task.id));
    for(const item of groups.flat())if(selected.length<SUMMARY_TASK_LIMIT&&!ids.has(item.task.id)){selected.push(item);ids.add(item.task.id);}
  }
  const missingIds=explicit?.filter(id=>!index.has(id)||!tasks.some(t=>t.id===id))??[];
  return {mode:explicit?'explicit':'representative',taskIds:selected.map(t=>t.task.id),omittedCount:tasks.length-selected.length,missingIds:[...missingIds],reasons:selected.map(t=>({id:t.task.id,reason:(explicit?'직접 선택 · ':'')+labels[t.group],waitingCount:t.waiting}))};
}
