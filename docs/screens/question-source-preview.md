# QSRC-01 — 문제 원문 보기 (문제 PDF 영역 미리보기)

**상태:** 화면 요구사항 v1.0 (사용자 결정 2026-11-04) · QSRC-SPEC 신규 2026-11-04 (사용자 요청 "문제에 이미지가 포함된 경우 사용자가 볼 수 있어야 한다 — 범위가 작은 방식으로", 선택한 방식 "문제 원문 보기 버튼 — hover·focus·long-press는 tooltip 미리보기, click은 새 floating dialog")
**Route:** 별도 route 없음(URL을 바꾸지 않는다). QuestionViewer(QVIEW-01) 안의 버튼과 그 버튼이 여는 dialog: `practice`(풀이 panel, `?question=`)·`sequence(bank)`(범위 풀이, `?practice=`)·`manage`("문제 상세" dialog)·모의고사 문제(`sequence(mock)`·`manage(mock)`).
**테스트:** `tests/e2e/questions/question-source-preview.spec.ts` (계약: `tests/integration/questions/source_region/test_source_region_contract.py`)
**Phase:** QSRC.0 (RED) → QSRC-API (계약 C01~C05) → QSRC-UI (AC01~AC06 중 등록 문제·풀이 panel·문제 상세·범위 풀이) → QSRC-W (모의고사 문제·CI phase 켬)
**연계:** [QVIEW-01](question-viewer.md), [QPLAY-01](questions-practice.md), [QIMPORT-01](questions-import.md)(`원본 비교`), [MOCK-01](mock-exams.md), [DOC-02](documents-editor.md), [WS-VIEW-01](workspace-shared-view.md), [Questions 명세](../questions.md) §16, [디자인 시스템](../design-system.md) §5.6, [E2E 규칙](../e2e-strategy.md), [UX12-SRCMENU](ux12-source-menu.md)(더보기 메뉴의 `원문 보기`)

```yaml
id: QSRC-01
route: (URL 불변) QuestionViewer 안 — /workspaces/:workspaceId?question=:questionId | ?practice=:runId | "문제 상세" dialog | 모의고사 풀이·상세
actor: workspace_member (보기 권한 이상)
permission: read
status: confirmed
api: [GET /api/v1/questions/:id/source-region, GET /api/v1/mock-exam-questions/:id/source-region, GET /api/v1/documents/:id/source-url (기존 PDF 중계)]
components: [Button, Tooltip, FloatingSidePanel, PdfRegionView]
linked_tests: [QSRC-01-AC01 … QSRC-01-AC06]
```

## 목적과 정책

가져온 문제 PDF의 문제에는 그림처럼 글로 옮겨지지 않은 부분이 있다. 표는 UX12부터 발문 안 표로 보이지만([QTABLE-01](question-tables.md)) 병합 셀 등 인쇄 모양까지 옮기지는 못한다. 풀이 화면은 글과 표만 보이므로 사용자가 나머지를 볼 수 없다. 이 화면은 문제의 **PDF 원문 영역**을 풀이 화면 옆에서 볼 수 있게 한다. 새 기능을 최소로 하기 위해 기존 부품(`PdfViewer`·`/documents/:id/source-url` 중계·`FloatingSidePanel`)만 쓰고 새 migration·저장 데이터는 없다.

- **버튼:** 문제 본문 부품 header(번호·유형 badge가 있는 줄) 끝의 글자 버튼 `문제 원문 보기`(아이콘만 아님; `aria-label`도 같음). 제출 **전과 후** 모두 보인다(사용자 결정 2026-11-04 2).
- **PDF로 열리는 때(UX12 DOCS-3):** 정답이 이미 보이는 화면의 dialog는 잘린 영역 대신 PDF 전체를 그 영역에서 연다. 제출 전 문제는 아래 규칙 그대로다. 기준은 [UX12-PDFPREVIEW](ux12-pdf-preview.md).
- **더보기 메뉴(UX12 VIEW-4):** 풀이 panel과 범위 풀이의 더보기 메뉴에도 같은 dialog를 여는 `원문 보기`가 있다. 본문 버튼은 그대로 둔다. 기준은 [UX12-SRCMENU](ux12-source-menu.md).
- **무엇을 보이는가 — 문제 자기 영역만 (사용자 결정 2026-11-04 1):** 그 문제의 가져오기 출처(`question_sources`의 `import_run_id`가 있는 행) 위치들(`locations`) 중 **문제 자기 블록의 위치(`block_id`가 없는 첫 근거)** bbox 합집합으로 자른 부분만 보인다(쪽마다 합집합 하나, C06). 쪽 이동·확대 후 스크롤·다른 쪽 보기가 **없다**. "해설 포함" PDF는 같은 쪽 아래나 뒤쪽에 정답·해설이 있으므로, 영역 밖은 어떤 방법으로도 보이지 않는다. 영역이 두 쪽에 걸치면 두 쪽의 잘린 부분을 위아래로 쌓아 보이고 각 부분에 쪽 표시(`p.1`)를 붙인다. 자르는 크기는 bbox 그대로다(여백을 더하지 않는다 — 여백이 다음 문제나 정답으로 넘어갈 수 있음).
- **어디에 (사용자 결정 2026-11-04 3):** 풀이 panel(`practice`)과 범위 풀이(`sequence(bank)`), "문제 상세" dialog(`manage`, 보관 문제 포함), 가져오기 출처가 있는 원본 문제에서 만든 `보기 섞기`(`OPTION_SHUFFLE`) 모의고사 문제(`sequence(mock)`·`manage(mock)`). AI 변형 모의고사 문제(`PARAPHRASE` 등 — 글이 원본과 다름)에는 절대 없다(사용자 결정 2026-11-04 7). **없는 곳:** 공유 링크 게스트(`read-only`), 가져오기 출처가 없는 문제 — 직접 만든 문제, 생성된 문제, 교재 근거(`evidence`·책 출처)만 있는 문제, bbox가 없는 출처만 있는 문제, **출처 PDF 문서가 삭제된(`documents.deleted_at`, `DELETE /documents/:id`) 문제** — 문제는 남지만 그 문서는 어디서나 404이므로 "출처 없음"과 같이 숨긴다(사용자 결정 2026-11-04 5). 문서의 원본 PDF는 불변이고 모든 revision이 같은 원본을 쓰므로(documents.sql) 저장된 `document_revision_id`의 쪽·bbox는 문서의 지금 원본에 그대로 맞는다 — revision이 바뀌어도 영역은 같고 따로 검사하지 않는다. 이때 버튼은 **숨긴다**(비활성으로 두지 않는다). 교재 근거 출처는 정답이 든 쪽을 가리키므로 절대 보이지 않는다.
- **영역 정보 API는 정답을 알려 주지 않는다:** `GET /questions/:id/source-region`은 문서 id·revision id·쪽·bbox만 돌려준다. 발문·보기·정답·해설·출처 글·블록 id가 없고, 풀이 session이 필요 없다(제출 전에도 같은 응답). 풀이 DTO(QPLAY-01-AC01)는 바뀌지 않는다. PDF 자체는 기존 `GET /documents/:id/source-url` 중계(구성원 누구나, `SignedUrlCache` + `loadPdfBytes`)로 받는다 — 이 화면이 새로 여는 권한은 없다(문서 PDF는 이미 구성원에게 열림). 따라서 "정답이 보이지 않는다"는 보장은 **화면 수준**이다: 잘린 영역 밖의 글·그림은 DOM·canvas 어디에도 그려지지 않는다.
- 원문을 보는 것은 풀이·열람이 아니다(풀이 기록·Heatmap 상태 불변).
- **불러오는 시점:** 영역 정보(작은 JSON)는 풀이 화면이 문제를 보일 때 요청해 버튼 표시 여부를 정하고, PDF(`/documents/:id/source-url` 중계)는 hover·focus·long-press·click으로 처음 원문을 열 때 받는다(아래 "화면 상태"의 `확인 중`). **UX12 EXTRACT-7(D-11):** 문제에 그림(`figures`)이 있으면 그림 영역이 화면에 들어올 때도 같은 중계로 받아 보기 위에 그린다. 그림이 없는 문제는 전처럼 버튼 뒤에서만 PDF를 받는다. 기준은 [UX12-REEXTRACT](ux12-reextract.md).

## 레이아웃 및 컴포넌트

- **버튼 표시 시점:** 풀이 화면이 열리면 영역 정보를 한 번 요청한다(문제당, 위치를 옮기면 그 문제 것). 응답 200이면 버튼이 나타나고, 404면 버튼은 나타나지 않는다(자리를 비워 두지 않음 — 줄 배치가 달라지지 않는다). 영역 정보는 정답이 없으므로 `practice`·`sequence`의 session cache(UX7-CACHE)에 넣어도 된다.
- **tooltip (사용자 결정 2026-11-04 5):** hover(데스크톱), keyboard focus(`:focus-visible`), long-press(터치, 500ms)로 열린다. 내용: 영역 그림(쪽마다 잘린 부분을 쌓음, 최대 폭 `min(360px, 100vw - 32px)`·높이 320px — 크면 비율을 지켜 줄임)과 쪽 표시. 불러오는 중에는 `role="status"` "원문을 불러오는 중입니다", 실패하면 "원문을 불러오지 못했습니다"(재시도는 dialog에서). `role="tooltip"`이고 버튼이 `aria-describedby`로 가리킨다. 닫기: 포인터가 버튼과 tooltip을 모두 벗어남, blur, **Escape(tooltip만 닫고 panel은 그대로)**, 터치에서는 **tooltip 바깥을 누르면** 닫힌다(그 tap은 tooltip만 닫고 아래 내용 — backdrop 포함 — 에 전달되지 않는다). long-press로 연 뒤 손가락을 떼어도 click으로 취급하지 않는다(dialog가 열리지 않음). 짧은 tap은 click이다.
- **dialog (click/Enter/Space):** 이름 "문제 원문"인 `FloatingSidePanel`(`role="dialog"`), header에 제목과 `닫기`. 내용은 tooltip과 같은 영역 그림을 dialog 폭에 맞춰 크게(쪽 표시 포함), 쪽 이동·scroll 도구·검색·다운로드·"PDF 열기" 링크가 없다. 불러오는 중·실패(`role="alert"` "원문을 불러오지 못했습니다" + `다시 시도`)를 보인다.
  - **나란히 배치(viewport ≥ 868px):** 열려 있는 문제 panel의 **왼쪽**에 놓는다 — `FloatingSidePanel side="start"`, 문제 panel은 그대로 보이고 가려지지 않는다. 폭은 `--floating-panel-width` 이하, 최소 320px. 868px = 문제 panel 500px + 오른쪽 여백 16px + 사이 간격 16px + dialog 최소 320px + 왼쪽 여백 16px.
  - **전체 화면 sheet(viewport < 868px — 좁은 화면 < 768px(기존 `FloatingSidePanel` 모바일 breakpoint)과 두 panel이 들어갈 자리가 없는 태블릿 폭, 사용자 결정 2026-11-04 4·6):** 전체 화면 sheet(`mobileLayout="full"`)로 문제 panel을 덮는다. header의 `닫기`로 닫으면 문제 panel로 돌아온다(문제 panel의 위치·고른 답·scroll 유지).
  - 문제 panel(풀이 panel·범위 풀이)이 modal이므로 원문 dialog도 같은 modal 층의 맨 위에 쌓인다(design-system §5.5): 열린 동안 문제 panel은 보이지만 `inert`이고, Escape·backdrop click은 원문 dialog만 닫는다(다음 Escape가 문제 panel을 닫는다 — 맨 위부터 닫기 규칙). 문제 panel의 이전·다음·`다시 풀기`·제출은 원문 dialog를 닫은 뒤에 쓴다. 문제 위치를 바꾸면(이전·다음) 열려 있던 원문 dialog는 닫혀 있다(원문은 위치마다 다시 연다).
- **focus 순서:** 열면 focus가 dialog(제목 또는 `닫기`)로 간다. 닫으면(닫기·Escape·backdrop·좁은 화면의 Back) focus가 `문제 원문 보기` 버튼으로 돌아온다. 좁은 화면에서 브라우저 Back은 sheet만 닫고(sheet를 연 history 항목 하나를 쓴다 — URL은 바뀌지 않는다) 문제 panel은 그대로 열려 있다; 그다음 Back은 기존 동작(QOV-01-AC14)이다.
- 키보드: 버튼 Tab → Enter/Space로 dialog, focus로 tooltip. tooltip과 dialog의 터치 target 24px 이상. 색만으로 구분하지 않는다. 그림에는 `role="img"`와 이름 "문제 원문 p.1"(쪽마다). reduced motion·reduced transparency는 kit 규칙을 따른다. 375px에서 가로 scroll 없음.
- 의미 token만 쓴다(raw 색·그림자·radius 금지).

## 화면 상태

| 상태 | 구성원 | 보관된 Workspace | 공유 게스트 |
|---|---|---|---|
| 가져오기 출처 있음(bbox 포함) | 버튼 보임 | 같음 | 버튼 없음 |
| 직접 만든·생성된·교재 근거만 있는 문제, 출처 PDF가 삭제된 문제 | 버튼 없음 | 같음 | 버튼 없음 |
| 영역 정보 확인 중 | 버튼 없음(응답 뒤 나타남) | 같음 | — |
| 영역 정보 오류(5xx·네트워크) | 버튼 없음(원문 보기가 없을 뿐 풀이는 그대로) | 같음 | — |
| PDF 불러오기 실패 | tooltip: "원문을 불러오지 못했습니다" · dialog: alert + `다시 시도` | 같음 | — |
| 제출 전·후 | 같은 영역(같은 응답) | 같음 | — |

## 수용 기준

E2E는 합성 `questions-ko.pdf`(문제 1~8, 정답표가 3쪽에 있음)를 `question_paper`로 올려 기존 가져오기 흐름으로 등록한 문제를 쓴다. 두 쪽에 걸친 영역은 등록 뒤 그 문제의 가져오기 출처 행에 둘째 쪽 위치를 더해 만든다(DB 직접 seed — 합성 PDF에는 쪽을 넘는 문제가 없고, 어떤 공개 API도 그런 출처를 만들지 못함; fixtures/question-source.ts S4). LLM은 쓰지 않는다. 정답이 보이는 화면이므로 trace·screenshot·video를 끄고 합성 문자열만 쓴다.

### QSRC-01-AC01

- **Given:** 가져오기로 등록된 확정 객관식 문제 2개(문제 1, 문제 5), 직접 만든 문제, 교재 근거(`question_sources`에 책 문서만, `import_run_id` 없음)만 있는 문제, 문제 PDF를 지우는 단계, 편집 권한 구성원(답을 제출하는 쪽)이 연 Workspace 홈
- **When:** 각 문제의 풀이 panel(`?question=`)을 열어 풀이 panel header 아래를 확인하고, 가져온 문제에서 답을 제출한 뒤 다시 확인한다
- **Then:** 가져온 문제 둘에는 제출 전에도 후에도 `문제 원문 보기` 버튼이 보인다. 직접 만든 문제와 교재 근거만 있는 문제에는 버튼이 없다(자리도 비어 있지 않음). 문제 PDF를 `DELETE /documents/:id`로 지우면 그 PDF에서 가져온 문제(문제 1·5)는 남아 있지만 새로 열면 버튼이 없다. 그림이 없는 이 문제들은 버튼을 누르기 전에는 PDF를 가져가는 요청(`/documents/:id/source-url`)이 없다. 제출 전에 이 화면이 부른 API 응답에는 `correct_option_ids`·`explanation` 등 정답 키가 없다.

### QSRC-01-AC02

- **Given:** AC01의 가져온 문제를 연 풀이 panel(데스크톱), 키보드 사용자, 터치 입력 context
- **When:** 버튼 위에 포인터를 올렸다 벗어난다. Tab으로 focus를 주고 Escape를 누른다. 터치에서 500ms 누르고 있다가 뗀다. 열린 tooltip 바깥을 누른다. 짧게 tap한다
- **Then:** hover·focus·long-press 모두 `role="tooltip"`이 열리고 문제 영역 그림(`role="img"` "문제 원문 p.1")이 보이며 버튼이 `aria-describedby`로 가리킨다. 포인터를 벗어나면 닫힌다. focus 중 Escape는 tooltip만 닫고 풀이 panel은 열려 있다. long-press 뒤 손가락을 떼도 dialog는 열리지 않고 tooltip이 남으며, 바깥을 누르면 닫힌다. 짧은 tap은 dialog를 연다(AC03).

### QSRC-01-AC03

- **Given:** AC01의 가져온 문제를 연 풀이 panel(viewport 1280×800)
- **When:** `문제 원문 보기`를 click한다. dialog 안에서 Escape를 누른다. 다시 열고 `닫기`를 누른다. 다시 열고 backdrop을 누른다. 마지막으로 열린 채 Escape를 두 번 누른다
- **Then:** "문제 원문" dialog가 풀이 panel의 **왼쪽**에 나란히 열린다(두 상자가 겹치지 않고 둘 다 viewport 안, 풀이 panel의 위치·폭 불변). 풀이 panel은 보이지만 `inert`다. Escape·`닫기`·backdrop은 원문 dialog만 닫고 focus는 `문제 원문 보기` 버튼으로 돌아오며 풀이 panel은 열려 있고 고른 답이 그대로다. 열린 채 두 번 누른 Escape는 먼저 원문 dialog를, 그다음 풀이 panel을 닫는다. URL은 열고 닫는 동안 바뀌지 않는다. 풀이 기록(attempt)·Heatmap 상태는 바뀌지 않는다.

### QSRC-01-AC04

- **Given:** AC01의 가져온 문제를 연 풀이 panel(viewport 375×812, 그리고 두 panel이 들어갈 자리가 없는 태블릿 820×1180), 푼 답을 고른 상태
- **When:** `문제 원문 보기`를 tap한다. 브라우저 Back을 누른다. 다시 열고 `닫기`를 누른다. 다시 열고 Escape를 누른다
- **Then:** "문제 원문" dialog가 **전체 화면 sheet**로 풀이 panel을 덮는다(viewport 전체, 가로 scroll 없음). 820px에서도 나란히가 아닌 같은 sheet다(868px 미만). 풀이 panel 뒤에 있어도 위치·고른 답은 그대로다. Back은 sheet만 닫고 풀이 panel과 URL은 그대로이며, `닫기`·Escape도 sheet만 닫아 문제로 돌아오고 focus는 버튼에 있다. axe 위반 0.

### QSRC-01-AC05

- **Given:** `questions-ko.pdf`에서 가져온 문제 1(1쪽, bbox 하나), 둘째 쪽 위치를 더해 두 쪽에 걸치게 한 문제 5(2쪽 + 1쪽의 한 구역), 정답표(3쪽 `1. ②` …)와 같은 쪽 다른 문제의 글, 영역 정보 API 응답
- **When:** 두 문제의 원문 dialog와 tooltip을 열고 그림의 크기·쪽 표시·dialog 안의 글을 확인한다. 영역 정보를 `GET /questions/:id/source-region`으로 직접 부른다
- **Then:** 문제 1의 그림은 bbox의 가로세로 비(±2%)이고 한 쪽 전체의 비가 아니다(쪽 표시 `p.1` 하나). 두 쪽 문제는 쪽 표시 `p.1`·`p.2`가 위아래 순서로 쌓인 그림 둘이다. dialog에는 쪽 이동·scroll 도구가 없고 정답표 줄(`1. ②` 등)·`- 3 -`·다른 문제의 발문이 DOM 글로 없으며, 쪽 표시는 영역이 있는 쪽(`p.1`·`p.2`)뿐이고 정답표 쪽(`p.3`)은 어디에도 없다. 영역 정보 응답은 문서 id·revision id·쪽·bbox만 있고 `ANSWER_KEYS`의 어떤 키도 발문·보기·글 본문도 없다.

### QSRC-01-AC06

- **Given:** AC01의 문제들, 그 가져온 문제로 만든 `보기 섞기` 모의고사와 직접 만든 문제로 만든 `보기 섞기` 모의고사(AI 변형 모의고사 문제는 계약 C04), 가져온 문제 둘의 범위 풀이, "문제 상세" dialog를 여는 편집·보기 권한 구성원, 유효한 공유 링크 게스트
- **When:** 원본 풀이로 범위 풀이를 시작해 버튼을 확인하고 dialog를 연다. 풀이 panel `문제 정보` › `정답·해설 보기`의 "문제 상세"에서 확인하고 연다. 두 모의고사의 풀이와 상세에서 확인한다. 게스트가 공유 문제 panel을 연다. 게스트가 두 API를 직접 부른다
- **Then:** 범위 풀이(`sequence(bank)`)와 "문제 상세"(`manage`)에서 가져온 문제에는 버튼이 있고 같은 원문 dialog가 열린다("문제 상세"의 dialog는 그 위에 쌓인다). 가져온 문제의 모의고사 문제에는 버튼이 있고 원본 문제와 같은 영역을 보이며, 직접 만든 문제의 모의고사 문제에는 없다. 공유 게스트 화면에는 버튼이 없고 게스트 요청은 영역 정보 API에서 거절된다(404/401, 영역 없음).

## 계약 요구사항 (pytest, 화면 AC 아님)

`tests/integration/questions/source_region/test_source_region_contract.py`.

| ID | 요구사항 |
|---|---|
| QSRC-01-C01 | **정답을 알려 주지 않는 응답:** `GET /questions/{id}/source-region`(구성원) → 200 `{question_id, regions: [{document_id, document_revision_id, page, bbox: {x0, y0, x1, y1}}], figures: [같은 모양]}`뿐이다(`figures`는 UX12-REEXTRACT-C05). 발문·보기·정답·해설·출처 글·`block_ids`·`import_run_id`·점수가 없고(재귀 key 검사에 `ANSWER_KEYS`와 `stem`·`options`·`block_ids` 없음), 풀이 session이 필요 없으며 제출 전·후 응답이 같다. `regions`는 문서·쪽마다 하나(bbox는 그 쪽 위치들의 합집합, x0<x1·y0<y1·유한한 수), 쪽 오름차순. `Cache-Control: private, no-store`. 풀이 session·practice DTO·`question_user_states`·attempt는 바뀌지 않는다(행 수 비교). |
| QSRC-01-C02 | **가져오기 출처만:** `question_sources.import_run_id is not null`이고 `locations`에 bbox가 있는 행의 위치만 쓴다. 직접 만든 문제·교재 근거(`import_run_id` null)만 있는 문제·bbox 없는 위치뿐인 문제는 404(응답에 정답이 든 책 쪽 정보가 없음). 같은 문제에 가져온 출처와 교재 근거가 함께 있으면 가져온 출처 위치만 합친다(교재 근거 쪽은 응답에 없음 — test). 두 쪽에 걸친 위치는 쪽마다 한 항목이다. Fork 복사본은 복사된 위치로 같은 규칙. 출처 문서가 삭제됐으면(`documents.deleted_at`) 그 출처의 위치는 쓰지 않고 남는 것이 없으면 404이며 문제는 그대로다. 문서 원본 PDF는 불변이라 revision 일치 검사는 없다. |
| QSRC-01-C03 | **인가:** 같은 Workspace의 구성원이면 `viewer` 포함 누구나 200(편집 권한 불필요). 비구성원·다른 Workspace·삭제된 문제·삭제된 Workspace는 존재 여부를 알 수 없는 같은 404. 초안(DRAFT) 문제는 404. 보관된(ARCHIVED) 문제와 보관된 Workspace는 읽을 수 있다. 공유 링크 게스트 세션(share cookie)과 익명 요청은 거절된다(401/404, 본문 없음). `workspace_id`·`user_id` 같은 client 값은 쓰지 않는다(경로의 문제 id → DB의 Workspace → 구성원). |
| QSRC-01-C04 | **모의고사 변형:** `GET /mock-exam-questions/{id}/source-region`은 그 모의고사 문제의 **원본 문제**(`source.question_id`)가 가져오기 출처 영역을 가질 때만 C01과 같은 모양(`mock_exam_question_id`, `regions`, `figures`)의 200이다. 원본이 직접 만든 문제·교재 근거만 있는 문제이거나 원본 문제가 삭제된·초안인 경우, 원본의 출처 PDF가 삭제된 경우, **`보기 섞기`(`OPTION_SHUFFLE`)가 아닌 AI 변형 모의고사 문제(`variation_type` ≠ `OPTION_SHUFFLE`)는 원본에 영역이 있어도 404**, 비구성원·다른 Workspace는 404. 모의고사 문제의 `evidence`(근거) 위치는 쓰지 않는다. 정답·해설 키 없음, 모의고사 응시 기록(`mock_exam_attempts`) 불변. |
| QSRC-01-C06 | **영역은 정답 줄에 닿지 않는다 (UX12 2026-11-06):** 합집합에는 문제 자기 블록의 위치만 넣는다. `block_id`가 있는 그림 근거 위치는 인라인 정답 뒤에서 읽은 이미지일 수 있어 합집합을 넓히지 않는다. revision의 글 블록 중 인라인 정답 줄(`정답: ②`, `book_core.extractor.has_inline_answer`)이 있는 블록과 합집합이 겹치는 쪽은 영역이 없다. 파서가 마지막 보기와 정답 줄을 한 블록에 둘 수 있고, 단을 넘는 문제의 합집합은 정답 줄을 가로지를 수 있다. 남는 쪽이 없으면 404(버튼 숨김)다. `정답을 고르시오` 같은 발문은 정답 줄이 아니다. 문제 영역 밖에 인쇄된 공통 그림은 이 화면에도 보이지 않는다. 정답 표(문서 뒤쪽)는 원래 영역 밖이다. |
| QSRC-01-C05 | **기존 경로 불변:** 새 migration·테이블·env 없음. practice·묶음 응답 schema, `GET /documents/{id}/source-url`의 권한(구성원 누구나)·모양은 바뀌지 않는다. 영역 요청·응답은 로그·trace·URL에 bbox·문서 id 외의 문제 글을 남기지 않는다(예외 type·code만). |

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 구현한다(QSRC.0). 계약은 pytest `infra red`로 먼저 쓰고 구현하는 Task(QSRC-API)가 `red` marker를 뗀다.
- 정답이 보이는 화면의 spec은 trace·screenshot·video와 page text 첨부를 끈다.
- `QSRC.0`은 QSRC-W가 끝날 때까지 CI `E2E_PHASES`에 넣지 않는다. 기존 GREEN AC(QVIEW-01·QPLAY-01 등)는 고치지 않는다(plan §7 UX9-SPEC 해석 (1)).
