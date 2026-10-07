# Phase2 관측·검토 워크스페이스 구현과 수락 범위

대상은 T-036~T-048 및 T-050/T-051의15개 계약이다. note-app은 관측·검토·파견 보류 권고를 맡고 실제 실행은 Orca가 맡는다. 자동 파견, 프로세스 종료, DAG 원문 쓰기, 계정 권한 확대, 트레이 확대, main merge·외부 push·실제 모델 호출은 구현/검증 범위에 추가하지 않았다.

## 1. 원문 읽기 계약 v2

외부 query SHA256 pin은 `23d00c96beb0661bb7da064d7dd83566ea754f75165bb9790831dabc25887d47` 그대로다. 기존 고정 index/coverage 명령과 원본 coverage 계산을 유지하고 다음 두 고정 조회를 추가했다.

- 상세 필드: `id,type,feature,description,acceptance_criteria,target_files,discussion,design`
- 정책 이력: `--policy --all`

Phase ID·제목·순번·태스크 소속은 같은 hash 검증 snapshot을 같은 pinned loader로 읽은 뒤 제한된 구조만 투영한다. 독립 YAML 파서, coverage/의존 closure 재구현, 디렉터리 탐색, private script 복사, renderer 지정 필드/명령은 없다.

`readContractVersion:2`일 때만 확장 필드를 노출한다. 버전 없는 v1은 기존 no-prose 경계를 유지한다. 새/미확인 타입과 상태는 원래 문자열을 보존하고, 지원하지 않는 상세 형식은 생략 수를 남긴다. 정책은 최대200개/각32KiB/합계256KiB, 텍스트는4,096자, 상세 배열은40개로 제한한다. 기존 source/output/time 상한은 낮추지 않았다. 큰 rich DAG는 기존 출력 상한에서 실패할 수 있으며 불완전한 성공으로 바꾸지 않는다.

워크스페이스는 요약 접두사와 독립된 최대1,000개 태스크 읽기 화면이다. 요약 화면은 기존200개 표시·최대20개 선택 계약을 유지한다. 의존/커밋/E2E 참조 표시 상한과 생략량을 따로 표시하며, 그래프가 전체 연결을 모두 보여 준다고 주장하지 않는다.

## 2. 명시 정책과7개 상태

상태 이름만으로 committed/blocked/deferred/superseded를 완료 등에 배정하지 않는다. 없는/모호한 매핑은 전체 목록에 원본과 ‘해석 미확인’으로 남긴다. 계획 완료는 개발·배포 완료가 아니며 E2E 링크도 실행 통과 증거가 아니다.

명시 매핑 envelope 예시:

```json
{
  "key": "note_app_status_mapping",
  "legacy": false,
  "decision": {
    "schemaVersion": 1,
    "id": "project-status",
    "revision": "reviewed-1",
    "scope": {"projectId": "관측된 정확한 note-app workstream ID"},
    "mappingVersion": "1",
    "statuses": {
      "pending": {"lifecycle": "before"},
      "review_needed": {"lifecycle": "review"},
      "done": {"lifecycle": "done"}
    }
  }
}
```

앱이 이 정책을 원문에 쓰지는 않는다. 무관한 정책 key는 보존하되 lifecycle 해석에서 제외한다. legacy:true는 이력이다. 현재 정책의 형식 오류·상충은 fail-closed다. revision은 불투명 식별자이며 같은 범위의 명시 supersedes 관계로만 우선순위를 정한다. mtime/문자순 정렬은 쓰지 않는다. DAG/타입/Phase/task ID 범위 제약도 보존한다.

상태는 전체 / 작업 전 / 진행 중 / 검토 대기 / 논의 필요 / 검증 필요 / 완료의7개다. 검토 대기는 정책상 태스크 리뷰와 실제 관측된 PR 리뷰를 포용하지만 URL만 보고 추정하지 않는다. 논의·검증은 완료 등의 lifecycle과 겹칠 수 있어 건수 합을 전체 수로 표시하지 않는다. source hash·관측 시각·해석 버전·정책 ID/revision/scope·이유를 확인할 수 있다.

## 3. 프로젝트·DAG 사용 흐름

왼쪽 프로젝트 목록과 오른쪽 요약/사용량/태스크·DAG 탭을 유지한다. 탭·검색·상태·타입·Phase·접두사·명시 feature·선택·스크롤은 검증된 IPC를 통해 앱 소유 private cache에 보존한다. 브라우저의 비영구 partition과 sandbox는 그대로다. 저장은 직렬화/병합하고 최대100개 프로젝트 상태·5초 응답 한도를 적용한다. 저장 실패는 화면에 알린다.

딥링크 프로젝트가 필터에 숨으면 URL 선택을 보존하고 경고와 명시 필터 회복 버튼을 보여 준다. 회복하면 동일 프로젝트를 열고 임의의 다른 프로젝트를 선택하지 않는다.

목록이 기본이다. SVG DAG는 제목/원본 상태/정책 해석, 선택 동기화, 순환·외부·필터 밖 연결, 전체 맞춤/확대/선택 위치 이동과 키보드 선택·focus 복귀를 제공한다. 원문 편집 affordance는 없다. 진단 상세는 접어 두고 사람이 읽는 범주/건수로 설명한다. VueFlow/ELK를 설치하지 않고 기존 Vue와 자체 결정적 레이아웃을 사용했다. 축소 개요에서 작은 글자를 읽으려면 확대하거나 목록을 사용한다.

## 4. 안전한 rich Markdown과 이미지

[상세 Markdown 계약](phase2-markdown.md)을 따른다. 제목·문단·강조·코드·표·중첩 목록·인용·로컬 링크·앵커를 Vue의 escaped 노드로 그린다. HTML/v-html, 스크립트, 외부 fetch/URL 이동은 없다. 전체 CommonMark를 지원한다고 주장하지는 않는다. 표는32열/256행, 목록은6단계로 제한하며 잘못된 표·초과 깊이는 명시된 원문 fallback으로 보존한다. 원문 보기와 앵커 미일치 안내를 제공한다.

근거는 등록 프로젝트 연결 또는 선택 태스크의 명시 설계/논의 연결뿐이다. renderer는 파일경로·URL 대신 main이 발행한 불투명 ID를 전달한다. root/realpath·일반 파일·symlink/hardlink·크기·MIME·hash·identity·권한을 검사한다. PNG/JPEG/GIF/WebP는 제한된 구조/크기 검사를 거치고 native decode 실패를 별도로 표시한다. 이미지 fit/원본/확대/scroll과 Escape 닫기를 제공한다. 파일/이미지의 존재는 검증 통과 판정이 아니다.

문서에서 연 후속 링크는 선언한 원문 hash와 최대8단계의 평탄한 조상 증거에 묶인다. 같은 자료의 자식 세션을 재사용하고 필요한 조상은 eviction에서 보호한다. 최대16개 세션·동시 준비4개·미결 권한 조회4개이며 전체 읽기 응답도5초로 제한한다. 취소/닫기/권한 회수/원문 변경/재연결은 이전 권한을 무효화한다. 오래 걸리는 kernel IO는 원래 작업이 정리를 맡으며 강제 취소된다고 주장하지 않는다.

## 5. 실제 연결한 사용량 수집과 메모리 경계

[CodeBurn 수집 계약](phase2-repository-usage.md)은 공식v0.9.25 소스로 검증했다. 신뢰된 기존 executable에 `spend --format branch-json --period today|month --provider all`만 전달한다. shell/renderer 경로/임의 인수는 없다. 출력·시간·동시성·자식 프로세스 정리를 제한한다. 공식 reporting 명령이어도 CodeBurn 자체의 가격/세션 cache 갱신까지 파일 쓰기0이라고 보증하지 않는다. 앱이 credentials/private cache를 직접 읽지는 않는다.

오늘/월 관측은 foreground 최소60초, background 최소300초, 명시 새로고침 시 재조회한다. 실패하면 같은 기간의 last-good만 stale로 보존한다. 출처 기간·관측/마지막 성공/시도·조회 비용·오류·coverage를 표시한다. 현재 관측된 각 checkout의 원래 repo identity를 사용하며, 같은 호스트의 정확한 경로 대응만 인정한다. 합쳐진 프로젝트의 대표 repo를 다른 checkout에 복사하지 않는다. remote 이름·originKey만으로 합치거나 외부 폴더를 탐색하지 않는다. 정확한 경로 대응도 과거 경로 재사용/소유권까지 증명하지 않으므로 실제 자료 대조가 필요하다.

등록 프로젝트 / 저장소 확인·프로젝트 미등록 / 저장소 연결 미확인을 구분한다. DAG task 연결은 별개다. branch 정보 없는 세션의 비용은 보존하지만 토큰/cwd는 unknown이다. 기록 추정 비용은 실제 청구액·계정 quota·전체자료 포함을 보증하지 않는다. 오늘/월을 합산하지 않고 stale/unknown은 그래프의0점으로 바꾸지 않는다.

[프로세스 메모리 어댑터](phase2-process-memory.md)는 명시된 PID/사용자/수명/연결 증거만 받는다. Linux는 지정 PID의 stat/status/stat, macOS는 고정 단일-PID ps만 사용하고 프로세스 전체를 열거하지 않는다. Mac lstart의 초 해상도로는 완전한 수명 검증을 주장하지 않는다. 현재 Orca 응답에는 PID/정밀 수명/worktree 연결이 없어 **프로젝트 메모리 수집은 그 capability가 생기기 전까지 막혀 있다**. Mac을 켠다는 이유만으로 자동 해결된다고 말하지 않는다.

별도로 note-app 자체의 실제 Electron app.getAppMetrics를 연결했다. 프로세스별 working-set/peak를 Electron KB 단위로 표시하며 프로젝트 메모리나 중복 제거된 물리 메모리 합계로 사용하지 않는다. 사용량 탭 활성·focus 상태에서15초 주기로 확인하고 배경에서는 추가 주기 조회를 하지 않는다. [Electron MemoryInfo 공식 문서](https://www.electronjs.org/docs/latest/api/structures/memory-info)와 설치44.5.1 타입 계약을 대조했다.

계정 한도는 provider→account/profile→window 모델이며 기존 CodeBurn 계정 미확인을 그대로 보존한다. 서로 다른 계정 퍼센트 합산/평균은 없다. UsageScope의 공식 계정별 external interface가 확인되지 않았고 새 계정 연결 권한도 없으므로 실제 멀티계정 수집은 미완료다. 모델 fixture 통과를 실제 연동 성공으로 바꾸지 않는다.

## 6. 권고와 수동 태스크 요약

권고는 관측 출처/시각·quota·검토/검증·공급된 시스템 압력을 사용하되 실행 허가/강제 제어가 아니다. 임의 RSS 임계치·자동 파견·프로세스 종료는 없다. ‘읽었음’은 실행 override가 아니다.

태스크 헤더의 요약은 기존 guarded endpoint로 정확히 한 태스크를 선택한 뒤 전송 동의 화면을 연다. 선택/열람 자체는 모델을 부르지 않는다. 실제 Orca 바로가기는 공개 안전 capability가 확인되지 않아 미지원 사유만 표시한다.

수동 AI는 작업 상세·정책 해석/버전·범위를 캐시 입력에 포함한다. 상세는 별도8KiB source에 태스크별 hash/omittedBytes/complete 표시로 제한하고 원래12KiB DAG/48KiB 전체 cap·민감정보 검사·ledger·취소/late/no-replay 계약은 유지한다. 실제 외부 모델의 문맥 품질은 평가하지 않았다.

## 7. 15개 계약의 남은 단계

| ID | 현재 구현 | 구현/인터페이스상 남은 것 | 환경·실측/사용자 수용 |
| --- | --- | --- | --- |
| T036 | pin 보존 v2·타입/feature/Phase/상세·출처/생략 | 큰 rich DAG는 기존 출력 상한에서 fail-closed | 실제459노드 원문 대조 |
| T037 | 명시 policy envelope·scope/revision·unknown·중첩 | 자유문장 정책의 자동 의미 추론은 제외, 명시 매핑 필요 | 실제 프로젝트 정책 수용 |
| T038 | 좌측 목록·3탭·private cache 보존·딥링크 회복 | 저장 실패 안내 유지 | Mac native·사용자 동선 |
| T039 | 7상태와 검색/타입/Phase/접두사/feature | 미선언 feature는 만들어 내지 않음 | 실제 대규모 필터 수용 |
| T040 | readonly SVG·상태/제목·진단/탐색/배율/focus | 강제 성능 목표 미설정 | 실제459구조·합의한 성능 기준 |
| T041 | 상세 이유/수행/수용/파일/의존/검증·헤더 동선 | 실제 PR 리뷰 source 없는 범위는 미확인 | 사용자 읽기 수용 |
| T042 | bounded rich Markdown·앵커·등록 링크·이미지·권한 체인 | 전체 CommonMark는 제외, 잘못된 표·한도 초과는 명시 fallback | Mac 파일권한·실제 근거 문서/이미지 |
| T043 | 공식 branch-json collector·repo/session tokens/cost·그래프/표·오류/범위 | 전체자료 coverage/계정 귀속은 원천이 제공하지 않음 | 설치 CodeBurn 버전·실자료 정확도 |
| T044 | Linux/Mac 명시 PID adapter, 실제 앱 전용 메모리 UI | Orca의 PID/정밀수명/worktree source capability 부재로 프로젝트 귀속 차단 | Mac adapter 실측·수집 비용, OS pressure/swap source |
| T045 | 근거 기반 권고·확인, 실행 제어 없음 | 미관측 자원이 판단을 제한 | 실제 동시4작업 시 권고 수용 |
| T046 | 단일 task 동의·정책/범위 hash·제한/취소/no-replay | 실모델 의미 품질은 자동 확정 불가 | 허용된 실제 모델 평가·사용자 읽기 |
| T047 | 별도 이동 capability 미지원 안내 | 설치 Orca 공개 이동 interface 미확인 | Mac에서 공식 도움말/capability 확인 |
| T048 | unit/type/build·Linux 실제 Electron·합성500·이미지 직접검수 | 현재 구현 변경분마다 결과 재고정 | Mac 설치/서명/권한·상태보존 upgrade/rollback·사용자 수용 |
| T050 | 복수계정/window 모델·오류/시각·legacy unknown | 공식 계정별 interface 및 별도 계정 권한이 없어 실제 수집 불가 | interface 확인·구체적인 연결 승인 후 실조회 |
| T051 | 공식 repo수집·개별 checkout 매칭·3단계·task linkage 분리 | branch없는 token/cwd, 계정·DAGtaskID, 외부 PID귀속은 source 부재 | 실제 여러worktree/동명remote/누락 자료 대조 |

따라서 Linux 공통 구현/검증 통과를15개 태스크의 최종 사용자 수락·Mac 설치·전체 실제 수집 완료로 표시하지 않는다. authoritative DAG의 planning 상태를 임의로 완료 처리하지 않았다.
