# 2026-10-06 규칙 기반 네 섹션 검증

## 결과

새 요구의 독립적인 읽기 요약을 기존 live runtime에 추가했다. 연결된 비보관
프로젝트의 기존 DAG display projection으로 네 섹션의 문장 설명을 만든다.
기존 source collection 주기와 읽기 summary scheduler를 분리했고, 실제 소스
새로고침과 별도로 ‘지금 요약’ IPC/버튼을 제공한다. 모델 호출, 사용자 DAG/노트
쓰기, 앱 종료 후 서비스, 실제 GitHub PR 조회는 없다.

기존 여섯 관점의 모델 후보·승인·historical 상태와 production transport 차단은
유지한다. 읽기 요약은 사용자 승인 기록으로 저장하지 않는다. 완료 선언과
PR 병합을 테스트·화면 검수·배포 증명으로 바꾸지 않는다. 고정 규칙의 추론
한계를 화면에서 설명하며 설계 합의와 검수 입력 부재는 미확인으로 남긴다.

## 검증

최종 `npm run check`: typecheck 통과, **813 passed / 16 skipped**, build 통과.
새 scheduler/PR 합성 계약, runtime 주기·수동 합류·끊기, renderer SSR 검증을 포함한다.

- PR-only 변경/DAG 불일치, squash·foreign task·매핑 미확인
- 현재 head SHA와 옛 SHA CI/리뷰, 수정 요청과 승인 기록 분리
- 부분/빈 결과, 생략된 의존성, 사용자 지정 완료 vocabulary
- 관측 시각·projection 밖 DAG hash-only 변경의 재생성 no-op
- 동시 수동/예약 합류, reconnect no-op, departed scope 제거
- 취소 전 IO 미시작, scope 전환/취소 후 late response 게시 차단
- PR 실패 시 동일 scope의 과거 근거 표시, stalled adapter retirement
- 외부 조회 fanout·시간·응답/배열/문자열·scope·SHA/시각 상한
- 화면 미기동 SSR의 네 문장 섹션, 출처 escaping, 읽기 요약과 승인 분리,
  연결 상태에 따른 두 버튼, renderer 늦은 요약 RPC 억제

직전 restricted 전체 검사에서는 모든 assertion은 통과했지만, 기존 fake-provider
테스트의 소유 process group kill에서 `EPERM` unhandled error가 발생했다.
이 실행은 성공으로 세지 않았다. 소유한 비모델 fixture의 프로세스 정리가 가능한
실행 환경에서 최종 검사를 다시 완료했다. fake-provider 코드를 바꾸거나 실패를
삼키지 않았다. 원시 실행 로그는 로컬에만 남긴다.

## 아직 미검증/필요한 다음 단계

- 실제 조회 저장소와 PR/task/round/commit 연결 범위 결정 후 production
  read-only GitHub adapter 구현 및 실제 head/merge SHA·CI·리뷰 대조
- 사용자 동의 후 Mac native 네 섹션/지금 요약, 실제 5분 background/resume,
  CPU/RSS/전력과 프로젝트별 문장 유용성 확인. 이번에는 앱/업무 화면을 점유하지 않았다.
- 목표·설계 합의·화면 검수 등 추가 근거의 좁은 등록 방식. 현재 입력에 없는
  근거는 요약 문장으로 발명하지 않는다.
- 자유로운 모델 종합이 필요할 경우 별도 실행 범위/비용/격리 승인 및 검증.
  이 규칙 기반 기능은 그 승인을 기다리지 않고 사용할 수 있다.

전체 Phase 1 완료나 실제 GitHub 연동 성공으로 판정하지 않는다. 사용자 DAG를
자동 수정하는 track-dag-stack 전체 호출도 하지 않는다. 정확한 제품·어댑터 경계는
[reading-summary.md](../docs/reading-summary.md)에 기록했다.

### 후속 대조 보완

미병합(open/closed) PR에 mergeSha 값이 있어도 실제 병합 커밋으로 설명하지 않도록
추가 제한했다. 과거 PR 병합 커밋 설명도 이전 관측임을 문장에 표시한다.
후속 typecheck/build 통과, reading-summary 집중 테스트 **30/30 통과**.
첫 체크포인트의 전체 CI도 성공했다. 최종 원격 SHA의 CI는 별도로 확인한다.
