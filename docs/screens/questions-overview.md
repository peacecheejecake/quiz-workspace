# QOV-01 — Questions Heatmap 홈

**상태:** 확정 화면 요구사항 v1.3
**Route:** `/workspaces/:workspaceId/questions`
**테스트:** `tests/e2e/questions/questions-overview.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태 토큰: unseen=lightgray, viewed=gray, incorrect=red, correct=green, retry=yellow(최상위 우선순위).
- 일반 마커 rounded square, 즐겨찾기 rounded star(크기 동일). Hover/focus scale=1.18, 고정 Grid 셀, 키보드/스크린리더 대응.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

## 수용 기준

### QOV-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 확정 문제 100개와 draft 10개 존재 시 상태 마커는 100개이며 보기 셔플로 점 개수가 증가하지 않는다.

### QOV-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 마커 위 포인터 미리보기만으로 viewed 상태를 만들지 않는다.

### QOV-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 즐겨찾기를 지정하면 현재 상태 색상·기본 크기는 유지한 채 rounded-square를 rounded-star로 변경한다. 고정 셀 유지.

### QOV-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** Hover 또는 키보드 focus 시 1.18배 확대와 Popover를 보여주고 reduced-motion에서는 움직임을 제거한다.

### QOV-01-AC05

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** Retry 플래그가 마지막 정답 상태와 동시에 있으면 노란색을 우선하고 Retry 해제 시 기존 초록색으로 돌아간다.

### QOV-01-AC06

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 마커 click/Enter로 Floating Practice Panel을 열고 닫으면 원래 마커로 focus를 복구한다.

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
