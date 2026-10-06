# 무호출 준비 단위의 결과와 범위 대기

사용자가 note-app에 모델 호출이 언제 필요한지와 Phase 1 범위를 확인 중이다.
조회·집계·기존 기록 표시에 새로운 모델 호출이 필수라고 전제하지 않는다.
아래 자료는 검토용 초안이며 실행 승인이나 제품 필수 요구가 아니다. 이 단위에서
추가 실험 준비를 멈추고 범위 답변을 기다린다. 모델 호출·credential 접근/생성·
보안 설정 변경·화면 점유는 모두 0회다. production transport는 차단 상태다.

## 정확한 공개 입력 초안

`fixtures/summary-quality/public-one-shot-preview.json`의 exactInput만 전달 대상으로
정의한다. readableInput은 동일한 JSON의 검토용 표시다. sourceCommit은
cc59bd1621b5ac2278c495786f92ddf7e2b09c23이며 출처 URL/발췌문 hash를 함께 기록했다.
입력은 공개 README의 목표/실행 차단, Phase 1 현황과 읽기 전용 조회·headless
검증 보고서의 다섯 발췌문이다. private 노트, 대화, 인증·설정, 전체 저장소/DAG를
포함하지 않는다. 보고서의 테스트 선언은 독립적인 실제 모델·사용자 인수 증거와
구분하고 incomplete coverage 및 미확인을 포함한다. 한국어 여섯 관점의 미승인
JSON 후보만 요청하며 추가 자료 수집/도구/위임을 금지하는 기존 compiler를 사용했다.
정확한 바이트/hash와 8,192-byte 응답 상한은 fixture metadata에 있다. 실제 모델의
토큰·과금 상한을 의미하지 않는다. 구독을 사용하는 Orca 경로는 검증 대기이며
bare/API나 Cursor 경로로 전환하지 않았다.

## 새로운 fake provider 검증 — 실제 모델·Orca transport 아님

tests/helpers의 고정 Node fixture만 실행한다. 임의 제공자 실행 파일·모델 인수·
사용자 config를 선택하는 경로가 없고, 요청 본문은 평가하거나 파일 경로로 쓰지 않는다.
고정 argv, 명시적 fake env, 테스트 소유 빈 임시 cwd와 stdin 입력을 사용한다.
macOS가 추가한 `__CF_USER_TEXT_ENCODING` 환경 키도 관측했으며 그 값을 전달
허용 목록이나 인증 격리 증거로 사용하지 않는다. 환경 omission만으로 파일 접근이
격리되는 것은 아니다. 이 runner를 구독 인증 실행 정책으로 복사하지 않는다.

새 프로세스 검증 6개가 통과했다: 정확한 입력 hash/argv/env/cwd와 정리, 다른
request frame 거절, stdout/stderr flood 중단, 실제 로컬 deadline, pre-abort와
진행 중 취소, parent 종료 뒤 테스트 소유 descendant group 정리, 입력 상한 및
알 수 없는 fake mode 거절. framing은 앱 작성 비모델 JSONL이며 Orca/Claude의
의미 응답 필드가 아니다. 프로세스 exit만으로 완료하지 않는다. 소유된 POSIX
process group만 SIGKILL하며 취소가 원격 계산/청구를 되돌린다고 주장하지 않는다.
공개 발췌문을 연속된 문단으로 보완한 뒤 입력 전달 관련 한 개만 재검증했다.
기존 전체 회귀를 불필요하게 반복하지 않았다.

## 강제 격리의 남은 게이트

현재 실행 sandbox 안에서 임시 sandbox-exec를 적용한 echo-only probe는
`sandbox_apply: Operation not permitted`로 종료했다. 승인된 별도 실행에서 두
default-deny echo 정책은 종료 134/출력 없음, allow-default 대조군은 정상 출력했다.
개인 파일/네트워크/모델은 이 probe의 대상이 아니었다. 이는 특정 default-deny
프로파일의 실행 경계를 검증하지 못했다는 뜻이며, macOS 격리가 불가능하거나
전체 프로필이 안전하다는 증거가 아니다. 추가 프로파일·설치·정책 변경은 진행하지
않았다. 이 단위에서 강제 파일 읽기 confinement를 통과 처리하지 않는다.

구독 인증을 유지하면서 정확한 테스트 소유 Orca 세션에서 hooks/skills/MCP/
외부 도구와 추가 process를 차단하는 지원 방법, startup managed 설정·인증 읽기
범위, 요청별 실제 output framing, provider가 강제하는 상한과 실제 turn 취소는
여전히 확인이 필요하다. 인증이 있다고 가정하거나 개인 설정을 열어 확인하지 않는다.
OS confinement 및 credential 예외의 최소 범위가 정해지지 않은 상태에서 실제
제공자를 띄우지 않는다. 이것들은 새 모델 생성 기능을 선택할 경우의 게이트이며
기존 관측·기록 표시 기능 전체의 필수 조건이라고 단정하지 않는다.

## 확인한 과거 설계 기록

`specs/information-contract.md` §1/2는 T-001의 Orca discovery/note association와
사람이 이해하는 여섯 관점의 진행 표시를 기록한다. local manual-summary boundary와
함께 full acceptance/approval/development delegation은 Phase 2이고 Phase 1의
필수 UI/차단 의존성이 아니라고 명시한다. `docs/summary-instructions.md`는 향후
전략을 기존 Orca CLI agents로 기록하며 외부 vendor API/credentials를 도입하지
않았다고 한다. 이는 복구된 저장소의 구현 설계 기록이며 원래 사용자 발언이나
현재 실행 승인을 직접 확인한 것은 아니다. 해당 기록에서는 Cursor 호출이
필수라는 근거를 확인하지 못했다. 사용자 범위 답변 후 다음 단계를 결정한다.
