# QGEN-01 — 문제 변형 출제

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (문제 생성 dialog) · UX4 개정 2026-10-21 (`문제` 메뉴의 변형 출제)
**Route:** 검토 페이지 `/workspaces/:workspaceId/questions/generate?source=&run=` (뒤로가기·breadcrumb `Workspace 이름 › 문제 변형 출제`) · 문제 생성 dialog `/workspaces/:workspaceId?panel=generate`
**테스트:** `tests/e2e/questions/questions-generation.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태별 Empty/Loading/Failure/Success UI, 반응형 Layout과 Floating Side Panel, 접근성 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- **문제 생성 dialog (UX3c 2026-10-20):** Workspace 홈 header의 `문제` 메뉴 › `변형 출제`(UX4 2026-10-21; 이전 `문제 생성` 버튼)는 non-modal floating dialog "문제 생성"을 바로 열고(목록을 불러오는 동안 skeleton) 변형할 확정 문제를 고른 뒤 같은 dialog에서 생성 form(변형 유형·후보 수·난이도)을 제출한다. 생성을 시작하면 검토 페이지(`?source=&run=`)로 이동해 진행률, 원본 diff·근거·검증 상태, 승인·등록을 이어간다 — 초안 비교 drawer와 편집기를 겹쳐 쓰는 검토는 dialog보다 페이지가 맞아서 남긴다. 보기 섞기는 run 없이 홈에서 원본의 풀이 panel(`?question=`)을 연다. 문제은행 상세의 '변형 출제'는 검토 페이지를 바로 연다.

## 수용 기준

### QGEN-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 확정 객관식 문제의 보기만 섞을 때 원본 문제의 연습 세션에 순서만 저장하고 신규 문제나 Heatmap 점을 생성하지 않는다.

### QGEN-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 문구 변형 초안 생성 후 원본과 diff, 근거 출처, 정답 검증 상태를 표시한다.

### QGEN-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** '틀린 것'을 '맞는 것'으로 바꿔 복수 정답이 생기면 경고하고 검증 통과 전 승인을 차단한다.

### QGEN-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 유사 개념 변형을 승인하면 원본 lineage와 문서 근거를 가진 새로운 확정 문제를 만든다.

### QGEN-01-AC05

- **Given:** 확정 문제가 있는 Workspace 홈(편집 권한)
- **When:** header의 `문제` 메뉴에서 `변형 출제`를 고르고(UX4) 원본 문제를 고른 뒤 변형 유형을 골라 "생성"
- **Then:** "문제 생성" floating dialog(`?panel=generate`)가 즉시 열려 확정 문제 목록을 보이고, 고른 문제의 생성 form을 같은 dialog에서 보인다. "생성"하면 run을 시작하고 검토 페이지(`/questions/generate?source=<id>&run=<id>`)로 이동해 그 run의 진행·초안을 보인다. 보기 섞기를 고르면 run 없이 홈에서 원본 문제의 풀이 panel이 열린다. 보기 권한(viewer)에게는 `변형 출제` 메뉴 항목이 없다(UX3c, UX4).

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
