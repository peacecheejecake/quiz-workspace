# DOC-01 — Documents 목록·PDF 업로드

**상태:** 확정 화면 요구사항 v1.3
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
- **Then:** PDF가 없는 활성 Workspace에서 빈 상태와 업로드 버튼을 제공한다.

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
