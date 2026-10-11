# Phase4 문서 열람과 검수 설계

작성일: 2026-10-09
상태: 2026-10-09 목업과 초기 범위에 대한 구현 승인 후 진행 중. 아래 원래 제안은 설계 이력이며 모든 수치·API가 확정되었다는 뜻은 아니다. 구현·검증 기록은 [Phase4 구현 검토](reviews/phase4-document-review-20261009.md)를 따른다.

## 승인된 초기 범위 갱신

- 태스크 상세 하단 인라인 문서 목록·열람, 같은 프로젝트의 넓게 보기·복귀, 독립된 네 번째 문서 탭은 검토한 목업에 맞춘다
- 프로젝트 노트 루트와 명시적으로 연결한 프로젝트 소스 문서·검수 폴더가 초기 범위다. vault 권한이나 관측된 worktree 경로를 전체 탐색 권한으로 확대하지 않는다
- Markdown, 실행 없는 제한된 안전 Mermaid, PNG, 읽기 전용 YAML/JSON 원문을 지원한다. 실행 HTML·Slidev와 전용 PDF·CSV·SQL 편집기는 보류한다
- 상대 링크·wikilink·heading을 지원하고 누락·모호함·범위 밖·미지원 상태를 구분한다
- 실제 대상 규모를 반영한 합성 fixture로 520 KiB급 Markdown, 2.14 MiB급 DAG, 1.9 MiB급 YAML을 확인한다. 과거 256 KiB 제안은 이 범위에 맞춰 수정하며 본문을 조용히 자르지 않는다
- 읽기 전용 안전 경계, main 소유 식별자, 명시된 좁은 루트, 출처·상태 복원은 유지한다. 구현 승인은 main 병합·배포·릴리스를 포함하지 않는다

## 1 목표와 완료할 사용자 흐름

[제품 대전제](product-premise.md)에 따라, 개발자는 note-app 안에서 태스크의 이유와 수용 기준을 읽고 연결된 요구사항, 설계, 구현 및 리뷰 문서로 이동한 뒤 원래 검수 위치로 돌아올 수 있어야 한다. 일반 관측 프로젝트의 실행은 Orca가 맡고 note-app 자체는 dot이 개발한다.

Phase4의 두 진입점은 다음과 같다.

1. **태스크 관련 문서**: 그래프 또는 목록 선택 → 우측 태스크 상세 → 하단 관련 문서 → 인라인 Markdown 열람 → 관련 링크 탐색 → 태스크 검수로 복귀
2. **프로젝트 문서**: 프로젝트 → 문서 섹션 → 폴더 또는 파일 이름으로 탐색 → 같은 읽기 전용 뷰어에서 열람

별도 개발 실행 UI, 편집기, 문서 자동 가져오기, 문서 쓰기, 자동 승인, 신규 모델 실행은 범위에서 제외한다. 기존 수동 AI 기능은 별도 흐름이며 문서 선택과 연결하지 않는다. 외부 앱 없이 완료되는 위 두 흐름이 Phase4의 최소 성과다.

## 2 요구사항 출처와 확인 범위

| 구분 | 내용 | 설계에서의 취급 |
| --- | --- | --- |
| 사용자 확정 | 시각적 맥락 파악과 검수, 인지 부담 감소 | 제품 판단 기준 |
| 사용자 확정 | 우측 태스크 상세 하단의 관련 Markdown, 프로젝트 문서 탐색 | 필수 범위 |
| 사용자 확정 | Phase4 별도 실행 UI 불필요, note-app 자체는 dot이 개발 | 역할과 비목표 |
| 현재 구현 | note-app 기준 커밋 `f525a31a604bf71b4159d34dfc3fa9628be9bd94`의 아래 소스 | 재사용 가능 기반. 전체 기능의 런타임 통과를 주장하지 않음 |
| 공개 상위 계약 | agent-skills 기준 커밋 `6032b38ddfdcdf4acb0c60aa322eee41e5b8c478`의 collect/plan/receive 등 | 호환성 입력. 이후 계약 변경은 별도 검토 |
| 이 문서의 제안 | 문서 탭, 탐색 이력, 해결 규칙, 한도, API | 구현 전 검토할 권장안 |

기존 저장소 문서에는 이번 읽기 전용 문서 탐색의 완성된 Phase4 계약이 없다. 현재 README의 로컬 소스·개인정보 경계와 Phase3 사용성 검토의 상태 보존·권한·회귀 원칙을 이어받는다. 이 문서는 제품 코드를 변경하지 않으며 UI 실측이나 새 기능의 테스트 통과 보고서가 아니다.

### 공개 dag-stack 문서 계약

- `collect-dag-stack`은 `ticket_url`, 선택적 `figma_url`과 `slack_thread`, `project_path`, 선택적 `note_dir`를 다룬다. `project_path`는 `NOTE_ROOT` 아래의 상대 프로젝트 식별자이며 git worktree의 절대경로가 아니다. `docs/note`가 미연결이면 필수다. `note_dir`는 명시값, 기존 `docs/note` 연결, 사용자 프로젝트 확인 후 setup 순서로 정한다
- 수집 결과는 `{note_dir}/context.md`다. `summary`, `requirements`, `constraints`, `figma_specs`, `sources`와 변경 이력을 담는다. `sources`는 `kind`, `ref`, `collected_at`, `fingerprint`를 포함한다. 기존 파일을 임의 재생성하지 않는다
- collect에서 plan으로 `project_path`와 `context_file: '{note_dir}/context.md'`를 전달한다. `base_branch`는 plan 단계에서 확인한다. note-app이 이를 추정하거나 수집 skill을 자동 실행하지 않는다
- plan 산출물은 schema 2의 `dag.yaml`, `dag.md`, `e2e-checklist.md`다
- receive의 태스크 기록은 `{note_dir}/inbox/{task_id}/` 아래의 `assignment.md`, `implementation.md`, `review-N.md`, `final.md`다. 통합 구현 기록은 `inbox/integration/implementation.md`의 `## Task T-XXX:` 마커를 사용한다
- receive는 볼트 루트 기준의 path-qualified wikilink를 요구하고 `[[<project_path>/inbox/T-001/assignment|T-001]]` 예제를 든다. Markdown 표에서는 alias 구분자를 `\|`로 쓴다. 다만 setup의 `NOTE_ROOT`는 vault root와 같다고 보장되지 않으므로 예제의 `project_path`만으로 실제 볼트 상대 경로를 확정할 수 없다. 볼트가 없을 때의 평문 태스크 ID는 문서 링크가 아니다
- 기획 변경은 append에서 날짜·출처와 변경 이력 및 새 태스크를 함께 기록한다. track의 source drift 조회가 불가능하면 “변경 없음”으로 볼 수 없다

출처: [collect 원문](https://github.com/zeno0505/agent-skills/blob/6032b38ddfdcdf4acb0c60aa322eee41e5b8c478/skills/collect-dag-stack/SKILL.md), [plan 원문](https://github.com/zeno0505/agent-skills/blob/6032b38ddfdcdf4acb0c60aa322eee41e5b8c478/skills/plan-dag-stack/SKILL.md), [receive 원문](https://github.com/zeno0505/agent-skills/blob/6032b38ddfdcdf4acb0c60aa322eee41e5b8c478/skills/receive-dag-stack/SKILL.md), [setup 경로 처리](https://github.com/zeno0505/agent-skills/blob/6032b38ddfdcdf4acb0c60aa322eee41e5b8c478/skills/setup-dag-stack/scripts/setup_note_link.sh), [track 변경 확인](https://github.com/zeno0505/agent-skills/blob/6032b38ddfdcdf4acb0c60aa322eee41e5b8c478/skills/track-dag-stack/SKILL.md)

이 산출물 계약이 현재 note-app의 읽기 모델에 모두 노출된다는 뜻은 아니다. 특히 `project_path`라는 이름을 근거로 `NOTE_ROOT` 상대 식별자와 실제 볼트 상대 링크 접두사를 동일시하지 않는다. 실제 main 소유 프로젝트 매핑에서 각각의 루트를 검증한다. 공개 skill의 문서 관례를 임의의 새 `dag.yaml` 필드로 바꾸지 않는다.

## 3 현재 구현과 추가 개발의 경계

| 현재 소스 | 확인한 동작 | Phase4에서 필요한 변화 |
| --- | --- | --- |
| `TaskWorkspace.vue` | 목록·DAG 공통 선택, 우측 상세, 필터·선택·스크롤, 하단 `EvidenceViewer` | 관련 문서 목록과 인라인 뷰어를 이 위치에 통합 |
| `ProjectWorkspace.vue` | 요약, 사용량, 태스크·DAG의 세 탭 | 프로젝트 문서 진입점 추가. 세 탭을 전제로 한 키보드 이동도 수정 |
| `EvidenceViewer.vue` | 등록 근거 버튼, Markdown/원문, 이미지, 모달, 이전 근거 이동, 비동기 세대 관리 | 뷰어와 세션 제어 분리, 인라인·넓게 보기, 앞/뒤 이력과 위치 보존 |
| `SafeMarkdown.vue`, `phase2/markdown.ts` | HTML 삽입 없이 Vue 텍스트/요소 생성, 제한된 Markdown, heading 이동, 로컬 참조 버튼 | 안전 규칙 유지, 목차·검색·anchor 결과 명확화, 호환 parser 보강 |
| `phase2/evidence.ts` | main 전용 파일 읽기, 불투명 ID, read-root 재확인, 해시, 취소·시간 제한, 경로·파일 안전 검사 | 파일목록에서 검증된 등록을 생성하는 경로 추가 |
| `live-runtime.ts` | 현재 태스크의 design/discussion과 프로젝트 documentLinks를 합쳐 등록, 자식 문서의 해시 의존성 검증 | 태스크 직접 관계와 프로젝트 공통 문서 분리, 출처·루트별 resolver, 프로젝트 문서 세션 |
| `main/projects/wikilinks.ts` | note root 상대 wikilink를 검증하여 Obsidian URI 생성 | 앱내 열람의 공통 resolver와 계약 차이를 분리. 외부 앱 열기를 기본 동작으로 사용하지 않음 |
| `main/read-roots.ts`, `collector/notes` | 허용된 좁은 프로젝트 노트 매핑, 지정된 `docs/note` 연결 확인 | 프로젝트 문서 열거의 별도 범위를 명시하고 권한 철회와 함께 무효화 |
| `shared/workspace-state.ts` | 엄격한 기존 상태 스키마와 저장/복원 | 버전 있는 문서 UI 상태와 이전 버전 migration |

현재 `DagTask.details`가 읽는 문서 관련 필드는 `design`, `discussion`이다. task 문서 경로, `context_file`, 별도 문서 목록 필드가 이미 제공된다고 가정하지 않는다. 현재 프로젝트 documentLinks는 등록된 JSON 문서 관측 레코드에서 오며 일반 Markdown 디렉터리 목록이 아니다.

### 먼저 해결할 호환성 차이

1. 기존 외부 열기 resolver는 wikilink를 `canonicalNotePath` 아래로 붙인다. 상위 계약의 볼트 접두사를 다시 붙이면 프로젝트 경로가 중복될 수 있다
2. 기존 근거의 시작 링크는 note root 기준, 문서 안 링크는 원본 문서 디렉터리 기준이다. 볼트 기준 wikilink와 같은 규칙이 아니다
3. 기존 parser는 경로의 역슬래시를 거부한다. 표 안 `\|`는 alias escape로 정확히 파싱해야 하며 경로 역슬래시 허용으로 해결하면 안 된다
4. heading 이동은 제한된 slug 규칙으로 구현되어 있지만 Obsidian block reference는 구현되어 있지 않다
5. 상위 setup은 `NOTE_ROOT/project_path`를 만들지만 receive 링크 설명은 볼트 루트 기준이다. 두 루트가 다른 구성의 실제 링크와 계약 보정은 P4-0에서 확인해야 한다
6. 현재 read-root 안내는 전체 폴더의 재귀 수집을 하지 않는다고 명시한다. 프로젝트 문서 탐색을 기존 권한 설명 뒤에 숨겨서 추가하면 안 된다

이는 정적 소스와 공개 계약의 차이다. 회귀 fixture로 재현한 뒤 호환 범위를 확정한다.

## 4 정보 구조

### 태스크 관련 문서

상세의 수용 기준, 변경 대상, 의존성, 검증·리뷰를 유지하고 그 아래에 `관련 문서`를 둔다. 아래 관계를 라벨로 구별한다.

| 그룹 | 근거 | 표시 규칙 |
| --- | --- | --- |
| 태스크가 연결한 문서 | 현재 DAG의 `design`, `discussion` 등 실제 지원 필드의 명시된 참조 | 선언 필드와 원문 링크를 확인 가능 |
| 태스크 기록 | 확인된 receive 계약의 정확한 태스크 폴더에서 발견된 파일 | `계약 경로에서 발견`으로 표시. 명시된 DAG 링크와 구별 |
| 프로젝트 공통 맥락 | `context.md`, `dag.md`, `e2e-checklist.md` 등 프로젝트 문서 목록 | `프로젝트 공통`으로 표시. 모든 태스크의 직접 근거처럼 표현하지 않음 |

문서 행은 표시명, 프로젝트 상대 경로, 관계 출처, 읽기 상태를 가진다. alias만으로 같은 파일을 구분하지 않는다. 같은 파일을 여러 근거가 가리키면 파일 행은 합치되 관계와 anchor는 보존한다. 문서가 있다는 이유로 `검토 완료` 배지를 붙이지 않는다.

태스크 ID를 경로에 넣을 때는 현재 DAG에서 유일하게 확인된 ID만 사용하며, 제한된 파일명 문법에 맞지 않는 ID를 보정하거나 문자열 치환하지 않는다. 일반 `T-001`뿐 아니라 프로젝트별 ID 규칙은 별도 계약을 확인한다. 폴더 관례가 일치하지 않으면 명시 링크만 제공한다.

`review-N.md`의 N은 리뷰 시도 번호이며 PR의 round 번호로 취급하지 않는다. 숫자 N 순서로 나열하되 가장 큰 숫자를 “최종 승인”으로 해석하지 않는다. `final.md` 역시 기록 파일이다. 통합 문서는 정확한 `Task T-XXX:` 마커가 유일할 때만 해당 섹션을 후보로 표시하고 `통합 문서 내 태스크 섹션`이라고 설명한다. 마커 중복·누락 때 임의의 첫 섹션을 고르지 않는다.

초기 선택은 문서 목록까지만 보여 준다. 첫 문서를 자동으로 읽거나 “최신 리뷰”를 자동 선택하지 않는다. 재방문 시 이전에 사용자가 열었던 문서는 신원과 권한을 재확인한 뒤 복원할 수 있다.

### 프로젝트 문서

권장 진입점은 `ProjectWorkspace`의 네 번째 `문서` 탭이다. 태스크·DAG와 동등한 프로젝트 수준 섹션이며 태스크 선택이 필요 없다.

- 왼쪽: 현재 탐색 범위, 폴더/파일 목록, 파일 이름·상대 경로 검색, 명시적인 목록 새로고침
- 오른쪽: 태스크 상세에서 사용하는 것과 같은 문서 뷰어
- 상단 바로가기: 실제 존재를 확인한 `context.md`, `dag.md`, `e2e-checklist.md`. 누락한 파일을 생성하거나 빈 문서로 꾸미지 않음
- 기본 범위: 현재 프로젝트에 매핑된 canonical note root. `docs/note`가 symlink이면 검증된 실제 프로젝트 노트 루트를 사용
- 저장소의 다른 Markdown은 별도 `저장소 문서` 읽기 범위를 명시적으로 연결한 경우에만 제공. 관측된 worktree 경로만으로 읽기 권한을 얻지 않음
- 전체 볼트와 다른 프로젝트는 목록·검색에 포함하지 않음

Phase4 최소 출시는 프로젝트 노트 범위의 문서 탐색을 포함한다. 저장소 전체 문서까지 동시에 제공할지는 결정 항목이다. UI에는 실제 범위를 `프로젝트 노트 문서`처럼 명시해 “프로젝트의 모든 Markdown을 읽었다”는 오해를 피한다.

첫 탐색에서 범위와 동작을 안내한다. `이 프로젝트 노트 폴더의 Markdown 파일 이름을 탐색하고, 선택한 파일만 읽습니다`를 확인한 뒤 세션을 시작한다. 기존 읽기 허용 폴더를 더 넓히지는 않는다. 새 파일열거 동작에 맞게 권한 안내 문구와 해당 테스트도 함께 변경해야 한다. 태스크 기록의 계약 경로 발견도 같은 범위 검토 뒤에 수행하고, 그전에는 기존의 명시된 참조만 제공한다. 반복해서 문서마다 확인을 요구하지 않고 검토한 프로젝트 범위·동작의 revision에 결합한다.

## 5 문서 뷰어와 이동 상태

### 배치

- 태스크 상세 하단: 관련 문서 목록 다음에 뷰어. 태스크 ID·제목과 문서명을 동시에 확인할 수 있는 짧은 헤더 유지
- 뷰어 헤더: 뒤로, 앞으로, 문서명·상대 경로, 원문/서식 전환, 문서 안 찾기, 목차, 넓게 보기, 문서 닫기
- 문서 본문을 최초 열 때는 태스크 상세의 한 세로 스크롤을 사용한다. 본문·상세·전체 화면에 세 개의 고정 높이 스크롤을 겹치지 않는다. 코드와 넓은 표의 가로 스크롤은 별도 허용
- 넓게 보기는 같은 프로젝트 안의 전용 읽기 영역으로 확장한다. 창이나 외부 앱을 띄우지 않는다. 상단에 `T-001 상세로 돌아가기` 또는 `문서 목록으로 돌아가기` 제공
- 좁은 창에서는 한 열로 전환하고 같은 복귀 동작을 제공한다. 데스크톱 최소 지원 창, 200% 확대와 긴 한글 경로를 검증
- 관련 이미지도 명시 클릭 후 같은 뷰어에서 연다. 현재 이미지 맞춤·원본 크기·확대 기능을 재사용

### 상태와 이력

`선택 태스크`와 `열린 문서`는 독립 상태다. 문서 링크를 열어도 그래프/목록 선택, 필터, 페이지, 그래프 줌·이동과 상세 위치를 바꾸지 않는다. 태스크 문서에서 다른 문서를 읽어도 출발 태스크의 검수 맥락을 헤더에 유지한다.

이력 항목에는 문서의 main 소유 안정 식별자, 출발 위치, anchor, 확인된 문서 해시, 스크롤과 포커스 복귀 대상만 보관한다. 현재 세션 토큰을 디스크에 저장하지 않는다. 앞/뒤 이동은 문서를 다시 검증하고, hash가 달라지면 자동 교체하지 않는다. 같은 문서 안 heading 이동도 위치 이력으로 다룬다.

- 문서 닫기: 연결 버튼에 포커스를 돌리고 태스크 상세를 유지
- 상세 닫기: 원래 목록/그래프의 태스크에 포커스를 돌림. 필터 밖이면 검색/안내로 복귀
- 문서 탭으로 이동: 태스크 상태를 유지. 탭을 돌아오면 원래 상세와 위치 복원
- 새 태스크 선택: 이전 문서 요청 취소. 새 태스크 제목과 예전 문서를 섞어 표시하지 않음
- 프로젝트 전환·연결 해제·권한 철회: 이전 읽기와 파생 세션 취소. 늦은 응답 폐기
- 앱 재시작: 문서명/위치 등 UI 상태만 복원 후보로 사용. 현재 프로젝트 매핑과 권한을 재검증한 뒤 본문을 다시 읽음

문서 이력은 앱 라우터의 프로젝트 이동 이력과 분리한다. 초기 범위에서는 전역 Alt+Left/Right를 가로채지 않는다. 뷰어의 앞/뒤 버튼은 문서 이력만 이동한다. 원문/서식 전환·넓게 보기 전환은 새 문서를 연 것으로 쌓지 않는다.

## 6 링크 해결 계약

아래는 Phase4 권장 계약이다. renderer가 문자열을 파싱했다는 사실은 파일 읽기 권한이 아니다. main이 원문, 출발 문서, 등록 루트, 계약 버전과 현재 권한을 다시 검증한 뒤 정확한 대상만 불투명 ID로 발급한다.

| 입력 | 권장 동작 |
| --- | --- |
| `[설계](design.md)` | 원본 문서 디렉터리 기준의 정확한 파일 |
| `[[context]]`, `[[inbox/T-001/assignment]]` | 등록된 링크 기준 계약이 `project-note`이면 note root 기준, 문서 상대 계약이면 출발 문서 기준. 무명 파일 검색은 하지 않음 |
| `[[<vault-project-prefix>/inbox/T-001/assignment]]` | 볼트 기준으로 해석한 뒤 현재 프로젝트 note root 내부임을 검증. 접두사는 main의 실제 매핑에서 얻음 |
| heading과 alias가 함께 있는 wikilink | alias는 표시 전용. heading과 파일 신원은 별도로 유지 |
| 표 안의 escaped alias wikilink | 표 문맥의 alias escape 하나만 처리. 원문을 보존하며 일반 경로 역슬래시는 계속 거부 |
| `#heading`, `[[#heading]]`, `[[path#heading]]` | 확인된 heading에만 이동. 같은 문서의 wikilink anchor 지원은 parser 확장 항목. 일치 실패는 본문을 열고 `제목 위치를 찾지 못함` 표시 |
| `[[path#^block-id]]` | 원문 anchor를 보존하고 `블록 위치 이동 미지원` 표시. 파일 자체는 안전하게 읽을 수 있으면 열기 |
| `[[basename]]`인데 여러 폴더에 같은 이름 | 전체 폴더 검색으로 추측하지 않음. 명시 기준이 없거나 여러 기준에서 다른 파일이면 `대상 모호함` |
| 없는 파일 | `파일 없음`과 원문 참조, 새로고침/프로젝트 문서 찾기 제공. 자동 생성 없음 |
| `..`, `.`, 절대경로, UNC, 드라이브 문자, 백슬래시 경로, URL·percent 인코딩 경로 | 거부. decode/정규화로 위험 문자열을 살리지 않음 |
| 다른 프로젝트 또는 볼트 밖 경로 | 거부. 더 넓은 vault 읽기 권한이 있어도 현재 프로젝트 문서 범위를 넘지 않음 |

### 서로 다른 링크 기준의 공존

현재 레거시 note-root/문서-relative 링크와 상위 skill의 vault-root 링크를 하나의 추정 규칙으로 합치지 않는다. 신규 문서 등록에 `referenceBase`와 `contractVersion`을 둔다. 상위 skill 산출물이라고 출처가 확인된 참조에는 그 계약을 적용한다.

레거시·출처 불명 문서에서 기준이 없는 경우에는 최대 세 개의 정해진 기준(note root, 출발 문서 디렉터리, 검증된 vault 프로젝트 접두사)만 후보로 확인한다. 디렉터리 검색은 하지 않는다. 하나의 canonical 파일로만 귀결되면 어떤 기준을 적용했는지 표시한다. 서로 다른 파일이 둘 이상이면 모호함을 유지하고 허용 범위 안의 후보 상대 경로를 보여 주어 사용자가 고르게 한다. 선택은 이번 열람에만 적용하며 원문이나 전역 규칙을 바꾸지 않는다.

명시된 계약 기준의 파일이 없다고 다른 기준으로 조용히 fallback하지 않는다. `project_path` 문자열을 잘라 붙이거나 폴더명이 같다는 이유로 vault 접두사를 제거하지 않는다. `NOTE_ROOT`와 vault root가 달라 상위 예제대로 만든 링크가 맞지 않으면 `링크 기준 계약 불일치`로 표시하고 프로젝트 문서 목록으로 이동할 수 있게 한다. 프로젝트 식별자 기준의 호환 adapter가 필요하면 현재 DAG의 `project.project_path`와 검증된 note root의 명시적 결합을 먼저 확보해야 한다. 이를 기존 읽기 모델이 제공한다고 가정하지 않으며, 승인된 새 투영 계약과 fixture 없이 자동 보정하지 않는다.

heading은 기존 `markdownHeadingAnchor`의 Unicode 문자·숫자 기반 slug와 중복 suffix 규칙을 먼저 사용한다. 원문 heading 텍스트형 anchor를 추가 지원할 때에는 동일 문서의 실제 heading 중 유일한 경우만 매핑한다. 부분 문자열·가장 비슷한 제목 매칭은 하지 않는다. source가 지정한 anchor 원문과 실제 매칭 결과를 각각 보존한다.

### 경로와 파일 안전성

기존 근거 reader의 경계를 유지한다. 원본 프로젝트 연결인 `docs/note` symlink는 전용 매핑 단계에서 검증하고 canonical note root로 전환한다. 그 뒤 문서·이미지·탐색 디렉터리 안의 symlink는 안쪽을 가리키더라도 따라가지 않는다. hardlink와 특수 파일도 제외한다.

각 파일 읽기에는 루트 identity, 경로 구성 요소, 최종 파일 종류, 단일 링크, 크기, `O_NOFOLLOW`, 읽기 전후 stat와 해시, 권한의 전후 재검사를 적용한다. renderer에서 임의 경로를 받을 수 있는 `readFile(path)`나 `openPath(path)` IPC는 추가하지 않는다. 파일목록에서 발견한 파일도 읽는 시점에 다시 검사한다. 후보의 프로젝트 경계는 filesystem 조회 전에 검사하며 허용되지 않은 후보의 존재를 탐색하지 않는다. 경로의 대소문자나 Unicode 정규화를 자동 교정해서 다른 파일로 바꾸지 않는다. 루트 이동·교체·권한 철회가 확인되면 이전 캐시와 세션을 계속 사용하지 않는다.

## 7 읽기 전용 렌더링과 안전 경계

`SafeMarkdown`의 제한된 AST 렌더러를 기반으로 한다. 지원 범위는 제목, 문단, 강조, 인라인/블록 코드, 제한된 중첩 목록·인용, 표, 로컬 링크 버튼이다. front matter나 미지원 문법은 실행 없이 원문으로 남기며 일부 항목이 서식으로 보이지 않는다는 안내를 제공한다.

- HTML, `<script>`, iframe, SVG, 이벤트 속성은 HTML로 삽입하지 않음. `v-html`, 임의 DOM injection 사용 금지
- JavaScript, `file:`, `data:` 링크, `javascript:`, `mailto:`, `obsidian:`, 기타 앱 프로토콜은 문서 링크 실행 대상으로 사용하지 않음
- 외부 HTTP(S) 링크와 원격 이미지는 텍스트·차단 이유만 표시. DNS, 미리보기, preload, 다운로드와 외부 브라우저 열기 모두 자동 수행하지 않음
- 로컬 이미지는 명시 클릭 후 기존 bounded-format 검사를 통과한 PNG/JPEG/GIF/WebP만 표시. 검증된 이미지 data URL만 renderer에 전달. 원문이 제공한 data URL은 거부
- 코드펜스, 셸 명령, Mermaid, Dataview, Obsidian embed/plugin, 템플릿과 AI 지시는 실행하지 않음
- Markdown checkbox는 선언의 표현일 뿐, 클릭으로 파일/태스크 상태를 변경하는 UI로 만들지 않음
- source-derived 내용을 권한 요청이나 실행 명령으로 취급하지 않음

기존 CSP `connect-src 'none'`, renderer navigation 차단, 새 창/webview 차단, context isolation, sandbox, node integration 비활성화를 유지한다. 문서 표시를 위해 `file:` 접근이나 네트워크 허용을 추가하지 않는다. 외부 링크 열기가 필요해지면 별도 요구와 정책으로 설계한다.

## 8 긴 문서와 변경된 문서

### 긴 문서

현재 텍스트 256 KiB 제한을 유지하는 것이 초기 권장안이다. 읽기 한도 초과는 조용히 잘라서 전체 문서처럼 표시하지 않는다. 파일 크기와 `현재 앱내 읽기 한도 초과`를 알리고 다른 문서 탐색은 계속 가능하게 한다. 더 큰 context/review 문서가 실제로 필요하면 chunk reader와 경계 테스트를 후속 단계로 설계한다.

안전하게 읽은 원문이 parser의 줄·node·작업·표 한도를 넘으면 기존 원문 표시 fallback을 사용한다. 제한 사유를 헤더에 표시한다. 목차는 실제 파싱한 heading만 사용한다. 코드와 표는 가로 이동이 가능해야 하며, 긴 파일명·URL은 레이아웃을 밀어내지 않는다.

### 문서 변경과 기준 보존

뷰어에 `DAG 선택 기준`과 `문서 읽기 기준`을 분리한다. DAG의 `sourceHash`와 문서의 `sha256:...`를 같은 값이나 같은 시간의 검증으로 취급하지 않는다. 표시 내용은 읽은 시점의 스냅샷이며 문서 내용의 사실성·테스트 통과는 미판정이다.

- 사용자가 새로 읽거나 앞으로/뒤로 이동할 때, 앱 활성화 후 재확인할 때 원본을 재검증
- 문서 내용이 바뀌었지만 같은 읽기 권한과 루트가 유지되면 기존 화면을 `이전 내용`으로 남기고 `변경된 문서 다시 읽기` 제공. 자동 덮어쓰기와 자동 스크롤 점프 금지
- 현재 파일이 없어졌으면 `삭제되었거나 이동됨`을 알리고 마지막 본문은 이전 관측임을 분명히 표시. 새 링크 탐색은 중단
- 권한 철회, 연결 해제, 루트 신원 불일치에는 본문·이미지와 파생 세션을 제거. 이전 내용 표시로 읽기 제한을 우회하지 않음
- 다시 읽기 후 heading이 같으면 그 위치로, 없으면 문서 시작과 안내로 이동. 픽셀 스크롤을 새 내용의 정확한 검토 위치라고 주장하지 않음
- DAG가 바뀌면 선택 기준이 달라졌음을 표시하고 현재 태스크 관계를 재검증. 이전 문서와 새 태스크를 조용히 재결합하지 않음

Phase4는 문서 diff 편집기나 오프라인 본문 아카이브를 만들지 않는다. 캐시된 내용도 권한과 신원 검증 없이 최신 파일처럼 제시하지 않는다.

## 9 검색과 키보드 접근성

프로젝트 문서 검색과 열린 문서 안 찾기를 분리한다.

- 프로젝트 검색: 허용된 프로젝트 범위의 파일명·상대 경로를 대상으로 함. 본문 전문 검색과 다른 프로젝트 검색은 초기 범위 밖
- 문서 안 찾기: 현재 읽은 전체 원문을 기준으로 이전/다음 일치를 제공. 제한된 표시라면 검색 범위를 명시. 정규식과 동적 HTML 주입을 쓰지 않음
- 목차: 문서 heading 이동과 현재 anchor 결과를 제공. 중복 제목은 파일 순서와 구분자를 보존하고 블록 anchor로 가장하지 않음
- 검색은 IME 조합이 끝난 뒤 반영하고 입력 중 포커스를 결과로 강제 이동하지 않음
- 링크와 모든 조작은 Tab/Shift+Tab, Enter/Space로 사용 가능. 문서 보기에는 제목과 `region`/heading 구조, 로딩에는 `aria-busy`와 짧은 상태 안내 제공
- 프로젝트 네 탭의 방향키/Home/End 탐색을 배열 길이로 처리. 기존 세 탭 고정 로직을 그대로 두지 않음
- 문서 닫기, 넓게 보기 복귀, 오류 복구 후 포커스를 실제 출발 버튼으로 반환. 버튼이 사라졌으면 가장 가까운 제목/목록으로 반환
- Esc는 현재 찾기 입력이나 넓게 보기 등 가장 안쪽 맥락만 닫고 선택 태스크를 연쇄 종료하지 않음
- Ctrl/Cmd+F는 뷰어 안에 포커스가 있을 때만 문서 찾기에 연결. 다른 앱 입력과 OS 탐색을 가로채지 않음
- 스크린리더에 문서 전체를 매번 live announce하지 않음. 파일명, 완료/실패와 필요한 다음 동작만 알림

초기 목록은 복잡한 ARIA tree보다 폴더 breadcrumb와 파일 목록 버튼을 권장한다. 200% 확대, 키보드 전용, 밝은/어두운 테마, 긴 한글 경로와 표의 focus-visible을 회귀 항목에 포함한다.

## 10 오류와 복구

| 상태 | 사용자에게 보여 줄 것 | 복구 |
| --- | --- | --- |
| 명시 링크 없음 | `이 태스크에 연결된 문서가 없습니다`와 프로젝트 문서 진입점 | 태스크 상태 그대로 유지 |
| 참조 문법 미지원 | 원문 참조와 미지원 이유 | 프로젝트 파일명 검색 가능, 자동 보정 없음 |
| 파일 없음 | 경로와 파일 미확인 | 목록/파일 다시 확인 |
| 대상 모호함 | 허용된 후보별 전체 상대 경로 | 직접 선택 또는 취소 |
| 읽기 허용 없음 | 현재 범위와 허용 필요 이유 | 설정 검토. 클릭만으로 권한 확대하지 않음 |
| 경로 탈출·symlink·특수 파일 | 안전하게 읽을 수 없다는 구체적인 분류 | 다른 정상 문서 선택, 자동 우회 없음 |
| 파일 변경·DAG 변경 | 어떤 기준이 달라졌는지 | 새 내용 다시 읽기 또는 원래 목록 복귀 |
| 크기·분석 한도 | 한도와 실제 상태, 원문 fallback 가능 여부 | 제한된 표시 또는 다른 문서 선택 |
| 시간 초과·busy | 읽기 중단/처리 중이며 빈 문서가 아님 | 요청 취소 후 새 세션으로 명시 재시도 |
| 불완전 파일목록 | 수집한 범위와 제외/중단 이유 | 폴더 좁히기, 다음 페이지, 재시도 |
| 잘못된 UTF-8·이미지 디코딩 실패 | 콘텐츠를 안전하게 표시하지 못함 | 원본 파일 확인, 다른 문서 선택 |

재시도는 새 요청 세대와 현재 권한에서 수행하며 중복 클릭을 합친다. 취소·실패의 늦은 응답이 새 문서를 덮거나 닫힌 뷰어를 다시 열어서는 안 된다. 원시 OS 오류, 전체 절대경로, 스택트레이스를 일반 오류 메시지에 내보내지 않는다.

## 11 데이터와 API 권장안

아래 이름은 설계안이며 현재 IPC가 아니다. 기존 prepare/read/release의 권한 구조를 보존하면서 공통 문서 서비스를 추출한다.

### main 소유 데이터

- `DocumentScope`: 프로젝트/노트/선택적 저장소 루트의 검증된 identity, 허용 revision, 매핑 revision, 계약 버전. 절대경로는 main 전용
- `DocumentDescriptor`: 불투명 문서 ID, 표시명, 상대 경로, 종류, 관계 출처 배열, anchor, 존재/읽기 상태. 파일명·목록 metadata는 내용 검증이 아님
- `DocumentSnapshot`: 문서 해시, 읽은 시각, byte 수, MIME, 안전하게 읽은 내용, 표시 한계, `verification: not-assessed`
- `DocumentReference`: 원문, 출발 문서 ID/해시, 명시 기준과 resolved/blocked/missing/ambiguous 상태. renderer의 해석은 권한으로 사용하지 않음
- `DocumentCatalog`: scope revision, 목록 revision, 수집 완료/부분 상태, 폴더별 cursor와 제외 이유. 목록 revision과 문서 내용 해시를 혼동하지 않음

### IPC의 책임

| 제안 API | 입력 | main의 검증과 결과 |
| --- | --- | --- |
| `prepareProjectDocuments` | workstream ID, 기대 매핑 revision | 현재 프로젝트와 읽기 범위를 검증해 catalog 세션 발급 |
| `listProjectDocuments` | catalog 세션 ID, 서버 발급 directory ID/cursor, 제한된 검색어 | 허용 디렉터리의 목록 metadata만 반환 |
| `prepareTaskDocuments` | workstream ID, task ID, DAG sourceHash | 현재 태스크와 정확한 선언/계약 경로에서 문서 등록 |
| `readDocument` | 세션 ID, 문서 ID, expectedSourceHash | 기존 안전 reader로 읽고 안전한 snapshot 반환 |
| `resolveDocumentReference` | 현재 문서 snapshot ID, main이 발급한 참조 ID | 원본 문서 해시와 출발 관계까지 재확인하여 대상 capability 발급 |
| `releaseDocumentSession` | 세션 ID | 요청 취소, reader retire, 파생 세션과 이미지 제거 |

renderer가 scope path, 파일 경로, `trusted: true`, 임의 해시를 권한 근거로 제출하는 API는 금지한다. 검색어와 화면에 보이는 상대 경로는 파일 읽기 권한이 아니다. 모든 호출은 기존 trusted sender 검사, 정확한 schema/키/길이 제한, 취소 신호와 동시성 제한을 적용한다.

기존 `readTaskEvidence`의 상위 문서 해시 proof chain은 유지한다. 링크가 제거된 상위 문서에서 발급된 자식 capability를 재사용하지 않는다. 이력 보관 한도와 읽기 proof 깊이는 별개다. 깊이 한도 도달 시 chain을 몰래 버리고 계속 읽지 말고 출발 목록에서 다시 열도록 안내한다.

### 파일목록과 캐시

- 파일목록 열람을 시작하기 전에는 새 디렉터리 스캔을 하지 않음. 폴더 펼치기/페이지 이동은 metadata만 읽고 본문은 선택 시 읽음
- `.md`, `.markdown`만 문서 목록에 포함. `.git`, `node_modules`, 빌드/캐시 및 숨김 디렉터리는 기본 제외하며 제외 범위를 UI에 알림
- 첫 버전은 폴더 단위 lazy listing. 파일 이름 전체 검색은 사용자가 요청한 현재 프로젝트 안에서만 bounded metadata walk 수행. 본문 index는 생성하지 않음
- symlink 디렉터리를 내려가지 않음. 파일 삭제·권한 오류를 건너뛴 경우 partial 상태와 이유를 보존
- 목록 캐시는 scope identity·권한 revision·directory revision을 키로 하는 메모리 LRU. 목록 확인 시각을 표시하며 30초 soft TTL, 폴더 재진입·앱 활성화·명시 새로고침 시 해당 폴더를 다시 확인하는 것을 권장. TTL은 최신성 증명이 아니며 변경을 감지하지 못한 목록은 `이전 목록`으로 표시. 재시작 후 원문/목록 본문 캐시를 자동 복원하지 않음
- 파일 읽기는 목록 캐시와 무관하게 파일 종류·권한·identity·내용 해시를 재검증. mtime만으로 동일 내용을 확정하지 않음
- 프로젝트 변경, 매핑 변경, read-root 철회, 연결 해제 때 캐시와 capability 무효화. 원문 parser 결과 재사용도 같은 scope 권한과 문서 hash에서만 허용
- UI 상태 저장에는 문서/폴더 복원용 안정 키와 scroll/anchor만 사용. raw 본문, 이미지, ephemeral token, 검색 본문은 저장하지 않음

## 12 성능과 자원 한도

기존 한도는 초기 출시에서 상향하지 않는다. 신규 수치는 fixture 측정 전의 권장 목표다.

| 구분 | 현재 또는 권장 한도 |
| --- | --- |
| 현재 텍스트 읽기 | 256 KiB |
| 현재 Markdown | 8,192줄, AST 4,096 nodes, 1,500,000 work units, 참조 64개, 표 32열/256행 |
| 현재 이미지 | 압축 4 MiB, 한 변 8,192, 16 Mi pixels, decoded 64 MiB. 포맷별 추가 제한 유지 |
| 현재 근거 세션 | 16개, 등록 동시 처리 4개, 참조 proof 8단계, 읽기 5초 |
| 신규 목록 페이지 | 최대 100개, 응답 metadata 256 KiB 이하 |
| 신규 파일 이름 검색 | 프로젝트당 최대 5,000개 entry 방문, 깊이 16, 전체 5초. 한도 도달 시 partial 명시 |
| 신규 metadata 캐시 | 앱 전체 최대 4 MiB. 초과 시 LRU 제거와 세션 재검증 |
| 신규 본문/AST 캐시 | 앱 전체 예산 8 MiB, 열린 이미지 1개. 할당 비용은 원문 byte 수만으로 계산하지 않음 |
| 신규 탐색 이력 | 프로젝트별 20항목. capability 유효 기간이나 proof 깊이를 확장하지 않음 |

성능 검증 fixture: 1,000 Markdown 파일/복수 폴더, 200 KiB 문서, 한도 부근 표/heading/링크, 반복 열기와 취소. 기준 머신·빌드·표본 수를 기록하고 cold/warm을 분리한다. 초기 목표는 첫 목록 페이지와 일반 문서 열기 p95 500 ms 이내, 취소/새 선택 반응 100 ms 이내다. 측정 결과가 없으므로 달성했다고 표기하지 않는다.

## 13 구현 단계와 종료 조건

### P4-0 계약과 fixture 고정

공개 skill의 버전·경로·위키링크와 실제 note-app 읽기 모델 필드의 대응표를 고정한다. `project_path` 문맥, vault 접두사, escaped alias, task/integration 기록 예제를 합성 fixture로 옮긴다. 개인정보나 실제 노트를 fixture에 넣지 않는다.

종료 조건: 현재 불일치를 재현하는 테스트와 합의된 해결 규칙이 있으며, 지원하지 않는 경우도 명시되어 있다. 새 DAG 필드를 추측하여 추가하지 않는다.

### P4-1 공통 문서 서비스와 안전 resolver

기존 evidence reader/세션 관리를 재사용하고 링크 기준별 resolution과 명시적인 상태를 추가한다. 프로젝트 목록용 등록 경로와 범위 동의를 분리한다.

종료 조건: 경로·권한·race·늦은 응답·proof chain 테스트 통과. 기존 근거 읽기, 이미지, read-root와 외부 문서 열기 경계 회귀 없음.

### P4-2 태스크 상세의 인라인 문서

관련 문서 관계 구분, 인라인 뷰어, 원문/서식 전환, 위치/포커스 복귀와 넓게 보기를 구현한다. 양방향 이력과 문서 변경 안내를 붙인다.

종료 조건: 목록·그래프에서 같은 태스크의 문서를 외부 앱 없이 읽고, 기존 필터·페이지·선택·위치로 돌아온다. 파일 읽기가 모델/실행/쓰기 호출을 유발하지 않는다.

### P4-3 프로젝트 문서 탐색

문서 탭, 범위 안내, lazy 폴더 목록, 파일 이름 검색, 실제 존재하는 공통 문서 바로가기를 구현한다. 이전 workspace state의 migration과 네 탭 키보드 탐색을 포함한다.

종료 조건: 태스크 선택 없이 범위 안의 문서를 찾아 읽는다. 권한 없는 저장소나 다른 프로젝트는 탐색하지 않는다. 목록의 partial 상태를 완료처럼 표현하지 않는다.

### P4-4 반복 검수와 독립 검증

긴 문서, 변경·삭제, 권한 철회, 재연결, 프로젝트 전환, 재시작과 접근성을 확인한다. 디자인 검토와 실제 UI 시나리오를 분리해 결과를 남긴다.

종료 조건: 아래 matrix의 필수 항목과 기존 `npm run check` 및 영향 Electron suite 통과. 누락된 플랫폼·테스트는 명시한다. Linux 결과를 macOS 검증으로 대신하지 않는다. 구현 완료, 소스 배포, 설치본 반영은 각각 따로 확인한다.

## 14 완료 기준과 테스트 matrix

| 영역 | 필수 사례 | 통과 증거 |
| --- | --- | --- |
| 계약 | collect context 파일, plan 공통 문서, receive 태스크/통합 기록 | 고정 버전 합성 fixture와 필드 대응 테스트 |
| 링크 문법 | local, project-note, vault-qualified, alias, 표의 escaped alias | parser/main resolver 동일 target 회귀 |
| 링크 실패 | heading 없음·중복, block anchor, missing, 여러 기준 충돌 | 상태·원문 보존과 임의 선택 없음 |
| 경로 안전 | 절대/상위/인코딩/UNC/Windows 경로, 중첩 symlink·hardlink·특수 파일 | 읽기 거부, 파일·네트워크 side effect 0 |
| race | 읽기 중 교체·truncate·삭제·symlink 치환, root identity 변경 | 이전 capability로 새 대상을 읽지 않음 |
| 권한 | read-root 철회, 변경 중 pending read, reconnect | 본문 제거·취소·세션 무효화, 늦은 응답 폐기 |
| 관계 | 같은 문서의 여러 출처, 공통 문서, review-N, 통합 마커 중복 | task 직접 근거/경로 발견/공통 맥락 구분 |
| 태스크 UX | 목록과 DAG, 다른 페이지·필터 밖 선택, 문서 이동·닫기 | 프로젝트·태스크·필터·페이지·줌·스크롤·포커스 유지 |
| 문서 UX | 인라인/확장/원문, 앞·뒤·동일 문서 anchor, 탭 왕복 | 기대 위치와 이력, 다른 태스크 내용 혼입 없음 |
| 변경 | 파일 hash 변경·삭제, DAG 변경, 같은 mtime 다른 내용 | 이전 관측과 현재 확인의 구분, 자동 교체 없음 |
| 검색 | 한글 IME, 같은 이름, 특수문자, 0건, partial 목록 | 결과 범위·건수·상태 정확, 미검색을 없음으로 표현 안 함 |
| 안전 렌더링 | HTML/XSS, 외부 URL/image, data/SVG, code/Mermaid/plugin | HTML 실행·외부 요청·외부 앱·모델·쓰기 0 |
| 한도 | text/lines/nodes/links/table/image 상한의 전후, file tree 깊이·entry 제한 | freeze 없음, 이유와 원문 fallback 정확 |
| 수명 | 연속 빠른 클릭, 닫기 중 읽기, 프로젝트 전환, 20회 이상 탐색 | 세션/파일 descriptor 해제, 최신 선택만 표시 |
| 저장/복원 | 구버전 상태, 손상 상태, 재시작, 복원 파일 삭제 | 안전 default·안내, 임의 파일 재열기 없음 |
| 접근성 | 키보드 전용, screen reader, 200% 확대, 760px급 좁은 창, 두 테마 | focus-visible·명칭·순서·복귀·표 이동 확인 |
| 자원 | 1,000 파일, 200 KiB, cold/warm, 반복 취소 | 측정 조건과 p95·메모리/handle 추이 기록 |

프로젝트 문서 접근은 태스크 선택이나 DAG의 태스크 유무를 요구하지 않는다. 다만 현재 구현의 연결·매핑 수명 경계를 초기 단계에서 유지하므로, 연결이 끊긴 상태에서도 독립적으로 문서를 읽는 기능은 별도 설계 없이 추가하지 않는다. 문서 탭의 빈 상태에서 태스크 없음과 읽기 범위 미확인을 구별한다.

현재 관련 테스트는 `phase2-markdown`, `phase2-evidence`, `phase2-evidence-runtime`, `phase2-evidence-viewer`, `project-wikilinks`, `read-roots`, `phase2-workspace-state` unit suite와 `test:electron:phase2`다. Phase4 전용 unit/renderer/Electron suite를 추가하고 기존 범위를 함께 실행한다. trusted DAG query가 필요한 선택적 검증은 실제 실행 여부를 별도로 보고한다.

최소 인수 시나리오: 처음 보는 개발자가 외부 편집기 없이 `context.md`에서 요구사항을 읽고, DAG에서 T-001을 선택하여 설계와 구현·리뷰를 확인하고, 다른 관련 문서를 따라갔다가 같은 태스크의 수용 기준으로 돌아온다. 이 과정에서 검토 대상과 최신성, 미확인 항목을 설명할 수 있어야 한다. 자동화 통과와 별도로 실제 UI에서 수행한 관찰을 기록하며 실사용자 연구로 과장하지 않는다.

## 15 구현 전 결정할 항목

| 결정 | 권장안 | 영향 |
| --- | --- | --- |
| 프로젝트 탐색 초기 범위 | 프로젝트 note root를 필수 출시, 저장소 문서는 명시 연결 후 확장 | 권한 설명과 파일 목록 범위 |
| 태스크 기록의 자동 발견 | 확인된 계약의 정확한 task 폴더만 제한 조회 | 명시 링크만 쓸 때의 누락을 보완하되 관계 provenance 필요 |
| NOTE_ROOT와 vault root 불일치 | 원문 경로 오류를 숨기지 않음. 검증된 프로젝트 식별자 adapter 도입 여부를 P4-0에서 결정 | 상위 예제와 실제 파일 경로의 호환성 |
| 링크 기준 미선언 | 정해진 후보만 검사, 여러 다른 파일이면 사용자 선택 | 레거시 호환성과 잘못된 문서 연결 방지 |
| Obsidian block anchor | 첫 버전은 파일 열기와 미지원 안내 | 새로운 block parser 없이 안전한 범위 확보 |
| 256 KiB 초과 문서 | 초기 제한 유지, 실제 사용 문서 크기를 확인 후 chunk 설계 | 긴 누적 리뷰 문서를 앱내 읽는 범위 |
| 문서 변화 감지 | 활성화/명시 새로고침/탐색 시 재확인. 전체 재귀 watcher 제외 | 무의미한 재스캔과 조용한 문서 교체 방지 |
| UI 배치 | 상세 하단 인라인 + 넓게 보기, 프로젝트 네 번째 문서 탭 | 사용자 요청을 만족하며 기존 태스크 흐름 유지 |

이 결정들은 제품 대전제를 다시 묻는 항목이 아니다. 구현할 범위와 안전한 기본값을 정하기 위한 선택지다. 이 단락은 최초 설계 당시의 결정 목록이다. 이후 승인된 초기 범위는 문서 상단 갱신을 따른다.

## 16 확인한 로컬 근거

- [태스크 상세](../src/renderer/components/TaskWorkspace.vue), [프로젝트 작업공간](../src/renderer/components/ProjectWorkspace.vue), [근거 뷰어](../src/renderer/components/EvidenceViewer.vue)
- [안전 Markdown 렌더러](../src/renderer/components/SafeMarkdown.vue), [제한된 Markdown parser](../src/phase2/markdown.ts), [파일 reader](../src/phase2/evidence.ts)
- [runtime 등록과 권한](../src/main/live-runtime.ts), [wikilink 외부 열기](../src/main/projects/wikilinks.ts), [읽기 범위](../src/main/read-roots.ts), [읽기 범위 UI](../src/renderer/components/ReadRootsSettings.vue)
- [DAG 상세 필드](../src/phase2/dag-extension.ts), [기존 문서 관측 계약](../src/summary/reading/documents.ts), [workspace 상태](../src/shared/workspace-state.ts)
- [보안 호스트](../src/main/host.ts), [renderer CSP](../src/renderer/index.html), [개발·검증 안내](../README.md), [Phase3 검토](reviews/phase3-usability-20261009.md)
