# 변경 의도를 중심으로 리뷰하기

변경이 여러 파일이나 경계에 걸쳐 있다면, 무엇을 함께 살펴볼지 짧게 안내합니다.
한 파일의 간단한 수정이라면 한 문장으로 충분할 수 있습니다. 이 가이드는
2026-10-05에 확인한 [pulls.review의 `cf686ebc` 버전](https://github.com/antfu/pulls.review/tree/cf686ebcf6642759c2a1291e2f12dc740c5c431b)에서
얻은 착안점을 note-app에 맞게 적용한 리뷰 참고 문서입니다.
작업 일정이나 제품 로드맵을 정하는 문서는 아닙니다.

## 원안의 착안점, 반영 방식, 리뷰어의 이득

1. **디렉터리를 넘어 변경의 이유를 따라갑니다.**
   - 원안 근거: [그룹 분류 프롬프트][intent]는 의도를 기준으로 변경을 묶고,
     테스트·스토리·픽스처(테스트용 데이터)를 해당 동작과 함께 둡니다.
   - note-app 반영: 하나의 동작을 관련 인터페이스 계약, 테스트, 설명 문서와
     함께 설명합니다. 예를 들어 요약 승인 방식의 변경은
     `src/shared/summary-workflow.ts`, `src/summary/workflow/`,
     렌더러 코드, `tests/unit/summary-workflow.test.ts`에 걸칠 수 있습니다.
   - 리뷰어 이득: 디렉터리 구조에서 연관성을 다시 찾아내지 않아도,
     변경 설명과 실제 구현, 검증 근거를 연결해 볼 수 있습니다.

2. **규칙으로 파일 목록을 먼저 정리하고, 실제 의도는 변경 내용을 읽어 판단합니다.**
   - 원안 근거: [분류 규칙][rules]과 [어댑터][adapter]는 경로 규칙을 순서대로
     평가하고 처음 일치한 docs/code/tests/config/deps/generated/other 그룹에
     배정합니다. 어느 규칙에도 맞지 않는 텍스트 파일은 code, 바이너리 파일은
     other로 분류합니다. [카테고리 스키마][schema]의 API·데이터·보안 등은
     시스템 영역을 나타내는 별도 분류이며, 이 고정 규칙 그룹과 구별됩니다.
   - note-app 반영: 변경 파일 목록과 필요에 따른 경로·glob 힌트에서 시작한 뒤,
     실제 diff를 읽고 의미 있는 그룹을 만듭니다. 여러 그룹에 걸친 보안·데이터·
     인터페이스 계약의 위험도 함께 적습니다. 파일 분류만으로 의도를 단정하지 않습니다.
   - 리뷰어 이득: 적은 비용으로 누락을 반복 확인하면서도, 파일 확장자 때문에
     여러 영역에 걸친 변경을 놓치는 일을 줄입니다. 규칙부터 살펴보고 필요할 때만
     모델을 쓰는 방식은 note-app의 선택이며, 원안이 강제하는 우선순위는 아닙니다.

3. **리뷰 안내는 짧고 찾아보기 쉽게 만듭니다.**
   - 원안 근거: [그룹 데이터][schema]에는 이름, 목적 요약, 파일 경로와 한 단계의
     하위 그룹이 담깁니다. [DiffGroup][group], [탭][nav], [사이드바][sidebar]는
     그룹을 파일 및 리뷰 진행 상황과 연결합니다. [탐색 설정][nav-setting]은
     그룹 구성을 유지한 채 표시 방식만 바꿉니다.
   - note-app 반영: 변경 의도를 나타내는 짧은 제목 몇 개와 파일·근거 링크를
     사용하고, 필요할 때만 하위 제목을 둡니다. 각 그룹을 묶은 이유와 먼저 볼 곳을
     설명합니다. 아래 양식을 활용하면 새 UI 없이도 이런 안내를 만들 수 있습니다.
   - 리뷰어 이득: 탐색에 드는 시간을 줄이고, 관심 있는 부분부터 리뷰를 이어갈 수
     있습니다. 검토한 파일 수는 진행 상황을 보여 줄 뿐, 동작의 정확성을 입증하지는 않습니다.

4. **diff가 바뀌어도 검토에서 빠진 부분이 드러나게 합니다.**
   - 원안 근거: [그룹과 파일을 연결하는 로직][coverage]은 이전 경로를 대조하고,
     사라진 참조를 표시하며, 어느 그룹에도 없는 파일을 Uncategorized 그룹에 넣습니다.
   - note-app 반영: 정확한 base/head 간 diff와 리뷰 안내를 대조합니다. 변경된
     각 경로에는 기본 그룹 하나를 정하고, 미분류 파일이나 여러 glob에 중복 일치하는
     항목은 정리될 때까지 명시합니다. 공통 인터페이스 계약은 필요에 따라 교차 링크하되,
     같은 파일을 두 번 집계하지 않습니다. 이름이 바뀌거나 삭제·추가된 파일도 다시 확인합니다.
   - 리뷰어 이득: 오래된 요약이나 편의상 붙인 그룹 이름 때문에 검토할 변경이
     조용히 누락되는 일을 막습니다.

5. **커밋 메시지로 의도를 설명하되, 커밋 경계에 리뷰를 억지로 맞추지 않습니다.**
   - 원안 근거: [프롬프트][intent]는 커밋 메시지를 의도의 단서로 활용하지만,
     fixup/WIP 커밋의 경계 대신 최종 변경 내용을 기준으로 그룹을 만듭니다.
   - note-app 반영: 제목에는 변경 결과를, 본문에는 이유나 중요한 한계를 적는 것을 권장합니다.
     동작·테스트·필요한 인터페이스 계약은 함께 이해할 수 있게 유지하고,
     독립적인 변경은 이해에 도움이 될 때 나눕니다. 기능·테스트·문서를 기계적으로
     분리하거나 이 가이드에 맞추려고 기존 이력을 다시 쓰지는 않습니다.
   - 리뷰어 이득: 중간 저장 지점의 커밋도, 최종 변경 비교도 이해하기 쉬워집니다.

## note-app의 리뷰 순서와 검증 근거

원안 프롬프트는 핵심 변경, 이를 뒷받침하는 변경, 기계적인 변경 순으로 보기를 제안합니다.
note-app에서는 위험도에 맞게 순서를 조정합니다. 변경된 IPC/API 계약, 권한,
데이터 쓰기·최신성 보장 경계를 먼저 살펴보고, 동작의 구현과 검증 근거를 이어서 확인합니다.
다른 순서가 필요하면 이유를 설명합니다. 이는 note-app의 선택이며,
pulls.review가 강제하는 고정 순서는 아닙니다.

- IPC와 샌드박스는 [애플리케이션 경계](../app/README.md)를 참고합니다.
  실패·취소·오래된 결과를 처리하는 경로가 바뀌었다면 해당 동작과 함께 리뷰합니다.
- 변경 설명 옆에 관련 테스트, 픽스처, 스크린샷·로그를 연결합니다.
  **통과**, **실패**, **미실행**을 구분하고 검증한 SHA와 환경을 적습니다.
  [검증 범위](../reviews/electron-test-infrastructure.md)를 따릅니다.
  Linux·단위 테스트 결과만으로 macOS나 실제 모델의 검증이 완료됐다고 볼 수는 없습니다.
- 기계적 변경과 생성 파일도 목록에 남기되, 대개 뒤에서 확인합니다.
  변경 원인과 의존성·빌드에 미치는 영향을 살펴봅니다. 생성 파일이라는 이유로
  안전성 검토를 생략하지 않습니다.
- 문서만 바꾼 작업은 변경된 링크와 출처에 관한 설명을 확인합니다.
  영향을 받는 동작에 맞게 검증하고, 양식을 채우기 위해 관계없는 고비용 검증을
  다시 실행하지 않습니다. CI가 실행되면 실제 푸시한 SHA의 결과를 보고합니다.

## 필요할 때 골라 쓰는 리뷰 메모

커밋 본문, 브랜치·변경 비교 설명, 리뷰 기록 또는 PR에 필요한 항목만 옮겨 씁니다.
[저장소 작업 방식](../decisions/repository.md)은 브랜치에 직접 푸시하는 흐름을
지원하며, PR 작성은 선택 사항입니다.

```text
목적: 사용자에게 무엇이 달라지며, 왜 필요한가?
범위: base SHA -> head SHA; 변경 비교·커밋 링크

변경 의도별 그룹: 짧은 제목
  변경 이유 / 영향을 받는 동작:
  주요 경로 / 관련 인터페이스 계약 또는 경계:
  검증 근거: 명령 또는 검토 내용 + 결과 + 검증한 SHA·환경 + 링크
  먼저 볼 곳: 시작 지점과 위험 요소; 아직 해소되지 않은 한계

누락·중복 확인: 미분류 경로; 중복 일치; 이름 변경·사라진 경로 (없으면 없음)
원격 저장 확인: 브랜치 + 확인한 원격 head; 해당 SHA의 CI 결과·링크 또는 미실행
```

head가 바뀌면 범위와 누락·중복 확인 내용을 갱신합니다. 승인된 직접 푸시를 마친 뒤에는
원격 head와 커밋된 파일을 확인한 다음, 원격에 저장됐다고 보고합니다.
로컬 커밋만으로는 원격 저장이 완료된 것이 아닙니다. 이렇게 변경을 추적하는 방식은
note-app에서 채택한 실무 방식입니다.

이 가이드를 적용하는 데 pulls.review 설치, 모델 키, 새 Action, diff 업로드는
필요하지 않습니다. [공개 저장소에 포함할 수 있는 데이터의 범위](../decisions/repository.md)를
지킵니다. 합성 픽스처를 사용하고, 비공개 노트·회사 코드·인증 정보는 포함하지 않습니다.

[intent]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/core/src/analyze/adapters/llm/prompt.ts#L29-L52
[rules]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/core/src/analyze/adapters/rule-based/rules.ts
[adapter]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/core/src/analyze/adapters/rule-based/index.ts
[schema]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/core/src/types/analyze.ts#L12-L89
[group]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/components/diff/DiffGroup.vue
[nav]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/components/diff/DiffGroupNav.vue
[sidebar]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/components/diff/DiffGroupSidebar.vue
[nav-setting]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/state/group-nav.ts
[coverage]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/components/diff/group-utils.ts#L34-L87
