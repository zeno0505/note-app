# Mac 설치 가드레일 검토: 단일 사용자 경로

> 이 문서는 승인 전 검토 기록이다. 이후 사용자 승인을 받아 구현·canonical 설치·43개 휴지통 이동·LaunchServices 선호 확인을 완료했다. 실제 적용 결과와 검사 한계는 [후속 보고서](../reviews/mac-canonical-installation-2026-10-07.md)에 기록했다.
**검토와 제안만 수행했다.** 구버전 삭제/휴지통 이동, Dock 변경, 새 설치 경로 적용, OS 등록 변경과 제품 가드 코드 구현은 하지 않았다. 투자자문 실제 생성·재시작 검증을 먼저 마치고 기존 경로의 최신 앱을 일반 실행으로 재개한 뒤 조사했다.

## 현재 사실과 대상 목록

현재 유일한 실행은 `artifacts/b35bdfe/note-app.app`, source be80587, PID78848이다. 이전 안내 경로 `artifacts/87a28ca/note-app.app`도 be80587이다. 그러나 [NSWorkspace의 bundle ID 질의](https://developer.apple.com/documentation/appkit/nsworkspace/urlforapplication(withbundleidentifier:))로 읽은 LaunchServices 선호 경로는 오래된 `artifacts/0012e3f/note-app.app`였다. 현재 실행과 기본 질의 결과가 다르다. 앞선 구버전 재실행의 직접 원인까지 확정한 것은 아니다.

알려진 작업 산출물과 두 표준 후보만 확인했다. 전체 개인 환경·외부 폴더·Spotlight·OS 등록 DB를 스캔하지 않았다. Dock preferences는 note-app에 일치하는 저장 항목만 추출했고 0건이었다. `~/Applications/note-app.app`와 `/Applications/note-app.app`는 현재 없다.

| 분류 | 수 | 현재 역할 | 제안된 처리(미실행) |
| --- | --- | --- | --- |
| 사용자 진입 경로 | 2 | artifacts/b35bdfe,87a28ca의 동일 최신 앱 | 단일 표준 설치 검증 후 기존 복사본 정리 검토 |
| 검증 산출물 | 17 | SHA별 packaged 앱, 최신 후보 포함 | 실행 가능한 복사본을 정리 대상으로 명시하고 필요한 산출물은 압축·manifest·근거로 보관 |
| 백업/원본 보존 | 24 | artifacts/backups 및 note-app.pre-*.app | rollback을 검증 가능한 압축본으로 보관하고 실행 가능한 원래 경로는 휴지통 이동 검토 |

43개가 모두 `dev.noteapp.local`, CFBundleShortVersionString0.1.0/CFBundleVersion1이었다. 대상별 path/source/category 목록은 private inventory에 보관했다. 삭제 명령을 준비하거나 실행하지 않았다. 목록이 미확인 폴더의 모든 앱까지 포함한다고 주장하지 않는다.

## 최소 변경안과 업데이트 순서

권고 사용자 경로는 **`~/Applications/note-app.app` 하나**다. 사용자 단위 경로라 system Applications보다 관리 범위가 좁다. 아직 적용하지 않았으며 설치 경로 확정과 해당 경로 쓰기 승인이 필요하다. 기존 `Library/Application Support/note-app`의 권한·성공 본문·ledger·프로젝트 상태·최근12개 이력은 보존한다.

1. 정확한 정리 대상과 사용자 설치 경로를 확정한다. 최신 빌드·서명·설정/프로필 스냅샷을 검증하고 같은 filesystem의 stage에 준비한다. 기존 앱을 먼저 모두 삭제해 사용할 앱이 없는 상태를 만들지 않는다.
2. note-app만 표준 Quit하고 실행 PID와 owned CLI 종료를 확인한다. 정상 종료를 거절하거나 사용자 저장 작업이 있으면 중단한다. 다른 앱 종료·강제 kill·권한 거절 우회는 없다.
3. 기존 canonical 설치가 있으면 교체 중에만 rollback 가능하게 보존하고 stage를 교체한다. 실패하면 원래 canonical 설치를 복원한다.
4. canonical 경로를 명시해 일반 실행한다. 실제 PID/executable/sourceSha/서명/main/preload/전체 dist와 설정·권한·모델 ledger·상태·이력 보존을 검증한다.
5. 성공 후 rollback `.app`를 압축하고 내용·manifest·hash와 복원 절차를 검증한다. 승인된 옛 사용자/검증/백업 복사본만 복구 가능한 휴지통 이동 대상으로 한다. 압축을 푼 rollback은 복원 시 canonical 경로 하나에서 실행한다.
6. LaunchServices의 note-app 질의가 canonical 설치를 가리키는지 확인한다. 필요하면 note-app 대상 등록/해제만 별도 검토하며 OS 전체 DB reset은 하지 않는다. Dock에는 현재 note-app 저장 항목이 없고, canonical 설치 핀은 원할 때 별도 결정한다.

휴지통 이동만으로 OS의 선호 질의가 자동 교정된다고 보장하지 않는다. 실제 질의와 실행 확인이 수용 기준이다. 확인 실패를 전체 등록 DB reset으로 우회하지 않는다.

## 제품 가드레일 제안(구현 미실행)

`src/main/host.ts`에는 이미 `requestSingleInstanceLock`와 `second-instance` 창 복원이 있다. [Electron 문서](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata)는 다른 프로세스가 lock을 보유하면 새 프로세스가 실패한다고 설명한다. 따라서 구버전이 먼저 뜨는 문제를 single-instance 추가만으로 해결할 수 없다.

- 사용자 package는 main의 실제 canonical executable/app 경로와 신뢰된 설치 manifest/build를 시작 시 확인한다. 잘못된 경로는 관측/AI 동작 전에 경고하고 검증된 설치본 열기를 제공하는 안을 검토한다. 복사본을 임의 삭제하지 않는다. 구버전에는 새 코드가 없으므로 기존 실행 가능한 복사본 정리와 함께 적용해야 한다.
- 앱정보에 실제 설치 경로와 build SHA/버전을 표시하고 현재 build footer를 유지한다. CFBundleVersion은 유효한 증가 build 번호로 관리해 모든 빌드가1인 상태를 끝내는 안을 검토한다. SHA만으로 OS의 버전 선호를 추정하지 않는다.
- 일반 사용자 앱과 검증 bundle의 bundle ID/display name/임시 userData를 분리하는 안을 검토한다. fixture 검증은 기본 실제 연동·모델 전송을 비활성화한다. 실제 허용 자료를 쓰는 검증은 승인 대상·권한·캐시 보존을 명시하고 credentials를 복사하지 않는다. 검증 경로가 OS 선호 경로에 영향을 주는 가능성을 줄이는 목적이다.
- 단일 경로/최소 build 검사는 lock과 함께 판단한다. 개발·검증 package를 전부 차단하거나 구버전의 lock을 강제로 빼앗는 방식은 제안하지 않는다.

## 적용 전 결정과 후속 검증

설치 경로(권고 ~/Applications),43개 중 정확한 정리 대상과 보존 압축 목록, 가드 코드·검증 identity 분리 범위를 사용자가 확정해야 한다. 현재 요청은 검토이므로 이후 설치/휴지통 이동/Dock/OS 등록 변경에는 별도 승인과 필요한 샌드박스 권한이 있어야 한다.

후속 수용 기준은 단일 canonical 경로의 일반 실행·정확 SHA/서명/프로필 보존, 잘못된 경로에서 검증 설치본 안내, 구버전 먼저/second-instance 상황, LaunchServices 선호 경로와 실제 PID 일치, 검증 bundle 분리와 압축 rollback 복원성이다. 아직 이 조건을 실제 시험하지 않았다.
