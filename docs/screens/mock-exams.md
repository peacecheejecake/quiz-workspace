# MOCK-01 — 모의고사 목록·만들기·편집 Floating Dialog

**상태:** 확정 화면 요구사항 v1.0 · MOCK-SPEC 신규 2026-11-01 (사용자 요청 "변형 출제 -> '문제 생성' 삭제 / 대신 '모의고사' 기능 추가 — 모의고사 리스트 화면 필요, 리스트 위 '추가' 버튼 눌러 생성, 다른 화면과 레이아웃 비슷하게 — 생성 버튼을 누르면 현재 '변형 유형'에 해당하는 옵션과 출제 문제 범위 선택 화면 — 한 번 생성한 모의고사는 저장됨(수정, 삭제 가능) — 문제 선택에는 전체 선택 기능이 필요", 사용자 결정 1·2·4)
**Route:** 목록 `/workspaces/:workspaceId?panel=mock-exams` · 만들기 `?panel=mock-exams&mock=new` · 상세·편집 `?panel=mock-exams&mock=:mockExamId` (Workspace header `문제` 메뉴 › `모의고사`가 여는 non-modal floating dialog "모의고사") · 풀기는 QuestionViewer(`?practice=new&source=mock&mock=:mockExamId`, [QVIEW-01](question-viewer.md))
**테스트:** `tests/e2e/questions/mock-exams.spec.ts` (계약: `tests/integration/questions/mock_exams/test_mock_exams_contract.py`, `apps/worker` · `packages/core` unit test, `supabase/tests` pgTAP)
**Phase:** MOCK.0 (RED) → MOCK-B → MOCK-P → MOCK-W
**연계:** [QVIEW-01](question-viewer.md), [QOV-01](questions-overview.md), [QGEN-01 (폐지)](questions-generation.md), [Questions 명세](../questions.md) §5·§10, [공유 명세](../workspace-sharing.md) §9, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: MOCK-01
route: /workspaces/:workspaceId?panel=mock-exams
actor: workspace_member (목록·풀기) · editor/owner (만들기·편집·다시 만들기·삭제)
permission: read · edit
status: confirmed
api: [GET /api/v1/workspaces/:id/mock-exams, POST /api/v1/workspaces/:id/mock-exams, GET /api/v1/mock-exams/:id, PATCH /api/v1/mock-exams/:id, DELETE /api/v1/mock-exams/:id, POST /api/v1/mock-exams/:id/generations, GET /api/v1/mock-exams/:id/questions, PATCH /api/v1/mock-exam-questions/:id, DELETE /api/v1/mock-exam-questions/:id]
components: [FloatingSidePanel, Button, QuestionRangePicker, Checkbox, Select, StepProgress, ProgressBar, ConfirmDialog, DropdownMenu, QuestionViewer, Badge, EmptyState]
linked_tests: [MOCK-01-AC01 … MOCK-01-AC08]
```

## 목적과 정책

- **모의고사 = 저장된 출제 설정 + 그 설정으로 만든 문제 묶음.** 편집 권한자가 이름·변형 유형 옵션·출제 범위를 정해 만들면 서버가 범위의 확정 문제를 원본으로 문제를 만들어 저장한다. 만든 모의고사는 목록에 남고 이름 바꾸기·문제 편집·빼기·설정 바꿔 다시 만들기·삭제를 할 수 있다(사용자 결정 4).
- **모의고사 문제는 그 모의고사 안에만 있다 (사용자 결정 2 — 의도된 예외):** 만들어지는 즉시 풀 수 있고 문제은행(확정 문제)·Heatmap·문제 수·홈 검색·정리 노트 입력에 들어가지 않는다. 그래서 "생성·가져온 문제는 사람이 승인할 때까지 초안" 규칙(AGENTS.md §5 Data)은 모의고사 문제에 적용되지 않는다 — 모의고사 문제는 은행에 들어가는 경로가 없다(승인·등록 API 없음). AGENTS.md 문구 보완은 후속(implementation-plan §7).
- **변형 출제 대체 (사용자 결정 1):** 이전 `문제` 메뉴 › `변형 출제`와 "문제 생성" dialog(QGEN-01, 묶음 QGEN-MULTI 포함)는 없어지고 그 자리에 `모의고사`가 온다. 생성 엔진(변형 유형별 LLM 생성·검증·fake adapter)은 재사용한다(아래 "재사용과 폐지").
- **옵션 = 지금의 변형 유형 (사용자 요청):** 만들기 화면의 옵션은 QGEN-01 생성 form과 같은 변형 유형이다: `보기 섞기`(`OPTION_SHUFFLE`, 원본 문제를 그대로 옮기고 보기 순서만 섞음 — LLM 없음), `문구 변형`(`PARAPHRASE`), `정오 반전`(`INVERT_POLARITY`), `유사 개념`(`ANALOGOUS_CONCEPT`). 하나 이상 고른다. 그 밖의 옵션:
  - `문항 수` 1~50(기본 20) (제안 — 사용자 확인 필요). 서버가 범위에서 원본을 `min(문항 수, 범위 문제 수)`개 고르고(범위가 문항 수보다 크면 seed로 임의 선택, 작으면 전부) 원본마다 문제 1개를 만든다. 원본마다 쓸 변형 유형은 고른 유형 중에서 seed로 고르게 돌려 정한다(제안 — 사용자 확인 필요). QGEN-01의 `후보 수`는 없다(원본 하나 = 문제 하나).
  - `난이도`(선택, `쉬움`·`보통`·`어려움`, 기본 "원본과 같게") — QGEN-01 form과 같다.
- **범위 (제안 — 사용자 확인 필요):** QVIEW-01과 같은 `QuestionRangePicker`(장 그룹 → 문제 checkbox, 맨 위 `전체 선택`, 상태·즐겨찾기·유형 필터)로 이 Workspace의 확정 문제를 고른다. 저장되는 범위는 사람이 고른 의도(`전체 선택` 여부·장·개별 문제·제외 문제·필터)이고, 다시 만들 때 그 의도를 그때의 확정 문제로 다시 푼다(새로 등록된 문제는 `전체 선택`·장 선택이면 포함).
- **만든 직후 바로 사용:** 생성 결과 중 기계 검증(형식·정답 개수·중복·출처 근거 — 이전 QGEN의 승인 차단 검증)을 통과한 문제만 저장되고 곧바로 `풀기`에 쓰인다. 통과하지 못한 후보는 저장·표시하지 않는다(그 원본으로 한 번 다시 요청, 그래도 실패면 그 원본은 건너뜀). 승인을 막지 않는 경고(`warning`)는 편집 권한자에게 문제 행의 "확인 필요" 글자 badge와 편집 화면의 안내로만 보이고 풀이 화면에는 보이지 않는다.
- **다시 만들기 (제안 — 사용자 확인 필요):** 설정(변형 유형·문항 수·난이도·범위)을 바꾸거나 그대로 `다시 만들기`하면 새 회차(generation)로 문제를 모두 새로 만들고, 성공하면 모의고사의 문제 목록을 새 회차로 **바꾼다**. 이전 회차 문제와 그 풀이 기록은 지우지 않고(풀이 기록 불변) 화면에서 숨긴다(v1에 이전 회차 열람 없음). 새 회차가 실패하면 이전 문제가 그대로 남는다. 사람이 편집한 문제도 다시 만들면 바뀐다(확인 dialog에서 알림).
- **공유 범위 (제안 — 사용자 확인 필요):** 모의고사는 Workspace 단위다 — 모든 구성원이 목록을 보고 풀 수 있고(풀이 기록은 사람마다), 편집 권한자가 만들고 고친다. 공유 링크 게스트에게는 보이지 않고 Fork에 복제되지 않는다(v1; [공유 명세 §9](../workspace-sharing.md)).
- **환경별 사용 여부:** LLM 변형 유형은 worker 설정 `WORKER_MOCK_EXAMS`와 LLM 설정이 있을 때만 고를 수 있다. 꺼진 환경에서도 `보기 섞기`만 고른 모의고사는 만들 수 있고(LLM 없음) 저장된 모의고사는 풀 수 있다 (제안 — 사용자 확인 필요).

## 재사용과 폐지 (QGEN-01 생성 엔진)

| 부분 | 처리 |
|---|---|
| `book_core.generation`(`VariantGenerator`, `prompts`, `validation`의 형식·정답 개수·정오 반전 정답 불일치·중복 fingerprint·출처 근거 검증) | **재사용**(바꾸지 않음). 모의고사 job이 원본마다 같은 요청(`VariantRequest`, 후보 1개)으로 부른다. 승인 차단(`is_rejection`) 검증을 통과하지 못하면 저장하지 않는다 — 사람의 승인 대신 이 검증이 저장 조건이다. |
| `OPTION_SHUFFLE` 결정적 shuffle(M5.2) | **재사용**: 모의고사 문제는 원본 revision의 발문·보기·정답·해설을 복사하고 보기 순서를 seed로 섞어 저장한다(풀이 때 보기 섞기는 QVIEW-01 세션 규칙 그대로). |
| fake LLM adapter·`tests/fixtures/llm/generation-scenarios.json` | **재사용**(E2E·계약 test). 모의고사용 시나리오(정상·정오 반전 복수 정답·전부 실패)를 같은 파일에 추가한다. |
| worker `question.generate` job의 원본 읽기·근거 passage 검색·근거 좁히기(`source_question`, `build_passages`, `narrow_evidence`) | **재사용**: 공용 모듈로 옮겨 새 job `mock_exam.generate`가 쓴다. `question.generate` job 등록은 QGEN-RM에서 뺀다. |
| `question_generation_runs`·생성 `question_drafts`·`question_lineage` 테이블과 기존 행 | **보존**(additive-first; 삭제 migration 없음). 새 행은 생기지 않는다. 승인되지 않은 기존 생성 초안은 검토 화면이 없어져 볼 수 없게 된다(열린 질문). 이미 등록된 변형 문제와 lineage는 그대로 확정 문제다. |
| API `POST /questions/{id}/generations`, `/question-generations/*`, `/workspaces/{id}/question-generation-batches*` | **폐지**(QGEN-RM에서 router 제거 → 404). OpenAPI·api-client 재생성. |
| 화면: `문제` 메뉴 `변형 출제`, "문제 생성" dialog(`?panel=generate`), 검토 페이지·묶음 결과 페이지(`/questions/generate?…`), 문제 상세의 `변형 출제` | **폐지**. 이전 URL은 홈으로 redirect(`?panel=generate` → `?panel=mock-exams`). |
| 이력의 `question_generation.*` 활동·"문제 생성" 작업 label | **보존**(과거 기록 표시용). |

## 레이아웃 및 컴포넌트

**레이아웃 패턴:** 문서 관리 dialog([DOC-01](documents-library.md))와 문제 PDF 관리 dialog(QIMPORT-01-AC05)의 목록 dialog 패턴을 따른다 — Workspace header에서 여는 non-modal `FloatingSidePanel`, 제목·설명 header 없음(접근성 이름 "모의고사"), 위쪽 동작 영역 + 행 목록, 행은 제목 · 글자 badge · 메타 줄 · 오른쪽 아이콘 동작, 즉시 열리고 skeleton(QOV-01-AC09), 다른 홈 dialog와 쌓기(QOV-01-AC10). 만들기·상세는 같은 dialog 안에서 목록을 대신하고 위에 `BackLink` "모의고사 목록"을 둔다(넓은 화면 전환 없음).

- **진입:** Workspace header `문제` 메뉴의 `모의고사` 항목(모든 구성원; 이전 `변형 출제` 자리). 메뉴 순서는 UX7-BANK 이후의 메뉴에 `모의고사`·`문제 풀기`(QVIEW-01)를 더한 것이다.
- **목록 화면:**
  - 목록 위 동작 줄: 왼쪽 "모의고사 n개", 오른쪽 primary 버튼 `추가`(편집 권한·보관되지 않은 Workspace에서만).
  - 행: 이름(누르면 상세) · 상태 badge(`만드는 중`·`준비됨`·`일부만 만듦`·`실패`) · 메타 줄 `문제 18개 · 문구 변형, 정오 반전 · 2026. 11. 1. 오후 3:28` · `풀기`(준비됨·일부만 만듦, 모든 구성원) · 행 메뉴(편집 권한: `이름 바꾸기`·`설정 바꾸기`·`삭제`). 만드는 중이면 메타 줄 아래 공통 `ProgressBar`("문제 생성 진행률", 값 글자 "20개 중 7개").
  - 빈 상태: "아직 모의고사가 없습니다." 편집 권한자에게는 안내 "`추가`로 변형 유형과 범위를 골라 모의고사를 만드세요." (CTA는 위 `추가` 하나 — UX1 "CTA 하나" 규칙).
- **만들기 화면(`추가`):** 두 단계 `StepProgress` `옵션 → 범위`.
  1. 옵션: `이름`(필수, 기본 "모의고사 <n>"), `변형 유형` checkbox 4개(각 설명은 Tooltip, design-system §4.1), `문항 수`, `난이도`. LLM 유형이 쓸 수 없는 환경이면 그 checkbox는 비활성 + 이유 글자. `다음`.
  2. 범위: `QuestionRangePicker`(QVIEW-01과 같음; `전체 선택`, 장·문제 checkbox, 필터) + "선택 n문제 중 m문항을 만듭니다" 글자 + 안내 "고른 문제의 발문·보기·정답·해설과 관련 본문이 AI 서비스로 전송됩니다."(LLM 유형을 골랐을 때) + `이전`·`만들기`(선택 0이면 비활성 + "출제 범위를 고르세요").
  - `만들기` → 저장하고 상세 화면으로 가서 생성 진행을 보인다.
- **상세 화면:** header 이름 · 상태 badge · 메타(설정 요약, 회차 "2회차", 만든 시각) · `풀기` · 편집 권한: `설정 바꾸기`(만들기 화면과 같은 두 단계, 현재 값이 채워짐, 마지막 버튼 `다시 만들기`)·`다시 만들기`(설정 그대로)·`이름 바꾸기`·`삭제`.
  - 문제 목록: "문제 k · <발문 앞 40자>" · 변형 유형 badge · 출처 "3장 12번"(원본 문제 번호; 원본이 지워졌으면 "원본 삭제됨") · "편집됨"·"확인 필요" badge(편집 권한자만). 편집 권한자가 행을 누르면 QuestionViewer `manage` 방식(modal)으로 열려 정답·해설을 보고 `편집`(QBANK 문제 편집기와 같은 발문·보기·정답·해설 field, 저장하면 새 revision)·`이 모의고사에서 빼기`(`ConfirmDialog`)를 한다. 보기 권한자의 행은 정답이 보이지 않는 미리보기만(풀기 전 정답 노출 방지)이다.
  - 생성 중: `ProgressBar` "20개 중 7개" + "문제를 만드는 중입니다. 창을 닫아도 계속 만듭니다." 다시 만드는 중에는 이전 문제 목록을 그대로 보이고 위에 진행 줄.
  - 실패: alert "모의고사를 만들지 못했습니다" + 이유 + `다시 시도`(편집 권한). 이유 문구: `llm_unavailable`·`llm_timeout` → "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.", `no_valid_questions` → "검증을 통과한 문제를 만들지 못했습니다. 범위나 변형 유형을 바꿔 보세요.", `no-matching-questions` → "범위에 맞는 확정 문제가 없습니다.", 그 밖 → "모의고사를 만들지 못했습니다. 다시 시도하세요."
  - 일부만 만듦: "20문항 중 17문항을 만들었습니다. 3개는 검증을 통과하지 못했습니다." + `다시 만들기`.
- **삭제:** `ConfirmDialog` "‘<이름>’을 삭제할까요? 문제와 내 풀이 기록이 목록에서 사라집니다." → soft delete(목록에서 빠짐; 풀이 기록 행은 남음). 생성 중이면 job을 취소한다.
- **이름 바꾸기:** 행·상세의 인라인 입력(Enter 저장, Escape 취소, 1~100자, 같은 Workspace 안 중복 허용).

## 화면 상태

| 상태 | 편집 권한 | 보기 권한 | 공유 게스트 |
|---|---|---|---|
| 목록 불러오는 중 | skeleton(`aria-busy`) | 같음 | 메뉴 없음 |
| 모의고사 없음 | 빈 상태 + `추가` | "아직 모의고사가 없습니다." | — |
| 만드는 중 | 진행 + 상세 진입 가능, `풀기` 없음(다시 만드는 중이면 이전 문제로 `풀기` 가능) | 같음(동작 없음) | — |
| 준비됨·일부만 만듦 | `풀기`·편집·다시 만들기·삭제 | `풀기` | — |
| 실패 | alert + `다시 시도`(이전 회차가 있으면 그 문제 유지) | alert | — |
| 확정 문제가 없는 Workspace | `추가`는 보이고 범위 단계에 "아직 확정된 문제가 없습니다." | 목록만 | — |
| LLM 기능 꺼짐(환경) | LLM 유형 비활성 + 이유, `보기 섞기`만 가능 | 영향 없음 | — |
| 보관된 Workspace | 읽기 전용(`추가`·편집·삭제 없음, `풀기`는 보기만·제출 불가 — QVIEW-01-AC07) | 같음 | — |
| 삭제·다른 Workspace 모의고사 딥링크 | "모의고사를 찾을 수 없습니다."(404) | 같음 | 404 |

## 접근성

- non-modal dialog: 닫기 버튼·Escape(focus가 안에 있을 때)로 닫고 연 `문제` 메뉴 버튼으로 focus 복귀(QOV-01-AC10). 목록 ↔ 만들기 ↔ 상세 전환 때 focus는 새 화면의 제목(heading)으로 간다.
- 상태 badge·"확인 필요"·"편집됨"은 글자로 전달한다(색만으로 전달하지 않음). 생성 진행은 `ProgressBar` 값 글자 + 완료·실패 때 `aria-live="polite"` 알림.
- 행 메뉴는 Radix DropdownMenu(접근성 이름 "<이름> 메뉴"), 아이콘 버튼은 접근성 이름을 가진다. `QuestionRangePicker` 접근성은 QVIEW-01과 같다.
- 375px에서 가로 스크롤 없음, 버튼 문구는 줄바꿈하지 않고 버튼 단위로 넘어간다.

## 수용 기준

### MOCK-01-AC01

- **Given:** 확정 문제가 있고 모의고사가 없는 Workspace 홈(편집 권한, 그리고 보기 권한)
- **When:** header `문제` 메뉴를 열어 `모의고사`를 고른다
- **Then:** 메뉴에 `변형 출제` 항목은 없고 `모의고사`가 있다. non-modal dialog "모의고사"(`?panel=mock-exams`)가 데이터 응답 전에 열려 skeleton 뒤 빈 상태 "아직 모의고사가 없습니다."를 보인다. 편집 권한자에게는 목록 위에 `추가` 버튼이 하나 있고 보기 권한자에게는 없다. 이전 URL `?panel=generate`는 `?panel=mock-exams`로 바뀐다. dialog는 다른 홈 dialog(문서 관리)와 함께 열리고 나중에 연 것이 위에 온다.

### MOCK-01-AC02

- **Given:** 두 장에 확정 문제 6개와 초안 2개가 있는 Workspace(편집 권한), 결정적 fake LLM
- **When:** `추가` → 이름 "중간 점검", `문구 변형`·`정오 반전` 선택, 문항 수 4 → `다음` → 범위에서 `전체 선택` → `만들기`
- **Then:** 만들기 화면은 `옵션 → 범위` 두 단계를 보이고 변형 유형 checkbox 4개(`보기 섞기`·`문구 변형`·`정오 반전`·`유사 개념`)가 있다. 범위 단계는 확정 문제 6개만 보이고 "선택 6문제 중 4문항을 만듭니다"와 AI 전송 안내를 보인다. `만들기` 뒤 상세 화면이 "만드는 중"과 진행 "4개 중 k개"를 보이다가 `준비됨`, 문제 4개(각 행에 변형 유형 badge와 출처 "n장 m번")로 바뀐다. 홈의 Heatmap marker 수·문제 수·`GET /questions/overview`는 만들기 전과 같다(모의고사 문제는 은행에 없음). 목록으로 돌아가면 행 "중간 점검 · 준비됨 · 문제 4개 · 문구 변형, 정오 반전"이 있다.

### MOCK-01-AC03

- **Given:** 두 장(1장 4문제, 2장 2문제) 중 1장에 즐겨찾기 1개가 있는 Workspace의 만들기 범위 단계
- **When:** `전체 선택`을 켜고, 2장 checkbox를 끄고, 1장을 펼쳐 문제 하나를 끄고, 필터 `즐겨찾기만`을 켠 뒤 끄고, `전체 선택`을 두 번 누른다
- **Then:** `전체 선택`으로 6문제가 선택되고, 2장을 끄면 "선택 4문제"와 `전체 선택` mixed(`aria-checked="mixed"`), 1장 문제 하나를 끄면 1장 checkbox도 mixed·"선택 3문제"다. `즐겨찾기만`을 켜면 보이는 문제만 남고 선택도 그 안으로 줄어든다. `전체 선택`을 두 번 누르면 전부 선택 → 전부 해제가 되고 해제 상태에서 `만들기`는 비활성이며 "출제 범위를 고르세요"를 보인다. 같은 조작이 키보드(Tab·Space)만으로 된다.

### MOCK-01-AC04

- **Given:** AC02로 만든 모의고사 "중간 점검"
- **When:** 페이지를 새로 고쳐 다시 `모의고사`를 열고, 행 메뉴 `이름 바꾸기`로 "기말 대비"로 바꾸고, 다른 모의고사 하나를 행 메뉴 `삭제`(확인)로 지우고, 지운 모의고사의 상세 URL을 연다
- **Then:** 새로 고친 뒤에도 모의고사와 문제 4개가 그대로 있다(저장됨). 이름은 목록·상세에 "기말 대비"로 바뀌고 새로 고쳐도 유지된다. 삭제 확인 dialog를 거쳐 그 행이 사라지고 "모의고사 n개"가 줄어든다. 지운 모의고사의 상세 URL은 "모의고사를 찾을 수 없습니다."를 보이고 `GET /mock-exams/{id}`는 404다.

### MOCK-01-AC05

- **Given:** 문제 4개인 모의고사의 상세 화면(편집 권한), 그 모의고사의 문제 하나를 이미 푼 기록
- **When:** 문제 1을 눌러 `편집`으로 발문과 해설을 고쳐 저장하고, 문제 2를 `이 모의고사에서 빼기`(확인)하고, 문제 1을 다시 연다. 보기 권한자로 같은 상세를 연다
- **Then:** 문제 1은 QuestionViewer `manage` 방식으로 정답·해설과 함께 열리고, 저장하면 고친 발문·해설이 보이며 행에 "편집됨" badge가 붙는다(새 revision; 이미 한 풀이 기록은 그때의 revision을 가리켜 그대로). 문제 2를 빼면 목록이 "문제 3개"가 되고 이후 `풀기` 범위에 없다. 보기 권한자의 상세에는 `편집`·`빼기`·`설정 바꾸기`·`다시 만들기`·`삭제`가 없고 문제 행을 눌러도 정답·해설이 보이지 않는다.

### MOCK-01-AC06

- **Given:** `문구 변형`으로 만든 문제 4개인 모의고사(편집 권한), 두 번째 생성은 실패하도록 설정된 fake 시나리오
- **When:** `설정 바꾸기`에서 `보기 섞기`만 남기고 범위에서 2장만 고른 뒤 `다시 만들기`(확인) → 완료를 기다린다. 이어서 실패 시나리오로 `다시 만들기`한다
- **Then:** 확인 dialog는 "지금 문제 4개를 새로 만든 문제로 바꿉니다. 편집한 문제도 바뀝니다."를 보인다. 다시 만드는 동안 이전 문제 4개가 그대로 보이고 진행 줄이 위에 있다. 끝나면 문제 목록이 2장 원본의 `보기 섞기` 문제로 바뀌고 메타가 "2회차"다. 실패하면 alert "모의고사를 만들지 못했습니다"와 이유, `다시 시도`가 보이고 문제 목록은 2회차 문제 그대로다. 바뀐 설정은 새로 고쳐도 `설정 바꾸기`에 남는다.

### MOCK-01-AC07

- **Given:** 모의고사가 있는 Workspace — 보기 권한 구성원, 보관된 Workspace의 Owner, 그 Workspace의 공유 링크 게스트, 다른 Workspace의 편집자
- **When:** 보기 권한자가 목록을 열고 `POST /workspaces/{id}/mock-exams`·`PATCH`·`DELETE`를 직접 부른다. Owner가 보관된 Workspace에서 목록·상세를 연다. 게스트가 `/share/:shareId`를 연다. 다른 Workspace 편집자가 그 모의고사 id로 GET·PATCH를 부른다
- **Then:** 보기 권한자는 목록과 `풀기`만 보이고 쓰기 API는 403이다. 보관된 Workspace에서는 `추가`·행 메뉴·편집 동작이 없고 쓰기 API는 403 `workspace-archived`이며 `풀기`는 열리지만 제출이 비활성이다. 게스트 화면에는 `모의고사` 진입점이 없다. 다른 Workspace 편집자의 요청은 404다.

### MOCK-01-AC08

- **Given:** fake 시나리오: 원본 하나는 정오 반전 결과가 복수 정답(검증 실패)이고 다시 요청해도 실패한다. 또 모든 후보가 실패하는 범위, LLM 기능이 꺼진 stack 설정
- **When:** `정오 반전`으로 문항 수 3을 만들고, 모든 후보가 실패하는 범위로 만들고, LLM 기능이 꺼진 환경에서 `추가`를 연다
- **Then:** 첫 모의고사는 `일부만 만듦`과 "3문항 중 2문항을 만들었습니다. 1개는 검증을 통과하지 못했습니다."를 보이고 복수 정답 문제는 목록·`풀기`·API 어디에도 없다. 모두 실패하면 `실패`와 "검증을 통과한 문제를 만들지 못했습니다. 범위나 변형 유형을 바꿔 보세요."이다. LLM 기능이 꺼진 환경에서는 `문구 변형`·`정오 반전`·`유사 개념`이 비활성이고 이유 "이 환경에서는 AI 변형을 쓸 수 없습니다."를 보이며 `보기 섞기`만으로 만들 수 있다.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/questions/mock_exams/test_mock_exams_contract.py`, `apps/worker/tests`, `packages/core/tests`, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| MOCK-01-C01 | **은행 격리:** 모의고사 생성·편집·풀이는 `questions`·`question_revisions`·`question_drafts`·`question_lineage`·`question_user_states`·`question_attempts`에 행을 만들거나 바꾸지 않는다(행 수·갱신 시각 비교). overview·Heatmap·검색 색인(Qdrant payload)·정리 노트 입력·Fork snapshot에 모의고사 문제가 없다. 모의고사 문제를 확정 문제로 등록하는 API는 없다. |
| MOCK-01-C02 | **검증이 저장 조건:** worker는 원본마다 `VariantGenerator`를 후보 1개로 부르고 승인 차단 검증(형식·정답 개수·정오 반전 정답 불일치·중복 fingerprint·출처 근거)을 통과한 결과만 `mock_exam_questions`에 저장한다. 실패하면 그 원본으로 한 번 다시 요청하고, 그래도 실패면 건너뛴다(`skipped` 수 기록). 저장된 문제가 0이면 회차 `failed`/`no_valid_questions`. LLM이 선언한 정답은 검증 없이 쓰지 않는다. |
| MOCK-01-C03 | **범위·선택 재현:** 생성 요청의 범위는 서버가 이 Workspace의 살아 있는 CONFIRMED 문제로 푼다(QVIEW-01-C01과 같은 resolver; 다른 Workspace·초안 id는 422 `range-invalid`, 0개면 409 `no-matching-questions`). 원본 선택과 변형 유형 배정은 회차에 저장된 seed로 재현된다(같은 seed·같은 후보 → 같은 원본·유형). 회차는 원본 `question_revision_id`를 고정한다. |
| MOCK-01-C04 | **회차·이력:** `다시 만들기`는 새 회차(`version + 1`)를 만들고 성공하면 `mock_exams.current_generation_id`를 바꾼다. 이전 회차와 그 문제·revision·풀이 기록은 지우지 않는다. 모의고사마다 대기·실행 중 회차는 하나(partial unique; 진행 중 POST 409 `mock-generation-running`). 문제 편집은 새 `mock_exam_question_revisions` 행, 빼기는 `removed_at`(soft). 이름·설정 변경은 `mock_exam_revisions` 행을 남긴다. 풀이 기록·revision 행은 UPDATE·DELETE 불가(pgTAP). |
| MOCK-01-C05 | **인가 matrix:** GET(목록·상세·문제 목록)은 모든 구성원(보관 Workspace 포함), 쓰기(만들기·PATCH·DELETE·다시 만들기·문제 편집·빼기)는 owner·editor이고 활성 Workspace만(보관 403 `workspace-archived`). 다른 Workspace·삭제된 모의고사 404. 공유 세션은 모든 모의고사 API에 404. 보기 권한자의 문제 목록·문제 상세 응답에는 정답·해설이 없다(편집 권한자의 `manage` 응답에만 있음). |
| MOCK-01-C06 | **한도(비용 보호):** 문항 수 1~50(초과 422). Workspace에서 대기·실행 중인 모의고사 회차 수가 한도(`MOCK_EXAM_MAX_RUNNING_PER_WORKSPACE`, 기본 5)를 넘으면 409 `generation-busy`. 사용자별 생성 시작 분당 횟수 제한(`MOCK_EXAM_GENERATION_RATE_LIMIT_PER_MINUTE`, 기본 6) 초과 429 + Retry-After. `Idempotency-Key`로 재시도하면 같은 회차를 돌려준다. |
| MOCK-01-C07 | **유출 금지:** 문제·해설·근거 본문·prompt·LLM 응답은 API·worker 로그, job `result`(만든 수·건너뛴 수·usage·오류 코드만), 활동 기록(`mock_exam.*`은 id·개수만), trace에 남지 않는다. |
| MOCK-01-C08 | **원본 변경·삭제:** 원본 확정 문제를 편집·삭제·보관해도 이미 만든 모의고사 문제는 바뀌지 않고 그대로 풀 수 있다(출처는 "원본 삭제됨"). 다시 만들 때는 그때의 범위로 다시 풀므로 삭제·보관된 원본은 빠진다. Workspace 삭제 시 모의고사 API는 404. |

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- MOCK.0의 RED는 "모의고사 메뉴·API 없음"으로 실패해야 한다(infra·seed 문제로 실패하면 안 됨). QGEN-01 테스트는 QGEN-RM 전까지 GREEN으로 남는다 — AC01의 "`변형 출제` 항목 없음"·`?panel=generate` redirect 확인은 QGEN-RM 이후에 GREEN이 된다(MOCK-W는 `모의고사` 항목을 더하고 QGEN-RM이 `변형 출제`를 뺀다). 그래서 orchestrator는 QGEN-RM이 GREEN인 뒤에 `MOCK.0`을 CI `E2E_PHASES`에 넣는다(implementation-plan §3 MOCK).
