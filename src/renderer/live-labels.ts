import type { LiveWorkstreamView } from '../shared/live';
export const configurationLabels={unconfigured:'미설정',ready:'연결 준비됨',invalid:'설정 오류'};
export const coverageLabels={complete:'완전 관측',partial:'부분 관측',unknown:'범위 미확인'};
export const summaryLabels={unavailable:'저장 요약 사용 불가',empty:'저장된 요약 없음',restored:'이전 저장 요약',error:'저장 요약 읽기 실패'};
export const freshnessLabels={current:'관측 근거와 일치',stale:'이전 근거 · 변경됨',unknown:'근거 최신성 미확인'};
export const aspectLabels={goal:'목표',implemented:'어디까지 했나요',remaining:'남은 일',current:'현재 상황',next:'다음 제안',blockers:'막힘 · 판단할 일'};
export function projectLabel(workstream:LiveWorkstreamView):string {
  if(workstream.projectMapping==='missing-project-id') return '프로젝트 ID 없음';
  if(workstream.projectMapping==='project-not-observed') return '프로젝트 미관측';
  return workstream.projectName??'프로젝트 이름 미확인';
}
export function branchLabel(branch:string|null):string {
  if(branch===null) return '브랜치 없음 / 미확인';
  return branch;
}
export function mappingLabel(reason:string|null):string {
  const labels:Record<string,string>={
    'missing-note':'docs/note 없음','note-missing':'docs/note 없음','ambiguous-dag':'DAG 선택 필요',
    'outside-scope':'허용된 노트 범위 밖','whole-vault':'전체 vault 연결은 허용되지 않음',
    'note-broken-link':'docs/note 링크가 끊어짐','note-unavailable':'docs/note 접근 불가','note-not-directory':'노트가 디렉터리가 아님',
    'vault-root-note':'vault 전체를 가리키는 노트 연결','note-outside-scope':'허용된 노트 범위 밖','dag-not-registered':'등록된 DAG 없음',
    'dag-unavailable':'DAG 접근 불가','dag-not-file':'DAG가 파일이 아님','dag-outside-scope':'DAG가 허용 범위 밖에 있음',
    'dag-outside-note':'DAG가 연결된 노트 밖에 있음','invalid-dag-selection':'DAG 선택 설정 오류','no-allowed-scope':'허용된 노트 범위 없음',
    'ambiguous-scope':'일치하는 노트 범위가 여러 개','docs-unavailable':'docs 경로 접근 불가','docs-not-directory':'docs가 디렉터리가 아님',
    'docs-outside-worktree':'docs가 워크트리 밖을 가리킴','timeout':'제한 시간 초과','aborted':'조회 취소됨','operation-limit':'조회 작업 상한 도달','path-changed':'관측 중 경로 변경됨',
    'remote-host':'다른 호스트의 작업','missing-project-id':'프로젝트 ID 없음',
    'project-not-observed':'프로젝트 미관측','matched':'관측된 프로젝트와 일치',
  };
  return reason===null?'이유 미확인':labels[reason]??diagnosticText(reason);
}
export const isCancelledObservation=(reason:string|null|undefined):boolean=>reason==='The observation was cancelled.';
const diagnosticLabels:Record<string,string>={
  'The observation was cancelled.':'관측이 취소되었습니다. 창을 다시 활성화하면 관측을 다시 시도합니다. 직접 새로고침할 수도 있습니다.',
  'No explicit summary task selection resolves to this canonical DAG.':'이 DAG에 연결되는 명시적 요약 작업 선택이 없습니다. 시작 설정의 summarySelections를 확인하세요.',
  'The explicit summary selection could not be verified; retained claims are historical and current evidence is unavailable.':'명시된 요약 작업 선택을 확인하지 못했습니다. 표시된 요약은 이전 기록이며 현재 근거는 확인할 수 없습니다.',
  'The combined explicit selection exceeds the 32-task context limit; current evidence is unavailable.':'선택한 작업이 컨텍스트 상한인 32개를 초과했습니다. 현재 근거를 확인할 수 없습니다.',
  'The combined explicit selection exceeds the 32-task context limit.':'선택한 작업이 컨텍스트 상한인 32개를 초과했습니다.',
  'Historical local summary; claim freshness is compared with the explicit current task slice. Generation is unavailable.':'이전에 로컬에 저장한 요약입니다. 명시적으로 선택한 작업의 관측 근거와 비교해 최신성을 표시합니다. 새 요약은 생성하지 않습니다.',
  'No existing local summary cache. Summary generation is unavailable.':'저장된 로컬 요약이 없습니다. 새 요약 생성은 비활성 상태입니다.',
  'Summary cache or bounded context could not be refreshed; any displayed claims are retained historical data.':'저장 요약이나 제한된 컨텍스트를 다시 읽지 못했습니다. 표시된 요약이 있다면 이전 기록입니다.',
  'Local host identity is not configured.':'로컬 호스트 ID가 설정되지 않아 노트를 연결하지 않았습니다.',
  'Note mapping is retired after an unsettled or failed observation; restart is required.':'노트 조회가 끝나지 않았거나 실패해 추가 조회를 중단했습니다. 설정과 소스를 확인한 뒤 앱을 다시 시작해 주세요.',
  'Note mapping request was rejected.':'노트 연결 요청이 검증을 통과하지 못했습니다.',
  'Note mapping could not be refreshed.':'노트 연결을 다시 확인하지 못했습니다.',
  'Worktree host identity or local path is unavailable.':'워크트리의 호스트 ID나 로컬 경로를 확인할 수 없습니다.',
  'A trusted DAG query executable is not configured.':'검증된 DAG 조회 실행 파일이 설정되지 않았습니다.',
  'The lifetime DAG registration limit was reached; no additional reader was created.':'앱 실행 중 허용된 DAG 등록 상한에 도달해 추가 DAG를 읽지 않았습니다.',
  'No successful DAG observation.':'아직 성공한 DAG 관측이 없습니다.',
  'Canonical DAG identity changed unexpectedly.':'확인했던 DAG 경로 식별자가 변경되어 조회하지 않았습니다.',
  'DAG observation could not be refreshed.':'DAG 관측을 갱신하지 못했습니다.',
  'DAG reader could not be initialized.':'DAG 조회를 준비하지 못했습니다.',
  'The previous DAG mapping is unavailable; retained data is historical.':'이전 DAG 연결을 확인할 수 없습니다. 표시된 내용은 이전 관측입니다.',
  'Some historical DAGs are omitted at the eight-DAG display limit.':'DAG 표시 상한 8개에 따라 일부 이전 DAG를 생략했습니다.',
  'Orca observation could not be refreshed.':'Orca 관측을 갱신하지 못했습니다.',
  'The live read-only projection could not be refreshed.':'실제 소스의 읽기 전용 표시 데이터를 갱신하지 못했습니다.',
};
export function diagnosticText(reason:string):string {
  if(diagnosticLabels[reason]) return diagnosticLabels[reason];
  const classified=/^(DAG|Orca) observation could not be refreshed \(([a-z_-]+)\)\.$/.exec(reason);
  if(classified) return `${classified[1]} 관측을 갱신하지 못했습니다. 오류 분류: ${classified[2]}`;
  const omission='Some historical DAGs are omitted at the eight-DAG display limit.';
  if(reason.endsWith(' '+omission)) return `${diagnosticText(reason.slice(0,-omission.length).trim())} ${diagnosticLabels[omission]}`;
  return reason;
}
