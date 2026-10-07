# Phase2 최종 Linux 구현 검증 — 2026-10-07 UTC

## 결과

- 테스트 기준 SHA: `93ed46d47dfd09f16d383dfcc869131210900426`
- 제품 코드·빌드는 `a6d9f30b0a32ba23e0d395fd1226dc5491aec0dc` 이후 동일하다. 이후 두 커밋은 Phase2 합성 fixture의 repo ID와 진단만 수정했다
- 외부 query 의존성을 켠 `npm run check`: **66개 파일 / 1395개 테스트 전부 통과 / skip0**, TypeScript·Vue 검사와 production build 성공
- 실제 Electron Phase2: **exit0 / PASS / 모델 호출0**
- 기존 접두사/요약 회귀: **exit0 / PASS / 모델 호출0**
- 원문 fixture DAG 불변, renderer sandbox·context isolation 유지, 테스트 앱 종료와 소유 fixture 정리 확인
- main merge, 외부 push, 실제 계정 연결, credential/private cache 직접 조회, 실제 외부 모델 호출, Mac 설치는 하지 않았다

전체15개 계약과 남은 interface/환경/실측 구분은 [수락 행렬](../docs/phase2-workspace.md#7-15개-계약의-남은-단계)에 있다. 이 결과를 모든 실제 수집/사용자 수락의 완료로 해석하지 않는다.

## 정확한 실행과 원시 결과

```sh
DAG_QUERY_PYTHON=<신뢰된 절대 Python 경로> \
DAG_QUERY_SCRIPT=<기존 pin과 일치하는 승인된 query.py 경로> \
npm run check

NOTE_APP_PYTHON=<동일 Python 경로> \
NOTE_APP_DAG_QUERY_PATH=<동일 query.py 경로> \
NOTE_APP_PHASE2_EVIDENCE=<격리된 증거 디렉터리> \
npm run test:electron:phase2

NOTE_APP_PYTHON=<동일 Python 경로> \
NOTE_APP_DAG_QUERY_PATH=<동일 query.py 경로> \
NOTE_APP_PREFIX_EVIDENCE=<별도 격리된 증거 디렉터리> \
npm run test:electron:prefix
```

- [전체 gate 로그](runs/2026-10-07-phase2/all-dependencies-check.log)
- [실제 pinned query·candidate 테스트 로그](runs/2026-10-07-phase2/external-query-check.log): 37개 통과. 합성459개와2MiB 초과 source, 기존16MiB 상한도 포함하며 **실제 사용자의459개 DAG라는 뜻은 아니다**
- [Phase2 원시 결과](runs/2026-10-07-phase2/phase2-report.json), [실행 로그](runs/2026-10-07-phase2/electron.log)
- [기존 prefix 원시 결과](runs/2026-10-07-phase2/prefix-report.json), [실행 로그](runs/2026-10-07-phase2/prefix-electron.log)
- [제품 빌드 해시](runs/2026-10-07-phase2/final-build-hashes.txt), [이미지 SHA256 manifest](runs/2026-10-07-phase2/evidence-manifest.json)

외부 private query 내용은 복사·배포하지 않았다. pin은 `23d00c96beb0661bb7da064d7dd83566ea754f75165bb9790831dabc25887d47`이다. Vite의781.21kB 단일 chunk 경고는 남아 있으며 build 실패가 아니다.

## 실제 GUI로 확인한 범위

1. 숨겨진 딥링크 선택 보존, 명시 필터 회복, 왼쪽 목록/오른쪽3탭
2. 원문 v2의500개 태스크, 정확7상태, 완료+검증 중첩, unknown 원본 보존
3. 오른쪽 상세·정확한 단일 task 요약 동의·모델 미호출
4. Markdown 제목/강조/표/3단계 목록/코드, 앵커, 로컬 문서와 뒤로 이동, HTML 비실행, 위험 링크 비활성화
5. source-bound 이미지, fit/원본/확대/scroll, 외부 이미지 차단, 해제된 IPC 세션 거절
6. 공식 branch-json 고정 CLI runner를 통과하는 합성 executable, 오늘/월, 등록/저장소 확인·미등록/미확인3단계, 누락 token unknown
7. 실제 Electron 앱 자체 메모리와 프로젝트 메모리의 구분
8. readonly DAG의 제목/상태·전체맞춤/100%·키보드 선택/focus 복귀·접힌 진단
9. 라이트/다크와820px 화면, 문서 가로 overflow 없음
10. 프로세스 재시작 후 탭/필터/정확한 요약 범위 유지와 no-replay

CodeBurn 데이터는 **합성 CLI 통합 fixture**다. 실제 사용자의 소비량이 아니다. 메모리는 **실제 note-app 프로세스 관측**이며 개발 프로젝트 메모리나 물리 메모리 합계가 아니다.

취소·늦은 응답·권한 철회·부모 문서 hash·세션 상한/재사용·5초 deadline·late handle 정리는 별도의 main/Vue lifecycle 단위 테스트로 확인했다. GUI의 단순 세션 해제와 동일한 검증이라고 주장하지 않는다. 원래 잘못 합쳐지던 checkout/repo와 재귀 권한 검증 문제도 회귀에 포함한다.

기존 prefix 회귀는 T/TT 구분,200개 표시 상한 적용 전 범위 선택,200번째 밖 task 직접 선택,20개 제한, 동의 초기화, 취소 시 저장 범위 불변,22초 polling/지연 refresh 중 모달·초안·검색·focus 유지, Escape·재연결·재시작을 확인했다.

## 시각 검수

최종 Phase2의8개 이미지와 prefix의7개 이미지를 검증자가 직접 열었고, 구현 담당도 Phase2 최종8개를 직접 열었다. 표·중첩, 비활성 링크 안내, 이미지 확대/스크롤, 저장소3단계, 앱 메모리 caveat, DAG 상태/키보드 focus, 테마와 좁은 화면에서 검증을 막는 clipping/overlap은 관측하지 못했다.

- [표·중첩 목록](runs/2026-10-07-phase2/images/rich-markdown.png)
- [저장소 사용량](runs/2026-10-07-phase2/images/repository-usage.png)
- [앱 메모리와 수집 경계](runs/2026-10-07-phase2/images/usage-capabilities.png)
- [820px 화면](runs/2026-10-07-phase2/images/tasks-narrow.png)
- [라이트 DAG](runs/2026-10-07-phase2/images/tasks-light.png), [다크 DAG](runs/2026-10-07-phase2/images/tasks-dark.png)
- [태스크 상세](runs/2026-10-07-phase2/images/task-detail.png), [이미지 확대](runs/2026-10-07-phase2/images/evidence-image.png)

DAG의500-node chain은 내부 가로 스크롤을 사용한다. 전체맞춤은 관계 개요이며 축소된 글자를 읽을 수 있다는 보증이 아니다. 이미지 fixture는 자체 작성한 색상 격자이며 실제 제품 스크린샷이나 검증 통과 증거를 꾸민 것이 아니다.

## 성능 관측

동일 합성500 fixture의 한 번 측정이다. 합의한 수용 임계치나 전체 환경 benchmark가 아니다.

| 항목 | 관측 |
| --- | ---: |
| 앱 시작·초기 연결/읽기 | 6363.6ms |
| 500개 목록 표시 | 119.6ms |
| 필터 전환 | 41.4ms |
| 500-node layout/표시 | 152.0ms |

프로세스별 원시 메모리는 JSON에 보존했다. 서로 공유되는 페이지 때문에 합산하여 물리 메모리로 제시하지 않는다.

## 실패를 통해 보완한 경계

- 기본 활동 필터가 선택 프로젝트를 가리면 URL 선택까지 지우던 제품 문제를 수정하고 명시 회복을 추가했다
- Electron의 비영구 browser storage에 의존하던 화면 상태를 private 앱 cache로 옮겨 재시작 보존을 검증했다
- 합쳐진 프로젝트의 대표 repo를 다른 checkout에 붙이던 경로를 개별 관측 identity로 수정했다
- 문서 링크의 재귀 재검증/조상 eviction을 평탄한 최대8단계 proof·세션 재사용·전체5초 응답으로 고쳤다
- current/source 변경 중 읽기 busy가 남던 UI를 수정하고7개 lifecycle 회귀를 추가했다
- 마지막 GUI fixture의 repoId:null을 ‘확인된 저장소’로 기대한 오류와 worktree/process ID 불일치를 테스트에서 수정했다. 제품의 unknown/ambiguous_identity 차단은 약화하지 않았다

## 남은 실제 수용 단계

- Mac에서 실제 설치·패키징/서명·파일권한·일반 실행·focus/앱 연동·백업/rollback 및 상태/최근12건 history/모델 본문·ledger 보존 확인
- 실제459개 원문·프로젝트 정책과 사용자 읽기 수용
- 설치 CodeBurn 버전/자료 기간/누락/여러 worktree·경로 재사용의 정확도 검증
- 프로젝트 메모리에 필요한 Orca의 명시 PID·정밀 수명·worktree 연결 source는 현재 없다. Mac을 켜기만 하면 해결된다고 말하지 않는다
- 실제 멀티계정 수집은 공식 계정별 interface와 구체적인 연결 승인이 필요하다. private credential/cache로 대신하지 않는다
- 선택적 Orca 이동 capability와 OS pressure/swap source 확인
- 허용된 실제 모델의 의미 품질 평가. 이번 검증은 실제 모델을 부르지 않았다

권한/인터페이스가 막힌 항목은 임의 mock 성공으로 완료 처리하지 않았다.
