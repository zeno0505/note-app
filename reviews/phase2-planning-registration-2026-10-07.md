# Phase 2 계획 등록 검증 — 2026-10-07 KST

사용자 v7 화면 수용 및 후속 상태 Select 결정에 따라 [공개 설계·태스크 관계](../docs/plans/phase2-task-design-2026-10-07.md)를 작성하고 기존 note-app DAG feature phase 끝에 **T-036~T-048, 13개 planning/pending**을 등록했다. 제품 구현·스파이크·모델 호출·설치는 수행하지 않았다.

- 실제 ID: T-036, T-037, T-038, T-039, T-040, T-041, T-042, T-043, T-044, T-045, T-046, T-047, T-048.
- 총49태스크: done2 / in_review26 / pending21. 신규13개는 round:null, commits:[], e2e.required=false, covered_by:[]. 이는 실제 제품 검증 통과나 향후 검증 면제가 아니다.
- 공식 query 출력으로 등록 전후 기존36태스크의 ID/type/title/description/status/depends_on/acceptance_criteria/round/commits/e2e 동일 확인. 중복ID0 / 누락 의존 참조0 / 순환0.
- T-029~032의 원래 기준과 의존/상태는 보존하고 scope_revision에 제외·대체/보류 및 연결 ID만 기록했다. 최신 Phase2 적용 정책을 별도 추가했다.
- 공식 set.py dry-run 후 순차 적용, query 및 show-dag-stack renderer 성공. 새 QA/fix phase·branch·PR를 만들지 않았다.
- 7개 옵션 전체/작업 전/진행 중/검토 대기(PR 리뷰·태스크 완료 리뷰 포함)/논의 필요/검증 필요/완료 유지. 원본 lifecycle/타입 유니온·정책 근거·mappingVersion 보존, 논의/검증 보조 분류의 중첩·해석 미확인 전체 목록 보존을 T036/037/039에 포함했다.
- 기존 T029 실행 제어/T030 직접 위임 제외, T031 원문 쓰기/T032 트레이는 현재 수용 화면 밖 보류. 실행은 Orca, note-app은 관측·리뷰·파견 보류 권고.
- VueFlow/ELK 등은 정확 버전/459노드·500태스크 측정/worker/CSP/라이선스 검증 후 채택 후보다. 설치·성능 통과를 주장하지 않는다.

확인한 명령/절차: 공식 read-dag-stack query.py --brief/--index/--task/--policy, set-dag-stack set.py --add-task/--set scope_revision/--policy-add의 dry-run 및 실제 적용, show-dag-stack render.py, 원래 필드/의존 그래프 비교, git diff --check. 이번 검증은 설계 문서·DAG 구조 범위다. 정확 feature branch SHA/CI는 배포 인계에서 별도로 보고하며, 문서 CI가 제품 구현 또는 Phase1 수용을 의미하지 않는다.

로컬 비공개 등록 로그/초안/비교 결과는 `phase2-planning/`에 보존했다. 공개 문서에는 타 프로젝트의 비공개 원문·실명·절대 노트 경로를 넣지 않았다. 이후 들어온 Phase1 사용자 실제 리뷰 문제는 별도 수정 범위로 이어가며 이 설계를 Phase1 완료로 대신하지 않는다.
