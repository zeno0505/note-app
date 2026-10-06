# Phase 1 결과 상태

> 최신 추가 검증: [투자자문 실제 생성·캐시 검증](phase1-investor-actual-followup-2026-10-07.md). 이전 empty/stale 기록은 당시 상태이며 새 결과와 구분한다.

**Phase 1 전체 완료는 아직 아니다.** 최신 사용자 실행 경로·구버전 대조와 설치/요약 표시 후속은 [사용자 검토 후속](phase1-user-review-followup-2026-10-07.md)에 있다. 현재 설치는 be80587이며 이전 설치 기록과 구분한다. 실제 Mac에서 Orca/CodeBurn 읽기와 세 연결 프로젝트의 수동 Claude v2 생성·저장·중복 방지·독립 재시작, 실제 UI 취소·owned CLI 종료를 확인했다. 배경에서 관측 시간만 지나 실행이 취소되던 문제와 legacy 선택 커밋 형식 호환성을 수정했다. 실제 v2 출력의 에이전트 검수는 통과했고, 사용자 내용 수용·현재 지속 foreground·지원/성능 기준은 남는다. [최신 Mac 검토표](phase1-mac-review-2026-10-07.md)를 판정 기준으로 사용한다.

## 확인한 제품 동작

- 실제 Orca 네 종류 조회, CodeBurn status/quota, canonical scoped DAG와 공개 GitHub의 읽기 연동
- 한국어 overview/detail/settings, 독립된 terminal/agent/DAG/PR/CI 근거와 unknown/stale 표시
- 이미 등록한 문서 발췌와 scoped task/goal 설명, 변경 시 재수집과 과거 승인 stale 차단
- 사용자가 허용한 연결 프로젝트의 **수동 Claude 요약**: bounded input, 전송 안내/확인, 비밀키·개인정보 검사, 네 섹션/근거/생성 시각/입력 hash
- 실제 세 연결 프로젝트의 v2 생성 각 1회, 동일 입력·독립 재시작 추가 0회; 공개 파일럿 원문 보존
- 현재 입력 v2: 최신 작업/CI 우선, 현재 수동 승인과 과거 문서 제한 구분, 등록 문서의 현재 미대조 표시
- 모델 인증 확인의 비동기 취소, owned CLI 취소/늦은 결과 차단, 영속 no-replay ledger
- Mac 임시 Git fixture에서 note preview/confirm/no-op/rollback/exclude/cancel, 캐시와 승인 복원
- 실제 로컬 .app 패키징·ad hoc 서명·일반 실행·기존 상태/권한/최근12개 이력 정책/AI 캐시 보존 교체

각 항목의 실제/fixture/과거 소스 구분과 한계는 최신 검토표에 있다. 검사 개수나 DAG done 선언이 실제 요약의 품질을 대신하지 않는다.

## 남은 판정과 사용자 결정

1. **대표 프로젝트 사용자 수용:** 세 실제 v2 본문의 에이전트 의미 검수를 마쳤다. 사용자가 사실/추정·누락·다음 작업 유용성을 확인해야 한다.
2. **현재 지속 foreground:** 과거 소스에서 두 번 예정 polling은 통과했지만 최근 시도는 실제 포커스 유지에 실패했다. 배경 모델 성공은 별도 실제 통과이며 계속 foreground를 요구하는 우회는 쓰지 않는다.
3. **지원/성능 기준:** 실제 baseline과 제품 최소 OS/지원 행렬·성능 목표 합의는 별개다. 실제 native dialog/sleep-wake 및 배포 notarization은 미실행이다.
4. **별도 후보 transport:** 현재 수동 Claude 예외와 구분한다. 자동 호출/일괄 전송/자동 후보 승인은 활성화하지 않았고, Phase 2 실행은 Orca 담당이다.

실제 Orca 비모델 terminal create/send/read/wait/cancel은 승인된 격리 fixture에서 확인했다. 초기 미등록 체크아웃 selector 오류는 과거 기록이며 현재 전부 미검증으로 반복하지 않는다. 실제 AI Orca terminal transport/Codex 실행은 별도로 미실행이고, 현재 수동 Claude 범위의 완료 조건으로 확대하지 않는다.

## 관련 기록

- [수동 AI 구현과 첫 Mac 검증](project-manual-ai-2026-10-06.md)
- [실제 resume/비모델 terminal 계약](mac-resume-terminal-2026-10-06.md)
- [Mac follow-up 및 올바른 대기](mac-followup-2026-10-06.md)
- [읽기 설명 계약](../docs/reading-summary.md)
- [현재 수동 AI 계획/입력 v2](../docs/plans/connected-project-manual-ai.md)
- [Phase 2 방향 합의와 논의 필요](../docs/plans/phase2-discussion-needed-2026-10-07.md)

원래 수용기준과 의존성은 유지한다. 개별 테스트 종료를 Phase 1 전체 완료로 해석하지 않는다.
