# Phase 1 결과 상태

**Phase 1 전체 완료는 아직 아니다.** 실제 Mac에서 읽기 연동과 수동 Claude 요약을 연결했고, 일반 프로젝트 실제 생성·저장·중복 방지·재시작을 확인했다. 실제 v1 출력의 의미 문제를 발견하여 v2 선별/승인 설명을 보완했으나, 새 v2 출력의 실제 내용 검수와 대표 프로젝트 사용자 수용 확인은 남아 있다. [최신 Mac 검토표](phase1-mac-review-2026-10-07.md)를 현재 판정 기준으로 사용한다.

## 확인한 제품 동작

- 실제 Orca 네 종류 조회, CodeBurn status/quota, canonical scoped DAG와 공개 GitHub의 읽기 연동
- 한국어 overview/detail/settings, 독립된 terminal/agent/DAG/PR/CI 근거와 unknown/stale 표시
- 이미 등록한 문서 발췌와 scoped task/goal 설명, 변경 시 재수집과 과거 승인 stale 차단
- 사용자가 허용한 연결 프로젝트의 **수동 Claude 요약**: bounded input, 전송 안내/확인, 비밀키·개인정보 검사, 네 섹션/근거/생성 시각/입력 hash
- 실제 일반 프로젝트 생성 1회, 동일 입력 추가 0회, 실제 재시작 추가 0회; 공개 파일럿 원문 보존
- 현재 입력 v2: 최신 작업/CI 우선, 현재 수동 승인과 과거 문서 제한 구분, 등록 문서의 현재 미대조 표시
- 모델 인증 확인의 비동기 취소, owned CLI 취소/늦은 결과 차단, 영속 no-replay ledger
- Mac 임시 Git fixture에서 note preview/confirm/no-op/rollback/exclude/cancel, 캐시와 승인 복원
- 실제 로컬 .app 패키징·ad hoc 서명·일반 실행·기존 상태/권한/이력/AI 캐시 보존 교체

각 항목의 실제/fixture/과거 소스 구분과 한계는 최신 검토표에 있다. 검사 개수나 DAG done 선언이 실제 요약의 품질을 대신하지 않는다.

## 남은 판정과 사용자 결정

1. **실제 v2 의미 검수:** v1은 과거 승인 기록과 최신 작업 선택의 설명이 불충분했다. v2 첫 실제 요청은 관측이 배경에서 오래되어 취소되었으며 성공 출력으로 취급하지 않는다.
2. **현재 패키지의 지속 foreground:** 포커스가 실제로 유지되지 않아 두 번의 예정 polling을 입증하지 못했다. 과거 실제 두 번 통과 근거는 남기되 현재 시도를 통과로 바꾸지 않는다. 실제 창 활성 유지가 필요하다.
3. **대표 프로젝트 수용:** 세 프로젝트의 한국어 설명을 사용자가 읽고 사실/추정, 누락, 다음 작업의 유용성을 확인해야 한다. 현재 사용자 승인을 대신하여 완료 처리하지 않는다.
4. **지원/성능 기준:** 실제 Mac 자원 baseline과 제품 최소 OS/지원 행렬, 성능 목표 합의를 구분한다. macOS 강제 sleep/wake·배포 notarization·전체 native permission dialog는 미실행이다.
5. **기존 작업별 후보 transport:** 수동 Claude 예외와 별도다. 자동 생성/개발 위임/일괄 전송/자동 후보 승인은 활성화하지 않았다. Phase 2 직접 실행은 새 합의에서 Orca 담당이다.

실제 Orca 비모델 terminal create/send/read/wait/cancel은 승인된 격리 fixture에서 확인했다. 초기 미등록 체크아웃 selector 오류는 과거 기록이며 현재 전부 미검증으로 반복하지 않는다. 실제 AI Orca terminal transport/Codex 실행은 별도로 미실행이고, 현재 수동 Claude 범위의 완료 조건으로 확대하지 않는다.

## 관련 기록

- [수동 AI 구현과 첫 Mac 검증](project-manual-ai-2026-10-06.md)
- [실제 resume/비모델 terminal 계약](mac-resume-terminal-2026-10-06.md)
- [Mac follow-up 및 올바른 대기](mac-followup-2026-10-06.md)
- [읽기 설명 계약](../docs/reading-summary.md)
- [현재 수동 AI 계획/입력 v2](../docs/plans/connected-project-manual-ai.md)
- [Phase 2 방향 합의와 논의 필요](../docs/plans/phase2-discussion-needed-2026-10-07.md)

원래 수용기준과 의존성은 유지한다. 개별 테스트 종료를 Phase 1 전체 완료로 해석하지 않는다.
