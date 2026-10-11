import type {LiveWorkspaceView,LiveWorkstreamView,LiveDagView} from '../shared/live';
import {mappingLabel} from './live-labels';
export function noteState(workstream:LiveWorkstreamView,live:LiveWorkspaceView|null,dag?:LiveDagView):{label:string;block:string|null}{
 if(workstream.project?.status==='completed')return {label:'완료 · 노트 조회 중단',block:'완료한 프로젝트입니다. 프로젝트 재개 후 요약할 수 있습니다.'};
 if(live?.connection!=='connected')return {label:'노트 연결 미확인',block:'소스 연결이 해제돼 있습니다. 연결 및 설정에서 연결해 주세요.'};
 if(live.refreshing)return {label:'노트 연결 조회 중',block:'소스 조회가 진행 중입니다. 완료 후 다시 확인해 주세요.'};
 if(dag?.readerRecovery?.retired){const r=dag.readerRecovery;return {label:'DAG 조회 중단 · '+r.cause,block:r.cleanup==='verified'?'이전 DAG 조회는 중단됐고 정리가 확인됐습니다. 소스 새로고침으로 안전하게 다시 조회할 수 있습니다.':'이전 DAG 조회의 정리가 '+(r.cleanup==='pending'?'진행 중입니다.':'확인되지 않았습니다.')+' 겹치는 조회를 시작하지 않습니다. 계속되면 앱을 정상 종료한 뒤 다시 열어 주세요.'};}
 if(live.freshness!=='current')return {label:'노트 연결 관측 오래됨',block:'현재 관측이 오래됐거나 최신성을 확인하지 못했습니다. 소스 새로고침으로 다시 확인해 주세요.'};
 if(workstream.noteMapping.state!=='resolved'){
  const reason=workstream.noteMapping.reason,label=reason==='dag-not-registered'?'등록된 DAG 없음':mappingLabel(reason);
  return {label,block:reason==='dag-not-registered'?'연결된 노트에서 읽기 등록된 DAG를 찾지 못했습니다. 노트 디렉토리와 DAG 등록을 확인해 주세요.':label+' · 재연결에서 노트 디렉토리를 확인해 주세요.'};
 }
 if(dag?.state==='error')return {label:'노트 연결 확인 · DAG 조회 실패',block:'DAG 조회가 실패했습니다. 원인을 확인하고 소스를 다시 조회해 주세요. 재연결은 조회 실패의 자동 해결을 보장하지 않습니다.'};
 if(!dag||dag.state!=='ready')return {label:'노트 연결 확인 · DAG 접근 미확인',block:'DAG의 현재 읽기 결과를 확인하지 못했습니다. 소스를 다시 조회해 주세요.'};
 if(workstream.project?.sourceState!=='available'&&workstream.project)return {label:'노트 현재 접근 미확인',block:'프로젝트의 현재 소스 접근을 다시 확인하지 못했습니다. 소스를 새로고침해 주세요.'};
 return {label:'노트 · DAG 연결 확인',block:null};
}
