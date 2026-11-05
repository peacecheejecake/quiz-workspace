# DOCVIEW-01 — PDF 열람 보기 설정 (목차 panel·보기 방식·분할)

> **UX10 개정(2026-11-05):** [UX10-DOC](ux10-doc.md)의 보기 선택·전체 높이·도구 overlay 기준이 이 문서의 이전 배치 설명에 우선한다. 변경되지 않은 요구·보안 경계는 유지한다.

**상태:** 확정 화면 요구사항 v1.1 · DOCVIEW-SPEC 신규 2026-10-29 (사용자 요청 "pdf 보기 UI 개선") · DOCVIEW-PORT 2026-11-02(사용자 결정 "제 배치로 교체": DOC-02 v1.4의 목차 panel·폭 조정 구분선(DOC-02-AC06·AC10, 폐기)을 이 배치로 바꾸고 DOC-02-AC07·AC08·AC09·AC11은 유지)
**Route:** 별도 route 없음 — DOC-02 `/workspaces/:workspaceId/documents/:documentId` 화면의 배치(공유 게스트의 WS-VIEW-01 문서 보기 `/share/:shareId`도 같은 배치)
**테스트:** `tests/e2e/documents/documents-viewer-layout.spec.ts`
**Phase:** DOCVIEW.0 (RED) → DOCVIEW-PORT
**연계:** [DOC-02](documents-editor.md), [WS-VIEW-01](workspace-shared-view.md), [디자인 시스템](../design-system.md) §5·§7, [E2E 규칙](../e2e-strategy.md), 결정 [implementation-plan §7](../implementation-plan.md) (2026-10-29 DOCVIEW-SPEC, 2026-11-02 DOCVIEW-PORT)

```yaml
id: DOCVIEW-01
route: (DOC-02 화면 안) /workspaces/:workspaceId/documents/:documentId · (WS-VIEW-01 문서 보기) /share/:shareId
actor: workspace_member · share_guest
permission: read (보기 설정은 권한과 무관; 교정 UI는 DOC-02 규칙 그대로)
status: confirmed
api: []  # 보기 설정은 서버에 저장하지 않는다
components: [FloatingSidePanel(side=start, placement=docked), SplitView, IconButton, OutlineTree, PdfViewer, TextBlockEditor]
linked_tests: [DOCVIEW-01-AC01 … DOCVIEW-01-AC12]
```

## 목적과 범위

사용자 요청(2026-10-29): "목차는 floating dialog로, 화면 왼쪽, 접었다 펼칠 수 있게 / 보기 설정: pdf, 텍스트 변환본 보기 — 양쪽보기(반씩) / pdf만 / 텍스트 변환 내용만 / 드래그해서 각 view의 위치 조정(상하/좌우 split)". DOC-02의 기능(목차 → 쪽·블록 이동, 연속 스크롤 PDF와 빠른 쪽 넘김(DOC-02-AC07), PDF↔텍스트 동기화와 highlight(AC08), 쪽별 `N쪽` 묶음(AC09), 확정된 가져온 문제의 문제 카드(AC11), 변환본 교정·발행·되돌리기, 고정(pinned) revision 보기, 처리 중·실패·오류 상태)은 바꾸지 않고 **배치와 보기 설정만** 다룬다. 이 기능들은 모든 보기 방식·분할 방향·위치에서 같게 동작해야 한다.

DOCVIEW-PORT(2026-11-02): DOC-02 v1.4(PR #43)가 같은 요청 일부를 먼저 구현했다 — PDF 도구 막대의 `목차` 토글로 여는 왼쪽 floating panel(DOC-02-AC06)과 PDF·원문 사이 폭 조정 구분선(25–75%, 기본 55%, DOC-02-AC10). 사용자 결정 "제 배치로 교체"로 이 둘은 폐기하고 이 화면의 배치(보기 설정 막대, 분할 영역에 붙는 docked 목차 panel, `SplitView` 20–80%·기본 50:50)가 대신한다. 이전 브라우저 저장값(`quiz:doc02:outline`, `quiz:doc02:split`)은 읽지 않는다(그대로 무시; 지우지도 않는다).

### 용어

| 용어 | 화면 문구 | 의미 |
|---|---|---|
| 원본 | `원본` (접근성 이름 `PDF 원본만 보기`) | PDF.js 연속 스크롤 뷰어 pane. region 이름 `PDF 원본` |
| 변환본 | `변환본` (접근성 이름 `변환본 텍스트만 보기`) | canonical text pane — DOC-02의 "원문 텍스트 영역"(쪽별 묶음·문제 카드·교정). region 이름 `변환본 텍스트` |
| 함께 보기 | `함께 보기` (접근성 이름 `원본과 변환본 함께 보기`) | 원본·변환본을 한 화면에 나눠 보기 |
| 분할 방향 | `좌우` · `상하` (접근성 이름 `좌우로 나누기` · `상하로 나누기`) | 함께 보기의 나누는 축 |
| 위치 바꾸기 | `위치 바꾸기` (접근성 이름 `원본과 변환본 위치 바꾸기`) | 두 pane의 앞뒤(왼쪽/오른쪽, 위/아래) 순서 교환 |
| 크기 조절 막대 | (시각 막대) 접근성 이름 `원본과 변환본 크기 조절` | 두 pane 사이 splitter |

region 이름은 화면 문구(원본·변환본)를 담고 기존 E2E helper(`/pdf/i`, `/원문|텍스트/`)와도 맞는다. PDF region 이름에는 "원문"·"텍스트"를 넣지 않는다. DOC-02 명세의 "원문 텍스트 영역"은 이 화면의 변환본 pane이다(문제 카드의 `원문 블록 보기`처럼 블록을 가리키는 문구는 그대로).

## 레이아웃

### 데스크톱 (≥ 1024px)

- **보기 설정 막대**: `PublishBar`·안내(note/alert) 아래, 분할 영역 바로 위 한 줄. 왼쪽부터 `목차` 펼치기/접기 toggle, `보기 방식` radio group(함께 보기 · 원본 · 변환본), 함께 보기일 때만 `분할 방향` radio group(좌우 · 상하)과 `위치 바꾸기` 버튼. 이름 "보기 설정"인 `role="group"`. 선택 상태는 `aria-checked` + 선택 배경 + 굵은 글씨(색만으로 구분하지 않음, design-system §4.1). PDF 도구 막대에는 더 이상 `목차` 토글이 없다(DOC-02-AC06 폐기).
- **목차 panel**: 분할 영역의 왼쪽 위에 떠 있는 docked `FloatingSidePanel`(`side="start"`, `placement="docked"`, non-modal, glass surface·`--shadow-floating`·radius token; viewport가 아니라 화면의 분할 영역에 붙는다). 제목 `목차`(dialog 이름), 안에 기존 tree `목차`(DOC-02 v1.4처럼 별도 `nav` landmark 없음). 높이는 분할 영역과 같고 내용은 독립 scroll. 폭 `--outline-panel-width`(20rem, DOC-02 v1.4 `size="narrow"` 목차 panel과 같은 폭을 token으로).
  - 펼침: 분할 영역(원본·변환본)이 panel 폭만큼 오른쪽으로 비켜선다 — panel이 pane 내용을 가리지 않는다(Workspace 홈 dialog의 "내용이 비켜선다" 규칙과 같음).
  - 접힘: panel이 사라지고 분할 영역이 전체 폭을 쓴다. 보기 설정 막대의 `목차` toggle(`aria-expanded=false`, 접근성 이름 `목차 펼치기`)이 남는 손잡이다. 펼쳐져 있을 때 toggle 이름은 `목차 접기`, panel header의 접기 버튼(`목차 접기`)도 같은 동작.
  - 펼치기/접기는 transform+opacity `--duration-panel-enter`(reduced-motion: 즉시). Escape는 focus가 panel 안에 있을 때만 접는다(non-modal 규칙). 접으면 focus는 `목차 펼치기` toggle로, 사용자가 펼치면 focus는 tree의 현재 항목(없으면 첫 항목)으로 간다. 저장된 설정으로 펼쳐진 채 열린 페이지는 focus를 옮기지 않는다.
  - 목차 항목 선택은 panel을 닫지 않는다(데스크톱).
- **분할 영역 (`SplitView`)**:
  - 함께 보기: 두 pane과 그 사이 크기 조절 막대. 좌우면 앞 pane이 왼쪽, 상하면 위. 기본 순서는 원본 → 변환본.
  - 원본 / 변환본: 해당 pane 하나가 분할 영역 전체를 쓰고 막대·다른 pane은 보이지 않는다. 숨은 pane은 **unmount하지 않고** `hidden`으로 둔다(교정 중 입력, PDF 문서·그려 둔 쪽 cache·zoom, 텍스트 scroll 위치 유지; PDF를 다시 내려받지 않는다).
  - 각 pane 위에 pane header(제목 `원본`/`변환본` `h2` + 함께 보기일 때 끌기 손잡이). 기존 PDF toolbar(쪽·zoom)와 변환본 내용(쪽별 묶음·문제 카드)은 그 아래 그대로.
- **크기 조절 막대**: `role="separator"`, focus 가능(`tabindex=0`), `aria-orientation` = 좌우 분할이면 `vertical`, 상하면 `horizontal`, `aria-valuenow` = 앞 pane 비율(정수 %), `aria-valuemin`/`aria-valuemax` = 허용 범위, `aria-valuetext` = "원본 60%, 변환본 40%", `aria-controls` = 앞 pane. 시각 선은 1px `--color-border`이고 hit 영역은 24px 이상(coarse pointer 44px), hover/focus-visible/drag 중 강조(굵기 + grip 모양; 색만이 아님).
  - pointer(mouse·touch·pen, Pointer Events + `touch-action: none`) drag로 비율 변경, 놓으면 저장.
  - 키보드: 좌우 분할에서 ←/→, 상하 분할에서 ↑/↓ = 5%p, Home = 앞 pane 최소, End = 앞 pane 최대, Enter = 50:50. 반대 축 화살표는 무시(스크롤 방해 안 함).
  - 더블클릭(touch는 double-tap) = 50:50.
  - 최소 크기: 각 pane은 20% 이상이면서 좌우 320px·상하 200px 이상. 분할 영역이 두 최소값의 합보다 작으면 비율은 50:50으로 그리고 막대는 움직이지 않는다(`aria-disabled`은 쓰지 않고 valuemin = valuemax = 50).
  - drag 중 PDF는 쪽 자리(placeholder)만 새 폭을 따르고 이미 그린 canvas를 늘려 보이며, 새 폭으로 다시 그리는 것은 놓은 뒤 한 번이다(DOC-02-AC07의 cache·보이는 쪽 우선 규칙 그대로). drag 중 text 선택이 생기지 않게 한다.
- **비율의 의미**: 저장되는 값은 **원본 pane의 비율**이다. 위치를 바꾸면 각 pane이 자기 크기를 가지고 자리를 바꾼다(원본 60%면 바꾼 뒤에도 원본 60%, `aria-valuenow`는 새 앞 pane인 변환본의 40). 분할 방향을 바꿔도 비율은 같다.
- **위치 바꾸기** (필수, 사용자 결정 2026-10-29): 함께 보기에서 좌우·상하 모두 동작.
  - `위치 바꾸기` 버튼(키보드 경로): 누르면 두 pane 순서가 바뀌고 focus는 버튼에 남으며 live region에 "변환본이 왼쪽, 원본이 오른쪽에 있습니다"(상하면 위·아래)를 알린다.
  - pane header 끌기: 각 pane header의 손잡이(접근성 이름 `원본 위치 옮기기`/`변환본 위치 옮기기`, button)를 pointer로 잡아 다른 pane 쪽으로 끌면, 끄는 동안 놓을 자리(다른 pane)에 점선 테두리 + "여기에 놓아 위치 바꾸기" 문구가 보이고, 그 pane 위(또는 막대를 넘어서)에서 놓으면 위치가 바뀐다. 다른 곳에서 놓거나 Escape를 누르면 취소(변화 없음). 손잡이를 키보드로 Enter/Space 하면 `위치 바꾸기`와 같다. 끄는 동안 pane은 반투명 미리보기로만 움직이고 실제 배치는 놓을 때 한 번 바뀐다.
  - 위치를 바꿔도 pane은 다시 mount되지 않는다(PDF 문서·그린 쪽·텍스트 scroll·교정 입력 유지).
  - reduced-motion이 아니면 바뀌는 배치는 `--duration-state`로 짧게 전환, reduced-motion에서는 즉시.

### 태블릿 (768–1023px)

- 보기 방식·분할 방향·위치 바꾸기·크기 조절은 데스크톱과 같다(저장된 설정 사용).
- 목차 panel은 분할 영역 위에 **겹쳐** 뜬다(내용이 비켜서지 않음; 폭이 부족). PDF·변환본을 가리므로 불투명 surface(`--color-glass-solid`, blur 없음)이다. 이 폭에서는 저장된 목차 펼침 여부와 무관하게 접힌 채 시작하고, 목차 항목을 고르면 panel이 접힌다. 이 폭에서의 펼치기/접기는 저장하지 않는다.

### 좁은 화면 (< 768px)

- 한 번에 한 pane만 보인다. 보기 설정 막대는 `원본 | 변환본` 전환(이름 "보기 선택", segmented 버튼, `aria-pressed`)과 `목차` 버튼만 보인다. 함께 보기·분할 방향·위치 바꾸기·크기 조절 막대는 없다. DOC-02 v1.4의 `PDF | 원문` 전환을 대신한다.
- 처음 보이는 pane: 저장된 보기 방식이 `변환본`이면 변환본, 그 밖(함께 보기·원본)이면 원본. 이 화면에서 바꾼 전환은 저장하지 않는다(저장된 데스크톱 설정을 덮지 않음).
- `목차` 버튼은 목차 panel을 `mobileLayout="full"`(full-height, safe-area inset)로 연다. 목차 항목을 고르면 panel이 닫히고 원본 pane이 그 쪽을 보인다(기존 동작: 목차 → PDF). 변환본 블록을 누르면 기존처럼 원본으로 전환된다.

### 폭이 바뀔 때

- 창 크기·회전으로 구간이 바뀌면 그 구간 규칙으로 즉시 다시 배치한다. 좁은 화면 → 데스크톱으로 돌아오면 저장된 설정(함께 보기·비율 등)이 그대로 돌아온다. 교정 중 입력·현재 쪽·선택 블록은 유지된다.
- 화면 높이: 분할 영역은 viewport에서 페이지의 나머지(제목·안내·보기 설정 막대·아래 여백)가 쓰고 남은 높이를 채워 페이지 자체는 스크롤되지 않는다(pane만 스크롤; 최소 높이 28rem, 좁은 화면 24rem). 공유 화면처럼 옆에 다른 열(sidebar)이 있어도 그 열의 높이는 분할 영역 높이에 영향을 주지 않는다.

## 설정 저장 (이 브라우저)

- 저장 위치: `localStorage` key `quiz.documentViewer.v1`, 값 JSON `{ "mode": "both"|"pdf"|"text", "orientation": "horizontal"|"vertical", "order": "pdf-first"|"text-first", "pdfRatio": 20…80, "outlineOpen": true|false }`. 사용자 결정 2026-10-29: "이 브라우저에 기억".
- 기본값(저장값 없음): 함께 보기 · 좌우 · 원본 먼저 · 50:50 · 목차 펼침(데스크톱).
- 문서·Workspace·계정과 무관한 **이 브라우저 전체의 한 설정**이다(어느 문서를 열어도, 공유 링크 문서 보기에서도 같은 설정). 개인 데이터나 문서 정보는 담지 않는다.
- 서버·URL에 보내지 않는다: 설정 변경은 API 요청을 만들지 않고 주소(`?page=&block=` 등 기존 query)도 바꾸지 않는다. 다른 기기·브라우저와 동기화하지 않는다. 같은 브라우저의 이미 열린 다른 탭은 즉시 바뀌지 않고 다음 로드부터 따른다.
- 읽기·쓰기는 모두 try/catch. 저장소를 쓸 수 없거나(사생활 보호 모드·차단) 값이 깨졌거나 알 수 없는 필드·범위 밖 값이면 그 필드만 기본값으로 쓰고 오류를 보이지 않는다(`pdfRatio`는 20…80으로 clamp). 저장 실패 시에도 현재 페이지에서는 바꾼 설정대로 동작한다.
- 비율은 drag를 놓을 때·키 입력 때 저장한다(drag 중 매 frame 저장하지 않음).
- SSR: 서버는 기본 배치로 렌더하지 않고(깜빡임 방지) 설정을 읽기 전까지 분할 영역을 skeleton으로 둔다; 첫 client render에서 저장값을 읽어 한 번에 배치한다.

## 기존 동작과의 관계

- 목차 → 쪽·블록 이동(DOC-02-AC01): 모든 보기 방식에서 현재 쪽과 선택 블록 상태를 갱신한다. 함께 보기는 둘 다, 원본은 PDF 쪽 이동 + highlight, 변환본은 해당 블록으로 scroll + 현재 블록 표시. 보기 방식을 바꾸면 그때의 쪽·블록이 바로 보인다.
- 빠른 쪽 넘김(DOC-02-AC07): 원본은 화면을 열 때 한 번 받은 PDF.js 문서 하나를 연속 스크롤로 보인다. 보기 방식·분할 방향·위치·목차 펼침을 바꿔도 다시 내려받거나 문서를 다시 열지 않고, 그려 둔 쪽 cache를 유지한다(pane 폭이 바뀌면 그 폭으로 한 번 다시 그린다).
- PDF ↔ 텍스트 동기화(DOC-02-AC08): 함께 보기(좌우·상하, 어느 순서든)에서 PDF를 스크롤하거나 쪽을 넘기면 변환본이 그 쪽 묶음으로 따라가고, 변환본 블록을 누르면 원본이 그 쪽으로 가서 highlight한다. 원본만·변환본만 볼 때도 현재 쪽과 선택 블록은 계속 갱신된다(동기화 상태 유지). **숨었던 pane을 다시 보이면 그때의 현재 쪽·블록으로 바로 맞춘다**: 원본은 현재 쪽(선택 블록이 있으면 그 위치 highlight)으로, 변환본은 선택 블록(없으면 현재 쪽 묶음)으로 scroll한다. 블록을 편집하는 중에는 변환본을 움직이지 않는다(DOC-02 규칙). 변환본만 볼 때 블록을 누르면 선택만 바뀌고 보기 방식은 바뀌지 않는다(좁은 화면만 원본으로 전환).
- 쪽별 묶음·문제 카드(DOC-02-AC09·AC11): 변환본 pane 안의 내용이라 어느 배치에서나 같다(`N쪽` 묶음과 현재 쪽 `aria-current="page"`, 접힌 `정답·해설 보기`, `원문 블록 보기`).
- 교정(DOC-02-AC02~AC05): 편집 UI·권한 규칙은 그대로. 원본만 보기로 바꿔도 편집 중 블록의 입력은 유지되고 되돌아오면 그대로 이어서 저장할 수 있다. 발행·되돌리기·고정 revision note·처리 중/실패 안내는 보기 방식과 무관하게 분할 영역 위에 보인다. 처리 중·실패 문서도 보기 설정 막대와 목차 panel이 있고, 변환본 pane은 처리 안내를, 목차 panel은 "목차를 불러오는 중"/빈 상태를 보인다.
- 공유 게스트(WS-VIEW-01 문서 보기): 같은 배치·보기 설정·저장 규칙, 교정 UI 없음.

## 수용 기준

### DOCVIEW-01-AC01

- **Given:** 함께 보기 설정이 저장된 브라우저(데스크톱 1280px)에서 처리 완료 교재 문서의 DOC-02 화면
- **When:** 화면을 연다
- **Then:** 왼쪽에 이름 `목차`인 목차 panel이 펼쳐져 있고(toggle `목차 접기`, `aria-expanded=true`), 원본과 변환본 checkbox가 모두 선택되어 원본(`PDF 원본` region)이 왼쪽·변환본(`변환본 텍스트` region)이 오른쪽에 같은 폭(크기 조절 막대 `aria-valuenow=50`, 실제 폭 차이 ≤ 2px)으로 보이며, 목차 panel의 영역은 두 pane과 겹치지 않는다.

### DOCVIEW-01-AC02

- **Given:** DOCVIEW-01-AC01의 화면
- **When:** `목차 접기`를 누르고, 다시 `목차 펼치기`를 누르고, panel 안에서 Escape를 누르고, 펼친 뒤 목차의 절을 고른다
- **Then:** 접으면 panel이 사라지고 `목차 펼치기` toggle(`aria-expanded=false`)만 남으며 두 pane이 넓어지고(50:50 유지), 펼치면 focus가 tree 항목으로 가고, Escape는 panel을 접고 focus를 toggle로 돌리며, 절을 고르면 panel은 열린 채 PDF가 그 쪽으로 이동하고 변환본의 해당 블록이 현재 블록으로 표시된다(DOC-02-AC01 동작). `prefers-reduced-motion: reduce`에서는 펼치기·접기 전환 시간이 0이다.

### DOCVIEW-01-AC03

- **Given:** 처리 완료 문서의 DOC-02 화면(함께 보기)
- **When:** checkbox로 원본만, 변환본만, 둘 다를 차례로 고르고, `변환본`일 때 목차의 절을, `원본`일 때 다른 절을 고른다
- **Then:** `원본`이면 `PDF 원본` region만, `변환본`이면 `변환본 텍스트` region만 보이고 크기 조절 막대·`분할 방향`·`위치 바꾸기`는 보이지 않으며, 선택한 checkbox는 checked 상태이다. `변환본`에서 고른 절은 해당 블록으로 scroll되어 현재 블록이 되고, `원본`에서 고른 절은 PDF 쪽(현재 페이지 입력값)이 바뀐다. `함께 보기`로 돌아오면 마지막으로 고른 절의 쪽과 블록이 양쪽에 함께 보인다.

### DOCVIEW-01-AC04

- **Given:** owner가 함께 보기에서 변환본 블록을 편집 중이며 저장하지 않은 입력이 있다
- **When:** `원본`으로 바꿨다가 `함께 보기`로 돌아와 저장한다
- **Then:** 돌아왔을 때 입력과 편집 상태가 그대로이고, 저장하면 DOC-02-AC02처럼 새 draft revision이 생기며 PDF 원본은 바뀌지 않는다. 같은 문서를 보기 권한자로 열면 같은 보기 방식들을 쓸 수 있고 어느 방식에서도 편집 UI는 없다.

### DOCVIEW-01-AC05

- **Given:** 함께 보기·좌우 분할의 DOC-02 화면(데스크톱)
- **When:** 크기 조절 막대를 pointer로 오른쪽으로 끌고, 오른쪽 끝 너머까지 끌고, 막대를 더블클릭한다
- **Then:** 끄는 만큼 원본이 넓어지고 변환본이 좁아지며 `aria-valuenow`·`aria-valuetext`("원본 n%, 변환본 m%")가 따라 바뀌고, 끝 너머로 끌어도 각 pane은 최소 크기(20%이자 320px 이상) 아래로 줄지 않으며, 더블클릭하면 50:50으로 돌아온다. 끄는 동안 텍스트가 선택되지 않는다.

### DOCVIEW-01-AC06

- **Given:** 함께 보기 화면에서 크기 조절 막대에 키보드 focus가 있다(좌우 분할, 그다음 상하 분할)
- **When:** →, ←, End, Home, Enter를 누르고, 상하 분할로 바꾼 뒤 ↓, ↑, → 를 누른다
- **Then:** 좌우에서 →는 원본 비율 +5, ←는 −5, End는 최대, Home은 최소, Enter는 50으로 `aria-valuenow`와 pane 크기가 바뀐다. 상하에서는 막대의 `aria-orientation=horizontal`이고 ↓/↑가 ±5로 바뀌며 →는 아무것도 바꾸지 않는다. 막대의 focus 표시는 `qz-focus-ring` 규칙을 따른다.

### DOCVIEW-01-AC07

- **Given:** 함께 보기·좌우·원본 60%인 화면
- **When:** `분할 방향`에서 `상하`를 고르고, 다시 `좌우`를 고른다
- **Then:** 상하에서는 원본이 위·변환본이 아래에 원본 60% 높이로 보이고 막대는 `aria-orientation=horizontal`이며, 좌우로 돌아오면 원본 왼쪽 60% 폭으로 돌아온다. 현재 쪽·선택 블록은 유지된다.

### DOCVIEW-01-AC08

- **Given:** 함께 보기·좌우·원본 60%인 화면
- **When:** `위치 바꾸기` 버튼을 키보드(Enter)로 누르고, `상하`로 바꾼 뒤 다시 누른다
- **Then:** 좌우에서는 변환본이 왼쪽·원본이 오른쪽이 되고 원본은 여전히 60%(막대 `aria-valuenow=40`)이며 focus는 버튼에 남고 live region이 새 배치를 알린다. 상하에서 다시 누르면 원본이 위·변환본이 아래로 돌아온다(원본 60% 유지). DOC-02의 동기화(블록 클릭 → 원본 쪽 이동·highlight)는 바뀐 배치에서도 동작한다.

### DOCVIEW-01-AC09

- **Given:** 함께 보기·좌우(원본 먼저)인 화면, 그리고 상하 분할인 같은 화면
- **When:** 원본 pane header의 `원본 위치 옮기기` 손잡이를 pointer로 잡아 변환본 pane 위로 끌어 놓고; 다시 끌다가 Escape를 누르고; 상하 분할에서 변환본 손잡이를 원본 위로 끌어 놓는다
- **Then:** 끄는 동안 놓을 자리에 "여기에 놓아 위치 바꾸기" 문구와 점선 테두리가 보이고, 놓으면 두 pane 위치가 바뀐다(원본 오른쪽). Escape로 취소하면 배치가 바뀌지 않는다. 상하에서 놓으면 변환본이 위로 간다. `pointerType: touch`로 끌어도 같은 결과다.

### DOCVIEW-01-AC10

- **Given:** 사용자가 보기 방식 `변환본`·분할 방향·위치·비율·목차 접힘을 바꾼 브라우저
- **When:** 다시 로드하고, 같은 Workspace의 다른 문서를 열고, 함께 보기·`상하`·변환본 먼저·원본 35%·목차 접힘으로 바꾼 뒤 다시 로드한다
- **Then:** 다시 로드·다른 문서에서도 마지막 설정이 그대로 적용된다(목차 접힘 포함). 설정을 바꾸는 동안 `/api/` 요청이 하나도 없고 주소의 query는 바뀌지 않으며, 설정은 `localStorage`의 `quiz.documentViewer.v1`에만 있다. 저장값이 깨진 JSON이거나 범위 밖(`pdfRatio: 5`, 알 수 없는 `mode`)이면 오류 없이 해당 값만 기본값(또는 20으로 clamp)으로 화면이 열리고, `localStorage` 접근이 예외를 던져도 기본 배치로 열리고 설정을 바꿀 수 있다.

### DOCVIEW-01-AC11

- **Given:** 함께 보기·상하·변환본 먼저로 저장된 브라우저, 좁은 화면(390px 폭, touch)과 태블릿 폭(834px)
- **When:** 좁은 화면에서 문서를 열고 `변환본`으로 전환한 뒤 `목차` 버튼으로 panel을 열어 절을 고르고; 태블릿 폭에서 같은 문서를 열어 목차를 펼치고 절을 고른 다음; 데스크톱 폭으로 돌아온다
- **Then:** 좁은 화면에서도 두 pane이 상하로 함께 보이고 크기 조절 막대가 있다. `분할 방향`·`위치 바꾸기`는 없다. 목차는 full-height panel로 열리고 절을 고르면 닫히며 원본이 그 쪽을 보인다. 태블릿 폭에서는 상하·변환본 먼저 배치가 적용되고 목차는 접힌 채 시작해 펼치면 pane 위에 겹쳐 뜨고 절을 고르면 접힌다. 데스크톱으로 돌아오면 저장된 설정(함께 보기·상하·변환본 먼저)이 그대로이다(모바일 분할 방향과 비율은 데스크톱 설정을 덮어쓰지 않음).

### DOCVIEW-01-AC12

- **Given:** 유효한 공유 링크로 WS-VIEW-01에서 문서를 연 로그인하지 않은 게스트(저장된 설정 없음)
- **When:** 두 checkbox를 선택하고 목차를 접고, `원본`·`함께 보기`를 고르고, `위치 바꾸기`·크기 조절 막대 키보드 조작을 한 뒤 다시 로드한다
- **Then:** DOC-02와 같은 목차 panel·보기 방식·분할·위치 바꾸기가 동작하고 다시 로드해도 설정이 유지되며, 어느 배치에서도 교정·발행 UI는 없다. 설정을 바꾸는 동안 API 요청이 없다.

## 폐기된 DOC-02 AC (DOCVIEW-PORT 2026-11-02)

| AC | 처리 | 대신 |
|---|---|---|
| DOC-02-AC06 PDF 도구 막대 `목차` 토글·왼쪽 floating panel·펼침 상태 기억 | 폐기 (사용자 결정 "제 배치로 교체") | DOCVIEW-01-AC01(기본 펼침·비켜섬)·AC02(접기·펼치기·Escape·절 선택)·AC10(펼침 상태 기억)·AC11(태블릿 겹침·좁은 화면 full panel) |
| DOC-02-AC10 PDF·원문 폭 조정 구분선(25–75%, 기본 55%) | 폐기 (같은 결정) | DOCVIEW-01-AC05(pointer·최소 크기·더블클릭)·AC06(키보드)·AC10(비율 기억; 20–80%, 기본 50) |

## 품질 suite (구현 후, DOCVIEW-PORT)

- axe `A11Y-16`(`tests/e2e/quality/a11y-docview.spec.ts`, light/dark): DOC-02 데스크톱 기본(목차 펼침·함께 보기·좌우), 원본만, 상하 분할, 목차 접힘, 좁은 화면(390px) 목차 panel 열림.
- visual `VISUAL-08`(`tests/e2e/quality/visual.spec.ts`, light/dark, desktop·iPad): 기본 배치에 목차 펼침(데스크톱 docked inset, iPad는 겹쳐 뜬 overlay) `document-viewer-outline-open`, 목차 접힘 `document-viewer-outline-collapsed`, 상하·변환본 먼저 `document-viewer-vertical-text-first`. 기존 `VISUAL-04`(document editor) baseline은 새 배치로 재생성한다(고정 Linux renderer).
- 번호: 이전 계획(DOCVIEW-SPEC)의 `A11Y-13`·`VISUAL-07`은 develop에서 각각 UX7-DEDUP(A11Y-13)과 MOCK-SYNC의 예약(A11Y-14·A11Y-15·VISUAL-07, implementation-plan §7 2026-11-02)이 먼저 썼으므로 다음 빈 번호 `A11Y-16`·`VISUAL-08`을 쓴다.

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고(`DOCVIEW-01-AC05 …`) RED를 확인한 다음 UI를 구현한다. 요소는 role/이름(한국어·영어 regex: `/함께 보기|both/i`, `/원본|original|pdf/i`, `/변환본|converted|text/i`, `/위치 바꾸기|swap/i`, `/크기 조절|resize/i`)으로 찾는다.
- 저장값은 `page.addInitScript`로 `localStorage`를 미리 채우거나 비워 시작한다(브라우저 context마다 독립; 다른 test와 공유하지 않음). 저장소 예외는 init script로 `Storage.prototype.getItem/setItem`을 throw하게 해서 만든다.
- 크기·위치는 `boundingBox()`로 비교한다(허용 오차 2px). mouse drag는 `page.mouse`로, touch drag는 Playwright에 touch 끌기 API가 없으므로 `pointerType: 'touch'` pointer 이벤트 순서(down → move → up)로 만든다. 폭은 test별 viewport(`test.use`)로 정한다.
- 단위 테스트(Vitest): 설정 parse/clamp/기본값, 비율 ↔ 위치 바꾸기 계산, 키보드 step, 최소 크기 계산, `SplitView` separator ARIA.
- DOC-02(남은 AC01–AC05·AC07–AC09·AC11)·WS-VIEW-01·SEARCH-01(검색 hit → 문서) E2E는 기본 설정에서 바뀌지 않고 GREEN이어야 한다.
