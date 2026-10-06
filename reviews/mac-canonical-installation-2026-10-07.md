# Mac 단일 사용자 설치 및 foreground 검증 결과

2026-10-07 KST. 사용자가 승인한 `~/Applications/note-app.app` 설치와 기존 조사 대상 43개 정리를 적용했다. 설치 코드 SHA는 `261b4a992568328ed5b70ab0de844a51a2850654`, CFBundleVersion은 **2**다. 사용자 bundle ID는 `dev.noteapp.local`이다. 설치본과 검증본은 ad-hoc 서명 검증을 통과했다. main 병합이나 배포는 하지 않았다.

## 실제 foreground 확인

사용자가 창을 활성으로 유지한 정상 실행 앱(source `be80587`)에서 OS 활성 앱과 저장된 DAG 관측 시각을 매초 기록했다. 첫 ChatGPT 활성 샘플은 제외하고 note-app 연속 활성 구간 **20:30:55.567–20:31:51.427 UTC, 55.85초**를 구분했다. 최초 갱신은 20:31:00.893, 그 뒤 예정 polling 완료는 **20:31:23.565 / 20:31:46.188 UTC**이며 cache revision은 167→168→169였다. 수동 새로고침과 모델 호출은 없었다. 정상 실행이라 renderer 내부 telemetry를 붙이지 않았으며 OS 포커스와 실제 영속 관측 metadata에 한정한 확인이다. 사전 inactive 구간을 포함한 전체 측정을 모두 foreground 통과로 표현하지 않는다.

## 설치 가드와 실제 설치

잘못된 경로의 사용자 package는 collection/AI/IPC/single-instance lock 전에 경고한다. 검증된 canonical 대상의 metadata/build와 실제 codesign 검증이 성공해야 그 대상만 열 수 있다. 실제 native 경고 발생 시 windows/IPC handlers/CLI spawn은 0, lock은 false였다. 첫 경고 모달 검사에서는 inspector Quit가 timeout되어 자체 검사 PID만 강제 정리했다. 이를 정상 종료 통과로 취급하지 않는다. 별도 반복에서 앱 자체 안내 응답 0을 선택해 정상 종료했고, 설치 후 응답 1을 선택해 실제 canonical `shell.openPath` 성공과 기존 사용자 PID 유지도 확인했다. 응답 선택은 검사에서 제어했으며 사람이 OS 대화상자를 클릭한 검증은 아니다.

검증 package는 `dev.noteapp.verification`, `note-app Verification` 이름과 build/SHA별 private userData/sessionData를 사용한다. 실제 사용자 profile과 분리되어 있으며 bundled config와 유효한 `NOTE_APP_CONFIG` 환경값을 무시했다. 실제 검증에서 read roots 0, model disabled, CLI spawn 0을 확인했다. 사용자 profile의 권한을 복사하지 않았다.

기존 앱을 표준 Quit한 뒤 검증 stage를 canonical 경로로 이동했다. 설치 직전/직후 전체 bundle regular-file hash와 서명, config hash 및 protected profile bytes가 동일했다. 실제 설치본에서 Orca workstreams **71개**, 연결된 두 DAG **459개/77개**를 읽었다. 기존 두 실제 한국어 AI 결과의 input hash/생성 시각을 그대로 표시했다. 수동 Claude 제어는 사용 가능했지만 추가 모델 호출은 **0회**다. 재시작 후 저장 결과의 `stale`은 현재 입력 재검증 전 상태이며 자동 재생성하지 않았다.

읽기 권한·저장된 모든 성공 본문·model ledger·기존 harness 결과 등 보호 파일 8개가 byte-identical이다. 모든 기존 프로젝트 status/changedAt과 history content/order가 보존됐다. history latest12 정책을 확인했으며 이번 설치 검증에서는 기존 prefix eviction도 없었다. 760/1600 너비에서 실제 canonical 경로, build 2/SHA 표시와 가로 overflow가 없는 것을 확인했다. 최초 UI 검사 실패는 실제 `/` 표시와 검사 문자열 `·`의 불일치였으며 검사 수정 후 통과했다.

## 정리와 복구

기존 조사 **43개**의 path/source/metadata/main/Info.plist를 다시 비교한 뒤에만 이동했다. 성공한 일반 실행 canonical 앱을 유지하고 기존 대상 각각의 LaunchServices 등록만 해제했다. 복구 가능한 `~/.Trash/note-app-retired-<timestamp>/`의 고유 폴더로 43개를 이동했다. 원래 승인 대상 경로의 남은 앱은 **0개**다. 휴지통 비우기·영구 삭제·전체 LaunchServices reset·다른 앱/Dock 변경은 없었다. 코드·노트·사용자 profile·기존 증거와 sidecar 보고서는 보존했다.

canonical 앱을 대상으로만 등록한 후 bundle ID의 LaunchServices 선호 질의가 `~/Applications/note-app.app`을 반환했다. 최종 일반 실행 사용자 main은 **PID 60272 하나**이며 executable도 canonical이고 inspector 인수가 없다. 별도 identity의 검증 bundle은 검증 artifact로 남아 있으며 사용자 설치본으로 등록하지 않았다. 새로 만든 임시 wrong-path 검사 bundle은 검사 종료 후 정리했다.

이전 사용자 빌드 `be80587` 복구 ZIP은 127,953,588 bytes, SHA-256 `db0c3a3e72251bc1154ba1ce6578983869bee1370aa7a870177b5930c73f33a8`이다. 원본과 실제 압축 해제본 621 entries의 파일 hash/symlink/mode, config, signature가 같았다. private `canonical-installation/rollback.manifest.json`과 `retirement-report.json`에 archive 및 43개의 원본↔휴지통 경로와 복구 절차를 보관했다. 복구 시 note-app을 Quit하고 archive hash를 확인해 빈 stage로 풀고 서명/config를 검증한 후 canonical 앱을 교체하며 기존 사용자 profile을 유지한다. 휴지통을 비우지 않아 개별 이전 bundle도 원래의 빈 경로로 복원할 수 있다.

## 검증 및 남은 항목

코드 회귀 `npm run check`: **972 passed / 16 skipped**, typecheck/build 통과. 정확한 설치 코드 SHA의 [CI run 37525429798](https://github.com/zeno0505/note-app/actions/runs/37525429798)이 success다. native report/profile preservation/retirement/foreground timeline은 로컬 private evidence에 보관하며 config, 개인 노트, 실제 모델 입력/본문/스크린샷은 Git에 올리지 않았다.

이번 설치·정리는 완료됐지만 Phase 1 전체는 **in_review**다. 실제 요약의 의미/가독성에 대한 사용자 수용, 지원 Mac/장시간/OS 대화상자 수용 검증 등 기존 미완료 항목은 계속 별도로 관리한다. 독립된 CodeBurn collector 조사도 전체 완료로 합치지 않는다. 추가 모델 호출이나 보안 설정 변경을 이 설치 작업의 통과 조건으로 사용하지 않았다.
