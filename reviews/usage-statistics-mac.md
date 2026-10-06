# 사용량 통계 페이지 Mac 검증 — 2026-10-06

제품 source SHA `7b0f42d90c1d51257db2afa503c148e7765bfb2d`, tree `cac8bb9797a865164fe738eedc119c0996f90267`. 공개 저장소에는 개인 프로젝트 내용, 계정 금액, 원본 화면과 캐시를 포함하지 않는다.

## 구현과 검증

`프로젝트 현황 → 사용량 통계 → 연결 및 설정` 순서로 독립 `/usage` 경로를 추가했다. 기존 CodeBurn 구성요소와 상태를 재사용하고 프로젝트 현황의 중복 패널은 제거했다. 페이지 이동에는 수집/모델 실행 효과가 없다. 미설정·demo·이전 관측·연결 해제 상태를 0 사용량으로 바꾸지 않는다.

- `npm run typecheck`: 통과.
- `npx vitest run --root . tests/unit/live-renderer-store.test.ts`: 30개 통과. 부분 timeout/retained/unknown, demo/미설정과 실제 route/nav를 검증한다.
- `npm test`: 941개 통과, 16개 skip.
- `npm run build`: 통과.
- 정확 source SHA [CI 37483122259](https://github.com/zeno0505/note-app/actions/runs/37483122259): success.

실제 arm64 Electron 44.5.1 패키지를 앱 소유의 별도 프로필로 실행했다. 첫 실제 Orca 관측은 74개 작업이며 CodeBurn 두 status와 quota 조회가 성공했다. 공개 저장 요약 상세·사용량 이동·뒤로 돌아오기·선택 복원, 세 메뉴의 실제 전환을 검증했다. 수집을 연결 해제한 뒤 페이지 전환으로 observedAt/CodeBurn/읽기 허용 목록이 바뀌지 않음을 확인했다. 새 모델 호출은 0회다.

실제 창 너비 760/1024/1600에서 가로 넘침이 없었다. 360/640 요청은 앱 minWidth 때문에 760으로 제한되므로 작은 너비의 성공으로 보고하지 않는다. 760/1600 화면의 메뉴·간격·경고를 직접 시각 검토했다. 관측 비용과 계정 quota 의미는 구분하며 실행 가능 여부는 미확인으로 표시한다. 검증용 앱/자식 프로세스는 정상 종료됐다.

## 실제 앱 업데이트

실행 경로를 새로 확인해 기존 `artifacts/87a28ca/note-app.app`를 검증된 7b 번들로 교체했다. 경로의 과거 이름과 내부 SHA는 다르다. 이전 앱은 검증된 복사본 및 원래 디렉터리로 보존했다. 표준 macOS Quit AppleEvent로 기존 프로세스 트리를 종료했으며 강제 종료는 사용하지 않았다.

정상 재실행 PID 11151의 명령/내부 SHA/서명을 검증했고, 설치된 모든 dist 파일이 실제 검증 번들과 일치했다. 교체 직전/직후 앱 프로젝트 캐시는 동일하며 정상 실행 뒤에도 상태·변경 시각·기존 이력이 보존됐다. 읽기 권한, AI 최신 저장, 호출 방지 ledger와 공개 하네스 파일 hash도 동일하다. 새 권한·디버그 포트·모델 활성화는 없다.

## 증거와 미검증 범위

로컬 작업 루트 `/Users/zeno/Documents/Codex/2026-10-06/task` 아래 비공개 증거:

- `verification-followup/T028-{typecheck,focused,full,build}.log`, `T028-ci.json`
- `native-T028-7b0f42d/ui-review.mjs`, `ui-report.json`, 각 페이지 760/1600 스크린샷
- `app-update-T028-7b0f42d/update-report.json`, `protected-cache-before.json`, `actual-state.json`

실제 CodeBurn 첫 조회는 모두 성공했으므로 `failureLabels`의 빈 배열 판정을 실제 Mac 부분 timeout의 양성 증거로 취급하지 않는다. 후속 격리 Mac 검증에서는 앱 소유 wrapper로 Claude status만 제한 시간을 넘겼다. 약 6.9초 후 timeout과 이전 성공값/다른 성공 조회의 공존을 실제 renderer에서 확인했고, 다음 정상 조회에서 모든 결과 성공과 timeout 표시 제거를 확인했다. `native-T028-partial/report.json`과 화면을 비공개 보존한다. 이는 통제된 timeout 검사이며 실제 제공자 장애가 아니다.

정상 사용자 앱의 후속 실제 캡처에서도 첫 수집 완료·로딩 해제·워크트리 74개/현재 관측 71개·프로젝트 목록·다음 background 조회를 확인했다. 최초 로딩 캡처만으로 실패나 지연 원인을 확정하지 않는다. 실제 화면은 `app-update-T028-7b0f42d/actual-settled-overview.png`에 있다. 일반 프로필 자동 입력은 `window_not_focused`로 차단되어 공개 저장 요약 클릭과 OS 폴더 선택창 취소는 미검증으로 남긴다. 이 한계는 별도 프로필의 실제 화면 전환 성공을 무효화하지 않는다.

T-028은 구현·회귀·실제 페이지 검증 근거가 있는 in_review이며, 원래 의존성/미검증 조건을 무시해 done 처리하지 않는다. Phase 1 전체 완료나 일반 AI transport 활성화를 의미하지 않는다.
