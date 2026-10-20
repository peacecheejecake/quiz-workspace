# QBANK-01 — 문제은행 목록·편집

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (하위 페이지 내비게이션)
**Route:** `/workspaces/:workspaceId/questions/bank`
**테스트:** `tests/e2e/questions/questions-bank.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태별 Empty/Loading/Failure/Success UI, 반응형 Layout과 Floating Side Panel, 접근성 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- **하위 페이지 내비게이션 (UX3c 2026-10-20):** 버튼으로 들어오는 Workspace 하위 페이지(문제은행, 문제 PDF 가져오기, 문제 변형 출제 검토, PDF 열람·원문 교정)는 제목 위에 뒤로가기(`BackLink`, Workspace 홈으로)와 breadcrumb(`Workspace 이름 › … › 현재 페이지`, 현재 항목 `aria-current="page"`)을 둔다.

## 수용 기준

### QBANK-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 등록된 문제가 없는 경우 직접 등록과 PDF Import 버튼을 제공하는 빈 상태를 보여준다.

### QBANK-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 유효한 객관식 문제를 저장하면 확정 문제를 챕터별 목록에서 조회할 수 있다.

### QBANK-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 문제를 수정하면 question_revision을 새로 생성하고 이전 풀이 기록의 사용 revision은 유지한다.

### QBANK-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 다른 사용자의 question ID로 직접 수정 API를 호출해도 서버가 차단한다.

### QBANK-01-AC05

- **Given:** Workspace 홈
- **When:** header의 `문제은행` 버튼으로 문제은행 페이지에 들어감
- **Then:** 문제은행 페이지 위쪽에 뒤로가기 링크(Workspace 홈으로)와 breadcrumb(`Workspace 이름` 링크 › `문제은행` 현재 페이지)이 있고, 뒤로가기나 breadcrumb의 Workspace 이름을 누르면 Workspace 홈으로 돌아간다. 문제 PDF 가져오기·문제 변형 출제 검토·PDF 열람 페이지도 같은 뒤로가기와 breadcrumb을 가진다(UX3c).

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
