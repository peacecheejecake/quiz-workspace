# QVIEW-01 — 통합 문제 보기 `QuestionViewer` (범위 풀이 popup)

**상태:** 확정 화면 요구사항 v1.0 · MOCK-SPEC 신규 2026-11-01 (사용자 요청 "정해진 범위의 문제에서 하나씩 팝업 위에서 문제를 보여주는 기능 추가(랜덤 여부는 시작 전 체크) — 등록된 문제 전체, 그리고 모의고사로 생성된 문제에서 각각 해당 기능 사용 — 공통 컴포넌트로 개발", 추가 결정 "하나씩 팝업 위에서 문제를 보여주는 기능을 통합 QuestionViewer로 하고, 기존 문제를 보여줄 때도 이 컴포넌트를 사용해도 되겠다")
**Route:** 범위 고르기 `/workspaces/:workspaceId?practice=new&source=bank` · 모의고사 범위 고르기 `/workspaces/:workspaceId?practice=new&source=mock&mock=:mockExamId` · 진행 중 `/workspaces/:workspaceId?practice=:practiceRunId&i=:position` (Workspace 홈 위 modal panel). 한 문제 보기는 기존 route 그대로(`?question=:questionId` — QPLAY-01)
**테스트:** `tests/e2e/questions/question-viewer.spec.ts` (계약: `tests/integration/questions/practice_runs/test_practice_runs_contract.py`, `packages/ui` · `apps/web` Vitest)
**Phase:** QVIEW.0 (RED) → QVIEW-B → QVIEW-W (UX7-CACHE·UX7-BANK merge 이후)
**연계:** [QPLAY-01](questions-practice.md), [QOV-01](questions-overview.md), [MOCK-01](mock-exams.md), [CHNOTE-01](chapter-notes.md), [WS-VIEW-01](workspace-shared-view.md), [Questions 명세](../questions.md) §4·§10, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: QVIEW-01
route: /workspaces/:workspaceId?practice=new&source=bank|mock
actor: workspace_member (owner · editor · viewer — 개인 풀이)
permission: read · personal attempt
status: confirmed
api: [POST /api/v1/workspaces/:id/practice-runs, GET /api/v1/practice-runs/:id, GET /api/v1/practice-runs/:id/items/:position, POST /api/v1/practice-runs/:id/finish, POST /api/v1/questions/:id/practice-sessions, POST /api/v1/mock-exam-questions/:id/practice-sessions]
components: [QuestionViewer, QuestionRangePicker, FloatingSidePanel, Checkbox, ProgressBar, Button]
linked_tests: [QVIEW-01-AC01 … QVIEW-01-AC08]
```

## 목적과 정책

- **하나의 컴포넌트:** 문제를 하나씩 보여 주는 모든 곳은 `QuestionViewer` 하나를 쓴다(사용자 결정 2026-11-01). 문제 출처(`source`)는 두 가지다: 등록된 문제(`bank` — Workspace의 CONFIRMED 문제, Heatmap의 marker)와 모의고사 문제(`mock` — [MOCK-01](mock-exams.md)이 만든, 그 모의고사 안에만 있는 문제). 출처만 다르고 화면·키보드·채점 흐름은 같다.
- **풀이 흐름(사용자 결정 3):** 답을 고르고 `제출` → 서버 채점 → 결과(정답/오답/채점 대기) + 정답 + 해설. 제출 전에는 화면과 API 응답 어디에도 정답·해설이 없다(QPLAY-01-AC01과 같은 non-disclosing DTO). 채점은 표시 위치가 아니라 변하지 않는 option ID로 한다(QPLAY-01-AC02). 풀이 기록은 바뀌지 않는다(immutable).
  - `bank` 출처의 풀이는 지금처럼 `question_attempts`·`question_user_states`에 기록되어 Heatmap 상태(열람·정답·오답)에 반영된다. 문제가 화면에 보일 때(세션을 열 때) `viewed`를 기록한다(questions.md §2.1).
  - `mock` 출처의 풀이는 그 모의고사 문제에 기록되고(`mock_exam_attempts`) Heatmap·문제 상태·문제 수는 바뀌지 않는다.
- **범위 풀이 (새 기능):** 시작 전에 범위를 고르고(`전체 선택` 포함) `무작위 순서` checkbox를 정한 뒤 `시작`. 서버가 범위를 확정 문제 목록으로 풀고(순서 = Heatmap 순서, `무작위 순서`면 서버가 seed로 섞음) 풀이 묶음(`practice_run`)으로 저장한다. 묶음은 한 번에 한 문제를 보이고 `이전`·`다음`으로 오간다. 새로 고침하면 같은 순서·같은 위치로 돌아온다.
- **범위 단위 (제안 — 사용자 확인 필요):** 범위는 Heatmap과 같은 **챕터 그룹 → 문제** 두 단계 checkbox 목록이고, 위에 `전체 선택`이 있다. 목록을 좁히는 필터는 홈 상태 필터와 같은 항목(풀이 상태 `안 푼 문제`·`본 문제`·`틀린 문제`·`맞힌 문제`·`다시 풀기`, `즐겨찾기만`, 유형)이다. 문서 단위·쪽 단위 범위는 없다. 이 고르기 부품(`QuestionRangePicker`)은 MOCK-01의 출제 범위 고르기와 같은 컴포넌트다.
- **한 묶음 크기:** 한 묶음은 최대 500문제(넘으면 `시작` 비활성 + "한 번에 500문제까지 풀 수 있습니다", 서버 422 `practice-run-too-large`) (제안 — 사용자 확인 필요).
- **묶음 안 재풀이 (제안 — 사용자 확인 필요):** 한 묶음에서 문제마다 제출은 한 번이다. `이전`으로 돌아간 문제는 제출한 답·결과·정답·해설을 읽기 전용으로 보인다. 다시 풀려면 결과 화면의 `처음부터 다시`(새 묶음, 같은 범위·같은 무작위 설정)를 쓴다. 한 문제 보기(`?question=`)의 기존 다시 풀기 동작은 그대로다.
- **끝과 결과 요약 (제안 — 사용자 확인 필요):** 마지막 문제 뒤 `결과 보기`는 같은 panel에 "맞음 x · 틀림 y · 채점 대기 z · 건너뜀 w"와 문제별 결과 목록(번호·발문 앞부분·결과 글자)을 보인다. 목록의 문제를 누르면 그 위치로 돌아가 읽기 전용 결과를 본다. 시간 제한은 없다 (제안 — 사용자 확인 필요).
- **도중에 닫기 (제안 — 사용자 확인 필요):** 닫기·Escape는 확인 없이 닫는다(제출한 풀이는 이미 저장됨). 닫은 묶음은 URL(`?practice=<id>`)이나 이력에서 다시 열면 이어서 풀 수 있고, 새 `문제 풀기`는 새 묶음을 만든다. 끝나지 않은 묶음 목록·이어 풀기 메뉴는 v1에 없다.

## 기존 호출 위치 (call sites)와 보기 방식

QuestionViewer는 아래 **방식(mode)**을 갖는다. 기존 AC가 요구하는 동작(modal/non-modal, 정답 표시 여부, 이전·다음 순서)은 방식으로 남기고 바꾸지 않는다. 각 기존 화면의 AC는 그대로 유효하며 이제 QuestionViewer를 대상으로 검증한다.

| # | 호출 위치 | 문제 수 | 방식 | 겉 panel | 기준 AC |
|---|---|---|---|---|---|
| 1 | Workspace 홈 Heatmap marker click/Enter, `?question=` 딥링크 | 한 문제(이전·다음 = Heatmap 순서·현재 필터, URL이 문제마다 바뀜) | `practice` | modal `FloatingSidePanel`(design-system §5.1 `QuestionPracticePanel` 규칙) | QOV-01-AC06, QPLAY-01-AC01~AC05 |
| 2 | 이력 dialog의 풀이 기록 링크(`?question=`) | 한 문제 | `practice` | 1과 같음 | HISTORY-01 |
| 3 | 챕터 정리 노트 각주 링크(구성원, `?question=`) | 한 문제 | `practice` | 1과 같음(열리면 노트 본문 접힘) | CHNOTE-01-AC02·AC05 |
| 4 | 홈의 문제 상세 + 편집·삭제(UX7-BANK가 QBANK-01 상세를 홈으로 옮김) | 한 문제 | `manage`(정답·해설·출처 표시, 편집·삭제 동작; 풀이 기록 없음, viewed 기록 없음) | UX7-BANK가 정한 panel 방식 그대로 | UX7-BANK의 AC(QBANK-01 대체) |
| 5 | 공유 링크 게스트의 문제 미리보기(`/share/:shareId`, 정리 노트 각주 포함) | 한 문제 | `read-only`(발행 문제·정답·해설 표시, 제출·즐겨찾기·다시 풀기 없음, 아무것도 저장 안 함) | non-modal `FloatingSidePanel` | WS-VIEW-01-AC01·AC03, CHNOTE-01-AC04 |
| 6 | **새로:** `문제` 메뉴 › `문제 풀기`(등록된 문제 범위 풀이) | 범위 묶음 | `sequence`(`source=bank`) | modal `FloatingSidePanel` | QVIEW-01 |
| 7 | **새로:** 모의고사 목록·상세의 `풀기` | 범위 묶음 | `sequence`(`source=mock`) | modal `FloatingSidePanel` | QVIEW-01-AC05, MOCK-01 |
| 8 | **새로:** 모의고사 상세의 문제 행(편집 권한) | 한 문제 | `manage`(`source=mock`: 편집·빼기) | modal `FloatingSidePanel` | MOCK-01-AC05 |
| — | DOC-02·공유 문서 화면의 "가져온 문제 형식"(본문 안에 펼쳐 보이는 문제) | — | 범위 밖: popup이 아니라 본문 안 렌더링. 문제 본문 부품(`QuestionBody` — 발문·번호 붙은 보기·접힌 정답·해설)만 공유한다 | — | DOC-02-AC11 |
| — | 문제 변형 출제의 보기 섞기 미리보기(QGEN-01) | — | 없앤다(QGEN-RM) | — | — |

- **modal vs non-modal (열린 질문):** 새 범위 풀이(6·7)는 사용자 요청의 "팝업"에 맞춰 1과 같은 modal `FloatingSidePanel`(데스크톱 오른쪽 500px, 모바일 bottom sheet)로 제안한다 (제안 — 사용자 확인 필요; 대안은 화면 가운데 큰 `ModalDialog`). 게스트 미리보기(5)는 지금처럼 non-modal로 남긴다 — 공유 화면 AC가 문제 목록과 panel을 함께 쓰는 동작을 전제한다. 4의 방식은 UX7-BANK 결정을 따른다.
- 방식마다 header 동작: `practice`·`sequence(bank)`는 즐겨찾기·다시 풀기 toggle(QPLAY), `sequence(mock)`는 없음(모의고사 문제는 개인 상태가 없음, 제안 — 사용자 확인 필요), `manage`는 편집·삭제(또는 빼기), `read-only`는 없음.
- 문제 본문 부품은 모든 방식이 같다: 번호, 장, 유형 badge, 발문, 번호 붙은 보기(`1.` `2.` … 표시용, `aria-hidden`), 답 입력, 결과 영역(`role="status"`, 글자로 "정답"·"오답"·"채점 대기"), 정답·해설.

## 레이아웃 및 컴포넌트

- **진입 (bank):** Workspace header `문제` 메뉴에 `문제 풀기` 항목(모든 구성원; 보관된 Workspace에서도 보임). 누르면 QuestionViewer가 범위 고르기 단계로 바로 열리고(`?practice=new&source=bank`) 목록을 불러오는 동안 skeleton(QOV-01-AC09 규칙).
- **진입 (mock):** 모의고사 행·상세의 `풀기`(MOCK-01). 범위 고르기 단계는 그 모의고사의 문제만 보이고(출처 장별 묶음) 처음에 모두 선택되어 있다.
- **범위 고르기 단계:** 제목 "문제 풀기"(mock이면 "<모의고사 이름> 풀기").
  - 필터 줄(접힘 가능, 홈 상태 필터와 같은 칩) → `QuestionRangePicker`.
  - `QuestionRangePicker`: 맨 위 `전체 선택` checkbox(지금 필터에 보이는 문제 전체; 일부만 선택이면 `aria-checked="mixed"`), 장 그룹마다 장 checkbox(장 제목·문제 수, 일부 선택 = mixed)와 펼치기 버튼(`aria-expanded`), 펼치면 문제 checkbox 목록("3장 12번 · 발문 앞 40자 · 유형"). 필터를 바꾸면 보이지 않게 된 문제는 선택에서 빠진다(선택 = 보이는 문제 중에서만). 아래 "선택 n문제" 글자.
  - `무작위 순서` checkbox(기본 꺼짐, 시작할 때마다 다시 고름 — 기억하지 않음).
  - `시작`(선택 0이면 비활성 + 이유 "풀 문제를 고르세요").
- **풀이 단계:** header: 제목(문제 번호 "3장 12번" / 모의고사는 "문제 k"), 진행 "k / n"(공통 `ProgressBar`, 값 글자 "n문제 중 k번째"), 방식별 toggle, 닫기. 본문: 문제 본문 부품. footer: `제출`(답이 없으면 비활성) → 결과 후 `다음`(마지막이면 `결과 보기`), `이전`, `건너뛰기`(제출 없이 다음; 결과 요약에서 "건너뜀"). 서술형·자동 채점 불가 단답은 QPLAY와 같이 `PENDING` 후 자기평가(맞음/틀림).
- **결과 단계:** 위 "끝과 결과 요약". `처음부터 다시`, `닫기`.
- 반응형: 375px에서 가로 스크롤 없음, 모바일 bottom sheet `max-height: 90dvh`, footer 버튼은 줄바꿈.

## 화면 상태

| 상태 | 표시 |
|---|---|
| 범위 불러오는 중 | 즉시 열린 panel + skeleton(`aria-busy`, "불러오는 중") |
| 확정 문제 없음(bank) | "아직 확정된 문제가 없습니다." `시작` 없음 |
| 필터에 맞는 문제 없음 | "조건에 맞는 문제가 없습니다." + `필터 초기화`, `시작` 비활성 |
| 문제 불러오는 중 | 본문 skeleton, 진행 막대 유지 |
| 묶음 도중 문제가 삭제·보관됨(bank) 또는 모의고사에서 빠짐(mock) | "이 문제는 더 이상 풀 수 없습니다." + `다음` (결과 요약에서 "건너뜀") |
| 모의고사 삭제됨·다시 만들어 문제가 바뀜 | 묶음은 시작할 때의 문제로 계속 풀 수 있다(제안 — 사용자 확인 필요); 삭제된 모의고사의 묶음은 "모의고사를 찾을 수 없습니다."(404) |
| 제출 실패(네트워크) | 답 유지 + alert "제출하지 못했습니다. 다시 시도하세요." |
| 보관된 Workspace | 범위 고르기·보기는 가능, `제출` 비활성 + "보관된 Workspace에서는 답안을 제출할 수 없습니다."(API 403 `workspace-archived`) |
| 다른 Workspace·다른 사용자의 묶음 딥링크 | "풀이를 찾을 수 없습니다."(404; 묶음은 만든 사용자만) |
| 공유 링크 게스트 | `문제 풀기`·`?practice=` 없음(제안 — 사용자 확인 필요), 게스트 미리보기(호출 위치 5)는 그대로 |

## 접근성

- modal panel: Radix focus trap, 제목·설명 연결, Escape·닫기로 닫고 연 버튼(메뉴 항목이면 `문제` 메뉴 버튼, 행의 `풀기`)으로 focus 복귀.
- 문제가 바뀌면 focus는 문제 제목(heading, `tabIndex=-1`)으로 가고, 진행 "n문제 중 k번째"를 `aria-live="polite"`로 알린다. 결과는 `role="status"` 글자로 알리고 색만으로 전달하지 않는다.
- 범위 checkbox 목록: native checkbox(또는 Radix Checkbox)로 Space 토글, mixed 상태 `aria-checked="mixed"`, 장 펼치기는 별도 버튼. 목록은 roving 없이 Tab 순서(장 checkbox → 펼치기 → 문제 checkbox).
- `prefers-reduced-motion`에서 panel·진행 막대 움직임 없음. 결과·정답 영역은 hover 없이 보인다(터치 동등).

## 수용 기준

### QVIEW-01-AC01

- **Given:** 두 장(1장 3문제, 2장 2문제)의 확정 문제와 초안 2개가 있는 Workspace 홈(보기 권한 구성원)
- **When:** header `문제` 메뉴에서 `문제 풀기`를 고른다
- **Then:** modal panel "문제 풀기"가 데이터 응답 전에 열리고(`?practice=new&source=bank`, skeleton → 내용) 장 그룹 2개와 `전체 선택`, `무작위 순서`(꺼짐), `시작`(비활성, "풀 문제를 고르세요")을 보인다. 초안은 목록에 없다. 장 그룹을 펼치면 그 장의 문제 checkbox가 "1장 1번 · <발문 앞부분>" 형식으로 보인다. Escape로 닫으면 focus가 `문제` 메뉴 버튼으로 돌아오고 `practice`가 URL에서 빠진다.

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

- **Given:** 문제 4개로 만들어진 모의고사(MOCK-01)와 문제 10개의 Heatmap
- **When:** 모의고사 행의 `풀기` → 범위 고르기에서 문제 하나를 해제하고 `무작위 순서`를 켜고 `시작` → 3문제를 모두 제출하고 `결과 보기`
- **Then:** 범위 고르기는 그 모의고사의 문제 4개만 처음부터 모두 선택된 상태로 보이고(`전체 선택` checked), 해제 후 "선택 3문제"다. 풀이 단계는 등록 문제와 같은 본문·footer를 쓰고 즐겨찾기·다시 풀기 toggle이 없다. 제출 결과·정답·해설은 AC04와 같다. 끝나면 Heatmap marker 10개의 상태·문제 수와 `question_attempts`는 그대로이고, 풀이는 모의고사 문제의 기록으로만 남는다(`mock_exam_attempts` 3건).

### QVIEW-01-AC06

- **Given:** 5문제 묶음에서 2문제를 제출(정답 1·오답 1)하고 1문제를 건너뛰고 2문제는 서술형으로 채점 대기인 상태
- **When:** 마지막 문제 뒤 `결과 보기`를 누르고, 결과 목록의 두 번째 문제를 누른 뒤 `처음부터 다시`를 누른다
- **Then:** 결과 단계는 "맞음 1 · 틀림 1 · 채점 대기 2 · 건너뜀 1"과 문제별 결과 글자 목록을 보인다(색만으로 구분하지 않음). 목록의 문제를 누르면 그 위치의 읽기 전용 결과로 간다. `처음부터 다시`는 같은 범위·같은 무작위 설정의 새 묶음을 "5문제 중 1번째"부터 시작하고 이전 묶음의 풀이 기록은 바뀌지 않는다.

### QVIEW-01-AC07

- **Given:** 보관된 Workspace(편집 권한자), 다른 사용자가 만든 묶음 id, 공유 링크 게스트
- **When:** 보관된 Workspace에서 `문제 풀기`로 묶음을 시작해 답을 고르고, 다른 사용자의 `?practice=<id>`를 열고 `GET /practice-runs/{id}`를 부르고, 게스트가 `/share/:shareId`를 연다
- **Then:** 보관된 Workspace에서는 범위 고르기·시작·문제 보기는 되지만 `제출`이 비활성이고 "보관된 Workspace에서는 답안을 제출할 수 없습니다."를 보인다(직접 submit은 403 `workspace-archived`). 다른 사용자의 묶음은 "풀이를 찾을 수 없습니다."이고 API는 404다. 게스트 화면에는 `문제 풀기`가 없고 문제 미리보기는 기존처럼 non-modal 읽기 전용이다.

### QVIEW-01-AC08

- **Given:** 3문제 묶음을 시작한 뒤 편집 권한자가 두 번째 문제를 삭제했고, 필터에 맞는 문제가 없는 범위 조건
- **When:** 묶음에서 두 번째 문제로 가고, 새 `문제 풀기`에서 `다시 풀기만` 필터를 켠다(다시 풀기 문제 없음)
- **Then:** 두 번째 위치는 "이 문제는 더 이상 풀 수 없습니다."와 `다음`을 보이고 결과 요약에서 "건너뜀"으로 센다. 필터에 맞는 문제가 없으면 "조건에 맞는 문제가 없습니다."와 `필터 초기화`를 보이고 `시작`은 비활성이다. 서버에 직접 빈 범위로 시작하면 409 `no-matching-questions`이고 묶음은 생기지 않는다.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/questions/practice_runs/test_practice_runs_contract.py`, `packages/ui`·`apps/web` Vitest, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| QVIEW-01-C01 | **범위 확정:** `POST /workspaces/{id}/practice-runs`(`source=bank`, `range{all, chapter_ids[], question_ids[], excluded_question_ids[], filters}`, `random_order`, `Idempotency-Key`)는 서버에서 범위를 이 Workspace의 살아 있는 CONFIRMED 문제로만 푼다(필터의 풀이 상태·즐겨찾기는 요청한 사용자 기준, Heatmap과 같은 판정). 다른 Workspace·초안·보관·삭제 문제 id는 범위에서 조용히 빠지지 않고 422 `range-invalid`로 거절한다. 결과 0개면 409 `no-matching-questions`, 500개 초과 422 `practice-run-too-large`. client가 보낸 `workspace_id`·`user_id`는 쓰지 않는다. |
| QVIEW-01-C02 | **순서:** `random_order=false`면 Heatmap 순서, `true`면 `random.Random(seed).shuffle`(seed 미지정 시 서버가 정해 저장). 같은 seed·같은 범위 → 같은 순서. 묶음의 `item_ids`·seed는 생성 후 바뀌지 않는다. |
| QVIEW-01-C03 | **정답 비노출:** `GET /practice-runs/{id}`·`/items/{position}`과 묶음에서 여는 practice session은 제출 전 정답·허용 답안·채점 기준·해설을 보내지 않는다(응답 schema test + 항목마다 key 검사). 제출 응답에서만 그 문제의 정답·해설을 보낸다. |
| QVIEW-01-C04 | **기록:** `bank` 묶음의 세션·풀이는 기존 `practice_sessions`·`question_attempts`에 `practice_run_id`와 함께 기록되어 `question_user_states`·Heatmap에 반영된다. `mock` 묶음은 `mock_exam_practice_sessions`·`mock_exam_attempts`에만 기록되고 `question_*` 테이블은 바뀌지 않는다(행 수 비교 test). 묶음 안 문제마다 제출 1회(두 번째 제출 409 `already-submitted`); 풀이 기록은 UPDATE·DELETE 불가(pgTAP). |
| QVIEW-01-C05 | **인가 matrix:** 묶음은 만든 사용자만 읽고 쓴다(다른 사용자·다른 Workspace 404). 모든 구성원(viewer 포함)이 만들고 풀 수 있고, 보관 Workspace는 만들기·읽기 가능·제출 403 `workspace-archived`, 삭제 Workspace 404. 공유 세션(게스트)은 묶음 API에 접근할 수 없다(401/404). |
| QVIEW-01-C06 | **컴포넌트 계약(Vitest):** `QuestionViewer`는 방식 `practice`·`sequence`·`manage`·`read-only`를 갖고, `read-only`·`manage`는 제출 UI를 렌더링하지 않으며, `sequence(mock)`는 즐겨찾기·다시 풀기를 렌더링하지 않는다. 기존 호출 위치(홈 marker, 이력·정리 노트 링크, 홈 문제 상세, 공유 미리보기)는 모두 이 컴포넌트를 쓴다(이전 `PracticePanel`·`QuestionDetail`·`SharedQuestionPanel` 구현 제거). |

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 기존 QPLAY-01·QOV-01-AC06·CHNOTE-01-AC02/AC05·WS-VIEW-01 테스트는 QVIEW-W에서 바꾸지 않고 GREEN으로 남아야 한다(회귀 기준). 테스트가 구현 컴포넌트 이름에 기대고 있으면 role/label locator로만 고친다.
