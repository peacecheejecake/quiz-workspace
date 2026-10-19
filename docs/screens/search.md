# SEARCH-01 — 통합 검색 (문제·다국어 원문)

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (Workspace header 통합 검색)
**Route:** `/workspaces/:workspaceId?q=:query` (Workspace 홈 header; 이전 `/workspaces/:workspaceId/search?…`는 `scope=content`로 redirect)
**테스트:** `tests/e2e/search/search.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- Dense / BM25 / Hybrid·RRF와 Reranker를 선택할 수 있는 검색 옵션을 제공한다. 검색 API는 server-side workspace filters와 SourceLocation(페이지·block ID·revision)을 반환한다.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- "검색 방식"(키워드/의미/하이브리드) 선택지의 설명은 Tooltip으로 보여 준다(hover·키보드 focus, `aria-describedby` 유지, hover 없는 기기는 인라인; UX1 2026-10-19, design-system.md §4.1).
- query embedding을 쓸 수 없으면 키워드(BM25) 결과로 계속 검색하고 비차단 안내를 표시한다(AC06).

## 통합 검색 (UX3c 2026-10-20)

- 문제 검색과 원문(내용) 검색을 하나로 합친 검색창이 Workspace 홈 header 맨 위에 있다. 입력란(접근성 이름 "검색어") + 검색 아이콘 버튼(접근성 이름 "검색", 글자 없음). Enter도 검색한다.
- 검색창 아래 작은 글씨 "검색 옵션" 버튼이 tooltip처럼 붙어 뜨는 검색 옵션 popover를 토글한다(`aria-expanded`; Escape·바깥 클릭으로 닫힘, focus는 버튼으로 복귀). Popover 내용:
  - **검색 대상** 체크박스 `문제`·`내용`(기본 둘 다 = 모두). 최소 하나는 켜져 있어야 하며 마지막 하나는 끌 수 없다.
  - **내용 검색**: 검색 방식(키워드/의미/하이브리드, 설명 tooltip), 문서·장 필터, "문제지 PDF도 검색".
  - **문제 필터**: 챕터, 유형.
  - 옵션을 바꾸면 마지막 검색에 바로 적용된다.
- 검색 대상 `문제`: 홈의 문제 Heatmap을 검색어로 거른다(기존 QOV-01 검색). `내용`: header 아래 "원문 검색 결과" 영역에 결과 목록과 발췌 panel(AC01~AC06)이 나타나고, "검색 결과 닫기"로 검색어를 지우고 문제 화면으로 돌아간다. 모두: 둘 다.
- 상태는 URL에 둔다: `q`, `scope`(`questions`|`content`, 생략 = 모두), 원문 검색 `mode`·`document`·`section`(장)·`papers=1`, 문제 필터 `chapter`·`type`·`status`·`favorite`·`retry`. 새로 고침·뒤로가기·공유 링크로 같은 검색을 다시 연다. 이전 `/search?q=&mode=&document=&chapter=&papers=1`은 `scope=content`와 `section=`(← `chapter`)으로 옮겨 redirect한다.

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

### SEARCH-01-AC07

- **Given:** 확정 문제와 발행된 문서가 있는 Workspace 홈
- **When:** header의 통합 검색창에 검색어를 입력하고 검색 아이콘 버튼(또는 Enter)으로 검색하고, "검색 옵션"으로 검색 대상 체크박스를 바꿈
- **Then:** 검색 버튼은 아이콘만 보이고 접근성 이름은 "검색"이다. "검색 옵션" 버튼은 검색 대상(문제·내용 체크박스, 최소 하나), 검색 방식, 문서·장 필터와 문제 챕터·유형 필터를 담은 popover를 열고 닫는다(`aria-expanded`). 대상이 모두면 Heatmap이 검색어로 걸러지고 원문 검색 결과 영역도 나타난다. `문제`만이면 원문 결과 영역이 없고, `내용`만이면 Heatmap은 거르지 않은 채 원문 결과만 나타난다. 검색 상태(`q`, `scope`, 옵션)는 URL에 남아 새로 고침해도 같은 결과를 보이며, "검색 결과 닫기"는 검색어와 원문 결과를 지운다(UX3c).

### SEARCH-01-AC06

- **Given:** 문서가 색인된 Workspace에서 query embedding(dense) 공급자를 일시적으로 쓸 수 없는 상태(hosted embedder 장애·quota 초과·timeout; 테스트는 `APP_ENV=test` 실패 marker로 재현)
- **When:** 하이브리드 또는 의미 검색을 실행
- **Then:** 검색은 실패(503)하지 않고 BM25 키워드 결과만 반환하며, API 응답은 `degraded: ["dense_unavailable"]`을 담고, 화면은 결과 위에 차단하지 않는 안내 "의미 검색을 일시적으로 사용할 수 없어 키워드 결과만 표시합니다"를 `role="status"`(텍스트, 색만으로 구분하지 않음)로 표시한다. 정상 상태의 같은 검색에는 안내도 `degraded`도 없다.

## 검색 저하(dense 불가) 규칙 (M7.4b)

- 적용 범위: query를 embedding하는 단계의 장애만(`EmbeddingUnavailableError`: hosted embedder의 429·5xx·timeout·연결 실패·quota 초과). Qdrant 자체 장애는 기존대로 503.
- `hybrid`: BM25 목록만으로 결과(점수 유형 `bm25`). `semantic`: 같은 BM25 결과로 대체(의미 검색 결과가 아님을 안내 문구로 알린다). `keyword`: 영향 없음.
- 응답 `degraded`는 저하 코드 목록(현재 `dense_unavailable`만). `warnings`와 별개로, 클라이언트는 코드로 판단한다.
- 서버는 WARNING 로그 한 줄(예외 type과 code만)을 남기고 검색어·문서 원문·token은 남기지 않는다.
- 공유 보기(`WS-SHARE-VIEW`)의 검색도 같은 API 경로를 쓰므로 같은 응답 필드를 받는다.

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
