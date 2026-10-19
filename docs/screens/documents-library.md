# DOC-01 — Documents 목록·PDF 업로드

**상태:** 확정 화면 요구사항 v1.3 · UX1·UX2 개정 2026-10-19
**Route:** `/workspaces/:workspaceId/documents`
**테스트:** `tests/e2e/documents/documents-library.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태별 Empty/Loading/Failure/Success UI, 반응형 Layout과 Floating Side Panel, 접근성 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

## 수용 기준

### DOC-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** PDF가 없는 활성 Workspace에서 빈 상태와 업로드 버튼을 제공한다. 업로드 버튼은 빈 상태 안의 CTA 하나뿐이며, 빈 상태가 보이는 동안 페이지 헤더(우측 상단)의 "PDF 업로드"는 숨긴다. 문서(업로드 중 포함)가 있거나 목록을 불러오지 못했을 때는 헤더 버튼을 표시한다(UX1 2026-10-19). 업로드할 수 있으면 빈 상태의 설명 문구는 끌어다 놓기 안내("PDF 파일을 이 영역에 끌어다 놓아도 업로드할 수 있습니다.", 끌어 오는 동안 "놓으면 업로드를 시작합니다.") 하나이며, 빈 상태가 보이는 동안 목록 위의 별도 안내 줄은 두지 않는다. 문서가 있으면 같은 안내를 목록 위에 표시한다(UX2 2026-10-19).

### DOC-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 정상 PDF 업로드를 완료하면 parser/index 작업 진행률과 READY 상태가 표시된다.

### DOC-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 미지원 형식 및 허용 크기 초과는 프론트와 서버 모두에서 거부하고 사유를 제공한다.

### DOC-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 네트워크 중단 시 재개 가능한 업로드를 지원하며 재시도로 중복 문서를 생성하지 않는다.

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
