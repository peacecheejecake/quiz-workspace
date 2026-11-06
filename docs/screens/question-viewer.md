# QVIEW-01 — 통합 문제 보기 `QuestionViewer` (범위 풀이 popup)

> **UX10 개정 예정(2026-11-05):** [확정 구현 기준](../implementation/ux10/index.md)의 해당 변경 요구가 이 문서의 이전 동작에 우선한다. 구현 Task의 RED 단계에서 해당 AC·trace를 함께 갱신한다. 변경되지 않은 요구·보안 경계는 유지한다.

**상태:** 확정 화면 요구사항 v1.0 · MOCK-SPEC 신규 2026-11-01 (사용자 요청 "정해진 범위의 문제에서 하나씩 팝업 위에서 문제를 보여주는 기능 추가(랜덤 여부는 시작 전 체크) — 등록된 문제 전체, 그리고 모의고사로 생성된 문제에서 각각 해당 기능 사용 — 공통 컴포넌트로 개발", 추가 결정 "하나씩 팝업 위에서 문제를 보여주는 기능을 통합 QuestionViewer로 하고, 기존 문제를 보여줄 때도 이 컴포넌트를 사용해도 되겠다") · MOCK-SYNC 개정 2026-11-02 (UX7이 만든 호출 위치·메뉴·보관·중복 정리에 맞춤) · UX9-SPEC 개정 2026-11-02 (해설 영역 하이라이트 — [HILITE-01](highlights.md), `다시 풀기` toggle 물음표 아이콘 — C08, 정리 노트 각주 호출의 노트 가림 — [CHNOTE-02](chapter-note-tools.md))
**Route:** 범위 고르기 `/workspaces/:workspaceId?practice=new&source=bank` · 모의고사 범위 고르기 `/workspaces/:workspaceId?practice=new&source=mock&mock=:mockExamId` · 진행 중 `/workspaces/:workspaceId?practice=:practiceRunId&i=:position` (Workspace 홈 위 modal panel). 한 문제 보기는 기존 route 그대로(`?question=:questionId` — QPLAY-01)
**테스트:** `tests/e2e/questions/question-viewer.spec.ts` (계약: `tests/integration/questions/practice_runs/test_practice_runs_contract.py`, `packages/ui` · `apps/web` Vitest)
**Phase:** QVIEW.0 (RED) → QVIEW-B → QVIEW-W (UX7-CACHE·UX7-BANK merge 이후; `bank` 출처 AC) → MOCK-P·MOCK-W (`mock` 출처: AC05, C03·C04의 mock 경우; CI phase는 MOCK-W에서 켬)
**연계:** [QPLAY-01](questions-practice.md), [QOV-01](questions-overview.md), [MOCK-01](mock-exams.md), [CHNOTE-01](chapter-notes.md), [WS-VIEW-01](workspace-shared-view.md), [Questions 명세](../questions.md) §4·§11·§12, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: QVIEW-01
route: /workspaces/:workspaceId?practice=new&source=bank|mock
actor: workspace_member (owner · editor · viewer — 개인 풀이)
permission: read · personal attempt
status: confirmed
api: [POST /api/v1/workspaces/:id/practice-runs, GET /api/v1/practice-runs/:id, GET /api/v1/practice-runs/:id/items/:position, POST /api/v1/practice-runs/:id/finish, POST /api/v1/questions/:id/practice-sessions, POST /api/v1/mock-exam-questions/:id/practice-sessions]
components: [QuestionViewer, QuestionRangePicker, FloatingSidePanel, Checkbox, ProgressBar, Button]
linked_tests: [QVIEW-01-AC01 … QVIEW-01-AC09]
```

## 목적과 정책

- **하나의 컴포넌트:** 문제를 하나씩 보여 주는 모든 곳은 `QuestionViewer` 하나를 쓴다(사용자 결정 2026-11-01). 문제 출처(`source`)는 두 가지다: 등록된 문제(`bank` — Workspace의 CONFIRMED 문제, Heatmap의 marker)와 모의고사 문제(`mock` — [MOCK-01](mock-exams.md)이 만든, 그 모의고사 안에만 있는 문제). 출처만 다르고 화면·키보드·채점 흐름은 같다.
- **풀이 흐름(사용자 결정 3):** 답을 고르고 `제출` → 서버 채점 → 결과(정답/오답/채점 대기) + 정답 + 해설. 제출 전에는 화면과 API 응답 어디에도 정답·해설이 없다(QPLAY-01-AC01과 같은 non-disclosing DTO). 채점은 표시 위치가 아니라 변하지 않는 option ID로 한다(QPLAY-01-AC02). 풀이 기록은 바뀌지 않는다(immutable).
  - `bank` 출처의 풀이는 지금처럼 `question_attempts`·`question_user_states`에 기록되어 Heatmap 상태(열람·정답·오답)에 반영된다. 문제가 화면에 보일 때(세션을 열 때) `viewed`를 기록한다(questions.md §2.1).
  - `mock` 출처의 풀이는 그 모의고사 문제에 기록되고(`mock_exam_attempts`) Heatmap·문제 상태·문제 수는 바뀌지 않는다.
- **범위 풀이 (새 기능):** 시작 전에 범위를 고르고(`전체 선택` 포함) `무작위 순서` checkbox를 정한 뒤 `시작`. 서버가 범위를 확정 문제 목록으로 풀고(순서 = Heatmap 순서, `무작위 순서`면 서버가 seed로 섞음) 풀이 묶음(`practice_run`)으로 저장한다. 묶음은 한 번에 한 문제를 보이고 `이전`·`다음`으로 오간다. 새로 고침하면 같은 순서·같은 위치로 돌아온다.
- **범위 단위 (사용자 결정 2026-11-01):** 범위는 Heatmap과 같은 **챕터 그룹 → 문제** 두 단계 checkbox 목록이고, 위에 `전체 선택`이 있다. 목록을 좁히는 필터는 홈 상태 필터와 같은 항목(풀이 상태 `안 푼 문제`·`본 문제`·`틀린 문제`·`맞힌 문제`·`다시 풀기`, `즐겨찾기만`, 유형)이다. 문서 단위·쪽 단위 범위는 없다. 이 고르기 부품(`QuestionRangePicker`)은 MOCK-01의 출제 범위 고르기와 같은 컴포넌트다.
- **한 묶음 크기 (사용자 결정 2026-11-01):** 한 묶음은 최대 **5,000문제**다(실제 Workspace에 1,008문제짜리 책이 있음). 넘으면 `시작` 비활성 + "한 번에 5,000문제까지 풀 수 있습니다", 서버 422 `practice-run-too-large`. 이 크기에서도 화면은 한 번에 한 문제와 진행만 불러오고(묶음 전체 문제 내용을 받지 않음), 범위 고르기 목록은 장 단위로 접혀 있다가 펼친 장만 virtualized 목록으로 그리며, 결과 요약 목록은 페이지(200개씩)로 불러온다.
- **묶음 안 재풀이 (사용자 결정 2026-11-01):** 한 묶음에서 문제마다 제출은 한 번이다. `이전`으로 돌아간 문제는 제출한 답·결과·정답·해설을 읽기 전용으로 보인다. 다시 풀려면 결과 화면의 `처음부터 다시`(새 묶음, 아래 "처음부터 다시")를 쓴다. 한 문제 보기(`?question=`)의 기존 다시 풀기 동작은 그대로다.
- **끝과 결과 요약 (사용자 결정 2026-11-01):** 마지막 문제 뒤 `결과 보기`는 같은 panel에 "맞음 x · 틀림 y · 채점 대기 z · 건너뜀 w"와 문제별 결과 목록(번호·발문 앞부분·결과 글자)을 보인다. 목록의 문제를 누르면 그 묶음 안의 그 위치(`?practice=<id>&i=<k>`)로 돌아가 읽기 전용 결과를 본다 — 한 문제 보기(`?question=`)를 열지 않는다. 시간 제한은 없다 (사용자 결정 2026-11-01).
- **처음부터 다시 (사용자 결정 2026-11-02, QVIEW-W에서 만든 대로 확정):** 새 묶음은 **이전 묶음의 문제 중 아직 풀 수 있는 문제**(그 사이 삭제·보관된 문제, 모의고사에서 빠진 문제는 빠짐)로 만들고 무작위 설정은 이전 묶음과 같다(`무작위 순서` 묶음은 새로 섞는다). 처음 범위를 고를 때의 조건(장 선택·`전체 선택`·풀이 상태·즐겨찾기 필터)을 다시 풀지 않는다 — 그 사이 새로 확정된 문제나 풀이 상태가 바뀐 문제는 들어오거나 빠지지 않는다. 이전 묶음과 그 풀이 기록은 그대로 남는다.
- **도중에 닫기 (사용자 결정 2026-11-01):** 닫기·Escape는 확인 없이 닫는다(제출한 풀이는 이미 저장됨). 닫은 묶음은 URL(`?practice=<id>`)이나 이력에서 다시 열면 이어서 풀 수 있고, 새 `문제 풀기`는 새 묶음을 만든다. 끝나지 않은 묶음 목록·이어 풀기 메뉴는 v1에 없다.

## 기존 호출 위치 (call sites)와 보기 방식

QuestionViewer는 아래 **방식(mode)**을 갖는다. 기존 AC가 요구하는 동작(modal/non-modal, 정답 표시 여부, 이전·다음 순서)은 방식으로 남기고 바꾸지 않는다. 각 기존 화면의 AC는 그대로 유효하며 이제 QuestionViewer를 대상으로 검증한다. 아래 표는 UX7(2026-11-01, `feature/ux7-feedback`)이 실제로 만든 화면 기준이다(MOCK-SYNC 2026-11-02 — MOCK-SPEC 초안은 UX7-BANK가 "홈 문제 상세 panel"을 따로 만든다고 가정했으나, UX7-BANK·BANK-2는 풀이 panel의 메뉴와 그 위의 modal "문제 상세" dialog로 만들었다).

| # | 호출 위치 (지금 구현) | 문제 수 | 방식 | 겉 panel | 기준 AC |
|---|---|---|---|---|---|
| 1 | Workspace 홈 Heatmap marker click/Enter, `?question=` 딥링크 (`components/questions/practice/practice-panel.tsx`) | 한 문제(이전·다음 = Heatmap 순서·현재 필터, URL이 문제마다 바뀜) | `practice` | modal `FloatingSidePanel`(design-system §5.1 `QuestionPracticePanel` 규칙) | QOV-01-AC06·AC14, QPLAY-01-AC01~AC06·AC12·AC13 |
| 1a | 1의 header 메뉴 (`practice/question-manage-menu.tsx`): 편집 권한·보관되지 않은 Workspace는 `문제 관리`(`정답·해설 보기`·`수정 이력·출처` \| `편집`·`보관` \| `삭제`; `변형 출제`는 QGEN-RM에서 제거), 보기 권한·보관된 Workspace는 읽기 전용 `문제 정보`(`정답·해설 보기`·`수정 이력·출처`) | 한 문제 | `practice`의 header 메뉴(쓰기 항목은 편집 권한에만 보이고 비활성으로도 보이지 않음) | 1과 같음; `편집`은 그 위에 modal "문제 편집" dialog, `보관`·`삭제`는 확인 dialog 후 panel을 닫음 | QPLAY-01-AC07~AC11 |
| 2 | 이력 dialog의 풀이 기록 링크(`?question=`, 합쳐진 중복이면 남길 문제를 엶 — UX7-DEDUP) | 한 문제 | `practice` | 1과 같음 | HISTORY-01, QOV-01-AC17 |
| 3 | 챕터 정리 노트 각주 링크(구성원, `?question=`) | 한 문제 | `practice` | 1과 같음(UX9 전: 열리면 노트 본문 접힘 → UX9-SPEC: modal 노트 위에 쌓이고 열린 동안 노트 내용을 가림, 닫으면 각주로 focus; 노트가 열린 동안 Heatmap marker는 비활성) | CHNOTE-01-AC02·AC05, CHNOTE-02-AC04·AC05 |
| 4 | 1a의 `정답·해설 보기`·`수정 이력·출처`가 여는 "문제 상세" dialog (`components/questions/detail/question-detail-dialog.tsx`, 본문 `question-detail.tsx`의 `RevisionView`) | 한 문제 | `manage`(정답·해설·허용 답안·채점 기준·출처(그 쪽의 "원본 PDF" dialog, [UX12-SOURCE](ux12-source-panel.md) — dialog에서 DOC-02 `?page=`로)·수정 이력(버전 toggle `aria-pressed`, 지난 버전 미리보기); 정답이 든 문제는 항목을 고를 때만 `GET /questions/{id}`로 불러옴; 풀이 기록·viewed 기록 없음; 여기서는 동작 버튼 없음 — ASK-Q부터 footer에 `질문하기`, EXPL-W·RELSRC-W부터 해설 아래 `AI 해설`·"관련 본문", 아래 "AI 질문·AI 해설·관련 본문") | panel 위 modal `ModalDialog` "문제 상세"(설명: 제목 · 유형 · 챕터). `수정 이력·출처`로 열면 `수정 이력` 제목에 focus, 닫으면 메뉴 버튼으로 focus 복귀. 닫아도 아래 `practice`의 고른 답·session이 그대로 남아 제출할 수 있다 | QPLAY-01-AC09·AC10·AC13 |
| 5 | `문제` › `보관·초안 문제` dialog(`?panel=inactive-questions`, `components/questions/inactive/inactive-questions.tsx`)의 행 → 4와 같은 "문제 상세" dialog | 한 문제(목록 행은 QuestionViewer가 아님: 번호·유형·상태 badge·챕터·발문 앞부분) | `manage` — 편집 권한(보관되지 않은 Workspace)은 footer에 그 상태의 `보관 해제`/`확정`·`편집`·`삭제`, 보기 권한·보관된 Workspace는 동작 없는 읽기 전용(행에도 버튼 없음) | non-modal 목록 dialog 위 modal `ModalDialog` "문제 상세" | QOV-01-AC15 |
| 6 | 공유 링크 게스트의 문제 미리보기(`/share/:shareId`, 정리 노트 각주 포함; `components/shared/shared-questions.tsx`, 본문 `RevisionView`) | 한 문제 | `read-only`(발행 문제·정답·해설 표시, 제출·즐겨찾기·다시 풀기·수정 이력 없음, 아무것도 저장 안 함) | non-modal `FloatingSidePanel` → UX9-SPEC 사용자 결정 2026-11-02부터 modal(공유 목록 `inert`, panel 안 이전·다음 — 사용자 결정 2026-11-03; WS-VIEW-01) | WS-VIEW-01-AC01·AC03, CHNOTE-01-AC04 |
| 7 | **새로:** `문제` 메뉴 › `문제 풀기`(등록된 문제 범위 풀이) | 범위 묶음 | `sequence`(`source=bank`) | modal `FloatingSidePanel` | QVIEW-01 |
| 8 | **새로:** 모의고사 목록·상세의 `풀기` | 범위 묶음 | `sequence`(`source=mock`) | modal `FloatingSidePanel` | QVIEW-01-AC05, MOCK-01 |
| 9 | **새로:** 모의고사 상세의 문제 행(편집 권한) | 한 문제 | `manage`(`source=mock`: 정답·해설·검증 경고, 동작 `편집`·`이 모의고사에서 빼기`; 수정 이력·출처 링크는 원본 번호만) | modal `FloatingSidePanel` | MOCK-01-AC05 |
| — | `문제` › `중복 문제 정리` dialog(`?panel=question-duplicates`, `components/questions/duplicates/question-duplicates.tsx`)의 묶음 행 | — | 범위 밖: popup이 아니라 목록 안 렌더링(번호·챕터·등록일·발문·보기, **정답 표시 없음**, `남길 문제` radio). 바꿀 때 문제 본문 부품을 쓰더라도 정답·해설을 렌더링하지 않는다 | — | QOV-01-AC16 |
| — | Heatmap marker hover/focus preview(`QuestionPreviewPopover`) | — | 범위 밖: 발문 앞부분 미리보기. `displayStem`만 공유한다 | — | QOV-01, QPLAY-01-AC13 |
| — | DOC-02·공유 문서 화면의 "가져온 문제 형식"(본문 안에 펼쳐 보이는 문제) | — | 범위 밖: popup이 아니라 본문 안 렌더링. 문제 본문 부품(`QuestionBody` — 발문·번호 붙은 보기·접힌 정답·해설)만 공유한다 | — | DOC-02-AC11 |
| — | 문제 변형 출제의 보기 섞기 미리보기(QGEN-01) | — | 없앴다(QGEN-RM 2026-11-02) | — | — |

- **modal vs non-modal:** 새 범위 풀이(7·8)는 사용자 요청의 "팝업"에 맞춰 1과 같은 modal `FloatingSidePanel`(데스크톱 오른쪽 500px, 모바일 bottom sheet)로 한다 (사용자 결정 2026-11-01). 게스트 미리보기(6)는 지금처럼 non-modal로 남긴다 — 공유 화면 AC가 문제 목록과 panel을 함께 쓰는 동작을 전제한다. 4·5의 "문제 상세"는 UX7-BANK-2가 만든 대로 다른 panel·dialog 위의 modal `ModalDialog`로 남는다(QuestionViewer `manage`가 그 안을 그린다).
- 방식마다 header 동작: `practice`·`sequence(bank)`는 즐겨찾기·다시 풀기 toggle(QPLAY; 합쳐진 중복이 있으면 끄기는 기존 my-state PATCH 그대로 — 합쳐진 중복의 flag도 함께 꺼짐, questions.md §10.2)과 1a의 `문제 관리`/`문제 정보` 메뉴, `sequence(mock)`는 toggle·메뉴 없음(모의고사 문제는 개인 상태가 없음, 사용자 결정 2026-11-01), `manage`는 호출 위치가 넘긴 동작(4: 없음, 5: `보관 해제`/`확정`·`편집`·`삭제`, 9: `편집`·`빼기`), `read-only`는 없음. 보관된 Workspace의 `practice`는 toggle 없이 `문제 정보` 메뉴만 보인다(QPLAY-01 "메뉴").
- **해설 하이라이트 (UX9-SPEC 2026-11-02, [HILITE-01](highlights.md)):** `practice`·`sequence(bank)`의 제출 결과 해설과 `manage`("문제 상세" dialog — 호출 위치 4·5)의 해설은 공통 `HighlightableText` + `HighlightMenu`이다(AIEXPL-01이 merge되면 그 AI 해설 글도). `sequence(mock)`·`manage(mock)`(9)·`read-only`(6, 공유 게스트)·`수정 이력`의 지난 버전 미리보기에는 하이라이트가 없다(사용자 결정 2026-11-02, HILITE-01). 하이라이트는 해설이 보인 뒤에만 불러오고 practice·묶음 API 응답에는 없다(HILITE-01-C07). 보관된 Workspace에서도 하이라이트 메뉴 전체를 쓴다(사용자 결정 2026-11-02 (i) — 하이라이트만 보관 Workspace 쓰기 예외).
- **AI 질문·AI 해설·관련 본문 (ASK-SPEC 2026-11-01 사용자 결정, ASK-SYNC 2026-11-02 — 구현은 ASK-Q·EXPL-W·RELSRC-W, 기준 명세 [ASK-01](ask-llm.md) "문제 쪽 진입점"·[AIEXPL-01](ai-explanations.md)·[RELSRC-01](related-sources.md)):** QuestionViewer가 방식별로 그린다. 이 화면의 AC(QVIEW-01-AC01~AC09)는 바뀌지 않는다. 문제의 그림은 보기 위에 보인다(`read-only` 제외, [UX12-REEXTRACT](ux12-reextract.md)). "관련 본문"은 접힌 채로 나오고 펼칠 때 불러온다(RELSRC-01, 사용자 결정 2026-11-04).
  - `질문하기`: `manage`(호출 위치 4·5)의 footer, `sequence(mock)`·`manage(mock)`(8·9)의 header. `practice`(1~3)·`sequence(bank)`(7)·`read-only`(6)에는 없다. 기능 꺼짐·보관된 Workspace에서는 없다.
  - 제출 결과 아래(문제 본문 부품의 결과 영역 바로 아래, footer 위): `AI 해설`(AIEXPL-01) → "관련 본문"(RELSRC-01). `practice`·`sequence(bank|mock)`는 제출 뒤(`이전`·결과 목록으로 돌아간 읽기 전용 결과 포함), `manage`는 해설 아래 제출 없이, `read-only`는 이미 있는 것만 읽기 전용. AI 해설 완료 상태의 `AI 질문하기`는 `practice`·`sequence`에서 그 위치의 제출한 session을 첨부한다(`full`).
  - AI 질문 panel(`?panel=ask`)은 이 화면의 modal panel 위 층으로 열리고 닫혀도 묶음의 위치·진행·고른 답을 바꾸지 않는다. `?panel=ask`는 AC09의 `question`↔`practice` 배타와 무관하다(ASK-01 "panel 쌓기·뒤로가기").
  - 정답이 든 AI 해설·관련 본문은 `practice`·`sequence`의 session cache(UX7-CACHE)에 넣지 않는다(제출 결과와 같음).
- **문제 원문 보기 (QSRC-SPEC 2026-11-04, [QSRC-01](question-source-preview.md) — 구현은 QSRC-UI·QSRC-W):** 문제 본문 부품 header(번호·유형 badge 줄) 끝의 `문제 원문 보기` 버튼. `practice`(1~3)·`sequence(bank)`(7)·`manage`(4·5)·`sequence(mock)`·`manage(mock)`(8·9)에서 그 문제(모의고사는 원본 문제)에 가져오기 출처 영역이 있을 때만 보이고, `read-only`(6, 공유 게스트)에는 없다. 제출 전·후 같다. 열린 원문 dialog는 문제 panel 왼쪽(< 768px는 전체 화면 sheet)에 같은 modal 층의 맨 위로 쌓여 Escape가 먼저 닫고, 이전·다음으로 위치를 바꾸면 닫힌다. 이 화면의 AC(QVIEW-01-AC01~AC09)는 바뀌지 않는다.
- 문제 본문 부품은 모든 방식이 같다: 번호, 장, 유형 badge, 발문, 번호 붙은 보기(`1.` `2.` … 표시용, `aria-hidden`), 답 입력, 결과 영역(`role="status"`, 글자로 "정답"·"오답"·"채점 대기"), 정답·해설.

**모든 방식이 지켜야 하는 UX7 동작 (기존 AC GREEN 유지, MOCK-SYNC):**

- **표시 (QPLAY-01-AC13, UX7-QDISPLAY):** 발문은 모든 방식(미리보기·`practice`·`sequence`·`manage`·`read-only`, 모의고사 문제 포함)에서 `displayStem`으로 끝의 빈 답 괄호만 숨긴다(저장값·편집기 입력값·API 값은 그대로). 보기 목록 위 `보기` 글자는 보이지 않고 radiogroup·목록의 접근 가능한 이름으로만 남는다(kit `RadioGroup` `hideLabel`, 복수 정답은 "정답을 모두 고르세요" + 숨긴 `보기`).
- **채점 결과 테두리 (QPLAY-01-AC12, UX7-QDISPLAY):** 객관식 결과를 보이는 모든 곳 — `practice`, `sequence(bank|mock)`의 제출 직후, `이전`·결과 목록으로 돌아간 읽기 전용 결과 — 은 같은 표시를 쓴다: 맞힘 = 고른 보기 `--color-success`, 오답 = 고른 보기 `--color-border-strong` + 정답 보기 `--color-danger`, 행마다 체크/X 아이콘과 보이지 않는 "정답"·"내 선택"·"정답 · 내 선택" 글자(`aria-describedby`, UX12 VIEW-2 — [UX12-OPTIONS](ux12-options.md)), 제출 전후 같은 두께·같은 위치(레이아웃 이동 없음). `manage`·`read-only`의 정답 표시는 채점 결과가 아니므로 기존 "정답" 글자 + 체크 아이콘 그대로다.
- **열어 본 문제 client cache (QPLAY-01-AC06, UX7-CACHE):** `practice` 방식은 지금처럼 이번 화면에서 연 정답 없는 session을 메모리에 보관한다(화면 인스턴스·Workspace 단위, TTL 10분, 200개, browser storage 없음, 제출 시작·실패·만료 session 버림, 제출 결과 미보관, 이웃 prefetch 없음 — 열기 = 열람 기록). `sequence`가 같은 cache를 쓰면 같은 규칙을 따르고, 묶음 안 위치(`practice_run_id`, position)를 key에 넣어 묶음 밖 `practice` session과 섞지 않는다. `manage`·`read-only`의 정답이 든 내용은 cache하지 않는다.
- **정답 보기는 풀이가 아님 (QPLAY-01-AC09, UX7 확인 7):** 4의 "문제 상세"를 열고 닫아도 아래 `practice`(또는 `sequence`)의 고른 답·session은 그대로이고 그대로 제출된다. `sequence`에서는 4의 메뉴를 열 수 있어도 묶음 진행·결과를 바꾸지 않는다.
- **뒤로가기·URL state (QOV-01-AC14, UX7-BACK·UX7-BACK-2):** 새 URL state `?practice=new&source=…`·`?practice=<id>&i=<n>`·`?panel=mock-exams`(`&mock=new|<id>`)도 홈 dialog 기록 규칙을 그대로 따른다: 열면 기록 항목 하나, 열린 동안 뒤로가기 한 번 = 맨 위 dialog 하나 닫기, 닫힌 dialog는 뒤로가기·앞으로가기 어느 쪽으로도 다시 열리지 않음, 닫으면 열기 전 주소로 돌아가되 열린 동안 바꾼 필터·검색어는 유지, 딥링크·새로 고침으로 열린 dialog도 뒤로가기 한 번에 하나씩 닫힘. 묶음 안 `이전`·`다음`(`i` 변경)은 풀이 panel의 이전/다음처럼 dialog 닫기가 아니다: 뒤로가기는 panel을 연 채 앞 위치로, 앞으로가기는 다시 뒤 위치로 간다. **풀이 panel(`?question=`)과 범위 풀이(`?practice=`)는 동시에 열리지 않는다 (사용자 결정 2026-11-02, AC09):** 하나를 열면 다른 하나는 닫힌다 — `?question=`을 여는 모든 곳(Heatmap marker, 이력·정리 노트 각주 링크)은 열린 범위 풀이를 닫고, `문제 풀기`로 범위 고르기를 열거나 묶음(`?practice=<id>`)을 열면 열린 풀이 panel을 닫는다. 이 바꾸기는 "닫기 한 번 + 열기 한 번"이다: 닫힌 쪽은 위 규칙대로 뒤로가기·앞으로가기 어느 쪽으로도 다시 열리지 않고, 새로 연 panel은 기록 항목 하나라 뒤로가기 한 번이 그것을 닫는다(그 아래 열려 있던 non-modal dialog는 다음 뒤로가기가 닫는다). 둘 다 modal이라 화면에서는 한쪽이 열린 동안 다른 쪽을 여는 버튼에 닿지 않으므로, 이 규칙은 주로 URL로 들어올 때 보인다. 두 매개변수를 함께 가진 주소(딥링크·북마크)는 서버가 `question`을 뺀 주소로 바꾸어(redirect) 범위 풀이만 연다 (사용자 결정 2026-11-02: 범위 풀이(`문제 풀기`)가 더 나중의 의도라고 보고 `?practice=`를 남김). 모의고사 `manage`(9)도 modal이라 둘 중 어느 것과도 함께 열리지 않는다; `?panel=mock-exams`는 다른 non-modal 홈 dialog와 쌓인다(QOV-01-AC10). (사용자 결정 2026-11-02) 범위 고르기에서 `시작`해 `practice=new`가 `practice=<id>`로 바뀌는 것, `결과 보기`, `처음부터 다시`는 같은 dialog 안의 단계 전환이라 기록 항목을 **바꾸고**(replace) 새로 쌓지 않는다 — 시작한 뒤 뒤로가기 한 번이 범위 고르기로 돌아가지 않고 panel을 닫는다. 모의고사 dialog 안의 목록 → 만들기·상세 전환(`mock=`)은 `이전`·`다음`처럼 항목을 쌓아 뒤로가기가 dialog를 연 채 목록으로 돌아간다(`BackLink` "모의고사 목록"과 같은 결과).

## 레이아웃 및 컴포넌트

- **진입 (bank):** Workspace header `문제` 메뉴에 `문제 풀기` 항목(모든 구성원; 보관된 Workspace에서도 보임) (사용자 결정 2026-11-01). 메뉴 항목은 `requiresEdit: false`(UX7-DOCS-2 패턴)라 보기 권한·보관된 Workspace에서도 활성이고 이유 글자가 붙지 않는다 — 위치는 구분선 아래 보기 권한 항목 묶음(`보관·초안 문제`·`모의고사`·`문제 풀기`, QOV-01 "Workspace header"). 누르면 QuestionViewer가 범위 고르기 단계로 바로 열리고(`?practice=new&source=bank`) 목록을 불러오는 동안 skeleton(QOV-01-AC09 규칙).
- **진입 (mock):** 모의고사 행·상세의 `풀기`(MOCK-01). 범위 고르기 단계는 그 모의고사의 문제만 보이고(출처 장별 묶음) 처음에 모두 선택되어 있다. 출처 장별 묶음 (사용자 결정 2026-11-02, MOCK-W-3): 등록 문제와 같은 장 그룹 `QuestionRangePicker`(tri-state `전체 선택`, 장 checkbox·펼치기, 긴 장 virtualize)이고, 장은 원본 문제의 지금 장(API `source.chapter`, MOCK-01-C10 — 출처 글자 "3장 12번"의 장과 같음)이며 생성 계획의 장 순서(`chapter_rank`, 만들 때의 Heatmap 순서)로 놓인다. 원본에 장이 없거나 원본이 삭제된 문제는 맨 뒤 "챕터 없음" 묶음이다. 문제 행은 모의고사 안 번호 "문제 k · 발문 앞 40자 · 유형"이고 상태 필터는 없다(모의고사 문제는 개인 상태가 없음). `시작`은 장 전체를 고른 것도 그 문제들의 id(`question_ids`)로 보낸다 — 모의고사 묶음 범위는 `chapter_ids`를 받지 않으므로(422 `range-invalid`, MOCK-P) 범위 API는 그대로다. 전부 고르면 `all`.
- **범위 고르기 단계:** 제목 "문제 풀기"(mock이면 "<모의고사 이름> 풀기").
  - 필터 줄(접힘 가능, 홈 상태 필터와 같은 칩) → `QuestionRangePicker`. 목록은 Heatmap에 보이는 문제와 같다: 보관된 문제(중복 정리로 보관된 중복 포함)·초안은 없고, 풀이 상태·즐겨찾기·다시 풀기 필터는 합쳐진 중복의 기록까지 합친 상태로 판정한다(Heatmap marker와 같은 상태, C07).
  - `QuestionRangePicker`: 맨 위 `전체 선택` checkbox(지금 필터에 보이는 문제 전체; 일부만 선택이면 `aria-checked="mixed"`), 장 그룹마다 장 checkbox(장 제목·문제 수, 일부 선택 = mixed)와 펼치기 버튼(`aria-expanded`), 펼치면 문제 checkbox 목록("12번 · 발문 앞 40자 · 유형", 번호가 없으면 "번호 없음 · …"; UX12-NUMBER). 필터를 바꾸면 보이지 않게 된 문제는 선택에서 빠진다(선택 = 보이는 문제 중에서만). 아래 "선택 n문제" 글자.
  - `무작위 순서` checkbox(기본 꺼짐, 시작할 때마다 다시 고름 — 기억하지 않음).
  - `시작`(선택 0이면 비활성 + 이유 "풀 문제를 고르세요").
- **풀이 단계:** header: 제목(문제 번호 "12번", 번호가 없으면 "번호 없음"; UX12-NUMBER / 모의고사는 "문제 k"), 진행 "k / n"(공통 `ProgressBar`, 값 글자 "n문제 중 k번째"), 방식별 toggle, 닫기. 본문: 문제 본문 부품. footer: `제출`(답이 없으면 비활성) → 결과 후 `다음`(마지막이면 `결과 보기`), `이전`, `건너뛰기`(제출 없이 다음; 결과 요약에서 "건너뜀"). `이전`·`다음`·`건너뛰기`는 화살표 버튼이고 첫 위치의 `이전`은 `aria-disabled`다(UX12-VIEW-AC01). 서술형·자동 채점 불가 단답은 QPLAY와 같이 `PENDING` 후 자기평가(맞음/틀림).
- **결과 단계:** 위 "끝과 결과 요약"·"처음부터 다시". `처음부터 다시`, `닫기`.
- 반응형: 375px에서 가로 스크롤 없음, 모바일 bottom sheet `max-height: 90dvh`, footer 버튼은 줄바꿈.

## 화면 상태

| 상태 | 표시 |
|---|---|
| 범위 불러오는 중 | 즉시 열린 panel + skeleton(`aria-busy`, "불러오는 중") |
| 확정 문제 없음(bank) | "아직 확정된 문제가 없습니다." `시작` 없음 |
| 필터에 맞는 문제 없음 | "조건에 맞는 문제가 없습니다." + `필터 초기화`, `시작` 비활성 |
| 문제 불러오는 중 | 본문 skeleton, 진행 막대 유지 |
| 묶음 도중 문제가 삭제·보관됨(bank — 중복 정리로 보관된 경우 포함) 또는 모의고사에서 빠짐(mock) | "이 문제는 더 이상 풀 수 없습니다." + `다음` (결과 요약에서 "건너뜀") |
| 모의고사 삭제됨·다시 만들어 문제가 바뀜 | 묶음은 시작할 때의 문제로 계속 풀 수 있다(사용자 결정 2026-11-01); 삭제된 모의고사의 묶음은 "모의고사를 찾을 수 없습니다."(404) |
| 제출 실패(네트워크) | 답 유지 + alert "제출하지 못했습니다. 다시 시도하세요." |
| 보관된 Workspace | 범위 고르기·보기는 가능, `제출` 비활성 + "보관된 Workspace에서는 답안을 제출할 수 없습니다."(API 403 `workspace-archived`) |
| 다른 Workspace·다른 사용자의 묶음 딥링크 | "풀이를 찾을 수 없습니다."(404; 묶음은 만든 사용자만) |
| 공유 링크 게스트 | `문제 풀기`·`?practice=` 없음(사용자 결정 2026-11-01), 게스트 미리보기(호출 위치 6)는 그대로 |

## 접근성

- modal panel: Radix focus trap, 제목·설명 연결, Escape·닫기로 닫고 연 버튼(메뉴 항목이면 `문제` 메뉴 버튼, 행의 `풀기`)으로 focus 복귀.
- 문제가 바뀌면 focus는 문제 제목(heading, `tabIndex=-1`)으로 가고, 진행 "n문제 중 k번째"를 `aria-live="polite"`로 알린다. 결과는 `role="status"` 글자로 알리고 색만으로 전달하지 않는다.
- 범위 checkbox 목록: native checkbox(또는 Radix Checkbox)로 Space 토글, mixed 상태 `aria-checked="mixed"`, 장 펼치기는 별도 버튼. 목록은 roving 없이 Tab 순서(장 checkbox → 펼치기 → 문제 checkbox).
- `prefers-reduced-motion`에서 panel·진행 막대 움직임 없음. 결과·정답 영역은 hover 없이 보인다(터치 동등).
- **품질 suite (MOCK-X):** axe `A11Y-15`(`tests/e2e/quality/a11y-mock.spec.ts`, light·dark)가 범위 고르기(`전체 선택` mixed, 상태 필터, 80문제를 넘어 virtualize된 장)·풀이·채점 뒤·결과 단계와 모의고사 출처(`sequence(mock)`)의 출처 장별 범위 고르기(펼친 장)·풀이를 검사하고, 키보드만으로 `문제` 메뉴 → 범위 → `시작` → 제출 → `결과 보기`까지 가는 흐름을 확인한다. visual `VISUAL-07`은 범위 고르기와 결과 요약만 찍는다(채점 뒤 정답·해설 상태는 찍지 않음, 결과 요약은 정답 보기 없이 결과 글자만 있음).

## 수용 기준

### QVIEW-01-AC01

- **Given:** 두 장(1장 3문제, 2장 2문제)의 확정 문제와 초안 2개가 있는 Workspace 홈(보기 권한 구성원)
- **When:** header `문제` 메뉴에서 `문제 풀기`를 고른다
- **Then:** modal panel "문제 풀기"가 데이터 응답 전에 열리고(`?practice=new&source=bank`, skeleton → 내용) 장 그룹 2개와 `전체 선택`, `무작위 순서`(꺼짐), `시작`(비활성, "풀 문제를 고르세요")을 보인다. 초안은 목록에 없다. 장 그룹을 펼치면 그 장의 문제 checkbox가 "1번 · <발문 앞부분>" 형식으로 보인다. Escape로 닫으면 focus가 `문제` 메뉴 버튼으로 돌아오고 `practice`가 URL에서 빠진다.

### QVIEW-01-AC02

- **Given:** AC01의 범위 고르기 단계
- **When:** `전체 선택`을 누르고, 1장 문제 하나를 해제하고, 상태 필터 `틀린 문제`를 켜고, 필터를 끈 뒤 다시 `전체 선택`을 누르고 다시 한 번 누른다
- **Then:** 처음 `전체 선택`으로 "선택 5문제"가 되고 모든 장 checkbox가 선택된다. 문제 하나를 해제하면 `전체 선택`과 1장 checkbox가 `aria-checked="mixed"`, "선택 4문제"다. 필터를 켜면 보이는 문제(틀린 문제)만 남고 선택도 그 안으로 줄며 `전체 선택`은 보이는 문제만 고른다. 필터를 끄고 `전체 선택`을 누르면 다시 5문제, 한 번 더 누르면 0문제와 비활성 `시작`이다. 키보드(Tab·Space)만으로 같은 조작이 된다.

### QVIEW-01-AC03

- **Given:** 5문제를 고른 범위 고르기 단계
- **When:** `무작위 순서`를 끈 채 `시작`하고 두 번째 문제까지 간 뒤 새로 고침한다. 닫고 다시 `문제 풀기`에서 같은 5문제를 `무작위 순서`를 켜고 시작한다(fake seed 고정)
- **Then:** 꺼진 묶음은 Heatmap 순서(1장 1·2·3번, 2장 1·2번)로 보이고 진행이 "5문제 중 2번째"이며 URL은 `?practice=<id>&i=2`다. 새로 고침해도 같은 문제·같은 진행이다. 켜진 묶음은 서버가 정한 다른 순서이고(같은 5문제, 중복 없음) 새로 고침해도 그 순서가 유지된다. 진행 막대는 값 글자를 갖고 문제가 바뀔 때 진행이 화면 낭독기에 알려진다.

### QVIEW-01-AC04

- **Given:** 객관식(보기 섞임)·단답·서술형이 섞인 등록 문제 묶음, Heatmap에서 처음 문제는 "안 본 문제"
- **When:** 첫 문제가 보인 뒤 제출 전 `GET /practice-runs/{id}/items/1`·practice session 응답을 확인하고, 오답을 제출하고, `다음`, 서술형은 제출 후 자기평가, `이전`으로 첫 문제로 돌아간 뒤 panel을 닫는다
- **Then:** 제출 전 응답과 화면에 정답·해설이 없다. 제출하면 결과 글자 "오답", 정답(보기 번호와 문구)과 해설이 보이고 채점은 option ID 기준이다(섞인 표시 순서와 무관). 서술형은 "채점 대기" 뒤 자기평가로 확정된다. `이전`으로 돌아간 첫 문제는 제출한 답·결과를 읽기 전용으로 보이고 `제출`이 없다. 닫은 뒤 Heatmap에서 첫 문제 marker는 오답 상태(접근성 이름·미리보기에 "오답"), 보기만 하고 건너뛴 문제는 "본 문제"다.

### QVIEW-01-AC05

- **Given:** 문제 10개의 Heatmap(1장 4개·2장 3개·장 없음 3개)과 그중 1장 2개·2장 1개·장 없는 1개를 원본으로 만든 4문제 모의고사(MOCK-01)
- **When:** 모의고사 행의 `풀기` → 범위 고르기에서 `챕터 없음` 묶음을 해제하고 `무작위 순서`를 켜고 `시작` → 3문제를 모두 제출하고 `결과 보기`
- **Then:** 범위 고르기는 그 모의고사의 문제 4개만 처음부터 모두 선택된 상태로 출처 장별 묶음("1장 … · 2문제", "2장 … · 1문제", "챕터 없음 · 1문제" 순)으로 보이고(`전체 선택` checked), 해제 후 "선택 3문제"이며 `시작` 요청의 범위는 `chapter_ids` 없이 `question_ids` 3개다. 풀이 단계는 등록 문제와 같은 본문·footer를 쓰고 즐겨찾기·다시 풀기 toggle이 없다. 제출 결과·정답·해설은 AC04와 같다. 끝나면 Heatmap marker 10개의 상태·문제 수와 `question_attempts`는 그대로이고, 풀이는 모의고사 문제의 기록으로만 남는다(`mock_exam_attempts` 3건).

### QVIEW-01-AC06

- **Given:** 5문제 묶음에서 2문제를 제출(정답 1·오답 1)하고 1문제를 건너뛰고 2문제는 서술형으로 채점 대기인 상태
- **When:** 마지막 문제 뒤 `결과 보기`를 누르고, 결과 목록의 두 번째 문제를 누른 뒤 `처음부터 다시`를 누른다
- **Then:** 결과 단계는 "맞음 1 · 틀림 1 · 채점 대기 2 · 건너뜀 1"과 문제별 결과 글자 목록을 보인다(색만으로 구분하지 않음). 목록의 문제를 누르면 그 위치의 읽기 전용 결과로 간다. `처음부터 다시`는 이전 묶음의 아직 풀 수 있는 문제(여기서는 5문제 모두)·같은 무작위 설정의 새 묶음을 "5문제 중 1번째"부터 시작하고 이전 묶음의 풀이 기록은 바뀌지 않는다.

### QVIEW-01-AC07

- **Given:** 보관된 Workspace(편집 권한자), 다른 사용자가 만든 묶음 id, 공유 링크 게스트
- **When:** 보관된 Workspace에서 `문제 풀기`로 묶음을 시작해 답을 고르고, 다른 사용자의 `?practice=<id>`를 열고 `GET /practice-runs/{id}`를 부르고, 게스트가 `/share/:shareId`를 연다
- **Then:** 보관된 Workspace에서는 범위 고르기·시작·문제 보기는 되지만 `제출`이 비활성이고 "보관된 Workspace에서는 답안을 제출할 수 없습니다."를 보인다(직접 submit은 403 `workspace-archived`). 다른 사용자의 묶음은 "풀이를 찾을 수 없습니다."이고 API는 404다. 게스트 화면에는 `문제 풀기`가 없고 문제 미리보기는 기존처럼 non-modal 읽기 전용이다.

### QVIEW-01-AC08

- **Given:** 3문제 묶음을 시작한 뒤 편집 권한자가 두 번째 문제를 삭제했고, 필터에 맞는 문제가 없는 범위 조건
- **When:** 묶음에서 두 번째 문제로 가고, 새 `문제 풀기`에서 `다시 풀기만` 필터를 켠다(다시 풀기 문제 없음)
- **Then:** 두 번째 위치는 "이 문제는 더 이상 풀 수 없습니다."와 `다음`을 보이고 결과 요약에서 "건너뜀"으로 센다. 필터에 맞는 문제가 없으면 "조건에 맞는 문제가 없습니다."와 `필터 초기화`를 보이고 `시작`은 비활성이다. 서버에 직접 빈 범위로 시작하면 409 `no-matching-questions`이고 묶음은 생기지 않는다.

### QVIEW-01-AC09

- **Given:** 확정 문제 2개가 있는 Workspace(Owner), 그 문제들로 만든 묶음, 그 전에 Workspace 목록을 연 기록
- **When:** `?practice=<id>&i=2&question=<1번 문제>` 주소로 들어와 뒤로가기·앞으로가기를 누르고; `?question=<2번 문제>&practice=new&source=bank`로 들어와 `전체 선택` → `시작` → 건너뛰기 → `결과 보기` → 결과 목록의 첫 문제를 누른다
- **Then:** 두 매개변수를 가진 주소는 범위 풀이 panel 하나만 연다("2문제 중 2번째"; 풀이 panel은 렌더링되지 않고 URL에 `question`이 없다 — 사용자 결정 2026-11-02). 뒤로가기 한 번이 그 panel을 닫고 아무 panel도 남지 않으며, 앞으로가기는 어느 panel도 다시 열지 않는다. 범위 고르기 주소도 범위 고르기 panel 하나만 연다. 결과 목록의 문제는 그 묶음의 위치(`i=1`, "2문제 중 1번째")를 열고 `?question=`·풀이 panel을 열지 않는다(열린 modal panel 하나). 한쪽을 연 채 다른 쪽을 여는 URL 전환(닫기 + 열기, 뒤로가기·앞으로가기로 닫힌 쪽이 돌아오지 않음)은 `apps/web` Vitest(panel-history·home URL)로 확인한다. (사용자 결정 2026-11-02)

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/questions/practice_runs/test_practice_runs_contract.py`, `packages/ui`·`apps/web` Vitest, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| QVIEW-01-C01 | **범위 확정:** `POST /workspaces/{id}/practice-runs`(`source=bank`, `range{all, chapter_ids[], question_ids[], excluded_question_ids[], filters}` — `전체 선택`·장 선택은 id 목록 대신 `all`·`chapter_ids`로 보내고 개별 id 목록은 각각 5,000개 이하, `random_order`, `Idempotency-Key`)는 서버에서 범위를 이 Workspace의 살아 있는 CONFIRMED 문제로만 푼다(필터의 풀이 상태·즐겨찾기는 요청한 사용자 기준, Heatmap과 같은 판정). 다른 Workspace·초안·보관·삭제 문제 id는 범위에서 조용히 빠지지 않고 422 `range-invalid`로 거절한다. 결과 0개면 409 `no-matching-questions`, 5,000개 초과 422 `practice-run-too-large`(5,000개는 허용 — 경계 test). client가 보낸 `workspace_id`·`user_id`는 쓰지 않는다. |
| QVIEW-01-C02 | **순서·크기:** `random_order=false`면 Heatmap 순서, `true`면 `random.Random(seed).shuffle`(seed 미지정 시 서버가 정해 저장). 같은 seed·같은 범위 → 같은 순서. 묶음의 `item_ids`(순서 고정 uuid 배열, 5,000개 ≈ 80 KB)·seed는 생성 후 바뀌지 않는다. `GET /practice-runs/{id}`는 내용 없이 개수·진행·요약 집계만, `/items/{position}`은 한 문제만, `/results?offset&limit`(≤200)은 결과 목록 한 페이지를 돌려준다 — 5,000문제 묶음에서도 응답 크기가 문제 수에 비례하지 않는다(크기 test). 이어 풀기 URL은 `?practice=<id>&i=<position>`(1~5,000) 그대로다. |
| QVIEW-01-C03 | **정답 비노출:** `GET /practice-runs/{id}`·`/items/{position}`과 묶음에서 여는 practice session은 제출 전 정답·허용 답안·채점 기준·해설을 보내지 않는다(응답 schema test + 항목마다 key 검사). 제출 응답에서만 그 문제의 정답·해설을 보낸다. |
| QVIEW-01-C04 | **기록:** `bank` 묶음의 세션·풀이는 기존 `practice_sessions`·`question_attempts`에 `practice_run_id`와 함께 기록되어 `question_user_states`·Heatmap에 반영된다. `mock` 묶음은 `mock_exam_practice_sessions`·`mock_exam_attempts`에만 기록되고 `question_*` 테이블은 바뀌지 않는다(행 수 비교 test). 묶음 안 문제마다 제출 1회(두 번째 제출 409 `already-submitted`); 풀이 기록은 UPDATE·DELETE 불가(pgTAP). |
| QVIEW-01-C05 | **인가 matrix:** 묶음은 만든 사용자만 읽고 쓴다(다른 사용자·다른 Workspace 404). 모든 구성원(viewer 포함)이 만들고 풀 수 있고, 보관 Workspace는 만들기·읽기 가능·제출 403 `workspace-archived`, 삭제 Workspace 404. 공유 세션(게스트)은 묶음 API에 접근할 수 없다(401/404). |
| QVIEW-01-C06 | **컴포넌트 계약(Vitest):** `QuestionViewer`는 방식 `practice`·`sequence`·`manage`·`read-only`를 갖고, `read-only`·`manage`는 제출 UI를 렌더링하지 않으며, `sequence(mock)`는 즐겨찾기·다시 풀기를 렌더링하지 않는다. 기존 호출 위치(홈 marker와 그 header 메뉴, 이력·정리 노트 링크, "문제 상세" dialog(풀이 panel 메뉴·보관·초안 문제 행), 공유 미리보기)는 모두 이 컴포넌트를 쓴다(이전 `PracticePanel`의 본문, `QuestionDetailDialog`·`RevisionView`의 본문, `shared-questions.tsx`의 문제 panel 본문을 대체; `QuestionManageMenu`·`QuestionMenu`·"문제 편집"·확인 dialog는 그대로 재사용). `displayStem`·`hideLabel`·채점 결과 테두리·session cache 규칙(위 "모든 방식이 지켜야 하는 UX7 동작")을 방식별로 검사한다. |
| QVIEW-01-C07 | **범위와 보관·중복 (MOCK-SYNC, UX7-BANK-2·UX7-DEDUP):** `quiz_api.question_ranges`는 Heatmap overview와 같은 판정을 쓴다 — 살아 있는 CONFIRMED 문제만(보관 ARCHIVED — 중복 정리로 보관된 중복 포함 — 과 초안 DRAFT는 범위 고르기 목록·`전체 선택`·장 선택에 없다), 풀이 상태·즐겨찾기·다시 풀기 필터는 요청한 사용자의 `question_merged_user_states`(합쳐진 중복까지 합친 상태, questions.md §10.2)로 판정해 Heatmap 필터와 같은 문제를 고른다. 보관·초안 문제 id를 직접 보내면 422 `range-invalid`(C01). 묶음을 만든 뒤 보관(중복 정리 포함)·삭제된 문제의 위치는 "이 문제는 더 이상 풀 수 없습니다."·건너뜀이다(AC08). `bank` 묶음의 제출은 그 문제(남길 문제)의 `question_attempts`·`question_user_states`에 기록되고 합친 상태는 view가 계산한다(기록을 옮기지 않음). Heatmap과 같은 결과를 내는지 같은 fixture로 비교하는 test. |
| QVIEW-01-C08 | **`다시 풀기` 아이콘 (UX9-SPEC, 사용자 결정 C10; Vitest + VISUAL-10):** `RetryToggle`(`packages/ui/src/questions/StudyToggles.tsx`)은 `RetryIcon` = 원 안의 물음표(꺼짐 윤곽선, 켜짐 채운 원 — `data-state` 별 SVG가 다름)를 그리고, 접근성 이름은 기존대로 "다시 풀기 표시"/"다시 풀기 해제"(둘 다 "다시 풀기"를 포함), `data-state="off|on"`, tooltip은 이름과 같다. **UX12 VIEW-2 개정 2026-11-06:** 켜진 toggle에는 selected 배경이 없고 아이콘의 fill·stroke 반전과 이름 변화가 상태를 전달한다([UX12-OPTIONS](ux12-options.md)). 이 toggle을 그리는 모든 방식(`practice`·`sequence(bank)`)이 같은 컴포넌트를 쓴다(이전 화살표 아이콘을 쓰는 곳이 없음 — import 검사). |
| QVIEW-01-C09 | **하이라이트 비노출 (UX9-SPEC):** `practice-sessions`·`submit`·`self-grade`·`practice-runs/{id}/items/{position}`·모의고사 practice 응답 schema에 하이라이트 필드가 없다(HILITE-01-C07과 같은 test). |
| QVIEW-01-C10 | **`다시 풀기`는 정답 뒤에만 (RETRY-CORRECT 2026-11-04):** `practice`·`sequence(bank)`의 `다시 풀기` toggle은 마지막 채점 결과가 정답인 문제에만 렌더링한다(비활성 아님). 규칙·AC·계약은 [RETRY-01](retry-correct.md)(C04가 Vitest). C06·C08의 "toggle을 그린다"는 이 조건 아래에서다. |

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 기존 QPLAY-01(AC01~AC13 — 특히 AC06 cache, AC09~AC11 메뉴·문제 상세·보관, AC12 결과 테두리, AC13 표시)·QOV-01-AC06·AC14·AC15·AC17·CHNOTE-01-AC02/AC05·WS-VIEW-01·HISTORY-01 테스트는 QVIEW-W에서 바꾸지 않고 GREEN으로 남아야 한다(회귀 기준). 테스트가 구현 컴포넌트 이름에 기대고 있으면 role/label locator로만 고친다.
