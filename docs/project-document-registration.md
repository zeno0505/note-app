# 프로젝트 수준 근거 문서의 명시적 등록

기존 main 소유 `createRegisteredExcerptReader`를 재사용한다. 선택한 worktree의
등록 파일·행에 있는 구조화된 기록만 읽으며, 자유 문서/소스 코드를 자동 해석하지
않는다. 모델, Git 명령, 문서의 URL 실행, 새로운 서비스, 사용자 파일 쓰기는 없다.
기존 task context/모델 후보/승인 캐시와 독립된 `readingDocuments` 입력이다.

## startup 등록

기존 scope/DAG/host 설정과 실제 worktree mapping이 확인되어야 한다. 등록만으로
note link를 만들거나 자동 프로젝트 검색을 하지 않는다. worktree path는 정확한
canonical path와 일치해야 한다. 다음은 합성 예시다.

```json
{
  "readingDocuments": [{
    "scopeId": "example", "dagRelativePath": "dag.yaml",
    "worktreePath": "/approved/worktree",
    "excerpts": [{"id":"feature-record","kind":"document",
      "relativePath":"reviews/project.jsonl","startLine":1,"endLine":1}]
  }]
}
```

각 발췌는 아래처럼 JSON object 하나여야 한다. 여러 기록은 JSONL의 서로 다른
행으로 저장하고 각각 등록한다. 허용되지 않은 필드, taskIds/완료 상태, 빈 내용,
잘못된 SHA/환경, 상대 경로 이탈은 거부한다. 결과는 `passed`, `failed`, `not-run`이다.

```json
{"schemaVersion":1,"id":"read-feature","section":"implemented","text":"명시적 연결 화면과 읽기 수집이 구현 기록에 있습니다.","verification":null,"references":["docs/feature.md","src/feature.ts"]}
```

```json
{"schemaVersion":1,"id":"check-record","section":"evidence","text":"합성 fixture의 단위 검사가 통과했다고 보고했습니다.","verification":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":"Linux / synthetic fixture","result":"passed"},"references":["reviews/check.md"]}
```

section은 implemented/next/evidence/decisions이다. verification이 null인 기록에는
검증 SHA/환경을 만들어 붙이지 않는다. 문서의 reported pass는 문서 선언으로
표시하며 현재 head 재검증·실제 모델·전체 작업 완료를 의미하지 않는다. references는
등록 문서가 선언한 연결일 뿐이다. 앱이 참조 파일의 내용·코드 동작을 확인하지 않는다.

## 출력·실패·갱신

등록 문장이 해당 섹션 앞에 나타난다. “등록된 프로젝트 구현 기록”, “등록된 남은
작업”, “등록된 검증 기록”, “등록된 결정 필요 항목”으로 읽을 수 있다. 인용에는 실제
등록 파일의 상대 경로·행 범위·발췌 해시·관측 시각과 문서가 보고한 검증 SHA/환경/
결과를 유지한다. canonical path와 원문 파일 전체는 renderer/모델에 전달하지 않는다.
별도의 사람 검토가 필요하며 자동 해석이나 출처의 진실성 인증은 수행하지 않는다.

잘못된/없는/변경 중인 소스, 다른 DAG·worktree, 현재 DAG 조회 실패는 현재 문서
미확인으로 표시하고 예전 문장을 현재 기능 근거로 재사용하지 않는다. 전체 수집
실패의 last-good 설명은 기존 snapshot freshness에 따라 과거로 유지한다. 내용·행
해시/등록 메타데이터가 같고 읽은 시각만 바뀌면 설명을 재생성하지 않는다.

config 전체에서 8 worktree 등록·8 파일·32 발췌 상한을 적용한다. 기존 reader의
128 KiB/파일, 512 KiB/reader 읽기, 2 KiB/발췌, 12 KiB/reader 발췌 상한과 경로/
symlink/hardlink/변경 검사를 유지한다. record text는 1,200 UTF-8 bytes,
references는 6개까지다. reader 응답은 독립 5초 deadline/취소로 제한하며 늦은
응답을 게시하지 않는다. timeout/취소 reader는 lifetime 재사용하지 않는다.
새 timer나 백그라운드 모델 큐를 만들지 않는다.

[실제 note-app 공개 근거 등록](../reviews/project-evidence-2026-10-06.md)은 앱 코드의
하드코딩과 구별되는 프로젝트별 문서다. 사용자 DAG/노트와 무관한 공개 개발 산출물이며
로컬 진단에서만 명시적으로 등록했다. 사용자 전역 startup 파일은 변경하지 않았다.
Phase 1 전체 완료나 사용자 수용 승인을 뜻하지 않는다.
