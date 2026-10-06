# 공개 note-app 모델 읽기 요약 하네스

일반 프로젝트의 수집·규칙 기반 요약·모델 후보 승인 경로는 그대로 유지한다. 이 하네스는 공개 `zeno0505/note-app` 대표 입력의 제한된 실험 경로이며 기존 프로젝트에 자동 모델 호출을 켜지 않는다.

`scripts/public-reading-model.mjs`는 명시적으로 선택한 공개 커밋의 고정 파일·행 범위와 해당 SHA의 공개 CI 응답만 근거 팩에 담는다. `docs/note` 링크, 개인 노트, inbox, 전체 DAG, 현재 작업 디렉터리 탐색은 사용하지 않는다. 준비 명령은 모델을 호출하지 않는다.

```sh
node scripts/public-reading-model.mjs --output /absolute/private/evidence --approved-public-sha PUBLIC_COMMIT_SHA
```

실행에는 별도로 승인된 `--execute --claude-path /absolute/installed/claude`가 필요하다. 기존 HOME의 로그인 인증은 CLI가 정상적으로 사용한다. 인증 파일을 읽거나 출력·복사하지 않는다. API 키·provider 라우팅 환경을 상속하지 않고 `--bare`, 권한 우회, 새 로그인은 사용하지 않는다. 설치 버전에서 `--safe-mode --restricted --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --permission-prompts none --no-chrome --no-session-persistence`를 모델 실행 전 스키마 오류로 확인한 뒤 실행한다. 매 호출 전 정상 CLI auth status의 로그인 방식·구독 유형만 확인하고 claude.ai/firstParty 구독이 아니면 모델 실행을 중단한다. 이메일·계정 식별자·자격증명은 기록하지 않는다. 실제 호출 cwd는 새로 만든 빈 디렉터리다. 관리자 정책은 계속 적용되며 거절을 우회하지 않는다.

전역 실행 슬롯은 프로세스 내 공유하고, 사용자별 앱 전용 public-model-harness 저장소의 영구 파일 잠금으로 별도 프로세스의 겹침도 막는다. 실험 출력 경로를 바꿔도 같은 예약·잠금을 공유한다. 입력 해시에는 공개 근거·SHA·프롬프트 및 스키마 버전이 포함된다. 같은 입력은 생성 한 번, 완료 응답의 검증 실패만 수정 한 번까지 허용한다. 네트워크 오류·크래시·timeout은 자동 재실행하지 않는다. SDK/CLI 내부 서비스 재시도 횟수는 이 계약으로 확인한 값이 아니다. 중단된 예약이나 잠금은 자동 삭제하지 않는다.

모델에 네 섹션, 모든 필수 fact의 식별자·출처·상태를 요구한다. `none`, `unrecorded`, `query-failed`를 구분하고 숫자·SHA·필수 문구·출력 상한·run ID·프로젝트·입력 해시·버전을 검증한다. PR 병합, CI, 화면 검수, 배포는 별개이며 설계 문서는 구현 증거가 아니다. 원문 지시는 데이터로 취급한다. 역사 문서가 최신인지 판정하지 않는다.

schema와 fact ID 일치만으로 문맥·semantic 진실성을 보장할 수 없다. 실제 한국어 요약을 공개 근거와 대조해 검수해야 한다. 고정 문체나 추가 모델 judge는 사용하지 않는다. 실패는 명시적인 규칙 기반 fallback이며 취소·입력 교체의 늦은 결과는 게시하지 않는다. 응답한 프로세스가 중단 뒤에도 정리되지 않으면 전역 슬롯을 격리해 추가 호출을 차단한다.

호출 전에 CodeBurn의 확인된 quota와 현재 메모리 상태를 읽고 하나의 제공자를 선택한다. unknown은 0이나 무제한이 아니다. 출력의 사용량·token·runtime만 실측으로 기록한다. CLI가 반환하는 `total_cost_usd`는 구독 계정 청구액이나 금액 보장이 아니다. quota 변화는 다른 사용자 작업도 포함하므로 한 요청의 정확한 사용량으로 귀속하지 않는다.

Claude 프로그램 실행: https://code.claude.com/docs/en/headless

Codex 프로그램 실행: https://learn.chatgpt.com/docs/non-interactive-mode

Orca 터미널 전송 계약은 `accepted`와 `turn_started`를 구별한다. `tui-idle`도 요약 완료가 아니다. 설치판의 중단 명령은 `terminal send --interrupt`이며 `terminal cancel`은 없다. 미등록 체크아웃은 `selector_not_found`여서 실제 생성·송신·중단 계약은 아직 검증되지 않았다. 이 공개 실험은 Orca TUI 대신 제한된 로그인 CLI 프로세스를 직접 소유한다.

## 승인된 실제 대표 입력 결과

공개 입력 SHA `aedcb6c6c093f10d20354e46f00cf49952109654`, 입력 해시 `c68761e16fc782708ad523344acf33b83a03a346f143df621d2b2438ecdeb11e`, 지정 소스 8개·필수 fact 6개·8,894바이트를 사용했다. Claude Code 2.1.291의 기존 claude.ai Team 구독으로 생성 요청 1회, 수정 0회, 동일 입력 재요청의 추가 호출 0회였다. Codex는 호출하지 않았다.

반환 실측: 일반 입력 token 2, 캐시 생성 입력 token 7,761, 출력 token 1,578, 실행 16,165ms. CLI의 num_turns는 2이며 앱의 생성 요청 횟수와 다른 값이다. 반환 server_tool_use의 웹 검색·웹 fetch는 모두 0이다. 반환 list-cost 0.093656 USD는 구독 청구액으로 해석하지 않는다. quota의 전후 변화는 다른 사용자 작업도 포함하므로 이 요청에 귀속하지 않는다.

한국어 네 섹션을 공개 근거와 대조했다. 다음 작업의 “계획 문서에만 있습니다”라는 표현은 지정된 공개 입력 범위로 한정하며 저장소 전체에 구현이 없다는 인증이 아니다. 입력 SHA를 실행 앱 SHA로 보거나 이 CI를 Mac 화면 검수·배포로 바꾸지 않았다. 일반 프로젝트 자동 호출과 역사 문서 freshness 판단은 추가하지 않았다. 저장 결과는 앱 연결 및 설정의 접힌 공개 검증 영역에서 읽을 수 있으며 그 화면은 모델을 호출하지 않는다.
