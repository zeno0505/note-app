# Phase2 Mac UI와 DAG 전송 검증 — 2026-10-08 UTC

기준은 Phase1 이력을 포함하는 `5bac1a4f77a1a76f880d422b5568e64568db6dfa`이다. 사용자 설치 build19와 별도의 격리된 Mac arm64 Electron fixture를 구분했다.

## 변경

- 읽기 요약을 관측 메타데이터·AI 조작보다 앞에 배치하고 헤더·설정·요약의 중복 여백을 줄였다.
- 반복적인 설명은 이름과 툴팁이 있는 정보 버튼의 모달로 옮겼다. Enter/Space 진입, Escape 닫기, 원래 버튼의 포커스 복귀를 유지한다.
- 프로젝트 AI의 전송 확인 조작만 모달로 옮겼다. 컴포넌트는 계속 유지하며 저장 결과, 오류, 현재 상태, 진행과 취소를 본문에서 표시한다. 모달을 닫으면 동의가 초기화된다.
- 프로젝트 ID 미확인, 부분 관측, 오래된 근거, 실제 수집 미지원, 계정 미확인과 사용량 0의 구분, 복구 경로는 계속 노출한다.
- DAG 상세 닫기의 포커스 복귀가 SVG 노드도 대상으로 삼도록 했다.
- DAG query 결과 JSON은 ASCII escape 대신 동등한 UTF-8 필드로 전달한다. 원문·query pin·2MiB 출력 제한·16MiB 원문 제한·시간 제한은 유지한다.

실제 읽기 전용 DAG에서 기존 ASCII 전송은 2,166,155 bytes, UTF-8은 1,363,458 bytes였다. 출력 제한 2,097,152 bytes 안에 들어오며 측정 전후 원문 해시는 같다. 필드 삭제·잘라내기·제한 확대는 없다. 이는 실제 설치 앱의 복구 수락과 별개의 transport 검증이다.

## 검증

- 외부 pinned query를 켠 최종 `npm run check`: 타입 검사·production build 통과, 1,386 tests passed / 13 skipped.
- 13 skip: Linux procfs 전용 Orca lifecycle 11개, cleanup-failure 1개, cleanup-race 1개. 첫 기본 실행의 18 skip에는 외부 query opt-in 5개도 포함되어 있었다.
- 첫 전체 실행은 Claude adapter의 네 응답 사례를 한 테스트에서 연속 실행하며 5초 timeout이 났다. 같은 파일의 격리 rerun 6개 통과만으로 전체 통과를 주장하지 않았다. 각 응답을 독립 parameterized test로 바꾼 후 전체 검사를 다시 통과했다. 제품 timeout은 변경하지 않았다.
- 실제 darwin/arm64 Electron, 가상 500개 task Phase2 14항목 통과. 정보 버튼 키보드/Escape/포커스, 동의 닫기·재열기 초기화, DAG SVG 포커스, 라이트/다크/820px, 실제 앱 자체 메모리와 프로젝트 소비 구분, 재시작·선택 보존을 포함한다.
- 접두사 회귀, 노트 재연결, 진단 재시도 회귀 통과. 원문 fixture/링크 보존과 소유 테스트 프로세스 종료 확인. 재시도는 테스트 소유 가짜 실행 파일만 사용했고 실제 모델 호출은 0회다.
- 독립 UI 리뷰는 before/after 캡처와 소스에서 신규 blocking을 발견하지 않았다. 리뷰 자체는 정적 확인이며 실제 키보드 동작의 근거는 위 Electron 실행이다.

## 남은 실제 환경 수락

사용자가 앱을 활성 유지한다고 한 직후 70초 읽기 전용 OS 관측에서는 SecurityAgent가 모든 샘플의 foreground였다. DAG 관측 시각 변화는 0회다. 두 번의 연속 foreground polling은 **미입증**이며, 보안 창을 자동 승인·닫기·우회하지 않았다.

실제 계정 수집, Orca PID와 프로젝트 메모리 귀속, 실제 모델 한국어 의미 검수와 production transport는 이 fixture 결과로 완료라 하지 않는다. 사용자 프로젝트 등록·새 권한·실제 모델 송신 없이 진행했다. build19의 actual renderer 캡처는 로딩 상태였으므로 캐시 ready만으로 UI 수락을 주장하지 않는다. 최종 패키지의 실제 설치·재조회 결과는 별도 Mac 설치 기록에서 확인해야 한다.
