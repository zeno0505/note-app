import type {LiveWorkspaceView} from './live';
import type {DagReaderRecovery} from '../facts/dag-read-model/types';
export interface ReconnectReadiness {state:'ready'|'blocked';reason:'disconnected'|'refreshing'|'stale'|'mapping_unavailable'|'dag_unavailable'|'source_unavailable'|'model_unconfigured'|null;observedAt:string|null;readerRecovery:DagReaderRecovery|null}
/** A persisted link is not evidence that its selected source can be summarized. */
export function reconnectReadiness(live:LiveWorkspaceView,id:string|undefined,modelConfigured:boolean):ReconnectReadiness {
 const w=live.workstreams.find(w=>w.id===id),dag=live.dags.find(d=>d.dagId===w?.noteMapping.dagId);
 const reason=live.connection!=='connected'?'disconnected':live.refreshing?'refreshing':live.freshness!=='current'?'stale':!w||w.noteMapping.state!=='resolved'?'mapping_unavailable':dag?.state!=='ready'?'dag_unavailable':w.project&&(w.project.status!=='active'||w.project.sourceState!=='available')?'source_unavailable':!modelConfigured?'model_unconfigured':null;
 return {state:reason?'blocked':'ready',reason,observedAt:live.observedAt,readerRecovery:dag?.readerRecovery??null};
}
