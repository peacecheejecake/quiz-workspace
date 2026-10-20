# QBANK-01 — 문제은행 목록·편집

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (하위 페이지 내비게이션) · UX4 개정 2026-10-21 (검색·필터 접기, PDF 가져오기 dialog)
**Route:** `/workspaces/:workspaceId/questions/bank`
**테스트:** `tests/e2e/questions/questions-bank.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태별 Empty/Loading/Failure/Success UI, 반응형 Layout과 Floating Side Panel, 접근성 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- **하위 페이지 내비게이션 (UX3c 2026-10-20):** 버튼으로 들어오는 Workspace 하위 페이지(문제은행, 문제 PDF 가져오기, 문제 변형 출제 검토, PDF 열람·원문 교정)는 제목 위에 뒤로가기(`BackLink`, Workspace 홈으로)와 breadcrumb(`Workspace 이름 › … › 현재 페이지`, 현재 항목 `aria-current="page"`)을 둔다.

- **UX4 (2026-10-21):**
  - 제목 줄의 `PDF 가져오기`는 홈과 같은 "문제 PDF 관리" non-modal dialog(QIMPORT-01-AC05와 같은 component: 문제 PDF 목록 + Dropzone)를 이 페이지 위에 연다. 다른 화면으로 이동하지 않는다. 빈 상태의 `PDF 가져오기`도 같다.
  - 문제가 하나도 없으면(필터 없이 빈 문제은행) 제목 줄의 `PDF 가져오기`·`문제 등록`을 두지 않고 빈 상태의 `문제 직접 등록`·`PDF 가져오기`만 둔다. 필터 결과가 비었을 때는 제목 줄 버튼이 남는다.
  - 검색·필터(문제 검색, 유형, 챕터, 상태)는 홈의 상태 필터와 같은 방식으로 접는다: 기본 접힘, 위/아래 화살표 아이콘 버튼 "검색·필터"(`aria-expanded`, `aria-controls`). 접힌 동안 필터가 적용 중이면 "검색·필터 적용 중"을 보인다.
  - 버튼 문구는 줄바꿈하지 않는다(design-system.md §4.1).
  - `?create=1`(홈 `문제` 메뉴의 `직접 추가`)로 들어오면 "문제 등록" dialog를 바로 연다. 한 번만 적용되며 URL에서 빠진다(편집 권한이 없으면 무시).

## 수용 기준

### QBANK-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 등록된 문제가 없는 경우 직접 등록과 PDF Import 버튼을 제공하는 빈 상태를 보여준다. PDF Import 버튼은 "문제 PDF 관리" dialog를 연다(UX4).

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

### QBANK-01-AC06

- **Given:** 문제은행(편집 권한): 문제가 없는 Workspace와 문제·문제 PDF·책 문서가 있는 Workspace
- **When:** 문제은행을 열고 "검색·필터" 버튼과 제목 줄의 `PDF 가져오기`를 누름
- **Then:** 빈 문제은행의 제목 줄에는 `PDF 가져오기`·`문제 등록`이 없고 빈 상태에만 있다. 문제가 있으면 제목 줄에 둘 다 있다. 검색·필터는 기본으로 접혀 있고(문제 검색 입력이 보이지 않음) 화살표 아이콘 버튼 "검색·필터"(`aria-expanded`, `aria-controls`)로 펼치고 접는다. `PDF 가져오기`는 페이지를 떠나지 않고 홈과 같은 "문제 PDF 관리" non-modal dialog를 열어 문제 PDF만(책 문서 없이) 나열하고 Dropzone의 "PDF 선택"을 보인다. 375px 폭에서도 버튼 문구는 줄바꿈되지 않고 페이지 가로 스크롤이 없다(UX4).

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
