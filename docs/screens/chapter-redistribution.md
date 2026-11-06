# CHREDIST-01 — 챕터 재분배 Floating Dialog

**상태:** 확정 화면 요구사항 v1.0 · UX9-SPEC 신규 2026-11-02 (사용자 피드백 "'챕터 재분배' 기능 필요 — 여러 문제를 한 번에 챕터에 할당 — 자동 챕터 분배 재시도 기능", 사용자 결정 2026-11-02 C1·C2; 제안 (a)~(g)는 같은 날 사용자 결정 — (b)는 modal로 대체, HOMEDLG-01)
**Route:** `/workspaces/:workspaceId?panel=chapter-redistribution` (Workspace 홈 header `문제` 메뉴의 `챕터 재분배`가 여는 modal panel)
**테스트:** `tests/e2e/questions/chapter-redistribution.spec.ts` (계약: `tests/integration/questions/chapter_redistribution/test_chapter_redistribution_contract.py`, `apps/api` unit test, `supabase/tests` pgTAP)
**Phase:** UX9.0 (RED) → UX9-REDIST-B → UX9-REDIST-W
**연계:** [Questions 명세](../questions.md) §6 "챕터"(CHAPTER-MAP)·§14, [QOV-01](questions-overview.md), [CHNOTE-01](chapter-notes.md), [QVIEW-01](question-viewer.md) `QuestionRangePicker`, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: CHREDIST-01
route: /workspaces/:workspaceId?panel=chapter-redistribution
actor: editor/owner (활성 Workspace)
permission: edit
status: confirmed
api: [GET /api/v1/workspaces/:id/chapter-redistribution/questions, POST /api/v1/workspaces/:id/chapter-redistribution/preview, POST /api/v1/workspaces/:id/questions/chapter-assignments]
components: [FloatingSidePanel, QuestionRangePicker, Select, Checkbox, Button, Badge, ConfirmDialog, BackLink]
linked_tests: [CHREDIST-01-AC01 … CHREDIST-01-AC04]
```

## 목적과 정책

- **두 가지 일 (사용자 결정 2026-11-02 C1·C2):** (1) **직접 옮기기** — 여러 확정 문제를 골라 한 번에 한 챕터로 옮긴다. (2) **자동 추천 다시 받기** — 고른 문제(고르지 않았으면 전체)의 챕터를 서버가 CHAPTER-MAP 규칙으로 다시 추천하고(추천 → 미리보기 → 적용), 사람이 행마다 또는 전체를 확인한 뒤에만 적용한다. 미리보기는 아무것도 바꾸지 않는다.
- **대상:** Heatmap에 보이는 문제, 곧 이 Workspace의 살아 있는 `CONFIRMED` 문제만이다(questions.md §3.1). 초안(DRAFT)·보관(ARCHIVED, 중복 정리로 보관된 중복 포함) 문제는 목록에 없다 — 그 문제의 챕터는 지금처럼 `편집`(문제 편집 dialog)으로 바꾼다 (사용자 결정 2026-11-02).
- **옮길 수 있는 챕터:** Workspace의 살아 있는 책(`document_type = book`, 교재·교재+문제) 문서의 **현재 발행 revision** 챕터와 `챕터 없음`. 문제지(`question_paper`) 문서의 챕터로는 옮길 수 없다(CHAPTER-MAP: 문제는 교재 챕터 아래에 등록 — questions.md §6). 문제 편집 dialog의 `챕터` 목록과 같은 목록이다.
- **사람이 정한 챕터 (사용자 결정 C2):** 문제마다 챕터가 어떻게 정해졌는지(`questions.chapter_source`: `manual` 사람이 정함 · `auto` 자동 추천)를 기록한다(questions.md §14.1). 직접 옮기기는 `manual`로 만든다. 자동 추천 다시 받기는 기본으로 `manual` 문제를 건너뛰고 "직접 정한 챕터라 건너뜀 n개"를 보인다; `직접 정한 챕터도 다시 추천` checkbox(기본 꺼짐)를 켜야 그 문제들도 추천을 받는다. 추천을 적용한 문제는 `auto`다 (사용자 결정 2026-11-02).
- **문제 revision과 풀이 기록:** 챕터는 문제(`questions.chapter_id`)의 속성이고 문제 내용 revision(`question_revisions`)이 아니다. 옮겨도 새 revision이 생기지 않고 버전 번호·attempt·학습 상태(`question_user_states`)·즐겨찾기·다시 풀기는 그대로다. 옮김마다 `question_chapter_changes` 이력 행과 활동 기록(id·개수만)을 남긴다(questions.md §14.3).
- **다른 화면에 미치는 것:** Heatmap은 바로 다시 읽혀 문제가 새 챕터 그룹의 번호 순서 자리로 옮겨진다(같은 문제 번호가 한 그룹에 둘 있을 수 있다 — 번호는 바꾸지 않는다). 옮긴 문제가 있던 장과 새 장의 정리 노트는 "문제가 바뀌어 최신이 아닙니다" stale이 된다(CHNOTE-01-C03의 "장 이동" — 이미 있는 규칙). 이미 만든 범위 풀이 묶음(`practice_runs.item_ids`)과 모의고사 문제는 바뀌지 않는다(모의고사 범위 고르기의 출처 장 묶음은 원본의 지금 장 — MOCK-01-C10 — 이므로 새 장으로 보인다). 문제의 `내 하이라이트`는 문제를 따라 새 장의 정리 노트로 간다(HILITE-01).

## 레이아웃 및 컴포넌트

- **진입 (QOV-01 Workspace header):** `문제` 메뉴의 첫 묶음 `직접 추가` · `중복 문제 정리` 다음에 `챕터 재분배`(`requiresEdit: true`). 보기 권한·보관된 Workspace에서는 다른 편집 항목과 같이 비활성(`aria-disabled="true"`, 화살표 키에서 건너뜀)이고 메뉴 안 이유 글자("편집 권한이 있어야 사용할 수 있습니다" / 보관 우선 "보관된 Workspace는 읽기 전용입니다", `aria-describedby`)를 보인다(UX7-DOCS-2 패턴). 그들이 `?panel=chapter-redistribution`으로 와도 dialog는 열리지 않는다.
- **panel:** 공통 `FloatingSidePanel` **modal** "챕터 재분배"(사용자 결정 2026-11-02 — 처음 제안 (b) non-modal을 대체: 모든 홈 dialog가 modal, [HOMEDLG-01](home-dialogs.md); focus trap, 배경 `inert`, 열고 닫아도 홈 배치 그대로, QOV-01 4의 뒤로가기 규칙). 즉시 열리고 목록을 불러오는 동안 skeleton "문제를 불러오는 중입니다."(QOV-01-AC09), 실패하면 role=alert와 `다시 시도`, 확정 문제가 없으면 빈 상태 "옮길 확정 문제가 없습니다". 확인 dialog는 이 panel 위에 쌓인다.
- **1단계 — 목록 (기본):**
  - `QuestionRangePicker`(QVIEW-01과 같은 부품): 맨 위 `전체 선택`(tri-state, 일부 선택 `aria-checked="mixed"`), Heatmap 순서의 챕터 그룹마다 장 checkbox(장 제목 · 문제 수, 그 장 전체 선택)와 펼치기 버튼(`aria-expanded`), 펼친 장의 문제 checkbox 행 "12번 · 발문 앞 40자 · 유형"(`displayStem`). `chapter_source = manual`인 행은 "직접 정함" 글자 badge를 단다. "챕터 없음" 그룹도 있다(맨 뒤). 긴 장은 virtualize(5,000문제까지). 아래 "선택 n문제" 글자(`aria-live="polite"`).
  - **직접 옮기기 줄:** `옮길 챕터` `Select`(문서 이름별 그룹, 장 제목 들여쓰기, 맨 위 `챕터 없음`) + `이동 (n)` 버튼. 선택 0이거나 챕터를 고르지 않았으면 `이동`은 비활성이고 이유 글자("옮길 문제를 고르세요" / "옮길 챕터를 고르세요", `aria-describedby`). 고른 문제 중 이미 그 챕터인 문제는 세지 않는다("n문제 중 k문제는 이미 이 챕터입니다" 글자).
  - **자동 추천 줄:** `직접 정한 챕터도 다시 추천` checkbox(기본 꺼짐, 열 때마다 꺼짐) + `자동 추천 보기` 버튼(선택이 있으면 "선택한 n문제", 없으면 "전체 문제"라고 버튼 옆 글자로 범위를 알림).
  - `이동`은 확인 dialog(`ConfirmDialog`) "문제 n개를 <챕터>로 옮길까요?"(설명: "옮긴 장과 새 장의 정리 노트가 최신이 아니게 됩니다. 문제 내용과 풀이 기록은 바뀌지 않습니다.")를 거친다 (사용자 결정 2026-11-02). `옮기기`를 누르면 한 요청으로 옮기고 알림 "문제 n개를 <챕터>로 옮겼습니다."를 보인 뒤 목록·Heatmap·열린 정리 노트 panel을 다시 읽는다. 선택은 비운다.
- **2단계 — 추천 미리보기:** `자동 추천 보기`를 누르면 같은 panel이 미리보기 단계로 바뀌고(위에 `BackLink` "목록으로") "추천을 계산하는 중입니다." skeleton 뒤:
  - 요약 글자: "바뀔 문제 k개 · 그대로 u개 · 추천 없음 r개 · 직접 정한 챕터라 건너뜀 m개"(0인 항목은 뺌). 추천 없음은 이유별 개수를 펼치기로 보인다: "출처가 없음"·"출처의 장을 찾을 수 없음"·"교재 장과 맞는 제목 없음"·"맞는 장이 여럿".
  - **바뀔 문제만** 행으로 보인다(그대로인 문제·추천 없는 문제는 행이 없다): `적용` checkbox(기본 체크) · "12번 · 발문 앞 40자" · "현재: <장> → 추천: <장>"(화살표는 장식이고 글자 "에서 … 으로"가 접근 가능한 이름에 들어간다) · 근거 글자("출처 교재의 장" / "문제지 장 제목과 일치"). 맨 위 `모두 적용` tri-state checkbox. 행이 많으면 virtualize.
  - footer: `선택한 추천 적용 (k)`(0이면 비활성 + "적용할 추천을 고르세요"). 확인 dialog "추천한 챕터로 문제 k개를 옮길까요?"(설명은 직접 옮기기와 같음) → 한 요청으로 적용 → 알림 "문제 k개의 챕터를 추천대로 바꿨습니다." → 목록 단계로 돌아가 다시 읽는다.
  - 바뀔 문제가 없으면 "추천과 다른 챕터의 문제가 없습니다."와 `목록으로`.
  - 미리보기 단계로 가는 것과 돌아오는 것은 같은 dialog 안의 단계 전환이라 URL·기록 항목을 바꾸지 않는다(뒤로가기는 dialog를 닫는다 — QOV-01-AC14 규칙; 단계는 URL에 남기지 않는다) (사용자 결정 2026-11-02).
- **바뀜 충돌:** 직접 옮기기·추천 적용 모두 보낸 문제마다 "보고 있던 지금 챕터"를 함께 보낸다. 그 사이 누가 그 문제의 챕터를 바꿨거나(다른 탭·다른 구성원·교정 발행으로 장 id가 바뀜) 문제가 보관·삭제되었으면 서버가 요청 전체를 거절하고(아무것도 옮기지 않음) role=alert "그 사이 바뀐 문제가 있어 옮기지 않았습니다. 목록을 다시 불러왔습니다."를 보이며 목록(미리보기 단계면 추천)을 다시 계산한다.
- **키보드·터치:** 모든 동작은 Tab·화살표·Space·Enter로 닿는다(`QuestionRangePicker` 규칙). checkbox·버튼 hit 영역 24px 이상(coarse pointer 44px). 375px에서 페이지·panel 가로 스크롤 없음, 줄의 버튼은 버튼 단위로 다음 줄. Escape(focus가 안에 있을 때)·닫기로 닫으면 focus는 `문제` 버튼으로 돌아간다. 확인 dialog를 닫으면 focus는 그 dialog를 연 버튼으로 돌아간다.

## 화면 상태

| 상태 | 편집 권한(활성 Workspace) | 보기 권한 | 보관된 Workspace |
|---|---|---|---|
| 메뉴 | `챕터 재분배` 활성 | 비활성 + "편집 권한이 있어야 사용할 수 있습니다" | 비활성 + "보관된 Workspace는 읽기 전용입니다" |
| `?panel=chapter-redistribution` 딥링크 | dialog 열림 | 열리지 않음(URL에서 뺌) | 열리지 않음 |
| 불러오는 중 | skeleton "문제를 불러오는 중입니다." | — | — |
| 확정 문제 없음 | "옮길 확정 문제가 없습니다" | — | — |
| 미리보기 계산 중 | "추천을 계산하는 중입니다." | — | — |
| 바뀔 추천 없음 | "추천과 다른 챕터의 문제가 없습니다." | — | — |
| 바뀜 충돌(409) | alert + 다시 불러옴, 아무것도 안 옮김 | — | — |
| 실패 | role=alert + `다시 시도` | — | — |

## 수용 기준

### CHREDIST-01-AC01

- **Given:** 두 교재 장(1장·2장)과 "챕터 없음"에 걸친 확정 문제 6개, 초안 1개, 보관 문제 1개가 있는 Workspace 홈: Owner, 보기 권한 멤버, 보관된 Workspace의 Owner
- **When:** Owner가 `문제` 메뉴를 키보드(Enter, 화살표)로 열어 `챕터 재분배`를 고르고, 1장의 장 checkbox와 2장 문제 하나를 Space로 고른 뒤 1장 checkbox를 다시 눌러 풀고; 보기 권한 멤버와 보관된 Workspace의 Owner가 `문제` 메뉴를 열고 `?panel=chapter-redistribution`으로 직접 오고, 목록·옮기기 API를 직접 부른다
- **Then:** Owner에게는 홈을 떠나지 않고 modal dialog "챕터 재분배"가 열리고 URL에 `?panel=chapter-redistribution`이 있으며 Tab은 dialog 안에서만 돈다. 목록은 Heatmap 순서의 1장·2장·"챕터 없음" 그룹에 확정 문제 6개만 있고(초안·보관 문제 없음) 행은 "<장> <번호>번 · 발문 앞부분 · 유형"이다. 1장 checkbox는 그 장 문제를 모두 고르고, 2장 checkbox는 일부만 고른 상태에서 `aria-checked="mixed"`이며 "선택 n문제"가 바뀔 때마다 알린다. 보기 권한·보관된 Workspace에서는 `챕터 재분배`가 이유 글자와 함께 비활성(화살표 이동에서 건너뜀)이고, 딥링크로 와도 dialog가 열리지 않으며, 서버는 목록·미리보기·옮기기를 거절한다(viewer 403 `insufficient-role`, 보관 403 `workspace-archived`). dialog를 닫은 뒤 뒤로가기·앞으로가기로 다시 열리지 않는다(QOV-01-AC14).

### CHREDIST-01-AC02

- **Given:** 1장에 확정 문제 3개(그중 하나는 풀이 기록 2개·즐겨찾기), 2장에 1개, "챕터 없음"에 1개가 있고 1장·2장 모두 정리 노트(버전 1)가 있는 Workspace 홈(Owner), 다른 Workspace의 장 id
- **When:** `챕터 재분배`에서 1장 문제 2개(기록이 있는 문제 포함)와 "챕터 없음" 문제를 고르고, `옮길 챕터`를 고르기 전 `이동`을 보고, `옮길 챕터`로 2장을 골라 `이동`과 확인 dialog의 `옮기기`를 누르고, 새로 고침한 뒤 1장·2장 정리 노트 panel을 열고, 옮긴 문제의 풀이 panel과 `수정 이력·출처`를 열고; 옮기기 API에 다른 Workspace의 장 id와 문제지 문서의 1단계 장 id를 직접 보낸다
- **Then:** 챕터를 고르기 전 `이동`은 이유 글자("옮길 챕터를 고르세요")와 함께 비활성이다. 확인 dialog는 "문제 3개를 2장 …로 옮길까요?"이고, 옮기면 알림 "문제 3개를 … 옮겼습니다."가 보이며 Heatmap의 1장 그룹은 1문제, 2장 그룹은 4문제, "챕터 없음" 그룹은 사라진다(새로 고침해도). 옮긴 문제 행에는 "직접 정함" badge가 있다. 기록이 있던 문제는 같은 상태 색·즐겨찾기 star 그대로이고 `수정 이력`의 버전 수가 늘지 않는다(새 revision 없음). 1장·2장 정리 노트는 "문제가 바뀌어 최신이 아닙니다" badge를 보이고 1장 노트의 옮긴 문제 각주는 "삭제되었거나 옮긴 문제"로 보인다. 다른 Workspace의 장 id는 404이고 아무 문제도 옮기지 않으며, 문제지 문서의 1단계 장 id는 유효한 이동 대상이라 200으로 옮겨진다(문제지의 더 깊은 노드는 422 `chapter-invalid`).

### CHREDIST-01-AC03

- **Given:** 교재 하나(1장 "개요"·2장 "주의 집중")와 문제지 PDF 하나(장 제목 "제1장 개요"·"제2장 주의 집중")에서 가져와 등록한 확정 문제 4개 — A·B는 문제지 2장에 있는데 1장으로 등록됨(자동 추천 `auto`), C는 검토자가 1장으로 정함(`manual`, 문제지 2장), D는 문제지 1장에 있고 1장(맞음) — 그리고 출처가 없는 직접 등록 문제 E(`manual`)가 있는 Workspace 홈(Owner)
- **When:** `챕터 재분배`에서 아무것도 고르지 않고 `자동 추천 보기`를 누르고, 미리보기 응답 전후로 문제 목록 API를 읽고, B의 `적용`을 끈 뒤 `선택한 추천 적용`과 확인을 누르고; 다시 `직접 정한 챕터도 다시 추천`을 켜고 `자동 추천 보기`를 누른다
- **Then:** 첫 미리보기 요약은 "바뀔 문제 2개 · 그대로 1개 · 직접 정한 챕터라 건너뜀 2개"이고 행은 A·B 두 개뿐이며 각각 "현재: 1장 개요 → 추천: 2장 주의 집중"과 근거 "문제지 장 제목과 일치"를 보인다(D·C·E는 행이 없다). 미리보기 전후 문제의 챕터는 같다(미리보기는 아무것도 바꾸지 않음). 적용하면 A만 2장으로 옮겨지고 B는 1장에 남으며, A는 "직접 정함" badge가 없다(`auto`). `직접 정한 챕터도 다시 추천`을 켠 두 번째 미리보기는 "바뀔 문제 2개 · 그대로 2개 · 추천 없음 1개"(B와 C가 행, E는 "출처가 없음")다.

### CHREDIST-01-AC04

- **Given:** 1장에 확정 문제 3개가 있는 Workspace 홈(Owner)과 같은 Owner의 두 번째 탭
- **When:** 첫 탭에서 3개를 고르고 `옮길 챕터` 2장, `이동`까지 연 상태에서 두 번째 탭이 그중 한 문제를 `편집`으로 "챕터 없음"으로 바꾸고, 첫 탭이 확인 dialog의 `옮기기`를 누르고; 다시 고른 뒤 `옮기기`를 빠르게 두 번 누르고(같은 `Idempotency-Key`); 키보드만으로(Tab·Space·Enter) 375px 폭에서 고르기·`이동`·확인을 마친다
- **Then:** 바뀐 문제가 있는 첫 요청은 409 `chapter-changed`로 거절되어 세 문제 중 어느 것도 옮겨지지 않고(Heatmap 그대로), role=alert "그 사이 바뀐 문제가 있어 옮기지 않았습니다. 목록을 다시 불러왔습니다."가 보이며 목록에 그 문제가 "챕터 없음" 그룹에 있다. 두 번 누른 요청은 한 번만 옮기고 활동 기록·`question_chapter_changes` 행도 한 번분이다. 375px에서 페이지와 panel에 가로 스크롤이 없고 키보드만으로 같은 결과를 얻으며, 확인 dialog를 닫으면 focus가 `이동` 버튼으로 돌아온다.

## 계약 요구사항 (pytest·unit·pgTAP, 화면 AC 아님)

`tests/integration/questions/chapter_redistribution/test_chapter_redistribution_contract.py`, `apps/api/tests`, `supabase/tests`.

| ID | 요구사항 |
|---|---|
| CHREDIST-01-C01 | **인가 matrix:** 목록(`GET …/chapter-redistribution/questions`)·미리보기·옮기기는 owner·editor이고 활성 Workspace만(viewer 403 `insufficient-role`, 보관 403 `workspace-archived`, 삭제·비구성원 404 — 알 수 없는 Workspace와 같은 응답). 공유 링크 세션·Fork 수신자에게 이 API는 없다(공유 router에 없음, 404). `workspace_id`는 path의 Workspace의 멤버십으로만 판정하고 body의 id를 믿지 않는다. |
| CHREDIST-01-C02 | **대상 검증·원자성:** `POST /workspaces/{id}/questions/chapter-assignments` `{source: "manual" \| "recommendation", items: [{question_id, chapter_id \| null, expected_chapter_id \| null}]}`(1~5,000개, 같은 `question_id` 두 번 422). 한 트랜잭션에서 Workspace 행 FOR SHARE → **문서 먼저**: 대상 장의 책 문서와 보낸 문제들의 지금 장(`expected_chapter_id`의 장)의 문서를 문서 id 순으로 한 문장에서 FOR SHARE(`QuestionRepository.lock_documents`, `apps/api/src/quiz_api/repositories/questions.py` — 문제 쓰기의 잠금 순서: 문서 → 문제) → 그 다음 문제들을 id 순 FOR UPDATE하고 지금 장을 다시 읽는다. 교정 발행은 문서를 FOR UPDATE한 뒤 장 재매핑(`documents_remap_question_chapters`)으로 그 장의 문제를 고치므로, 문제를 먼저 잠그고 문서를 나중에 잠그면 둘이 서로 반대 순서로 기다려 deadlock이 난다 — 그래서 문서를 문제보다 먼저 잠근다(발행이 먼저 commit하면 새 revision의 장을 읽고 `expected_chapter_id`가 달라 409, 아니면 발행이 이 트랜잭션을 기다린 뒤 옮긴 문제를 재매핑). 문제를 잠근 뒤 읽은 지금 장이 잠그지 않은 문서의 장이면(그 사이 바뀜) `expected_chapter_id`와 다르므로 409 `chapter-changed`다. 하나라도 다른 Workspace·삭제·없는 문제면 404, 확정이 아니면 409 `question-not-confirmed`, `expected_chapter_id`가 지금 챕터와 다르면 409 `chapter-changed`(응답에 바뀐 `question_id` 목록), 대상 챕터가 이 Workspace의 살아 있는 `book` 문서의 현재 발행 revision 챕터(또는 살아 있는 `question_paper` 문서의 현재 revision level-1 챕터 — CHAP-MATCH)가 아니면 422 `chapter-invalid`(다른 Workspace 챕터는 404) — 어느 경우든 **아무 행도 바뀌지 않는다**. `expected_chapter_id`가 지금 챕터와 같고 그것이 이미 대상 챕터인 문제(예: 목록에서 이미 그 장에 있던 문제를 함께 고름)는 바꾸지 않고 `unchanged`로 센다 — 이것은 "보이던 상태 그대로"일 때만이다. |
| CHREDIST-01-C03 | **멱등은 `Idempotency-Key`로만:** 같은 `Idempotency-Key`의 재시도(같은 사용자·같은 body)는 C02 검사보다 먼저 저장된 결과(처음 응답과 같은 개수)를 돌려주고 다시 쓰지 않는다(활동·이력 행 1회분). 키 없이 A → B로 옮긴 요청을 다시 보내면 `expected_chapter_id = A`가 지금 장 B와 다르므로 **409 `chapter-changed`**이고 아무것도 쓰지 않는다(지난 상태를 근거로 한 쓰기는 늘 거절 — 성공한 재실행은 같은 키일 때만). 같은 키에 다른 body는 422 `idempotency-key-reused`. 화면은 요청마다 새 키를 만들고 같은 요청의 재시도(두 번 누름·네트워크 재시도)에는 같은 키를 쓴다. |
| CHREDIST-01-C04 | **쓰는 것:** 바뀐 문제마다 `questions.chapter_id`, `chapter_source`(`manual` 요청은 `manual`, `recommendation`은 `auto`), `chapter_set_by`(JWT `sub`), `chapter_set_at`; `question_chapter_changes` 행(from·to·source·changed_by); 요청마다 활동 `questions.chapters_reassigned`(개수·source·job 없음; 문제·챕터 id만, 제목·발문 없음). `question_revisions`·`question_attempts`·`question_user_states`·`practice_runs`·`mock_exam_*` 행 수와 내용은 바뀌지 않는다(행 수 불변 test). `questions.updated_at`은 바뀐다. |
| CHREDIST-01-C05 | **추천 규칙(`book_core.chapter_matching` 재사용):** 확정 문제의 시작 블록 = 그 문제의 출처 행(`question_sources`, 가져온 출처(import provenance)가 있으면 그것, 없으면 가장 먼저 만든 출처)의 `block_ids[0]`, 없으면 `page_range` 첫 쪽의 첫 블록. 시작 블록의 문서가 `book`이면 그 블록의 장(그 문서 현재 revision에서 같은 `section_key`의 장)이 곧 추천이다(`source_in_book`). 아니면(문제지·`mixed` 문제 구간) 그 블록의 `content_blocks.chapter_id`에서 상위 장까지 CHAPTER-MAP 제목 key 비교(`matched` · `ambiguous` · `no_match` · `no_source_chapter`, 숫자만으로 맞추지 않음). 출처가 없으면 `no_source`. 초안 추천과 같은 함수·같은 결과(같은 문제지 블록이면 초안 추천과 문제 추천이 같다 — property test). |
| CHREDIST-01-C06 | **미리보기는 읽기 전용:** `POST /workspaces/{id}/chapter-redistribution/preview` `{question_ids \| all: true, include_manual: false}`는 어떤 행·활동·이력·job도 만들지 않는다(전후 DB snapshot 비교). 응답: 바뀔 문제마다 `{question_id, number_label, stem_preview(40자), current_chapter, recommended_chapter, reason}`(정답·해설·보기 없음)와 개수 `unchanged`·`no_recommendation{reason별}`·`skipped_manual`. `include_manual = false`이면 `chapter_source = manual` 문제는 계산하지 않고 센다. 같은 상태에서 두 번 부르면 같은 결과다. |
| CHREDIST-01-C07 | **`chapter_source` backfill·유지:** migration은 기존 문제에 `chapter_source`를 채운다: 가져온 초안(`question_drafts.published_question_id`)에서 등록되었고 그 초안의 `chapter_manual = false`였던 문제는 `auto`, 나머지(직접 등록, 검토자가 챕터를 고른 초안, 변형 출제로 등록된 문제)는 `manual` (사용자 결정 2026-11-02). 이후 `manual`이 되는 경우: 문제 등록 API·문제 편집 dialog(`PATCH /questions/{id}`)에서 `chapter_id`가 바뀜, 직접 옮기기. `auto`: 가져오기 등록(`chapter_manual = false` 초안), 추천 적용. 교정 발행의 장 재매핑(`documents_remap_question_chapters`)은 `chapter_source`를 바꾸지 않는다. Fork는 `chapter_source`를 그대로 복사하고 `chapter_set_by`·이력 행은 복사하지 않는다. |
| CHREDIST-01-C08 | **일관성:** 옮긴 뒤 같은 요청자의 `GET /questions/overview`는 새 챕터 그룹에 그 문제를 두고, `GET /workspaces/{id}/chapter-notes`·`GET /chapters/{id}/note`는 옮긴 문제가 있던 장과 새 장 모두 `stale = true`다(CHNOTE-01-C03 fingerprint). 공유 노트의 출처 일치 판정(CHNOTE-01-C05)은 바뀌지 않는다(옮김은 인용 문제의 revision·상태를 바꾸지 않음). 로그·활동·job 결과에 발문·장 제목이 없다(log audit). |
