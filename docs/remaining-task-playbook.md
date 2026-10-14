# 남은 검증과 Mac 인계 절차

작성 기준: 2026-10-13 UTC. 이 문서는 실행한 Linux 검증과 아직 실행하지 않은 절차를 구분한다. 절차가 작성되었다고 해당 검증이 통과한 것은 아니다.

## 1. 후보와 증거를 먼저 고정하기

- 현재 작업본은 build34의 선택된 소스 스냅샷이다. Git 저장소나 설치된 Mac 앱이 아니다.
- 원본 commit: `fab58637da5fc1e01c39872f734f3f8792741f05`
- 원본 tree: `c02e7fb79a7bf8d9e4494ea4ab05686cf4298944`
- 원본 목록은 `SOURCE-MANIFEST.json`, 스냅샷 제한은 `LINUX-HANDOFF.md`에 있다.
- 기존 요약 입력 변경 8개 파일은 이전 기록을 바탕으로 재구성한 수정본이다. 원래 ZIP을 복원했다는 뜻이 아니다.
- 2026-10-13 Mac 인계 결과에서 build34 → build35 전체 delta가 이 재구성본의 6개 수정 + 2개 추가 파일임을 확인했고, 8개 모두 SHA-256이 일치했다. 따라서 선택된 소스 baseline은 제공된 build35 delta와 byte-equivalent다.
- 확인된 build35 commit은 `c681389c7331cd3331e7fe548cee838cd8733468`, tree는 `e8657d02ca7fa707ffebb4868d20e756449ffd11`이다. 로컬에 그 Git repository나 설치 앱을 materialize했다는 뜻은 아니다. 이번 후속 수정까지 포함한 현재 후보는 이 baseline과 별도로 해시를 기록한다.
- 공식 DAG 등록은 mutation 이전에 실패하여 기존 57개 항목이 그대로다. 아래 로컬 번호나 예정 매핑을 공식 등록 완료로 표시하지 않는다.
- 원본 commit만으로 현재 변경본을 식별하지 않는다. 각 실행은 현재 관련 파일의 SHA-256, 빌드 산출물 해시, 명령, 운영체제, 시작/종료 시각, 로그, 결과를 함께 기록한다.
- 기록 상태는 `not_run`, `running`, `passed`, `failed`, `blocked`, `stale`를 구분한다. 관련 소스가 바뀌면 그 이전 통과 결과를 새 후보의 통과로 옮기지 않는다.

이번 updater 증거는 원본 작업 디렉터리의 `../../evidence/continuation-updater-lifecycle/`에 있으며, `result.json`이 관련 파일의 해시와 명령·로그를 묶는다. 전달 패키지에서 이 위치를 바꾸면 링크와 실행 기록도 함께 갱신한다.

### 임시 작업 번호

아래 번호는 이 로컬 인계를 위한 임시 식별자다. 공식 DAG 등록이나 기존 DAG ID 매핑이 완료되었다는 뜻이 아니다. 공식 등록 확인 후 기존 항목과 중복을 대조하여 매핑한다.

| 로컬 ID | 작업 | 현재 범위/의존성 |
| --- | --- | --- |
| `LOCAL-LNX-01` | 제한된 회귀 및 요약 근거 시나리오 | Linux의 authored synthetic/conservative evidence 시나리오; 최종 aggregate는 상위 실행 기록 확인 |
| `LOCAL-LNX-02` | 검증 근거 popover | 구현 + 단위 검증 완료; 실제 runtime·최종 후보 pixels/정적 UI gate는 환경 제약으로 blocked |
| `LOCAL-LNX-03` | updater 수명주기 | 이 문서의 새 16개, 확인된 await 경계 결함 수정 및 기존 updater regression; native 설치는 별도 |
| `LOCAL-USR-01` | source 대조 및 공식 DAG 등록 | baseline 8개 delta 해시 일치 확인; 공식 등록 및 최종 추가 변경 대조는 미완료 |
| `LOCAL-USR-02` | native 전경 흐름 | Mac 연결과 사용자 준비 확인 필요; native fixture도 별도 결과로 기록 |
| `LOCAL-USR-03` | 실제 모델 유용성/사람 평가 | 지정 데이터·provider·호출 범위 승인 및 평가 필요 |
| `LOCAL-USR-04` | 배포·업데이트 채널 | 특정 게시·전송·설치와 restart 승인 필요 |

공식 DAG에 넣으려던 다음 매핑은 아직 미등록이다. 기존 57개 항목을 변경하지 않았다. 공식 등록을 다시 할 때 실제 현재 항목과 충돌 여부를 확인하고 확정된 ID를 받는다.

- `T057` 예정: full-chain 검증 (`LOCAL-LNX-01` 관련)
- `T058` 예정: 합성 usefulness 시나리오와 인계 playbook (`LOCAL-LNX-01`, `LOCAL-USR-03` 관련)
- `T059` 예정: verification popover (`LOCAL-LNX-02` 관련); 구현·단위 검증 완료, runtime/pixels blocked, 공식 등록 미완료
- `T060` 예정: updater preflight와 playbook (`LOCAL-LNX-03` 관련)
- `T061` 예정: 사용자 Mac updater 검증 (`LOCAL-USR-02`, `LOCAL-USR-04` 관련)
- `T062` 예정: 실제 사용자 유용성/native 확인 (`LOCAL-USR-02`, `LOCAL-USR-03` 관련)
- `T063` 예정: 남은 위험에 대한 사용자 결정, 보류 상태. 공식 risk acceptance를 받은 것으로 간주하지 않는다

## 2. 유지해야 하는 기존 검증

아래는 이전 보고의 유효한 범위다. 이번 Linux 실행 횟수에 더하지 않으며, 새로 실행했다고 표현하지 않는다.

- build30: 합성 데이터의 네이티브 앱 흐름에서 임시 DAG 생성·읽기를 포함한 검증 기록이 있다. 이를 미검증으로 초기화하지 않는다.
- build34: 실제 DAG를 읽는 host → IPC → 화면 연결과 주기적 갱신 검증 기록이 있다. 실제 DAG 전체 연결을 한 번도 확인하지 않았다는 설명은 부정확하다.
- build35: Mac 단위 검증 2,632개, Linux 단위 검증 2,597개 및 기능 통합 7개, headless Vue 5개, 비전경 Electron 5개 통과 기록을 보존한다. 이는 당시 후보와 당시 실행 방식의 기록이다.
- 남은 질문은 최종 후보에서 영향을 받은 전체 경로의 재확인, 실제 사용자의 이해·사용성, 실제 모델 응답 품질, 운영 배포 경로다. 앞선 합성 검증이 답한 질문과 혼동하지 않는다.
- 이전 `window_not_focused` 전경 조작 실패는 성공 증거가 아니며, 그 오류만으로 앱 결함이라고 단정하지 않는다.

## 3. 이번 Linux updater 검증

증거 종류: 합성 테스트 및 회귀 검증. 독립 검토에서 발견하고 새 회귀로 재현한 기존 updater 결함을 수정했다. 기다리던 journal 읽기 또는 app cleanup 도중 helper가 종료하거나 validation deadline이 지나도 기존 코드는 설치 재시작을 요청할 수 있었다. `src/main/update-service.ts`에 await 이후 helper 종료 여부·deadline·앱 종료 중 상태를 다시 확인하는 guard를 추가했다. 새 제품 기능을 확장하지 않았다.

| 확인 | 현재 결과 | 범위 |
| --- | --- | --- |
| `tests/unit/updater-lifecycle.test.ts` | 16/16 통과 | 수정 전 신규 경계 4개 재현 실패 → 수정 후 16개 통과; 모든 파일·프로세스·receipt 의존성은 mock |
| 기존 `npm run test:updater` | 79/79 통과 | 격리된 임시 fixture의 해시·설치 트랜잭션·복구·경계·source release 검증 |
| updater/quit 단위 검증 묶음 | 219/219 통과 | 수정 후 결과이며 새 16개 포함; 중복 합산 금지; 이전 수정 전 215/215 기록 보존 |
| 독립 updater 경계 재검증 | 4/4 통과 | 별도 검토자가 production source를 transpile한 synthetic VM으로 deadline/helper exit × journal/cleanup 경계를 재검증; native 설치 아님 |
| 최종 전체 단위 검증 | 2,695/2,695 통과, 124개 파일, skip 0 | 허용된 pinned query 의존성을 켠 Linux 결과; updater 부분집합과 중복 합산 금지 |
| 최종 typecheck·updater·production build | 모두 exit 0 | updater 79/79; 기존 Vite 약 911 KB chunk 경고는 남음 |
| 이번 후보의 실제 Electron updater UI | `blocked` / 실행 전 중단 | 전체 host의 Linux UNIX socket 제한이 별도 production-host 실행에서 확인됨; updater UI 자체는 이번 후보에서 실행하지 않음 |
| 실제 Mac native 설치·실제 사용자 앱 교체 | `not_run` | Linux 통과로 대체할 수 없음 |
| 실제 업데이트 게시·다운로드·외부 AI | `not_run` | 이번 작업의 실행 범위 밖 |

새 16개 회귀의 확인 내용:

1. staging 중 반복 설치 요청은 한 번의 handoff로 합쳐지고 quit 준비 receipt는 quit 수명주기가 요청하기 전 쓰이지 않는다
2. 정상 종료가 staging copy, pending intent 저장, journal 읽기, app cleanup을 각각 기다리며 뒤늦은 결과가 새로운 updater quit을 만들지 않는다
3. cleanup 거절, helper spawn 오류, validation 전 helper 종료, validation deadline 초과가 quit을 승인하지 않는다
4. 이미 소유한 deferral 저장이 완료되기 전 설치가 진행되지 않으며, 과거 저장 실패가 이후 성공만으로 지워지지 않는다
5. handoff 이후 새 동작은 차단되고 subscriber 예외가 수명주기를 깨지 않는다
6. journal 읽기를 기다리는 중 deadline 초과/helper 종료 또는 cleanup을 기다리는 중 같은 두 사건이 발생하면 설치 재시작 요청과 quit receipt를 차단한다. 이 네 가지는 수정 전 `installing`으로 잘못 진행됨을 재현했다

테스트의 `darwin` 분기는 mock 의존성을 가진 서비스 코드 경로만 선택한다. 실제 codesign, OS 프로세스 정체성, 파일 교체, 재시작은 이 테스트로 입증하지 않는다.

독립 검토 원문은 `../../evidence/remaining-work/independent-code-review.md`이며, 검토된 updater source SHA-256은 `ca2e89ecea45e929b6b06d4727c50536f70b2b866d98e91e00dfade19c06a969`, lifecycle test는 `49c80dc1a26dbdff264121d45487b0af2d36c86ad7882066e497aea3f42faa01`이다. 해당 검토는 독립 실행과 자기 테스트를 분리한다.

최종 전체 검증은 `../../evidence/remaining-work/final-unit.log`와 `final-unit.exit`, `../../evidence/remaining-work/final-type-updater-build.log`에 있다. 중간 실행의 typing 실패는 수정 후 위 최종 결과로 해소되었으며, 원래 실패 로그도 보존한다. 이 통과는 Mac 전경/native 설치 또는 실제 모델 응답 평가로 확대하지 않는다.

반복 실행 명령:

```sh
./node_modules/.bin/vitest run --root . tests/unit/updater-lifecycle.test.ts --maxWorkers=1
./node_modules/.bin/vitest run --root . tests/unit/update tests/unit/updater-lifecycle.test.ts tests/unit/quit-lifecycle.test.ts --maxWorkers=2
npm run test:updater
npm run typecheck
```

기존 `tests/electron/update-smoke.mjs`는 실제 Electron host와 production Vue/preload에 main-only 합성 updater를 붙인다. `NOTE_APP_E2E_HEADLESS=1`은 sandbox를 끄지 않는다. 해당 harness의 무조건적인 `git ls-files`는 이 Git 없는 스냅샷에서 준비를 막는다. 작성 중인 snapshot wrapper는 import adaptation 단계에서 실패했고 Electron을 실행하지 않았으며 최종 소스에서 제거했다.

별도 production-host UI 실행에서 `process_singleton_posix.cc:319`, `socket() failed: Operation not permitted`, `SIGTRAP`이 확인되어 전체 host를 다시 시도하지 않았다. updater actual UI는 이번 후보에서 미실행이며 기존 UI 통과 기록을 덮어쓰지 않는다. 이는 Linux 런타임 접근 제한이지 Mac 설치 실패나 updater UI 결함의 증거가 아니다. 보안 설정이나 `--no-sandbox`로 통과시키지 않는다.

## 3A. 검증 근거 popover (`LOCAL-LNX-02` / 예정 `T059`)

상태: **구현 + 단위 검증 완료, 실제 runtime/pixels gate blocked**. 공식 DAG 등록이나 UI 최종 승인 완료라는 뜻은 아니다.

- 태스크 상세의 검증·리뷰 출처 버튼은 기존 `createTaskVerificationReader`를 사용한다. 열기/다시 확인 시 fresh capability로 현재 원문을 읽고, 기록 없음과 읽기 실패·불완전 탐색을 구분한다.
- Markdown은 작성자 주장으로 표시하며 검증 미판정, 리뷰어 신원·대상 SHA·독립성 미확인을 유지한다. 원문 버튼은 새 capability를 얻어 기존 inline viewer로 이동한다.
- 닫기, task/DAG 기준 변경, current/active/scope 변화, background/unmount는 과거 기록을 숨기고 세션을 정리한다. 탭 이탈 중 늦게 끝난 원문 탐색은 재진입하더라도 hidden reader를 열지 않는다. 이미 열린 문서의 기존 persistence는 보존한다.
- 새 component/navigation 14개와 기존 reader/viewer를 포함한 focused 74/74가 통과했다. 실제 production template을 custom Vue renderer host에서 실행한 검증이며 실제 browser-native 포커스나 pixels의 증거는 아니다.
- 전체 host Electron 시도는 UNIX singleton socket 거절로 창을 열기 전 SIGTRAP. 지원되는 실행 권한 escalation도 명령 실행 전 bwrap synthetic mount target 오류로 중단되었다. Electron sandbox나 production singleton guard를 약화하지 않았다.
- cloud Chromium의 별도 renderer fixture 시도도 local HTTP 연결 거절로 화면을 얻지 못했다. 미검증 fixture 소스는 테스트 변경 묶음에서 제외하고 evidence 아래에 보존했다. 임시 서버와 preview 탭은 정리했다.

전달 패키지의 검증 결과와 한계는 `validation-summary.json`을 기준으로 확인한다. 세부 원시 로그·실패 기록·내부 검토 기록은 로컬에 별도 보존하며 패키지에 포함되었다고 가정하지 않는다. 정확한 후보 screenshot은 **없으며 static clearance는 하지 않았다**. Source-only 검토에서 정보 밀도/위계, 발견 가능성, 목표/방향, 오류/신뢰, 접근성/적응, 반복/중단의 여섯 차원을 각각 확인하거나 미확인으로 구분했다. 실제 버튼 fit/padding, popover 공백/그룹 간격, 전체 화면 위계, 반복 설명, keyboard/close/reopen와 narrow/200% 확인은 다음 실행에서 pixels와 interaction으로 검증해야 한다.

다음 최소 단계: local singleton socket을 지원하는 허용 환경에서 `tests/electron/verification-sources-smoke.mjs`를 기존 sandbox 옵션 그대로 실행하고, exact-candidate 화면을 독립 정적 검토한다. 그 harness는 아직 통과한 실제 UI suite가 아니며, visual 수정 뒤에는 반드시 재렌더·재검토한다.

## 4. 사용자 작업에 앞선 공통 gate

현재 절차들은 계획이며 실행 승인이 아니다. Linux 소스 검토·로컬 수정·로컬 테스트는 기존 범위대로 계속할 수 있다. 아래 행동은 해당 범위와 위험을 확인한 뒤 별도로 진행한다.

- Mac의 포커스 변경 또는 사용 중단이 필요한 비headless 동작은 시작 전에 예상 시간과 영향, 대상 창을 알리고 사용자가 준비되었다고 답할 때까지 시작하지 않는다. 끝나면 업무를 재개해도 된다고 알린다.
- 예상 시간이 늘거나 대상·영향이 바뀌면 멈추고 변경 범위를 확인한다. 포커스 오류를 반복 클릭으로 덮지 않는다.
- 사용자의 실제 설정·노트·계정·앱을 테스트 fixture로 삼지 않는다. 처음에는 소유가 확인된 별도 profile과 fixture를 사용한다.
- 외부 전송, 실제 AI 호출, 릴리스 게시, 다운로드, 실제 설치, credentials·권한·보안 변경은 각각 승인된 데이터·대상·행위 안에서만 한다. 이 문서는 그런 승인을 추가하지 않는다.
- 기존 사용자 작업을 덮어쓰거나, live 앱을 강제 종료하거나, 결과를 좋게 보이게 하려고 테스트를 약화하지 않는다.

## 5. 단계 A: build35와 최종 후보의 정확한 차이 확인

목표: 검증하려는 앱과 소스의 차이를 명시하고, 적용할 수정만 결정한다.

이미 확인된 것: build34 → build35 delta 8개 파일의 재구성본 SHA-256 일치. 남은 것은 이번 후속 변경이 포함된 최종 후보 대조와 공식 DAG 등록 결과다. 완료된 baseline 대조를 미확인으로 되돌리거나 불필요하게 다시 실행하지 않는다.

필요 입력:

- 사용자가 제공한 build35 소스 snapshot/manifest 또는 허용된 환경에서의 read-only 소스 확인
- 설치 앱의 버전·build number·full source SHA, package 메타데이터와 관련 파일 해시
- 최종 Linux 변경 목록 및 관련 파일 fingerprint

절차:

1. 제공된 파일과 manifest 해시를 검증한다. 설정·인증정보를 함께 가져오지 않는다.
2. build34 원본, 기존 재구성 8개 파일, 이번 수정, build35 현황을 구분해서 비교한다.
3. base가 다르거나 동일한 수정이 이미 있으면 적용을 멈춘다. 변경을 보존한 채 차이를 해소하고 필요한 수정만 선택한다.
4. 최종 후보 해시를 고정하고 영향을 받는 타입·단위·통합 테스트를 다시 실행한다.

필요 증거: 비교 파일 목록/해시, 결정된 변경 목록, 최종 후보 해시, 재실행 로그. 완료 조건: 어떤 후보를 검증하는지 모호함이 없고, 사용자 수정 손실이 없다. Mac 컴퓨터 사용이 필요하면 연결 상태를 확인한 별도 허용 작업에서 수행한다.

## 6. 단계 B: 실제 Mac 전경 흐름

목표: 최종 후보에서 키보드·포커스·dismiss·반복 동작을 실제 Mac 전경으로 확인한다.

사용자에게 먼저 제안할 범위: 약 10–15분, note-app 검증 창으로 포커스가 이동하며 그동안 해당 Mac에서 입력 작업이 중단될 수 있음. 저장 중인 작업을 마친 뒤 준비 확인을 받는다. 실제 설치는 이 단계에 포함하지 않는다.

1. 최종 앱 identity, 격리 profile, synthetic source/model 여부와 화면 크기를 기록한다.
2. 열기 → 키보드 이동 → Escape/취소 → 원래 버튼으로 포커스 복귀 → 재열기를 확인한다. 연속 클릭, 화면 이동, 새 응답보다 늦은 이전 응답도 포함한다.
3. updater Settings 진입만으로 check/prepare/install이 발생하지 않는지, 준비 중 화면 이동, Cancel, Later 복구, 재시작 결과 dismiss를 확인한다.
4. 대화상자의 초기 안전한 선택, Tab/Shift+Tab 범위, 좁은 창과 light/dark를 확인한다.
5. `window_not_focused`가 나면 대상 앱·활성 창·automation 상태를 기록하고 일시 중지한다. 앱 기능 실패와 도구 접근 실패를 구분한다.

필요 증거: 실제 수행 단계, 시간, 앱 identity, 전/후 screenshot, console/page error, 액션 수, 원래 작업 복귀 확인. 단순 screenshot 검토는 static review이며 실제 interaction과 분리한다.

완료 조건: 정해진 흐름을 실제 전경에서 한 번 끝내고 반복·취소 회귀가 없음. 결함이 있으면 최소 재현 → 허용된 수정 → 해당 경로 재검증으로 마무리한다. 미확인 항목을 성공 처리하지 않는다.

## 7. 단계 C: 격리된 Mac native updater

목표: actual macOS의 서명·PID·종료·교체·부팅·복구를 소유한 fixture 안에서 확인한다.

먼저 `tests/electron/native-updater-README.md`와 실행 스크립트를 다시 읽는다. 기존 harness는 private 임시 home, 두 Electron fixture copy, ad hoc 서명, synthetic SHA/build와 prebuilt stage를 사용한다. 실제 canonical 사용자 앱 교체 또는 게시된 소스 준비의 검증이 아니다.

사용자에게 먼저 제안할 범위: 약 15–25분, 검증용 앱이 열리고 정상 종료·재실행되며 포커스가 바뀔 수 있음. 준비 확인 후 시작한다. 최종 후보로 build하고 다음을 실행한다.

```sh
npm run build
NOTE_APP_NATIVE_UPDATE_EVIDENCE=/absolute/owned/evidence/path npm run test:electron:native-updater
```

확인할 세 가지 scenario:

- healthy: 실제 old PID 종료와 settled quit, 정확한 target 교체·backup, production renderer/main IPC boot ack, 맞는 terminal receipt
- crash: ack 없는 candidate 종료 뒤 정확한 old bytes 복원과 정상 재실행
- hang: ack 없는 live candidate를 강제 종료/덮어쓰기하지 않고 recovery-needed로 남김; fixture의 인증된 정상 quit 후 복원

필요 증거: OS/architecture, 최종 candidate/build 해시, signature 확인, plan/quit/boot/journal/receipt의 synthetic evidence, canonical/backup hash, owned process 종료, profile sentinel 보존, fixture cleanup 결과.

정지 조건: home/profile 소유권이 불명확함, real user app 경로에 닿음, 예상 밖 권한/서명 요청, live 프로세스 미종료, 복구 불확실성. 실패한 fixture는 증거를 보존한다. 강제 kill, backup 삭제, 보안 완화로 회복시키지 않는다.

완료 조건: 세 scenario 모두 통과하고 소유 process가 정상 종료함. 이 결과 뒤에도 production CLI detached handoff, 실제 canonical 사용자 앱 교체, 모든 interrupted phase, published-source 준비는 별도 잔여 항목이다.

## 8. 단계 D: 운영 배포 경로

목표: 승인된 특정 source release의 발견 → 다운로드 → 고정 SHA/local build → 검증 → 명시적 설치 → 재시작 결과를 끝까지 확인한다.

현재 상태: `not_run`. 게시 또는 다운로드를 시작하지 않았다.

필수 결정/승인:

- 유지관리자가 지정한 대상 commit·버전·증가 build number·changelog, 게시 저장소/채널/asset과 공개 범위
- 다운로드/로컬 빌드 및 실행할 소스, 설치 위치와 교체 대상 앱, backup/복구 계획
- 사용자 앱을 닫고 재시작할 시점과 사용자의 준비 여부
- 새 약관·인증·권한·보안 관련 요구가 생기면 해당 별도 승인 또는 사용자 handoff

절차:

1. 정확한 실제 Git checkout에서 clean 상태·고정 origin·package/lockfile 일치를 검증한다. 현재 archive에 가짜 Git identity를 만들어 release로 취급하지 않는다.
2. release 도구와 manifest를 검토한다. source identity와 lockfile hash는 대상 commit에서 도출되며 UI에서 임의 대상/SHA를 고르지 않는다.
3. 게시 승인 후에만 명시된 채널에 게시하고 remote asset·manifest·commit identity를 확인한다. 게시 승인은 실제 설치 승인과 별개다.
4. 승인된 환경에서 발견·prepare를 실행한다. source 변경/만료, 도구 누락, 취소, 무결성 오류는 기존 앱을 유지해야 한다.
5. native fixture가 통과하고 실제 교체 승인이 있을 때만 canonical 앱에서 install/restart를 실행한다. 종료 전 owned IO/collector cleanup과 helper validation을 확인한다.
6. 실제 restart outcome, installed bytes/build identity, profile 보존, backup와 receipt를 확인한다. 명확한 실패면 정확한 evidence를 남기고 승인된 복구 경로만 사용한다.

완료 조건: 승인된 동일 target에 대해 remote publication과 실제 설치 후 identity/receipt까지 연결됨. 서명·bundle·source SHA·배포 대상이 다르거나 backup/정상 종료가 불확실하면 멈춘다. 테스트 수 증가만으로 운영 배포 통과를 선언하지 않는다.

## 9. 단계 E: 실제 DAG와 실제 AI 품질, 사람의 사용성

전체 흐름의 소프트웨어 연결, 모델의 답 품질, 사람이 이해하는지는 서로 다른 질문이다.

Linux의 자동화된 유용성 점검은 직접 작성한 합성 입력과 보수적인 근거 처리 시나리오다. 누락·근거 없는 단정·unknown 처리의 코드상 회귀를 잡을 수 있지만, 실제 provider가 생성한 답변이 도움이 되는지 평가한 결과는 아니다. 실제 모델 유용성은 아래의 별도 승인된 전송과 응답 평가로만 확인한다.

### 최종 후보의 실제 DAG 경로 재확인

- 허용된 대표 source를 하나 정하고 읽기 전용으로 DAG → host → IPC → 화면 → 주기적 갱신 경로를 확인한다.
- 이전 build34 성공은 그대로 유지한다. 최종 후보에서 새로 실행한 범위만 추가한다.
- 실제 AI 승인이 없다면 model transport는 합성/차단 상태를 유지하고 그렇게 표시한다.
- 증거는 source identity/hash, 관찰 시점, host/IPC 상태, 렌더링된 task/근거, 갱신 전후 일치 여부다. 비밀·불필요한 원문은 보고서에 복제하지 않는다.
- 완료 조건: 선택한 source의 정의된 경로가 최종 후보에서 일치함. real AI 응답의 품질을 이 결과로 주장하지 않는다.

### 실제 모델 응답의 유용성 평가

- 실행 전 사용자가 허용할 대표 프로젝트 2–3개와 보낼 입력의 범위, 구체적인 AI provider/계정/모델, 호출 수·비용 상한을 정한다. 정기 전송이나 재전송까지 자동 허용된 것으로 해석하지 않는다.
- 실제 전송되는 excerpt와 누락 정보, 민감정보 탐지·동의 상태를 미리 확인한다. 동의가 없거나 대상/데이터가 바뀌면 호출을 멈춘다.
- source에 근거한 예상 핵심 사실을 미리 고정하고, 현재 상황·막힌 점·다음 확인 사항·true/false/unknown 구분·근거 연결·중요 누락을 평가한다.
- 합격 기준 예시: 중대한 근거 없는 사실 0건, 중요한 상태/차단 요인 누락 0건, 불확실한 사실을 단정하지 않음, 평가자가 원문을 전부 다시 읽지 않고 다음 확인 행동을 정할 수 있음. 사용자가 기준을 정한 뒤 바꾸려면 변경을 기록한다.
- 증거는 승인 범위, input/output identity, provider/model/시점, 실제 호출 수·비용, 항목별 판정과 근거다. 추정 또는 합성 응답을 actual AI로 세지 않는다.
- 완료 조건: 정해진 표본과 기준을 한 번 평가하고 발견한 중대한 오류의 처리 여부를 결정함. 무한 재요약이나 새 기능 확장으로 늘리지 않는다.

### 실제 사용자의 이해·사용성

- 사용자 또는 동의한 평가자에게 결함 목록을 알려주기 전에 “현재 프로젝트 상태와 다음 확인 사항 찾기”처럼 실제 목표를 준다.
- 처음 보는 화면에서 완료 여부, 막힌 지점, 잘못 이해한 표현, 불필요한 왕복과 중요한 결정을 기록한다.
- 작성자의 static UI 검토나 automation 통과를 실제 사람의 사용성 평가로 부르지 않는다.
- 완료 조건: 정한 과업의 이해 여부를 관찰하고, 중대한 실패가 있으면 해당 문제만 수정·재확인함.

## 10. 재개할 때

1. 가장 최근 사용자 범위와 승인, 해당 환경의 연결, 후보 해시를 다시 확인한다.
2. 로그·artifact와 실제 process 상태를 읽어 이미 완료한 장시간 작업을 중복 실행하지 않는다.
3. 같은 후보의 유효한 통과 기록은 보존하고, 바뀐 부분에 영향을 받는 증거만 `stale` 처리한다.
4. Linux에서 할 수 있는 남은 검증은 Mac 대기와 분리해 끝낸다.
5. 종료 보고에는 새로 통과한 것, 역사적 증거, 실패/blocked/not_run, 필요한 사용자 결정만 나눈다. 이 문서는 작업을 자동 재시작하거나 영구적으로 실행시킨다는 보장이 아니다.
