# 수동 프로젝트 AI 진단 기록

AI 프로젝트와 투자자문 프로젝트에서 동일한 일반 실패 문구가 보고됐다. 빌드2 조사 시 두 프로젝트의 저장 DAG 관측은 `cleanup_unverified`였다. 이는 query process group 정리를 확인하지 못해 해당 reader가 이후 관측을 차단한 상태다. 왜 최초 정리 확인이 실패했는지는 당시 로그에서 알 수 없다. 이전 버튼 클릭 시각/내부 예외/단계가 기록되지 않았으므로 각 클릭 원인을 소급 확정하지 않는다. 기존 ledger/권한/성공본문은 설치 후 baseline과 byte-identical이고 새 모델 예약은 없었다. 모델 호출 전에 durable ledger 예약이 필요한 현재 경로상 새 호출 근거가 없지만 과거 프로세스 추적을 수행한 것은 아니다. 정상 LaunchServices 실행의 stdout/stderr는 `/dev/null`이며 별도 raw 실행 로그는 없었다.

새 버전은 앱 데이터의 **`model-diagnostics/summary-cache-v1.json`**에 최소 진단 metadata를 저장한다. Mac 경로는 `~/Library/Application Support/note-app/model-diagnostics/summary-cache-v1.json`이다. 프로젝트 AI 영역의 **요약 진단 기록**에서 해당 프로젝트 최근12건과 파일 위치를 확인한다. 기록은 표시·재시작 조회만으로 모델을 호출하지 않는다.

- ISO UTC 시각, 임의 상관 ID, workstream 식별자의 SHA-256, 빌드 SHA, 시도1/2
- 단계: 근거/입력/예약/인증/모델/결과/저장/완료
- 고정 allowlist 오류 코드와 실행 관측: `not-started` / `launch-requested` / `started` / `unknown`

노트·프롬프트·모델 출력·원문 stdout/stderr·환경값·인증 정보·프로젝트 이름/경로·exception message/stack은 저장하지 않는다. unexpected field/code는 저장을 거부한다. 알려진 내부 오류 상수만 코드로 변환하고 그 외 오류는 단계별 일반 코드로 남긴다. DAG 차단 코드와 권한/매핑 검증 실패를 원문 없이 구분한다. 기록은 append 형태지만 고정 캐시 envelope를 원자적으로 교체하며 최대200 events/128KiB이고 저장·조회 때 30일 초과 event를 정리한다. directory0700/file0600, owner/canonical path/symlink/cache integrity 검증을 사용한다. 손상된 파일을 덮어쓰지 않는다. 앱을 실행하지 않는 동안의 삭제를 담당하는 별도 스케줄은 없다.

새 요청은 진단 시작 기록이 성공해야 근거 검사로 진행한다. 모델 실행 요청도 프로세스를 시작하기 전에 기록한다. 진단 저장이 실패하면 새 모델 실행 전에 차단한다. 프로세스 시작 이후 기록이 실패하거나 앱이 중단되면 마지막 `launch-requested` 등의 기록으로 시작/완료 여부를 확정하지 않는다. `started`는 실제 프로세스 시작 확인이며 응답 성공·토큰 사용·과금 확정을 뜻하지 않는다. 동일 입력의 결과 재사용은 `saved_input_reused`, 진행 중 같은 요청 합류는 같은 상관 ID의 `duplicate_joined`, 다른 프로젝트 요청 거절은 `request_busy`다. 실패·취소·저장 실패의 정확한 내부 세부 사항을 모든 경우에 구분하는 것은 아니며 기록되지 않은 과거 실패를 추측해 생성하지 않는다.

이 진단 파일은 성공 결과/모델 ledger와 분리된다. ledger는 `model-reading/ledger/summary-cache-v1.json`: 입력별 실행 예약·상태·시각·최대2회 receipt·제한된 일반 오류를 보관하고 최대128개 입력/64개 프로젝트이다. 최신 성공 본문은 프로젝트별 `model-reading/latest-<hash>/summary-cache-v1.json` 하나이다. 성공 ledger는 재호출 방지를 위해 시간만으로 지우지 않는다. 새 진단의 event 회전은 성공본문과 ledger에 영향을 주지 않는다. 과거 preflight 실패는 ledger에 기록되지 않았으므로 새 진단 적용 이전의 실패 시각/코드는 확인할 수 없다.

회귀는 synthetic adapter/CLI로 근거 차단·인증 실패·민감정보 검사·실행 관측·실패·취소·합류·중복재사용·재시작·200건회전/30일정리·symlink/손상 거부와 이전 성공/ledger 보존을 확인한다. 실제 사용자 모델의 재호출을 검증의 필수 조건으로 사용하지 않는다. `cleanup_unverified` 안전 차단은 제거하거나 자동 reader 재생성으로 우회하지 않는다.
