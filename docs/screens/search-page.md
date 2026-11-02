# SEARCH-02 — 본문 검색 페이지

**상태:** 확정 화면 요구사항 v1.0 · UX9-SPEC 신규 2026-11-02 (사용자 피드백 "본문 검색을 별도의 페이지로 넣기, 홈 화면에서 버튼 눌러서 진입", 사용자 결정 2026-11-02 D2; 진입 버튼 자리 (v)는 같은 날 사용자 결정으로 header 아이콘 버튼, (w)는 제안대로)
**Route:** `/workspaces/:workspaceId/search?text=:본문검색어&mode=&document=&section=` (Workspace 홈 header의 `본문 검색` 아이콘 버튼(`이력` 앞)으로 들어가는 하위 페이지; 홈의 `?text=…`와 이전 `/workspaces/:workspaceId/search?q=…`는 이 페이지로 redirect)
**테스트:** `tests/e2e/search/search-page.spec.ts`
**Phase:** UX9.0 (RED) → UX9-SEARCH-W
**연계:** [SEARCH-01](search.md)(검색 규칙·결과·발췌 panel·문제지 제외·저하 — 그대로 이 페이지에 적용), [QOV-01](questions-overview.md)(header·하위 페이지 규칙 AC13), [DOC-02](documents-editor.md)(PDF에서 보기), [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: SEARCH-02
route: /workspaces/:workspaceId/search
actor: workspace_member (owner · editor · viewer)
permission: read
status: confirmed
api: [POST /api/v1/workspaces/:id/search, GET /api/v1/workspaces/:id/documents]
components: [PageHeader, BackLink, Breadcrumb, Input, IconButton, Popover, FloatingSidePanel(modal), EmptyState]
linked_tests: [SEARCH-02-AC01 … SEARCH-02-AC04]
```

## 목적과 정책

- **본문 검색은 홈 밖의 페이지 (사용자 결정 D2):** UX7-SEARCH의 홈 안 "본문 검색" 펼치기 영역(SEARCH-01-AC10)은 없어지고, 본문 검색은 이 하위 페이지에서만 한다. 검색 자체의 규칙 — 검색 방식(키워드/의미/하이브리드)·문서·장 설정("본문 설정" popover), Enter·검색 버튼으로 실행, 문제지 제외(UX7-SEARCH-2), 발행된 교재가 없으면 비활성, 결과 항목 → "본문 발췌" panel(SEARCH-01-AC11), "PDF에서 보기"(AC03), 빈 상태(AC04), dense 저하 안내(AC06), 서버 인가(AC05) — 은 SEARCH-01 그대로다.
- **문제 검색은 그대로 홈에:** 문제 검색 입력란(실시간 Heatmap 필터, `?q=`)과 "문제 설정" popover는 홈 header에 남는다(SEARCH-01-AC12 불변). 이 페이지에는 문제 검색이 없다.
- **진입 (사용자 결정 2026-11-02 (v) — 처음 제안(문제 검색 아래 글자 버튼)이 아님):** Workspace header 오른쪽 아이콘 묶음에서 `이력` **앞**에 `본문 검색` 아이콘 버튼(secondary `IconButton`, `SearchIcon`, 글자 없음, 접근성 이름·tooltip "본문 검색"; `이력`·`공유하기`와 같은 모양, 링크로 렌더링 `<a href>`). 문제 검색 입력란 아래의 이전 "본문 검색" 펼치기 버튼 자리는 **비운다**(없어지고 아무것도 두지 않는다 — 문제 검색 입력란과 "문제 설정"만 남음). 누르면 같은 탭에서 이 페이지로 이동하고(기록 항목 하나) route `loading.tsx` skeleton을 먼저 보인다(QOV-01-AC09). modal 홈 dialog가 열려 있으면 header가 비활성이라 누를 수 없다(HOMEDLG-01).
- **URL과 redirect:** 상태는 이 페이지의 URL `text`·`mode`·`document`·`section`이다(SEARCH-01 "상태는 URL에 둔다"의 본문 key; 검색 실행은 `replace`). 이전 주소는 이 페이지로 옮긴다(server redirect, 검색 key만 유지): 홈 `?text=…&mode=&document=&section=` → `/search?text=…`(홈의 다른 key `q`·필터·`panel`·`question`은 버림 (사용자 결정 2026-11-02)), 홈 `scope=content&q=` → `/search?text=`, 이전 `/workspaces/:id/search?q=&chapter=` → `/search?text=&section=`(UX7-SEARCH가 홈으로 보내던 것을 이제 이 페이지로).
- **돌아가기:** 페이지 header에 `BackLink` "Workspace 홈"과 breadcrumb `Workspace 이름 › 본문 검색`(현재 항목 `aria-current="page"`, 아래 제목까지 12px — QOV-01-AC13). 홈에서 들어왔으면 `BackLink`는 브라우저 뒤로가기처럼 홈의 그 주소(문제 검색어·필터 포함)로 돌아가고, 직접 들어왔으면 `/workspaces/:id`로 간다. 브라우저 뒤로가기도 같다.
- **결과에서 문서 열기:** 발췌 panel의 "PDF에서 보기"는 DOC-02(`/documents/<id>?page=<n>&block=<id>`)를 연다(AC03). DOC-02의 뒤로가기는 이 검색 페이지의 같은 검색(URL `text`로 다시 실행, 결과 목록 scroll 위치는 다시 처음)으로 돌아온다. 발췌 panel의 열림·선택 항목은 URL에 남기지 않는다(지금과 같음).
- **공유 보기:** 공유 Workspace 화면(WS-VIEW-01)의 검색 카드는 그대로다(사용자 확인 2026-11-01 "공유 화면 검색은 그대로").

## 레이아웃 및 컴포넌트

- `PageHeader`(제목 "본문 검색" `h1`, back·breadcrumb 슬롯) 아래 검색 줄: 입력란(접근성 이름 "본문 검색어", 페이지를 열면 focus — 검색어가 URL에 있으면 focus하지 않고 결과로), 아이콘 검색 버튼("검색"), "설정" 버튼("본문 설정" popover). 영역은 이름 "본문 검색"의 `search` landmark. 그 아래 "본문 검색 결과" 목록과 "검색 결과 지우기"(검색어·결과를 지움). 처음(검색어 없음)에는 안내 "교재 본문에서 찾을 말을 입력하세요."
- 결과 항목을 누르면 non-modal "본문 발췌" `FloatingSidePanel`(데스크톱 오른쪽, 결과 목록이 비켜섬; 휴대폰 bottom sheet) — SEARCH-01-AC11 그대로. **이 panel도 modal이다**(사용자 결정 2026-11-02 — 처음 제안(non-modal)과 다름, HOMEDLG-01): 열린 동안 결과 목록은 `inert`이고 결과 목록이 비켜서지 않으며(배치 고정), 다른 결과로 옮기려면 panel header의 `이전 결과`·`다음 결과` 버튼(결과 목록 순서, 끝에서는 비활성; Alt+↑/Alt+↓)으로 바꾸거나 닫고 고른다 (제안 — 사용자 확인 필요: panel header의 `이전`·`다음` 버튼과 Alt+↑/Alt+↓로 목록 순서대로 옮기고, 다른 항목을 고르려면 닫고 고름. 대안: 닫고 고르기만). 닫으면 focus는 그 결과 항목(마지막으로 본 결과)으로 가고 그 항목이 `aria-current`다.
- 반응형: 375px에서 가로 스크롤 없음, 검색 줄의 버튼은 줄바꿈 없이 입력란이 줄어든다.

## 수용 기준

### SEARCH-02-AC01

- **Given:** 확정 문제와 발행된 교재가 있는 Workspace 홈(보기 권한 멤버), 그 전에 Workspace 목록을 연 기록
- **When:** 홈 header를 보고 `본문 검색` 버튼을 click(그리고 키보드 Enter)하고, 페이지에서 검색어를 입력해 Enter를 누르고, `BackLink`를 누르고 브라우저 앞으로가기를 누른다
- **Then:** 홈 header 오른쪽 아이콘 묶음에 `이력` 바로 앞의 `본문 검색` 아이콘 버튼(글자 없음, 접근성 이름과 hover·focus tooltip "본문 검색")이 있고, 문제 검색 입력란 아래에는 아무 버튼도 없으며, 본문 검색 입력란·"본문 검색" 펼치기 버튼(`aria-expanded`)·본문 검색 결과 영역이 홈에 없다. 버튼을 누르면 `/workspaces/<id>/search`로 이동해(skeleton 먼저) 제목 "본문 검색", `BackLink`, breadcrumb `Workspace 이름 › 본문 검색`(`aria-current="page"`)과 focus된 "본문 검색어" 입력란을 보인다. 검색하면 URL에 `text`가 `replace`로 쓰이고 결과가 보인다. `BackLink`는 들어오기 전 홈 주소로 돌아가고, 앞으로가기는 같은 검색어의 결과 페이지로 돌아온다.

### SEARCH-02-AC02

- **Given:** 본문 검색 결과가 여럿 나오는 검색어가 있는 Workspace(편집 권한, 데스크톱과 휴대폰 터치)
- **When:** 검색 페이지에서 "본문 설정"으로 문서 하나를 고른 뒤 검색하고, 결과 항목의 발췌를 눌러 "본문 발췌" panel을 열고 "PDF에서 보기"를 누른 뒤 PDF 열람 페이지에서 뒤로가기를 누른다
- **Then:** 결과는 고른 문서의 발췌만이다(URL `document`). 발췌 panel이 modal로 열려(결과 목록 `inert`) 문서·쪽 위치와 표시된 검색어를 보이고(휴대폰은 bottom sheet), `다음 결과`가 다음 결과의 발췌로 바꾸며, "PDF에서 보기"는 그 PDF의 그 쪽(DOC-02 `?page=`)을 연다. 뒤로가기는 같은 검색어·같은 문서 설정의 검색 페이지와 결과로 돌아온다. 문제지는 결과·문서 필터에 없다(UX7-SEARCH-2).

### SEARCH-02-AC03

- **Given:** 발행된 교재가 있는 Workspace(Owner)
- **When:** 홈 `?text=주의&mode=keyword&q=개요&panel=history`, 홈 `?scope=content&q=주의`, 이전 `/workspaces/<id>/search?q=주의&chapter=<장>`를 각각 직접 연다
- **Then:** 셋 모두 검색 페이지로 redirect되어 그 검색을 실행한다: 첫째는 `/search?text=주의&mode=keyword`(홈의 `q`·`panel`은 버림), 둘째는 `/search?text=주의`, 셋째는 `/search?text=주의&section=<장>`. redirect된 페이지의 뒤로가기는 redirect 전 주소로 다시 가지 않는다(redirect 항목이 기록에 남지 않음).

### SEARCH-02-AC04

- **Given:** 발행된 교재가 없는(문제지만 발행된) Workspace, 그리고 다른 사용자의 Workspace id
- **When:** 검색 페이지를 열고; 다른 사용자의 Workspace 검색 페이지 URL과 검색 API를 직접 부른다
- **Then:** 검색 버튼이 비활성이고 이유 "검색할 본문이 없습니다. 문서를 먼저 등록하고 발행하세요."가 `aria-describedby`로 연결된 글자로 보인다(Enter도 검색하지 않음). 다른 사용자의 Workspace 검색 페이지는 알 수 없는 Workspace와 같은 404이고 API는 문서 내용을 주지 않는다.
