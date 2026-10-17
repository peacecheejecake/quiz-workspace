# 구현 계획 — Platform v1.3

**상태:** 실행 기준 계획 · 2026-10-17
**기준 문서:** [architecture](architecture.md) · [auth](auth.md) · [workspace-sharing](workspace-sharing.md) · [questions](questions.md) · [design-system](design-system.md) · [deployment](deployment.md) · [e2e-strategy](e2e-strategy.md) · [screens](screens/index.md)
**운영 규칙:** [`AGENTS.md`](../AGENTS.md) (orchestration·리뷰 게이트·코딩 규칙)

이 문서는 `docs/`의 확정 설계를 **실행 가능한 Task 계층과 의존 그래프**로 분해한다. 설계 내용과 충돌하면 설계 문서가 우선하며, 충돌은 이 문서 §7 "결정 기록"에 남긴다.

---

## 1. 계층 구조와 용어

```text
Phase  (P0, A, M1 … M7, S)        — architecture.md §8 마일스톤 / auth A트랙 / 공유 S트랙
 └─ Epic   (예: M3.2)              — 하나의 기능 경계(API+UI 또는 Core 모듈)
     └─ Task (예: M3.2a)           — subagent 1개가 한 번에 끝내는 작업 = **리뷰 단위**
```

- **Task = 리뷰 단위.** Task는 RED 증거(해당 시)·구현·GREEN·커밋까지 완결되어야 하며, 끝나면 `codex review`를 받는다 (AGENTS.md §4).
- **구현 Task는 자기 Phase의 RED Task에 반드시 의존한다** (그래프의 굵은 화살표 `==>`). RED 없이 구현 착수 금지.
- **RED Task (`*.0`)** 는 각 Phase의 화면 AC를 Playwright/contract test로 먼저 작성하고, 실패 원인이 "미구현"임을 확인해 커밋한다. 구현 Task는 이 테스트를 GREEN으로 만든다.
- 상태 표기: `☐` 대기 · `◐` 진행 · `✅` 완료(GREEN + 리뷰 반영) · `⛔` 사람의 결정/계정 필요.

## 2. Phase 그래프

```mermaid
flowchart LR
  P0[P0 Foundation<br/>M0 + harness] --> A[A Auth track<br/>A0–A3]
  P0 --> M1[M1 Parser·Chunker]
  P0 --> UI[P0.4 UI kit]
  M1 --> M2[M2 Search Core]
  A --> M3[M3 Workspace·Docs·Search]
  M2 --> M3
  UI --> M3
  M3 --> M4[M4 Question Bank·Import]
  M4 --> M5[M5 Practice·Heatmap]
  M5 --> M6[M6 Variant Generation]
  M3 --> S[S Sharing·Fork]
  M4 --> S
  A --> S
  M5 --> M7[M7 Harden·Release]
  M6 --> M7
  S --> M7
```

- **A3(교차 사용자 차단) 완료 전 M3 UI release 금지** (auth.md §6).
- 병렬 가능 구간: `A ∥ M1 ∥ P0.4` → `A ∥ M2 ∥ P0.4` → `M3` 이후 `M4 → M5 → M6` 와 `S` 병렬.

## 3. Task 계층 (전체)

열: **ID · 내용 · 의존 · 완료 조건(DoD)**. AC 범위는 `docs/screens/*.md`의 ID를 그대로 사용한다.

### P0 — Foundation (M0 + E2E harness)

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| P0.1 | Monorepo 골격: `pnpm-workspace.yaml`, root `package.json`(lint/typecheck/test 스크립트), uv workspace `pyproject.toml`, `.env.example`, ruff/mypy/eslint/prettier 설정, `Makefile`(또는 `justfile`) 공통 명령 | — | `pnpm install`, `uv sync` 성공, 빈 lint/typecheck 통과 |
| P0.2 | 로컬 인프라: `infra/compose.yaml`(Qdrant, Redis), Supabase CLI(devDependency `supabase`)로 `supabase init`, Mailpit 포함 local config | P0.1 | `make infra-up` 후 Qdrant/Redis/Supabase health OK |
| P0.3 | `packages/design-tokens`: `tokens.json` 단일 소스 → CSS 변수/TS 생성(light/dark), raw hex 금지 lint 규칙 | P0.1 | 생성물이 design-system.md §3 값과 일치하는 unit test |
| P0.4 | `packages/ui`: Storybook, Foundation primitives(`Button`, `IconButton`, `Input`, `Surface`, `GlassSurface`, `FocusRing`, `Tooltip`, `Popover`, `Toast` …), `FloatingSidePanel`(modal/non-modal), `AppShell` | P0.3 | Storybook build, Vitest + axe 통과, panel focus trap/return 테스트 |
| P0.5 | `apps/web`: Next.js App Router, AppShell 적용, 21개 화면 **stub route**(404가 아닌 "미구현" 화면), Supabase SSR client 자리 | P0.1, P0.3 | `pnpm --filter web build`, 모든 route 200 |
| P0.6 | `apps/api`: FastAPI 앱, settings, `/health/live`·`/health/ready`, SQLAlchemy 세션, 오류 형식, OpenAPI → `contracts/openapi.json` export, TS client 생성 파이프라인 | P0.1 | pytest 통과, openapi 생성 스크립트 동작 |
| P0.7 | `apps/worker`: Celery 앱, 멱등 task base(`async_jobs` 연동 인터페이스), 테스트용 eager 모드 | P0.6 | 샘플 task unit test |
| P0.8 | `packages/core`(`book_core`): 모듈 골격, Pydantic 계약(`ParsedDocument`, `DocumentRevision`, `SearchChunk`, `SearchHit`, `Excerpt`, `QuestionDraft`), Typer CLI stub, 모델/LLM **fake adapter 인터페이스** | P0.1 | 계약 직렬화 unit test, `core --help` |
| P0.9 | DB baseline migration(`supabase/migrations`): `profiles`, `workspaces`, `workspace_memberships`, `activity_events`, `async_jobs` + 최소 grants/RLS, seed 골격 | P0.2 | `supabase db reset` 성공, migration lint |
| P0.3b | 토큰 보강: feedback(danger/success/warning, 텍스트 대비 충족), on-accent, scrim, typography scale, breakpoint 토큰 추가 후 `packages/ui` 내부 alias 교체 | P0.4 | 토큰 test + ui test/axe 통과, alias 제거 |
| P0.7b | Postgres `JobStore` + `async_jobs` 정합 migration(max_attempts, lease/locked_by, cancel_requested_at, publication 상태, idempotency 범위 결정) | P0.7, P0.9 | 실 DB 통합 test(claim 경쟁·lease 회수·reconciler), pgTAP 갱신 |
| P0.10 | E2E harness: Playwright 설치, `tests/e2e/fixtures/`(사용자·workspace 고유 fixture 팩토리), test-only seed 경로(production 빌드 제외), `e2e:trace` 스크립트(AC ↔ test title 대조, orphan 검출), CI workflow 골격(lint→unit→contract→e2e) | P0.5, P0.6, P0.9 | `pnpm e2e:trace` 동작. 기존 starter spec은 `tests/e2e/_pending/`(실행 제외)로 옮기고, 각 Phase RED Task가 화면 명세 경로로 가져와 확장 |

### A — Auth track (auth.md §6)

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| A0 | RED: `auth/*.spec.ts`(AUTH-01~07, ACCOUNT-01 = 24 AC) + API contract test(AUTH-API-AC01~03) | P0.10 | RED 증거 커밋, trace 통과 |
| A1.1 | Supabase Auth local 설정: 이메일 확인 필수, redirect allowlist, 비대칭 JWT signing key, Mailpit | P0.2 | 로컬 가입→메일 수신 수동/자동 확인 |
| A1.2 | FastAPI JWT/JWKS 검증(kid·alg allowlist·iss·aud·exp·sub, 키 캐시/rotation), `GET /me`, `GET /me/workspaces`, 401/403 구분 | A0, P0.6, A1.1 | AUTH-API-AC01 GREEN |
| A1.3 | 인가 dependency: resource → workspace → membership, archived 쓰기 거부, soft-deleted 차단, profile upsert | A1.2, P0.9 | 교차 사용자 403/404 integration test |
| A2.1 | Next.js 세션: `proxy.ts`/`middleware.ts` refresh, `getClaims()` 기반 서버 판단, 보호 라우트, `next` 내부경로 allowlist, API client Bearer 주입 | A0, P0.5, A1.1 | AUTH-01-AC01, open redirect AC GREEN |
| A2.2 | 화면 AUTH-01~07 (`AuthLayout`, `SignInForm`, `SignUpForm`, `PasswordResetForm`, `VerificationNotice`) | A2.1, P0.4 | AUTH-01~07 AC GREEN |
| A2.3 | ACCOUNT-01 보안 설정 화면 | A2.2 | ACCOUNT-01 AC GREEN |
| A3 | 릴리즈 준비(로컬 범위): AUTH-API-AC02/03, CORS·CSRF·쿠키 정책, 로그 마스킹. staging SMTP/도메인은 M7.4로 이월 | A1.3, A2.3 | Auth 전 AC + API AC GREEN |

### M1 — Parser·Chunker

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| M1.1 | 합성 PDF fixture(KO/EN 2~5p, 목차·표·문단·문제 포함) 생성 스크립트 | P0.8 | fixture 재생성 가능, 저작권 자료 없음 |
| M1.2 | `parser`: Docling → `ParsedDocument`(page, bbox, block 유형), OCR fallback 플래그, sha256 | M1.1 | 페이지·bbox 매핑 unit test |
| M1.3 | `structure`: 장·절 계층 복원 + canonical blocks + `DocumentRevision` | M1.2 | 목차 재현 test |
| M1.4 | `chunker`: HybridChunker + parent/child 계층 청킹, block/page provenance, stable id/hash | M1.3 | chunk 경계·provenance test |
| M1.5 | CLI `core parse` / `core chunk` | M1.4 | CLI e2e(pytest) |

### M2 — Search Core

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| M2.1 | `embedding`: Qwen3-Embedding adapter(optional extra) + 결정론적 fake | M1.4 | fake 결정성 test |
| M2.2 | `indexing`: Qdrant dense+BM25 sparse, workspace/document/revision payload, active revision 전환·rollback | M2.1, P0.2 | Qdrant 통합 test |
| M2.3 | `search`: keyword/semantic/hybrid, RRF, published-revision 필터 강제 | M2.2 | 필터 우회 불가 test |
| M2.4 | `reranker`: Qwen3-Reranker adapter + fake, 후보 수 설정 | M2.3 | 순위 계약 test |
| M2.5 | `ExcerptResolver`: 문단 경계 확장, page/bbox | M2.3 | 발췌 완결성 test |
| M2.6 | `evaluation` + `eval/`: ir-measures, KO↔EN 데이터셋 골격, `core eval`, `core index/search/excerpt` CLI | M2.4, M2.5 | 샘플 리포트 생성 (실모델 nightly) |

### M3 — Workspace·Docs·Search

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| M3.0 | RED: WS-01(6), DOC-01(4), DOC-02(5), SEARCH-01(5) | P0.10 | RED 증거 |
| M3.1a | Workspace API: CRUD/archive/restore/soft delete, 멱등 키, activity 기록 | M3.0, A1.3 | contract test GREEN |
| M3.1b | WS-01 화면 (`WorkspaceSwitcher`, 탭 Active/Archived, 빈 상태) | M3.1a, A2.1, P0.4 | WS-01-AC01~05 GREEN (AC06은 S2) |
| M3.2a | 문서 schema(`documents`, `document_revisions`, `chapters`, `content_blocks`), upload-intent / complete-upload, private Storage 버킷 | M3.1a | 업로드 인가 integration test |
| M3.2b | Worker 파싱·색인 job, `GET /jobs/{id}`(DB 기준, Celery result 미사용), SSE events, 실패 시 이전 revision 유지 | M3.2a, M1.5, M2.2, P0.7b | job 재시도·멱등 test |
| M3.3 | DOC-01 화면: 목록·업로드(TUS)·진행률·취소·재시도 | M3.2b | DOC-01 AC GREEN |
| M3.4 | outline/blocks/publish API, 교정 → 신규 revision → 재색인 → rollback | M3.2b | revision/재색인 test |
| M3.5 | DOC-02 화면: PDF.js viewer, `DocumentOutlineTree`, `TextBlockEditor`, signed read URL | M3.4 | DOC-02 AC GREEN |
| M3.6a | Search API: workspace/published 필터 서버 강제, 문서 hit + excerpt | M3.4, M2.6 | 교차 workspace 검색 차단 test |
| M3.6b | SEARCH-01 화면: 모드 전환, `SearchResultList`, `DocumentExcerptPanel`(non-modal), PDF jump | M3.6a, M3.5 | SEARCH-01 AC GREEN |

### M4 — Question Bank·Import

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| M4.0 | RED: QBANK-01(4), QIMPORT-01(4) | M3.0 | RED 증거 |
| M4.1 | 문제 schema: `questions`, `question_revisions`, `question_sources`, `question_user_states`, `question_attempts`, `question_lineage`, `question_drafts`, generation/import runs | P0.9 | migration + 제약 test |
| M4.2a | Question CRUD API(유형 MCQ/SHORT_ANSWER/ESSAY, 챕터·출처, revision) | M4.0, M4.1, M3.4 | contract test |
| M4.2b | QBANK-01 화면 | M4.2a | QBANK-01 AC GREEN |
| M4.3 | Core `llm` adapter(structured output, fake 포함) + `extractor`(문제 PDF → `QuestionDraft`, 정답 생성 금지) | M1.5 | fake 기반 추출 test |
| M4.4a | Import run API/worker, drafts 격리, 승인분만 publish | M4.0, M4.3, M4.2a, P0.7 | 미승인 미등록 test |
| M4.4b | QIMPORT-01 화면 + 공용 `QuestionDraftReview` | M4.4a | QIMPORT-01 AC GREEN |

### M5 — Practice·Heatmap

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| M5.0 | RED: QOV-01(6), QPLAY-01(5) + 정답 비노출 contract test | M4.0 | RED 증거 |
| M5.1 | `deriveDotStatus`(TS/Python 공통 규칙), overview API(CONFIRMED만, 상호배타 집계 + favorite overlap, 필터) | M5.0, M4.2a | 우선순위 unit test |
| M5.2 | practice-session(정답·해설 미전송, option ID 순서 저장), submit, self-grade, `my-state`, viewed는 패널 open에서만 | M5.1 | 정답 유출·shuffle 100회 test |
| M5.3 | `QuestionMarker`/`QuestionDot`/`QuestionHeatmap`/`HeatmapLegend`/`QuestionPreviewPopover` + Storybook 5상태×favorite×hover/focus/selected, roving tabindex, visual regression | P0.4 | 스냅샷·axe 통과 |
| M5.4 | QOV-01 화면 (필터·URL state·집계 chips) | M5.2, M5.3 | QOV-01 AC GREEN |
| M5.5 | QPLAY-01 `QuestionPracticePanel`(modal, `?question=` 딥링크, 이전/다음, focus return) | M5.4 | QPLAY-01 AC GREEN |

### M6 — Variant Generation

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| M6.0 | RED: QGEN-01(4) + fake LLM valid/invalid 시나리오 | M5.0 | RED 증거 |
| M6.1 | Core `generation`: PARAPHRASE / INVERT_POLARITY / ANALOGOUS_CONCEPT, schema·정답 개수·중복 fingerprint·출처 검증 (OPTION_SHUFFLE은 M5.2에서 완료) | M4.3, M2.5 | validation unit test |
| M6.2 | generation run API/worker, drafts, 승인 → CONFIRMED + lineage | M6.0, M6.1, M4.4a | 승인 전 dot 수 불변 test |
| M6.3 | QGEN-01 화면(`QuestionGenerationForm`, `VariationDiffViewer`, ≥600px drawer) | M6.2, M4.4b | QGEN-01 AC GREEN |

### S — Workspace Sharing·Fork (workspace-sharing.md)

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| S0 | RED: WS-SHARE-01(5), WS-VIEW-01(6), WS-FORK-01(6) + 보안 contract test, owner/guest/recipient fixture | P0.10 | RED 증거 |
| S1a | `workspace_share_links` + owner API(발급·조회·PATCH·revoke·rotate), digest 저장 | S0, A3, M3.1a | 비밀값 미저장 test |
| S1b | shared session 교환(fragment → HttpOnly cookie), shared read API(문서/PDF/검색/문제), 매 요청 재검증, no-store/no-referrer 헤더 | S1a, M3.6a, M4.2a | revoke 즉시 차단 test |
| S2a | WS-SHARE-01 화면(`WorkspaceSharingPanel`) + WS-01-AC06 | S1a, M3.1b | WS-SHARE-01 AC GREEN |
| S2b | WS-VIEW-01 화면(`SharedWorkspaceView`, 읽기 전용) | S1b | WS-VIEW-01 AC GREEN |
| S3a | `workspace_forks` + Fork worker: snapshot manifest, ID remap, 개인 데이터 제외, 커밋 직전 재검증, 취소 정리 | S1b, P0.7 | 복제·격리·경쟁 integration test |
| S3b | WS-FORK-01 화면(`ForkWorkspaceDialog`) | S3a, S2b | WS-FORK-01 AC GREEN |
| S4 | 보안 검증 묶음: 우회·권한 상승·CSRF·rate limit·로그 유출 | S3b | 보안 test GREEN |

### M7 — Harden·Release

| ID | 내용 | 의존 | DoD |
|---|---|---|---|
| M7.0 | RED: HISTORY-01(3) | M3.0 | RED 증거 |
| M7.1 | activities/attempts/jobs 조회 API + HISTORY-01 화면 | M7.0, M5.2 | HISTORY-01 AC GREEN |
| M7.2 | 전 화면 a11y(axe)·visual baseline(light/dark, desktop/iPad)·WebKit/모바일 smoke, 성능 점검 | M5.5, M6.3, S4 | 전체 E2E GREEN, `e2e:trace` orphan 0 |
| M7.3 | 컨테이너화(web/api/worker Dockerfile), CI 전체 파이프라인, 색인 재생성·백업 복원 스크립트 | M7.2 | CI GREEN |
| M7.4 ⛔ | Staging/Production 배포(Vercel·Supabase·Railway·Qdrant Cloud), SMTP, DEP-01~07 | M7.3 | **사용자 계정·비용 승인 필요** |

## 4. Task 의존 그래프

```mermaid
flowchart TB
  subgraph P0[P0 Foundation]
    P01[P0.1 monorepo] --> P02[P0.2 infra]
    P01 --> P03[P0.3 tokens] --> P04[P0.4 ui kit]
    P01 --> P05[P0.5 web stub]
    P03 --> P05
    P01 --> P06[P0.6 api] --> P07[P0.7 worker]
    P01 --> P08[P0.8 core]
  P04 --> P03b[P0.3b token 보강]
  P07 --> P07b[P0.7b PG JobStore]
  P09 --> P07b
    P02 --> P09[P0.9 db baseline]
    P05 --> P010[P0.10 e2e harness]
    P06 --> P010
    P09 --> P010
  end

  subgraph A[Auth]
    A0[A0 RED]
    A11[A1.1 supabase auth] --> A12[A1.2 JWT] --> A13[A1.3 authz]
    A11 --> A21[A2.1 web session] --> A22[A2.2 auth screens] --> A23[A2.3 account]
    A13 --> A3[A3 readiness]
    A23 --> A3
  end
  P010 --> A0
  A0 ==> A12
  A0 ==> A21
  P02 --> A11
  P06 --> A12
  P09 --> A13
  P05 --> A21
  P04 --> A22

  subgraph M1[M1 Parser]
    M11[M1.1 fixtures] --> M12[M1.2 parser] --> M13[M1.3 structure] --> M14[M1.4 chunker] --> M15[M1.5 CLI]
  end
  P08 --> M11

  subgraph M2[M2 Search core]
    M21[M2.1 embedding] --> M22[M2.2 indexing] --> M23[M2.3 hybrid] --> M24[M2.4 rerank] --> M26[M2.6 eval]
    M23 --> M25[M2.5 excerpt] --> M26
  end
  M14 --> M21
  P02 --> M22

  subgraph M3[M3 Workspace·Docs·Search]
    M30[M3.0 RED]
    M31a[M3.1a ws api] --> M31b[M3.1b WS-01]
    M31a --> M32a[M3.2a upload] --> M32b[M3.2b parse job]
    M32b --> M33[M3.3 DOC-01]
    M32b --> M34[M3.4 publish] --> M35[M3.5 DOC-02]
    M34 --> M36a[M3.6a search api] --> M36b[M3.6b SEARCH-01]
    M35 --> M36b
  end
  P010 --> M30
  M30 ==> M31a
  A13 --> M31a
  A21 --> M31b
  P04 --> M31b
  M15 --> M32b
  M22 --> M32b
  P07b --> M32b
  M26 --> M36a

  subgraph M4[M4 Bank·Import]
    M40[M4.0 RED]
    M41[M4.1 schema] --> M42a[M4.2a crud api] --> M42b[M4.2b QBANK-01]
    M43[M4.3 llm+extractor] --> M44a[M4.4a import] --> M44b[M4.4b QIMPORT-01]
    M42a --> M44a
  end
  M30 --> M40
  M40 ==> M42a
  M40 ==> M44a
  P09 --> M41
  M34 --> M42a
  M15 --> M43

  subgraph M5[M5 Practice·Heatmap]
    M50[M5.0 RED]
    M51[M5.1 status+overview] --> M52[M5.2 practice api] --> M54[M5.4 QOV-01] --> M55[M5.5 QPLAY-01]
    M53[M5.3 heatmap comps] --> M54
  end
  M40 --> M50
  M50 ==> M51
  M42a --> M51
  P04 --> M53

  subgraph M6[M6 Generation]
    M60[M6.0 RED]
    M61[M6.1 core generation] --> M62[M6.2 run api] --> M63[M6.3 QGEN-01]
  end
  M50 --> M60
  M60 ==> M62
  M43 --> M61
  M25 --> M61
  M44a --> M62
  M44b --> M63

  subgraph S[Sharing·Fork]
    S0[S0 RED]
    S1a[S1a links] --> S1b[S1b shared read] --> S2b[S2b WS-VIEW-01]
    S1a --> S2a[S2a WS-SHARE-01]
    S1b --> S3a[S3a fork worker] --> S3b[S3b WS-FORK-01] --> S4[S4 security]
    S2b --> S3b
  end
  P010 --> S0
  S0 ==> S1a
  A3 --> S1a
  M31a --> S1a
  M36a --> S1b
  M42a --> S1b
  M31b --> S2a

  subgraph M7[M7 Harden·Release]
    M70[M7.0 RED]
    M71[M7.1 HISTORY-01] --> M72[M7.2 a11y/visual]
    M72 --> M73[M7.3 CI/containers] --> M74[M7.4 deploy ⛔]
  end
  M30 --> M70
  M70 ==> M71
  M52 --> M71
  M55 --> M72
  M63 --> M72
  S4 --> M72
```

## 5. 실행 Wave (orchestration 순서)

같은 Wave 안의 Task는 파일 범위가 겹치지 않으면 병렬 subagent로 실행한다 (worktree 격리).

| Wave | Task | 비고 |
|---|---|---|
| W1 | P0.1 | 단독 (모든 Task의 기반) |
| W2 | P0.2 · P0.3 · P0.6 · P0.8 | 서로 다른 디렉터리 |
| W3 | P0.4 · P0.5 · P0.7 · P0.9 · M1.1 | |
| W4 | P0.10 · A1.1 · M1.2 | |
| W5 | A0 · M1.3 | Auth RED는 Auth 구현 직전 |
| W6 | A1.2 · A2.1 · M1.4 · M5.3 | M5.3은 순수 UI 컴포넌트(Storybook)라 선행 가능 |
| W7 | A1.3 · A2.2 · M1.5 · M2.1 | |
| W8 | A2.3 · M2.2 · M3.0 · M4.1 · M4.3 | M3 RED는 M3 착수 직전 |
| W9 | A3 · M2.3 · M3.1a | |
| W10 | M3.1b · M2.4 · M2.5 · M3.2a | M3.1b는 A3 이후 |
| W11 | M2.6 · M3.2b · S0 | |
| W12 | M3.3 · M3.4 · S1a | |
| W13 | M3.5 · M3.6a · M4.0 · S2a | |
| W14 | M3.6b · M4.2a · M4.4a | |
| W15 | M4.2b · M4.4b · M5.0 · S1b | |
| W16 | M5.1 · M6.0 · M6.1 · S2b · S3a · M7.0 | |
| W17 | M5.2 · M6.2 · S3b | |
| W18 | M5.4 · M6.3 · M7.1 · S4 | |
| W19 | M5.5 | |
| W20 | M7.2 → M7.3 → M7.4⛔ | |

Wave는 권장 순서이며, 실제로는 §4 그래프의 의존이 충족된 Task를 즉시 착수한다.

## 6. 리뷰 단위와 게이트 요약

- Task 하나 = 리뷰 단위. RED Task도 리뷰 대상(테스트가 AC를 정확히 반영하는지).
- 게이트 순서: `RED 증거 → 구현 → 로컬 검증(lint/typecheck/unit/관련 E2E) → 커밋 → codex review → 지적 반영 커밋 → 상태 ✅`.
- 리뷰 실행: `scripts/codex-review.sh --commit <sha>` 또는 `--base <ref>` (herdr의 `codex-review` pane 재사용). 세부는 AGENTS.md §4.

## 7. 결정 기록

| 날짜 | 결정 | 근거 |
|---|---|---|
| 2026-10-17 | E2E 파일명은 `docs/screens/*.md`의 "테스트" 경로를 기준으로 한다. 기존 starter(`questions/overview.spec.ts` 등)는 RED Task에서 해당 경로로 이동·확장한다. | e2e-strategy.md 표와 화면 명세의 파일명이 다름; 화면 명세가 AC의 Source of Truth |
| 2026-10-17 | AUTH-API-AC01~03은 브라우저 E2E가 아닌 `tests/integration` API contract test로 작성한다. | auth.md §7, e2e-strategy.md §4 계층 |
| 2026-10-17 | Supabase CLI는 전역 설치 대신 root devDependency(`supabase`)로 고정하고 `pnpm exec supabase`로 실행한다. | 로컬 환경에 CLI 미설치, 버전 고정 |
| 2026-10-17 | 실모델(Docling OCR 대형 모델, Qwen3)은 Python optional extra로 두고 E2E/CI는 fake adapter를 사용한다. | e2e-strategy.md §3 |
| 2026-10-17 | 모든 Task 커밋은 통합 브랜치 `develop`에 쌓는다(병렬 Task는 `task/<id>` worktree 브랜치 → `develop` merge). `main`은 `develop`의 **존재하는 모든 테스트가 GREEN**일 때만 fast-forward한다. 그래서 RED Task는 해당 Phase 착수 직전에 작성한다(일괄 선작성 금지). | e2e-strategy.md §1: main에 의도적 RED 금지 |
| 2026-10-17 | 생성된 TS API client는 별도 패키지 `packages/api-client`(openapi-typescript + openapi-fetch)로 둔다. | P0.5(web) 이전에 생성 파이프라인이 필요; web·share 화면 등 여러 소비처 공유 |
| 2026-10-17 | TypeScript는 `~6.0.3`으로 고정한다(7.x 미사용). | typescript-eslint 8.x가 `<6.1.0`만 지원 |
| 2026-10-17 | Supabase Studio는 local에서 비활성화(`[studio] enabled = false`). CLI 업데이트로 정상 이미지가 나오면 재활성화한다. | CLI 2.119.0이 고정한 arm64 Studio 이미지의 node가 segfault → `supabase start` health check 실패 |
| 2026-10-17 | API는 `python -m quiz_api.serve`로만 실행한다(uvicorn access log 비활성, 로그 redaction 일원화). | uvicorn 기본 access log가 query string의 토큰을 기록(codex P1) |
| 2026-10-17 | 비밀번호 정책: 최소 10자, 문자 종류 규칙 없음(NIST 800-63B). A2.2 폼 검증도 동일 규칙. | auth.md에 수치 없음 |
| 2026-10-17 | 인증 메일 링크는 `token_hash` 방식(`/auth/callback?token_hash&type`), callback은 `token_hash`(verifyOtp)와 `code`(PKCE/OAuth) 모두 처리하고 `next`는 내부 경로 allowlist로 검증. | Supabase SSR 권장, 다른 브라우저에서 열어도 동작 |
| 2026-10-17 | 웹/UI React는 19.2.8로 통일(Next 16.3 라인). | P0.4·P0.5 버전 불일치 해소 |
| 2026-10-17 | 실모델(Docling) test는 `models` marker로 분리해 `make test-models`로만 실행하고, CI는 nightly(또는 parser 변경 시)로 HF cache와 함께 돌린다. PR CI의 `make test`는 오프라인·모델 미사용. | AGENTS.md 실모델 경계, 오프라인 재현성 |
| 2026-10-17 | test-only seed endpoint는 만들지 않는다. E2E fixture는 local Auth admin API(로컬 loopback만 허용)와 이후 공개 API로 데이터를 만든다. CI의 `E2E_PHASES`에는 GREEN이 된 phase만 추가한다. | AGENTS.md §5, develop의 RED spec이 CI를 깨지 않게 |
| 2026-10-17 | API·worker 공용 로그 redaction은 `book_core.log_redaction`에 둔다. | 두 앱이 이미 book_core에 의존, 신규 member 불필요 |
| 2026-10-17 | Chunker는 Docling HybridChunker를 쓰지 않고 canonical DocumentRevision 기반 자체 parent/child chunker로 구현한다(구조 우선·토큰 기반 분할/병합·표 행 단위 직렬화는 계승). | 입력이 사용자 교정 revision이라 DoclingDocument로 재구성하면 block id/provenance 손실, 기본 설치에 docling-core·HF tokenizer 의존 |
| 2026-10-17 | 로컬 Supabase stack은 orchestrator가 main checkout에서 상시 기동하고, subagent는 `infra-up/down`·`db-reset`을 하지 않고 공유해 쓴다(per-test 사용자로 격리). migration을 바꾸는 Task만 orchestrator 승인 후 reset. | 병렬 Task 간 stack 재시작·초기화 충돌 방지 |
| 2026-10-17 | 공유 stack에 migration을 적용할 때는 `supabase migration up`(비파괴)을 쓰고 `db reset`은 쓰지 않는다. | 병렬 Task 데이터 보존 |
| 2026-10-17 | 로그인은 server action으로 처리(비밀번호가 브라우저 JS를 거치지 않음), signup/recover는 브라우저 supabase-js 호출(A0 test의 실패 주입 방식과 일치). `next` allowlist: /workspaces, /documents, /questions, /settings, /reset-password, /share. | A2.1 구현, A0 가정 확정 |
| 2026-10-17 | 인가 응답: 미존재·비회원·soft-deleted·workspace 불일치 → 404(동일 본문, 존재 여부 비노출). 회원이지만 role 부족 → 403 `insufficient-role`, archived에 쓰기 → 403 `workspace-archived`. 권한은 `authz/permissions.py`의 단일 표. | auth.md §4–5, 존재 여부 탐색 방지 |
| 2026-10-17 | archived Workspace에서는 개인 풀이 기록(practice)도 쓰기로 보고 거부한다(엄격한 read-only). | "archived는 쓰기 거부" 해석; 변경 시 표의 flag 하나 |
| 2026-10-17 | 프로필은 `/me` 호출 시 `insert … on conflict do nothing`으로 생성한다. 삭제된 사용자의 토큰은 401. | 멱등·경합 안전 |
| 2026-10-17 | Worker는 별도 최소권한 role `quiz_worker`(async_jobs 상태 컬럼만 UPDATE, DELETE 없음)로 접속한다. 이후 job이 다루는 테이블 권한은 각 Task의 migration이 추가한다. | auth.md 최소 권한 |
| 2026-10-17 | Job 멱등 범위는 `(workspace_id, created_by, job_type, idempotency_key)`(key nullable)로 유지하고 API는 `created_by`=JWT sub로 insert, envelope에도 같은 값을 싣는다. NULLS NOT DISTINCT는 사용자 삭제 시 충돌 위험으로 미사용. | P0.9/P0.7 정합 |
| 2026-10-17 | pytest RED test는 `red` marker를 달아 `make test-infra`에서 제외하고 `make test-red`로 실행한다(구현 Task가 marker 제거). | develop의 infra gate를 GREEN으로 유지 |
| 2026-10-17 | migration은 subagent가 rolled-back transaction에서만 검증하고, 공유 DB 적용은 merge 후 orchestrator가 한다. | 미merge migration이 공유 DB에 적용돼 다른 Task를 막은 사고(P0.7b) |
| 2026-10-17 | LLM provider는 SDK 없이 httpx로 Anthropic Messages API를 직접 호출한다(모델 id는 설정 필수, 기본값 없음). | SDK가 httpx2를 끌어와 기존 test 타입 깨짐 + DEBUG 로그에 원문 노출 |
| 2026-10-17 | 문제 PDF는 문서 업로드 경로를 재사용하고 `documents.type='question_paper'`로 구분한다(책 검색 기본 제외). | architecture §5 `documents.type`, 업로드/파싱 경로 단일화 |
| 2026-10-17 | E2E·contract test의 결정론적 실패 주입은 `APP_ENV=test`에서만 동작하는 fake adapter가 파일명/내용 marker(`E2E-FAIL-…`)로 수행한다. production 코드 경로에는 test-only endpoint를 두지 않는다. | DOC-02-AC04, QIMPORT-01-AC04 재현성 |
| 2026-10-17 | Workspace 생성/보관/복원 POST는 `Idempotency-Key`를 지원(사용자·route·key 범위, 24h, 다른 body 재사용 409). | architecture §6 |

## 8. 진행 현황

| Task | 상태 | 커밋 | 리뷰 |
|---|---|---|---|
| PLAN (계획·AGENTS.md·리뷰 스크립트) | ✅ | 7f11b19 · e223735 · fix 2건 | 4회 리뷰: P2×3 반영(RED 의존 edge, exit status, 원자적 lock) → P2 lock 수명 반영 → P2 상태 경합 반영(status file) → 지적 없음 |
| P0.1 monorepo 골격 | ✅ | 704c61a | 지적 없음 |
| P0.2 로컬 인프라 | ✅ | 5cfce1a (merge 73c5a13) | 지적 없음. Studio 비활성(결정 기록) |
| P0.3 design tokens | ✅ | e1c4fc3 | 지적 없음 |
| P0.6 API 골격·OpenAPI client | ✅ | ce575fe · d17018a (merge a8b5d80) · 02b4e0e | P1×2(예외 traceback·uvicorn access log 토큰 노출) → 반영 → 지적 없음. 실행 순서 의존 로그 테스트 수정 → 지적 없음 |
| P0.5 web stub routes | ✅ | c28cc7a · 40a9aed · d074397 | P2(root .env 미로딩) → 반영 → P1(확장자 없는 config import, native TS loader) → 반영 → 지적 없음. `agentRules: false`(next dev가 apps/web/AGENTS.md 생성 방지) |
| P0.9 DB baseline | ✅ | 0e1d8c0 (merge a78f172) · ac9fa6a | P2(quiz_api LOGIN 시 db-test 실패) → 반영 → 지적 없음 |
| M1.1 PDF fixtures | ✅ | eea3957 | 지적 없음. Noto Sans KR subset(OFL) 임베드 |
| P0.4 UI kit | ✅ | 66f6466 (merge 7bc9440, React 19.2.8로 정렬) · 12158b7 | P1(RSC client boundary 누락)·P2(숨김 요소로 Tab handoff) → 반영(RSC build fixture 추가) → 지적 없음 |
| A1.1 Supabase Auth local | ✅ | e8768f3 | 지적 없음 |
| P0.3b 토큰 보강 | ✅ | 9df4496 | 지적 없음. 대비 test 추가(light unseen/retry marker는 outline 필요 → M5.3) |
| M1.2 Docling parser | ✅ | 9cd16d6 · 408a015 · 1eda859 | P2×2 → 반영(`make test-models` 분리, RapidOCR 명시) → P2(OCR extra 설치 시 test 실패) → 반영 → 지적 없음 |
| P0.7 worker | ✅ | 981a1bf · bf6f99d · 2ef82be · e93724a · 3fc8089 | P1×2·P2 → reconciler/published_at/공용 redaction → P2(terminal cleanup 복구) → cleanup_pending 영속·재시도 → P2(SQLite 스키마 업그레이드) → 반영 → 지적 없음 |
| P0.10 E2E harness | ✅ | 776afac · a5a58e8 | P2×2(빈 spec 목록, 주석 test coverage 인정) → 반영(TS parser 기반) → 지적 없음 |
| M1.3 structure | ✅ | 1134994 · 21c35ce · a4bb8c1 · ea6fe4e · 54053a9 | P2×3 → 국소 규칙 수정이 회귀를 반복 → 전역 최소비용 할당 → 성능 회귀 → 구간 분할 DP(선형, brute force 동치 검증) → 지적 없음 |
| M1.4 chunker | ✅ | 1d77e08 · ac0c667 | P2×3(parent 문맥 누락, 문자 분할 복원 시 공백 삽입, breadcrumb가 max 초과) → 반영 → 지적 없음 |
| M5.3 heatmap 컴포넌트 | ✅ | aa1b2c5 · a05a82c | P2(단독 QuestionDot 모바일 32px 미적용) → 반영 → 지적 없음. visual test(darwin baseline) 포함 |
| A0 Auth RED | ✅ | c01a1e1 · 7c0c398 | RED 확인(24 AC + API 3 AC, 모두 기능 누락 원인). P2×2(로그인 재시도 이메일, 비-recovery reset) → 반영 → 지적 없음 |
| P0.8 core 골격 | ✅ | 163e9ea · bc78ce6 · 1c56c17 | P2(LLM 검증 오류에 원문 노출) → 반영 → P2(식별자형 key 노출) → 반영 → 지적 없음 |
| M1.5 core CLI | ✅ | da574d0 · ad9fd77 · b5b7493 · ab93574 | P2×2 → 반영 → P2(label 예외) → 반영 → P2(backslash userinfo 노출) → 원칙 변경: `--source-path`는 진단에 절대 출력하지 않음 → 지적 없음 |
| A1.2 JWT/JWKS·/me | ✅ | ad853a7 · 6183e77 · b8f7b8c | P2×2(JWKS 무제한 다운로드, 비정상 JWK로 500) → 반영 → 지적 없음. AUTH-API-AC01~03 GREEN(23 infra test) |
| M2.1 Qwen3 embedding | ✅ | 29022f4 | 지적 없음. seed KO↔EN 12/12 top-1, CPU ~0.94s/chunk(batch 8) |
| A2.1 web session | ✅ | 4fd7d51 · b44a7ec | AUTH-01·04·07 GREEN(44 E2E). P2(손상 cookie로 getClaims 예외) → 반영 → 지적 없음 |
| A1.3 authz layer | ✅ | 64db317 | 지적 없음. 권한 matrix 단일 표, 37 infra test |
| P0.7b PG JobStore | ✅ | 82dd792 · cca0e21 | P2(updated_at trigger가 고정 clock 덮어씀) → transaction-local 명시 signal + test 격리(scan 범위) → 지적 없음 |
| M2.2 Qdrant indexing | ✅ | 4833cb4 · 17c64b9 · e594988 | P1(alias 전환 미추종)·P2(BM25 설정 미반영) → 반영 → P2×2(해석 경합 retry, 수치 정규화) → 반영 → 지적 없음 |
| A2.2 auth screens | ✅ | ee64ec2 · 3507767 | AUTH-01~07 GREEN. P2×2(recovery marker 위조 가능, 미확인 주소 재전송 대상) → HMAC 서명 marker 등 → 지적 없음 |
| M4.1 question schema | ✅ | 00e6f21 · c9a1bea | P2×3(job FK workspace 범위, NULL 의미로 CHECK 우회 2건) → 반영 → 지적 없음. migration 170000·180000 orchestrator 적용 |
| M3.0 RED | ✅ | 71343ac · 0a454d1 | RED 확인(E2E 44, contract 10, `red` marker). P2×3(Hangul `\b`, 언어 판정 범위, 서버 chapter filter) → 반영 → 지적 없음 |
| A2.3 account security | ✅ | 1342644 | 지적 없음. **A0 phase GREEN** → CI `E2E_PHASES=P0.10,A0` |
| M2.3 hybrid search | ✅ | 4618c72 | 지적 없음. Qwen3 hybrid R@5 0.667 / semantic 0.917(양 책 동시 검색 시 RRF가 교차언어를 밀어냄 → M2.4/M2.6 튜닝) |
| M3.1a workspace API | ✅ | ad8d6f6 · 9d7634a | migration 190000 적용. P2(archive/restore idempotency) → 반영 → 지적 없음. WS-01-AC03~05 contract는 문서/검색 route 대기로 red |
| M4.0 RED | ✅ | e5a51e1 · 7f8ee11 · d8a5341 | RED 확인(M4 endpoint 미구현). P2×2 → 반영 → P2(부분 저장 전제) → 반영 → 지적 없음 |
| M2.5 ExcerptResolver | ✅ | dd296d7 · 7440a26 | P2(word window가 match 끝을 자름) → 반영 → 지적 없음 |
| A3 auth readiness | ◐ | e38a507 | CORS allowlist·CSP nonce·보안 header·prod guard. 기본 port 전체 auth E2E GREEN. P2×2(origin 직렬화, log-audit blocking) 수정 중 |
| M3.1b workspace UI | ◐ | 4453ab4 | WS-01 AC01·02·04 GREEN(AC03·05·06은 M3.2a/S1a 대기). P2×3(dialog lifecycle, focus 복귀, drawer) 수정 중 |
| M2.4 · M3.2a | ◐ | — | 진행 중 |
| M4.3 LLM·extractor | ✅ | d104c02 · 9b335a6 · a6cb4a2 | P1(보기 swap)·P2(세로 정답표) → 반영 → P1(원문자 숫자 crash 회귀) → decimal-only + never-raise property test(600 seed) → 지적 없음 |
| (통합) worktree 제외 설정 | ✅ | 6704d1c | 사소한 설정 수정, 리뷰 생략 |

Task 착수/완료 시 orchestrator(main thread)가 이 표에 행을 추가·갱신한다.
