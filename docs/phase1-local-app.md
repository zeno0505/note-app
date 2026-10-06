# Phase 1 로컬 앱과 검수 범위

Phase 1은 로컬 Mac 앱, 실제 프로젝트의 근거 있는 한국어 설명, 앱이 소유하는 프로젝트 상태를 포함한다. 테스트나 합성 화면만으로 개발 완료를 선언하지 않는다.

- 공식 Orca 열린 워크트리의 지정 `docs/note` 심볼릭 링크를 등록된 범위에서 확인한다. 모호한 DAG/범위 연결은 사용자 선택을 앱에 저장하며 원본 링크를 바꾸지 않는다.
- 프로젝트 완료/재개는 사용자 결정이다. 완료 프로젝트의 정기 DAG·문서 조회는 멈추고 수동 지금 요약과 맥락·이력은 유지한다. 워크트리가 사라져도 등록된 프로젝트를 추적한다.
- foreground 20초, background 5분, 복귀 5초 대기를 사용한다. OS suspend는 예정 타이머를 멈추고 resume·focus·수동 갱신을 단일 조회로 합친다. 실제 OS 절전은 별도 검수한다.
- 창 닫기는 숨김이며 수집은 유지한다. 트레이 클릭은 창 열기만 한다. 명시적 앱 종료는 수집을 중단하고 앱 전용 저장을 정리한다. 트레이 popover·최근 3개 프로젝트 메뉴는 Phase 2다.
- 네 가지 설명의 문서 기록은 기록 있음/해당 없음/미기재/상충 기록을 구분한다. `statement`로 해당 없음이나 미기재를 명시할 수 있다. 결정 기록의 `designState`는 `discussion`, `designed`, `not-applicable`, `unrecorded`만 허용한다. 문서 존재·날짜·에이전트 완료로 설계 합의를 추론하지 않는다.
- DAG 갱신 필요 배지는 현재 관측에서 작업 연결이 검증된 PR 병합과 DAG 미완료 선언이 다를 때만 표시한다. hover/focus title에 작업과 근거가 있다. CI 성공을 작업 완료로 연결하거나 DAG를 수정하지 않는다.
- 등록 문서의 선택적 `links`는 `inbox`, `discussion`, `design` 역할과 명시적 `[[상대/문서#앵커|표시명]]`을 받는다. 프로젝트 노트 안의 정확한 파일만 Obsidian으로 연다. vault 전체 검색이나 날짜 기반 갱신 판단은 없다. renderer는 경로/URI 대신 main이 소유한 링크 ID만 보낸다.

## 로컬 패키지 준비

깨끗한 검증 SHA에서 `npm run package:mac:local -- --output /absolute/new/note-app.app --config /absolute/private/config.json`을 사용한다. `--config`는 선택이며 기존 시작 설정 형식이다. Finder는 셸 환경을 상속하지 않으므로 이 명시적 로컬 설정을 앱 Resources에 넣는다. 원본·설치 앱을 덮어쓰지 않으며 새 출력이 필요하다. 설정은 private regular file이어야 한다. 개인 경로가 든 설정과 앱은 공개 저장소에 넣지 않는다.

패키징은 다시 빌드하고 소스 SHA/트리와 entry/preload 해시를 manifest에 기록한다. 복사본 실행 파일과 CFBundleExecutable을 note-app으로 맞춰 실제 packaged 실행과 내장 설정 선택이 가능하도록 한 뒤 ad hoc 서명하고 구조·서명을 검사한다. 계정 인증서·보안 설정·자동 업데이트·설치는 변경하지 않는다.

## 최종 정확한 SHA에서 필요한 실제 Mac 검수

1. Finder/Dock 앱 실행 및 실제 note-app 연결·자동 발견/추가.
2. 사용자 완료/재개, 완료 후 정기 읽기 중단, 수동 요약과 이력.
3. DAG 배지 hover와 근거, explicit wikilink의 실제 문서 열기(해당 실제 근거가 없으면 격리 사례와 구분).
4. 트레이 클릭, 창 닫은 상태의 background 예정 조회, 다시 열기, 명시적 종료.
5. 사용자와 조율한 실제 sleep/wake, 중복 읽기 여부, 전체 Electron 프로세스의 유휴 CPU/RSS.
6. 실제 활성 창에서 두 번 이상의 예정 foreground 조회와 activity 타임라인.

타입·unit·SSR·CI·headless 실제 소스 조회는 위 네이티브 검수의 대체가 아니다. 실제 note-app 체크아웃에 지정 링크가 없으면 자동 발견을 완료로 표시하지 않으며 원본 링크 생성은 별도 승인 범위다. 모델 transport 차단은 유지한다. DAG 갱신, 개발 위임, 트레이 popover는 Phase 2다.
