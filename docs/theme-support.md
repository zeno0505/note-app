# PrimeVue 기반 전체 라이트·다크 지원

요청: “prime vue 색상을 기반으로 다크모드를 지원하는 방향으로 갑시다.”
대상은 기존 앱 전체이며 이미지·스크린샷 원본을 반전하지 않는다.
PrimeVue4.5.5, @primeuix/themes3.0.1, @primeuix/styled1.0.0의 설치 소스를 기준으로 한다.
의존성 업그레이드·모델 호출·노트/권한 변경은 포함하지 않는다.

`main.ts`는 기존 Aura 및 녹색 primary preset과 OS `prefers-color-scheme` 동기화를 유지한다.
공통 surface/text/border/input/interaction은 PrimeVue 토큰을 사용한다.
`theme.css`는 앱 역할과 라이트/다크 쌍을 중앙화한다. `style.css`에는 직접 HEX 색이 남지 않는다.

| 역할 | 라이트 | 다크 |
| --- | --- | --- |
| 앱 배경 | surface50 | surface950 |
| 카드·헤더·Dialog | content.background | content.background |
| muted 표면 / 선택 | surface100 / primary50 | surface800 / primary950 |
| 본문 / 보조 글자 | text.color / surface600 | text.color / surface300 |
| 경계 / native 입력 경계 | content.border.color / surface500 | 동일 토큰의 다크 값 |
| primary / focus | primary.color / focus.ring.color | 동일 토큰의 다크 값 |
| 성공 / 경고 / 오류 / 정보 | green/amber/red/blue의50 배경·800 글자 | 950 배경·300 글자 |
| 쿼터 / 비용 / track | primary600 / blue700 / surface200 | primary300 / blue300 / surface700 |

상태색은 완료 근거의 의미를 변경하지 않는다. 기존 neutral badge는 neutral로 유지한다.
원본 이미지·본문에 filter/invert를 적용하지 않는다. 직접 색을 가진 앱 CSS214곳을 역할로 옮겼다.

| 요구·화면 | 구현과 검증 방법 | 검증 근거 |
| --- | --- | --- |
| 프로젝트 목록·선택·hover·focus | surface/text/selected/primary 역할 통일 | 격리 Electron overview/project, 실제 hover와 Tab focus |
| 사용량 그래프·상태 배지 | 독립 chart/status 역할 쌍 | 실제 fixture 사용량 화면, synthetic 상태 probe; 그래프 대비3:1 이상 |
| 설정·읽기 허용·요약·진단 | 모든 수동 light 색을 역할로 대체 | 실제 renderer settings/project 화면; 상태 probe와 실제 설치 후 대조 |
| 재연결·Dialog·disabled | 기존 PrimeVue token 사용, native 입력도 공통 역할 | 테마 Electron 및 대형 DAG/원문 보존 재연결 회귀 |
| empty/error/loading/selected | 기존 역할·문구 유지 | 실제 empty 화면 및 명시적인 synthetic CSS probe; 모델 실행하지 않음 |
| tooltip | 현재 앱은 native title 사용, custom tooltip component 없음 | OS color-scheme 유지. DOM 대비 검사로 native OS tooltip 픽셀을 검증했다고 주장하지 않음 |
| OS 테마 전환 | html note-app-dark를 media change에 동기화 | 재시작 없이 light/dark/light 반복 전환 |
| 가독성 | foreground/background 및 키보드 outline 측정 | 검사한 글자 대비4.5:1 이상, 그래프3:1 이상, focus2px |
| 원본·권한 보존 | 모델·링크 확인0회, 설정/보호 파일 hash 대조 | 실제 설치 보존 보고서와 정상 실행 복원 |

검증 명령: `npm run check`, `npm run test:electron:theme`, `npm run test:electron:reconnect`.
Electron은 기존 pinned query Python/DAG 환경을 사용한다.
단위 테스트1005통과/13skip, 타입 검사·빌드 통과.
private `theme-support/electron-confirmed/report.json`의53개 검증과
`theme-support/reconnect-final/report.json`의 격리 회귀는 통과했다.
synthetic 상태 probe는 실제 사용자 상태의 증거와 구분한다.

최종 canonical 설치의 실제 light/dark 픽셀 확인 전 완료나 검수 준비로 보고하지 않는다.
실제 설치 후 private `theme-support/canonical/report.json` 및 `final-report.json`의
source SHA/build/status와 화면 파일로 최종 판정한다. 개인 화면·본문·설정은 Git에 넣지 않는다.
