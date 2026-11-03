# SEARCH-01 — 문제 검색·다국어 본문 검색

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (Workspace header 통합 검색) · UX4 개정 2026-10-21 (검색 옵션 단일 목록) · UX6 개정 2026-10-28 (문제·본문 검색 범위 분리와 on/off) · UX7-SELECT 개정 2026-11-01 (터치로 연 Select의 현재 항목 탭) · UX7-SEARCH 개정 2026-11-01 (문제·본문 검색창 분리, 본문 검색 접힘, 결과 항목 → 주변 내용 panel, 문제 실시간 필터) · UX7-SEARCH-2 개정 2026-11-01 (문제지는 문제 검색에서만: 본문 검색에서 제외) · UX7-BACK-2 개정 2026-11-01 (dialog가 열린 동안 바꾼 본문 검색어는 그 dialog를 닫는 뒤로가기 뒤에도 남음, AC09) · UX9-SPEC 개정 2026-11-02 (본문 검색을 별도 페이지로 — [SEARCH-02](search-page.md); 문제 검색은 홈에 그대로)
**Route:** `/workspaces/:workspaceId?q=:문제검색어` (Workspace 홈 header의 문제 검색) · 본문 검색은 `/workspaces/:workspaceId/search?text=:본문검색어` ([SEARCH-02](search-page.md), UX9; 홈의 `?text=…`와 이전 `/workspaces/:workspaceId/search?q=…`는 그 페이지로 redirect)
**테스트:** `tests/e2e/search/search.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- Dense / BM25 / Hybrid·RRF와 Reranker를 선택할 수 있는 검색 옵션을 제공한다. 검색 API는 server-side workspace filters와 SourceLocation(페이지·block ID·revision)을 반환한다.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- "검색 방식"(키워드/의미/하이브리드) 선택지의 설명은 Tooltip으로 보여 준다(hover·키보드 focus, `aria-describedby` 유지, hover 없는 기기는 인라인; UX1 2026-10-19, design-system.md §4.1).
- query embedding을 쓸 수 없으면 키워드(BM25) 결과로 계속 검색하고 비차단 안내를 표시한다(AC06).

## 본문 검색 페이지로 이동 (UX9-SPEC 2026-11-02)

사용자 피드백 "본문 검색을 별도의 페이지로 넣기, 홈 화면에서 버튼 눌러서 진입"(사용자 결정 D2). 본문 검색은 홈 안의 펼치기 영역이 아니라 하위 페이지 `/workspaces/:workspaceId/search`([SEARCH-02](search-page.md))에서 하고, 홈 header의 "본문 검색" 펼치기 버튼은 없어지고 그 자리는 비운다; 그 페이지로 가는 입구는 header 오른쪽 아이콘 묶음의 `본문 검색` 아이콘 버튼(`이력` 앞, 사용자 결정 2026-11-02 (v))이다. 아래 UX7-SEARCH의 본문 검색 규칙(설정·실행·문제지 제외·비활성·결과 항목 → 발췌 panel·URL key)은 **그 페이지에서 그대로** 적용되고, "펼치기·접기·header 아래 전체 폭·홈 URL의 `text`"에 관한 문장만 SEARCH-02로 바뀐다. 문제 검색(실시간 필터, AC12)·"문제 설정"(AC08)은 홈에 그대로다. **GREEN AC 처리(이 repo의 개정 규칙):** phase M3.0이 CI에서 GREEN이므로 명세 커밋(UX9-SPEC)은 AC를 지우거나 새 AC를 SEARCH-01에 더하지 않았다. 새 동작의 AC는 SEARCH-02(phase UX9.0)에 있고, 구현 Task UX9-SEARCH-W(2026-11-03)가 (1) AC10(본문 검색 접힘)을 test와 함께 아래 "폐기된 AC" 표로 옮겼고(대신 SEARCH-02-AC01), (2) AC01~AC04·AC06·AC11·AC13의 test 진입을 홈 펼치기 영역에서 검색 페이지로 바꿨으며(AC 내용은 그대로), (3) AC09의 "본문 검색 입력란이 홈 header에 있음" 부분을 "홈 header에는 `본문 검색` 링크, 입력란은 SEARCH-02 페이지"로 고쳤다(아래 각 AC의 UX9 표시). 이전 주소의 장 필터(`/search?q=&chapter=`)는 문서 없이도 `section`으로 남아 그 장에서만 검색한다(SEARCH-02-AC03; API는 `chapter_ids`만으로도 범위를 건다). 결과 영역의 "검색 결과 닫기"는 SEARCH-02 문구대로 "검색 결과 지우기"가 되었다.

## 문제 검색·본문 검색 (UX7-SEARCH 2026-11-01)

사용자 요청(2026-11-01): "문제, 본문 검색 창 분리 — 본문 검색: 기본적으로 접혀있음, '본문 검색 결과'에서 개별 항목을 클릭하면 오른쪽에 키워드를 포함한 주변 내용이 보이도록 / 문제 검색: 키워드 입력 → 문제 필터링 → 키워드 변화에 따라(enter 혹은 검색 버튼 없이) 실시간으로 필터링 결과 변화하도록". 이전 통합 검색창(UX3c)과 검색 범위 체크박스 `문제`·`본문`(UX6)은 없다(SEARCH-01-AC07 폐기, 아래 "폐기된 AC").

- **두 개의 검색 입력.** Workspace 홈 header 왼쪽에 **문제 검색** 입력란(접근성 이름 "문제 검색", `type="search"`)이 있고, 그 아래에 **본문 검색** 펼치기 버튼이 있다. 두 입력은 값·상태·URL key가 서로 독립이다(한쪽에 입력해도 다른 쪽은 바뀌지 않는다). 검색 범위 체크박스는 없다.
- **문제 검색 (실시간 필터).** 입력란 옆에 작은 글씨 텍스트 버튼 "설정"(접근성 이름 "문제 설정")이 있고 Radix Popover "문제 검색 설정"(Heatmap의 챕터·유형 필터)을 연다(클릭·탭·키보드 Enter/Space, `aria-expanded`, Escape·바깥 클릭으로 닫히면 focus는 버튼으로). 검색 버튼은 없다. 입력이 바뀌면 Enter나 버튼 없이 Heatmap이 그 검색어로 걸러진다(QOV-01 검색, 서버의 문제 본문 부분 일치):
  - 마지막 입력 후 250ms 동안 더 입력이 없으면 서버에서 Heatmap을 다시 읽는다(debounce). 입력란은 입력 즉시 글자를 보이며, 다시 읽는 동안 입력한 글자나 caret 위치가 바뀌거나 사라지지 않는다. 다시 읽는 동안 Heatmap은 `aria-busy`와 "문제를 불러오는 중입니다." 상태 문구를 보인다.
  - 늦게 도착한 이전 검색어의 응답은 무시한다: 화면에는 항상 마지막 검색어의 결과가 남는다.
  - 한글 IME 조합 중(`compositionstart`~`compositionend`)에는 거르지 않고, 조합이 끝나면(`compositionend`) 그 값으로 거른다(조합 중인 자모로 Heatmap이 비었다 돌아오는 깜빡임이 없다).
  - URL `q`는 검색어를 따라 `replace`로 바뀐다(입력할 때마다 방문 기록이 쌓이지 않는다). 검색어를 지우면 `q`가 빠지고 Heatmap 전체가 보인다. 앞뒤 공백만 다른 검색어는 같은 검색어다. 최대 200자(QOV-01 API 한도).
  - 측정 결과 (UX7-SEARCH, 로컬 stack, 확정 문제 100개): 마지막 입력부터 Heatmap 갱신까지 debounce 250ms를 포함해 중앙값 313ms(Chromium)·322ms(WebKit), 범위 289~455ms(서버 다시 읽기 자체는 약 40~200ms). 이미 읽은 데이터를 브라우저에서 거르면 100개 0.01ms 미만·2000개 약 0.2ms로 빠르지만, 화면에 있는 문제 데이터는 문제 본문의 앞 1~3줄(`preview`)뿐이라 서버 검색(본문 전체 부분 일치)과 같은 결과를 낼 수 없다(API 변경 필요). 그래서 debounce한 서버 다시 읽기를 쓴다.
  - Workspace에 확정 문제가 하나도 없으면 입력란은 `disabled`이고 바로 아래 상태 메시지(`role="status"`, 텍스트) "검색할 문제가 없습니다. 문제를 먼저 등록하세요."가 보이며 입력란의 `aria-describedby`가 그 메시지를 가리킨다. 문제 수를 불러오지 못했으면 있다고 본다(막지 않는다).
- **본문 검색 (기본 접힘).** 문제 검색 아래의 펼치기 버튼 "본문 검색"(위/아래 화살표 아이콘, `aria-expanded`, `aria-controls`; Heatmap의 "상태 필터" 펼치기 버튼과 같은 모양)이 header 아래, Heatmap 위의 본문 검색 영역을 펼치고 접는다. 처음 열면 접혀 있다. URL에 본문 검색어(`text`)가 있으면(새로 고침·뒤로가기·PDF에서 돌아오기·공유 링크·이전 `/search` 경로) 펼친 채로 열고 그 검색을 다시 실행한다. 펼치면 focus는 본문 검색 입력란으로 간다. 펼치기 버튼은 문제 검색창 바로 아래, 펼친 내용은 header 아래 전체 폭이다(사용자 확인 2026-11-01: 제안대로 유지).
  - 펼친 영역: 입력란(접근성 이름 "본문 검색어") + 검색 아이콘 버튼(접근성 이름 "검색", 글자 없음; 영역은 이름이 "본문 검색"인 `search` landmark) + "설정" 버튼(접근성 이름 "본문 설정", popover "본문 검색 설정": 검색 방식(키워드/의미/하이브리드, 설명 tooltip)·문서·장). 본문 검색은 서버 검색 API를 부르므로 실시간이 아니라 Enter나 검색 버튼으로 실행한다. 바꾼 설정은 마지막 검색에 바로 적용된다. 그 아래 "본문 검색 결과"(결과 목록, AC01~AC06)와 "검색 결과 닫기"(본문 검색어와 결과를 지운다; 영역은 펼친 채 남는다).
  - 접으면 입력한 검색어·결과·설정은 남고 보이지만 않는다(발췌 panel은 닫힌다). 다시 펼치면 그대로 보인다(사용자 확인 2026-11-01).
  - **문제지는 본문 검색에 없다 (UX7-SEARCH-2, 사용자 결정 2026-11-01 "question paper는 '문제' 검색에서만").** 문제지(`document_type = question_paper`) PDF는 본문 검색 대상이 아니다: 문제지의 내용은 등록된 문제로 `문제` 검색(Heatmap)에서 찾는다. 서버 검색 API가 문제지를 항상 범위에서 뺀다 — 요청이 `document_ids`·`chapter_ids`로 문제지를 지정해도 그 문서는 결과가 없다(발행본이 없는 문서와 같다; 404가 아니다). 그래서 결과 수와 순위는 문제지가 없는 것과 같다(화면에서 숨기지 않는다). 이전 요청 필드 `include_question_papers`는 받아들이지만 무시한다(deprecated). 토글도 없고, "본문 설정"의 문서 필터에도 문제지는 나오지 않는다. 발행된 문서가 문제지뿐이면 본문 검색할 것이 없다(아래 비활성화 규칙). UX7-SEARCH의 "문제지 항상 포함" 제안은 기각되었다.
  - 교재+문제(`mixed`, `document_type = book`) 문서는 교재로 검색된다(documents-library.md). 그 안의 문제 부분만 빼는 것은 색인에 문제 구간 표시가 없어 지금은 하지 않는다(미결; 구현 계획 §7).
  - 발행본이 있는 교재(교재+문제 포함; 문제지는 세지 않는다)가 없으면 검색 버튼은 `disabled`이고(Enter도 검색하지 않는다) 상태 메시지 "검색할 본문이 없습니다. 문서를 먼저 등록하고 발행하세요."가 보이며 버튼의 `aria-describedby`가 가리킨다. 처리 중이라 발행본이 없는 문서는 세지 않는다. 문서 목록을 불러오지 못했으면 있다고 본다.
- **결과 항목 → 주변 내용 panel.** "본문 검색 결과"의 항목 아무 곳(문서 제목·위치·발췌)을 클릭하거나 탭하면 오른쪽에 non-modal `FloatingSidePanel` "본문 발췌"가 열려 그 항목의 문단 단위 발췌 전체(목록은 4줄로 줄여 보인다)를 위치(breadcrumb·쪽)와 함께 보인다. 키보드는 항목의 제목 버튼(Tab으로 이동, Enter/Space)으로 같은 일을 한다. 발췌에서 일치한 구절은 밑줄+배경, 검색어는 굵게 표시해 색만으로 구분하지 않으며, panel이 열리면 첫 검색어가 보이도록 스크롤한다. 선택한 항목은 테두리와 `aria-current`로 표시한다. 다른 항목을 누르면 panel 내용이 그 항목으로 바뀐다. 데스크톱에서는 panel 옆으로 결과 목록이 비켜서고, 휴대폰 폭에서는 기존 bottom sheet로 뜬다. panel의 "PDF에서 보기"는 AC03 그대로다. 이전에는 문서 제목 버튼만 panel을 열어 발췌 문단을 눌러도 아무 일이 없었다(UX7-SEARCH에서 확인).
- **상태는 URL에 둔다:** 문제 검색 `q`, 본문 검색 `text`·`mode`·`document`·`section`(장), 문제 필터 `chapter`·`type`·`status`·`favorite`·`retry`. 새로 고침·뒤로가기·공유 링크로 같은 검색을 다시 연다. 본문 검색을 실행하면 `text` 등을 `replace`로 쓴다. 이전 URL은 redirect로 옮긴다: `/search?q=&mode=&document=&chapter=` → 홈 `?text=&mode=&document=&section=`; 홈의 `scope=content&q=` → `text=`; 다른 `scope` 값(`questions`, `none`)은 지우고 `q`는 문제 검색어로 둔다; 이전 `papers` 값은 무시한다.
- 검색 API(`POST /workspaces/:id/search`)는 본문(문서 chunk)만 검색한다: 문제 검색은 Heatmap(`questions/overview?q=`)이 맡는다. 서버 인가 규칙은 그대로다.
- 공유 보기(WS-VIEW-01)의 검색은 원래 본문 검색만 있고 설정이 없는 카드이므로 접지 않고 그대로 둔다. 결과 항목 아무 곳이나 눌러 발췌 panel을 여는 규칙은 같이 적용된다(사용자 확인 2026-11-01: 공유 화면 검색은 그대로). 공유 보기 검색도 같은 서버 범위 규칙을 쓰므로 문제지는 검색되지 않는다(공유 보기는 원래 문제지를 넣으라고 요청한 적이 없어 화면 동작은 바뀌지 않는다).

### 폐기된 AC

| AC | 처리 | 대신 |
|---|---|---|
| SEARCH-01-AC07 통합 검색창·검색 범위 체크박스 `문제`·`본문`과 "설정" popover, 범위별 검색 버튼 비활성화 | 폐기 (UX7-SEARCH 2026-11-01, 검색창 분리) | SEARCH-01-AC09(두 입력·설정·비활성화·URL), AC10(본문 검색 접힘, 아래에서 폐기), AC11(결과 항목 → 주변 내용 panel), AC12(문제 실시간 필터) |
| SEARCH-01-AC10 홈의 "본문 검색" 펼치기 영역: 처음엔 접힘(`aria-expanded="false"`, `aria-controls`), 누르면 펼쳐지고 focus가 입력란으로, 다시 누르면 접혀도 검색어·결과 유지, URL `text`가 있으면 펼친 채 열고 검색 | 폐기 (UX9-SEARCH-W 2026-11-03, 본문 검색이 페이지로 옮김 — 사용자 결정 D2; test도 함께 지움) | [SEARCH-02-AC01](search-page.md)(홈 header `본문 검색` 아이콘 링크 → 검색 페이지, 입력란 focus), SEARCH-02-AC03(이전 홈 `?text=` 주소 → 검색 페이지) |

## 수용 기준

### SEARCH-01-AC01

> **UX9-SPEC 2026-11-02:** AC01~AC04·AC06의 본문 검색은 검색 페이지(SEARCH-02)에서 한다 — 내용 불변, test 진입은 UX9-SEARCH-W가 검색 페이지로 바꿨다(AC13의 본문 검색 부분도).

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 한국어 질문으로 영어 교재에 대한 의미 검색 시 관련 영어 본문과 PDF 페이지를 표시한다.

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

### SEARCH-01-AC06

- **Given:** 문서가 색인된 Workspace에서 query embedding(dense) 공급자를 일시적으로 쓸 수 없는 상태(hosted embedder 장애·quota 초과·timeout; 테스트는 `APP_ENV=test` 실패 marker로 재현)
- **When:** 하이브리드 또는 의미 검색을 실행
- **Then:** 검색은 실패(503)하지 않고 BM25 키워드 결과만 반환하며, API 응답은 `degraded: ["dense_unavailable"]`을 담고, 화면은 결과 위에 차단하지 않는 안내 "의미 검색을 일시적으로 사용할 수 없어 키워드 결과만 표시합니다"를 `role="status"`(텍스트, 색만으로 구분하지 않음)로 표시한다. 정상 상태의 같은 검색에는 안내도 `degraded`도 없다.

### SEARCH-01-AC08

- **Given:** Workspace 홈 문제 검색 옆의 "문제 설정" popover("문제 검색 설정")를 연 휴대폰(iPhone Safari, 터치) 화면
- **When:** `챕터` Select를 탭해 목록을 열고, 목록 맨 위의 현재 선택 항목(기본 "전체 챕터")을 한 번 탭함
- **Then:** 첫 탭에 목록이 닫히고(`aria-expanded="false"`) 선택값과 URL 필터는 그대로이며 popover는 열린 채 남는다. 탭한 항목의 pointerup은 취소되지 않는다(iOS Safari는 취소된 터치 pointerup의 click을 보내지 않는다; design-system.md §4.1 "열린 목록의 현재 항목은 닫기"). 다른 항목을 탭하면 그 값으로 바뀐다(UX7-SELECT 2026-11-01).

### SEARCH-01-AC09

> **UX9-SPEC 2026-11-02 (UX9-SEARCH-W에서 반영):** 본문 검색 입력란·"본문 설정"·검색 버튼은 SEARCH-02 페이지에 있고 홈 header에는 `본문 검색` 링크가 있다. 두 검색이 서로 독립이라는 내용·비활성 규칙·URL 복원은 그대로(본문 검색 key는 그 페이지 URL). 아래 문구와 test를 그에 맞췄다. **UX9-MODAL(HOMEDLG-01):** 홈 dialog가 modal이라 dialog가 열린 동안에는 본문 검색어를 바꿀 수 없다 — "dialog가 열린 동안 바꾼 검색어가 dialog를 닫는 뒤로가기 뒤에도 남음" 단계는 test에서 "dialog를 연 채 뒤로가기로 닫으면 검색어가 그대로이고, 그 뒤 새 검색이 기록 항목의 검색어를 고쳐 씀"으로 바뀌었다.

- **Given:** 확정 문제와 발행된 문서가 있는 Workspace 홈과 그 본문 검색 페이지(SEARCH-02)(비활성화 경우는 문제나 발행된 문서가 없는 Workspace)
- **When:** 홈 header의 문제 검색 입력란과 검색 페이지의 본문 검색 입력란을 각각 쓰고, 각 "설정" 버튼으로 상세 설정을 바꾸고, 새로 고침·뒤로가기를 함
- **Then:** 검색 범위 체크박스와 "검색 옵션" 버튼은 없고 문제 검색("문제 검색", 홈 header)과 본문 검색("본문 검색어", 아이콘만 있는 검색 버튼 "검색"; 검색 페이지)이 서로 다른 입력란이며, 홈 header에는 본문 검색 입력란 대신 검색 페이지로 가는 `본문 검색` 링크가 있다. 한쪽에서 검색해도 다른 쪽 값·결과는 바뀌지 않는다: 문제 검색어는 Heatmap만 거르고(홈 URL `q`), 본문 검색어는 본문 검색 결과만 바꾼다(검색 페이지 URL `text`) — 검색 페이지에서 돌아온 홈의 문제 검색어와 Heatmap은 그대로다. "문제 설정"(popover "문제 검색 설정": 챕터·유형)은 문제 검색 옆, "본문 설정"(popover "본문 검색 설정": 검색 방식·문서·장)은 본문 검색 옆에 있고 클릭과 키보드로 열고 닫는다(`aria-expanded`, Escape로 닫히면 focus 복귀). "문제지 PDF도 검색" 토글은 없다. 확정 문제가 없으면 문제 검색 입력란이, 발행된 교재가 없으면(문제지만 있어도) 본문 검색 버튼이 비활성화되고 그 이유를 `aria-describedby`로 연결된 상태 메시지로 보인다. 두 검색 상태는 각 페이지의 URL에 남아 새로 고침과 뒤로가기(PDF 열람에서 돌아오기 포함)가 그 기록 항목의 검색어·결과를 되살리고(홈 dialog는 modal이라 dialog가 열린 동안에는 문제 검색어를 바꿀 수 없다 — HOMEDLG-01), "검색 결과 지우기"는 본문 검색어와 결과만 지운다. 이전 `scope=content&q=` URL, 홈의 `text=`와 `/search?q=`는 검색 페이지의 `text=`로 redirect한다(SEARCH-02-AC03).

### SEARCH-01-AC11

> **UX9-SPEC 2026-11-02:** 같은 동작이 본문 검색 페이지(SEARCH-02)에서 일어난다("Workspace 홈" → "본문 검색 페이지"; UX9-SEARCH-W가 test 진입을 바꿨다). 사용자 결정 2026-11-02: "본문 발췌" panel은 **modal**이다 — "non-modal"·"결과 목록이 비켜섬"·"다른 항목을 누르면 panel 내용이 바뀜"은 "modal, 결과 목록 `inert`, 배치 고정, panel의 `다음 결과`/`이전 결과`(제안)로 바뀜, 닫으면 그 항목으로 focus"가 된다. UX9-MODAL이 이 AC의 test를 고친다.

- **Given:** 본문 검색 결과가 여러 개 있는 Workspace 홈(데스크톱, 그리고 휴대폰 터치 화면)
- **When:** 결과 항목의 발췌 문단(제목이 아닌 곳)을 클릭·탭하거나, 키보드로 항목의 제목 버튼에 가서 Enter를 누름
- **Then:** 오른쪽(휴대폰은 bottom sheet)에 non-modal "본문 발췌" panel이 열려 그 항목의 발췌 전체를 문서·쪽 위치와 함께 보이고, 검색어는 `<mark>`로 굵게(일치 구절은 밑줄) 표시되어 색만으로 구분하지 않는다. 선택한 항목은 `aria-current`로 표시되고, 다른 항목을 누르면 panel 내용이 그 항목으로 바뀐다. 마우스·키보드·터치가 같은 결과를 낸다(UX7-SEARCH).

### SEARCH-01-AC12

- **Given:** 확정 문제 여러 개가 있는 Workspace 홈
- **When:** 문제 검색 입력란에 검색어를 입력·수정·삭제함(Enter·버튼 없이), 한글 IME로 조합하며 입력함
- **Then:** 입력이 멈추면(250ms debounce) Enter나 버튼 없이 Heatmap이 그 검색어로 걸러지고, 검색어를 바꾸거나 지우면 결과도 따라 바뀐다. 빠르게 이어 입력해도 입력란의 글자와 caret 위치는 그대로이고, 화면에는 마지막 검색어의 결과만 남는다(늦게 도착한 이전 응답은 무시). URL `q`는 `replace`로 바뀌어 입력해도 방문 기록이 늘지 않는다. IME 조합 중(`compositionstart` 뒤 `compositionend` 전)에는 거르지 않고, 조합이 끝나면 그 값으로 거른다(UX7-SEARCH).

### SEARCH-01-AC13

> **UX9-SPEC 2026-11-02:** 본문 검색 부분은 검색 페이지(SEARCH-02)에서, 문제 검색(Heatmap) 부분은 홈에서 확인한다.

- **Given:** 발행된 교재와 발행된 문제지(같은 검색어가 둘 다에 있음)가 있는 Workspace 홈, 그리고 발행된 문서가 문제지뿐인 Workspace 홈
- **When:** 본문 검색을 실행하고 "본문 설정"의 문서 필터를 열며, 검색 API를 문제지를 지정해(`document_ids`, `include_question_papers: true`) 직접 호출함
- **Then:** 본문 검색 결과에는 교재의 발췌만 있고 문제지의 결과는 없다(서버가 범위에서 빼므로 결과 수도 교재만큼이다). 문서 필터 목록에는 교재만 있고 문제지와 "(문제지)" 표시는 없다. API는 문제지를 지정해도 문제지 결과를 돌려주지 않는다(`document_type`이 `question_paper`인 항목이 없다). 발행된 문서가 문제지뿐이면 본문 검색 버튼이 비활성화되고 "검색할 본문이 없습니다…" 이유를 보인다. 문제 검색(Heatmap)은 그대로 문제를 거른다(UX7-SEARCH-2).

## 검색 저하(dense 불가) 규칙 (M7.4b)

- 적용 범위: query를 embedding하는 단계의 장애만(`EmbeddingUnavailableError`: hosted embedder의 429·5xx·timeout·연결 실패·quota 초과). Qdrant 자체 장애는 기존대로 503.
- `hybrid`: BM25 목록만으로 결과(점수 유형 `bm25`). `semantic`: 같은 BM25 결과로 대체(의미 검색 결과가 아님을 안내 문구로 알린다). `keyword`: 영향 없음.
- 응답 `degraded`는 저하 코드 목록(현재 `dense_unavailable`만). `warnings`와 별개로, 클라이언트는 코드로 판단한다.
- 서버는 WARNING 로그 한 줄(예외 type과 code만)을 남기고 검색어·문서 원문·token은 남기지 않는다.
- 공유 보기(`WS-SHARE-VIEW`)의 검색도 같은 API 경로를 쓰므로 같은 응답 필드를 받는다.

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
