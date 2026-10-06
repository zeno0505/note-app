# Phase 1 실제 Mac 검토 — 2026-10-07 KST


> 후속: 사용자 실제 구버전 실행을 대조하고 두 안내 경로를 be80587로 갱신했다. 현재 상태는 [사용자 검토 후속](phase1-user-review-followup-2026-10-07.md)을 먼저 읽는다. 아래 ba58eb2 설치/호출 기록은 당시 증거로 보존한다.

**전체 완료는 아직 판정하지 않는다.** 실제 Orca·CodeBurn 읽기와 연결 프로젝트 세 곳의 수동 Claude v2 생성·저장·중복 방지·재시작을 확인했다. 배경에서 시간 경과만으로 정상 실행을 취소하던 결함과 선택적 커밋 참조 형식 때문에 실제 DAG 전체를 거절하던 결함을 수정했다. 세 실제 출력의 에이전트 의미 검수를 마쳤지만 사용자 내용 수용·현재 지속 foreground·지원/성능 기준은 남아 있다.

## 검증 소스와 설치

제품 SHA `ba58eb207369412a6fb3c3df50151e96f0d17e89`, tree `016029da9c32de2497da5e320153f5127d09fadb`. 기본 TMPDIR의 `npm run check`: **962 pass / 16 skip, 타입·빌드 통과**. [정확 SHA CI 성공](https://github.com/zeno0505/note-app/actions/runs/37512935201). 배경 실행 수정은 `c277031e3a559bb04059a1d7421e232b7a017036`, 961 pass / 16 skip 및 [해당 CI 성공](https://github.com/zeno0505/note-app/actions/runs/37508090423)에서 먼저 확인했다.

실제 환경은 macOS 26.5.2 / arm64 / RAM 24 GiB / Electron 44.5.1 / 로그인된 Claude Code 2.1.291이다. 번들 최소 OS 표기는 13.0이지만 제품 지원 최소 OS와 지원 행렬 수용을 뜻하지 않는다. ad hoc 서명이며 배포·notarization·main 병합은 하지 않았다.

검증 패키지를 기존 로컬 앱 경로 `artifacts/87a28ca/note-app.app`에 백업 후 교체했다. 설정은 동일했고 교체 직후 프로필이 동일했다. LaunchServices 일반 실행 PID 78433의 정확 executable·package/manifest SHA·main/preload·전체 dist 15개·서명을 확인했다. 읽기 권한·공개 파일럿·프로젝트별 모델 본문/ledger와 프로젝트 상태·변경 시각·현재 이력을 보존했다. 디버그 옵션과 새로운 권한 부여는 없다. 이력은 기존 최신 12개 정책이며 영구 전체 이력 보존을 주장하지 않는다. 이전 5e3b21a 교체에서는 oldest 1개 제외/나머지 순서·내용 보존을 확인했고, 이번 교체 직후에는 기존 이력이 모두 유지됐고 이후 실제 근거 갱신의 새 관측으로 두 프로젝트에서 각각 oldest 1개가 제외됐다. 재검증에서 기존 최신12개 정책에 따른 oldest prefix만 제외되고 retained suffix의 내용·순서가 유지되는지 확인했다.

## 실제 동작과 한계

| 항목 | 결과 | 근거와 제한 |
| --- | --- | --- |
| Orca·CodeBurn·canonical DAG 읽기 | 통과 | 현재 패키지 71 workstream. quota unknown을 0으로 치환하지 않음. 실제 조회와 개별 프로젝트 mapping을 구분 |
| 배경에서 실행 중 관측 시간 만료 | 실제 통과 | c277031 요청 시작 18:07:01.922Z → 저장 18:08:27.807Z. 인증 결과 callback을 45초 지연한 제어 조건 뒤 실제 Claude CLI PID16061가 40.623초 실행·exit0. 19 timeline 중 11개 background/stale이며 관측 시각 그대로. 시작 스냅샷의 실제 hash·권한 재검증 후 저장 |
| 실제 변화/권한/프로젝트/기한 경계 | 코드·회귀 통과 | 새로운 실행은 fresh 요구. 실행 중 경과 시간만 허용하며 실제 DAG hash·발췌·권한·mapping·연결·프로젝트 변경과 deadline은 계속 차단. fixture를 실제 권한 거절 실험으로 주장하지 않음 |
| 실제 v2 프로젝트 1 | 생성·저장·에이전트 의미 검수 통과 | note-app, 생성1/형식수정0, 6sources/18facts/33306bytes. 최신 검토 작업, 현재 수동 승인, 과거 미대조 문서/CI를 구분. 독립 재시작 및 동일 입력 추가0 |
| 실제 v2 대표 프로젝트 2 | 생성·저장·에이전트 의미 검수 통과 | 생성1/수정0, 6sources/8facts/16693bytes, 실제 CLI PID27222. 별도 재시작/중복 추가0. DAG 선언≠실제 검수·배포와 다음 작업 미확정을 유지 |
| 실제 v2 대표 프로젝트 3 | 생성·저장·에이전트 의미 검수 통과 | 기존 허용 DAG 459작업 ready, 화면 표시200, 모델 태스크24/생략435. 생성1/수정0, 6sources/11facts/17704bytes, PID72875 exit0. 미지원 커밋 참조는 unknown이며 참조 없음/검증 완료로 치환하지 않음. 독립 재시작/중복 추가0 |
| 실제 모델 UI 취소 | 통과 | 실제 완료 근거 갱신 뒤 새 note-app 입력, PID77126 stdin 전달 후 UI 취소. bounded TERM→KILL 종료 정책에서 SIGKILL로 종료, 이전 성공 보존·늦은 본문 미저장·동일 취소 hash 추가0. 원격 중단/청구는 unknown |
| UI·캐시·공개 결과 보존 | 통과 | 각 실제 v2 결과 재시작 시 hash/생성 시각 동일, 공개 파일럿 원문 보존. 760/1600 overflow 없음. note-app760·대표2 1600·대표3 760 스크린샷 직접 확인. 긴 반복 제한 문구와 사용성 수용은 사용자 검수 대상 |
| 현재 지속 foreground | 미검증 | a24e3be/5e3b21a 시도에서 실제 포커스 유지 실패. current 두 번 예정 polling으로 주장하지 않음. 정상 수동 모델 실행에 계속 foreground를 요구하는 우회는 사용하지 않음 |
| 과거 실제 foreground | 과거 소스 통과 | 0012e3f, 65,301ms focusLost=false·예정 수집2회. 현재 버전 통과로 확대하지 않음. 5d84870는 실패 기록 |
| 올바른 비동기 대기 | 실제 재현/수정 통과 | 설치 Playwright async false가 26ms 반환한 재현 및 Promise truthiness 설치 소스 확인. read/predicate를 await하는 waitUntil과 실제 deadline 사용 |
| scoped note·등록 발췌 | 기존 실제 Mac fixture 통과 재사용 | preview/confirm/no-op/rollback/exclude/cancel, 재시작5회 및 stale 승인 차단. 사용자 실제 note 링크는 이번에 변경하지 않음 |
| 부분 CodeBurn timeout | 기존 실제+제어 실패 통과 재사용 | 실제 CLI 중 하나의 timeout wrapper, 다른 정상 결과/last-good 유지 및 다음 refresh 복구. 실제 공급자 장애를 주장하지 않음 |
| Orca 비모델 terminal | 기존 실제 격리 fixture 통과 재사용 | 승인된 등록 체크아웃 create/send/read/wait/cancel/PTY cleanup. 초기 selector 오류는 이력. AI Orca/Codex transport는 미실행이며 현재 수동 Claude 범위에 포함하지 않음 |
| 자원 baseline | 측정 완료·수용 목표 미합의 | 5e3b21a 읽기 전용32샘플, 앱 관련3~4프로세스 working-set 합264128~655936KiB·CPU합최대2.814%. 공유 페이지 중복 가능; 전체 시스템·고유 메모리·모델 peak·지원 기준을 뜻하지 않음 |
| native OS dialog·sleep/wake | 미실행 | 강제 절전/권한 대신 승인/거절 우회 없음. 실제 사용자 확인과 적용 필요 범위 결정이 남음 |

## 실제 모델 사용과 실패 기록

전체 누적 **CLI 생성 시도 8회 / 실제 prompt 전송 7회 / 성공 본문 5개 / 전송 후 취소 2회 / 전송 전 종료 1회**, 형식 수정 0회다. 성공 본문은 공개 파일럿·일반 v1·위 세 프로젝트 v2다. 별도 API/Codex 호출은 없다. 취소 요청의 원격 수락·청구 중단 여부와 정확 model ID는 확인하지 않았으므로 추정하지 않는다. 실패/취소 hash를 reset하거나 재전송하지 않았다.

최초 v1은 과거 제한/현재 승인 및 최신 작업 선택의 의미가 일부 실패해 입력 v2로 보완했다. 첫 a24e3be v2는 배경 freshness 만료로 취소됐다. c277031에서 stdin을 45초 보류하는 첫 검증 방법은 CLI가 입력 전달 전 exit1하여 실패했다(모델 prompt 전송0); 제품 background 통과로 주장하지 않는다. 다음 인증 callback 지연 검증에서 실제 생성·저장은 통과했지만 post-generation ‘new-start button enabled’ 대기는 stale 시작 차단 때문에 실패했다. raw report는 실패 그대로 유지하고 **실제 생성/저장 통과만 scoped-result로 분리**했다. 대표2 raw report는 숨긴 창의 screenshot timeout으로 실패했지만 생성은 저장됐으며 이후 독립 재시작·UI·중복 검사는 통과했다. 대표3 첫 검증 스크립트는 DAG 위치를 잘못 읽어 모델0으로 종료했고, 수정한 스크립트의 별도 actual/restart 보고서는 통과했다.

전송 범위는 기존 허용 연결 DAG·관측 설명·등록 발췌의 bounded selection이다. no-tools/no-MCP/no-session-persistence와 sanitized env, subscription 인증 검사와 민감정보/경로 guard를 유지했다. OS 파일 감금이나 민감정보 완전 탐지로 확대하지 않는다. 자동 호출·자동 개발 위임·자동 후보 승인·일괄 전송은 활성화하지 않았다. 연결되지 않은 PR/CI는 모델 입력에서 미확인이고, 이 문서의 정확 SHA CI 확인은 별도 외부 읽기 검증이다.

## 남은 실행과 사용자 결정

1. **사용자 결정:** 세 프로젝트 실제 한국어 설명의 사실/누락/다음 작업 유용성·긴 제한 문구 수용. 에이전트 검수로 대신 완료 처리하지 않는다.
2. **추가 실행:** 현재 일반 앱에서 실제 활성 상태를 유지한 예정 polling 2회 및 필요한 native dialog/sleep-wake 확인. 기존 포커스 실패를 감추거나 강제 반복 focus하지 않는다.
3. **사용자 결정:** 제품 최소 OS·지원 행렬·성능 목표와 native 검증의 필요 범위. ad hoc 로컬 설치를 배포 승인으로 확대하지 않는다.
4. **별도 후속 범위:** 후보 production transport 및 실제 AI Orca/Codex 실행. 현재 사용자 수동 Claude 예외와 구분한다.

Phase 2는 [방향·화면 수용·설계 논의 기록](../docs/plans/phase2-discussion-needed-2026-10-07.md)만 갱신했다. 사용자 v7 화면 고정 후 태스크 설계 순서를 유지하며 제품 구현에는 착수하지 않았다. 원래 Phase 1 DAG 수용기준/의존성 및 in_review를 유지한다.

비공개 로컬 근거: `native-background-authdelay-c277031/{report.json,scoped-result.json}`, `native-background-restart-c277031`, `native-project2-c277031`, `native-project2-restart-c277031`, `native-project3-unavailable-c277031`, `native-project3-ba58eb2`(스크립트 실패/모델0), `native-project3-actual-ba58eb2`, `native-project3-restart-ba58eb2`, `native-paid-cancel-ba58eb2`, `app-update-phase1-ba58eb2`. 입력·출력 원문/개인 프로젝트명·스크린샷은 공개 Git에 넣지 않았다.
