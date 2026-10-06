# 공개 note-app GitHub 읽기 관측

현재 지원 범위는 **zeno0505/note-app 한 저장소**다. 앱 main의 Node fetch가 공개
GitHub REST를 GET으로 읽는다. ChatGPT/Codex 커넥터 인증을 앱에 가져오지 않고,
gh·토큰·키체인·로그인 설정·댓글·모델을 사용하지 않는다. 다른 저장소나 임의 URL을
설정할 수 없다. 비공개 저장소나 공개 API 접근 거절은 이 경로로 우회하지 않는다.

## 명시적 시작 등록

기존 private NOTE_APP_CONFIG 파일에서 승인된 note scope와 정확한 체크아웃을
연결한다. 아래는 허구 경로이며 자동 생성/수정되는 사용자 설정이 아니다.

```json
{
  "schemaVersion": 1,
  "orcaExecutablePath": "/usr/local/bin/orca",
  "localHostId": "approved-local-host",
  "noteScopes": [{
    "scopeId": "note-app",
    "hostId": "approved-local-host",
    "vaultRootPath": "/Users/you/Notes",
    "scopePath": "/Users/you/Notes/zeno0505/note-app",
    "dagRelativePaths": ["dag.yaml"]
  }],
  "dagQuery": {
    "pythonPath": "/absolute/trusted/python3",
    "queryScriptPath": "/absolute/approved/read-dag-stack/query.py"
  },
  "summarySelections": [],
  "publicGitHub": [{
    "scopeId": "note-app",
    "dagRelativePath": "dag.yaml",
    "worktreePath": "/Users/you/Codex/note-app",
    "branch": "feat/phase1-foundation"
  }]
}
```

publicGitHub는 renderer가 설정할 수 없다. main mapper가 등록된 local host,
정확한 worktree path, vault 아래 project scope, 등록된 DAG를 매번 재검증한다.
이 등록은 읽기 전용 연결이며 docs/note 링크나 사용자 노트를 만들거나 바꾸지
않는다. 기존 링크 기반 mapper는 기본 경로로 유지된다. 별도 읽기 등록은 화면에
구분 표시된다. 다른 scope/작업의 GitHub 관측은 하지 않는다. 별칭 때문에 실제
canonical worktree와 등록 경로가 다르면 GitHub 연결을 추측하지 않는다.

## 관측과 해석

- 지정 branch ref의 실제 head SHA
- state=all PR 목록, 실제 PR detail의 merged 상태와 head/merge SHA
- 해당 SHA의 GitHub Actions workflow 실행. push와 pull_request event를 구별한다.
  이 endpoint는 모든 종류의 CI/check-run/status/필수 체크를 포함하지 않는다.
- 정식 PR review submissions의 commit_id와 state. reviewer별 최신 제출만 본다.
  CodeRabbit은 정확한 coderabbitai[bot] login의 제출 기록만 분류한다. 댓글 존재,
  COMMENTED, DISMISSED를 review 완료·승인으로 취급하지 않는다. 별도 리뷰 에이전트
  완료는 현재 인증할 수 없어 미확인이다.

현재 어댑터는 PR/task/round/commit 대응을 인증하지 않는다. taskIds는 빈 목록이며,
병합 PR의 squash/원 커밋 대응과 특정 DAG task 완료는 미확인으로 남긴다. 현재
작업 선언과 PR·브랜치 사실은 별도로 표시한다. 직접 푸시 CI와 PR 승인/병합은
서로 다른 출처다. head CI 성공도 merge SHA 검증·배포 완료가 아니다. 미병합 PR의
merge preview 값을 실제 merge commit으로 표시하지 않는다.

DAG는 기존 SHA pin의 공식 query adapter로만 projection한다. 사용자 DAG를
set/render하거나 track-dag-stack 전체 작업을 자동 호출하지 않는다.

## 주기, 한도와 실패

Orca/DAG의 기존 foreground 20초/background 5분 수집은 유지한다. 공개 GitHub
API는 그보다 느린 **5분 성공/부분 관측 캐시**를 사용하여 foreground에서 같은
조회가 반복되지 않게 한다. 수동 새로고침/지금 요약은 cache를 우회할 수 있지만
15초 안의 중복은 합류/재사용한다. 내용이 같으면 읽기 summary revision과 원래
인용 시각을 유지한다. checkedAt과 외부 근거의 observedAt은 별개다.

고정 api.github.com URL, GET, redirect:error, credentials:omit, Authorization/Cookie
없는 명시적 헤더만 사용한다. 전체 deadline 4.5초, 요청 최대 12개, 응답당 256 KiB,
합계 1 MiB, PR 4개/Actions 16개/reviews 32개다. Link next나 total_count 초과,
세부 조회 실패는 partial로 표시한다. 리뷰가 페이지 상한에 걸리면 최신 승인 기록을
선택하지 않는다. 무한 pagination/자동 retry를 하지 않는다.

403/429에는 Retry-After/reset을 제한된 cooldown으로 반영한다. 공개 REST 자체의
할당량을 넘을 수 있으며 token을 추가해 우회하지 않는다. 일치하는 SHA의 마지막
완전 CI 값은 조회 실패 시 historical로 남기고, 새로운 head의 CI나 현재 PR CI
성공으로 옮기지 않는다. 전체 실패에는 reading scheduler의 마지막 성공 근거가
historical로 유지된다. 취소/시간 제한은 늦은 결과를 게시하지 않으며 해당 observer
lifetime을 재사용하지 않는다. 네트워크 GET 응답을 제한하는 경계이며 서버측 작업
취소나 모델 격리의 증명이 아니다.
