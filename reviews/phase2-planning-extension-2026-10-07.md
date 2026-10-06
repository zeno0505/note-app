# Phase2 계정·미등록작업 계획 추가 등록

기존 T-036~04813개 planning/pending 등록에 T-050/T-051 두 계획을 추가했다. T-049는 별도 Phase1 사용자 검토 후속 in_review다. 상세 설계15개와 Phase1 수정 작업을 혼동하지 않는다.

- T-050: provider/account/profile/window별 quota 모델과 UsageScope 공식 read-only 수집 인터페이스 조사. 의존 T-036,T-043. 새 계정 연결은 별도 승인, 인증정보 복사는 금지.
- T-051: 등록 프로젝트 / 저장소 확인·프로젝트 미등록 / 저장소 미확인3단계와 알려진 프로젝트의 DAG 미등재task 구분, 검증된 repository metadata로만 사용량/메모리 귀속 및 별도뷰 설계. 의존 T-036,T-043,T-044,T-050.
- T-043은 화면 본체, T-044는 관측 원천을 유지한다. T-048 통합검증에는 기존 의존성을 보존하고 T-050/T-051을 추가했다. 기존 수용 기준·상태·commits/e2e는 보존했다.

공식 DAG setter dry-run 후 등록, 공식 reader 선택 필드 대조, dependency 검증과 dag.md 생성이 통과했다. 총52태스크, done2/in_review27/pending23, 중복ID/없는의존/순환0이다. 설치·제품 구현·실제 계정 연결·외부 폴더 스캔·모델 호출은 없다. 원문 메타데이터와 dry-run/apply 로그는 private evidence이며 Git에는 이 문서와 [상세 설계](../docs/plans/phase2-task-design-2026-10-07.md)를 보존한다.
