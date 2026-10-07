# 노트 재연결과 모델 실패 확인

프로젝트의 **재연결** 버튼은 제목이 **노트 재연결**인 디렉토리 선택창을 연다.
선택 후 같은 제목의 확인창에서 노트 디렉토리, 프로젝트 `docs/note`, 기존 링크와
DAG 파일 존재 여부를 검토한다. 체크박스로 링크 변경을 확인해야 적용한다.
취소나 재선택은 이전 확인표를 폐기한다. 선택만으로 파일이나 권한을 바꾸지 않는다.

선택 디렉토리는 기존 읽기 허용 범위 안이어야 한다. 범위 밖이면 연결 및 설정에서
읽기 허용을 명시적으로 추가하고 다시 선택해야 한다. 재연결이 읽기 권한을 확대하지 않는다.
전체 허용 root, 순환 경로, Git 추적 경로, 일반 파일·디렉토리인 `docs/note`,
심볼릭 링크인 `docs`는 거절한다. main이 선택 경로와 디렉토리 정체성,
현재 로컬 프로젝트, 기존 링크와 권한을 확인 시점에 다시 검증한다.

없는 `docs`와 `docs/note`만 생성한다. 다른 기존 링크는
`docs/.note-app-link-backup-<확인표 ID>/note`로 이동해 보존하고 새 링크를 배타적으로 생성한다.
동시 변경이나 생성 실패 시 백업과 현재 항목을 보존하며 기존 자료를 덮어쓰지 않는다.
노트 디렉토리의 내용은 수정하지 않는다. 성공 후 목록을 다시 조회한다.
DAG가 없는 디렉토리는 노트 연결을 할 수 있지만 AI DAG 요약에는 사용할 수 없다.

사용자가 지정한 `setup_note_link.sh`의 worktree root 기준 `docs/note` 계약을 반영했다.
스크립트를 실행하지 않으며, 스크립트의 노트 폴더 생성, `docs/note-root`,
Git exclude, 공유 `.gh-stack` 연결은 재연결 범위에 포함하지 않는다.
공유 vault 접근이나 프로젝트 데이터 변경 없이 선택 디렉토리와 프로젝트 링크만 처리한다.

연결 해제, 관측 오래됨, 연결 미확인, 허용 범위 밖, 등록된 DAG 없음,
DAG 접근 미확인과 조회 실패는 서로 다른 설명을 표시한다.
DAG 조회 실패를 링크 문제로 단정하지 않고, 재연결이 조회 오류를 해결한다고 약속하지 않는다.
실제 DAG 조회 성공까지 AI 버튼을 활성화하지 않는다.

모델 실행 진단은 비정상 종료, JSON 파싱 실패, 모델 오류 응답,
완료된 구조화 응답 없음, 프로세스 그룹 정리 미확인을 구분한다.
필요한 실패 기록에만 종료 코드·허용된 신호 범주·경과 시간·출력 바이트 수·정리 결과를 붙인다.
원문, stderr 내용, 인증 정보와 임의 예외 메시지는 저장하지 않는다.
기존 진단 기록과 저장된 요약은 그대로 읽는다. 정리를 확인하지 못한 adapter는 재사용을 막는다.
실패한 입력의 재사용은 `saved_failed_input_reused`로 표시하고 유료 호출을 반복하지 않는다.

검증: `npm run check`, `npm run test:electron:reconnect`.
Electron 검증에는 기존 live fixture와 같은 절대 경로 `NOTE_APP_PYTHON`,
`NOTE_APP_DAG_QUERY_PATH`가 필요하다. 실제 host/preload/renderer와 임시 Git 프로젝트에서
취소·반복선택·허용 밖 거절·백업·원문 보존·재시작을 검사한다. 모델 호출은 없다.

## 실패 진단 재시도

실패한 동일 입력은 일반 요약 버튼으로 다시 호출하지 않는다. 별도의
‘실패 진단 재시도 · 1회’ 확인표로 현재 프로젝트·입력 해시·전송 범위를 검토한다.
현재 검증한 입력이 마지막 실패 입력과 다르면 호출 전에 중단한다.
재시도는 동일 입력 해시와 기존 실패 run ID에 묶인 별도 영속 예약을 사용한다.
기존 ledger, 실패 예약과 성공 본문을 수정하거나 삭제하지 않는다.
전역 모델 실행 잠금을 공유하며 예약을 모델 실행 전에 저장한다.
예약 후 취소·중단·재시작해도 재호출할 수 없다. 예약은 최대128건이며 만료 삭제하지 않는다.
Claude 생성 최대1회, 형식 수정0회이며 진단 응답을 기존 성공 본문으로 게시하지 않는다.
원문·프롬프트·모델 응답·stderr·인증 정보는 별도 예약과 진단 로그에 저장하지 않는다.
진단 성공은 과거 일시 실패 원인의 확정이 아니다.

이 경로는 실제 수동 Claude CLI adapter를 사용한다. `summaryTransport: blocked`는
별도 후보 승인 워크플로의 Orca 터미널 Claude/Codex 전송 경로이며,
프로젝트별 수동 Claude 요약이나 이 진단 재시도를 차단한다는 뜻이 아니다.

격리 Electron 검증은 `node tests/electron/model-retry-smoke.mjs`로 실행한다.
live fixture와 동일한 절대 경로 Python·DAG query 환경을 사용하고,
임시 synthetic Claude executable만 호출한다. 사용자 모델 호출은 없다.

기존 등록 프로젝트의 모델 입력 재검증은 그 프로젝트의 저장된 scope와 DAG 선택을
사용한다. 다른 worktree에서 발견한 빈 상위 note 범위가 기존 프로젝트 범위와 겹쳐도
기존 연결을 새로 추측하지 않는다. 현재 허용 범위에 해당 scope가 있어야 하며,
실제 docs/note 링크와 DAG ID·canonical 경로가 기존 프로젝트와 일치해야 한다.
권한 철회나 링크 대상 변경은 모델 호출 전에 차단한다.

## 2026-10-07 UI 요청 정합성 감사

전달된 사용자 요청: “최근 추가 UI에 PrimeVue 테마가 올바르게 적용되지 않아 보임”,
“사용자에게 의미없는 hash 대신 선택디렉토리에서 DAG양식에 맞는 dag.yaml/back-dag.yaml 등을 파일명으로 나열”,
“요청했던 별도의 ‘노트 재연결’ 다이얼로그가 빠져보임”.
제목은 정확히 **노트 재연결**이며, 디렉토리 선택과 검증된 DAG 선택·확인을 한 독립 Dialog에서 제공한다.
재연결과 기존 링크의 읽기 연결 선택은 구분하며, 해시는 기본 선택 문구에 노출하지 않는다.

| 요구사항·수용기준 | build6 구현과 감사 | 수정 및 검증 증거 | 최종 설치 검증 |
| --- | --- | --- | --- |
| PrimeVue 선택/확인과 테마 | 실제 build6 native select, 기본 label에 scope hash. native 재연결 checkbox | Select/Button/Checkbox와 Aura primary·dark selector 통일. 격리 Electron 라이트/다크 화면 확인 | build7 실제 PrimeVue control/Dialog 픽셀 확인 통과 |
| DAG 파일명·상대경로 선택 | dag.yaml/dag.yml 존재만 확인, 다른 파일명·스키마·선택 없음 | 선택 폴더의 제한된 YAML만 authoritative query 및 phases/tasks 구조 검증. dag.yaml/back-dag.yaml 통과, 임의 YAML 제외. 선택은 main 소유 ID로 검증·저장 | build7/8에서는 정상 main dag.yaml(459)이 source_limit으로 누락돼 전체 요구 미충족. 16MiB 정합 수정 후 실제 scanner의 3개 유효 후보 통과, 최종 설치 목록 픽셀 확인 대기 |
| 클릭 즉시 ‘노트 재연결’ 독립 Dialog | 실제 build6에서 picker 취소 뒤 titled Dialog 0개 | 클릭 즉시 Dialog, 그 안에서 디렉토리 선택·DAG 선택·명시 확인. 독립 시작 화면·취소·Escape 통과 | build7 클릭 즉시 시작 Dialog, 미선택 확인 비활성, close/reopen/Escape 통과 |
| 데이터·권한 경계와 선택 유지 | 과거 링크 안전성 검증은 새 UI 완료 근거가 아님 | 격리 fixture의 원문/백업 보존, 취소, 허용 밖 거절, 복수 DAG, DAG 없음, back-dag 선택 후 재시작 통과. 모델 호출 0회 | 실제 사용자 프로젝트에서는 확인 버튼0회. 격리 확인·재시작만 수행 |
| 라이트·다크·좁은 창·scroll·close | 기존 Aura darkModeSelector=false | 760/1600px, 높이620px, 테마 전환 후 색상·scroll·닫기·footer·가로 overflow 검증 및 픽셀 확인 | build7 실제 설치 760/1600px·높이620px, 라이트/다크·scroll·close·취소·가로 overflow 없음 통과 |

타입 검사·빌드 및 외부 query를 포함한 단위 테스트 **1004 통과/13 skip**.
최종 소스의 격리 Electron 결과는 private `ui-reconnect-audit/electron-confirmed/report.json`(passed).
실제 build6 감사는 `canonical-before/report.json`(source SHA 85c0b5c, build6, 모델0회, 링크 확인0회).
수동 CDP 감사의 timeout은 실패로 보존했고, 후속 Electron launch 방식으로 실제 설치 재현에 성공했다.
Library 첨부 다운로드는 HTTP403으로 차단되어 OCR 메타데이터만 확인했으며 첨부 픽셀을 보았다고 주장하지 않는다.

기존 검수는 링크 안전성에 집중되어 요청한 시작 Dialog·파일 선택·테마의 완료를 입증하지 못했다.
이번 수정의 최종 설치 화면은 확인했다. 이 UI 검증을 Phase1 전체 수용 완료로 확대하지 않는다.
첨부·로컬 감사 증거는 private `ui-reconnect-audit/`에 보존하며 개인 경로·이미지를 Git에 넣지 않는다.

실제 수정 설치 감사: source SHA **495bd4e67bf7e70651cc362915a4e0b6434ceee2**, build **7**,
GitHub CI **37583623157 success**. `canonical-final/report.json`은 passed이며 모델0회·링크 확인0회.
`actual-start-dialog.png`, `actual-valid-dag-list.png`, `actual-selected-light-760.png`,
`actual-selected-dark-760.png`의 실제 픽셀을 확인했다. 초기 스크립트가 유효 후보에 dag.yaml을
강제해 중단한 결과는 `canonical-build7-first/`에 보존했고, 실제 검증된 후보로 수정해 재검증했다.
이후 문서만 갱신한 체크포인트는 앱 소스가 동일하다. 첨부 Library 픽셀 미확인은 위 HTTP403 제한으로 남는다.

## 정상 main DAG 후보 제외 회귀 정정

앞선 build7/8 목록 검증은 기존 main DAG를 포함하는 사용자 요구 전체의 완료 근거가 아니었다.
실제 AI 폴더의 dag.yaml은 2,317,185바이트·459개 작업이며 phases/tasks 형식에 맞지만,
새 후보 스캐너의 2MiB 제한으로 query 실행 전 source_limit 처리됐다.
후보 목록은 기존 reader의 **16MiB 상한**을 사용하도록 수정한다.
원래 허용 범위·파일 안전 검사·스키마 검사·출력 상한·기한은 유지한다.
2MiB를 넘는 정상459개 fixture 포함과 16MiB 초과 제외를 회귀 검증한다.
creator-launch-dag.yaml/growth-dag.yaml/layout-dag.yaml은 phases가 없어
현재 query의 phases/tasks 계약과 호환되지 않는다. 기존 loader의 빈0개 결과를 유효 DAG로 확대하지 않는다.
이 세 파일은 고정 코드 document_shape_invalid와 파일명을 UI에 표시한다.
실제 main dag.yaml 포함 목록과 제외 사유의 최종 설치 픽셀 확인 전 검수를 요청하지 않는다.

build7→8은 문서만 변경됐으며 dist 15개 파일의 바이트가 동일하다.
build8의 독립 Dialog·라이트/다크·scroll·close·읽기 전용 미리보기는 별도로 실제 실행·픽셀 확인했다.
이 사실은 main DAG 후보 누락을 해결했다는 의미가 아니다.

다크 배경 원인 확인: build8 실제 OS 다크의 app-shell은 #09090b(Aura surface950),
Dialog/새 선택 surface는 #18181b(surface900)다. 순흑 #000 명시 팔레트는 아니다.
이번 UI 수정에서 앱 전체 shell을 surface950에 연결하고 OS 테마를 따르게 해
이전 build6의 #f5f6f3 배경·darkModeSelector=false와 동작이 달라졌다.
기존 카드/헤더에는 밝은 배경이 남아 혼합 테마다. 팔레트 변경 합의는 없으며
현재 별도 사용자 결정 대기: 이번 DAG 회귀에서는 팔레트와 OS 설정을 변경하지 않는다.

회귀 수정 검증: 타입 검사·빌드, **1005 통과/13 skip**,
private `electron-size-regression/report.json`(격리 Electron passed).
`candidate-exclusion/fixed-actual-scan.json`에서 이미 허용된 실제 AI 폴더의
dag.yaml459/back-dag.yaml40/back-dag-custom-table.yaml14 포함과
스키마 미지원3개 제외를 확인했다. 모델0회·링크 확인0회.
최종 설치 결과와 픽셀은 같은 private `canonical-final/report.json` 및
`actual-valid-dag-list.png`/`actual-exclusion-reasons.png`로 연결한다.
문서 작성 시점 이후 최종 설치 통과 여부는 해당 보고서의 source SHA/build/status로 판정한다.

## 전체 테마 지원 승인

사용자가 “prime vue 색상을 기반으로 다크모드를 지원하는 방향”을 승인했다.
위 팔레트 결정 대기 기록 이후의 요구이며, 현재 구현·검수 기준은 [전체 테마 검수](theme-support.md)다.
기존 main DAG459 회귀는 보존하며 테마 변경이 사용자 노트·요약·권한을 변경하지 않는다.
