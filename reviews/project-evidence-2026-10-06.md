# 등록된 프로젝트 기능·검증 근거 — 2026-10-06

이 문서는 앱의 자동 코드 분석 결과나 사용자 수용 승인이 아니다. 공개 저장소의
명시적 문서·코드와 실제 개발 검증 결과를 사람이 범위를 확인해 등록한 기록이다.
[작업 대응 초안](reading-output-review-2026-10-06.md)은 DAG 작업 완료를 판정하지 않는다.
앱은 [구조화된 등록 기록](project-evidence-2026-10-06.jsonl)을 명시적으로 선택한
경우에만 읽는다. 각 행은 별도 기록이며 실제 읽은 행의 해시·관측 시각을 인용한다.

## 기능 근거 맵

| 등록한 기능 | 공개 문서 | 관련 코드 | 이 근거의 한계 |
|---|---|---|---|
| 한국어 개요·상세·설정, 명시적 실제 소스 연결, 미관측/과거 상태 구별 | [Phase 1 현황](phase1-outcome-status.md), [Mac 후속](mac-resume-terminal-2026-10-06.md) | `src/main/host.ts`, `src/renderer`, `src/main/live-runtime.ts` | 코드·문서 기록과 과거 native 검증이다. 최신 head의 화면 수용 검수가 아니다 |
| 실제 Orca/CodeBurn 읽기, 명시적 범위와 DAG 연결 | [실제 공개 관측](public-github-2026-10-06.md), [Mac 후속](mac-resume-terminal-2026-10-06.md) | `src/collector/orca`, `src/summary/budget/codeburn.ts`, `src/facts/dag-read-model`, `src/collector/notes` | 실제 read-only 검증 범위만 사용한다. 모델 실행·노트 쓰기 증거가 아니다 |
| 네 구역 한국어 규칙 설명, 변경 시 갱신, 정확한 SHA의 공개 CI | [규칙 설명](../docs/reading-summary.md), [공개 읽기](../docs/public-github-reading.md) | `src/summary/reading`, `src/main/live-runtime.ts`, `ReadingSummary.vue` | headless/단위 검사와 문서 등록이다. 코드 동작 전부나 작업별 완료는 인증하지 않는다 |
| 등록 문서·목표 발췌, 후보/승인/복원 기능 | [Phase 1 현황](phase1-outcome-status.md), [Mac 후속](mac-resume-terminal-2026-10-06.md) | `src/summary/context/registered.ts`, `src/summary/claims`, `src/summary/storage`, `src/summary/workflow` | 합성 요청/응답의 경계 검증이다. 실제 모델 응답의 품질·승인을 주장하지 않는다 |

경로는 공개 코드 대응을 설명하는 문서 선언이다. 등록 record의 references를 앱이
실행하거나 자동 재검증하지 않는다. 사용자 노트나 비공개 프로젝트 내용은 포함하지 않았다.

## 검증 범위별 기록

- `a49ad3baebd8de2601a7ca11b5e5c5d955bcc091`: Mac 개발 체크아웃에서
  `npm run check` 최종 실행의 타입 검사·빌드와 기본 테스트 **838 통과 / 16 skip**.
  앞선 실행은 기존 fake-provider 테스트의 `kill EPERM`으로 성공으로 계산하지 않았다.
  해당 SHA의 [CI 37414985116](https://github.com/zeno0505/note-app/actions/runs/37414985116)는 성공이다.
- 같은 SHA의 실제 read-only headless runtime에서 승인된 note-app 한 scope, 공식 DAG
  query 28 작업, 반복 요약 no-op, 사용자 DAG 해시·mtime 불변을 확인했다. 새 앱창 0,
  모델 호출 0이다. 실제 한국어 규칙 출력 4구역·10문장을 Vue SSR으로 렌더링했다.
- 같은 수집 코드의 소유 Node headless 진단에서 초기 수집 시작
  `2026-10-06T04:39:54.885Z`, background 예정 수집 시작 `04:44:55.845Z`,
  간격 300.862초를 확인했다. 초기 완료 후 예약 기한은 `04:44:55.743Z`였다.
  **예정 자동 수집 1회**이며 지속 foreground 두 회나 Electron 자원 측정이 아니다.
  진단 bundle은 최종 작업별 검증 문구 수정 전이므로 그 최종 문장의 증거로 쓰지 않는다.

이후 SHA에 위 숫자·native/절전 결과를 자동 전이하지 않는다. 기능 문서와 이 기록을
등록한 후 앱은 그 문서 보고를 표시할 뿐, 새로운 test 실행이나 비용 있는 모델 호출을
수행하지 않는다. 현재 head CI는 기존 공개 observer가 별도로 관측한다.

## 실제 남은 항목과 수용 검토 지점

1. 네 섹션이 실제 프로젝트의 기능·남은 일·근거·결정을 이해하기 쉽게 설명하는지
   사용자가 검수한다. 등록 문장/참조의 정확성과 생략도 확인한다.
2. 공개 코드·검증 근거와 DAG 작업 수용 기준의 대응을 명시적으로 확정한다.
   이 등록 파일은 프로젝트 수준 설명이며 DAG task IDs/status/round를 변경하지 않는다.
3. 최신 앱의 지속 foreground, Electron 전체 자원, 실제 절전 복귀, native 설정 경험을
   사용자 작업이 없는 승인된 검증 시간에 확인한다. headless Node 결과로 대신하지 않는다.
4. Phase 1의 native 설정·패키징 포함 범위와 수용 조건을 결정한다. 추가 기능을 이
   수정에 자동 편입하지 않는다. production model transport는 차단 상태이며 모델을
   원한다면 대상 입력·권한·비용 경계에 대한 별도 사용자 결정과 검증이 필요하다.

이번 수정의 완료 경계는 범용 등록 입력→네 섹션의 실질 문장→출처·SHA/환경 보존→
회귀 검사→작은 feature 체크포인트/정확한 CI이다. 전체 Phase 1 완료 선언은 아니다.

## 이번 등록 경로 검증

기준 `a49ad3b`에 등록 경로 변경을 적용한 Mac 개발 체크아웃에서 전체 `npm run check`:
**856 통과 / 16 skip**, 타입 검사·빌드 통과. 집중 검사 109개가 통과했다. 기록의
잘못된 형식·SHA/환경·경로 이탈, 실제 bounded 파일 reader, scope/worktree/DAG
일치, 내용만 변경 갱신, 실패 시 현재 문장 제외, 5초 timeout·reader retirement·late
응답 차단과 기존 모델/발췌/승인 경로 회귀를 포함한다.

실제 main runtime은 승인된 한 scope에서 등록 기록 9개를 읽어 네 구역 앞에
표시했다. 반복 조회에서는 재생성하지 않았고 DAG 해시·mtime을 유지했다.
`ReadingSummary.vue`의 headless SSR은 4구역·20문장과 문서 상대 경로·행/검증
환경 메타데이터를 렌더링했다. GUI/모델/사용자 파일 쓰기는 0이다. 공개 remote SHA와
해당 CI는 feature 체크포인트 게시 후 별도로 확인하며 이 단락에 수치를 자동 전이하지 않는다.
