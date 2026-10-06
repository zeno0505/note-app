# Mac 후속 검증 — 2026-10-06

**Phase 1은 미완료다.** 실제 프로젝트의 새 한국어 요약 생성·품질 검토·사용자
승인까지 검증하지 않았다. production transport는 계속 차단되어 있다.

기준 코드는 `b251ecb5a2a219eff85cbffa5f0bb33ce33813dc`다. 독립 체크아웃과 임시
Electron 프로필을 사용했으며 기존 프로필·사용자 노트·사용자 프로젝트 등록·
기존 터미널·접근 설정을 변경하지 않았다. 실제 모델 호출은 0회다.
실제 프로젝트 이름/경로/내용과 원시 응답은 이 공개 보고서에 포함하지 않는다.

## 예정 foreground polling

실제 Mac Electron 창과 합성 CLI fixture를 사용했다. 초기 성공 이후 60.6초 동안
200ms 간격의 관측에서 `active/focused/visible=true`를 유지했다.
포커스 복구, native blur/hide는 각각 0회였다. 초기 수집 전의 inactive 상태를
측정 구간 성공으로 포함하지 않았다.

| 수집 | 시도 UTC | 완료 UTC | 결과 |
| --- | --- | --- | --- |
| initial | 01:54:22.956 | 01:54:23.728 | success |
| poll 2 | 01:54:43.730 | 01:54:43.940 | success |
| poll 3 | 01:55:03.942 | 01:55:04.129 | success |
| poll 4 | 01:55:24.131 | 01:55:24.342 | success |

이 결과는 Mac 창의 활동 정책과 실제 타이머를 검증한다. 실제 Orca 호출을
포함한 지속 foreground cadence 또는 packaged/Finder 실행의 증거는 아니다.
창과 추적 Electron 프로세스의 종료를 확인했다.

## Playwright 대기 계약과 테스트 보완

설치 Playwright 1.63.0의 `coreBundle.js`에서 predicate의 반환값을 await하지 않고
truthy 검사하는 경로를 확인했다. 실제 Electron의 최소 재현에서
`page.waitForFunction(async()=>false, {}, {timeout:500})`가 26ms에 정상 반환했고,
반환 핸들의 값은 false였다. 이 반환은 조건 충족의 증거가 아니다.

`tests/electron/wait-until.mjs`는 IPC read와 predicate를 각각 await하고 전체
deadline을 적용한다. stalled read도 timeout을 내며 source 데이터는 오류에
포함하지 않는다. timeout은 underlying read 자체를 취소하지 않으므로 caller가
앱/fixture 정리를 계속 소유한다. 같은 false IPC의 수정된 대기는 501ms에 timeout을
냈다. 네 회귀 테스트는 async-false, 실제 조건 충족, stalled read, IPC 오류를 확인한다.

Phase 1/발췌문 Electron 테스트는 공용 대기를 사용한다. Mac에서
`XDG_CONFIG_HOME`만으로 프로필이 격리되지 않으므로 테스트 전용 bootstrap에서
`app.setPath('userData', fixture profile)`을 main 로드 전에 적용한다. production
entry와 synthetic entry의 재시작은 같은 임시 프로필을 사용한다. production의
설정이나 transport를 활성화하는 변경은 없다.

Mac 요약 회귀의 최초 수집 timeout을 해결된 것으로 처리하지 않는다. Mac 회귀는
owned window를 안정화/blur한 뒤 명시적 manual refresh하는 조건을 보고서에
명시한다. foreground 연결의 수용 검증과 구분한다.

## 회귀 검증 결과

- typecheck/build 통과, 기본 unit 709 passed / 16 skipped.
- 외부 authoritative query를 명시한 unit 712 passed / 13 skipped.
- Mac Phase 1 전체 여정과 발췌문 5회 재시작 여정 통과. 각각 합성 요청 7회/3회,
  실제 모델 호출 0회, 자동 UI 승인 1회와 stale 승인 거절 1회씩 확인.
- 수동 수집 조건에서 link preview/확인/충돌/거절, candidate 저장·재시작 복원,
  소스 변경·늦은 응답 취소·발췌 제한을 확인했다. Electron/추적 subprocess 종료와
  임시 fixture 제거를 확인했다.
- 결과 스크린샷 16개를 열어 확인했다. 합성 응답/승인 기록/실행 승인 구분,
  변경된 근거와 누락 표시, 링크 충돌/거절, 좁은 창을 확인했다. 이 이미지들은
  임시 Mac 경로가 있으므로 공개 저장소에 올리지 않는다.

## 실제 읽기 연동과 터미널 계약

임시 프로필의 production host/preload/renderer에서 실제 Orca 네 조회를 수집해
93개 작업을 표시했다. CodeBurn Claude/Codex status와 quota가 모두 성공했다.
상세·설정·명시적 refresh의 관측시각 증가·disconnect도 통과했다. 등록 노트와
DAG는 0개였고 사용자 데이터를 쓰지 않았다. 최초 연결은 cancelled/unknown/0개였으며
manual refresh로 회복했다. 최초 연결 취소와 이전 T-0 미표시의 직접 원인은 미확정이다.

Orca 1.4.217의 실제 status에서 prompt-delivery capability를 확인했다. 설치
터미널 핸들러를 stub client로 격리 실행하여 다음 계약을 검증했다.

- 구형 host는 wait-submit을 입력 전에 거절한다.
- 정확한 retry UUID와 runtime preflight를 유지한다. accepted만으로 turn_started를
  주장하지 않으며 경고를 보존한다.
- cursor/screen을 동시에 요청하면 읽기 전에 거절한다.
- wait.satisfied=false는 exit code 1이다.
- close가 live PTY를 보고하면 실패다.

이는 설치 코드의 비모델 계약 검증이다. 실제 런타임 terminal create/send/read/wait/
cancel 성공을 입증하지 않는다. 등록되지 않은 체크아웃의 selector 차단이 남는다.
기존 사용자 터미널을 대신 사용하거나 프로젝트 등록/권한 변경으로 우회하지 않았다.

## 남은 실행과 사용자 결정

1. 계속 실행/수정: 최초 연결 cancel/T-0/초기 read-model timeout의 직접 원인,
   실제 Orca foreground cadence, native resource/packaged 실행 검증.
2. 사용자 결정: 독립 note-app 체크아웃을 Orca에 등록하고 전용 비모델 terminal에서
   고정 fixture만 send/read/wait/cancel할지 승인 필요. 대상·명령·권한을 확정한 뒤
   진행해야 하며 기존 사용자 터미널을 재사용하지 않는다.
3. 구현/보안 검증: 독립적으로 강제되는 입력/읽기/도구/MCP/설정 경계,
   exact request와 출력 framing, 취소·늦은 응답·비용 정책을 먼저 검증한다.
4. 사용자 결정 후 실제 실행: 선택한 실제 프로젝트의 제한된 context와 provider/
   비용 한도를 승인받고 실제 한국어 요약의 정확성·누락·제안·blocker를 검토한다.
   합성 approval은 실제 사용자 승인으로 세지 않는다.

main 병합·PR·배포는 수행하지 않는다.
