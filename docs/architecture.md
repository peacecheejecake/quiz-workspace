# PDF Knowledge & Question Workspace — Implementation Plan v1.2

**상태:** 확정 기준 설계 (2026-10-16)  
**범위:** 한두 권의 PDF에서 시작하되, Workspace 단위로 확장 가능한 다국어 검색·문제은행·문제 풀이 시스템  
**제외:** 범용 RAG 채팅/질의응답 생성

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
```

핵심 계약:
- `ParsedDocument`: 원본 PDF 경로, parser 버전, 장·절 계층, 텍스트/표/이미지 블록, PDF 페이지·bbox.
- `DocumentRevision`: 교정된 canonical blocks 및 발행 상태.
- `SearchChunk`: stable id, parent/section, canonical content, contextual search text, revision, hash, source location.
- `SearchHit`: 검색모드, 점수 유형, 관련 구절, 문서·장·절·원본 위치.
- `Excerpt`: 원문 문단 경계로 확장된 발췌 + 페이지·원본 좌표.
- `QuestionDraft`: 원문 추출/변형 초안, source evidence, validations, review 상태.

CLI: `core parse`, `core chunk`, `core index`, `core search`, `core excerpt`, `core questions extract`, `core questions generate`, `core eval`.

### 색인 흐름
1. 원본 PDF 업로드(원본 immutable, sha256 저장).
2. Docling 파싱 → `parsed_document.json` 생성 및 저장.
3. 장·절 계층 복원, 사용자가 수정할 canonical text blocks 생성.
4. 장·절 중심 청킹, block/page provenance 연결.
5. dense + sparse 인덱스 작성, Qdrant에 workspace/document/revision payload 부여.
6. 색인 완료 시 active revision 전환. 실패 시 이전 정상 인덱스 유지.
7. 텍스트 수정 시 신규 revision 발행; 영향받은 chunk 및 부모 문맥을 고려하여 재색인.

### 검색 흐름
- Query: `keyword | semantic | hybrid`; workspace/document/chapter/language filters.
- 기본 후보: dense 30, BM25 30 → RRF → 상위 20 rerank → 결과 10개(평가로 변경).
- `ExcerptResolver`: chunk와 별개로 문단 경계를 기준으로 전후 문맥을 복원하고 source bbox·page 제공.
- KO→KO, KO→EN, EN→KO, EN→EN 별도 평가. 초기에는 강제 번역 없이 multilingual embedding; 필요하면 query translation 후속.
- PDF text edit 후 stale revision이 검색 결과로 노출되지 않도록 published-revision 필터를 서버에서 강제한다.
- Dense 불가 시 저하(M7.4b, SEARCH-01-AC06): query embedding이 `EmbeddingUnavailableError`(hosted embedder 429·5xx·timeout·quota)로 실패하면 `hybrid`/`semantic` 검색은 503 대신 BM25 후보만으로 결과를 내고 응답에 `degraded: ["dense_unavailable"]`을 담는다. UI는 비차단 안내를 표시하고 서버는 검색어 없이 WARNING만 남긴다. Qdrant 장애는 계속 503.
- 색인 쪽(worker)은 저하하지 않는다: 한 chunk라도 embedding이 실패하면 revision을 발행하지 않고(이전 published revision 유지) job을 재시도 가능한 오류(`embedding_quota_exceeded` / `embedding_unavailable`)로 backoff 재시도한다. 이미 쓴 point는 재시도 때 재사용되며, 모든 child chunk가 embedding된 뒤에만 READY.

## 5. Workspace/Document/Question 도메인

```text
workspace
 ├── document ── document_revision ── content_block
 │              └── chapter/section tree
 ├── question ── question_revision
 │             ├── question_source
 │             ├── question_user_state  (user별 학습 상태·플래그)
 │             ├── question_attempt     (채점 이력)
 │             └── question_lineage     (변형 관계)
 ├── question_draft ── generation_run / pdf_import_run
 ├── activity_event
 └── async_job
```

정규화된 구조 및 핵심 제약:
- `profiles(user_id FK auth.users, display_name, created_at)`, `workspace_memberships(workspace_id, user_id, role, created_at)`; MVP는 owner 1인이고 다인 공유는 후속이지만 권한 모델은 미리 정의한다.
- `workspaces(id, name, owner_id, status, archived_at, deleted_at)`.
- `documents(id, workspace_id, type, storage_key, checksum)`; `document_revisions`; `chapters(parent_id)`; `content_blocks(source_location)`.
- `questions(id, workspace_id, chapter_id, question_type, active_revision_id, publication_status)`.
- `question_revisions(id, question_id, version, stem, options, correct_answer, explanation, rubric)`.
- `question_sources(question_id, document_id, document_revision_id, page_range, block_ids)`.
- `question_user_states(user_id, question_id, first_viewed_at, last_viewed_at, last_graded_result, last_graded_attempt_id, is_favorite, needs_retry, updated_at)` with `(user_id, question_id)` unique.
- `question_attempts(id, question_id, question_revision_id, user_id, displayed_option_ids, submitted_answer, result, grading_method, submitted_at, graded_at)`.
- `question_lineage(parent_question_id, child_question_id, variation_type, source_revision_id)`.
- `question_generation_runs` / `question_import_runs`; `question_drafts` (approval 전 격리).
- `activity_events` (변경 감사), `async_jobs` (재시도/상태).

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
| GET | `/api/v1/documents/{id}/outline` | 장·절 트리 |
| GET/PATCH | `/api/v1/documents/{id}/blocks/{blockId}` | 블록 읽기·교정 |
| POST | `/api/v1/documents/{id}/publish` | 교정본 발행·색인 |
| POST | `/api/v1/workspaces/{id}/search` | 다국어 문서·문제 검색 |
| GET | `/api/v1/workspaces/{id}/questions/overview` | heatmap 목록/집계/상태 |
| POST/GET | `/api/v1/workspaces/{id}/questions` | 문제 등록·조회 |
| GET/PATCH | `/api/v1/questions/{id}` | 문제 상세·편집 |
| PATCH | `/api/v1/questions/{id}/my-state` | 즐겨찾기·다시 풀기 토글 |
| POST | `/api/v1/questions/{id}/practice-sessions` | 문제 열람·보기 순서 생성(정답 비노출) |
| POST | `/api/v1/practice-sessions/{id}/submit` | 답변 제출·채점 |
| POST | `/api/v1/practice-sessions/{id}/self-grade` | 주관식·서술형 자기평가 |
| GET | `/api/v1/questions/{id}/attempts` | 풀이 이력 |
| POST | `/api/v1/questions/{id}/generations` | 변형 문제 생성 작업 |
| GET | `/api/v1/question-generations/{id}/drafts` | 생성 문제 검토 |
| POST | `/api/v1/question-generations/{id}/publish` | 승인한 문제만 등록 |
| POST | `/api/v1/workspaces/{id}/question-imports` | 문제 PDF 가져오기 |
| GET | `/api/v1/question-imports/{id}/drafts` | 가져온 문제 검토 |
| POST | `/api/v1/question-imports/{id}/publish` | 승인한 문제만 등록(`approve: true`면 선택한 초안을 승인과 함께 등록, 거절 목록 반환) |
| GET | `/api/v1/jobs/{id}` | 비동기 작업 상태 |
| GET | `/api/v1/jobs/{id}/events` | SSE 진행 상황 |
| GET | `/api/v1/workspaces/{id}/activities` | 변경 이력 |

인가·workspace filter를 서버에서 강제한다. 문제 풀이 조회 API는 정답/해설을 제출 전까지 전송하지 않는다. POST 작업에는 멱등 키를 지원한다.

## 7. Frontend 기능 범위

- Workspace Home: 생성, 목록, 보관·복원, 삭제.
- Documents: PDF viewer (PDF.js), 장·절 트리, canonical block editor, revision/publish, 업로드 진행.
- Search: keyword/semantic/hybrid, 관련 문단·페이지·본문 강조, source excerpt, PDF jump.
- Auth: 로그인·회원가입·이메일 확인·비밀번호 재설정·로그아웃·계정 보안.
- Questions Home(= Workspace 홈, UX3c): 챕터별 문제 heatmap(확정 문제 하나=marker 하나), 상태별 색상, 즐겨찾기 시 **둥근 별 모양**, hover/focus 확대, 접을 수 있는 상태 필터·정렬, hover preview, 클릭 시 Floating Question Player. Workspace header의 통합 검색과 문서·이력·공유·문제 생성 floating dialog.
- Questions Bank: 유형별 CRUD, 목록·검색·챕터 연결·출처 관리.
- Questions Import: PDF 추출 검토, 미완성 초안 수정, 확인/등록.
- Question Generation: 원본 선택, 변형 유형 지정, LLM 또는 deterministic 변형, diff/정답 검증, 승인.
- History: 수정·생성·풀이 이력, Job 로그.
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
