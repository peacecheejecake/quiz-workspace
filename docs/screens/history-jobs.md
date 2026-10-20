# HISTORY-01 — 작업·변경·풀이 이력

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (이력 floating dialog, 하나의 목록)
**Route:** `/workspaces/:workspaceId?panel=history` (Workspace header의 `이력` 아이콘 버튼; 이전 `/workspaces/:workspaceId/history`는 여기로 redirect)
**테스트:** `tests/e2e/history/history-jobs.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태별 Empty/Loading/Failure/Success UI, 반응형 Layout과 Floating Side Panel, 접근성 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- **UX3c 2026-10-20:** 이력은 `공유하기` 왼쪽의 `이력` 아이콘 버튼(접근성 이름 "이력")이 여는 non-modal floating dialog "이력"이다. 변경 이력·작업·내 풀이 기록을 하나의 최신순 목록으로 합치고, 각 행은 종류를 텍스트 badge(`변경`·`작업`·`풀이`)로 보인다. 세 API를 따로 페이지로 읽어 시간순으로 병합하며, "더 보기"는 더 남은 목록의 다음 페이지를 읽는다(아직 읽지 않은 더 오래된 항목보다 앞선 항목만 보여 순서가 어긋나지 않음). 실패한 작업 행은 원인·재시도 가능 여부·"다시 시도"를, 풀이 행은 그 문제를 홈의 풀이 panel로 여는 링크를 가진다. 한 목록을 못 읽으면 나머지는 보이고 그 종류의 오류와 "다시 불러오기"를 보인다.

## 수용 기준

### HISTORY-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 문서 교정과 문제 변경 이력에서 사용자·시간·대상·revision을 조회할 수 있다.

### HISTORY-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 인덱싱 작업이 실패하면 원인, 재시도 가능 여부, 조치 버튼을 표시한다.

### HISTORY-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 개인별 문제 풀이 이력은 본인 계정에서만 조회 가능하다.

### HISTORY-01-AC04

- **Given:** 문서 교정·작업·풀이 기록이 있는 Workspace 홈
- **When:** header의 `이력` 아이콘 버튼(`공유하기` 왼쪽)을 누름
- **Then:** "이력" floating dialog(`?panel=history`)가 즉시 열리고 불러오는 동안 skeleton을 보인 뒤, 변경·작업·풀이 항목을 하나의 목록에 최신순으로 보인다. 각 항목은 종류 badge(변경/작업/풀이)와 `<time>`을 가지며 색만으로 상태를 전달하지 않는다(UX3c).

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
