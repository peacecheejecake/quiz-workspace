# SEARCH-01 — 다국어 원문 검색

**상태:** 확정 화면 요구사항 v1.3
**Route:** `/workspaces/:workspaceId/search`
**테스트:** `tests/e2e/search/search.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- Dense / BM25 / Hybrid·RRF와 Reranker를 선택할 수 있는 검색 옵션을 제공한다. 검색 API는 server-side workspace filters와 SourceLocation(페이지·block ID·revision)을 반환한다.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

## 수용 기준

### SEARCH-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 한국어 질문으로 영어 교재에 대한 의미 검색 시 관련 영어 원문과 PDF 페이지를 표시한다.

### SEARCH-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 문서·장 필터를 선택하면 서버가 해당 범위만 검색하여 반환한다.

### SEARCH-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 검색 결과에서 발췌를 선택하면 해당 PDF 페이지와 연결된 원문을 연다.

### SEARCH-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 검색 결과가 없으면 명확한 빈 상태와 검색 수정 안내를 표시한다.

### SEARCH-01-AC05

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 다른 사용자의 Workspace 검색 API를 직접 호출해도 문서 내용이 노출되지 않는다.

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
