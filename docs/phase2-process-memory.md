# Phase 2 명시 PID 메모리 어댑터

T-044의 제한된 OS 메타데이터 읽기와 T-051의 귀속 경계를 구현한다. **현재 Orca collector에는 OS PID와 프로세스 시작 식별자 연결이 없으므로 프로젝트 메모리 capability는 여전히 unsupported다.** 이 모듈의 존재가 현재 제품에서 외부 프로세스 수집이나 프로젝트별 메모리 측정을 시작했다는 뜻은 아니다.

## 입력과 신뢰 경계

`src/phase2/process-memory.ts`의 main-process 전용 API:

```ts
const reader = createProcessMemoryAdapter({ hostId: verifiedLocalHostId });
const result = await reader.read({ targets: trustedTargets, signal });
```

각 `TrustedProcessMemoryTarget`은 다음을 명시해야 한다.

- 현재 어댑터와 같은 `hostId`, 양의 정수 `pid`, 예상 effective UID
- 신뢰한 원천이 제공한 epoch milliseconds `startTime`과 대상 원천 `source`
- Linux: 같은 lifetime의 `/proc/<pid>/stat` start ticks 문자열
- macOS: `darwin-lstart` 비교 방식. 초 미만 정밀도는 검증되지 않는다
- 연결을 주장할 경우 해당 host/PID/lifetime에 대한 `linkage.source`, `linkage.evidence`, 명시 `workstreamIds`. 근거가 없으면 `linkage: null`

타입이나 비어 있지 않은 문자열 자체는 증거가 아니다. 호출자는 대상 PID 및 연결 원천의 신뢰·권한·최신성을 먼저 검증해야 한다. 임의 renderer/IPC 입력, 제목/폴더명/remote 이름, Orca sidebar 활성 상태를 이 입력으로 승격하면 안 된다. 이 모듈은 등록되지 않은 폴더나 원천을 찾아 증명하지 않는다. 다른 호스트의 숫자 PID를 로컬 PID로 읽는 요청도 거절한다.

중복 PID와 잘못된 대상이 있으면 전체 요청을 I/O 전에 거절한다. 공유 프로세스는 대상 하나에 검증된 여러 workstream ID를 넣는다. target은 최초 읽기 전에 복사하므로 실행 중 호출자의 변경이 조회 범위를 넓히지 않는다.

## 읽는 범위

### Linux

정확히 `/proc/<pid>/stat → status → stat` 순서로 읽는다. 첫/마지막 start ticks가 신뢰 원천의 값과 같아야 한다. 중간 `status`에서 PID, Tgid, effective UID, VmRSS를 검증한다. 프로세스 이름은 파싱 시 무시하며 결과·오류·로그에 남기지 않는다. RSS 단위는 kB × 1024 bytes다.

시작 epoch은 trusted source가 공급한 값이다. 이 구현은 `/proc/stat`, uptime 또는 임의 clock tick 상수로 epoch을 추정하지 않는다. 시작 시각과 ticks의 올바른 연결은 원천 어댑터의 책임이다. Linux VmRSS는 근사 관측이며 정밀 물리 메모리 합계가 아니다. [Linux 커널 proc 문서](https://www.kernel.org/doc/html/latest/filesystems/proc.html)

### macOS

각 PID에 한 번씩 고정 명령을 실행한다.

```text
/bin/ps -p 100 -o pid=,uid=,lstart=,rss=,state=
```

shell을 사용하지 않으며 명령/인수/environment/username 열을 요청하지 않는다. 자식 환경은 PATH, LC_ALL=C, LANG=C, TZ=UTC, COLUMNS만 고정 공급한다. 실행 파일, command string, 임의 argv, 검색 범위, cwd를 호출자가 지정하는 옵션은 없다.

**여러 PID를 한 `-p` 목록으로 합치지 않는다.** Apple 공개 구현은 단일 PID selector일 때만 `KERN_PROC_PID`로 제한하고 여러 PID에서는 내부 전체 목록으로 확장한다. 그래서 이 구현은 제한된 대상 수 안에서 순차 단일 PID 조회만 한다. [Apple ps 소스](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.c)

`lstart`는 locale의 날짜 문자열이며 Apple 구현은 시작시각의 초 부분만 사용한다. UTC/C locale로 날짜·요일·달력 유효성을 엄격하게 검사하고 RSS는 1024-byte 단위로 변환한다. 서로 다른 초의 PID 재사용은 거절할 수 있지만 **같은 초의 재사용을 배제할 수 없다.** 따라서 `identityPrecision: seconds` 표본의 RSS는 명시 PID 관측으로만 보존하고 `linkage: unknown`, workstream ID 빈 목록으로 둔다. 새로운 정밀 lifetime 원천이 확인되기 전에는 이 결과를 프로젝트 독점/shared 귀속으로 승격하면 안 된다. [Apple ps 매뉴얼](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.1), [lstarted 구현](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c)

## 반환 상태와 합산

- `samples`: 대상별 observed/denied/exited/pid-reused/owner-mismatch/unknown/invalid-target/unsupported/timeout/cancelled/output-limit/busy 및 한글 사유
- `observations`: 기존 `ProcessMemoryObservation` 순수 투영에 맞는 입력
- `targetSource`, `linkageEvidence`: 대상 원천 및 실제 검증한 연결 근거. 실패와 macOS coarse 표본에는 연결 근거를 승격하지 않는다
- `state: complete`: 공급한 요청 대상만 정상 관측/종료했음을 뜻한다. 전체 시스템/프로젝트 수집 완료가 아니다
- `coverage`: 측정이 있으면 partial, 없으면 unknown. 목록이 비어도 관측량 0이나 전체 coverage complete가 아니다
- 실패 표본의 startTime은 호출자가 증명한 기존 lifetime이다. 재사용한 PID의 새 lifetime을 발견했다고 주장하지 않으며 RSS·귀속은 폐기한다

Linux ENOENT/ESRCH와 명시 zombie/종료 상태는 exited다. 접근 거절은 denied이고 다른 경로나 권한 상승으로 재시도하지 않는다. macOS ps의 빈 응답/실패는 숨김·미관측일 수 있으므로 unknown이다. RSS 누락/파싱 실패/소유자 불일치/시작 식별자 변경은 null이며 0으로 바꾸지 않는다. 실제 성공 RSS가 명시 0인 경우만 0을 보존한다. 이전 성공 표본을 다음 실패의 최신 값으로 재사용하지 않는다.

`projectMemoryObservations(result.observations, ...)`를 사용하려면 실제 연결된 source capability를 별도로 확인해야 한다. `currentResourceCapabilities().processMemory`는 변경하지 않았다. 공유 PID lifetime은 한 번만 계수하며 서로 다른 PID의 공유 물리 페이지는 RSS만으로 중복 제거할 수 없다. 미귀속 값을 프로젝트별로 나누거나 provider quota/역사 사용량과 합산하지 않는다.

Electron `app.getAppMetrics()`나 Node 자체 프로세스 메트릭은 **note-app 자체 범위**다. 이 모듈은 그것을 받거나 project observation으로 변환하지 않는다. 앱 자체 메트릭은 UI·계약·합계가 프로젝트 메모리와 별도인 경로로만 통합한다. 시스템 압력/swap은 수집하지 않는다.

## 상한과 취소

| 항목 | 기본값 | 허용 최댓값 |
| --- | ---: | ---: |
| 한 요청의 대상 수 | 32 | 128 |
| 전체 요청 deadline | 1,500 ms | 5,000 ms |
| 전체 metadata 출력 | 256 KiB | 1 MiB |
| 파일/ps 한 회 출력 | 16 KiB | 64 KiB |

Linux는 bounded buffer와 read-only/no-follow open만 사용한다. macOS는 stdout와 stderr 바이트를 합산하며 stderr 본문을 보존하지 않는다. 요청 취소·deadline·출력 초과는 late 결과를 버린다. 시간 안에 끝나지 않은 OS I/O/helper가 있으면 결과를 먼저 반환하되 정리가 끝날 때까지 다음 조회는 busy다. 정리되지 않은 작업을 반복 poll로 쌓지 않는다.

macOS timeout/취소/출력 초과 시 **직접 생성한 ps 조회 helper 객체만** 정리한다. 관측 대상 PID에 signal을 보내거나 사용자 프로세스/프로세스 그룹을 종료하는 경로는 없다. 프로세스 열거, cmdline/environ/cwd/exe/maps/smaps 읽기, credential/cache 읽기, OS·보안 설정 변경도 없다.

## 검증과 남은 gate

2026-10-07 synthetic OS/proc/runner fixture 테스트 64개와 TypeScript 검사가 통과했다. 테스트는 실 사용자/외부 프로세스를 열거하거나 읽지 않는다. 주요 범위는 공유 PID·미귀속·접근 거절·PID 재사용·churn·종료·UID mismatch·잘못된 메타데이터·경로/argv 제한·상한·취소·late 결과·중복 호출·요청 변경 및 native ps runner의 helper 정리다.

```text
npx vitest run --root . tests/unit/phase2-process-memory.test.ts
npm run typecheck
```

실제 Mac/Orca PID 연계와 동작·비용 측정은 아직 하지 않았다. 등록 source의 정확한 PID/lifetime/worktree 계약, 권한 범위, 활성/배경 수집 비용과 freshness를 확인하기 전에는 live project memory를 켜지 않는다. Mac의 초 해상도 한계는 fixture 통과로 해소되지 않는다. 이 어댑터는 모델 실행, 새 계정/권한 연결, 자동 파견 또는 종료 정책을 만들지 않는다.
