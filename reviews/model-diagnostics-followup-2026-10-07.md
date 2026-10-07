# 프로젝트 AI 실패 조사와 안전한 진단 기록 적용

사용자가 ai 및 투자자문 프로젝트에서 ‘지금 요약’ 실패를 보고해 읽기 전용으로 기존 기록을 조사한 뒤, 추가 승인을 받아 진단 구조를 구현하고 canonical 앱을 업데이트했다.

## 기존 기록에서 확인한 범위

기존 앱은 canonical 경로의 source `261b4a9`, build2였다. 두 프로젝트의 저장된 DAG 관측은 `state=error`, 안전한 원인 범주 `cleanup_unverified`였다. query process group 정리를 확인하지 못하면 reader가 해당 lifetime의 후속 관측을 차단하는 구현이다. 최초 정리 확인 실패 이유는 기록되어 있지 않다. 버튼 클릭 시각/실패 단계/예외 코드도 저장되지 않아 각 클릭의 직접 원인을 소급 확정할 수 없다. generic UI 문구만으로 민감정보 차단이나 Claude 인증 실패라고 단정하지 않는다.

모델 ledger는 revision20, runs10/requests5 그대로이며 마지막 persisted run은 기존 성공 시각 `2026-10-06T19:43:19.659Z`였다. 실제 실행 경로는 새 모델 호출 전에 durable 예약을 기록하므로 새 예약이 없는 이번 조사에서 새 호출 근거가 없다. 당시 프로세스를 추적한 것은 아니다. 기존 read permissions·5개 최신 성공본문·ledger·legacy harness의 보호 파일8개는 이전 검증 baseline과 byte-identical이다. 전역 model-slot lock도 없었다. 정상 실행 앱 stdout/stderr는 `/dev/null`이며 별도 app log directory가 없었다.

## 적용 내용

[진단 저장 계약](../docs/model-diagnostics.md)에 따라 고정 allowlist의 단계/코드, UTC 시각, hashed workstream ID, 임의 correlation ID, build SHA, 시도 번호와 모델 시작 관측만 기록한다. 원문 노트/프롬프트/모델 출력/raw stdout·stderr/환경값/인증/개인정보/exception message·stack은 기록하지 않는다. private app cache로 최대200 events/128KiB, 저장·조회 시 30일 초과 기록을 정리한다. 손상/symlink/owner/mode/path 검증 실패 시 원래 파일을 보존하고 새 모델 실행 전에 기록 실패를 차단한다.

프로젝트 화면 **요약 진단 기록**에서 최근12 events와 `~/Library/Application Support/note-app/model-diagnostics/summary-cache-v1.json` 위치를 확인한다. 최초 실제 요청부터 파일이 만들어지며 과거 실패를 추측해 생성하지 않는다. 호출 요청과 프로세스 시작 확인을 구분하고 중단 후 완료 기록이 없는 경우 unknown으로 해석해야 한다. 프로세스 시작 확인은 응답 성공/과금 확정이 아니다. 중복 합류/저장 결과 재사용/다른 프로젝트 동시 요청 거절도 기록한다. 기존 성공본문/재호출 방지 ledger와 분리되어 있다.

## 검증·설치

정확한 코드 source `dde16517c8919cf68e99f567de3b8390871b7209`, tree `ec35e7f92bc3170c2ead09cf80d10200e9782095`. 전체 check **979 passed/16 skipped**, typecheck/build 통과, [코드 CI 37562513967](https://github.com/zeno0505/note-app/actions/runs/37562513967) success. synthetic adapter/CLI로 preflight·민감정보·인증 실패, 모델 시작 관측, 취소·합류·동시 요청·동일 입력 재사용·재시작 조회, 제한/회전과 파일 보안 거부를 확인했다. 실제 실패 분류에서 임의의 오류 원문을 저장하지 않는 것도 검사했다.

빌드3을 `~/Applications/note-app.app`에 설치했다. 이전 빌드2 압축 복구본을 실제로 해제하여621 entries의 hash/mode/symlink/config/signature 동일성을 검증한 뒤 표준 Quit와 stage 교체를 수행했다. 설치 전후 전체 staged bundle regular-file hash/서명/config/profile bytes를 확인했다. 실제 native app에서71 workstreams, 두 DAG459/77을 조회했고 두 이전 한국어 성공본문의 input hash/생성시각과 진단 bridge/UI/파일 위치를 확인했다. 실제 모델 재호출은0이며 새 요약 버튼을 실행하지 않았다. 따라서 진단 화면의 기존 event 수는0이며 과거 실패를 새 로그인 것처럼 보여주지 않는다.

설치 후 read permissions/모든 성공본문/ledger/legacy harness8개 보호 파일은 byte-identical이고 모든 프로젝트 status/changedAt은 그대로다. DAG error→ready 관측에 따른 history가 추가됐으며 latest12 정책에 따라 oldest-prefix만 제거하고 retained suffix content/order를 검증했다. 별도의 독립 normal launch 후 source/build/서명/전체파일 hash, canonical LaunchServices 선호, 일반 main PID **42313 하나**를 확인했다. 검사기 인수는 없다. 원래43개 Trash는 건드리지 않았다. 교체 중 보존한 owned build2 bundle은 압축 복원 검증과 새 설치 검증 후 정리했다.

private evidence는 로컬 `failure-diagnostics/`의 original-failure-investigation/install/report/preservation/final-report 및 rollback manifest와 ZIP에 보관한다. 기존 build2 rollback ZIP SHA-256은 `37ebd94e2ba9b21a34f3a9c6864e04536f37ac6d15f9772d102cda3b19f3d85c`다. config/개인노트/실제 모델 입력/출력/스크린샷은 Git에 올리지 않았다. feature branch에 직접 체크포인트했고 main 병합/배포는 하지 않았다.

## 남은 원인 조사

앱 재시작 이후 두 DAG가 ready로 복구된 현재 관측을 확인했지만, 최초 cleanup 실패 원인을 고쳤거나 재부팅 문제 재발을 막았다는 의미는 아니다. 재발하면 새 진단의 시각·상관 ID·source-check/code와 모델 시작 여부로 다음 조사를 좁힐 수 있다. cleanup 안전 차단을 제거하거나 미확인 프로세스를 종료하거나 reader를 자동 재생성해 우회하지 않았다. Phase1 전체는 in_review이며 실제 내용의 사용자 수용과 기존 OS/장시간·성능 항목이 남아 있다.
