# 화면 없는 비모델 계약과 실제 모델 실험의 승인 경계

Phase 1은 미완료다. 모델 호출 0회, 추가 UI 점유 0회이며 production transport는
계속 차단한다. 이 변경은 CLI를 실행하지 않는 순수 decoder/계약 함수다.

## 구현·검증 범위

실제 Orca 1.4.221의 테스트 소유 Node/shell 응답 12개에서 UUID와 경로를 가상
값으로 치환한 fixture를 사용한다. 별도 version attestation을 요구한다. envelope는
자체 version을 제공하지 않으므로 응답만 보고 설치 버전을 추측할 수 없다.
read/send/interrupt/exit wait/close의 관측된 필드만 허용하며 새 필드·버전·단계는
거절한다. create/show와 Claude/Codex 응답 decoder를 구현했다고 주장하지 않는다.

input_accepted와 unsupported delivery, timeout, stop_unverified exit, PTY close는
각각 별개 결과다. turn_started·AI 완료·모델 취소는 생성하지 않는다. 같은 요청의
재송신 API는 없으며 미확정 send는 세션을 폐기한다. runtime/incarnation/소유자/
ticket/run 불일치, stream cursor reset·gap·history screen, truncated/limited read와
중복 receipt도 폐기한다. 읽기·출력·payload·frame의 바이트/횟수 상한을 적용한다.

read wire에는 processIncarnation이 없으므로 호출자의 신뢰된 현재 identity
attestation이 필요하다. 이 모듈은 해당 attestation을 생산하거나 실제 권한을
발견하지 않는다. cursor 구간만으로 모델 요청과 출력을 연결하지 않는다.
request/sequence/final을 검사하는 JSONL collector는 **앱이 작성한 비모델 fixture
프로토콜**이다. Orca wire나 AI 의미 계약이 아니며 production에 연결하지 않는다.
기존 fixture-only decoder의 fail-closed 동작도 유지한다.

## 최소 실제 모델 승인안 — 아직 실행하지 않음

공개 note-app 저장소에서 사람에게 미리 보여 준 합성/공개 DAG·목표 발췌문만
stdin 입력으로 전달하는 1회 실험은 가능성을 검토할 수 있다. 공개 저장소라 해도
로컬 `.git`, 설정, 개인 경로가 자동 포함되지 않도록 새 임시 디렉터리에 필요한
공개 파일만 복사한다. 기존 사용자 노트·세션·프로젝트 context는 입력하지 않는다.
목표는 제한된 한국어 JSON 요약 한 개와 근거 검증이다. 승인 저장·배포는 별도다.

화면 없는 읽기 전용 `--version/--help`로 설치 Claude Code 2.1.290과 Codex CLI
0.160.0을 확인했다. 제공자가 설치되었다는 사실은 인증/실행 가능/비용 승인이
아니다. credentials나 기존 설정 내용은 읽거나 변경하지 않았다.

- Claude 도움말은 print의 `--tools ""`, `--restricted`, `--safe-mode`,
  `--disable-slash-commands`, `--setting-sources`, 명시된 빈 MCP와
  `--strict-mcp-config`를 제공한다. 이 조합의 실제 유효성은 모델 실행 전에
  검증해야 한다. managed 정책과 인증 경로는 별도 확인이 필요하다.
  `--bare`는 OAuth/keychain을 건너뛰고 API key/helper 인증을 요구하므로 기존
  구독 인증에 사용할 수 있다고 추측하거나 새 키를 준비하지 않는다.
- Codex 도움말은 read-only shell sandbox, `--ignore-user-config`, `--ignore-rules`,
  ephemeral/JSON/schema를 제공한다. read-only는 파일 읽기 범위 제한의 증명이
  아니며 auth는 여전히 CODEX_HOME을 사용한다. 이 도움말만으로 tool/MCP/설정
  읽기 차단을 확정할 수 없어 현재 좁은 실험의 실행 선택지로 승인하지 않는다.
- CodeBurn 0.9.25 status/quota는 사후·현재 관측이다. 설치 source의 budget --check는
  configured budget을 읽고 별도 check 결과를 반환한다. 이를 모델 호출의 강제
  과금 상한으로 취급하지 않는다. hooks/guard 설치나 전역 budget 설정은 하지 않는다.
- Claude print의 `--max-budget-usd`는 도움말상 API 호출 예산 옵션이다. 구독 quota,
  실제 결제액, 요청 전 강제 가능한 상한은 별개다. 이 옵션의 초과·중단 동작과
  해당 인증 방식의 적용성은 검증되지 않았으며 정확한 금액 보장을 하지 않는다.
  Codex exec 도움말에서는 동등한 달러 상한을 확인하지 못했다.

부모가 사용자에게 확인할 최소 결정은 **Claude 1회, 정확히 보여 준 공개/합성
입력, 사용할 인증 방식, 허용 금액과 hard cap 필수 여부**다. hard cap이 필수라면
해당 제공자가 요청 전에 강제하는 비용/토큰 경계를 증명하기 전 실행하지 않는다.
인증 경로 확인에 private 설정/credential 접근 또는 변경이 필요하면 정확한
대상과 권한을 별도로 제시한다. 보안 설정·지속 접근 변경은 현재 승인 범위 밖이다.

실행 전에는 argv/env/config를 가상 제공자로 검사해 hooks/skills/MCP/tool/subagent
차단, 임시 cwd 외 파일 읽기와 추가 프로세스/네트워크를 거절하는 경계를 시험한다.
실제 실행 시에도 provider trace에서 tool call 0, 정확한 bounded request/response,
deadline·출력 한도와 테스트 소유 process tree 정리를 확인해야 한다. 네트워크
송신이 시작된 뒤 로컬 취소가 원격 계산·청구를 되돌린다고 주장하지 않는다.
Orca interactive turn 취소는 별도 게이트이며 이 print 실험의 성공으로 통과하지 않는다.

이후 실제 한국어 요약의 정확성·누락·근거·제안/blocker와 사람의 승인, 실제
production framing/권한/비용/취소 경계, packaged 앱 검증이 남는다. 지속 foreground
cadence는 사용자가 다른 업무 중이므로 조건 미충족 미검증으로 보류한다.
