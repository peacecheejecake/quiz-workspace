# MOCK-01 — 모의고사 목록·만들기·편집 Floating Dialog

> **UX12 개정(2026-11-06):** 만들기·설정 바꾸기 화면의 단계, 필터, 하단 버튼은 [UX12-MOCKFORM](ux12-mock-form.md)이 이 문서보다 우선한다.
>
> **UX10 개정 예정(2026-11-05):** [확정 구현 기준](../implementation/ux10/index.md)의 해당 변경 요구가 이 문서의 이전 동작에 우선한다. 구현 Task의 RED 단계에서 해당 AC·trace를 함께 갱신한다. 변경되지 않은 요구·보안 경계는 유지한다.

**상태:** 확정 화면 요구사항 v1.0 · MOCK-SPEC 신규 2026-11-01 (사용자 요청 "변형 출제 -> '문제 생성' 삭제 / 대신 '모의고사' 기능 추가 — 모의고사 리스트 화면 필요, 리스트 위 '추가' 버튼 눌러 생성, 다른 화면과 레이아웃 비슷하게 — 생성 버튼을 누르면 현재 '변형 유형'에 해당하는 옵션과 출제 문제 범위 선택 화면 — 한 번 생성한 모의고사는 저장됨(수정, 삭제 가능) — 문제 선택에는 전체 선택 기능이 필요", 사용자 결정 1·2·4) · MOCK-SYNC 개정 2026-11-02 (UX7의 `문제` 메뉴·보관·초안 문제·중복 정리에 맞춤)
**Route:** 목록 `/workspaces/:workspaceId?panel=mock-exams` · 만들기 `?panel=mock-exams&mock=new` · 상세·편집 `?panel=mock-exams&mock=:mockExamId` (Workspace header `문제` 메뉴 › `모의고사`가 여는 non-modal floating dialog "모의고사") · 풀기는 QuestionViewer(`?practice=new&source=mock&mock=:mockExamId`, [QVIEW-01](question-viewer.md))
**테스트:** `tests/e2e/questions/mock-exams.spec.ts` (계약: `tests/integration/questions/mock_exams/test_mock_exams_contract.py`, `apps/worker` · `packages/core` unit test, `supabase/tests` pgTAP)
**Phase:** MOCK.0 (RED) → MOCK-B (생성·편집 계약) → MOCK-P (풀이 계약) → MOCK-W (AC02~AC08) → QGEN-RM (AC01, CI phase 켬)
**연계:** [QVIEW-01](question-viewer.md), [QOV-01](questions-overview.md), [QGEN-01 (폐지)](questions-generation.md), [Questions 명세](../questions.md) §5·§11, [공유 명세](../workspace-sharing.md) §9, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: MOCK-01
route: /workspaces/:workspaceId?panel=mock-exams
actor: workspace_member (목록·풀기) · editor/owner (만들기·편집·다시 만들기·삭제)
permission: read · edit
status: confirmed
api: [GET /api/v1/workspaces/:id/mock-exams, POST /api/v1/workspaces/:id/mock-exams, GET /api/v1/mock-exams/:id, PATCH /api/v1/mock-exams/:id, DELETE /api/v1/mock-exams/:id, POST /api/v1/mock-exams/:id/generations, GET /api/v1/mock-exams/:id/questions, PATCH /api/v1/mock-exam-questions/:id, DELETE /api/v1/mock-exam-questions/:id]
components: [FloatingSidePanel, Button, QuestionRangePicker, Checkbox, Select, ProgressBar, ConfirmDialog, DropdownMenu, QuestionViewer, Badge, EmptyState]
linked_tests: [MOCK-01-AC01 … MOCK-01-AC08]
```

## 목적과 정책

- **모의고사 = 저장된 출제 설정 + 그 설정으로 만든 문제 묶음.** 편집 권한자가 이름·변형 유형 옵션·출제 범위를 정해 만들면 서버가 범위의 확정 문제를 원본으로 문제를 만들어 저장한다. 만든 모의고사는 목록에 남고 이름 바꾸기·문제 편집·빼기·설정 바꿔 다시 만들기·삭제를 할 수 있다(사용자 결정 4).
- **모의고사 문제는 그 모의고사 안에만 있다 (사용자 결정 2 — 의도된 예외):** 만들어지는 즉시 풀 수 있고 문제은행(확정 문제)·Heatmap·문제 수·홈 검색·정리 노트 입력에 들어가지 않는다. 그래서 "생성·가져온 문제는 사람이 승인할 때까지 초안" 규칙(AGENTS.md §5 Data)은 모의고사 문제에 적용되지 않는다 — 모의고사 문제는 은행에 들어가는 경로가 없다(승인·등록 API 없음). AGENTS.md 문구 보완은 후속(implementation-plan §7).
- **변형 출제 대체 (사용자 결정 1):** 이전 `문제` 메뉴 › `변형 출제`와 "문제 생성" dialog(QGEN-01, 묶음 QGEN-MULTI 포함)는 없어지고 그 자리에 `모의고사`가 온다. 생성 엔진(변형 유형별 LLM 생성·검증·fake adapter)은 재사용한다(아래 "재사용과 폐지").
- **옵션 = 지금의 변형 유형 (사용자 요청):** 만들기 화면의 옵션은 QGEN-01 생성 form과 같은 변형 유형이다: `보기 섞기`(`OPTION_SHUFFLE`, 원본 문제를 그대로 옮기고 보기 순서만 섞음 — LLM 없음), `문구 변형`(`PARAPHRASE`), `정오 반전`(`INVERT_POLARITY`), `유사 개념`(`ANALOGOUS_CONCEPT`). 하나 이상 고른다. 그 밖의 옵션:
  - `문항 수`: AI 변형 유형(`문구 변형`·`정오 반전`·`유사 개념`)을 하나라도 고르면 1~**100**(기본 20) (사용자 결정 2026-11-01: "더 많이는 안 될까?" → 100문항까지, 기본 20). `보기 섞기`만 고르면 LLM이 없으므로 한도는 범위 문제 수이고 `범위 전체`도 고를 수 있다(풀이 묶음 한도와 같은 5,000문제까지). 서버가 범위에서 원본을 `min(문항 수, 범위 문제 수)`개 고르고(범위가 문항 수보다 크면 seed로 임의 선택, 작으면 전부) 원본마다 문제 1개를 만든다. 원본마다 쓸 변형 유형은 고른 유형 중에서 seed로 고르게 돌려 정한다(사용자 결정 2026-11-01 — b의 배정 방식). QGEN-01의 `후보 수`는 없다(원본 하나 = 문제 하나). 원본 하나당 LLM 호출 하나가 아니다 — 아래 "LLM 호출 묶기"처럼 여러 원본을 한 호출로 만든다.
  - `난이도`(선택, `쉬움`·`보통`·`어려움`, 기본 "원본과 같게") — QGEN-01 form과 같다.
- **범위 (사용자 결정 2026-11-01):** QVIEW-01과 같은 `QuestionRangePicker`(장 그룹 → 문제 checkbox, 맨 위 `전체 선택`, 상태·즐겨찾기 필터, 유형 체크박스)로 이 Workspace의 확정 문제를 고른다. 보관된 문제(중복 정리로 보관된 중복 포함)·초안은 고를 수 없고, 상태·즐겨찾기 필터는 합쳐진 중복의 기록까지 합친 상태로 판정한다(Heatmap과 같음, QVIEW-01-C07). 저장되는 범위는 사람이 고른 의도(`전체 선택` 여부·장·개별 문제·제외 문제·필터)이고, 다시 만들 때 그 의도를 그때의 확정 문제로 다시 푼다(새로 등록된 문제는 `전체 선택`·장 선택이면 포함).
- **만든 직후 바로 사용:** 생성 결과 중 기계 검증(형식·정답 개수·중복·출처 근거 — 이전 QGEN의 승인 차단 검증)을 통과한 문제만 저장되고 곧바로 `풀기`에 쓰인다. 통과하지 못한 후보는 저장·표시하지 않는다(실패 항목은 모아서 함께 한 번 다시 요청, 그래도 실패면 그 원본은 건너뜀). 승인을 막지 않는 경고(`warning`)는 편집 권한자에게 문제 행의 "확인 필요" 글자 badge와 편집 화면의 안내로만 보이고 풀이 화면에는 보이지 않는다.
- **다시 만들기 (사용자 결정 2026-11-01):** 설정(변형 유형·문항 수·난이도·범위)을 바꾸거나 그대로 `다시 만들기`하면 새 회차(generation)로 문제를 모두 새로 만들고, 성공하면 모의고사의 문제 목록을 새 회차로 **바꾼다**. 이전 회차 문제와 그 풀이 기록은 지우지 않고(풀이 기록 불변) 화면에서 숨긴다(v1에 이전 회차 열람 없음). 새 회차가 실패하면 이전 문제가 그대로 남는다. 사람이 편집한 문제도 다시 만들면 바뀐다(확인 dialog에서 알림).
- **공유 범위 (사용자 결정 2026-11-01):** 모의고사는 Workspace 단위다 — 모든 구성원이 목록을 보고 풀 수 있고(풀이 기록은 사람마다), 편집 권한자가 만들고 고친다. 공유 링크 게스트에게는 보이지 않고 Fork에 복제되지 않는다(v1; [공유 명세 §9](../workspace-sharing.md)).
- **환경별 사용 여부:** LLM 변형 유형은 worker 설정 `WORKER_MOCK_EXAMS`와 LLM 설정이 있을 때만 고를 수 있다. 꺼진 환경에서도 `보기 섞기`만 고른 모의고사는 만들 수 있고(LLM 없음) 저장된 모의고사는 풀 수 있다 (사용자 결정 2026-11-01).
- **AI 질문·AI 해설·관련 본문 (ASK-SPEC 사용자 결정 2026-11-01 (27)·(30); ASK-SYNC 2026-11-02 — 구현 ASK-B·ASK-Q·EXPL-B·EXPL-W·RELSRC-B·RELSRC-W):** 모의고사 문제의 `질문하기`는 풀이(QuestionViewer `sequence(mock)`) header — 채점 뒤에만, `full`([UX12-RUNASK](ux12-run-ask.md)) — 와 편집 권한의 문제 관리(`manage(mock)`) header에 있다([ASK-01](ask-llm.md) AC12·C10). 제출 결과 아래에는 `AI 해설`([AIEXPL-01](ai-explanations.md) AC07·C09)과 "관련 본문"([RELSRC-01](related-sources.md) AC06·C07)이 등록 문제와 같은 자리에 나오고, 편집 권한의 문제 관리(`manage(mock)`)에서는 제출 없이 해설 아래에 나온다(사용자 결정 2026-11-02, ASK-SYNC (a)). 셋 다 `mock_exam_question_revisions` 행을 기준으로 하고(해설·관련 본문 캐시는 `mock_exam_question_ai_explanations`·`mock_exam_question_related_sources`, 원본 등록 문제와 공유하지 않음), 근거 구절은 그 revision의 `evidence` 중 현재 발행 `book` 블록만 쓴다. 질문·해설·관련 본문은 `mock_exam_attempts`와 이 화면의 진행·결과를 바꾸지 않는다. 이 화면의 기존 AC는 바뀌지 않는다.

## 재사용과 폐지 (QGEN-01 생성 엔진)

| 부분 | 처리 |
|---|---|
| `book_core.generation`(`VariantGenerator`, `prompts`, `validation`의 형식·정답 개수·정오 반전 정답 불일치·중복 fingerprint·출처 근거 검증) | `validation`·`models`는 **재사용**(바꾸지 않음). `prompts`·`VariantGenerator`의 원본 하나 단위 호출 대신 모의고사는 여러 원본을 한 호출로 만드는 묶음 prompt(`book_core.mock_exam`, 아래 "LLM 호출 묶기")를 쓰고, 응답 항목마다 같은 검증 함수를 부른다. 검증 결과에 `error` issue가 하나라도 있으면 저장하지 않는다 — QGEN이 후보를 버리던 코드(`is_rejection`)만이 아니라 승인을 막던 모든 `error`(예: `inverted_answer_mismatch`)가 저장을 막는다(MOCK-B, MOCK.0 발견). 사람의 승인 대신 이 검증이 저장 조건이다. |
| `OPTION_SHUFFLE` 결정적 shuffle(M5.2) | **재사용**: 모의고사 문제는 원본 revision의 발문·보기·정답·해설을 복사하고 보기 순서를 seed로 섞어 저장한다(풀이 때 보기 섞기는 QVIEW-01 세션 규칙 그대로). |
| fake LLM adapter·`tests/fixtures/llm/generation-scenarios.json` | **재사용**(E2E·계약 test). fake adapter가 묶음 응답(원본 여러 개 → 항목 여러 개)을 돌려주고 호출 수를 기록하도록 넓히고, 모의고사용 시나리오(정상 묶음·항목 하나만 정오 반전 복수 정답·해석할 수 없는 묶음·출력 예산에서 잘린 묶음·전부 실패·두 번째 생성 실패)를 같은 파일에 추가한다. |
| worker `question.generate` job의 원본 읽기·근거 passage 검색·근거 좁히기(`source_question`, `build_passages`, `narrow_evidence`) | **재사용**: 공용 모듈 `quiz_worker.question_sources`로 옮겨 새 job `mock_exam.generate`가 쓴다. `question.generate` job 등록은 QGEN-RM에서 뺐고, job module·run store는 UX8-QGEN-DEAD에서 지웠다. |
| `question_generation_runs`·생성 `question_drafts`·`question_lineage` 테이블과 기존 행 | **보존**(additive-first; 삭제 migration 없음). 새 행은 생기지 않는다. 승인되지 않은 기존 생성 초안은 검토 화면이 없어져 볼 수 없게 된다 — 보존만 하고 지우지 않는다(사용자 결정 2026-11-01). 이미 등록된 변형 문제와 lineage는 그대로 확정 문제다. |
| API `POST /questions/{id}/generations`, `/question-generations/*`, `/workspaces/{id}/question-generation-batches*` | **폐지**(QGEN-RM에서 router 제거 → 404). OpenAPI·api-client 재생성. 생성 초안 재검증(`question_generation_review`)·API repository·묶음 rate limit 설정(`QUESTION_GENERATION_BATCH_RATE_LIMIT_PER_MINUTE`)은 UX8-QGEN-DEAD에서 지웠고, `PATCH /question-drafts/{id}`는 import 초안만 받는다(생성 초안 404). |
| 화면: `문제` 메뉴 `변형 출제`, "문제 생성" dialog(`?panel=generate`), 검토 페이지·묶음 결과 페이지(`/questions/generate?…`), 문제 상세의 `변형 출제` | **폐지** (QGEN-RM 2026-11-02). 이전 URL은 홈으로 redirect(`?panel=generate` → `?panel=mock-exams`, `/questions/generate?…` → `?panel=mock-exams`). |
| 이력의 `question_generation.*` 활동·"문제 생성" 작업 label | **보존**(과거 기록 표시용). |

## LLM 호출 묶기 (batching — 사용자 결정 2026-11-01 "API 호출을 최소화")

사용자 질문 "꼭 한 문제당 하나의 call이어야 하나?" → **목표는 LLM API 호출 수 최소화**다. 원본마다 호출하던 QGEN(`prompts.build_request`: 원본 하나·변형 유형 하나에 후보 `candidate_count`개)과 달리, 모의고사는 한 호출에 원본 여러 개의 문제를 함께 만든다.

- **token 예산으로 채운다:** 한 호출에는 model context와 출력 예산에 들어가는 만큼 원본을 최대한 넣는다. 입력 예산 `MOCK_EXAM_MAX_PROMPT_TOKENS`(기본 60,000 — 지시문·원본·근거 passage 전부 포함), 출력 예산 `MOCK_EXAM_MAX_OUTPUT_TOKENS`(기본 16,000; 문제 하나 출력 ≈ 400 token으로 추정해 자리를 남김), `MOCK_EXAM_SOURCES_PER_CALL`(기본 40)은 **상한일 뿐**이다. token 수는 provider tokenizer가 있으면 그것으로, 없으면 보수적인 글자 수 기반 추정으로 센다. 기본값은 MOCK-B·MOCK-X eval에서 model에 맞춰 조정한다(model context보다 크게 둘 수 없음 — 설정 검사).
- **passage는 한 번만:** 근거 passage를 공유하는 원본(같은 장·같은 블록)은 같은 호출에 모은다. 한 호출 안에서 passage는 중복 없이 한 번만 `P1`, `P2`, …로 싣고 원본(`S1`, `S2`, …)들이 그 tag를 인용한다. 묶기는 결정적이다(같은 plan → 같은 묶음; 장·블록 순서로 정렬한 뒤 예산이 찰 때까지 채움). 변형 유형이 다른 원본도 한 호출에 넣는다(항목마다 유형 지시).
- **혼자서 예산을 넘는 원본:** 원본 하나의 passage만으로 입력 예산을 넘으면 기존 근거 좁히기(`narrow_evidence`)·상위 passage만 남겨 예산에 맞추고, 그래도 넘으면 그 원본은 `source_too_large`로 건너뛴다.
- **항목마다 검증:** 응답의 각 항목(`S` tag 하나 = 문제 하나)을 그 원본 기준으로 따로 검증한다(MOCK-01-C02의 승인 차단 검증, 인용 tag는 그 호출에 실린 passage만). 모르는 `S` tag·중복 항목·빠진 원본은 실패 항목이다.
- **실패 항목 재요청은 함께 한 번:** 모든 묶음이 끝난 뒤 실패 항목 전부를 같은 방식으로 다시 묶어(대개 호출 1번) **한 번만** 다시 요청한다. 다시 실패한 항목은 건너뛴다(`skipped_count`).
- **해석할 수 없는 응답:** 묶음 응답이 schema에 맞지 않거나 출력 예산에서 잘리면 그 묶음을 반으로 나눠 각각 다시 요청한다(반복해서 나누되 원본 하나짜리 묶음이 또 실패하면 그 원본은 실패 항목으로 넘긴다; 이미 재요청을 거친 항목이면 건너뜀).
- **실행·checkpoint:** 묶음은 `MOCK_EXAM_GENERATION_CONCURRENCY`(기본 2)개까지 동시에 부른다. 묶음 하나가 끝날 때마다 그 결과(저장된 문제·실패 항목·usage·진행)를 한 트랜잭션으로 기록하므로(`mock_exam_generation_items`), job이 시간 한도·재전달로 다시 시작해도 끝난 묶음은 다시 부르지 않는다. job 시간 한도는 `ceil(묶음 수 / 동시 수 + 재요청) × LLM 호출 timeout`을 넘지 않게 설정 검사한다.
- **예상 호출 수**(원본 하나 ≈ 300 token, passage 원본당 ≈ 1,200 token이고 같은 장끼리 일부 공유, 문제 하나 출력 ≈ 400 token일 때): **20문항 → 1번**(+ 실패 항목이 있으면 1번), **100문항 → 3번**(40·40·20, 입력·출력 예산 모두 40개 이내) + 재요청 1번 ≈ 3~4번. passage가 큰 교재(원본당 ≈ 3,000 token, 공유 없음)면 입력 예산이 묶음을 ≈ 18개로 줄여 100문항 → 6번 + 1번. 해석할 수 없는 응답 하나마다 +2번(반으로 나눔). 원본마다 부르던 방식(100문항 → 100번 이상)과 비교해 1/20~1/30 수준이다. `보기 섞기`는 호출 0번.


**레이아웃 패턴 (floating dialog — 사용자 결정 2026-11-01):** 문서 관리 dialog([DOC-01](documents-library.md))와 보관·초안 문제 dialog(QOV-01-AC15)의 목록 dialog 패턴을 따른다(MOCK-SPEC 초안의 문제 PDF 관리 dialog는 UX7-DOCS에서 문서 관리로 합쳐져 없음) — Workspace header에서 여는 non-modal `FloatingSidePanel`, 제목·설명 header 없음(접근성 이름 "모의고사"), 위쪽 동작 영역 + 행 목록, 행은 제목 · 글자 badge · 메타 줄 · 오른쪽 아이콘 동작, 즉시 열리고 skeleton(QOV-01-AC09), 다른 홈 dialog와 쌓기(QOV-01-AC10). 만들기·상세는 같은 dialog 안에서 목록을 대신하고 위에 `BackLink` "모의고사 목록"을 둔다(넓은 화면 전환 없음). `BackLink` "모의고사 목록"도 목록 → 만들기·상세처럼 기록 항목을 하나 쌓는다(push — 그 뒤 뒤로가기는 dialog를 연 채 앞의 만들기·상세로 돌아간다) (사용자 결정 2026-11-02).

- **진입:** 홈의 primary `모의고사`(모든 구성원, [UX12-MOCKNAV](ux12-mock-nav.md)). 목록 위 `추가`는 모든 구성원에게 보인다(사용자 결정 2026-11-06, [UX12-MOCKNAV-AC05](ux12-mock-nav.md)).
- **목록 화면:**
  - 목록 위 동작 줄: 왼쪽 "모의고사 n개", 오른쪽 primary 버튼 `추가`(모든 구성원). 편집 권한이 없거나 보관된 Workspace에서는 같은 만들기 화면이 열리되 변형 유형이 비활성이라 변형 없는 원본 풀이만 시작하고, 모의고사는 저장하지 못한다.
  - 행: 이름(누르면 상세) · 상태 badge(`대기 중`·`만드는 중`·`준비됨`·`일부만 만듦`·`실패`) · 메타 줄 `문제 18개 · 문구 변형, 정오 반전 · 2026. 11. 1. 오후 3:28` · `풀기`(준비됨·일부만 만듦, 모든 구성원) · 행 메뉴(편집 권한: `이름 바꾸기`·`설정 바꾸기`·`삭제`). 만드는 중이면 메타 줄 아래 공통 `ProgressBar`("문제 생성 진행률", 값 글자 "20개 중 7개").
  - `이어 풀기` 묶음: 동작 줄 아래, 모의고사 행 위에 내가 끝내지 않은 원본 풀이(챕터별 `풀기` 포함)를 보인다. 행은 이름·진행 `3/10`·시각·`이어 풀기`·행 메뉴 `지우기`다. "모의고사 n개"에는 세지 않는다([UX12-RESUME](ux12-run-resume.md)).
  - 빈 상태(모의고사도 이어 풀 행도 없을 때): "아직 모의고사가 없습니다." 편집 권한자에게는 안내 "`추가`로 변형 유형과 범위를 골라 모의고사를 만드세요." (CTA는 위 `추가` 하나 — UX1 "CTA 하나" 규칙).
- **만들기 화면(`추가`):** 패널 제목 `모의고사`, 위쪽 고정 영역의 `StepList` `범위 → 옵션`(접근성 이름 "모의고사 단계", 지금 단계는 `aria-current="step"`, UX12-MOCKFORM, 순서는 사용자 요청 2026-11-06 [UX12-MOCKFORM2](ux12-mock-form-order.md)).
  1. 범위: `QuestionRangePicker`(QVIEW-01과 같음; `전체 선택`, 장·문제 checkbox, 필터) + 고정 footer의 `다음`(선택 0이면 비활성 + "출제 범위를 고르세요").
  2. 옵션: `이름`(필수, 기본값은 고른 챕터 이름, 전체 선택이나 챕터 정보가 없으면 "모의고사 <n>" — UX12-MOCKFORM2-AC02; 변형 유형을 고르지 않은 원본 풀이에는 없음 — UX12-PLAY-AC01), `변형 유형` checkbox 4개(설명은 제목 옆 `?` Popover 하나에 모음 — UX12-MOCKFORM2-AC04), `문항 수`(기본 `min(20, 선택 수)`), `난이도`. LLM 유형이 쓸 수 없는 환경이면 그 checkbox는 숨긴다. 저장된 AI 유형 설정은 보기 섞기로 정규화한다. "선택 n문제 중 m문항을 만듭니다" 글자 + 안내 "고른 문제의 발문·보기·정답·해설과 관련 본문이 AI 서비스로 전송됩니다."(LLM 유형을 골랐을 때) + 고정 footer의 `만들기`. 범위로 돌아가려면 완료된 1단계 버튼 `범위 단계로 돌아가기`를 누른다(입력값 유지).
  - `만들기` → 저장하고 상세 화면으로 가서 생성 진행을 보인다.
- **`풀기`:** QuestionViewer `sequence(mock)`(QVIEW-01 "진입 (mock)"). 범위 고르기는 그 모의고사의 문제를 출처 장별로 묶어(원본의 장, 생성 때의 장 순서, 장 없음·원본 삭제는 맨 뒤 "챕터 없음") 모두 선택된 채 보인다(사용자 결정 2026-11-02, MOCK-01-C10).
- **상세 화면:** header 이름 · 상태 badge · 메타(설정 요약, 회차 "2회차", 만든 시각) · `풀기` · 편집 권한: `더보기` 메뉴(UX12-MOCKNAV)의 `설정 바꾸기`(만들기 화면과 같은 두 단계, 현재 값이 채워짐, 마지막 버튼 `다시 만들기`)·`다시 만들기`(설정 그대로)·`이름 바꾸기`·`삭제`.
  - 문제 목록: "문제 k · <발문 앞 40자>" · 변형 유형 badge · 출처 "3장 12번"(원본 문제 번호; 원본이 지워졌으면 "원본 삭제됨") · "편집됨"·"확인 필요" badge(편집 권한자만). 편집 권한자가 행을 누르면 QuestionViewer `manage` 방식(modal)으로 열려 정답·해설을 보고 `편집`(홈 "문제 편집" dialog(QPLAY-01-AC07, UX7-BANK)와 같은 발문·보기·정답·해설 field, 저장하면 새 revision)·`이 모의고사에서 빼기`(`ConfirmDialog`)를 한다. 보기 권한자의 행은 정답이 보이지 않는 미리보기만(풀기 전 정답 노출 방지)이다.
  - 생성 중: `ProgressBar` "20개 중 7개" + "문제를 만드는 중입니다. 창을 닫아도 계속 만듭니다." 다시 만드는 중에는 이전 문제 목록을 그대로 보이고 위에 진행 줄.
  - 실패: alert "모의고사를 만들지 못했습니다" + 이유 + `다시 시도`(편집 권한). 이유 문구: `llm_unavailable`·`llm_timeout` → "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.", `no_valid_questions` → "검증을 통과한 문제를 만들지 못했습니다. 범위나 변형 유형을 바꿔 보세요.", `no-matching-questions` → "범위에 맞는 확정 문제가 없습니다.", `mock_llm_disabled` → "이 환경에서는 AI 변형을 쓸 수 없습니다. 설정을 바꿔 `보기 섞기`로 만들어 보세요.", 그 밖 → "모의고사를 만들지 못했습니다. 다시 시도하세요."
  - 일부만 만듦: "20문항 중 17문항을 만들었습니다. 3개는 검증을 통과하지 못했습니다." + `다시 만들기`.
- **삭제:** `ConfirmDialog` "‘<이름>’을 삭제할까요? 문제와 내 풀이 기록이 목록에서 사라집니다." → soft delete(목록에서 빠짐; 풀이 기록 행은 남음). 생성 중이면 job을 취소한다.
- **이름 바꾸기:** 행·상세의 인라인 입력(Enter 저장, Escape 취소, 1~100자, 같은 Workspace 안 중복 허용). 입력란의 Escape는 이름 바꾸기만 취소하고 dialog는 열어 둔 채 focus를 시작한 행 메뉴·`더보기` 버튼으로 돌려보낸다. 그다음 Escape가 dialog를 닫는다(MOCK-ESC, [design-system §5.1](../design-system.md)).

## 동시 실행 (문제 추출·문서 처리와 함께 — 사용자 보고 2026-11-06)

문제 추출과 모의고사 생성을 함께 돌리면 모의고사가 만들어지지 않는 것처럼 보였다. 생성이 실패한 것이 아니다. 두 job이 같은 `quiz.jobs` queue에 있었고 기본 worker 칸은 `WORKER_CONCURRENCY=1`이라, `question.import`·`document.parse`(한도 2시간)가 칸을 잡은 동안 `mock_exam.generate`는 받는 쪽이 없어 `queued`로 남았다. 화면은 그동안 `만드는 중`과 0개 진행을 보였다.

- **실행 칸:** `mock_exam.generate`는 자기 queue `quiz.ondemand`로 간다. 기본 worker와 interactive worker(`WORKER_QUEUE=interactive`)가 모두 이 queue를 읽으므로, 비어 있는 칸이 먼저 받는다. 문서·추출 job은 그대로 기본 worker에서만 돈다. 그래서 interactive worker가 있는 환경에서는 추출 중에도 모의고사가 만들어지고, 없는 환경에서는 기본 칸이 빌 때 시작하되 뒤에 쌓인 다른 문서 job을 기다리지 않는다.
- **대기 표시:** 회차가 `queued`인 동안 행과 상세의 badge는 `대기 중`이고, 진행 막대 아래에 "앞선 작업을 기다리고 있습니다. 문서 처리나 문제 추출이 끝나면 시작하고, 창을 닫아도 순서는 유지됩니다."를 보인다. worker가 받으면(`running`) `만드는 중`과 기존 문구로 바뀐다. 대기 중에도 polling은 이어지고, 시간이 지났다고 실패시키지 않는다. 그만두려면 삭제한다.
- **환경 설정:** interactive worker가 모의고사를 받으므로 `WORKER_MOCK_EXAMS`·`MOCK_EXAM_*`·LLM 변수는 기본 worker와 같은 값이어야 한다([runbook-deploy.md](../runbook-deploy.md) §11). 값이 다르면 그 회차는 `mock_llm_disabled`로 실패하고 이유를 보인다.

## 화면 상태

| 상태 | 편집 권한 | 보기 권한 | 공유 게스트 |
|---|---|---|---|
| 목록 불러오는 중 | skeleton(`aria-busy`) | 같음 | 메뉴 없음 |
| 모의고사 없음 | 빈 상태 + 안내 + `추가` | "아직 모의고사가 없습니다." + `추가`(원본 풀이만) | — |
| 대기 중(`queued`) | `만드는 중`과 같고 badge `대기 중` + 대기 문구("동시 실행") | 같음(동작 없음) | — |
| 만드는 중 | 진행 + 상세 진입 가능, `풀기` 없음(다시 만드는 중이면 이전 문제로 `풀기` 가능) | 같음(동작 없음) | — |
| 준비됨·일부만 만듦 | `풀기`·편집·다시 만들기·삭제 | `풀기` | — |
| 실패 | alert + `다시 시도`(이전 회차가 있으면 그 문제 유지) | alert | — |
| 확정 문제가 없는 Workspace | `추가`는 보이고 범위 단계에 "아직 확정된 문제가 없습니다." | 같음(원본 풀이만) | — |
| LLM 기능 꺼짐(환경) | LLM 유형 숨김, `보기 섞기`만 가능 | 영향 없음 | — |
| 보관된 Workspace | 읽기 전용(편집·삭제 없음, `추가`는 원본 풀이만, `풀기`는 보기만·제출 불가 — QVIEW-01-AC07) | 같음 | — |
| 삭제·다른 Workspace 모의고사 딥링크 | "모의고사를 찾을 수 없습니다."(404) | 같음 | 404 |

## 접근성

- non-modal dialog(UX9-SPEC 사용자 결정 2026-11-02 D3부터 modal — focus trap·배경 `inert`, Escape는 dialog 안 어디서든, [HOMEDLG-01](home-dialogs.md)): 닫기 버튼·Escape(focus가 안에 있을 때)로 닫고 연 `모의고사` 버튼으로 focus 복귀(QOV-01-AC10). 목록 ↔ 만들기 ↔ 상세 전환 때 focus는 새 화면의 제목(heading)으로 간다.
- 상태 badge·"확인 필요"·"편집됨"은 글자로 전달한다(색만으로 전달하지 않음). 생성 진행은 `ProgressBar` 값 글자 + 완료·실패 때 `aria-live="polite"` 알림.
- 행 메뉴는 Radix DropdownMenu(접근성 이름 "<이름> 메뉴"), 아이콘 버튼은 접근성 이름을 가진다. `QuestionRangePicker` 접근성은 QVIEW-01과 같다.
- 375px에서 가로 스크롤 없음, 버튼 문구는 줄바꿈하지 않고 버튼 단위로 넘어간다.
- **품질 suite (MOCK-X):** axe `A11Y-14`(`tests/e2e/quality/a11y-mock.spec.ts`, light·dark)가 목록(빈·채워진·행 메뉴)·만들기 두 단계(AI 변형 안내 포함)·상세(만드는 중·실패·일부만 만듦·2회차)·문제 `manage` dialog·확인 dialog(삭제·다시 만들기·빼기)를 검사하고, 키보드만으로 `추가` → 두 단계 → `만들기` → `풀기` → 제출까지 가는 흐름을 확인한다. visual `VISUAL-07`(`visual.spec.ts`, light·dark × desktop·iPad, desktop 실행에서 375px 폭도)은 목록·만들기 1단계·범위 2단계·상세만 찍는다 — 정답·해설이 보이는 `manage` dialog와 채점 뒤 상태는 screenshot에 남기지 않는다(e2e-strategy §7.1).

## 수용 기준

### MOCK-01-AC01

- **Given:** 확정 문제가 있고 모의고사가 없는 Workspace 홈(편집 권한, 그리고 보기 권한)
- **When:** header `문제` 메뉴를 열어 `모의고사`를 고른다
- **Then:** 메뉴에 `변형 출제` 항목은 없고 `모의고사`가 있다. non-modal dialog "모의고사"(`?panel=mock-exams`)(UX9-SPEC 사용자 결정 2026-11-02 D3: modal — [HOMEDLG-01](home-dialogs.md); test는 UX9-MODAL이 고침)가 데이터 응답 전에 열려 skeleton 뒤 빈 상태 "아직 모의고사가 없습니다."를 보인다. 목록 위에 `추가` 버튼이 하나 있고(보기 권한자에게도, UX12-MOCKNAV-AC05) 안내 글자는 편집 권한자에게만 있다. 이전 URL `?panel=generate`는 `?panel=mock-exams`로 바뀐다. dialog는 다른 홈 dialog(문서 관리)와 함께 열리고 나중에 연 것이 위에 온다.

### MOCK-01-AC02

- **Given:** 두 장에 확정 문제 6개와 초안 2개가 있는 Workspace(편집 권한), 결정적 fake LLM
- **When:** `추가` → 범위에서 `전체 선택` → `다음` → 이름 "중간 점검", `문구 변형`·`정오 반전` 선택, 문항 수 4 → `만들기`
- **Then:** 만들기 화면은 `범위 → 옵션` 두 단계를 보인다. 범위 단계는 확정 문제 6개만 보인다. 옵션 단계에는 변형 유형 checkbox 4개(`보기 섞기`·`문구 변형`·`정오 반전`·`유사 개념`)가 있고 "선택 6문제 중 4문항을 만듭니다"와 AI 전송 안내를 보인다. `만들기` 뒤 상세 화면이 "만드는 중"과 진행 "4개 중 k개"를 보이다가 `준비됨`, 문제 4개(각 행에 변형 유형 badge와 출처 "n장 m번")로 바뀐다. 홈의 Heatmap marker 수·문제 수·`GET /questions/overview`는 만들기 전과 같다(모의고사 문제는 은행에 없음). 목록으로 돌아가면 행 "중간 점검 · 준비됨 · 문제 4개 · 문구 변형, 정오 반전"이 있다.

### MOCK-01-AC03

- **Given:** 두 장(1장 4문제, 2장 2문제) 중 1장에 즐겨찾기 1개가 있는 Workspace의 만들기 범위 단계
- **When:** `전체 선택`을 켜고, 2장 checkbox를 끄고, 1장을 펼쳐 문제 하나를 끄고, 필터 `즐겨찾기만`을 켠 뒤 끄고, `전체 선택`을 두 번 누른다
- **Then:** `전체 선택`으로 6문제가 선택되고, 2장을 끄면 "선택 4문제"와 `전체 선택` mixed(`aria-checked="mixed"`), 1장 문제 하나를 끄면 1장 checkbox도 mixed·"선택 3문제"다. `즐겨찾기만`을 켜면 보이는 문제만 남고 선택도 그 안으로 줄어든다. `전체 선택`을 두 번 누르면 전부 선택 → 전부 해제가 되고 해제 상태에서 `다음`은 비활성이며 "출제 범위를 고르세요"를 보인다. 같은 조작이 키보드(Tab·Space)만으로 된다.

### MOCK-01-AC04

- **Given:** AC02로 만든 모의고사 "중간 점검"
- **When:** 페이지를 새로 고쳐 다시 `모의고사`를 열고, 행 메뉴 `이름 바꾸기` 입력에서 Escape를 두 번 누른 뒤 다시 열어 행 메뉴 `이름 바꾸기`로 "기말 대비"로 바꾸고, 상세의 `이름 바꾸기` 입력에서 Escape를 누르고, 다른 모의고사 하나를 행 메뉴 `삭제`(확인)로 지우고, 지운 모의고사의 상세 URL을 연다
- **Then:** 새로 고친 뒤에도 모의고사와 문제 4개가 그대로 있다(저장됨). 첫 Escape는 이름 바꾸기만 취소한다: 이름은 그대로, dialog는 열려 있고 focus는 시작한 행 메뉴(상세에서는 `이름 바꾸기` 버튼)로 돌아온다. 두 번째 Escape는 dialog를 닫는다. 이름은 목록·상세에 "기말 대비"로 바뀌고 새로 고쳐도 유지된다. 삭제 확인 dialog를 거쳐 그 행이 사라지고 "모의고사 n개"가 줄어든다. 지운 모의고사의 상세 URL은 "모의고사를 찾을 수 없습니다."를 보이고 `GET /mock-exams/{id}`는 404다.

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
- **Then:** 보기 권한자는 목록과 `풀기`, 원본 풀이만 여는 `추가`가 보이고 쓰기 API는 403이다. 보관된 Workspace에서는 행 메뉴·편집 동작이 없고 `추가`는 원본 풀이만 열며 쓰기 API는 403 `workspace-archived`이며 `풀기`는 열리지만 제출이 비활성이다. 게스트 화면에는 `모의고사` 진입점이 없다. 다른 Workspace 편집자의 요청은 404다.

### MOCK-01-AC08

- **Given:** fake 시나리오: 원본 3개를 한 호출로 만드는데 그중 하나는 정오 반전 결과가 복수 정답(검증 실패)이고 다시 요청해도 실패한다. 첫 응답이 해석할 수 없는(깨진) 묶음인 범위 하나, 모든 후보가 실패하는 범위, LLM 기능이 꺼진 stack 설정
- **When:** `정오 반전`으로 문항 수 3을 만들고, 깨진 묶음 범위로 문항 수 4를 만들고, 모든 후보가 실패하는 범위로 만들고, LLM 기능이 꺼진 환경에서 `추가`를 연다
- **Then:** 첫 모의고사는 `일부만 만듦`과 "3문항 중 2문항을 만들었습니다. 1개는 검증을 통과하지 못했습니다."를 보이고 복수 정답 문제는 목록·`풀기`·API 어디에도 없다. 깨진 묶음 범위는 (반으로 나눠 다시 요청해) `준비됨`과 문제 4개다. 모두 실패하면 `실패`와 "검증을 통과한 문제를 만들지 못했습니다. 범위나 변형 유형을 바꿔 보세요."이다. LLM 기능이 꺼진 환경에서는 `문구 변형`·`정오 반전`·`유사 개념`은 숨기며 `보기 섞기`만으로 만들 수 있다.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/questions/mock_exams/test_mock_exams_contract.py`, `apps/worker/tests`, `packages/core/tests`, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| MOCK-01-C01 | **은행 격리:** 모의고사 생성·편집·풀이는 `questions`·`question_revisions`·`question_drafts`·`question_lineage`·`question_user_states`·`question_attempts`에 행을 만들거나 바꾸지 않는다(행 수·갱신 시각 비교). overview·Heatmap·검색 색인(Qdrant payload)·정리 노트 입력·Fork snapshot에 모의고사 문제가 없다. 모의고사 문제를 확정 문제로 등록하는 API는 없다. |
| MOCK-01-C02 | **검증이 저장 조건:** worker는 묶음 응답의 항목마다 승인 차단 검증(형식·정답 개수·정오 반전 정답 불일치·중복 fingerprint·출처 근거 — `book_core.generation.validation` 그대로; `severity=error`인 issue는 모두 차단, `is_rejection` 코드에 한정하지 않음)을 따로 돌리고 통과한 항목만 `mock_exam_questions`에 저장한다. 실패 항목은 모아서 함께 한 번 다시 요청하고, 그래도 실패면 건너뛴다(`skipped` 수 기록). 저장된 문제가 0이면 회차 `failed`/`no_valid_questions`. LLM이 선언한 정답은 검증 없이 쓰지 않는다. |
| MOCK-01-C03 | **범위·선택 재현:** 생성 요청의 범위는 서버가 이 Workspace의 살아 있는 CONFIRMED 문제로 푼다(QVIEW-01-C01과 같은 resolver; 다른 Workspace·초안 id는 422 `range-invalid`, 0개면 409 `no-matching-questions`). 원본 선택과 변형 유형 배정은 회차에 저장된 seed로 재현된다(같은 seed·같은 후보 → 같은 원본·유형). 회차는 원본 `question_revision_id`를 고정한다. |
| MOCK-01-C04 | **회차·이력:** `다시 만들기`는 새 회차(`version + 1`)를 만들고 성공하면 `mock_exams.current_generation_id`를 바꾼다. 이전 회차와 그 문제·revision·풀이 기록은 지우지 않는다. 모의고사마다 대기·실행 중 회차는 하나(partial unique; 진행 중 POST 409 `mock-generation-running`). 문제 편집은 새 `mock_exam_question_revisions` 행, 빼기는 `removed_at`(soft). 이름·설정 변경은 `mock_exam_revisions` 행을 남긴다. 풀이 기록·revision 행은 UPDATE·DELETE 불가(pgTAP). |
| MOCK-01-C05 | **인가 matrix:** GET(목록·상세·문제 목록)은 모든 구성원(보관 Workspace 포함), 쓰기(만들기·PATCH·DELETE·다시 만들기·문제 편집·빼기)는 owner·editor이고 활성 Workspace만(보관 403 `workspace-archived`). 다른 Workspace·삭제된 모의고사 404. 공유 세션은 모든 모의고사 API에 404. 보기 권한자의 문제 목록·문제 상세 응답에는 정답·해설이 없다(편집 권한자의 `manage` 응답에만 있음). |
| MOCK-01-C06 | **한도(비용 보호):** 문항 수는 AI 유형이 있으면 1~100(초과 422), `보기 섞기`만이면 1~min(범위, 5,000). Workspace에서 대기·실행 중인 모의고사 회차 수가 한도(`MOCK_EXAM_MAX_RUNNING_PER_WORKSPACE`, 기본 5)를 넘으면 409 `generation-busy`. 사용자별 생성 시작 분당 횟수 제한(`MOCK_EXAM_GENERATION_RATE_LIMIT_PER_MINUTE`, 기본 6) 초과 429 + Retry-After. `Idempotency-Key`로 재시도하면 같은 회차를 돌려준다. |
| MOCK-01-C09 | **호출 묶기(fake LLM이 호출을 셈):** (1) 같은 장 원본 20개·기본 예산 → LLM 호출 1번, passage는 호출 안에서 중복 없이 한 번씩. (2) 원본 100개 → 입력·출력 예산과 `MOCK_EXAM_SOURCES_PER_CALL`을 넘지 않는 최소 묶음 수(기본 값으로 3번), 묶음 구성은 같은 plan에서 결정적. (3) 묶음 안 항목 하나만 검증 실패 → 나머지는 저장되고 실패 항목들만 모여 호출 1번으로 다시 요청, 또 실패하면 건너뜀. (4) 해석할 수 없는(또는 잘린) 묶음 응답 → 그 묶음만 반으로 나눠 다시 요청하고 다른 묶음은 영향 없음. (5) 원본 하나가 예산을 넘으면 근거를 좁히고, 그래도 넘으면 `source_too_large`로 건너뜀. (6) 묶음 하나가 끝난 뒤 job을 죽이고 다시 실행하면 끝난 묶음을 다시 부르지 않는다(checkpoint). (7) 동시 호출 수가 `MOCK_EXAM_GENERATION_CONCURRENCY`를 넘지 않는다. |
| MOCK-01-C07 | **유출 금지:** 문제·해설·근거 본문·prompt·LLM 응답은 API·worker 로그, job `result`(만든 수·건너뛴 수·usage·오류 코드만), 활동 기록(`mock_exam.*`은 id·개수만), trace에 남지 않는다. |
| MOCK-01-C08 | **원본 변경·삭제:** 원본 확정 문제를 편집·삭제·보관해도 이미 만든 모의고사 문제는 바뀌지 않고 그대로 풀 수 있다(출처는 "원본 삭제됨"). 다시 만들 때는 그때의 범위로 다시 풀므로 삭제·보관된 원본은 빠진다. Workspace 삭제 시 모의고사 API는 404. **중복 정리(UX7-DEDUP, MOCK-SYNC):** 원본이 나중에 중복으로 보관되어도(`question_merges`) 모의고사는 자기 복사본(`mock_exam_question_revisions`)을 가지므로 문제·출처 번호·풀이 기록(`mock_exam_attempts`)이 바뀌지 않는다 — 합침은 `question_user_states`·`question_attempts`만 읽고 모의고사 기록을 옮기거나 합치지 않으며, 보관 해제로 합침이 풀려도 모의고사는 그대로다. 다시 만들면 보관된 중복은 위 규칙대로 범위에서 빠지고(`전체 선택`·장 범위는 남긴 문제를 그대로 포함; 개별로 고른 중복은 빠짐), 다른 문제(남긴 문제 등)로 바꿔 넣지 않는다(사용자 결정 2026-11-02). 모의고사 문제는 은행 밖이라 중복 문제 정리 검사(`question-duplicates`)와 가져오기 중복 표시의 대상이 아니다(`보기 섞기` 복사본이 원본과 같은 내용이어도). |
| MOCK-01-C10 | **출처 장 (MOCK-W-3):** 문제 목록·문제 편집 응답의 `source.chapter`는 원본 문제의 지금 장 `{id, number, title, rank}`이다 — `number`·`title`은 출처 글자("3장 12번")와 같은 장의 번호·제목, `rank`는 그 회차 생성 계획(`plan`)의 `chapter_rank`(만들 때 범위의 Heatmap 장 순서)다. 원본에 장이 없거나 원본이 삭제되면 `null`(범위 고르기의 "챕터 없음" 묶음, 맨 뒤). 추가 필드일 뿐이며 정답·해설 필드를 더하지 않는다(보기 권한 응답에는 여전히 정답 필드가 없음). |
| MOCK-01-C11 | **추출과 함께 실행:** `mock_exam.generate`는 API·worker 모두 `quiz.ondemand`로 보내고 기본·interactive worker 둘 다 이 queue를 읽는다(문서·추출 job은 `quiz.jobs`에 남음). 기본 칸이 추출에 잡힌 동안 회차 job은 시도 횟수를 쓰지 않고 `queued`로 남고 칸이 비면 끝난다. interactive worker는 추출을 건드리지 않고 회차를 끝낸다(`apps/worker/tests/test_mock_exam_lane.py`, fake job). |
| MOCK-01-C12 | **대기 표시:** `queued` 회차는 행·상세에 badge `대기 중`과 대기 문구를 보이고, polling이 이어져 `running`이 되면 `만드는 중`으로 바뀐다(Vitest). |

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- MOCK.0의 RED는 "모의고사 메뉴·API 없음"으로 실패해야 한다(infra·seed 문제로 실패하면 안 됨). QGEN-01 테스트는 QGEN-RM 전까지 GREEN으로 남는다 — AC01의 "`변형 출제` 항목 없음"·`?panel=generate` redirect 확인은 QGEN-RM 이후에 GREEN이 된다(MOCK-W는 `모의고사` 항목을 더하고 QGEN-RM이 `변형 출제`를 뺀다). 그래서 orchestrator는 QGEN-RM이 GREEN인 뒤에 `MOCK.0`을 CI `E2E_PHASES`에 넣는다(implementation-plan §3 MOCK).
