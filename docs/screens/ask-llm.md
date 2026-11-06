# ASK-01 — AI 질문 (문서 기반 답변) Floating Side Panel

> **UX12-ASK 개정(2026-11-06):** panel 구성(목록·대화 화면, FAB, floating 입력창, 질문 범위 아이콘)과 답의 표시는 [UX12-ASK](ux12-ask.md)가 정한다. `AI 생성` 표시와 `다시 생성` 버튼을 뺐다(2026-11-01 결정을 뒤집음, implementation-plan §7). API `/regenerate`, 한도, 답 버전 데이터는 그대로다. 아래 본문과 AC는 이 개정을 반영했다.

> **UX10 개정 예정(2026-11-05):** [확정 구현 기준](../implementation/ux10/index.md)의 해당 변경 요구가 이 문서의 이전 동작에 우선한다. 구현 Task의 RED 단계에서 해당 AC·trace를 함께 갱신한다. 변경되지 않은 요구·보안 경계는 유지한다.

**상태:** 화면 요구사항 v1.0 (모든 제안 사용자 결정 2026-11-01) · ASK-SPEC 신규 2026-11-01 (사용자 요청 "LLM에 질문하기 — 문서 기반 답변 — 문제별로 '질문하기' 버튼 추가 -> LLM input에 context로 추가") · 사용자 결정 반영 2026-11-01(진입점 세 곳, 대화 저장·비공개, 힌트 모드, 문서 근거만, `질문하기`는 문제 상세·모의고사 문제에만). 모든 설계 선택은 사용자가 확인했다(implementation-plan §7 ASK-SPEC 사용자 결정 행). RED(ASK.0)는 구현 착수 직전에 쓴다. · **ASK-SYNC 개정 2026-11-02** (develop의 UX7·모의고사·QuestionViewer·QGEN-RM에 맞춤): 문제 쪽 진입점을 QuestionViewer 방식으로 다시 적고("문제 쪽 진입점"), panel 쌓기·뒤로가기 규칙("panel 쌓기·뒤로가기"), 모의고사 문제 첨부(이전 ASK-QM)를 이 화면의 AC12·C10으로 당겼다.
**Route:** `/workspaces/:workspaceId?panel=ask` (대화 목록·새 대화) · `?panel=ask&conversation=:conversationId` (대화 하나). Workspace header의 `AI 질문` 버튼, 본문 검색의 `AI에게 묻기`, 그리고 문제의 `질문하기`(QuestionViewer `manage` — "문제 상세" dialog — 와 모의고사 문제의 `sequence(mock)`·`manage(mock)`)와 제출 결과 아래 AI 해설의 `AI 질문하기`가 연다. 공유 링크 게스트(`/share/:shareId`)에는 없다.
**테스트:** `tests/e2e/ask/ask-llm.spec.ts` (계약: `tests/integration/ask/test_ask_contract.py`, `apps/worker` · `packages/core` unit test, `supabase/tests` pgTAP)
**Phase:** ASK.0 (RED) → ASK-B (계약 C01~C11, 모의고사 첨부 C10 포함) → ASK-W (AC01~AC03·AC06~AC11) → ASK-Q (AC04·AC05·AC12, CI phase 켬) · ASK-X (품질·eval·runbook). 이전 계획의 ASK-QM은 ASK-SYNC에서 ASK-B·ASK-Q에 합쳤다(MOCK·QVIEW가 이미 develop에 있음).
**연계:** [전체 아키텍처](../architecture.md) §4·§5·§6, [SEARCH-01](search.md), [QPLAY-01](questions-practice.md), [QVIEW-01](question-viewer.md), [MOCK-01](mock-exams.md), [QOV-01](questions-overview.md), [DOCSUM-01](documents-summary.md), [CHNOTE-01](chapter-notes.md), [Questions 명세](../questions.md) §13, [공유 명세](../workspace-sharing.md) §10, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: ASK-01
route: /workspaces/:workspaceId?panel=ask
actor: workspace_member (owner · editor · viewer — 자기 대화만)
permission: read · personal conversation
status: confirmed
api: [POST /api/v1/ask/messages/:id/regenerate, GET /api/v1/workspaces/:id/ask, GET /api/v1/workspaces/:id/ask/conversations, POST /api/v1/workspaces/:id/ask/conversations, GET /api/v1/ask/conversations/:id, DELETE /api/v1/ask/conversations/:id, DELETE /api/v1/ask/conversations/:id/attachment, POST /api/v1/ask/conversations/:id/messages, GET /api/v1/ask/messages/:id, GET /api/v1/ask/messages/:id/stream, POST /api/v1/ask/messages/:id/cancel, POST /api/v1/ask/messages/:id/retry, PUT /api/v1/ask/messages/:id/feedback]
components: [FloatingSidePanel, Button, IconButton, Textarea, Badge, Chip, DropdownMenu, Popover, ConfirmDialog, EmptyState, DocumentExcerptPanel]
linked_tests: [ASK-01-AC01 … ASK-01-AC12]
```

## 목적과 정책

- **문서 기반 답변 (RAG).** 사용자가 자연어로 물으면 서버가 그 Workspace의 발행된 교재에서 관련 구절을 찾고(기존 hybrid 검색 파이프라인: BM25 + dense, Qdrant, RRF, reranker — architecture §4 "검색 흐름"), LLM은 그 구절만 근거로 답한다. 답의 문장은 근거 구절을 `[1]`·`[2]` 각주로 가리키고, 각주는 문서·쪽·발췌로 이어진다. 근거를 찾지 못하면 지어내지 않고 "문서에서 찾지 못했습니다"라고 답한다. 이 기능은 architecture §1의 "제외: 범용 RAG 채팅/질의응답 생성"과 questions.md §5의 "범용 RAG 챗봇이나 자동 답변 기능은 범위 밖"을 **사용자 요청(2026-11-01)으로 바꾼다** — 범용 채팅이 아니라 "Workspace 문서에 근거한 질문·답변"으로 범위를 좁힌다(결정 기록 §7 ASK-SPEC).
- **근거 범위 = 문서만 (사용자 결정 2026-11-01).** 모델은 제공된 구절과 첨부한 문제에 있는 내용만 답한다. 구절끼리 잇는 설명 정도의 일반 지식은 쓸 수 있지만, 구절에 없는 사실을 단정하지 않는다. 근거가 없으면 LLM을 부르지 않고 "찾지 못했습니다"로 답한다(아래 "찾지 못함").
- **문제별 `질문하기` (사용자 결정 2026-11-01).** "문제 상세" dialog(QuestionViewer `manage`)와 모의고사 문제(`sequence(mock)`·`manage(mock)`)에 `질문하기` 버튼이 있고(풀이 panel(`practice`)과 등록 문제 범위 풀이(`sequence(bank)`) header에는 없음; 그 둘에서는 제출 뒤 AI 해설 아래의 `AI 질문하기`만 — 아래 "문제 쪽 진입점"), 누르면 같은 AI 질문 panel이 그 문제를 **첨부한 새 대화**로 열린다. 입력란 위에 첨부 칩(chip)이 보이고(지울 수 있음), 서버는 그 문제를 LLM 입력의 context로 넣는다. 무엇을 넣는지는 아래 "문제 첨부와 정답 비노출"이 정한다.
- **AI 안내.** 답은 사람의 검토 없이 바로 보이고 편집할 수 없다. 답마다 "AI가 문서를 근거로 만든 답입니다. 틀릴 수 있으니 출처를 확인하세요." 안내를 단다. `AI 생성` badge는 UX12-ASK에서 뺐다.
- **환경별 사용 여부.** worker·api 설정 `WORKER_ASK_LLM`(두 서비스 같은 값, 기본 꺼짐)이 켜져 있고 LLM(worker `LLM_API_KEY`·`LLM_MODEL`, api `LLM_MODEL` 같은 값)이 설정된 환경에서만 질문할 수 있다. 꺼진 환경에서는 입력란이 비활성이고 "이 환경에서는 AI 질문을 사용할 수 없습니다."를 보이며, 이미 저장된 대화는 읽을 수 있다. **staging·production에서 켜는 것은 ⛔ 사용자 승인 후** (runbook-deploy §12, 질문·첨부 문제·검색된 발행 본문이 LLM 제공자로 전송됨).
- **AI 문제 해설과의 관계:** 제출 후 결과 아래의 AI 해설은 별도 화면 [AIEXPL-01](ai-explanations.md)이다(공유 캐시, 자기 플래그). AI 해설 영역의 `AI 질문하기`(사용자 결정 2026-11-01, 유지)는 이 panel을 `practice` 첨부(그 결과를 낸 practice session — 범위 풀이 `sequence`의 session 포함)로 연다. 이 링크는 **풀이 panel(`practice`)과 `sequence(bank)` 안에서 `질문하기`로 가는 유일한 경로**이고, AI 해설처럼 제출 뒤에만 보이며 언제나 `full`이다(서버가 그 session의 제출을 확인). 결정 (9) "풀이 panel header에는 `질문하기`가 없다"는 제출 전에 문제를 첨부하는 header 버튼을 두지 않는다는 뜻이고, 이 링크는 header가 아닌 제출 후 결과 영역에 있으므로 어긋나지 않는다. AI 해설은 ASK의 검색 근거가 아니다.
- **개인 대화.** 대화는 사용자 한 명 · Workspace 하나에 속한다. 다른 구성원(Owner 포함)은 남의 대화를 볼 수 없다(서버 404). Workspace 이력(HISTORY-01)·활동 기록에도 나오지 않는다 (사용자 결정 2026-11-01).

### 실행 경로 — worker + streaming (사용자 결정 2026-11-01)

API는 `LLM_API_KEY`를 갖지 않는다(결정 기록 2026-10-29 DOCSUM-B). 그래서 LLM 호출은 worker가 하고, 답은 흘려보낸다(streaming).

1. `POST /ask/conversations/{id}/messages` — API가 인가(JWT `sub` → 대화 주인 → Workspace 멤버십, DB 확인)·한도를 확인하고, **검색을 API 안에서 실행**해 고른 근거 구절의 참조(문서·발행 revision·block id·쪽·chunk id·점수)를 메시지에 고정(`ask_message_sources`)한 뒤 사용자 메시지·답 메시지(`queued`)·`ask.answer` job을 한 트랜잭션에서 만든다. 응답은 202와 답 메시지 id·`stream_url`. 검색은 이미 API가 하는 일(SEARCH-01: query embedding, Qdrant 필터)이라 새 비밀이 필요 없다.
2. worker의 `ask.answer {message_id}`는 별도 Celery queue `interactive`(전용 worker process, `ASK_WORKER_CONCURRENCY` 기본 2)에서 돈다 — 오래 걸리는 `document.parse`·요약 job이 질문을 막지 않게 한다. job은 고정된 참조로 Postgres의 블록 본문을 다시 읽고(검색 결과의 원문을 API→worker로 복사하지 않음), 그 revision이 아직 문서의 현재 발행 revision인지·문서와 Workspace가 살아 있는지·사용자가 아직 구성원인지 다시 확인한 다음, 문제 첨부를 아래 공개 수준으로 만들어 LLM을 **streaming**으로 부른다.
3. worker는 받은 글자를 약 100ms 또는 20자 단위로 모아 Redis Stream `ask:msg:<message_id>`(XADD, 최대 길이 제한, TTL 10분)에 `delta {seq, text}`로 쓴다. 끝나면 인용을 검증해 최종 답·인용·usage를 Postgres에 쓰고 `done`을 쓴다. 실패는 `error {code}`.
4. `GET /ask/messages/{id}/stream`(SSE)은 연결마다 인가를 다시 확인하고 Redis Stream을 XREAD로 읽어 그대로 보낸다(`Last-Event-ID`로 이어 받기). 메시지가 이미 끝났거나 stream key가 없으면 Postgres의 최종 상태를 `done`/`error` 하나로 보낸다. 브라우저는 Next.js route handler relay(`/api/ask/messages/[id]/stream`)로 연결하고, relay가 서버에서 검증한 access token을 `Authorization` header로 붙인다(token은 URL·query에 넣지 않는다). SSE가 끊기면 `GET /ask/messages/{id}`를 1초 간격으로 polling한다.
- 고른 이유: 채팅은 첫 글자가 빨리 보여야 한다(목표: 보낸 뒤 첫 글자 p50 ≤ 3초·p95 ≤ 6초 — 검색 ≤ 1.5초, queue 대기 ≤ 0.5초, 나머지는 provider 첫 token). 대안 (a) API가 LLM을 직접 부름 — API에 키가 필요해 기존 결정을 바꿔야 함(사용자 승인 필요), 가장 빠름; (b) worker + polling만 — 단순하지만 글자가 1초 단위로 끊겨 보이고 요청 수가 많음. 추천은 이 절의 worker + Redis Streams + SSE.
- Redis Stream에는 답 글자가 잠시(최대 10분) 머문다. Redis는 내부 서비스이고 브라우저가 직접 닿지 않는다(AGENTS.md §5). key에는 메시지 id만 있다.

### 검색 범위

- **대상 (사용자 결정 2026-11-01):** 기본은 Workspace의 모든 발행된 교재(`document_type = book`, 교재+문제 포함). panel의 "질문 범위" popover로 문서·장을 좁힐 수 있다(SEARCH-01 "본문 설정"의 문서·장 필터와 같은 부품·같은 목록; UX12 CHAPTER-1: `장`은 하위 장까지 고르는 트리 popover [UX12-PICKER](ux12-chapter-picker.md), 서버는 고른 장의 하위 절까지 찾는다). 범위는 메시지마다 저장된다.
- **문제지는 제외 (UX7-SEARCH-2와 같음):** `question_paper` 문서는 검색하지 않는다. 문제지에는 정답지가 있어, 넣으면 아직 풀지 않은 문제의 정답이 근거로 딸려 올 수 있다. 서버가 항상 범위에서 빼며 요청이 문제지를 지정해도 결과가 없다.
- **교재+문제의 문제 구간 제외:** `content_kind = mixed` 문서는 문제 추출이 문제·정답지 구간으로 읽은 블록(문서 요약이 입력에서 빼는 것과 같은 구간 — DOCSUM-01 "대상 아님")을 근거에서 뺀다. 검색 결과 chunk의 block이 그 구간에 있으면 버린다(색인은 그대로; 걸러진 수만 기록).
- **AI 파생물 제외:** 문서 요약(DOCSUM-01)과 챕터 정리 노트(CHNOTE-01)는 근거가 아니다. 특히 정리 노트는 정답·해설에서 나왔으므로 넣지 않는다.
- **발행본만:** 현재 발행(active published) revision의 chunk만(published-revision 필터는 서버가 강제, SEARCH-01과 같음). 초안·이전 revision·삭제된 문서·다른 Workspace는 없다. client가 보낸 `workspace_id`·문서 id는 믿지 않는다: 범위의 문서·장 id는 서버가 이 Workspace의 발행 교재와 교집합을 내고, 아닌 id는 결과가 없을 뿐이다(SEARCH-01과 같음).
- **검색어:** 사용자 질문 + 첨부 문제의 발문·보기 글(공개 수준 안의 것만). 이전 대화는 검색어에 넣지 않는다(마지막 질문 기준) (사용자 결정 2026-11-01).
- **개수:** 검색 파이프라인의 기본 후보(dense 30 · BM25 30 → RRF → rerank)에서 상위 `ASK_TOP_K`(기본 8)개, 각 근거는 `ExcerptResolver` 발췌(최대 2,000자), 합계 `ASK_MAX_CONTEXT_CHARS`(기본 16,000자). reranker 점수가 `ASK_MIN_RELEVANCE` 미만인 후보는 버린다(값은 eval로 정함). query embedding이 안 되면 BM25만으로 계속하고 답 위에 SEARCH-01-AC06과 같은 비차단 안내를 단다.
- **찾지 못함:** 남은 근거가 0개이고 첨부한 문제도 없으면 **LLM을 부르지 않고** 답 메시지를 `no_sources`로 끝낸다: "올린 문서에서 관련 내용을 찾지 못했습니다. 질문을 바꾸거나 질문 범위를 넓혀 보세요." (usage 0). 근거가 있지만 모델이 그 구절로 답할 수 없다고 판단하면 정해진 표시(`[NO_ANSWER]`)로 시작하게 하고, 서버가 같은 문구 + "검색한 구절" 목록으로 바꾼다. 첨부한 문제만 있고 근거가 0개면 모델을 부르되 "문서에서 근거를 찾지 못해 문제 내용으로만 설명합니다." 안내를 단다 (사용자 결정 2026-11-01).

### 문제 첨부와 정답 비노출

AGENTS.md §5 "Practice APIs never send correct answers or explanations before submission"을 지킨다. **경계는 서버다:** 아직 제출하지 않은 문제의 정답·해설은 서버가 LLM 요청에 아예 넣지 않는다. 모델에게 주는 "정답을 말하지 말라"는 지시는 UX일 뿐 보안 경계가 아니다.

공개 수준(`disclosure`)은 **메시지를 보낼 때마다 서버가 계산**한다(첨부할 때 고정하지 않음 — 첨부 뒤에 제출하면 다음 질문부터 정답·해설이 들어간다). client가 보낸 상태값은 쓰지 않고, 첨부에 저장된 practice session·문제 id로 DB에서 판정한다.

| 첨부한 곳 (첨부 `view`) | 서버 판정 | 공개 수준 | LLM에 넣는 것 | 넣지 않는 것 |
|---|---|---|---|---|
| `practice` 첨부(`source=bank`: QuestionViewer `practice`·`sequence(bank)`의 practice session) — 제출 전 (등록 문제는 UI 경로 없음, 아래) | 첨부한 practice session(`practice_sessions`, 범위 풀이 묶음의 session 포함)에 그 사용자의 제출(attempt)이 없음 | `hint` | 문제 번호·장·유형, 발문, 보기 글(그 session의 표시 순서·번호), 사용자가 지금 고른 답(제출 안 함, client가 보낸 option id 중 그 문제의 것만) | 어느 보기가 정답인지(정답 option id 목록·`is_correct`·정답 순서 — 보기 글은 정답 보기도 보통 보기로 들어감)·허용 답안·모범답안·채점 기준·해설·`question_sources` 근거 구절, 이 문제의 다른 풀이 기록 |
| 같은 곳 — 제출 후 | 그 session에 제출이 있음(채점 대기 포함) | `full` | 위 + 제출한 답·결과(정답/오답/채점 대기)·정답·해설·출처 구절(`question_sources`의 발행 블록) | 다른 사용자의 기록 |
| "문제 상세" dialog — QuestionViewer `manage`(`source=bank`; QVIEW-01 호출 위치 4: 풀이 panel 메뉴의 `정답·해설 보기`·`수정 이력·출처`, 호출 위치 5: 보관·초안 문제 dialog의 행; 첨부 `view: detail`) | 사용자가 그 문제를 `GET /questions/{id}`로 읽을 수 있음(모든 구성원, UX7-BANK-2) | `full` | 그 dialog에 보이는 현재 revision: 발문·보기·정답·해설·출처 구절. 풀이 기록 없음 | 지난 버전, 다른 사용자의 기록 |
| 모의고사 풀이(QuestionViewer `sequence(mock)`, 첨부 kind `mock_exam_question`·`view: practice`) — 제출 전/후 | 첨부한 모의고사 practice session(`mock_exam_practice_sessions`)에 그 사용자의 `mock_exam_attempts`가 있는지 | `hint` / `full` | 위 `practice`와 같은 규칙. 문제 내용은 session이 고정한 `mock_exam_question_revisions` 행, `full`의 출처 구절은 그 revision의 `evidence` 중 발행 `book` 블록(아래 C10) | 같음 + `hint`에서는 `evidence`도 넣지 않음 |
| 모의고사 문제 관리(QuestionViewer `manage(mock)`, QVIEW-01 호출 위치 9 — 모의고사 상세의 문제 행, 편집 권한; `view: manage`) | 편집 권한·활성 Workspace + 모의고사 문제를 정답과 함께 읽을 수 있음(`GET /mock-exams/{id}/questions?include=answers`와 같은 판정) | `full` | 지금 revision의 발문·보기·정답·해설·`evidence` 발행 `book` 구절 | 지난 revision, 풀이 기록 |
| 공유 링크 게스트 미리보기 | — | 없음 | `질문하기` 없음 | — |

- **어느 UI가 `hint`를 쓰나 (사용자 결정 2026-11-01 이후):** `질문하기`는 문제 상세 dialog(`manage`, `detail` → 언제나 `full`)와 모의고사 문제에만 있다. 등록 문제에서 **제출 전 문제를 첨부하는 UI 경로는 없다** — `practice`와 `sequence(bank)` header에는 `질문하기`가 없고, AI 해설의 `AI 질문하기`는 제출 후라 `full`이다. 그래도 서버는 `practice` 첨부와 `hint` 규칙을 그대로 둔다(안전을 위한 서버 규칙; API를 직접 부르는 client, 범위 풀이 묶음의 session에도 적용). 지금 `hint`를 쓰는 UI는 모의고사 풀이의 제출 전 `질문하기`뿐이다(사용자 결정 2026-11-01: 모의고사 문제는 제출 전에도 버튼을 보이고 `hint`, 제출 후 `full`).
- `detail`로 정답을 넣는 것은 새 노출이 아니다: 구성원은 이미 문제 상세에서 정답·해설을 읽을 수 있다(QPLAY-01-AC09). practice API가 아니다. 정답을 넣었는지는 메시지의 `disclosure`로 남고 풀이 기록·Heatmap 상태는 바뀌지 않는다(질문은 열람·풀이가 아님 — questions.md §2.1).
- **힌트 모드 지시 (사용자 결정 2026-11-01):** `hint`일 때 모델에게 "사용자는 아직 이 문제를 제출하지 않았다. 어느 보기가 정답인지, 최종 답이 무엇인지 말하지 말고 개념과 근거 구절을 짚어 스스로 풀 수 있게 도와라"라고 지시하고, 칩 옆에 "제출 전 — 정답 없이 힌트만"을 보인다. 교재 구절에 답의 근거가 있으면 모델이 사실상 답을 추론할 수 있다는 한계를 명세에 남긴다 — 이는 사용자가 교재를 직접 읽는 것과 같고, 저장된 정답·해설이 새는 것이 아니다.
- `hint`에서 출처 구절(`question_sources`)을 넣지 않는 이유: 편집자가 단 정답 근거라 사실상 정답 위치를 알려 준다. 일반 검색으로 같은 구절이 올라오는 것은 막지 않는다(교재는 열람 범위).
- 답 메시지의 SSE·API 응답에는 서버가 LLM에 넣은 context(정답·해설 포함)를 다시 돌려주지 않는다. 화면의 칩은 문제 번호·발문 앞 40자·공개 수준 글자만 보인다.
- **대화 하나 = 첨부 문제 하나 (사용자 결정 2026-11-01):** `질문하기`는 항상 새 대화를 만든다. 칩의 `×`(접근성 이름 "첨부한 문제 빼기")로 빼면 그 뒤 메시지에는 문제 context가 없다(`DELETE …/attachment`; 이전 답은 남음). 같은 대화에 다른 문제를 더 붙이지 않는다.
- (`practice` 첨부 — 지금은 모의고사 문제) 같은 문제를 새 session에서 다시 풀면 새 `질문하기`가 새 대화를 만든다. 예전 대화는 예전 session(이미 제출)에 묶여 그대로다 — 사용자가 이미 본 정답만 들어 있다.

### 대화·보존

- **여러 턴 (사용자 결정 2026-11-01):** 한 대화에 사용자 질문 최대 `ASK_MAX_TURNS`(기본 20)개. LLM에는 첨부·근거 + 직전 `ASK_HISTORY_TURNS`(기본 3)턴의 질문·답(합계 6,000자 이내, 오래된 것부터 뺌)을 보낸다. 한도에 닿으면 입력란이 비활성이고 "이 대화는 질문 20개까지입니다. 새 대화를 시작하세요."
- **저장 (사용자 결정 2026-11-01: 90일 보존·비공개·삭제 가능):** 대화·메시지·인용은 Postgres에 저장되고 대화 목록에서 다시 연다. 마지막 메시지 뒤 `ASK_RETENTION_DAYS`(기본 90일)가 지나면 nightly job이 지운다. 사용자는 대화를 언제든 지울 수 있다(확인 dialog). 메시지는 append-only(끝난 메시지는 바뀌지 않음, 다시 시도는 새 메시지). usage 기록(`llm_feature_usage`, 내용 없음)은 대화를 지워도 비용 집계를 위해 13개월 남는다.
- **목록:** 대화 제목은 첫 질문 앞 40자(첨부가 있으면 "3장 12번 · " 접두). 최근 순, 30개씩 `더 보기`. 메시지가 없는 대화(`질문하기`로 만들고 아직 묻지 않은 것)는 목록에 나오지 않는다 — 링크로는 열리고 이어서 물을 수 있으며, 보존 기간이 지나면 `ask.purge`가 지운다 (사용자 결정 2026-11-03).

### 한도와 비용 (사용자 결정 2026-11-01: 아래 기본값; 운영 측정으로 조정하면 결정 기록에 남김)

| 항목 | 기본값 | 넘으면 |
|---|---|---|
| 질문 길이 `ASK_MAX_QUESTION_CHARS` | 1,000자 | 글자 수 표시 "1,024/1,000"(`aria-describedby`), 보내기 비활성, API 422 `question-too-long` |
| 대화당 질문 `ASK_MAX_TURNS` | 20 | 입력 비활성 + 새 대화 안내, API 409 `ask-turn-limit` |
| 동시에 만드는 답 | 사용자당 1개 | API 409 `ask-answer-running`(화면은 답이 끝날 때까지 보내기 비활성) |
| 분당 질문 `ASK_RATE_LIMIT_PER_MINUTE` | 6 (사용자 기준) | 429 + `Retry-After`, "잠시 후 다시 질문하세요 (n초)" |
| 하루 질문 `ASK_DAILY_LIMIT_PER_USER` | 50 (사용자 기준, Asia/Seoul 날짜, DB 집계; 대화를 지워도 줄지 않음 — 사용자 결정 2026-11-02) | 429 `ask-daily-limit`, "오늘 질문 한도(50개)를 모두 썼습니다." |
| 월 token 상한 `ASK_MONTHLY_TOKEN_CAP` | 0 = 끔 (운영자가 켬; 전체 환경 합계) | 409 `ask-budget-exceeded`, "이번 달 AI 질문 사용량을 모두 썼습니다." |
| 근거 개수·글자 `ASK_TOP_K`·`ASK_MAX_CONTEXT_CHARS` | 8개 · 16,000자 | 낮은 순위부터 뺌 |
| 모델 출력 `ASK_MAX_OUTPUT_TOKENS` · effort `ASK_LLM_EFFORT` | 2,000 token · `low` | `max_tokens`에서 잘리면 답 끝에 "(답이 길어 잘렸습니다)" 표시, 상태는 성공 |

- **비용 가늠** (production 모델 `claude-sonnet-5-5` 기준 공개 가격 입력 $2 · 출력 $10 / 1M token, cache read $0.20 — 2026-10 기준, 변동 가능): 질문 하나 ≈ 입력 1만~1.5만 token(지시 1.5k + 근거 16,000자 ≈ 8k~11k + 대화 2k + 첨부 0.5k) + 출력 0.5k~2k token(사고 token 포함) → **약 $0.03~0.05**. 하루 50개를 모두 쓰는 사용자 한 명 ≈ 월 $45~75. DOCSUM·CHNOTE 운영 승인의 월 예산 목표 $20(결정 기록 2026-11-01)과 같은 키를 쓰므로, 켤 때 예산을 다시 정해야 한다(⛔). 지시 prompt는 고정 문자열이라 prompt cache로 조금 줄일 수 있다.

## 레이아웃 및 컴포넌트

- **진입 — 세 곳 모두 (사용자 결정 2026-11-01 "위 세 군데 모두"):** 셋 다 같은 `?panel=ask` panel을 연다. panel은 바로 열리고 데이터를 불러오는 동안 skeleton(QOV-01-AC09).
  - **header 버튼:** Workspace header 오른쪽 아이콘 묶음(`이력`·`공유하기`) 앞에 `AI 질문` 버튼(아이콘 + 글자 "AI 질문", 접근성 이름 "AI 질문", 모든 구성원; 보관된 Workspace·기능 꺼짐에서도 보임 — 지난 대화 읽기, 이유는 panel이 보임).
  - **`문제` 메뉴:** `AI 질문` 항목은 제거했다. 새 질문은 기능이 사용 가능할 때 header에서 연다.
  - **본문 검색의 `AI에게 묻기`:** 본문 검색 페이지 header의 동작 자리에 있다(UX12 HOME-3, [UX12-SEARCHPAGE](ux12-search-page.md)). 검색어와 선택한 문서·장 범위를 새 대화에 채우며 자동 전송하지 않는다. 보관 또는 기능 꺼짐에서는 숨긴다.
- **SEARCH-01과의 관계 (사용자 결정 2026-11-01):** 세 진입점(header 버튼·`문제` 메뉴·`AI에게 묻기`) 외에는 본문 검색과 별개다. 같은 검색 파이프라인을 쓰지만 검색창·결과 목록·URL은 바뀌지 않는다. 각주가 여는 "본문 발췌" panel은 SEARCH-01의 `DocumentExcerptPanel`을 그대로 쓴다.
- **panel:** 공통 `FloatingSidePanel`, non-modal(design-system §5.1; 다른 홈 dialog와 함께 열리고 나중에 연 것이 위 — QOV-01-AC10, 뒤로가기 규칙 QOV-01-AC14; modal 층 위에서 열 때는 아래 "panel 쌓기·뒤로가기"). **UX9와 합친 뒤(ASK-INTEG 2026-11-03):** 모든 홈 dialog가 modal이 되었으므로(HOMEDLG-01, 사용자 결정 2026-11-02 D3 "홈 밖의 floating panel도 모두 modal") AI 질문 panel도 어디서 열든 modal이다 — 열린 동안 홈은 inert이고, 홈 `?panel=` dialog 중 늘 맨 위에 쌓인다(딥링크·새로 고침에서도 마지막). 아래의 "non-modal로 열면"·"다시 열 때 위로" 규칙은 홈에서 더는 생기지 않는다. 본문 검색 페이지(SEARCH-02)의 `AI에게 묻기`는 그 페이지 위에 같은 panel을 modal로 열고 URL에 남기지 않는다(그 페이지의 "본문 발췌" panel과 같음; 대화는 저장되어 홈 `?panel=ask` 목록에서 다시 연다). 모바일(<640px)은 full-height sheet(safe-area, 입력란은 아래 고정, 화면 키보드가 올라오면 입력란이 그 위에 남음). 데스크톱 폭은 §5.1 기본(500px).
  - header: 대화 화면이면 시작 쪽에 `대화 목록` 화살표 버튼(UX12-ASK), 제목 "AI 질문", 부제(대화를 열었으면 대화 제목), 닫기.
  - **대화 목록 보기**(`?panel=ask`, 대화 없음): 대화 행(제목·마지막 시각, 누르면 연다)과 행 메뉴 `삭제`. 대화가 없으면 빈 상태 "Workspace 문서에 대해 물어보세요."가 보인다. 입력란은 없고, 질문할 수 있으면 오른쪽 아래의 `새 대화` FAB가 대화 화면을 연다(UX12-ASK).
  - **대화 보기**(`?panel=ask&conversation=<id>`): 메시지 목록(`role="log"`, 이름 "대화"), 맨 아래 입력 영역.
  - 사용자 메시지: 오른쪽 정렬 말풍선(글자만, Markdown 렌더링 없음). 첨부가 있던 메시지 위에는 첨부 칩의 작은 사본.
  - 답 메시지: 왼쪽, 본문(Markdown 일부 — 문단·목록·강조·코드 — 만 렌더링하고 HTML·링크·이미지는 글자로 다룬다: LLM 출력 sanitize, DOCSUM-01과 같은 renderer), 본문의 각주 번호 `[1]`은 버튼(접근성 이름 "출처 1: <문서 제목> p.12"), 그 아래 `출처` 목록(`ol`: `[1] <문서 제목> · <장> · p.12–13`, 각 줄은 버튼), 동작 줄(`복사`, `도움이 안 됨`), 안내 "AI가 문서를 근거로 만든 답입니다. 틀릴 수 있으니 출처를 확인하세요."
  - 출처 버튼은 오른쪽에 "본문 발췌" panel(SEARCH-01 `DocumentExcerptPanel`, non-modal, 휴대폰은 bottom sheet)을 열어 그 근거 발췌 전체·위치를 보이고, panel의 "PDF에서 보기"는 DOC-02 그 쪽(`?page=`)을 연다. 발췌는 메시지에 고정된 revision의 블록에서 읽는다; 그 revision이 더는 발행본이 아니면 "이 출처는 이전 발행본입니다. 현재 문서와 다를 수 있습니다."를 단다(메시지 내용은 바뀌지 않음).
  - `복사`: 답 본문(Markdown 원문)과 출처 목록(`[1] 문서 제목 p.12`)을 clipboard에 쓴다. 완료 시 `role="status"` "복사했습니다".
  - `도움이 안 됨` (사용자 결정 2026-11-01): 누르면 이유 4개 중 하나(`출처와 다름`·`지어낸 내용`·`정답을 알려 줌`·`기타`)를 고르는 작은 popover. 이유 code만 저장한다(자유 글 없음). 사용자 본인만 보고, 운영은 개수만 집계해 eval에 쓴다.
  - **`다시 시도` (UX12-ASK, D-10):** 대화의 **마지막 답**이 실패·중지 상태이면 동작 줄에 `다시 시도`가 있다. 성공·찾지 못함 답의 `다시 생성` 버튼은 2026-11-06에 뺐다. API `/regenerate`는 남아 있고, 기존 대화의 답 버전은 그대로 읽는다. API로 다시 만들면 같은 사용자 질문에 대해 새 답 메시지(`regenerated_from_message_id` = 이전 답)를 만든다 — 근거 검색을 다시 실행하고(그사이 발행된 교재 반영) 새 근거를 고정한다.
    - **이전 답은 버전으로 남긴다**(append-only — 메시지를 바꾸지 않음): 답 위에 "답 2/2" 글자와 `이전 답`·`다음 답` 버튼(접근성 이름 "이전 답 보기"·"다음 답 보기")으로 같은 질문의 답 버전을 오간다. 기본은 최신 버전이고, LLM에 보내는 직전 턴과 대화 목록·복사는 **보고 있는 버전이 아니라 최신 버전**을 쓴다. 이전 버전의 출처·각주·`도움이 안 됨`은 그대로 쓸 수 있다.
    - 한도: `다시 생성`은 새 질문과 같이 센다 — 사용자 분당·하루 한도, 진행 중 1개, 월 token 상한에 포함된다(대화 턴 수 `ASK_MAX_TURNS`에는 세지 않음). 같은 질문의 답 버전은 최대 `ASK_MAX_REGENERATIONS`(기본 5)개이고, 넘으면 `다시 시도`가 비활성 + "이 질문의 답은 5개까지 만들 수 있습니다."(API 409 `ask-regenerate-limit`). 마지막이 아닌 답(뒤에 다른 질문이 있음)에는 `다시 시도`가 없다 — 뒤 대화의 문맥이 어긋나지 않게 한다.
    - 보관된 Workspace·기능 꺼짐에서는 없다(새 질문과 같음).
- **입력 영역:** 첨부 칩(있을 때) → 여러 줄 입력란(접근성 이름 "질문", placeholder "문서에 대해 질문하세요", 자동 높이 최대 6줄) → 글자 수(한도의 80%부터 보임) → `보내기`(아이콘 버튼, 접근성 이름 "보내기") / 답을 만드는 동안은 같은 버튼이 `답변 중지` → `질문 범위`(필터 아이콘 버튼). 대화 화면 아래쪽의 floating 카드이고 대화 목록에는 없다(UX12-ASK).
  - **첨부 칩:** "3장 12번 · <발문 앞 40자>" + 공개 수준 글자("제출 전 — 정답 없이 힌트만" / "제출 후 — 정답·해설 포함" / "정답·해설 포함"), 오른쪽 `×`("첨부한 문제 빼기"). 색만으로 상태를 구분하지 않는다(글자). 칩을 누르면 아무 일도 없다(문제를 다시 열지 않음 — `질문하기`를 누른 문제 화면이 이미 뒤에 열려 있다).
  - Enter = 보내기, Shift+Enter = 줄바꿈. 한글 IME 조합 중(`compositionstart`~`compositionend`)의 Enter는 보내지 않는다(SEARCH-01-AC12와 같은 IME 규칙). 보내면 입력란을 비우고 focus는 입력란에 남는다. 앞뒤 공백만 있는 질문은 보내지 않는다.
- **답을 만드는 동안:** 답 메시지 자리에 "근거를 찾는 중" → "답을 쓰는 중"(글자 상태 + 깜빡이지 않는 진행 표시) → 받은 글자를 이어 붙인다. 각주 표시 `[S1]`은 받는 동안 번호 칩(`[1]`)으로 보이고, 끝나면(`done`) 서버가 검증한 최종 본문으로 바꾼다(검증에서 빠진 각주는 사라짐). `prefers-reduced-motion`에서는 글자 단위 애니메이션 없이 받은 덩어리를 그대로 붙인다.
- **질문 범위 popover:** "질문 범위" — 문서 Select(`전체 교재`가 기본) / 장 Select(SEARCH-01 "본문 설정"과 같은 부품·같은 교재 목록, 문제지 없음). 고른 범위는 다음 메시지부터 적용되고 입력창 안에 "범위: <문서 제목>" 글자와 버튼의 점 표시가 보인다. 범위는 대화에 기억된다.
- **문제 쪽 진입점 (사용자 결정 2026-11-01; ASK-SYNC 2026-11-02에 QuestionViewer 방식으로 다시 적음 — [QVIEW-01](question-viewer.md) "기존 호출 위치"의 번호):**

  | QVIEW-01 호출 위치 | 방식 | `질문하기` | 제출 결과 아래 `AI 질문하기`(AIEXPL-01 영역 안) |
  |---|---|---|---|
  | 1·2·3 Heatmap marker·이력·정리 노트 링크 (`?question=`, 풀이 panel) | `practice` | **없음** (header·메뉴 어디에도) | 제출 뒤, AI 질문이 켜진 환경 → `practice` 첨부 `full` |
  | 1a 풀이 panel의 `문제 관리`/`문제 정보` 메뉴 | `practice` 메뉴 | 메뉴 항목 없음 | — |
  | 4 메뉴의 `정답·해설 보기`·`수정 이력·출처` → "문제 상세" dialog | `manage` | footer `질문하기`(`detail` → `full`) | — (정답이 이미 보이므로 제출 없이 `AI 해설`이 있고 그 아래 같은 링크도 `detail` 첨부) |
  | 5 `보관·초안 문제` dialog 행 → "문제 상세" dialog | `manage` | footer `질문하기`(편집 권한이면 그 상태의 동작 버튼 앞; `detail` → `full`) | 4와 같음 — 단 초안(DRAFT) 상세에는 `AI 해설`·관련 본문이 없다(`질문하기`는 있음; ASK-SYNC (b)) |
  | 6 공유 게스트 미리보기 | `read-only` | 없음 | 없음 |
  | 7 `문제` › `문제 풀기` 범위 풀이 | `sequence(bank)` | **없음** | 제출 뒤 → 그 묶음 session의 `practice` 첨부 `full`(`이전`·결과 목록으로 돌아간 읽기 전용 결과에서도) |
  | 8 모의고사 `풀기` | `sequence(mock)` | header `질문하기`, 제출 전 `hint`·제출 후 `full` | 제출 뒤 → `mock_exam_question` 첨부 `full` |
  | 9 모의고사 상세의 문제 행(편집 권한) | `manage(mock)` | header `질문하기`(`view: manage` → `full`) | — |

  - 공통: 접근성 이름 "이 문제로 AI에게 질문하기", 모든 구성원(9는 편집 권한만 그 dialog를 연다). 기능이 꺼진 환경과 보관된 Workspace에는 문제의 `질문하기`와 `AI 질문하기`가 없다(header `AI 질문`은 보이고 panel이 이유를 보인다) (사용자 결정 2026-11-01). 삭제된 모의고사·모의고사에서 빠진 문제에는 없다(QuestionViewer가 "더 이상 풀 수 없습니다"를 보이는 위치).
  - 버튼은 QuestionViewer가 그리고(방식·출처별 표시 규칙은 QuestionViewer가 가짐), 누르면 호출 위치와 상관없이 같은 "문제를 첨부한 새 대화"를 연다. `질문하기`로 첨부를 만들어도 풀이 기록·열람(viewed)·Heatmap 상태·`mock_exam_attempts`는 바뀌지 않는다.
- **panel 쌓기·뒤로가기 (ASK-SYNC 2026-11-02 — 기존 사용자 결정의 규칙을 `?panel=ask`에 적용):**
  - `?panel=ask`(+ `conversation`)는 문서 관리·모의고사·이력과 같은 홈 `?panel=` 값이다. AI 질문 panel은 하나뿐이고 non-modal 홈 dialog의 쌓기(QOV-01-AC10: 나중에 연 것이 위, 이미 열려 있으면 다시 열 때 위로)와 뒤로가기 규칙(QOV-01-AC14: 열면 기록 항목 하나, 열린 동안 뒤로가기 한 번 = 맨 위 dialog 하나 닫기, 닫힌 panel은 뒤로가기·앞으로가기 어느 쪽으로도 다시 열리지 않음, 닫으면 열기 전 주소로 돌아가되 열린 동안 바꾼 필터·검색어는 유지, 딥링크·새로 고침으로 열린 panel도 뒤로가기 한 번에 하나씩 닫힘)을 그대로 따른다.
  - panel 안 전환은 모의고사 dialog와 같다(QVIEW-01 "뒤로가기·URL state", 사용자 결정 2026-11-02): 대화 목록에서 대화를 열면(`conversation=<id>`) 기록 항목을 쌓아 뒤로가기가 panel을 연 채 목록으로 돌아간다(`대화 목록` 버튼과 같은 결과). 새 대화에서 첫 질문을 보내 `conversation=<id>`가 생기는 것은 같은 대화 안의 단계 전환이라 기록 항목을 바꾼다(replace).
  - **QVIEW-01-AC09(풀이 panel ↔ 범위 풀이 배타)와 무관:** `?panel=ask`는 `question`·`practice` 어느 쪽과도 함께 열릴 수 있다. 풀이 panel이나 범위 풀이를 열고 닫거나 서로 바꾸어도 AI 질문 panel은 닫히지 않고, AI 질문 panel을 열어도 그 둘은 닫히지 않는다. 두 매개변수를 함께 가진 주소를 범위 풀이만 남기는 redirect는 `panel=ask`를 그대로 둔다.
  - **modal 층 위로 열기 (사용자 결정 2026-11-01 (10)을 모든 modal 층으로):** modal 층 — 풀이 panel(`practice`), 범위 풀이 panel(`sequence(bank|mock)`), "문제 상세" `ModalDialog`(`manage`), 모의고사 문제 관리 panel(`manage(mock)`) — 안의 `질문하기`·`AI 질문하기`로 열면 AI 질문 panel은 열린 모든 modal 층의 **위**에 그려지고 그동안 modal처럼 focus를 가둔다(밖은 inert). 아래 층의 상태(고르던 답, practice session, 범위 풀이의 위치 `i`·진행, 열린 문제 상세)는 그대로다. 닫기·Escape·뒤로가기 한 번은 AI 질문 panel만 닫고 focus를 누른 버튼으로 돌린다; 그다음 뒤로가기는 아래 층의 규칙(범위 풀이 panel 닫기 등)을 따른다. AI 질문 panel이 focus를 가두는 동안 아래 층의 `제출`·`이전`·`다음`은 닿지 않는다. 휴대폰에서는 아래 bottom sheet 위의 full-height sheet다. 출처 각주가 여는 "본문 발췌" panel은 AI 질문 panel 위에 열린다(AC10).
  - (ASK-INTEG 전 규칙 — UX9부터 언제나 modal, 위 "panel") header 버튼·`문제` 메뉴·`AI에게 묻기`로 열면 non-modal이다. non-modal로 열린 AI 질문 panel 위에 나중에 modal 층이 열리면(예: Heatmap marker) 다른 non-modal 홈 dialog처럼 그 아래에 남는다. 주소에 modal 층과 `panel=ask`가 함께 있으면(딥링크·새로 고침) AI 질문 panel을 맨 위에 modal처럼 연다(문제 상세는 URL state가 아니라 다시 열리지 않는다).
  - **이미 열린 AI 질문 panel에서 `질문하기` (사용자 결정 2026-11-02, ASK-SYNC (c)):** non-modal로 열린 AI 질문 panel이 modal 층 아래에 있을 때 문제의 `질문하기`를 누르면, 열린 panel을 닫고(닫힌 대화는 뒤로가기로 돌아오지 않음; 보내지 않은 입력은 버림 — 보낸 대화는 저장되어 목록에 있음) 새 대화로 맨 위에 다시 연다 — QVIEW-01-AC09의 "닫기 한 번 + 열기 한 번"과 같은 기록 규칙. 새 panel은 기록 항목 하나라 뒤로가기 한 번이 그것을 닫고, 닫힌 이전 panel은 다시 열리지 않는다.
- **오류 이유 문구:** `llm_unavailable`·`llm_timeout` → "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.", `llm_refused` → "이 질문에는 답할 수 없습니다.", `sources_unavailable`(고정한 근거 revision이 더는 발행본이 아니거나 문서가 지워짐) → "근거 문서가 바뀌었습니다. 다시 질문하세요.", `workspace_unavailable` → "Workspace를 사용할 수 없습니다.", 그 밖 `ask_failed` → "답을 만들지 못했습니다. 다시 시도하세요." 오류는 답 자리의 `role="alert"`와 `다시 시도`(해당하면)로 보인다. 오류 문구에 LLM 응답 원문은 없다.
- **접근성:** panel 안 Tab 순서 header → 메시지 목록(답마다 각주 버튼·출처·동작) → 첨부 칩 `×` → 입력란 → 보내기. 메시지 목록은 `role="log"`이지만 **글자 하나하나를 읽어 주지 않는다**: 답을 만드는 동안 그 답 요소는 `aria-busy="true"`이고, 별도의 시각적으로 숨긴 `role="status"`가 "답을 쓰는 중입니다" (시작), "답변이 끝났습니다. 출처 n개" (끝), 오류면 alert 문구를 한 번씩 알린다. 끝난 답은 `aria-busy="false"`가 되어 화면 낭독기로 읽을 수 있다. 새 답이 오면 사용자가 위로 스크롤해 있지 않은 한 아래로 따라간다(스크롤해 있으면 "새 답변" 버튼). Escape(focus가 panel 안이고 IME 조합 중이 아님, 열린 popover가 없음)와 닫기 버튼으로 닫고 focus를 연 버튼으로 돌린다. 터치 target 24px 이상(WCAG 2.5.8). 375px에서 가로 스크롤 없음.

## 화면 상태

| 상태 | 구성원(owner·editor·viewer) | 보관된 Workspace | 공유 게스트 |
|---|---|---|---|
| 처음(대화 없음) | 빈 상태 + `새 대화` FAB | 빈 상태 + "보관된 Workspace에서는 새 질문을 할 수 없습니다."(FAB 없음) | header 버튼 없음, `?panel=ask` 무시 |
| 근거 찾는 중 · 답 쓰는 중 | 진행 글자 + 받은 글자 + `답변 중지` | (새 질문 없음) | — |
| 답 성공 | 본문 + 각주 + 출처 + `복사`·`도움이 안 됨` | 지난 대화 읽기 | — |
| 찾지 못함(`no_sources`) | 정해진 문구(+ 검색한 구절 목록) | 읽기 | — |
| 중지됨(`stopped`) | 받은 데까지의 글자 + "답변을 중지했습니다." + `다시 시도` | 읽기 | — |
| 실패 | alert 이유 + `다시 시도` | 읽기(버튼 없음) | — |
| 답 버전이 여럿(예전 대화·API 재생성) | "답 n/n" + `이전 답`·`다음 답` | 읽기(버전 오가기만) | — |
| 한도(턴·하루·분당·월) | 이유 + 보내기 비활성(분당은 남은 초) | — | — |
| 기능 꺼짐(환경) | 대화 화면은 비활성 입력란(`aria-disabled`, focus 가능), 목록은 FAB 없음 + "이 환경에서는 AI 질문을 사용할 수 없습니다." 지난 대화 읽기, 문제 상세의 `질문하기` 없음, 새 질문 header·`AI에게 묻기` 숨김 | 같음 | — |
| 다른 사용자·다른 Workspace·지운 대화 딥링크 | panel에 "대화를 찾을 수 없습니다."(API 404) + `새 대화` | 같음 | — |
| 첨부 문제가 삭제·보관됨 | 칩에 "더 이상 볼 수 없는 문제" — 다음 메시지부터 문제 context 없음 | 같음 | — |

- 대화 삭제: 행 메뉴·대화 header 메뉴의 `삭제` → `ConfirmDialog` "대화를 삭제할까요? 질문과 답이 모두 지워지고 되돌릴 수 없습니다." `삭제`/`취소`. 보관된 Workspace에서도 자기 대화는 지울 수 있다(개인 데이터 — Workspace 내용이 아님) (사용자 결정 2026-11-01).
- Workspace를 삭제하면 그 Workspace의 대화도 지워진다. 구성원에서 빠진 사용자는 그 Workspace의 대화에 닿을 수 없고(404), 대화는 보존 기간이 지나면 지워진다.

## 수용 기준

모든 E2E는 `APP_ENV=test`의 결정적 fake 답변기(아래 C11)를 쓴다. 실제 모델은 `eval/`·`make test-llm`에서만 쓴다.

### ASK-01-AC01

- **Given:** 발행된 합성 교재(`book-ko.pdf`, 장 2개, 장 1에 고유 구절 "가나다 원리")가 있는 Workspace 홈(편집 권한), 기능이 켜진 환경, fake 답변기
- **When:** header의 `AI 질문`을 누르고, 입력란에 "가나다 원리를 설명해 줘"를 쓰고 Enter를 두 번 빠르게 누른 뒤 답이 끝나기를 기다린다. 답의 각주 `[1]`을 누르고, 발췌 panel의 "PDF에서 보기"를 누른 뒤 돌아와 `복사`를 누른다
- **Then:** panel이 데이터를 기다리지 않고 바로 열리고(`?panel=ask`) 빈 상태와 `새 대화` FAB를 보인다. FAB로 연 입력란에서 보내면 URL이 `?panel=ask&conversation=<id>`로 바뀌고 사용자 메시지 하나와 답 하나만 생긴다(Idempotency-Key). 답 자리는 "근거를 찾는 중"·"답을 쓰는 중"을 거쳐 글자가 **여러 번에 나눠** 늘어나며(SSE `delta` 2개 이상), 끝나면 안내 문구, 본문의 `[1]`, `출처` 목록 `[1] <교재 제목> · <장 1 제목> · p.<n>`을 보인다. 출처 1은 장 1의 "가나다 원리" 구절이다. `[1]`은 "본문 발췌" panel에 그 구절과 위치를 보이고, "PDF에서 보기"는 DOC-02 그 쪽을 연다. `복사` 뒤 clipboard에는 본문과 출처 줄이 있고 "복사했습니다"가 알려진다. 새로 고침하면 같은 대화·같은 답이 보인다(저장).

### ASK-01-AC02

- **Given:** 발행된 교재, 같은 고유 구절 "라마바 정답표"가 **문제지에만** 있는 발행된 문제지, 문제 구간에만 "사아자 해설"이 있는 발행된 교재+문제(`mixed`), 아무 문서에도 없는 단어 "차카타파"
- **When:** "라마바 정답표", "사아자 해설", "차카타파"를 각각 새 대화로 묻는다. 세 번째 질문의 fake 호출 수를 확인하고, `질문 범위`에서 장 2만 고른 뒤 장 1에만 있는 구절을 묻는다
- **Then:** 세 질문 모두 답은 "올린 문서에서 관련 내용을 찾지 못했습니다. 질문을 바꾸거나 질문 범위를 넓혀 보세요."이고 출처가 없다(문제지는 검색하지 않고, `mixed`의 문제 구간은 근거에서 빠진다). "차카타파"는 fake 답변기를 부르지 않는다(호출 수 0, usage 0, 메시지 상태 `no_sources`). 범위를 장 2로 좁히면 장 1의 구절은 근거가 되지 않아 같은 찾지 못함 문구가 나오고 입력창 안에 "범위: …" 글자가 보인다. API의 메시지 출처에는 `question_paper` 문서가 없다.

### ASK-01-AC03

- **Given:** 발행된 교재, fake 답변기 marker `E2E-ASK-BADCITE`(올바른 `[S1]` 각주와 근거에 없는 `[S9]` 각주를 함께 내는 답), marker `E2E-ASK-NOANSWER`(`[NO_ANSWER]`로 시작하는 답)
- **When:** marker가 든 질문을 각각 보내고 끝나기를 기다린다
- **Then:** BADCITE 답의 최종 본문에는 `[1]`만 있고 `[S9]`나 그에 해당하는 번호·출처 줄은 화면·`GET /ask/messages/{id}` 어디에도 없다(받는 동안 보였던 번호 칩도 `done` 뒤 사라짐). 저장된 인용은 고정된 근거만 가리킨다. NOANSWER 답은 찾지 못함 문구와 "검색한 구절" 목록(근거 문서·쪽)으로 바뀐다.

### ASK-01-AC04

- **Given:** 해설("E2E-EXPLANATION-SECRET")과 정답 보기("E2E-CORRECT-OPTION")가 있는 확정 객관식 문제를 아직 풀지 않은 보기 권한 멤버, Heatmap에서 연 풀이 panel(보기 하나를 고르고 제출하지 않음), fake 답변기 marker `E2E-ASK-LEAK-PROBE`(받은 문제 context의 항목 이름과 글을 그대로 되돌려 주는 답)
- **When:** 풀이 panel header를 확인하고, `문제 정보` › `정답·해설 보기`로 연 "문제 상세" dialog의 `질문하기`를 누른다. "E2E-ASK-LEAK-PROBE 이 문제 설명"을 보내고, 칩의 `×`로 첨부를 뺀 뒤 한 번 더 보낸다. AI 질문 panel을 Escape로 닫고 문제 상세를 닫는다
- **Then:** 풀이 panel header에는 `질문하기`가 없다. AI 질문 panel은 문제 상세 dialog 위에 새 대화로 열리고 칩에 "<장> <번호>번 · <발문 앞부분>"과 "정답·해설 포함"이 보인다(`detail` → `full`, 이미 dialog에 보이는 내용). probe 반향에 발문·보기·정답·해설이 있다. 보기 권한도 질문할 수 있다. 첨부를 뺀 뒤의 답에는 문제 context가 없다. 닫으면 focus가 `질문하기`로, 문제 상세를 닫으면 메뉴 버튼으로 돌아오고, 풀이 panel의 고른 보기·session은 그대로라 제출할 수 있으며 질문만으로는 풀이 기록·Heatmap 상태가 바뀌지 않는다.

### ASK-01-AC05

- **Given:** AC04의 문제와 그 문제의 아직 제출하지 않은 practice session(보기 하나를 골라 둠), 다른 사용자의 session id, 기능이 꺼진 환경과 보관된 Workspace
- **When:** UI 경로가 없는 `practice` 첨부를 API로 직접 만든다: 미제출 session으로 `POST /workspaces/{id}/ask/conversations`(첨부 `view: practice`, 고른 option id)와 LEAK-PROBE 질문을 보내고 그 대화를 panel에서 연다. 풀이 panel에서 답을 제출한 뒤 같은 대화에서 같은 질문을 보낸다. 다른 사용자의 session id로 첨부를 만들고, client가 `disclosure: full`을 보낸다. 기능이 꺼진 환경과 보관된 Workspace에서 문제 상세 dialog를 연다
- **Then:** 제출 전 칩은 "제출 전 — 정답 없이 힌트만"이고, probe 반향에는 발문·보기 글("E2E-CORRECT-OPTION"도 정답 표시 없는 보통 보기로)·고른 보기만 있고, "E2E-EXPLANATION-SECRET"과 정답을 가리키는 항목(`correct_answer`·`correct_option_ids`·`is_correct`·`explanation`·`accepted_answers`·`rubric`·`question_sources`)이 **없다** — 서버가 LLM에 보내지 않았다(C03). 어떤 응답(POST·SSE·GET)에도 어느 보기가 정답인지 알리는 field와 해설이 없다. 제출 뒤 같은 대화의 칩은 "제출 후 — 정답·해설 포함"이고 probe 반향에 정답·해설·제출한 답·결과가 있다(메시지 `disclosure`: `hint` → `full`). 다른 사용자의 session은 404이고 client의 `disclosure` 값은 무시된다(여전히 `hint`). 기능이 꺼진 환경과 보관된 Workspace의 문제 상세에는 `질문하기`가 없다.

### ASK-01-AC06

- **Given:** 같은 Workspace의 Owner와 보기 권한 멤버, 기능이 켜진 환경
- **When:** Owner가 질문 3개를 이어서 묻고(두 번째 질문은 "앞의 답을 더 짧게" — fake는 받은 이전 턴 수를 답에 적는다), panel을 닫았다 열어 대화 목록에서 그 대화를 다시 연다. 새 대화를 하나 더 만든 뒤 첫 대화를 `삭제`(먼저 `취소`, 다시 `삭제`)한다. 보기 권한 멤버가 Owner 대화의 URL·`GET /ask/conversations/{id}`·`/stream`·`DELETE`를 직접 부른다
- **Then:** 답은 같은 대화에 순서대로 쌓이고 두 번째 답의 fake 반향에 이전 턴 1개, 세 번째에 2개가 적힌다(직전 3턴까지). 대화 목록은 최근 순으로 두 대화(제목 = 첫 질문 앞 40자)를 보인다. `취소`는 아무것도 바꾸지 않고 focus를 메뉴 버튼으로 돌린다. `삭제` 뒤 그 대화는 목록에서 사라지고 그 URL은 "대화를 찾을 수 없습니다."다. 보기 권한 멤버에게 Owner 대화는 어느 경로로도 404이고 그 멤버의 목록에 없다. 이력 dialog(활동·작업)에 질문·답·`ask.answer` 작업이 보이지 않는다.

### ASK-01-AC07

- **Given:** 대화가 하나 있는 Workspace를 보관(archive)한 상태의 Owner, 다른 Workspace의 사용자, 같은 Workspace의 유효한 공유 링크(비로그인 게스트)
- **When:** Owner가 저장된 대화의 딥링크를 열어 지난 대화를 보고 `POST …/messages`를 직접 부른다. 다른 사용자가 그 Workspace의 `GET /workspaces/{id}/ask`·`POST /workspaces/{id}/ask/conversations`(다른 Workspace의 문서·장 id를 범위로)를 부른다. 게스트가 `/share/:shareId?panel=ask`를 연다
- **Then:** 보관된 Workspace에서 지난 대화는 읽히고, 입력란은 비활성이며 "보관된 Workspace에서는 새 질문을 할 수 없습니다."를 보이고, POST는 403 `workspace-archived`다. 다른 사용자는 404(Workspace를 모르는 것과 같은 응답)이고, 자기 Workspace에서 다른 Workspace의 문서·장 id로 범위를 보내도 그 문서의 내용은 근거·응답에 나오지 않는다. 공유 화면에는 `AI 질문` 버튼이 없고 `?panel=ask`는 아무 panel도 열지 않으며, 공유 세션으로 부른 ask API는 401/404다.

### ASK-01-AC08

- **Given:** 기능이 꺼진 환경(`WORKER_ASK_LLM` off 또는 `LLM_MODEL` 없음), 기능이 켜져 있을 때 만든 대화 하나
- **When:** 편집 권한자가 저장된 대화의 딥링크를 열고 `GET /workspaces/{id}/ask`와 `POST …/messages`를 직접 부른다
- **Then:** panel은 열리고 입력란은 비활성(`aria-disabled`, focus 가능), 보내기는 숨겨지며 "이 환경에서는 AI 질문을 사용할 수 없습니다."가 연결된 설명(`aria-describedby`)이다. 지난 대화와 출처 발췌는 그대로 읽힌다. API는 `available: false`, POST는 409 `ask-disabled`이고 job·LLM 호출이 없다.

### ASK-01-AC09

- **Given:** fake 답변기 marker `E2E-ASK-FAIL`(제공자 오류), `E2E-ASK-SLOW`(글자를 천천히 오래 흘림), 테스트 stack의 분당 한도 2
- **When:** FAIL 질문을 보내고 `다시 시도`를 누른다(두 번째는 marker 없는 같은 fixture로 성공하도록 설정). SLOW 질문을 보내고 글자가 보이기 시작하면 `답변 중지`를 누른다. 1,001자 질문을 붙여 넣는다. 1분 안에 질문 3개를 보낸다. SLOW 답이 흐르는 동안 새로 고침한다. 성공한 마지막 답을 API `/regenerate`로 다시 만들고 끝나기를 기다린 뒤 대화를 다시 열어 `이전 답`을 누른다. 같은 질문을 API로 한도(테스트 stack 2개)까지 다시 만든다
- **Then:** FAIL 답은 `role="alert"` "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요."와 `다시 시도`를 보이고, `다시 시도`는 같은 질문의 새 답 메시지를 만들어 성공한다(실패한 메시지는 남음). `답변 중지`는 받은 데까지의 글자와 "답변을 중지했습니다."를 남기고(상태 `stopped`) worker 호출을 멈춘다(그 뒤 delta 없음). 1,001자면 "1,001/1,000"이 보이고 보내기가 비활성이며 API는 422 `question-too-long`이다. 세 번째 질문은 429로 "잠시 후 다시 질문하세요 (n초)"를 보이고 입력한 글이 남는다. 흐르는 중에 새로 고침하면 같은 답이 이어서 끝까지 보인다(`Last-Event-ID` 또는 polling). 화면에는 `다시 생성`이 없고, API로 만든 새 답 버전은 "답 2/2"로 보이며 `이전 답`은 이전 답(본문·출처 그대로)을 "답 1/2"로 보인다(이전 답은 지워지지 않음). 한도를 넘는 재생성은 API 409 `ask-regenerate-limit`이며, 재생성도 분당 한도에 세어진다. 오류 화면·응답·로그에 LLM 응답 원문과 prompt가 없다.

### ASK-01-AC10

- **Given:** 답이 있는 대화, 데스크톱 키보드 전용 사용자, 그리고 휴대폰(iPhone Safari, 터치) 화면
- **When:** 키보드만으로 `AI 질문`을 열고, 한글 IME로 조합하며 Enter를 누르고, 조합이 끝난 뒤 Shift+Enter와 Enter를 누르고, 답이 흐르는 동안과 끝난 뒤 live region을 확인하고, Tab으로 각주·출처·`복사`에 가서 Enter로 발췌 panel을 연 뒤 Escape를 두 번 누른다. 휴대폰에서 같은 panel을 열고 입력란을 탭한다
- **Then:** 조합 중의 Enter는 보내지 않고 조합이 끝난 뒤 Shift+Enter는 줄을 바꾸며 Enter는 보낸다. 답이 흐르는 동안 답 요소는 `aria-busy="true"`이고 status는 "답을 쓰는 중입니다"를 한 번, 끝나면 "답변이 끝났습니다. 출처 n개"를 한 번 알린다(글자마다 알리지 않음). Tab 순서는 header → 메시지(각주·출처·동작) → 입력란 → 보내기 → 질문 범위다. 첫 Escape는 발췌 panel을 닫고 focus를 누른 출처 버튼으로, 두 번째는 AI 질문 panel을 닫고 focus를 `AI 질문` 버튼으로 돌린다. 휴대폰에서는 full-height sheet로 열리고 화면 키보드가 올라와도 입력란과 보내기가 보이며 가로 스크롤이 없고 버튼은 24px 이상이다. axe 위반 0.

### ASK-01-AC11

- **Given:** 발행된 교재가 있는 Workspace 홈(보기 권한 멤버), 같은 Workspace를 보관한 상태, 기능이 꺼진 환경
- **When:** header의 `AI 질문`을 열고, 본문 검색에서 검색어와 문서를 고른 뒤 `AI에게 묻기`를 누른다. 보관 Workspace와 기능 꺼짐 환경에서도 확인한다.
- **Then:** header는 같은 panel을 열고 뒤로가기는 닫는다. 검색의 버튼은 검색어와 범위를 채우되 자동 전송하지 않는다. 보관·기능 꺼짐에서는 새 질문 진입점을 숨기고, 허용된 저장 대화는 딥링크로 읽을 수 있다. 직접 전송 API는 각각 403 또는 409로 거절한다.

### ASK-01-AC12

- **Given:** 해설("E2E-MOCK-EXPLANATION-SECRET")·정답 보기("E2E-MOCK-CORRECT-OPTION")가 있는 객관식 문제 2개로 만든 모의고사(`보기 섞기`, MOCK-01; 원본 출처는 교재 장 1의 쪽), 보기 권한 멤버와 편집 권한자, fake 답변기 marker `E2E-ASK-LEAK-PROBE`, 기능이 켜진 환경
- **When:** 보기 권한 멤버가 모의고사 행의 `풀기` → `시작`으로 첫 문제를 열고 보기 하나를 고른 뒤(제출 전) header의 `질문하기`를 누르고 "E2E-ASK-LEAK-PROBE 이 문제 설명"을 보낸다. 뒤로가기를 한 번 누르고, 답을 제출한 뒤 header의 `질문하기`로 새 대화를 열어 같은 질문을 보내고 Escape로 닫는다. 편집 권한자가 모의고사 상세의 문제 행을 열어(`manage(mock)`) `질문하기`로 같은 질문을 보낸다. 마지막으로 편집 권한자가 그 모의고사를 삭제하고 보기 권한 멤버가 첫 대화를 다시 연다
- **Then:** 범위 풀이 header에 `질문하기`가 있고, AI 질문 panel은 범위 풀이 panel **위**에 새 대화로 열려 focus를 가둔다. 제출 전 칩은 "문제 1 · <발문 앞부분>"과 "제출 전 — 정답 없이 힌트만"이고 probe 반향에 발문·보기 글(정답 보기 "E2E-MOCK-CORRECT-OPTION"도 정답 표시 없는 보통 보기로)·고른 보기만 있으며 "E2E-MOCK-EXPLANATION-SECRET"·정답을 가리키는 항목(C03)·근거(`evidence`) 구절이 없다. 뒤로가기 한 번은 AI 질문 panel만 닫고(URL에서 `panel=ask`가 빠지고 `practice=<id>&i=1`은 그대로) focus는 `질문하기`로, 범위 풀이의 고른 보기·진행 "2문제 중 1번째"는 그대로라 제출할 수 있다. 제출 뒤 새 대화의 칩은 "제출 후 — 정답·해설 포함"이고 probe 반향에 정답·해설·제출한 답·결과와 장 1의 출처 구절이 있다. `manage(mock)`에서 연 대화는 "정답·해설 포함"이다. 질문은 `mock_exam_attempts`·`question_attempts`·Heatmap을 바꾸지 않는다. 모의고사를 삭제한 뒤 첫 대화의 칩은 "더 이상 볼 수 없는 문제"이고 다음 메시지에는 문제 context가 없다. 등록 문제의 범위 풀이(`문제 풀기`) header에는 `질문하기`가 없다.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/ask/test_ask_contract.py`, `apps/worker/tests`, `packages/core/tests`, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| ASK-01-C01 | **인가 matrix:** 모든 경로는 JWT `sub`의 사용자만. `GET /workspaces/{id}/ask`·대화 목록·만들기는 그 Workspace의 구성원(owner·editor·viewer), 아니면 404(알 수 없는 Workspace와 같은 응답). 대화·메시지·stream·cancel·retry·feedback·삭제는 **대화 주인만**(같은 Workspace의 다른 구성원·Owner도 404). 메시지 만들기·retry는 활성 Workspace만(보관 403 `workspace-archived`, 삭제 404), 읽기·삭제·중지는 보관 Workspace에서도 허용. 공유 세션 cookie로는 어떤 ask API도 부를 수 없다(401). 첨부 만들기는 서버가 문제·session을 읽어 확인한다: 문제가 이 Workspace의 살아 있는 문제가 아니면 404, `practice` 첨부의 session이 그 사용자의 것이 아니면 404, `detail`은 `GET /questions/{id}` 권한과 같음(보관·초안 문제 dialog의 상세 포함 — 살아 있는 문제면 상태와 무관). 모의고사 문제 첨부의 인가는 C10. |
| ASK-01-C02 | **검색 범위:** 근거 후보는 서버가 정한 Workspace의 살아 있는 `document_type = book` 문서의 현재 발행 revision chunk뿐이다(Qdrant workspace·revision 필터 + Postgres 재확인). `question_paper`는 항상 제외, `mixed`는 문제 추출 구간 블록 제외, 문서 요약·정리 노트는 근거가 아님. 요청 범위의 문서·장 id는 이 Workspace의 발행 교재와 교집합(나머지는 무시 — 결과 없음, 404 아님). 고정된 참조(`ask_message_sources`: tag·rank·document·revision·chapter·block ids·쪽·chunk id·점수)는 본문을 복사하지 않는다. worker는 쓰기 직전까지 revision이 아직 현재 발행본인지 확인하고 아니면 `sources_unavailable`로 끝낸다(경쟁 test: 질문 직후 발행). |
| ASK-01-C03 | **정답 비노출 (지금 등록 문제에는 UI 경로가 없어도 서버 규칙으로 유지 — 사용자 결정 2026-11-01; 검사 방식 ASK-SYNC 2026-11-02):** `hint`에서 지키는 것은 "어느 것이 정답인지"와 사람이 쓴 비공개 내용이다 — 보기 글 자체가 아니다. 객관식 `hint` context는 모든 보기 글을 넣으므로 정답 보기의 **글**도 보통의 보기 하나로 들어가고, 사용자가 고른 보기가 마침 정답일 수도 있다. 그래서 검사는 두 가지다. (1) **타입:** prompt builder(`book_core.ask.build_request`)의 `hint` 입력 DTO에는 정답을 가리키는 field가 없다 — `correct_option_ids`·`correct_answer`, 보기의 `is_correct`·정답 표시, 정답 key, 정답 순서(정렬·순서형 문제의 정답 배열), 모범답안·허용 답안(`accepted_answers`), 채점 기준(`rubric`), 해설(`explanation`), `question_sources`(모의고사 `evidence`) 구절. API는 `hint`면 그 field를 DB에서 읽지도 않는다(타입으로 강제, schema test). (2) **직렬화 (property test):** 무작위 문제·보기 순서·고른 답(정답을 고른 경우 포함)으로 만든 `hint` 요청의 직렬화에 fixture의 고유 문자열 — 해설 `E2E-EXPLANATION-SECRET`, 채점 기준·모범답안·허용 답안 marker, 출처 구절 marker — 이 없고, 보기 목록에 정답 표시·정답 순서가 없다(보기는 표시 순서와 글만, 고른 답은 사용자 선택으로만 표시). 보기 글과 사용자의 선택은 허용한다 — 정답 보기의 글이 들어 있다는 것만으로 실패하지 않는다. **단답형·서술형**에는 보기가 없으므로 허용 답안·모범답안·채점 기준 글은 `hint` 요청 어디에도 나타나지 않는다(사용자가 입력한 답은 그 사람의 선택으로만 들어감). 공개 수준은 메시지마다 DB에서 계산(첨부 session의 제출 여부)하며 client가 보낸 값은 무시한다. 메시지 행에 `disclosure`(`none`·`hint`·`full`)를 남긴다. 어떤 ask 응답(POST·GET·SSE)도 LLM에 보낸 문제 context를 돌려주지 않는다. practice API(`practice-sessions`·`submit`) 응답은 바뀌지 않는다. |
| ASK-01-C04 | **인용 검증:** 모델은 근거마다 받은 tag(`S1`…`Sn`)로만 인용한다. 끝난 답에서 모르는 tag는 표시와 저장에서 지우고 개수만 기록한다(`dropped_citations`). 남은 tag는 출처 번호(`[1]`…, 처음 나온 순서)로 다시 매기고 `ask_message_sources.cited = true`. `[NO_ANSWER]`로 시작하면 찾지 못함으로 바꾼다. 근거가 있는데 인용이 하나도 없는 답은 저장은 하되 `uncited = true`로 표시하고 화면은 "출처를 확인하지 못한 답입니다." 안내를 단다. 답 본문 Markdown은 허용 목록 renderer로만 보인다(HTML·링크·이미지 글자 처리). |
| ASK-01-C05 | **streaming 계약:** SSE event `delta {seq, text}`(seq 연속), `reset`(worker 재시작 시 — client는 받은 글자를 지움), `done {message}`(검증된 최종 본문·출처·상태), `error {code}`. `Last-Event-ID`로 이어 받으면 빠짐·중복이 없다. 연결마다 인가를 다시 확인하고, 대화가 지워지면 열린 stream도 `error {code: not_found}`로 끝난다. Redis Stream key는 TTL 10분·최대 길이 제한, 끝난 메시지는 Postgres에서 답한다. `POST /cancel`은 대기·실행 중 메시지를 `stopped`로(멱등), worker는 다음 delta 전에 확인해 provider stream을 닫는다. polling `GET /ask/messages/{id}`는 지금까지의 글자(진행 중) 또는 최종 상태를 준다. |
| ASK-01-C06 | **한도·usage:** `다시 생성`·`다시 시도`는 새 질문과 같은 분당·하루·진행 1개·월 한도에 세고, 같은 질문의 답 버전은 `ASK_MAX_REGENERATIONS`(5)개까지(409 `ask-regenerate-limit`), 마지막 답에서만(아니면 409 `ask-not-last-answer`); LLM 직전 턴에는 질문마다 최신 답 버전만. 질문 길이(422 `question-too-long`), 대화당 턴(409 `ask-turn-limit`), 사용자당 진행 중 1개(409 `ask-answer-running`, partial unique), 분당 rate(429 + Retry-After), 하루 한도(DB 집계, 429 `ask-daily-limit` — 받아들인 답(새 질문·`다시 시도`·`다시 생성`, LLM을 부르지 않은 찾지 못함 포함)을 사용자·Asia/Seoul 날짜별 개수(`ask_daily_counts`, 내용 없음)로 세고 대화를 지워도 줄지 않는다 (사용자 결정 2026-11-02)), 월 token 상한(409 `ask-budget-exceeded`, 0 = 끔). 같은 `Idempotency-Key`의 재시도는 한도 검사 전에 같은 메시지를 돌려준다. LLM을 부른 답마다 `llm_feature_usage`(`feature = ask`, 사용자·Workspace·모델·input/output/cache token·`cost_usd`(가격 설정 시)·상태)를 쓰고 job 결과에는 개수·usage·오류 코드만. 근거 개수·글자 한도(`ASK_TOP_K`·`ASK_MAX_CONTEXT_CHARS`)와 `ASK_MAX_OUTPUT_TOKENS`가 요청에 적용된다(fake가 받은 값으로 확인). |
| ASK-01-C07 | **유출 금지:** 질문·답·검색된 본문·prompt·LLM 응답·첨부 문제 내용·token·키는 API·worker 로그, job `result`, trace, 활동 기록에 남지 않는다(log capture test). 오류는 code만(`llm_unavailable`·`llm_timeout`·`llm_refused`·`sources_unavailable`·`workspace_unavailable`·`ask_failed`), provider 오류 원문을 저장하지 않는다. SSE URL·query에 token이 없다. `ask.answer` job은 HISTORY-01 작업 목록과 다른 구성원의 `GET /jobs/{id}`에 나오지 않는다. |
| ASK-01-C08 | **보존·개인정보:** 대화는 주인만 읽고 지운다(삭제는 메시지·출처·피드백까지, usage는 `message_id = null`로 남김). `ask.purge`(beat, 하루 1회)는 마지막 메시지가 `ASK_RETENTION_DAYS`보다 오래된 대화를 지우고 13개월 넘은 usage를 지운다(멱등). Workspace 삭제는 대화를 지운다. Fork는 대화·usage를 복제하지 않는다. 끝난 메시지는 바뀌지 않는다(append-only trigger; `retry`는 새 메시지 + `retry_of_message_id`). |
| ASK-01-C09 | **worker 재확인·멱등:** `ask.answer`는 LLM 호출 전과 결과 쓰기 직전(행 잠금)에 메시지 상태(`stopped`면 쓰지 않음)·Workspace 활성·사용자 멤버십을 다시 확인한다. 재전달·재시도는 이미 끝난 메시지를 다시 부르지 않는다. 첫 delta 뒤 실패는 자동 재시도하지 않고 `failed`(사용자의 `다시 시도`만). 첫 delta 전 실패는 `LLM_MAX_RETRIES`만큼 재시도하고 usage를 누적한다. queue는 `interactive`이며 `document.parse`와 같은 process pool을 쓰지 않는다. |
| ASK-01-C10 | **모의고사 문제 첨부 (ASK-B, ASK-SYNC — 이전 ASK-QM):** 첨부 kind `mock_exam_question`(`ask_conversations`의 첨부는 kind별 FK: 등록 문제 `question_id` + `practice_session_id`, 모의고사 `mock_exam_question_id` + `mock_practice_session_id` — `mock_exam_practice_sessions`). `view: practice`는 그 사용자의 모의고사 practice session이어야 하고(남의 session 404) 공개 수준은 메시지마다 그 session의 `mock_exam_attempts` 유무로 정한다; `view: manage`는 편집 권한·활성 Workspace(보기 권한 403). 문제 내용은 session(또는 `manage`면 지금 active revision)이 고정한 `mock_exam_question_revisions` 행이다. 출처: 원본 문제의 `question_sources`를 쓰지 않고 그 revision의 `evidence`(SourceEvidence 목록) 중 **이 Workspace의 살아 있는 `book` 문서의 현재 발행 revision에 있는 블록만**을 Postgres에서 다시 읽어 넣는다(`evidence.quote` 글은 쓰지 않음; 문제지·가져온 문제 PDF 쪽 근거는 뺌 — `보기 섞기`는 원본의 근거를 그대로 복사하므로). `hint`에서는 `evidence`도 넣지 않는다. 모의고사가 삭제(soft delete)되었거나 문제가 그 모의고사에서 빠졌으면(`removed_at`) 첨부 만들기 404, 기존 대화의 다음 메시지는 문제 context 없음(칩 "더 이상 볼 수 없는 문제"). 공유 세션에는 모의고사가 없으므로(workspace-sharing §9) 해당 없음. ASK.0에서 pytest `red`, ASK-B에서 GREEN. |
| ASK-01-C11 | **결정적 fake (`APP_ENV=test`만):** fake 답변기는 상위 근거 2개의 첫 문장을 `[S1]`·`[S2]`와 함께 정해진 덩어리·간격으로 흘린다. marker: `E2E-ASK-FAIL`(제공자 오류), `E2E-ASK-SLOW`(긴 답·느린 간격), `E2E-ASK-BADCITE`(`[S9]` 포함), `E2E-ASK-NOANSWER`, `E2E-ASK-LEAK-PROBE`(받은 문제 context의 항목 이름·글과 이전 턴 수를 반향), `E2E-ASK-HOLD-<token>`(테스트가 풀 때까지 대기). marker는 production 설정에서 아무 뜻이 없고 test 전용 endpoint는 production build에 없다. fake 호출 수·받은 설정값은 test 전용 기록 디렉터리로 확인한다. |

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다(ASK.0). E2E는 `APP_ENV=test`의 fake만 쓰며, 실제 provider 호출은 없다.
- 정답·해설·책 본문이 보이는 화면의 품질 spec(ASK-X의 A11Y·VISUAL)은 trace·screenshot·video와 실패 시 page text 첨부를 끈다(e2e-strategy §6, `a11y-docsum.spec.ts`와 같음).
- **품질 ID (ASK-X, 2026-11-04):** `A11Y-17`(`quality/a11y-ask.spec.ts`) = 이 화면의 AI 질문 panel — 빈·흐르는 중(`aria-busy`)·완료+각주·출처, 대화 목록, 질문 범위 popover, 첨부 칩(문제 상세 위·모의고사 풀이 위), 실패, 분당 한도, 기능 꺼짐, 휴대폰 sheet, `본문 검색`의 `AI에게 묻기` modal(URL 그대로), 키보드 전용 질문. `A11Y-18`(같은 파일) = [ai-explanations.md](ai-explanations.md)의 AI 해설 영역(만들기·진행·완료·실패)과 [related-sources.md](related-sources.md)의 관련 본문(불러오는 중·목록·없음·오류) — `practice`·`sequence(mock)`·`manage`. `VISUAL-09`(`quality/visual.spec.ts`) = 풀이 panel의 완료된 답 + AI 해설 + 관련 본문 두 위치(답·해설 위, 출처·관련 본문 목록), light/dark × desktop·iPad·375px; 보기(세션마다 순서가 섞임)와 AI 해설 생성 시각은 mask. 이 화면의 AI 질문 panel 자체는 답이 본문에서 나온 글이라 baseline에 넣지 않는다(axe만).
- 단위·통합 테스트는 화면으로 확인하기 어려운 경계(공개 수준·인가·인용 검증·streaming 이어 받기·로그 비노출·한도)를 보완한다.
