# WS-01 — Workspace 목록·관리

**상태:** 확정 화면 요구사항 v1.3 · 2026-10-16 · UX1 개정 2026-10-19
**Route:** `/workspaces`
**연계 E2E:** `tests/e2e/workspaces/overview.spec.ts`

## 목적·레이아웃
- Next.js App Router 기반, 모바일/데스크톱 반응형 레이아웃과 Minimal Glass 디자인 시스템을 사용한다.
- 상태: 최초 로딩, 입력 검증, 처리 중, 성공, 실패, 빈 데이터, 권한 오류, 세션 만료를 명시적으로 처리한다.
- 입력 컴포넌트에 필수 라벨·설명·에러를 연결하고 키보드와 스크린리더에 대한 접근성을 보장한다.
- Supabase Auth를 사용하되 인증 경계와 리소스 인가는 FastAPI가 재검증한다.

- Workspace 이름(목록 항목·switcher)은 Workspace 홈 `/workspaces/:workspaceId`(QOV-01)로 간다. 활성/보관됨 탭은 이미 받은 두 목록 사이를 서버 왕복 없이 바로 바꾼다(UX3c 2026-10-20).
- 헤더는 제목 "Workspace"만 두고 설명 문구는 두지 않는다. 활성/보관됨 탭의 개수는 원형 badge 없이 탭 이름 옆 숫자 텍스트로 표시하며 탭의 접근성 이름에 포함된다(예: "활성 2"). (UX1)

## 수용 기준

### WS-01-AC01

- **Given:** Workspace가 없는 로그인 사용자에게 빈 상태와 생성 CTA를 보여준다.
- **When:** 해당 조작·라우트 접근 또는 서버 API 요청
- **Then:** Workspace가 없는 로그인 사용자에게 빈 상태와 생성 CTA를 보여준다. 생성 버튼은 빈 상태 안의 CTA 하나뿐이며, 활성 탭이 빈 상태를 보이는 동안 페이지 헤더(우측 상단)의 "Workspace 만들기"는 숨긴다. 활성 Workspace가 있거나 보관됨 탭을 볼 때는 헤더 버튼을 표시한다(UX1 2026-10-19).

### WS-01-AC02

- **Given:** 새 Workspace를 만들면 자신이 Owner가 되고 Active 목록에 표시된다.
- **When:** 해당 조작·라우트 접근 또는 서버 API 요청
- **Then:** 새 Workspace를 만들면 자신이 Owner가 되고 Active 목록에 표시된다.

### WS-01-AC03

- **Given:** Archive한 Workspace는 Archived 탭으로 이동하고 쓰기 API가 거부된다.
- **When:** 해당 조작·라우트 접근 또는 서버 API 요청
- **Then:** Archive한 Workspace는 Archived 탭으로 이동하고 쓰기 API가 거부된다.

### WS-01-AC04

- **Given:** Soft delete 후 목록에서 제거하고 과거 URL 직접 접근을 차단한다.
- **When:** 해당 조작·라우트 접근 또는 서버 API 요청
- **Then:** Soft delete 후 목록에서 제거하고 과거 URL 직접 접근을 차단한다.

### WS-01-AC05

- **Given:** 다른 사용자의 Workspace ID 직접 API 접근은 서버에서 거부된다.
- **When:** 해당 조작·라우트 접근 또는 서버 API 요청
- **Then:** 다른 사용자의 Workspace ID 직접 API 접근은 서버에서 거부된다.

### WS-01-AC06

- **Given:** Owner가 공유 메뉴를 선택하면 WS-SHARE-01 설정으로 이동하며 타인은 설정 API에 접근할 수 없다.
- **When:** 해당 조작·라우트 접근 또는 서버 API 요청
- **Then:** Owner가 공유 메뉴를 선택하면 WS-SHARE-01 설정(Workspace 홈의 링크 공유 dialog, `?panel=share` — UX3c)으로 이동하며 타인은 설정 API에 접근할 수 없다.

## E2E-first 구현 규칙
- 해당 AC ID를 Playwright 시나리오로 먼저 작성하고 기대된 RED 실패를 확인한 뒤 구현한다.
- 성공/실패/권한 차단 결과는 실제 서버 응답에서도 보장되어야 하며 화면 조건만으로 대체하지 않는다.
