# 2026-10-06 note-app 실제 읽기 관측

## 확인된 결과

기준 feature SHA f33dc5488c9f64914ddd3e63503aadf8dbeef9c8에서 공개 note-app
GitHub 어댑터를 추가하고 실제 main runtime을 headless로 확인했다.

- 실제 note-app PR(state=all) 목록은 0개였다. PR을 생성하거나 병합하지 않았다.
- feature branch head는 위 SHA였고 Actions 37408603855는 push event로 성공했다.
  직접 푸시 CI와 PR 승인·병합·리뷰 완료를 구분하여 한국어 문장에 표시했다.
- note-app 프로젝트에 등록된 실제 DAG를 공식 query로 읽었다. 28개 작업,
  완료 선언 1개/pending 27개, 모든 task commits는 빈 목록이고 round는 null이었다.
  열린 회차는 없었다. 특정 task와 최신 커밋·PR의 대응은 미확인이다.
- 안전 체크아웃에는 docs/note 링크가 없어 기본 link mapper는 연결되지 않는다.
  startup의 정확한 worktree/scope/DAG 읽기 등록으로 해결했다. 기존 link mapper는
  유지하며, 새 등록은 링크 생성·사용자 파일 수정과 다른 읽기 연결로 표시한다.
- 실제 Orca collector 결과에서 승인된 note-app 체크아웃 한 개만 선택해 전달했다.
  실제 scope mapper·공식 DAG reader·공개 HTTP observer·reading scheduler를
  함께 실행했고 DAG ready/28 tasks 및 네 섹션/직접 push CI 문장을 확인했다.
- 연속 지금 요약에서는 변경이 없어 generatedAt/revision을 유지했다.
  사용자 DAG 원문 해시와 mtime도 유지했다. 모델 호출 0, GUI 실행 0.

로컬 진단의 외부 근거 관측 시각은 2026-10-06T04:28:29.158Z이다. 이는 해당
시점/기준 SHA의 증거이며 이후 feature push의 CI는 별도로 확인해야 한다.
원시 JSON/로그, 실제 host/worktree/path와 노트 source hash는 로컬에만 보존했다.
사용자 DAG/노트 내용이나 토큰을 공개 fixture/저장소에 복사하지 않았다.

## 앱 접근과 개발 커넥터 구분

공식 GitHub 커넥터도 PR 0개와 같은 SHA의 push CI 성공을 보여주었다. 앱은 그
커넥터 인증을 사용하지 않는다. 기존 gh auth 상태는 invalid였고 credential/token
값을 읽지 않았다. normal 실행 sandbox의 공개 REST 진단은 DNS ENOTFOUND였다.
승인된 네트워크 실행 환경에서는 토큰 없는 공개 GitHub REST가 200으로 응답했고,
실제 앱 observer도 같은 방식으로 성공했다. 앱 사용자 환경의 네트워크 접근이
항상 가능하다는 증거는 아니며 실패를 빈 PR/완료 결과로 바꾸지 않는다.

새 토큰 생성·로그인·권한 확장·지속 접근/보안 설정 변경·모델 호출은 없었다.
다른 저장소 GitHub API는 조회하지 않았다. 글로벌 Orca discovery의 기존 읽기
결과는 로컬에서 note-app 한 개로 필터링하여 타 프로젝트 노트 매핑을 실행하지 않았다.

## 검증

최종 `npm run check`: typecheck/build 통과, **837 passed / 16 skipped**.
public observer·규칙 읽기·config/실제 mapper·runtime 연동을 포함한다.

- 직접 푸시/빈 PR, 실제 merged flag와 preview SHA 분리
- head exact SHA Actions와 workflow별 최신 실행, 옛 SHA/foreign SHA
- formal review와 COMMENTED/DISMISSED·댓글 분리, 리뷰 pagination이면 승인 미확인
- 공개 고정 repository/host/GET/redirect/auth header 경계
- 5분 cache, 수동 15초 중복 제한, 동시 요청 합류, 403/429 cooldown
- response/aggregate bytes·배열·요청 수·독립 deadline·취소/late 결과 상한
- partial 및 일치 SHA의 historical CI, 새 head/현재 PR로 과거 CI 전이 금지
- 수집 중 head 변경이면 혼합 결과 거부, 최종 ref 재검증
- 명시적 읽기 등록의 missing/existing link 보존, scope/path/host/DAG 제한
- production factory wiring과 수동 intent, 이전 네 섹션/후보·승인 상태 회귀

## Phase 1과 남은 조건

현재 조건 중 실제 note-app 읽기 수집·DAG 연결·직접 push CI 출처·변경 없음의
재요약 no-op은 확인했다. 실제 PR이 없어 병합/리뷰 변동은 합성 회귀로 보완했으며
실제 성공으로 표시하지 않는다. CodeRabbit/리뷰 에이전트 완료도 확인되지 않았다.

전체 Phase 1 완료는 보류한다. 남은 조건은 실제 프로젝트 네 섹션의 사용자
이해도/정확성 수용, native 화면과 실제 5분 cadence/자원 관측, 필요한 목표·설계·
화면/테스트 증거 입력의 좁은 등록, task/round/commit의 명시적 대응 검증이다.
일반 CI 성공만으로 화면 검수나 모든 요구 구현을 판정하지 않는다. 실제 PR가 생기면
기존 어댑터의 관측 범위에서 검증하되 이 작업을 위해 임의 PR/병합을 만들지 않는다.

실제 검증은 private in-memory startup 등록으로 수행했다. 사용자 글로벌 앱 설정은
자동 변경하지 않았다. 이후 native 실행 시에도 동일하게 승인된 등록 파일만 사용한다.
다른 저장소 확대나 자유 모델 종합은 이번 검증에 포함하지 않는다.
