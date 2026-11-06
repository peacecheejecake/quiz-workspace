# PDF Knowledge & Question Workspace — Implementation Plan v1.2

**상태:** 확정 기준 설계 (2026-10-16)  
**범위:** 한두 권의 PDF에서 시작하되, Workspace 단위로 확장 가능한 다국어 검색·문제은행·문제 풀이 시스템  
**제외:** 범용 RAG 채팅/질의응답 생성 — 단, Workspace 문서에 근거한 AI 질문(ASK-01)과 제출 후 AI 문제 해설(AIEXPL-01)은 ASK-SPEC(2026-11-01, 사용자 요청)으로 범위에 넣는다(§4 `ask`·`explain`, §6)

## 1. 원칙과 범위

- `core`는 PDF 처리, 구조 분석, 청킹, 다국어 의미·키워드 검색, 재순위화, 원문 발췌, 문제 PDF 구조화, 문제 변형, 품질 평가를 수행하는 재사용 가능한 Python 패키지다.
- 인증은 **독립 구현 트랙**으로 분리하고 Supabase Auth에 위임한다. FastAPI는 JWT 검증과 Workspace 접근 권한을 자체 검증한다. 상세 기준: `docs/auth.md`.
- `service API`는 인증·권한, Workspace, 문서/문제 버전, 풀이·변경 이력, 작업 큐와 스토리지를 관리한다.
- `frontend`는 Workspace 탐색, PDF 보기·텍스트 교정, 검색, 문제 시각화·풀이·출제·검토를 제공한다.
- LLM은 문제 추출/변형에 선택적으로 사용하며, 검색 자체와 선택지 섞기는 LLM 없이 실행된다.
- 문서·문제 텍스트 및 revision은 PostgreSQL을 기준 저장소로 사용한다. PDF와 파싱 산출물은 객체 저장소(개발 시 로컬 파일)에 저장한다. Qdrant는 언제든 재생성 가능한 검색 인덱스다.
- 생성된 문제는 사용자의 검토와 승인 전까지 문제은행에 등록하지 않는다.
- **Screen Specification → 먼저 실패하는 Playwright E2E → API/화면 구현 → 통과 → 리팩터링**을 강제한다. 모든 화면의 AC와 E2E ID는 `docs/screens/`에서 관리한다.
- 프로덕션은 Supabase(Auth/Postgres/Storage), Vercel(Web), Railway 또는 VM(FastAPI/Worker), Qdrant Cloud, Redis의 조합을 기본으로 한다. 상세 기준: `docs/deployment.md`.
- 즐겨찾기 marker는 **고정 크기의 rounded star**, 일반 문제는 rounded-square이며 hover/focus 시 marker만 확대한다.

## 2. 기술 스택

| 계층 | 선택 |
|---|---|
| PDF parser / OCR | Docling, 필요 시 OCR fallback |
| Chunking | Docling HybridChunker + 커스텀 hierarchical parent/child |
| Dense embedding | Qwen3-Embedding-0.6B (성능 평가 후 교체 가능). 실행 위치는 `WORKER_EMBEDDER`로 선택(API·worker 같은 값): `qwen3` = 프로세스 내 CPU(transformers, 로컬·eval·nightly), `workers_ai` = Cloudflare Workers AI `@cf/qwen/qwen3-embedding-0.6b`(1024차원, staging/production; M7.4b). 두 실행 위치의 vector는 섞지 않는다: `model_name`이 달라 Qdrant 물리 collection이 분리되고, 전환은 새 collection 재구축 + alias 전환(`make reindex`) |
| Lexical / sparse search | Qdrant BM25, 다국어 토크나이징 평가 |
| Vector store / fusion | Qdrant, dense + sparse, RRF |
| Reranker | Qwen3-Reranker-0.6B (CPU 지연 측정 후 운영 모드 구성) |
| LLM adapter | 교체 가능한 API provider + structured outputs |
| Core | Python, Pydantic, Typer, pytest, ir-measures |
| API | FastAPI, SQLAlchemy, Supabase PostgreSQL, SQL migration (`supabase/migrations`) |
| Auth | Supabase Auth, Next.js SSR adapter, FastAPI JWT/JWKS verification |
| Async | Celery + Redis; worker와 API가 동일 Core 패키지 사용 |
| File storage | local dev, Supabase private Storage prod (TUS upload) |
| Deployment | Vercel(Web), Supabase(Auth/DB/Storage), Railway/VM(API/Worker), Qdrant Cloud, Redis |
| Frontend | Next.js, React, TypeScript, Radix Primitives, Tailwind CSS + CSS variables |
| QA | Vitest, Storybook, Playwright, axe 접근성 검사 |

## 3. 배포·코드 경계

```text
[Next.js Web @ Vercel] ── REST/SSE with Bearer JWT ── [FastAPI Service @ Railway/VM]
                                   ├── [Supabase PostgreSQL] (metadata, canonical text, revisions, attempts)
                                   ├── [Supabase Storage private] (PDF, parsed artifacts)
                                   ├── [Redis] (async queue) + Supabase Auth (JWT issuer)
                                   └── [Core Python package] ── [Qdrant Cloud]
                                            ▲
                                   [Celery Worker]
```

Core는 별도 HTTP 서버로 분리하지 않는다. Python SDK와 CLI, API/worker 어댑터로 먼저 구현한다. 모델 추론 프로세스 분리는 사용량과 메모리 측정 후 결정한다.

## 4. Core 모듈과 계약

```text
book_core/
  parser/ structure/ chunker/ embedding/ indexing/
  search/ reranker/ extractor/ question/
  generation/ llm/ evaluation/
  export/ summary/ notes/        # DOCSUM-SPEC 2026-10-29
  mock_exam/                     # MOCK-SPEC 2026-11-01
  ask/ explain/                  # ASK-SPEC 2026-11-01
```

핵심 계약:
- `ParsedDocument`: 원본 PDF 경로, parser 버전, 장·절 계층, 텍스트/표/이미지 블록, PDF 페이지·bbox.
- `DocumentRevision`: 교정된 canonical blocks 및 발행 상태.
- `SearchChunk`: stable id, parent/section, canonical content, contextual search text, revision, hash, source location.
- `SearchHit`: 검색모드, 점수 유형, 관련 구절, 문서·장·절·원본 위치.
- `Excerpt`: 원문 문단 경계로 확장된 발췌 + 페이지·원본 좌표.
- `QuestionDraft`: 원문 추출/변형 초안, source evidence, validations, review 상태.
- `export.render_revision(revision, md|txt, *, title)`(`markdown`·`plain` 별칭 허용): 발행·초안 revision의 canonical blocks → Markdown/텍스트(heading 깊이, GFM 표, `[그림 p.N]`, 쪽 marker), 결정적 순수 함수(DOC-03).
- `summary`: 장 입력(정규화 블록 텍스트 + 쪽) → `SummaryUnit{title, summary_md, key_points[{text, pages}]}`(map), 장 unit들 → 문서 요약(reduce); 큰 장 분할·병합, 쪽 범위 검증, 테스트용 결정적 추출 fake(DOCSUM-01).
- `notes`: 장의 확정 문제(`Q1…Qn`: 발문·보기·정답·해설) + 참고 본문 → `ChapterNote{sections[{heading, items[{text, q[tags], p[{block_id, quote, pages}]}]}]}`; 모든 항목 문제 tag 필수, 모르는 tag·인용 불일치 거절(1회 재요청)·tag 없는 항목 제거, 큰 장 묶음 생성·병합(CHNOTE-01).
- `mock_exam`(MOCK-SPEC 2026-11-01, [MOCK-01](screens/mock-exams.md)): 범위 후보(Heatmap 순서의 확정 문제) + 문항 수 + 변형 유형 + seed → `MockExamPlan[{source_question_id, variation_type}]`(결정적 원본 선택·유형 배정), `OPTION_SHUFFLE` 복사본(원본 revision 내용 + seed 보기 순서). LLM 유형은 묶음 생성: `pack_batches(plan, passages, budget)`(token 예산·`sources_per_call` 상한·passage 공유 원본끼리, 결정적) → 묶음 prompt `mock_exam.generate/v1`(원본 `S1…`, 묶음 안에서 한 번만 실린 passage `P1…`, 항목마다 변형 유형 지시) → 항목별로 `generation.validation`의 승인 차단 검증(`accept_for_mock_exam`), 실패 항목 모아 재요청 1회, 해석 불가 묶음은 반으로 나눔. 결정적 fake LLM은 묶음 응답·항목 하나 실패·깨진 묶음·잘린 응답 시나리오와 호출 수 기록을 지원한다.

- `ask`: 질문 + 근거(`S1…Sn`: 고정된 발행 블록 발췌) + 첨부 문제(공개 수준 `none|hint|full`에 맞는 필드만 받는 타입) + 직전 턴 → `LLMRequest`(지시: 근거만, `[S#]` 인용, `[NO_ANSWER]`, `hint`면 정답 비공개 지시); 끝난 답의 인용 검증(모르는 tag 제거·번호 다시 매김·`uncited`), 테스트용 결정적 streaming fake와 marker(ASK-01).
- `explain`: 고정된 문제 revision(발문·보기·정답·허용 답안·채점 기준·출처 블록) + 근거 → `AIExplanation{correct_option_ids, summary_md, options[{option_id, why_md}], concepts_md}`; 정답 불일치 거절, 모든 보기 한 번씩 확인(1회 재요청), 인용 검증은 `ask`와 공용(AIEXPL-01).
- `llm`: 기존 `complete`(structured output)에 더해 text streaming(`stream_text` — delta iterator + 끝난 뒤 usage·stop reason; Anthropic Messages streaming과 fake). 메시지 원문은 예외·로그에 넣지 않는 기존 규칙 그대로.

CLI: `core parse`, `core chunk`, `core index`, `core search`, `core excerpt`, `core questions extract`, `core questions generate`, `core eval`.

### 색인 흐름
1. 원본 PDF 업로드(원본 immutable, sha256 저장).
2. Docling 파싱 → `parsed_document.json` 생성 및 저장.
3. 장·절 계층 복원, 사용자가 수정할 canonical text blocks 생성. 장·절은 heading 번호 체계(`제1장`·`제1절`·`1.`·`1-1.`·`가.` …)로 복원하고, 인쇄된 목차는 front matter로 빼서 교차 확인에만 쓴다. 장 표지가 본문 text나 그림 영역으로 인식돼도 `제N장` label은 장 heading으로 살리고, 같은 번호의 반복(thumb index·running header)은 무시한다(CHAPTER-FIX).
4. 장·절 중심 청킹, block/page provenance 연결.
5. dense + sparse 인덱스 작성, Qdrant에 workspace/document/revision payload 부여.
6. 색인 완료 시 active revision 전환. 실패 시 이전 정상 인덱스 유지.
7. 텍스트 수정 시 신규 revision 발행; 영향받은 chunk 및 부모 문맥을 고려하여 재색인.

### 검색 흐름
- Query: `keyword | semantic | hybrid`; workspace/document/chapter/language filters.
- 기본 후보: dense 30, BM25 30 → RRF → 상위 20 rerank → 결과 10개(평가로 변경).
- `ExcerptResolver`: chunk와 별개로 문단 경계를 기준으로 전후 문맥을 복원하고 source bbox·page 제공.
- KO→KO, KO→EN, EN→KO, EN→EN 별도 평가. 초기에는 강제 번역 없이 multilingual embedding; 필요하면 query translation 후속.
- **AI 질문·AI 해설의 근거 검색(ASK-SPEC):** 같은 파이프라인을 API 안에서 부른다(`quiz_api.ask_retrieval`). 범위는 서버가 정한 Workspace의 살아 있는 `book` 문서의 현재 발행 revision만이고, `question_paper`는 항상 빼며(UX7-SEARCH-2), `mixed` 문서는 문제 추출 구간 블록을 버리고(DOCSUM과 같은 구간), 문서 요약·정리 노트·AI 해설은 근거가 아니다. 결과는 참조만 고정(문서·revision·chunk·block ids·쪽·점수)하고 본문은 worker가 Postgres에서 다시 읽는다. reranker 점수 하한 아래는 버리고, 남은 근거가 없으면 LLM을 부르지 않는다.
- PDF text edit 후 stale revision이 검색 결과로 노출되지 않도록 published-revision 필터를 서버에서 강제한다.
- Dense 불가 시 저하(M7.4b, SEARCH-01-AC06): query embedding이 `EmbeddingUnavailableError`(hosted embedder 429·5xx·timeout·quota)로 실패하면 `hybrid`/`semantic` 검색은 503 대신 BM25 후보만으로 결과를 내고 응답에 `degraded: ["dense_unavailable"]`을 담는다. UI는 비차단 안내를 표시하고 서버는 검색어 없이 WARNING만 남긴다. Qdrant 장애는 계속 503.
- 색인 쪽(worker)은 저하하지 않는다: 한 chunk라도 embedding이 실패하면 revision을 발행하지 않고(이전 published revision 유지) job을 재시도 가능한 오류(`embedding_quota_exceeded` / `embedding_unavailable`)로 backoff 재시도한다. 이미 쓴 point는 재시도 때 재사용되며, 모든 child chunk가 embedding된 뒤에만 READY.

## 5. Workspace/Document/Question 도메인

```text
workspace
 ├── document ── document_revision ── content_block
 │              ├── chapter/section tree
 │              ├── document_summary_run ── document_summary_unit (발행 revision 요약, DOCSUM)
 │              └── chapter_note (장 정리 노트 버전, CHNOTE)
 ├── question ── question_revision
 │             ├── question_source
 │             ├── question_user_state  (user별 학습 상태·플래그)
 │             ├── question_attempt     (채점 이력)
 │             ├── question_lineage     (변형 관계)
 │             ├── question_ai_explanation (revision별 공유 AI 해설, AIEXPL)
 │             ├── question_related_sources (revision·교재 fingerprint별 공유 관련 본문, RELSRC)
 │             └── question_chapter_change (챕터 변경 이력, UX9 챕터 재분배)
 ├── question_draft ── generation_run(QGEN, MOCK-SPEC부터 새 행 없음) / pdf_import_run
 ├── mock_exam ── mock_exam_revision (이름·설정·범위 이력)
 │             └── mock_exam_generation (회차) ── mock_exam_question ── mock_exam_question_revision
 │                                                              ├── mock_exam_practice_session
 │                                                              └── mock_exam_attempt (모의고사 풀이, Heatmap과 무관)
 ├── practice_run (사용자별 범위 풀이 묶음, bank|mock; QVIEW)
 ├── user_highlight (사용자별 하이라이트: 노트 버전·문제 해설·AI 해설; UX9, Fork 제외, 공유는 Owner가 켠 링크의 Owner 것만 읽기, UX12-SHARE)
 ├── ask_conversation ── ask_message ── ask_message_source (사용자별, ASK)
 ├── llm_feature_usage (ASK·AIEXPL 호출 usage, 내용 없음)
 ├── activity_event
 └── async_job
```

정규화된 구조 및 핵심 제약:
- `profiles(user_id FK auth.users, display_name, created_at)`, `workspace_memberships(workspace_id, user_id, role, created_at)`; MVP는 owner 1인이고 다인 공유는 후속이지만 권한 모델은 미리 정의한다.
- `workspaces(id, name, owner_id, status, archived_at, deleted_at)`.
- `documents(id, workspace_id, type, storage_key, checksum)` — `document_type`(`book` | `question_paper`: 본문 여부), `type_source`(`user` | `auto`), `content_kind`(`book` | `question_paper` | `mixed`, 자동 분류 또는 사람이 고른 종류; null = 미분류), `detection`(분류 수치, UX6-UPLOAD); `document_uploads.auto_classify`; `document_revisions`; `chapters(parent_id)`(문제의 챕터는 교재 장 또는 문제지 level-1 장 — CHAP-MATCH, questions.md §14.4); `content_blocks(source_location)`.
- `questions(id, workspace_id, chapter_id, question_type, active_revision_id, publication_status)` — UX9-SPEC(2026-11-02) additive: `chapter_source manual|auto`(not null, backfill — questions.md §14.1), `chapter_set_by`, `chapter_set_at`. 챕터는 revision이 아니라 문제 행의 속성이라 바꿔도 새 revision이 없다.
- `question_chapter_changes(id, workspace_id, question_id FK on delete cascade, from_chapter_id, to_chapter_id, source manual|recommendation|edit|import, changed_by, changed_at)` (UX9, [CHREDIST-01](screens/chapter-redistribution.md)) — append-only(update·delete trigger 거절), quiz_api는 insert·select만.
- `question_revisions(id, question_id, version, stem, options, correct_answer, explanation, rubric)`.
- `question_sources(question_id, document_id, document_revision_id, page_range, block_ids)`.
- `question_user_states(user_id, question_id, first_viewed_at, last_viewed_at, last_graded_result, last_graded_attempt_id, is_favorite, needs_retry, updated_at)` with `(user_id, question_id)` unique.
- `question_attempts(id, question_id, question_revision_id, user_id, displayed_option_ids, submitted_answer, result, grading_method, submitted_at, graded_at)`.
- `question_lineage(parent_question_id, child_question_id, variation_type, source_revision_id)`.
- `question_generation_runs` / `question_import_runs`; `question_drafts` (approval 전 격리); `question_import_registration_items` (서버 측 등록 job의 항목·진행, QIMP-JOB).
- `question_merges(id, workspace_id, duplicate_question_id, kept_question_id, created_by, created_at, ended_at, ended_by, end_reason)` (UX7-DEDUP, questions.md §10): 보관된 중복 → 남길 문제 연결의 이력. 연결 중(`ended_at is null`)인 행은 중복마다 하나(partial unique), 한 단계만(남길 문제는 연결 중인 중복이 아니고 중복은 연결 중인 남길 문제가 아님 — trigger), 중복을 보관 해제하면 trigger가 끝낸다(`end_reason = unarchived`), 옮김은 끝내고 새 행(`repointed`). quiz_api는 insert와 `ended_*` 열 update만. view `question_merged_user_states`(security_invoker): 사용자·남길 문제별로 자신과 연결 중인 중복의 `question_user_states`를 합친 상태(최초·최근 열람, 마지막 채점 결과(`graded_at` 최신), 즐겨찾기·다시 풀기 합집합). attempt·session은 그대로다.
- `activity_events` (변경 감사), `async_jobs` (재시도/상태).
- **문서 요약 (DOCSUM-SPEC 2026-10-29, [DOCSUM-01](screens/documents-summary.md)):** `documents.summary_enabled_at`·`summary_enabled_by`(opt-in·자동 갱신 켜짐; `요약 만들기`에서 기록, 켜져 있는 동안 모든 발행에서 자동 재생성; null = 꺼짐), `summary_disabled_at`·`summary_disabled_by`(마지막 `자동 갱신 끄기`).
  - `document_summary_runs(id, workspace_id, document_id, document_revision_id, status queued|running|succeeded|failed|superseded, trigger manual|publish|retry, job_id, prompt_version, model, error_code, usage jsonb(tokens·cost_usd·reused_units·generated_units), progress jsonb(chapters_done·chapters_total), created_by, created_at, started_at, finished_at)` — revision마다 살아 있는 run 하나(partial unique; `retry`는 같은 revision의 새 run, 이전 실패 run은 남김). 더 새 revision의 run이 생기면 이전 대기·실행 run은 `superseded`.
  - `document_summary_units(id, workspace_id, document_id, scope chapter|document, section_key, input_hash, prompt_version, model, body jsonb{title, summary_md, key_points[{text, pages}]}, page_from, page_to, usage, created_at)` unique `(document_id, scope, section_key, input_hash, prompt_version, model)` — 내용 주소 방식이라 바뀌지 않은 장은 재사용(문서 범위 밖 공유 없음). `document_summary_run_units(run_id, unit_id, position)`가 run의 장 순서·문서 요약 unit을 묶는다.
  - 시작: 발행 트랜잭션의 SECURITY DEFINER `public.worker_start_document_summary(document_id, revision_id, publisher_user_id, enabled)`(run·job은 발행한 사용자에게 귀속)(QIMP-AUTO의 `worker_start_question_import`와 같은 follow-up 방식) 또는 `POST /documents/{id}/summary`. 문서·요약 본문은 로그·job 결과·활동 기록에 넣지 않는다.
- **챕터 정리 노트 (CHNOTE, [CHNOTE-01](screens/chapter-notes.md)):** `chapter_notes(id, workspace_id, document_id, section_key, version, status queued|running|succeeded|failed, job_id, input_fingerprint, question_refs jsonb[{tag, question_id, question_revision_id, number_label}], body jsonb{sections[...]}, dropped_items, prompt_version, model, error_code, usage, created_by, created_at, finished_at, superseded_at)` unique `(document_id, section_key, version)`, 장마다 대기·실행 중 하나(partial unique). 장은 revision이 바뀌어도 같은 `section_key`로 이어진다(`documents_remap_question_chapters`와 같은 규칙). stale은 읽을 때 현재 확정 문제 fingerprint와 비교해 계산한다. 이전 버전은 지우지 않는다.
- **AI 질문 (ASK-SPEC 2026-11-01 사용자 결정, ASK-SYNC 2026-11-02, [ASK-01](screens/ask-llm.md)):**
  - `ask_conversations(id, workspace_id, user_id, title, scope jsonb{document_ids, chapter_ids}, attachment_kind null|question|mock_exam_question, attachment_question_id, attachment_question_revision_id, attachment_mock_question_id, attachment_practice_session_id, attachment_mock_practice_session_id, attachment_view practice|detail|manage, attachment_removed_at, created_at, last_message_at)` — 주인만 읽음(RLS·API), Workspace 삭제 시 cascade. 첨부는 kind별로 한쪽만 채운다(check): 등록 문제 `attachment_question_id` → `questions`, `attachment_practice_session_id` → `practice_sessions`(범위 풀이 묶음의 session 포함); 모의고사 문제 `attachment_mock_question_id` → `mock_exam_questions`, `attachment_mock_practice_session_id` → `mock_exam_practice_sessions`(ASK-01-C10). 첨부한 문제·session이 지워지면 FK는 `set null`이고 다음 메시지부터 문제 context가 없다.
  - `ask_messages(id, conversation_id, workspace_id, user_id, position, role user|assistant, status queued|streaming|succeeded|failed|stopped|no_sources, content, disclosure none|hint|full, scope jsonb, reply_to_message_id, retry_of_message_id, regenerated_from_message_id, job_id, prompt_version, model, error_code, dropped_citations, uncited, truncated, usage jsonb, created_at, finished_at)` — 끝난 행은 append-only trigger로 고정, 사용자마다 대기·실행 답 하나(partial unique).
  - `ask_message_sources(message_id, tag, rank, document_id, document_revision_id, chapter_id, block_ids, page_from, page_to, chunk_id, score, cited, citation_number)` — 본문 복사 없음.
  - `ask_message_feedback(message_id, user_id, rating, reason_code, created_at)` — 자유 글 없음.
- **AI 문제 해설 ([AIEXPL-01](screens/ai-explanations.md)):** `question_ai_explanations(id, workspace_id, question_id, question_revision_id, version, status queued|running|succeeded|failed, job_id, prompt_version, model, body jsonb{correct_option_ids, summary_md, options, concepts_md}, sources jsonb[{tag, document_id, document_revision_id, block_ids, pages}], error_code, usage, created_by, created_at, finished_at, superseded_at)`; 대기·실행·성공(미대체) 행은 `(question_revision_id, prompt_version, model)`마다 하나(partial unique) — 동시 요청은 같은 행을 받는다. 모의고사 문제는 같은 모양의 `mock_exam_question_ai_explanations(…, mock_exam_question_id, mock_exam_question_revision_id, …)`(키 `(mock_exam_question_revision_id, prompt_version, model)`, FK는 `mock_exam_question_revisions`에 cascade; 등록 문제 해설과 행을 공유하지 않음 — AIEXPL-01-C09).
- **관련 본문 ([RELSRC-01](screens/related-sources.md)):** `question_related_sources(id, workspace_id, question_id, question_revision_id, corpus_fingerprint, retrieval_version, items jsonb[{position, document_id, document_revision_id, chapter_id, block_ids, pages, score, from_question_source}], created_by, created_at, superseded_at)` unique `(question_revision_id, corpus_fingerprint, retrieval_version)`. `corpus_fingerprint` = Workspace의 살아 있는 `book` 문서의 정렬된 `(document_id, active published revision id)` + embedding model + chunk 설정 버전의 SHA-256(발행·복원·교재 추가/삭제·embedder 전환이 키를 바꿈). LLM 없이 API 요청 안에서 계산(advisory xact lock + 재확인), 본문 복사 없음, 보관 Workspace·검색 저하 결과는 저장하지 않음, Fork는 복제하지 않음(다시 계산). 모의고사 문제는 같은 모양의 `mock_exam_question_related_sources`(unique `(mock_exam_question_revision_id, corpus_fingerprint, retrieval_version)`; 1단계 출처는 그 revision의 `evidence` 중 현재 발행 `book` 블록 — RELSRC-01-C07).
- **usage:** `llm_feature_usage(id, feature ask|ai_explanation, workspace_id, user_id, ref_id(set null on delete), model, input/output/cache tokens, cost_usd, status, created_at)` — 하루·월 한도 집계와 비용 기록, 내용 없음, 13개월 보존(`ask.purge`).
- Fork는 snapshot revision의 성공한 요약(run·unit·`summary_enabled_at`)과 장마다 최신 성공 정리 노트 중 snapshot 기준 출처 일치(인용 문제가 모두 CONFIRMED이고 active revision = 고정 revision)인 것(`question_refs` 재매핑)을 새 id로 복제한다. 공유 노트 API도 같은 출처 일치 조건을 쓴다. 실패·이전 기록과 usage는 복제하지 않는다.
- **모의고사 (MOCK-SPEC 2026-11-01, [MOCK-01](screens/mock-exams.md)):** 은행과 분리된 테이블이다 — 모의고사 문제는 `questions`·`question_drafts`·`question_lineage`·`question_attempts`·`question_user_states`에 들어가지 않는다(questions.md §11, 사용자 결정 2).
  - `mock_exams(id, workspace_id, title, config jsonb{variation_types[], question_count, difficulty}, range jsonb{all, chapter_ids[], question_ids[], excluded_question_ids[], filters}, current_generation_id, created_by, created_at, updated_at, deleted_at, deleted_by)` — soft delete.
  - `mock_exam_revisions(id, mock_exam_id, workspace_id, version, title, config, range, edited_by, created_at)` unique `(mock_exam_id, version)` — 만들기·이름·설정 변경마다 한 행(append-only).
  - `mock_exam_generations(id, mock_exam_id, workspace_id, version, status queued|running|succeeded|partial|failed|cancelled, job_id, config, range_resolved jsonb[{question_id, question_revision_id}], plan jsonb[{question_id, question_revision_id, variation_type}], seed, prompt_version, model, created_count, skipped_count, error_code, usage jsonb, progress jsonb{done,total}, created_by, created_at, started_at, finished_at)` unique `(mock_exam_id, version)`, 모의고사마다 대기·실행 중 하나(partial unique). 성공·부분 성공이면 같은 트랜잭션에서 `mock_exams.current_generation_id`를 바꾼다(실패면 그대로).
  - `mock_exam_generation_items(generation_id, position, source_question_id, source_question_revision_id, variation_type, batch_no, status pending|done|failed|retried|skipped, skip_reason, mock_exam_question_id)` — 묶음별 checkpoint(묶음 하나가 끝날 때 한 트랜잭션으로 갱신; 재실행은 `pending`만 다시 묶음). 회차에는 `llm_calls`·`batches_total`·`batches_done`도 기록한다.
  - `mock_exam_questions(id, workspace_id, mock_exam_id, generation_id, position, question_type, active_revision_id, source_question_id, source_question_revision_id, variation_type, removed_at, removed_by, created_at)` — 원본 FK는 `on delete set null`(원본 삭제 후에도 풀 수 있음).
  - `mock_exam_question_revisions(id, mock_exam_question_id, workspace_id, version, stem, options, correct_answer, explanation, rubric, evidence jsonb, validation_issues jsonb, origin generated|edited, edited_by, created_at)` — append-only, 정답은 stable option ID.
  - `mock_exam_practice_sessions` / `mock_exam_attempts` — `practice_sessions`/`question_attempts`와 같은 모양·제약(표시 option ID, `pending` 자기평가 연결, immutable; FK는 `mock_exam_question_revisions`), `practice_run_id` 포함.
- **범위 풀이 묶음 (QVIEW, [QVIEW-01](screens/question-viewer.md)):** `practice_runs(id, workspace_id, user_id, source bank|mock, mock_exam_id, mock_exam_generation_id, range jsonb, random_order, seed, item_ids uuid[](순서 고정, 최대 5,000), created_at, finished_at)` — 만든 사용자만 읽음. 결과 집계는 세션 테이블의 `(practice_run_id, run_position)` index로 계산하고, 문제 내용은 위치별로만 읽는다. 기존 `practice_sessions`에 nullable `practice_run_id`·`run_position`을 더한다(additive). 문제마다 세션은 묶음 안에서 하나(partial unique `(practice_run_id, run_position)`).
- **QGEN 폐지 (MOCK-SPEC, QGEN-RM 2026-11-02):** `question_generation_runs`·생성 초안·`question_lineage`의 기존 행은 보존하고 drop하지 않는다(additive-first). 새 생성 run은 만들어지지 않는다(router 404, worker에 `question.generate` 등록 없음; 대기열에 남은 `question.generate` job은 reconciler가 `failed`/`job_retired`로 끝낸다). 실행되지 않던 코드는 UX8-QGEN-DEAD(2026-11-02)에서 지웠다: worker `question_generation_job`·`question_generation_store`(원본 row type은 `quiz_worker.question_sources`로 이동), API `question_generation_review`·`repositories/question_generations`, 설정 `QUESTION_GENERATION_BATCH_RATE_LIMIT_PER_MINUTE`. `PATCH /question-drafts/{id}`는 import 초안만 받는다 — 생성 초안 id는 404(authz binding이 `source_type = import`만 보임).
- **하이라이트 (UX9-SPEC 2026-11-02, [HILITE-01](screens/highlights.md), questions.md §15):** `user_highlights(id, workspace_id, user_id, target_kind note|explanation|ai_explanation, chapter_note_id FK chapter_notes on delete cascade, question_id FK questions on delete cascade, question_revision_id FK question_revisions, ai_explanation_id (AIEXPL-01의 `question_ai_explanations` FK — 그 테이블이 생기는 migration에서 FK 추가, 그 전에는 `ai_explanation` 행을 받지 않는 check), anchor jsonb{block, start, end}, quote text(≤ 2,000), prefix, suffix(≤ 32), color yellow|blue|pink, version int(낙관적 잠금), created_at, updated_at, deleted_at)`. check: 대상 열은 `target_kind`에 맞는 것 하나만(`explanation`은 `question_id`+`question_revision_id`). index `(user_id, chapter_note_id) where deleted_at is null`, `(user_id, question_id) where deleted_at is null`, `(workspace_id, user_id)`. RLS 켬, 브라우저 role 권한 없음, quiz_api는 select·insert·update(`color`·`version`·`deleted_at`·`updated_at`)만 — 모든 query는 JWT `sub`의 `user_id`로 거른다. 장 정리는 읽을 때 계산한다(노트 → `(document_id, section_key)`, 해설 → 문제의 지금 `chapter_id`). Fork(`worker_fork_commit`)는 이 테이블을 복사하지 않고 공유 API는 읽지 않는다. 사용자·대상당 살아 있는 행 500개 제한은 API가 대상 행 FOR UPDATE 아래에서 센다.

문제 상태는 독립 필드를 합성해 계산한다. 색상 규칙·열람 판정·변형 정책은 `docs/questions.md`가 단일 기준이다.

## 6. Service API v1.2

인증 요청(로그인, 가입, 확인 메일, 재설정, 세션 refresh)은 Supabase Auth를 직접 사용한다. FastAPI는 자체 비밀번호 DB나 로그인 처리 API를 만들지 않으며, `Authorization: Bearer <Supabase access token>`을 검증한다. 사용자 식별은 JWT `sub`, Workspace 권한은 DB 멤버십을 기준으로 한다. `GET /api/v1/me`는 FastAPI 인증 통합 검증용이다. 인증 화면/세부 보안정책: `docs/auth.md`.


| Method | Endpoint | 목적 |
|---|---|---|
| POST/GET | `/api/v1/workspaces` | 생성, 목록 |
| PATCH/DELETE | `/api/v1/workspaces/{id}` | 수정, 삭제 요청 |
| POST | `/api/v1/workspaces/{id}/archive` | 보관 |
| POST | `/api/v1/workspaces/{id}/restore` | 복원 |
| POST | `/api/v1/workspaces/{id}/documents` | PDF 업로드/파싱 작업 |
| POST | `/api/v1/workspaces/{id}/documents/upload-intent` | 업로드 의도(PDF마다 하나; `document_type = auto`면 서버가 교재·문제지·교재+문제로 자동 분류, UX6-UPLOAD) |
| GET | `/api/v1/workspaces/{id}/documents` | 모든 PDF 목록(`kind`·`kind_source`·`question_count`·`latest_import_id`·처리 작업) |
| PATCH | `/api/v1/documents/{id}` | `종류 변경`(`kind`, 사람이 고른 종류는 재분류 안 함; 쓰이는 교재 → 문제지는 409 `document-in-use`; 문제 있는 종류면 추출 시작, UX6-UPLOAD) |
| GET | `/api/v1/documents/{id}/outline` | 장·절 트리 |
| GET | `/api/v1/documents/{id}/text` | 전문 텍스트 내보내기(`format=md\|txt` — 별칭 `markdown\|plain` 허용, `revision=published\|draft\|<revision id>` — draft·초안 id는 편집 권한, 이전 발행본 id는 모든 구성원(DOC-02가 보이는 revision의 `전체 복사`); attachment·no-store; 공유 게스트 불가, DOC-03) |
| GET | `/api/v1/documents/{id}/summary` | 문서 요약(`available`·`enabled`·현재 run 상태·진행, 마지막 성공 요약 + `stale`, 장별 요약; DOCSUM-01) |
| POST | `/api/v1/documents/{id}/summary` | `요약 만들기`(opt-in + 현재 발행 revision run, 편집 권한, `Idempotency-Key`; 문제지 409 `summary-not-applicable`, 꺼짐 409 `summary-disabled`) |
| POST | `/api/v1/documents/{id}/summary/retry` | 실패한 현재 revision 요약 다시 시도(편집 권한) |
| DELETE | `/api/v1/documents/{id}/summary/auto` | 자동 갱신 끄기(편집 권한, 멱등 204; 이후 발행은 run·LLM 호출 없음, 기존 요약 유지; 다시 켜기는 `POST /summary`) |
| GET/PATCH | `/api/v1/documents/{id}/blocks/{blockId}` | 블록 읽기·교정 |
| POST | `/api/v1/documents/{id}/publish` | 교정본 발행·색인 |
| POST | `/api/v1/workspaces/{id}/search` | 다국어 문서·문제 검색 |
| GET | `/api/v1/workspaces/{id}/questions/overview` | heatmap 목록/집계/상태 |
| POST/GET | `/api/v1/workspaces/{id}/questions` | 문제 등록·조회 |
| GET/PATCH | `/api/v1/questions/{id}` | 문제 상세·편집 |
| PATCH | `/api/v1/questions/{id}/my-state` | 즐겨찾기·다시 풀기 토글 |
| POST | `/api/v1/questions/{id}/practice-open` | 풀이 panel 열기: 최신 결과 확인 후 캐시 session 재사용·결과·새 session을 한 트랜잭션으로(UX12-OPEN, 미제출 응답 정답 비노출) |
| POST | `/api/v1/questions/{id}/practice-sessions` | 문제 열람·보기 순서 생성(정답 비노출), 범위 풀이 위치 |
| POST | `/api/v1/practice-sessions/{id}/submit` | 답변 제출·채점 |
| POST | `/api/v1/practice-sessions/{id}/self-grade` | 주관식·서술형 자기평가 |
| GET | `/api/v1/questions/{id}/attempts` | 풀이 이력(합쳐진 중복의 attempt 포함, 항목별 `question_id`, UX7-DEDUP) |
| GET | `/api/v1/workspaces/{id}/question-duplicates` | 중복 확정 문제 묶음(편집 권한, 정답 없음; UX7-DEDUP) |
| POST | `/api/v1/workspaces/{id}/question-duplicates/merge` | 묶음마다 남길 문제 하나, 나머지 보관 + 기록 합침(편집 권한, 멱등; UX7-DEDUP) |
| POST | `/api/v1/questions/{id}/generations` | 변형 문제 생성 작업 (**폐지** — QGEN-RM 2026-11-02, 404) |
| GET | `/api/v1/question-generations/{id}/drafts` | 생성 문제 검토 (폐지 — QGEN-RM, 404) |
| POST | `/api/v1/question-generations/{id}/publish` | 승인한 문제만 등록 (폐지 — QGEN-RM, 404) |
| POST | `/api/v1/workspaces/{id}/question-generation-batches` | 여러 문제·임의 선택 묶음 변형 출제(원본마다 `question.generate` run; QGEN-MULTI) (폐지 — QGEN-RM, 404) |
| GET | `/api/v1/workspaces/{id}/question-generation-batches/{batch_id}` | 묶음의 원본별 run·진행 상태 (폐지 — QGEN-RM, 404) |
| POST | `/api/v1/workspaces/{id}/question-imports` | 문제 PDF 가져오기(준비 완료된 모든 PDF, UX6-UPLOAD) |
| GET | `/api/v1/question-imports/{id}/drafts` | 가져온 문제 검토(초안별 등록 챕터 추천·선택, 교재 챕터 목록 — CHAPTER-MAP; `offset`/`limit`(≤200)이면 한 페이지와 `total`, `include_chapters=false`이면 챕터 목록 생략 — QIMP-PAGING) |
| GET | `/api/v1/question-imports/{id}/draft-summaries` | 모든 초안의 요약(본문·보기·정답·해설 없음: id·version·순서·번호·유형·검토 상태·등록 여부·승인 가능·정답 없음·검증 코드·등록 챕터 id·중복 `duplicate_of`(UX7-DEDUP))과 교재 챕터 목록 — 검토 화면의 선택·개수·등록용(QIMP-PAGING) |
| POST | `/api/v1/question-imports/{id}/re-extract` | `다시 추출`(UX12-REEXTRACT): 같은 revision에 새 run과 새 초안, 저장된 파싱 결과 재사용, 등록된 문제 불변, `Idempotency-Key`, 문서당 진행 중 run 하나(409 `import-running`) |
| POST | `/api/v1/question-imports/{id}/publish` | 승인한 문제만 등록(`approve: true`면 선택한 초안을 승인과 함께 등록, 거절 목록 반환) |
| POST | `/api/v1/question-imports/{id}/registrations` | 선택한 초안 전체를 서버에서 승인·등록(`question.import_register` job, QIMP-JOB) |
| GET | `/api/v1/question-imports/{id}/registrations/{registration_id}` | 서버 측 등록 진행(처리/전체)·거절 목록 |
| GET | `/api/v1/workspaces/{id}/chapter-notes` | 장별 최신 정리 노트 상태(진행·stale·버전 수; Heatmap header 표시, CHNOTE-01) |
| GET | `/api/v1/chapters/{chapterId}/note` | 장 정리 노트(`version=` 이전 버전, `question_refs` 각주, `stale`) |
| POST | `/api/v1/chapters/{chapterId}/note` | 정리 노트 만들기·다시 만들기(새 버전, 편집 권한, `Idempotency-Key`; 확정 문제 없음 409 `no-chapter-questions`, 진행 중 409 `note-generation-running`, 꺼짐 409 `note-generation-disabled`) |
| GET | `/api/v1/workspaces/{id}/chapter-redistribution/questions` | 챕터 재분배 목록: 장 그룹별 살아 있는 확정 문제(번호·발문 앞 40자·유형·`chapter_source`, 정답 없음)와 옮길 수 있는 장 목록(편집 권한, 활성 Workspace; CHREDIST-01) |
| POST | `/api/v1/workspaces/{id}/chapter-redistribution/preview` | 추천 다시 계산(읽기 전용: `question_ids`\|`all`, `include_manual`; 바뀔 문제만 `현재 → 추천`과 개수; CHREDIST-01-C05·C06) |
| POST | `/api/v1/workspaces/{id}/questions/chapter-assignments` | 여러 문제의 챕터를 한 번에 바꿈(`source manual\|recommendation`, 항목마다 `expected_chapter_id`, ≤ 5,000, 원자적, `Idempotency-Key`; 409 `chapter-changed`·`question-not-confirmed`, 422 `chapter-invalid`; CHREDIST-01-C02) |
| GET | `/api/v1/questions/{id}/preview` | 정리 노트 각주 미리보기(발문·보기만 — 정답·해설·채점 기준 없음, 열람 기록 없음; CHNOTE-02-C01). 공유: `/api/v1/shared/{shareId}/questions/{questionId}/preview` |
| GET | `/api/v1/chapters/{chapterId}/my-highlights` | 그 장의 내 하이라이트(모든 노트 버전 + 지금 그 장 확정 문제의 해설·AI 해설, 다시 찾은 위치; HILITE-01-C06). "챕터 없음"은 `GET /api/v1/workspaces/{id}/my-highlights?chapter=none` |
| GET | `/api/v1/questions/{id}/my-highlights` | 그 문제 해설(·AI 해설)의 내 하이라이트(모든 구성원 — `GET /questions/{id}`와 같은 권한; practice 응답에는 없음) |
| POST | `/api/v1/my-highlights` | 하이라이트 만들기(대상·`anchor`·색, 겹친 것 `replace_ids` 원자적 교체, 서버가 quote를 자름; 보관 Workspace에서도 허용 — 하이라이트만의 예외; HILITE-01-C01·C03·C04) |
| POST | `/api/v1/my-highlights/{id}/restore` | 지운 지 10분 안의 자기 하이라이트 되살리기(같은 id·anchor·색; 겹침 409 `highlight-overlap`; `되돌리기` 알림, HILITE-01) |
| PATCH/DELETE | `/api/v1/my-highlights/{id}` | 색 바꾸기(`version` 낙관적 잠금) · 지우기(멱등). 다른 사용자의 id는 404 |
| GET | `/api/v1/workspaces/{id}/mock-exams` | 모의고사 목록(이름·상태·문제 수·설정 요약·현재 회차 진행; MOCK-01) |
| POST | `/api/v1/workspaces/{id}/mock-exams` | 모의고사 만들기(이름·`config`·`range`, 첫 회차 생성 시작, 편집 권한, `Idempotency-Key`; 범위 0개 409 `no-matching-questions`, 진행 한도 409 `generation-busy`, 429) |
| GET/PATCH/DELETE | `/api/v1/mock-exams/{id}` | 상세(설정·회차 상태·진행) · 이름/설정 변경(`mock_exam_revisions`) · soft delete(생성 중이면 job 취소) |
| POST | `/api/v1/mock-exams/{id}/generations` | 다시 만들기·다시 시도(새 회차, 편집 권한, `Idempotency-Key`; 진행 중 409 `mock-generation-running`; LLM 꺼짐에서 LLM 유형 409 `mock-llm-disabled`) |
| GET | `/api/v1/mock-exams/{id}/questions` | 현재 회차 문제 목록(번호·발문 앞부분·유형·변형 유형·출처 번호; 편집 권한자의 `include=answers`만 정답·해설·검증 경고) |
| PATCH/DELETE | `/api/v1/mock-exam-questions/{id}` | 문제 편집(새 revision, `version` 낙관적 잠금) · 모의고사에서 빼기(`removed_at`) |
| POST | `/api/v1/mock-exam-questions/{id}/practice-sessions` | 모의고사 문제 열기·보기 순서(정답 비노출) |
| POST | `/api/v1/mock-practice-sessions/{id}/submit` · `/self-grade` | 모의고사 문제 제출·채점·자기평가(`mock_exam_attempts`만 기록) |
| POST | `/api/v1/workspaces/{id}/practice-runs` | 범위 풀이 묶음 만들기(`source bank\|mock`, `range`, `random_order`, `seed`; 서버가 범위 확정, 최대 5,000; QVIEW-01) |
| GET | `/api/v1/practice-runs/{id}` · `/items/{position}` · `/results` | 묶음 진행·결과 집계(내용 없음) · 위치의 문제 하나(정답 비노출, 이미 제출했으면 그 결과·정답·해설) · 결과 목록 페이지(`offset`/`limit` ≤200) |
| POST | `/api/v1/practice-runs/{id}/finish` | 묶음 끝내기(`finished_at`, 요약 고정) |
| GET | `/api/v1/workspaces/{id}/ask` | AI 질문 사용 가능 여부(`available`)·한도·오늘 남은 수(ASK-01) |
| GET/POST | `/api/v1/workspaces/{id}/ask/conversations` | 내 대화 목록 / 새 대화(첨부 문제·범위, 첫 질문) |
| GET/DELETE | `/api/v1/ask/conversations/{id}` | 대화(메시지·인용) / 삭제 — 주인만 |
| DELETE | `/api/v1/ask/conversations/{id}/attachment` | 첨부 문제 빼기 |
| POST | `/api/v1/ask/conversations/{id}/messages` | 질문(`Idempotency-Key`; API가 근거 검색·고정 후 `ask.answer` job, 202 + `stream_url`) |
| GET | `/api/v1/ask/messages/{id}` · `/stream` | 답 상태(polling) · SSE(`delta`·`reset`·`done`·`error`, `Last-Event-ID`) |
| POST | `/api/v1/ask/messages/{id}/cancel` · `/retry` · `/regenerate` | 답변 중지 · 실패·중지 답 다시 시도 · 마지막 답 다시 생성(새 버전, 이전 답 유지, 한도에 셈) |
| PUT | `/api/v1/ask/messages/{id}/feedback` | `도움이 안 됨`(이유 code) |
| GET/POST | `/api/v1/questions/{id}/ai-explanation` | 제출 후 AI 해설 읽기 / 만들기(`practice_session_id` 제출 확인 또는 `view=detail`; 캐시 있으면 생성 없음, AIEXPL-01) |
| POST | `/api/v1/questions/{id}/ai-explanation/regenerate` | 다시 만들기(편집 권한, revision당 하루 3번) |
| GET | `/api/v1/ai-explanations/{id}/stream` | AI 해설 SSE |
| GET | `/api/v1/questions/{id}/related-sources` | 제출 후 관련 본문(`practice_session_id` 제출 확인 또는 `view=detail`; 없으면 API 안에서 검색해 저장, LLM 없음 — RELSRC-01) |
| GET | `/api/v1/questions/{id}/source-region` · `/api/v1/mock-exam-questions/{id}/source-region` | 문제 원문 보기(QSRC-01): 가져오기 출처(`question_sources.import_run_id` 있음) 위치의 문서·쪽·bbox 합집합과 문제 그림 `figures`(UX12-REEXTRACT)만, 정답·글 없음, 구성원 누구나, 없으면 404. PDF는 기존 `GET /documents/{id}/source-url` 중계 |
| GET/POST | `/api/v1/mock-exam-questions/{id}/ai-explanation` · `/ai-explanation/regenerate` · `/related-sources`, GET `/api/v1/mock-ai-explanations/{id}/stream` | 모의고사 문제의 AI 해설·SSE·관련 본문(`mock_practice_session_id` 제출 확인; 삭제된 모의고사·빠진 문제 404; 공유 API 없음 — AIEXPL-01-C09·RELSRC-01-C07, ASK-SYNC) |
| GET | `/api/v1/jobs/{id}` | 비동기 작업 상태 |
| GET | `/api/v1/jobs/{id}/events` | SSE 진행 상황 |
| GET | `/api/v1/workspaces/{id}/activities` | 변경 이력 |

인가·workspace filter를 서버에서 강제한다. 문제 풀이 조회 API는 정답/해설을 제출 전까지 전송하지 않는다. POST 작업에는 멱등 키를 지원한다.

Worker job(DOCSUM-SPEC 2026-10-29): `document.summarize {run_id}` — 문서별 advisory lock, 장 map(입력 hash가 같은 unit 재사용)·문서 reduce, 결과 쓰기 직전 run·현재 발행 revision 재확인(대체되면 쓰지 않음), 결과는 개수·usage·오류 코드(`llm_unavailable`·`llm_timeout`·`llm_invalid_output`·`summary_too_large`·`document_unavailable`)만. `chapter_note.generate {note_id}` — 노트 행에 고정된 `question_refs`만 읽고 인용 검증(1회 재요청), 큰 장은 묶음 생성·병합, 결과는 항목 수·버린 항목 수·usage·오류 코드(`note_citation_invalid` 포함)만. 둘 다 `WORKER_DOCUMENT_SUMMARY`·`WORKER_CHAPTER_NOTES`와 LLM 설정(`LLM_API_KEY`·`LLM_MODEL`)이 있을 때만 시작하며, 테스트(`APP_ENV=test`)는 결정적 fake/scenario LLM을 쓴다. 공유 게스트용 읽기 API는 [workspace-sharing.md](workspace-sharing.md) §5·§8.

Worker job(MOCK-SPEC 2026-11-01): `mock_exam.generate {generation_id}` — 모의고사별 advisory lock, 회차에 고정된 `plan`만 읽음(원본 revision 고정), `OPTION_SHUFFLE`은 LLM 없이 복사·섞기, LLM 유형은 기존 `question.generate`의 원본 읽기·근거 passage 검색·근거 좁히기 helper(공용 모듈 `quiz_worker.question_sources`)로 passage를 모은 뒤 `book_core.mock_exam.pack_batches`로 **호출 수가 최소가 되게** 묶어(`MOCK_EXAM_MAX_PROMPT_TOKENS` 기본 60,000·`MOCK_EXAM_MAX_OUTPUT_TOKENS` 기본 16,000·상한 `MOCK_EXAM_SOURCES_PER_CALL` 기본 40) `MOCK_EXAM_GENERATION_CONCURRENCY`(기본 2)개까지 동시에 부르고, 항목별 검증 통과분만 저장, 실패 항목은 모아 재요청 1회, 해석 불가 묶음은 반으로 나눔, 묶음마다 checkpoint(`mock_exam_generation_items`) — 재전달·시간 한도 뒤 재시작해도 끝난 묶음은 다시 부르지 않음, 진행(`progress` 원본 수·묶음 수)과 결과 쓰기 직전 회차·모의고사 상태 재확인(삭제·취소되면 쓰지 않음). 결과는 개수·usage·오류 코드(`llm_unavailable`·`llm_timeout`·`no_valid_questions`·`mock_exam_unavailable`)만. `WORKER_MOCK_EXAMS`와 LLM 설정이 있을 때만 LLM 유형을 시작하며 테스트(`APP_ENV=test`)는 결정적 fake/scenario LLM을 쓴다. `question.generate` job 등록은 QGEN-RM에서 뺀다.
Worker job(ASK-SPEC 2026-11-01): `ask.answer {message_id}`와 `question.ai_explain {explanation_id}`는 **API가 LLM 키를 갖지 않으므로** worker가 LLM을 streaming으로 부른다. 둘 다 새 Celery queue `interactive`(전용 process, `ASK_WORKER_CONCURRENCY`)에서 돌아 `document.parse` 같은 긴 job에 막히지 않는다. job은 고정된 근거 참조로 Postgres 블록을 읽고, LLM 호출 전·결과 쓰기 직전(행 잠금)에 메시지/해설 상태·Workspace 활성·멤버십·근거 revision이 현재 발행본인지 다시 확인한다. 받은 글자는 약 100ms 단위로 Redis Stream `ask:msg:<id>` / `explain:<id>`(TTL 10분, 최대 길이 제한)에 쓰고, API의 SSE endpoint가 연결마다 인가를 다시 확인하고 그 stream을 relay한다(브라우저 → Next.js route handler → FastAPI, token은 header로만). 끝나면 검증된 결과·usage를 Postgres에 쓰고 Redis에는 `done`만 남긴다. job 결과는 개수·usage·오류 코드(`llm_unavailable`·`llm_timeout`·`llm_refused`·`sources_unavailable`·`workspace_unavailable`·`explanation_answer_mismatch`·`ask_failed`)만이고 `ask.answer`는 이력 작업 목록에 나오지 않는다. `ask.purge`(beat 하루 1회)는 보존 기간이 지난 대화와 13개월 넘은 usage를 지운다. 둘 다 `WORKER_ASK_LLM`·`WORKER_AI_EXPLANATIONS`(api·worker 같은 값, 기본 off)와 LLM 설정이 있을 때만 시작하고, 테스트(`APP_ENV=test`)는 결정적 streaming fake를 쓴다.

## 7. Frontend 기능 범위

- Workspace Home: 생성, 목록, 보관·복원, 삭제.
- Documents: PDF viewer (PDF.js), 장·절 트리, canonical block editor, revision/publish, 업로드 진행.
- Search: keyword/semantic/hybrid, 관련 문단·페이지·본문 강조, source excerpt, PDF jump.
- Auth: 로그인·회원가입·이메일 확인·비밀번호 재설정·로그아웃·계정 보안.
- Questions Home(= Workspace 홈, UX3c): 챕터별 문제 heatmap(확정 문제 하나=marker 하나), 상태별 색상, 즐겨찾기 시 **둥근 별 모양**, hover/focus 확대, 접을 수 있는 상태 필터·정렬, hover preview, 클릭 시 Floating Question Player. Workspace header의 통합 검색과 문서·이력·공유·문제 생성 floating dialog.
- Questions Bank: 유형별 CRUD, 목록·검색·챕터 연결·출처 관리.
- Questions Import: PDF 추출 검토, 미완성 초안 수정, 확인/등록.
- ~~Question Generation: 원본 선택(한 문제·여러 문제·서버 임의 선택 묶음), 변형 유형 지정, LLM 또는 deterministic 변형, diff/정답 검증, 승인.~~ (MOCK-SPEC 2026-11-01 폐지 — QGEN-RM)
- 모의고사(MOCK-SPEC 2026-11-01): `문제` 메뉴 › `모의고사` 목록 dialog, 변형 유형 옵션·범위(`전체 선택`)로 만들기, 저장·편집·다시 만들기·삭제(MOCK-01). 모의고사 문제는 은행·Heatmap 밖.
- 통합 `QuestionViewer`(MOCK-SPEC 2026-11-01): 문제를 하나씩 보이는 모든 곳의 공통 컴포넌트(풀이·관리·읽기 전용·범위 풀이 방식), `문제` 메뉴 › `문제 풀기`와 모의고사 `풀기`의 범위 풀이(QVIEW-01).
- History: 수정·생성·풀이 이력, Job 로그.
- 문서 전문·요약·정리 노트(DOCSUM-SPEC 2026-10-29): 문서 관리 행·DOC-02의 텍스트 내보내기(DOC-03), 홈의 문서 요약 panel(DOCSUM-01), Heatmap 챕터 header의 정리 노트 panel(CHNOTE-01).
- AI 질문·AI 해설·관련 본문(ASK-SPEC 2026-11-01 사용자 결정, ASK-SYNC 2026-11-02): header `AI 질문`·`문제` 메뉴 `AI 질문`·본문 검색 `AI에게 묻기` → `AskPanel`(`?panel=ask`, streaming 답·각주 → 본문 발췌 panel; QuestionViewer modal 층 위에서 열면 맨 위 층), 문제의 `질문하기`(QuestionViewer `manage`·`sequence(mock)`·`manage(mock)`; `practice`·`sequence(bank)` header에는 없음), QuestionViewer 제출 결과 아래 `AI 해설`(AIEXPL-01)과 "관련 본문"(RELSRC-01).
- Design system 기반 일관된 modal/non-modal floating side panel 제공.

UI의 동작·상태·변형 세부 정책은 `questions.md`, UI 구현·토큰·접근성 기준은 `design-system.md` 참조. 모든 화면의 사양은 `screens/index.md`, 인증은 `auth.md`, E2E는 `e2e-strategy.md`, 배포는 `deployment.md`에서 관리한다.

## 8. 개발 마일스톤

**병렬 Auth 트랙(A0–A3):** A0 요구사항/E2E(RED), A1 Supabase local/Auth 설정·JWT/DB 인가, A2 인증 화면과 비밀번호 복구, A3 교차 사용자 차단 및 배포 검증. **M3 릴리즈 전 A3 수용 기준 완료**. Auth 상세는 `docs/auth.md`.

**전 마일스톤 선행 규칙:** 화면별 `docs/screens/*.md` AC 확정 → 참조 E2E 먼저 작성·실행(RED) → 해당 구현(GREEN) → 회귀/접근성 검증. 관련 `docs/e2e-strategy.md`.


| 단계 | 산출물 | 수용 기준 |
|---|---|---|
| M0 기반·디자인 시스템 | Monorepo, 계약, Supabase local/Qdrant/Redis, UI 토큰/Storybook, 화면 명세·E2E harness | 테스트가 실행되고 미구현 화면의 E2E는 의도적으로 실패(RED)하며 설계 토큰이 적용됨 |
| M1 Parser·Chunker | PDF 파싱, chapter/block/page, canonical text, CLI | 원문 위치와 목차 재현, 결과 검수 가능 |
| M2 Search Core | KO/EN embedding, BM25, RRF, reranker, excerpt, eval | 다국어 샘플 평가, 페이지 발췌 완결성 검증 |
| M3 Workspace·Docs·Search | CRUD/archive, upload jobs, PDF viewer, edit/reindex, search UI | 브라우저에서 업로드·교정·검색·PDF 이동 가능 |
| M4 Question Bank·Import | 객관식/주관식/서술형, chapter, PDF 문제 추출 검토 | 승인된 문제만 등록되고 출처 유지 |
| M5 Practice·Heatmap | attempt, self-grade, state, favorite rounded-star, hover/focus scale, retry, floating player | 모양·색상·hover/click/keyboard E2E 및 스냅샷 통과 |
| M6 Variant Generation | shuffle, wording, inverse, analogous concept, drafts, lineage | 답변 일관성 검증과 승인 절차 통과 |
| M7 Harden·Release | history, permission, index consistency, accessibility, performance, deployment and DR | E2E·WCAG·색인 복구·삭제/보관·Staging/Production smoke 테스트 통과 |

이력의 **데이터 구조는 M0~M3에서 이미 도입**해야 한다. M7은 이력 조회 완성·안정화 단계다. M5 전에 `attempts`와 `user_state`를 구현한다.

## 9. 테스트 및 평가

- Parser: 페이지 매핑, 장·절, 표·수식, OCR fallback, 원문/교정본 관계.
- Retrieval: Recall@5/10, MRR@10, nDCG@10, cross-language KO↔EN, hit→PDF 위치 매핑, reranker latency.
- Question generation: option shuffle 정답 ID 일치, inverse 문제 정답 유일/다중 여부, 근거 존재, LLM 출력 스키마, 사용자 승인 전 격리.
- Study state: `retry > last incorrect > last correct > viewed > unseen`; favorite 독립; hover does not mark viewed; 클릭만 학습 열람; 제출 전 정답 미노출.
- Revision: 문서 변경 후 적절한 재색인, 실패 시 rollback, 문제/풀이 이력 무손실.
- Frontend: 화면별 요구사항과 E2E AC ID traceability, 클릭 타깃·키보드·스크린리더·모바일 touch, focus trap/return, reduce motion, light/dark tokens, visual regression.

## 10. Repo 구조

```text
repo/
  apps/
    api/                # FastAPI / DB repositories, application services
    worker/             # Celery task adapters
    web/                # Next.js routes and feature modules
  packages/
    core/               # Python SDK + Typer CLI
    ui/                 # reusable React components, Storybook
    design-tokens/      # token definitions, generated CSS/TS values
  docs/
    architecture.md
    questions.md
    design-system.md
    auth.md
    deployment.md
    e2e-strategy.md
    screens/
  eval/
    datasets/
    reports/
  infra/
    compose.yaml
  contracts/
    openapi.json
  tests/
    e2e/
    integration/
  pyproject.toml
  uv.lock
  pnpm-workspace.yaml
```

Python packages는 `uv` workspace, TypeScript packages는 `pnpm` workspace로 관리한다. OpenAPI 계약으로 TS client를 생성한다.


## 13. Workspace 공유 및 Fork (v1.3 확정)
- 사용자가 소유한 Workspace는 기본적으로 private이다. Owner는 만료·철회 가능한 읽기 전용 링크를 발급할 수 있다.
- 유효한 공유 링크 소지자는 비로그인 상태에서도 published documents/chapter/question/search를 조회할 수 있으나 수정·문제 풀이 저장·개인 기록 조회는 할 수 없다.
- 공유받은 사용자가 로그인했고 원 저작자가 해당 링크의 `allow_fork`를 켠 경우에만 새로운 독립 Workspace로 published snapshot을 Fork할 수 있다. 기본값은 OFF다.
- Fork 시 문서·챕터·문제·정답·해설·원본 출처와 필요한 PDF를 복제하지만 타인의 풀이 기록·즐겨찾기·다시 풀기·비공개 초안·활동 로그·공유 링크는 복제하지 않는다. 모든 내부 ID를 재발급하고 참조를 재매핑한다.
- Fork 완료 후 원본과 자동 동기화하지 않으며 원본 링크 철회나 삭제가 이미 완료된 Fork를 삭제하지 않는다. 진행 중 철회는 Fork 작업을 취소한다.
- 공유 토큰은 무작위 비밀값으로 생성해 서버에 digest만 저장한다. HTTPS Fragment를 1회성 session으로 교환하고 scoped HttpOnly cookie를 사용한다. 공유 read API는 매번 만료/철회 여부와 Workspace 범위를 검증한다.
- 신설 엔티티: `workspace_share_links`, `workspace_forks`. 신설 owner API, shared-view API, Fork API 상세는 [workspace-sharing.md](workspace-sharing.md).
- 단계: S0(명세/E2E RED) → S1(인가·링크) → S2(공유 UI) → S3(Fork worker) → S4(보안·배포 검증); 인증 A 트랙과 M3/M4에 의존한다.
