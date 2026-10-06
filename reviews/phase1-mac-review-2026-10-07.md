# Phase 1 실제 Mac 검토 — 2026-10-07 KST

**전체 완료 미판정.** 읽기 연동·수동 Claude 연결·캐시/재시작은 실제로 동작한다. 일반 프로젝트 v1 출력의 의미 문제를 발견하여 입력 v2를 보완했다. v2 실제 성공 출력과 세 프로젝트 사용자 검수가 남아 있으며 합성 응답이나 검사 수로 이를 대신하지 않는다.

## 체크포인트

제품 수정 SHA `5e3b21abcd9f137f6e75d5fd05e1b1328213434a`, tree `d13199ac1bf029fc101f00d2ca70a470a80fcdfb`. [정확 SHA CI 성공](https://github.com/zeno0505/note-app/actions/runs/37503791054). 기본 TMPDIR에서 `npm run check`: 957 pass / 16 skip, 타입·빌드 통과. 실제 Mac은 macOS 26.5.2, arm64, RAM 24 GiB, Electron 44.5.1이다. 제품 지원 최소 OS는 별도 결정이며 현재 번들의 LSMinimumSystemVersion은 13.0이다.

추가 Phase 2 논의 문서 SHA `f25e07fbb0ee5bae8e70a5b5bf4bfc39dcd3c399`, [해당 CI 성공](https://github.com/zeno0505/note-app/actions/runs/37505042619). 문서만 기록했으며 Phase 2 구현은 시작하지 않았다.

## 실제/합성 근거와 판정

| 항목 | 판정 | 근거와 한계 |
| --- | --- | --- |
| 실제 Orca/CodeBurn 읽기 | 통과 | 5e3b21a 패키지에서 71 workstream 관측. provider quota의 unknown은 0으로 치환하지 않음 |
| 현재 패키지 UI/캐시 | 통과 | 기존 실제 v1 본문·시각 보존, legacy/stale와 문맥 검수 경고 표시. 760/1600 화면 overflow 없음, 두 스크린샷 직접 검토. 모델 0회 |
| 일반 프로젝트 실제 v1 생성 | 기계 계약 통과 / 의미 일부 실패 | 3f049e7에서 생성 1회/형식 수정 0회, 6 sources/16 facts. 과거 승인 제한을 현재 수동 예외와 충분히 구분하지 못하고 최신 작업보다 초기 태스크를 선별 |
| 같은 입력/재시작 | 통과 | v1 실제 중복·별도 앱 재시작 모두 추가 호출 0회. 원문·생성 시각·hash 동일. 공개 파일럿 보존 |
| v2 코드 보완 | 검사 통과 / 실제 의미 미실행 | 최신 진행/검토/차단 작업과 연결된 CI 우선, 현재 사용자 승인과 과거 미대조 문서 구분. 40-task fixture 및 필수 승인 anchor 검사 |
| v2 첫 실제 요청 | 취소 차단 확인 / 생성 실패 | a24e3be에서 1회 요청. 배경에서 관측 freshness 만료 후 취소, 늦은 본문 미저장, 이전 성공 본문 보존. 같은 실패 hash 재전송하지 않음 |
| 현재 지속 foreground | 실패/준비 미충족 | a24e3be 66초: 1 새 관측 후 blur. 5e3b21a 66초: 새 관측 0, blur. 별도 안정 포커스 대기는 180초 내 5초 연속 포커스를 얻지 못함. 두 번 예정 polling 통과로 주장하지 않음 |
| 과거 실제 foreground | 과거 소스에서 통과 | 0012e3f, 65,301ms, focusLost=false, 예정 수집 두 번. 현재 실패 시도를 대체하지 않음. 5d84870 기록은 실패 |
| 올바른 비동기 대기 | 통과 | 설치 Playwright async false가 26ms 반환한 실제 재현 및 설치 소스의 Promise truthiness 확인. waitUntil은 read/predicate를 await하고 실제 deadline 적용 |
| CLI 인증/취소 | fixture 통과 | async auth 중 main 이벤트 루프 유지·abort 전 paid spawn 0. owned fixture CLI 취소/settle. 실제 v2 취소의 CLI PID 종료는 별도 계측 미실행 |
| scoped note/등록 발췌 | 기존 실제 Mac fixture 통과 재사용 | preview/confirm/no-op/rollback/exclude/cancel, 5회 재시작, stale 승인 차단. 사용자 실제 note 링크 변경은 이번에 하지 않음 |
| 부분 CodeBurn timeout | 기존 실제+제어 실패 통과 재사용 | 실제 설치 CLI 중 하나에만 timeout wrapper, 다른 결과와 last-good 유지, 정상 refresh에서 오류 해소. 실제 공급자 장애를 주장하지 않음 |
| Orca 비모델 terminal | 기존 실제 격리 fixture 통과 재사용 | 승인된 등록 체크아웃에서 create/send/read/wait/cancel/PTY cleanup. 초기 selector 오류는 이력. 실제 AI terminal/Codex 모델 transport는 미실행 |
| 자원 baseline | 측정 완료 / 목표 미합의 | 현재 앱 관련 3~4 프로세스/32샘플. working-set 합 264,128~655,936 KiB, CPU 합 최대 2.814%. 공유 페이지 합산 및 CPU 구간 차이로 실제 고유 메모리/전체 시스템 점유/상한으로 해석하지 않음 |
| 세 대표 프로젝트 설명 | 부분 검토 / 사용자 수용 미확인 | 두 프로젝트는 DAG 선언과 미검증/미연결 근거를 구분. 세 번째는 mapping resolved여도 현재 DAG 관측이 없어 honest unknown. 세 유용한 모델 요약 통과로 보지 않음 |
| 실제 sleep/wake·OS dialog | 미실행 | 강제 절전이나 접근 거절 우회를 하지 않음. 실제 사용자 native 확인이 필요 |
| 로컬 설치/보존 | 통과（기존 보존 정책 범위） | 5e3b21a 검증 번들을 기존 경로에 설치, 일반 실행의 정확 executable/SHA/main·preload/전체 dist·서명 확인. 교체 직후 profile 동일. 이후 새 관측으로 기존 최신12개 정책에 따라 가장 오래된 이력 1개가 제외됨; 남은 이력의 순서/내용·프로젝트 상태/변경 시각·읽기 권한·공개 요약·모델 ledger 보존. 디버그 없음, 백업 보존 |

## 실제 모델 사용량

현재까지 기존 로그인 Claude subscription CLI 요청은 총 **3회**다: 공개 파일럿 1회 성공, 일반 v1 1회 성공, v2 1회 취소. 형식 수정 호출은 모두 0회다. 이 후속 세션에서는 추가 모델 호출 0회이며 별도 API/Codex 호출도 없다. 공개 파일럿의 원문과 일반 v1 성공 본문을 수정하거나 재생성하지 않았다. 정확 model ID는 기록하지 않았으므로 추정하지 않는다. 로컬 취소는 원격 실행/청구 중단 보장이 아니다.

모델 전송은 이미 허용한 연결 DAG·관측 설명·등록 발췌만 한도 내 선별한다. 고정 no-tools/no-MCP/no-session-persistence CLI와 sanitized env를 사용하며 별도 API 인증은 거절한다. 이 실행 계약을 OS 수준 파일 감금이나 민감정보 완전 탐지로 확대하여 주장하지 않는다. 자동 모델/일괄 전송/자동 후보 승인/개발 위임은 활성화하지 않았다.

설치 뒤 첫 일반 실행 PID가 종료된 원인은 미확정이다. 최종 앱은 macOS LaunchServices `open -a`로 다시 열고 일반 실행·보존을 재검증했다. 재검증의 최초 ‘모든 과거 이력 남음’ 검사는 최신12개 정책을 반영하지 않아 실패했다. 이후 오래된 prefix만 제외되고 retained suffix가 현재 prefix로 그대로 남는지 확인했으며 중간 항목 손실을 허용하지 않았다. 영구 전체 이력 보존을 주장하지 않는다. 프로젝트 상태·모델 원문/ledger는 별도 확인했다.

## 재개 시 짧은 확인

1. 실제 note-app 창을 활성화하고 1분 이상 유지하여 현재 패키지의 예정 polling 두 번을 다시 확인한다.
2. 현재의 합법적으로 변경된 입력으로 v2 수동 요약을 생성하고, 최신 작업·현재 수동 승인·과거 기록/미확인·사실/제안 구분을 검수한다. 실패/취소 hash를 reset하거나 재전송하지 않는다.
3. 허용한 대표 프로젝트 세 곳의 이해도/누락/다음 작업을 사용자 검수한다. 미관측 프로젝트는 필요한 읽기 연결부터 확인한다.
4. 제품 최소 OS/지원 행렬과 성능 목표를 결정하고 실제 native dialog·sleep/wake의 필요 범위를 확정한다.

로컬 비공개 근거: `native-note-app-real-AI-3f049e7`, `native-note-app-real-AI-restart-3f049e7`, `native-note-app-real-AI-a24e3be`, `foreground-current-a24e3be`, `foreground-current-5e3b21a`, `foreground-user-5e3b21a`, `native-readonly-resources-5e3b21a`, `app-update-phase1-5e3b21a`. 입력·출력 원문/개인 프로젝트명·스크린샷은 공개 Git에 넣지 않는다. 원래 DAG 수용기준/의존성은 유지하며 전체 완료를 선언하지 않는다.
