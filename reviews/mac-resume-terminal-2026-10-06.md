# 최초 관측 취소·자동 회복 및 비모델 터미널 검증

[앞선 Mac 검증](mac-followup-2026-10-06.md)의 후속 결과다. Phase 1은 여전히
미완료이며 실제 모델 호출은 0회다. production transport는 차단을 유지한다.

## 최초 취소의 상태 전이

별도 임시 프로필의 production host에서 실제 Orca/CodeBurn을 읽었다.
최초 1.555초에 connected/unknown/observedAt=null/0개/cancelled와
native focused=false를 함께 기록했다. 수동 refresh 없이 native refocus만으로
7.075초에 current/94개/lastError=null로 회복했다. 이후 hide 2초 동안 관측시각이
유지되고 show/focus 후 11.997초에 새 관측시각으로 회복했다. Electron과 임시
프로필 정리도 확인했다. 93→94 증가는 승인된 독립 체크아웃의 등록과 일치한다.

이 첫 재현은 비활성 전환에 따른 취소와 재활성화 재시도를 입증한다. 추가
재현에서는 hide/show 뒤 blur→focus 이벤트의 focus callback에서 isFocused=false를
읽었고, 이후 15초 동안 실제 창은 focused=true/visible=true인데 수집은 stale/
cancelled로 머물렀다. 즉 모든 최초 취소가 영구 고정인 것은 아니지만 callback의
과도 상태를 읽는 경로에서는 수집기의 활동이 실제 창과 어긋날 수 있다. 최초
blur/hide를 누가 유발했는지, 다른 최초 T-0/timeout의 직접 원인까지 확정하지는 않는다.

snapshot store는 비활성 전환 때 flight를 abort하고 마지막 성공이 없다면 unknown을
유지한다. 유효한 활성 전환은 즉시 resume하며 취소된 flight가 아직 정리 중이면
그 뒤에 한 번만 재시도한다. 이 취소/재시도 정책은 유지한다. host의 window
activity observer는 focus/blur/show/hide/minimize/restore 이벤트의 의미를 직접
반영하도록 수정해 callback 안의 순간적인 snapshot 값에 의존하지 않는다.
show/restore만으로 focus를 추측하지 않으며 hide/minimize는 active도 즉시 내린다.
회귀는 native snapshot 값이 이벤트와 반대여도 즉시 중단/재개하는지와 첫 수집
취소 후 settlement 전/후 두 경우의 refocus를 각각 확인하고, 취소된 late success를
관측으로 수락하지 않으며 manual refresh 없이 current로 회복하는지 확인한다.

표시는 작은 범위로 보완했다. 성공한 관측이 없을 때 0개 카운터/검색 필터를
노출하지 않고, cancelled는 실패 경고 대신 ‘관측 중단 · 아직 미관측’으로 표시한다.
재활성화 시 자동 재시도와 수동 새로고침 경로를 안내하며 실제 오류와 실제 관측된
빈 결과는 별도로 유지한다. 이전 성공 관측이 있는 취소는 이전 관측을 유지한다.

수정 후 실제 소스 실행은 초기 current/94개, hide 2초 동안 관측시각 유지,
show/focus 후 새 관측(02:18:43.123Z→02:18:52.557Z)을 통과했다. native
foreground bundle도 Electron이었다. 두 번의 추가 지속 polling 시도는 show 후
약 10초/19초에 native blur와 다른 앱(com.anysphere.sand)의 foreground 전환을
기록해 실패로 처리했다. 예정 poll 완료는 0회로, 실제 소스의 1분 지속 전경
polling 완료를 주장하지 않는다. 앞선 합성 fixture의 3회 scheduled polling은
별도 증거다. 반복적인 강제 활성화나 background 취소 정책 해제는 하지 않았다.

타입 검사·빌드와 기본 단위 테스트 713개(16 skip), 외부 DAG query를 포함한
단위 테스트 716개(13 skip)가 통과했다. 수정 후 합성 Phase 1 UI 회귀는
7개 요청, 발췌문 UI 회귀는 5회 재시작/3개 요청으로 통과했으며 각각 승인 복원과
stale 승인 거절을 확인했다. 새로 생성한 16개 스크린샷을 별도로 열어 확인했다.
이는 실제 한국어 모델 요약의 품질 검증이 아니다.

## 승인된 등록과 실제 shell/Node 터미널 계약

사용자의 명시적 승인 후 독립 note-app 체크아웃만 Orca에 등록했다. 기존
사용자 터미널은 사용하지 않았고 신규 등록 범위의 초기 terminal 수는 0개였다.
등록 자체를 되돌리거나 접근/보안/모델 설정을 변경하지 않았다.

전용 Node fixture는 파일·네트워크·모델 접근 없이 고정 echo/wait 입력과
cancelled marker만 처리한다. 두 개의 순차적인 테스트 소유 터미널에서 다음을
확인했으며 둘 다 close의 ptyKilled=true와 마지막 terminal 목록 0개로 정리했다.

- create/read에서 readiness 확인 후 고정 입력을 한 번 보냈다.
- accepted와 durable request UUID를 확인했고 cursor read에서 실제 complete marker를
  확인했다. 소비한 nextCursor를 다시 읽으면 중복 출력이 없었다.
- shell/Node provider는 unsupported로 input_accepted만 보고했다. 이는 AI의
  turn_started가 아니며 실제 fixture의 출력으로만 비모델 동작을 확인했다.
- running shell의 exit wait는 exit code 1 / ok=false / error.code=timeout이었다.
  결과 JSON 출력만으로 완료로 간주하지 않았다.
- fixture-wait 출력 후 interrupt 입력을 보내고 cancelled marker와 shell 복귀를
  확인했다. 이는 Node fixture 취소이며 실제 모델 turn 취소의 증거가 아니다.
- shell에 exit를 한 번 보낸 뒤 wait는 satisfied=true/status=exited였지만
  exitCode=-1, exitCause=unknown/stop_unverified였다. exit 원인·성공 코드를
  검증했다고 주장하지 않고 최종 close의 PTY 종료 확인을 별도로 사용했다.

첫 검증 중 외부에서 Orca 1.4.217→1.4.221 및 runtimeId가 변경되었다. 이번 작업이
업데이트/재시작을 요청하지 않았다. 기존 fixture handle/incarnation은 남았지만
orphaned 상태와 stream cursor 4→0이 관측됐다. 입력을 재전송하지 않고 소유
terminal을 다시 식별한 뒤 screen fallback에서 echo 완료를 확인했다. 정리 후 새
런타임의 새 전용 터미널에서 stream/cursor 계약을 다시 검증했다. 런타임 전환을
걸친 cursor나 화면 history를 요청별 완결 응답으로 간주하면 안 된다.

## 계속 필요한 작업

실제 AI의 제한된 읽기/도구/MCP/설정 경계, 정확한 요청별 response framing,
모델 turn 취소와 늦은 응답, 실제 비용 정책은 검증되지 않았다. 이번 비모델
터미널 성공은 production transport를 켤 근거가 아니다. 실제 프로젝트 context,
provider와 비용 한도에 대한 승인 및 해당 경계의 실행 검증 후 실제 한국어 요약의
정확성·누락·제안·blocker와 사용자 승인을 평가해야 한다. 실제 Orca 지속
foreground polling과 native packaged/Finder/resource 검증도 남는다.
