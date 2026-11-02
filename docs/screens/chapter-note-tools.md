# CHNOTE-02 — 정리 노트 읽기 도구 (항상 펼친 본문 · 노트 안 검색 · 각주 미리보기 · Heatmap 연동)

**상태:** 확정 화면 요구사항 v1.0 · UX9-SPEC 신규 2026-11-02 (사용자 피드백 "정리 노트 수정 — 정리 노트 내 키워드 검색 기능 추가 — 문장 옆에 각주 번호에 hover하면 마우스 포인트를 기준으로 또다른 floating (tooltip)이 보이며 문제가 보이도록 하기 — 정리 노트의 접기/펼치기는 필요 없을듯 … 정리 노트가 열린 상태에서 개별 문제(Heatmap)를 누르면 정리노트 dialog 닫기", 사용자 결정 2026-11-02 C6·C7·C8·C9) · 같은 날 개정: 정리 노트도 modal(사용자 결정 "정리 노트도 모달로 변경. 모달을 닫고 문제를 누르도록 유도" — C9를 대체, 아래 "노트가 열린 동안 Heatmap은 비활성")
**Route:** 별도 route 없음 — 정리 노트 panel(CHNOTE-01, `?panel=chapter-note&chapter=:chapterId`, 공유 게스트 `/share/:shareId?panel=chapter-note&chapter=:chapterId`) 안의 도구. 이 화면 ID는 CHNOTE-01(phase CHNOTE.0, CI에서 GREEN)에 새 AC를 더하지 않고 UX9 변경을 따로 추적하기 위한 것이다.
**테스트:** `tests/e2e/questions/chapter-note-tools.spec.ts` (계약: `tests/integration/questions/chapter_notes/test_chapter_note_previews_contract.py`, `apps/web` · `packages/ui` Vitest)
**Phase:** UX9.0 (RED) → UX9-NOTE-B → UX9-NOTE-W
**연계:** [CHNOTE-01](chapter-notes.md), [HILITE-01](highlights.md), [QOV-01](questions-overview.md) 4·5(뒤로가기·정리 노트), [QPLAY-01](questions-practice.md), [QVIEW-01](question-viewer.md), [WS-VIEW-01](workspace-shared-view.md), [디자인 시스템](../design-system.md) §5.3·§5.4, [E2E 규칙](../e2e-strategy.md)

```yaml
id: CHNOTE-02
route: (CHNOTE-01 panel 안)
actor: workspace_member · share guest (검색·각주 미리보기)
permission: read
status: confirmed
api: [GET /api/v1/questions/:id/preview, GET /api/v1/shared/:shareId/questions/:questionId/preview]
components: [FloatingSidePanel, SearchField, PointerAnchoredFloating, HighlightableText, IconButton]
linked_tests: [CHNOTE-02-AC01 … CHNOTE-02-AC05]
```

## 목적과 정책

- **본문은 늘 펼쳐 둔다 (사용자 결정 C7):** CHNOTE-01의 "정답·해설 포함 — 펼쳐서 보기" disclosure를 없앤다. panel을 열면 노트 본문(소제목·항목·각주 목록)이 바로 보인다(구성원·공유 게스트 모두). 노트가 정답·해설에서 나온 내용이라는 점은 본문 위 한 줄 설명 "이 노트에는 문제의 정답과 해설 내용이 들어 있습니다."(글자, 접기 없음)로 남긴다.
- **풀이와 분리는 그대로 (CHNOTE-01 정책 유지):** 풀이 panel(QPLAY-01)·범위 풀이(QVIEW-01 `sequence`)와 practice API에는 노트 내용·링크가 없다. 접기가 없어졌으므로, modal 풀이 panel이나 범위 풀이가 노트 panel 위에 열린 동안에는 노트 panel의 내용 영역을 가린다(`visibility: hidden` + `inert`, header의 제목·닫기만 남김; 화면 낭독기에도 숨김) — 풀이하는 동안 옆에 정답이 보이지 않게 (사용자 결정 2026-11-02). 풀이 panel이 닫히면 내용이 다시 보이고 scroll 위치·검색어·고른 버전은 그대로다.
- **노트는 modal, 열린 동안 Heatmap은 비활성 (사용자 결정 2026-11-02 "정리 노트도 모달로 변경. 모달을 닫고 문제를 누르도록 유도" — 처음의 C9 "Heatmap 문제를 누르면 노트를 닫는다"를 대체):** 정리 노트 panel은 modal `FloatingSidePanel`이다(HOMEDLG-01: focus trap, 배경 `inert`, 열고 닫아도 홈 배치가 변하지 않음). 노트가 열린 동안 Heatmap marker는 누를 수도 focus할 수도 없다. 문제를 풀려면 노트를 닫고(닫기·Escape·뒤로가기·**노트 밖 backdrop click** — 노트에는 저장하지 않은 입력이 없으므로 backdrop click은 늘 닫는다, HOMEDLG-01; 그 click은 아래 Heatmap·header로 전달되지 않음) — focus는 연 `정리 노트` 버튼으로 돌아온다 — 그다음 marker를 누른다. 그래서 노트를 닫는 "닫기 + 열기" 바꾸기 규칙은 없다(QOV-01 4의 기록 규칙은 그대로: 노트를 연 것이 기록 항목 하나, 닫으면 다시 열리지 않음).
- **각주를 누르면 (현재 동작 유지, 사용자 결정 C9 "keep current behaviour"; 사용자 결정 2026-11-02 (q)):** 본문의 각주 번호와 각주 목록 줄을 누르면(click·Enter) 그 문제의 풀이 panel(`?question=`, 게스트는 공유 문제 panel)이 노트 위에 **겹쳐 열린다**(modal 위 modal — 안에서 연 dialog는 쌓인다, HOMEDLG-01). 노트는 닫히지 않는다. 풀이 panel이 열린 동안 노트 내용은 가려지고(위 "풀이와 분리는 그대로"), 풀이 panel을 닫으면 focus는 누른 각주 링크로 돌아온다(이전: "정답·해설 포함" disclosure 버튼). 뒤로가기 한 번은 풀이 panel만 닫고 다음 뒤로가기가 노트를 닫는다.
- **각주 미리보기 (사용자 결정 C6):** 각주 번호(`[1]`, 본문)와 각주 목록 줄(`[^1] …`)에 pointer를 올리면 TOOLTIP_DELAY_MS(300ms) 뒤 **pointer가 들어온 위치를 기준으로** floating 미리보기가 뜬다(design-system §5.4 `PointerAnchoredFloating`). 키보드 focus-visible이면 지연 없이 그 각주 요소에 붙어 뜬다. 내용: "3장 12번 · 객관식", 발문(`displayStem`), 번호 붙은 보기(원래 순서, 정답 표시 없음); 단답형·서술형은 발문만. **정답·해설·허용 답안·채점 기준은 화면에도 응답에도 없다.** click은 지금처럼 문제를 연다(미리보기는 열기를 막지 않음). 터치(hover 없음): 각주를 tap하면 문제를 바로 열지 않고 미리보기가 뜨며 그 안의 `문제 열기` 버튼이 문제를 연다; 밖을 tap하거나 Escape로 닫는다. "삭제되었거나 옮긴 문제" 각주는 링크가 없으므로 미리보기도 없다. 미리보기는 열람(`viewed`)을 기록하지 않는다(questions.md §2.1 — hover는 열람이 아님).
- **노트 안 검색 (사용자 결정 C8):** 본문 위 검색 입력란(접근성 이름 "노트에서 찾기")으로 지금 보이는 노트 버전의 본문·각주 목록과 `내 하이라이트`의 해설 하이라이트 인용 글을 찾는다(사용자 결정 C8 제안 채택: `내 하이라이트`도 찾음). **찾는 범위 — 같은 글을 두 번 세지 않음 (사용자 결정 2026-11-02):** 본문의 노트 하이라이트는 본문에 나오는 자리에서만 센다; `내 하이라이트` 안에서는 **해설 하이라이트 행(해설·AI 해설)의 인용만** 찾고, 노트 본문 하이라이트 행("노트 · 버전 k")은 찾지 않는다(그 글은 이미 본문에서 찾았거나 이전 버전의 것). 그래서 본문 하이라이트 안의 결과는 본문에 한 번만 표시·계산된다. 대소문자·전각/반각(NFKC) 차이는 무시하고 띄어쓰기는 그대로 비교한다. 검색어는 URL에 남기지 않고 panel을 다시 열거나 장·버전을 바꾸면 비운다 (사용자 결정 2026-11-02).

## 레이아웃 및 컴포넌트

- **panel 순서(CHNOTE-01을 바꿈):** header(제목·부제·`AI 생성` badge·메타 줄·stale badge·닫기) → `버전` → 검색 줄 → 설명 한 줄 "이 노트에는 문제의 정답과 해설 내용이 들어 있습니다." → 본문(소제목·항목, `HighlightableText`) → `각주` 목록 → `내 하이라이트`(HILITE-01) → 동작 버튼(`다시 만들기` 등). "챕터 없음" 그룹의 `내 하이라이트` panel(HILITE-01)은 검색 줄과 `내 하이라이트`만 있다.
- **검색 줄 (`SearchField`):** `type="search"` 입력란(돋보기 아이콘, placeholder "노트에서 찾기"), 결과 글자 "2/5"(접근성: `aria-live="polite"` "5개 중 2번째"; 0이면 "결과 없음"), `이전 결과`·`다음 결과` `IconButton`(위·아래 chevron, 결과가 없으면 비활성). 입력하는 대로(debounce 150ms) 찾고 첫 결과로 scroll한다. Enter = 다음, Shift+Enter = 이전(끝에서 처음으로 돌아감, 돌아갈 때 "처음부터 다시" polite 안내). Escape: 검색어가 있으면 비우고 결과 표시를 지운다(focus는 입력란에 남음, dialog는 닫히지 않음 — design-system §5.1 "인라인 편집 안의 Escape"의 `ownEscapeProps`); 검색어가 비어 있으면 평소처럼 노트 panel을 닫는다.
- **결과 표시:** 모든 결과는 `<mark>`(하이라이트와 다른 class)로 굵은 테두리(outline 2px `--color-focus-ring`과 다른 `--color-search-match` 토큰) + 배경 `--color-search-match-bg`, 지금 결과는 더 굵은 테두리와 숨긴 글자 "현재 결과"를 더한다(색만이 아님). 하이라이트 위에 겹치면 검색 표시가 위에 그려진다. 결과가 `내 하이라이트`의 접힌 인용("더 보기") 안이면 그 행을 펼친다. 검색 표시는 화면에만 있고 저장하지 않는다.
- **각주 미리보기 floating:** glass `Popover` 표면(`role="dialog"` 아님 — 비대화형 미리보기는 `role="tooltip"`; 터치의 `문제 열기` 버튼이 있는 경우만 `role="dialog"`, 노트 안의 non-modal popover), 폭 `min(360px, 100vw - 32px)`, 높이가 넘치면 안에서 scroll(§5.3 scroll 격리). pointer 위치(들어온 점)에서 8px 아래·오른쪽에 붙고 화면 가장자리에서는 뒤집거나 밀어 화면 안에 둔다. pointer가 각주와 미리보기 밖으로 나가고 120ms가 지나면 닫힌다(그 사이 미리보기로 옮겨 가면 유지 — 긴 발문을 scroll할 수 있음). 각주 요소에는 `aria-describedby`로 미리보기를 연결한다(뜰 때만). 미리보기 내용은 처음 뜰 때 불러오고(그동안 "불러오는 중" skeleton) 같은 panel 안에서는 다시 요청하지 않는다(메모리, 정답 없음이므로 UX7-CACHE 규칙 밖이지만 browser 저장소에는 쓰지 않음). 실패하면 "미리보기를 불러오지 못했습니다" 글자.
- **키보드:** Tab 순서 header → `버전` → 검색 입력란 → `이전 결과`·`다음 결과` → 본문(HILITE-01 영역) → 각주 → `내 하이라이트` → 동작 버튼. 각주에 focus하면 미리보기가 뜨고 Escape는 미리보기만 닫는다(다음 Escape가 panel을 닫음).
- **reduced motion:** 검색 결과로의 scroll과 미리보기 등장은 `prefers-reduced-motion`에서 애니메이션 없이 즉시.

## 화면 상태

| 상태 | 구성원 | 공유 게스트 |
|---|---|---|
| 노트 열기 | 본문이 바로 보임(disclosure 없음) | 같음(출처 일치 노트만 — CHNOTE-01) |
| 검색 결과 있음/없음 | "k/n" + 결과 표시 / "결과 없음" | 같음(`내 하이라이트` 없음) |
| 각주 hover·focus | 발문 + 보기 미리보기(정답 없음) | 같음(공유 미리보기 API) |
| 각주 tap(터치) | 미리보기 + `문제 열기` | 같음 |
| 풀이 panel이 위에 열림(각주) | 노트 내용 가려짐, 닫으면 각주로 focus | 공유 문제 panel도 modal로 노트 위에 쌓이고 같은 규칙으로 노트 내용을 가림 |
| 노트가 열린 동안 Heatmap | 비활성(`inert`) — 노트 밖(backdrop)을 누르면 노트만 닫히고, 그다음 marker를 누를 수 있음 | 공유 화면의 노트 panel도 modal(사용자 결정 2026-11-02, WS-VIEW-01) — 공유 목록 비활성 |

## 수용 기준

### CHNOTE-02-AC01

- **Given:** 성공한 정리 노트가 있는 장의 Workspace 홈(편집 권한자)과 같은 Workspace의 유효한 공유 링크 게스트
- **When:** 편집 권한자가 `정리 노트`를 열고 닫았다가 다시 열고; 게스트가 공유 화면의 `정리 노트` 카드에서 같은 장을 연다
- **Then:** 두 경우 모두 panel이 열리자마자 소제목·항목·각주 목록이 보이고 "정답·해설 포함 — 펼쳐서 보기" 버튼이나 `aria-expanded`를 가진 접기 버튼이 없다. 본문 위에 설명 "이 노트에는 문제의 정답과 해설 내용이 들어 있습니다."가 글자로 보인다. 다시 열어도 본문이 보인다.

### CHNOTE-02-AC02

- **Given:** 확정 객관식 문제 3개(해설 있음)로 만든 노트가 있는 장(구성원), 같은 노트의 공유 게스트, 터치 기기(iPhone WebKit) 구성원
- **When:** 마우스를 본문의 각주 번호 `[2]` 위 한 점에 올려 기다리고, 미리보기로 pointer를 옮겨 scroll한 뒤 밖으로 빼고; Tab으로 각주 `[1]`에 focus하고 Escape를 누르고; 각주 `[1]`을 click하고; 미리보기 API(`GET /questions/{id}/preview`)와 공유 미리보기 API 응답을 확인하고; 터치 기기에서 각주를 tap한 뒤 `문제 열기`를 누른다
- **Then:** 약 300ms 뒤 pointer가 들어온 점 근처(각주 요소의 가장자리가 아니라 pointer 좌표 기준 8px 안팎)에 미리보기가 떠서 "<장> <번호>번 · 객관식", 발문, 번호 붙은 보기를 보이고 정답 표시·해설은 없다. 미리보기로 옮겨 가는 동안 닫히지 않고, 둘 다 벗어나면 닫힌다. focus-visible 미리보기는 각주 요소에 붙어 바로 뜨고 각주의 `aria-describedby`가 그것을 가리키며, Escape는 미리보기만 닫고 panel은 열려 있다. click은 그 문제의 풀이 panel(`?question=`)을 연다. 두 API 응답(JSON 전체)에 정답 option id·`correct`·해설·허용 답안·채점 기준 필드가 없고, 미리보기는 그 문제를 열람(`viewed`)으로 만들지 않는다(Heatmap marker 상태 그대로). 터치 tap은 문제를 바로 열지 않고 미리보기와 `문제 열기`를 보이며, `문제 열기`가 풀이 panel을 연다.

### CHNOTE-02-AC03

- **Given:** 본문 두 항목과 각주 줄 하나에 "주의"가 모두 5번 나오고(그중 하나는 노랑 하이라이트 안) 다른 항목에 "ＡＴＴＥＮＴＩＯＮ"과 "attention"이 한 번씩 있는 노트, 그리고 인용에 "주의"가 한 번 있는 `내 하이라이트` 해설 행(구성원); 본문의 그 노랑 하이라이트도 `내 하이라이트`에 노트 행("노트 · 버전 1", 인용에 "주의" 포함)으로 있다
- **When:** "노트에서 찾기"에 "주의"를 입력하고, Enter를 세 번, Shift+Enter를 한 번 누르고, `다음 결과` 버튼을 누르고; "attention"을 입력하고; "없는말"을 입력하고; Escape를 두 번 누른다
- **Then:** "주의"는 본문·각주의 5개와 `내 하이라이트` 해설 행의 1개, 모두 6개를 찾아 "1/6"을 보인다 — `내 하이라이트`의 노트 행 인용은 찾지 않으므로(본문 하이라이트 안의 "주의"는 본문에서 한 번만 셈) 7이 아니다. 첫 결과로 scroll하고 첫 결과로 scroll한다; Enter마다 "2/6"·"3/6"·"4/6", Shift+Enter로 "3/6", 버튼으로 "4/6"이 되고 결과 글자가 polite로 알린다. 지금 결과는 다른 결과보다 굵은 테두리와 숨긴 글자 "현재 결과"를 갖고, 하이라이트 안의 결과도 표시된다(색만으로 구분하지 않음). "attention"은 "ＡＴＴＥＮＴＩＯＮ"과 "attention"을 모두 찾는다. "없는말"은 "결과 없음"이고 `이전 결과`·`다음 결과`가 비활성이다. 첫 Escape는 검색어와 결과 표시를 지우고 panel은 열려 있으며 focus는 입력란이다; 두 번째 Escape가 panel을 닫는다.

### CHNOTE-02-AC04

- **Given:** 노트가 있는 장과 그 장의 아직 풀지 않은 문제가 있는 Workspace 홈(Owner), 그 전에 Workspace 목록을 연 기록, 그 장의 정리 노트 panel이 열린 상태
- **When:** Tab을 노트 안의 조작 수보다 많이 누르고; 노트 panel 밖의 Heatmap marker 자리(backdrop)를 click하고; 같은 marker를 다시 click해 풀이 panel을 열고 닫고(Escape); 노트를 다시 열어 Escape로 닫고; 뒤로가기·앞으로가기를 누른다
- **Then:** 노트가 열린 동안 Tab은 노트 panel 안에서만 돈다(Heatmap은 `inert`, marker가 focus를 받지 않음). marker 자리의 backdrop click은 **노트만 닫는다**(사용자 결정 2026-11-02, HOMEDLG-01 backdrop 규칙): URL에서 `panel=chapter-note`만 빠지고 풀이 panel은 열리지 않으며(`question=` 없음) focus가 그 장의 `정리 노트` 버튼으로 돌아온다. 그다음 marker click이 그 문제의 풀이 panel을 열고, 닫으면 focus가 그 marker로 돌아온다(QOV-01-AC06). Escape로 닫아도 같다(focus는 `정리 노트` 버튼). 그 뒤 뒤로가기·앞으로가기 어느 쪽도 노트 panel이나 풀이 panel을 다시 열지 않는다. (UX7-BACK·UX7-BACK-2 규칙; 사용자 결정 2026-11-02 — 처음의 C9 "marker를 누르면 노트를 닫고 문제를 엶"을 대체: 닫는 click과 여는 click은 따로다)

### CHNOTE-02-AC05

- **Given:** 노트가 있는 장의 Workspace 홈(구성원), 노트 panel에서 검색어 "주의"로 3번째 결과까지 옮기고 본문을 scroll한 상태
- **When:** 본문의 각주 번호 하나를 click해 풀이 panel을 열고, 그동안 노트 panel의 내용과 접근성 tree를 확인하고, 풀이 panel을 닫는다
- **Then:** 노트 panel은 닫히지 않고(URL에 `panel=chapter-note`와 `question`이 함께 있음) 풀이 panel이 위에 열린다. 풀이 panel이 열린 동안 노트 panel의 본문·각주·`내 하이라이트`는 보이지 않고(`visibility: hidden`) 접근성 tree에도 없다(`inert`). 풀이 panel을 닫으면 노트 내용이 다시 보이고 scroll 위치·검색어·"3/n"이 그대로이며 focus는 누른 각주 링크에 있다.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/questions/chapter_notes/test_chapter_note_previews_contract.py`, `apps/web`·`packages/ui` Vitest.

| ID | 요구사항 |
|---|---|
| CHNOTE-02-C01 | **미리보기 API:** `GET /api/v1/questions/{id}/preview`(모든 구성원, 보관 Workspace 포함)는 `{question_id, number_label, chapter_title, question_type, stem, options: [{id, text}] (원래 순서)}`만 준다 — `correct_option_ids`·`answer`·`accepted_answers`·`rubric`·`explanation`·AI 해설·하이라이트 필드는 schema에 없다(응답 schema test + 실제 응답의 key 검사). 살아 있는 CONFIRMED 문제만(초안·보관·삭제·다른 Workspace는 404), 지금 active revision 기준. 호출은 `question_user_states`·practice session·attempt·활동 기록을 만들지 않는다. |
| CHNOTE-02-C02 | **공유 미리보기:** `GET /api/v1/shared/{shareId}/questions/{questionId}/preview`는 같은 DTO를 공유 세션의 발행 범위 문제에만 준다(CHNOTE-01-C05 각주 링크 조건과 같음; 아니면 404). Fork 수신자는 자기 Workspace의 구성원 API를 쓴다. |
| CHNOTE-02-C03 | **노트 API는 그대로:** `GET /chapters/{id}/note`·공유 노트 API의 응답은 바뀌지 않는다(접기는 화면 동작이었음). `practice-sessions`·`submit` 응답에 노트·미리보기·하이라이트 필드가 없다(CHNOTE-01-C05 유지). |
| CHNOTE-02-C04 | **검색 함수(Vitest):** `findInNote(text blocks, query)`는 NFKC·casefold 후 겹치지 않는 결과를 문서 순서로 돌려주고, 하이라이트 mark·숨김 글자·각주 번호를 건너 이어진 글에서도 찾는다(mark 경계를 넘는 결과), 빈 검색어는 결과 0. 결과 수 1,000개에서 멈추고 "1000+"를 보인다. |
| CHNOTE-02-C05 | **쌓기 규칙(Vitest·E2E helper):** home dialog 상태 함수에서 노트(`panel=chapter-note`)가 열린 동안 home 수준의 열기(marker의 `question`, header 버튼의 다른 `panel=`)는 일어나지 않고(배경 `inert`), 노트 안에서 연 각주의 `question`은 노트 위에 쌓인다(노트 유지). |
