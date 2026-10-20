# Quiz Workspace

PDF 책을 올려 원문을 다국어로 검색하고, 그 책을 바탕으로 문제를 모으고·만들고·풀어 보는 Workspace 플랫폼입니다. 범용 RAG 챗봇이 아니라 **근거 원문을 찾아 주는 검색**과 **사람이 검토·승인한 문제은행**에 집중합니다.

- Production: <https://quiz.red-10-proto.xyz> (staging은 `develop`, production은 `main`에서 배포)
- 설계 버전: v1.3 · 화면 21개 · Acceptance Criteria 107개 ([화면 명세 목록](docs/screens/index.md))

## 주요 기능

**Workspace**
- 책과 문제를 Workspace 단위로 관리합니다. 활성/보관 목록, 보관된 Workspace는 읽기 전용입니다.
- Workspace 안은 홈 한 화면입니다. 상단 header에 통합 검색과 `문서 n` · `문제은행` · `이력` · `공유하기`가 있고, 문서 관리·문제 PDF 관리·문제 생성·이력·링크 공유는 홈 위에 겹쳐 뜨는 Floating Dialog로 엽니다(나중에 연 dialog가 위).

**문서 (PDF)**
- 브라우저에서 Supabase Storage로 바로 업로드(TUS, 진행률·취소·재시도)하고, Worker가 Docling으로 구조를 분석해 계층형 청크로 나눈 뒤 색인합니다.
- 처리 단계(대기 → 준비 → 파싱 → 색인 → 게시)와 경과 시간을 목록에서 확인할 수 있습니다. 첫 처리 때 모델을 불러오는 cold start도 "처리 준비 중"으로 표시합니다.
- PDF를 보면서 추출된 원문을 교정하고 revision으로 게시합니다. Qdrant 색인은 PostgreSQL의 게시 revision에서 언제든 다시 만들 수 있습니다.

**검색**
- 문제와 원문을 한 검색창에서 찾습니다. 검색 옵션에서 범위(문제·내용), 검색 방식(키워드·의미·하이브리드), 문서·장 필터를 고릅니다.
- 다국어 Dense embedding(Qwen3-Embedding) + BM25 sparse를 RRF로 합치고 Reranker로 재정렬해 근거 발췌를 보여 줍니다. 검색 품질이 떨어진 경우(embedding 장애 등)는 배너로 알립니다.

**문제**
- 문제 PDF를 가져와 문제를 추출하고(문제 PDF 관리), 원문을 근거로 LLM이 변형 문제를 출제합니다. 생성·가져온 문제는 사람이 검토·승인하기 전까지 초안으로 남습니다.
- 문제은행에서 편집하고, 홈의 Heatmap에서 문제 하나 = 마커 하나로 상태(안 봄·봄·맞음·틀림·다시 풀기)를 봅니다. 즐겨찾기는 같은 색의 둥근 별입니다.
- Floating Side Panel에서 풀이합니다. 정답·해설은 제출 전에는 서버가 보내지 않고, 선택지는 표시 위치가 아닌 고정 ID로 채점합니다.

**이력·공유**
- 문서·문제 변경, 작업(job), 풀이 기록을 하나의 이력 목록으로 봅니다.
- Owner는 읽기 전용 공유 링크를 만들 수 있습니다(로그인 없이 열람, 링크 비밀값은 digest로만 저장). 허용한 경우 로그인한 수신자가 게시본을 독립 Workspace로 Fork할 수 있습니다(원본과 동기화하지 않고 개인 풀이 기록은 복제하지 않음).

**인증·보안**
- Supabase Auth(이메일 인증, 비밀번호 재설정, Cloudflare Turnstile CAPTCHA, 계정 보안 설정).
- FastAPI가 권한 경계입니다. 모든 요청은 JWT `sub`와 DB의 resource → workspace → membership으로 확인하며, 브라우저는 Supabase Data API·Qdrant·Redis에 직접 접근하지 않습니다.

## 구조

```text
[Next.js Web @ Vercel] ── REST/SSE (Bearer JWT) ── [FastAPI @ Railway]
                                   ├── Supabase PostgreSQL (원문·revision·문제·풀이·이력, 기준 저장소)
                                   ├── Supabase Storage (private: PDF, 파싱 산출물)
                                   ├── Redis ── [Celery Worker @ Railway] (파싱·색인·추출·생성·Fork)
                                   └── Core Python 패키지 ── Qdrant Cloud (재생성 가능한 검색 색인)
```

| 경로 | 내용 |
|---|---|
| `apps/web` | Next.js(App Router) 웹 앱 |
| `apps/api` | FastAPI 서비스(인증·권한, Workspace·문서·문제·검색·공유 API) |
| `apps/worker` | Celery Worker(문서 처리, 문제 가져오기·생성, Fork, 정리 작업) |
| `packages/core` | Python Core: 파싱, 청킹, embedding, 검색·rerank, 문제 추출·변형, 평가 |
| `packages/ui` · `packages/design-tokens` | 디자인 시스템(Radix 기반 컴포넌트, semantic token) · Storybook |
| `packages/api-client` | OpenAPI(`contracts/openapi.json`)에서 생성한 TS 클라이언트(직접 수정 금지) |
| `supabase/migrations` | 유일한 DB migration 소유자(pgTAP 테스트는 `supabase/tests`) |
| `tests/e2e` · `tests/integration` | Playwright E2E(제목이 AC ID로 시작) · 실제 스택 통합 테스트 |
| `eval/` | 검색·생성 품질 평가(실제 모델) |

## 로컬에서 실행하기

**준비물:** Node 24(`.nvmrc`), pnpm 10, [uv](https://docs.astral.sh/uv/), Python 3.12, Docker.

1. 설치와 환경 파일
   ```bash
   make install          # pnpm install + uv sync
   cp .env.example .env  # 로컬 값. 커밋하지 않습니다
   ```
2. 인프라(Qdrant, Redis, Supabase 로컬 스택)
   ```bash
   make infra-up         # Auth 서명 키도 생성
   make infra-status     # 상태와 Supabase 로컬 URL
   ```
   처음 띄운 뒤와 `make db-reset` 뒤에는 최소 권한 DB role의 로그인을 켭니다(로컬 전용 비밀번호).
   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
     -c "alter role quiz_api with login password 'change-me-local'" \
     -c "alter role quiz_worker with login password 'change-me-local'"
   ```
3. 앱 실행(터미널 3개)
   ```bash
   make api-dev      # FastAPI   http://127.0.0.1:8000
   make worker-dev   # Celery worker (PDF 처리 등)
   make web-dev      # Next.js   http://127.0.0.1:3000
   ```
   production 빌드로 띄우려면 web을 `pnpm --filter @quiz/web build && pnpm --filter @quiz/web start`로 실행합니다. `make images`는 api·worker·web Docker 이미지를 로컬 태그로 빌드합니다(push 없음).

**참고**
- Worker는 `WORKER_PARSER`/`WORKER_EMBEDDER`(`auto`·`docling`/`qwen3`·`fake` 등)로 어댑터를 고릅니다. 실제 Docling·Qwen3를 쓰면 첫 처리 때 모델(수백 MB)을 내려받습니다. `APP_ENV=test`는 E2E용 결정적 fake 어댑터를 씁니다.
- 회원가입·비밀번호 재설정 메일은 로컬 Supabase의 Mailpit(`make infra-status`에 URL 표시)에서 확인합니다.
- 인프라 정지: `make infra-down`(데이터 유지) / `make infra-reset`(로컬 데이터 삭제).

## 테스트와 품질 검사

```bash
make lint           # eslint + prettier + ruff + contracts-check
make typecheck      # tsc + mypy
make test           # Vitest + pytest (오프라인, 모델 없이)
make test-infra     # 실행 중인 스택 대상 통합 테스트
make db-test        # pgTAP
make e2e            # Playwright (web을 빌드·실행, @infra spec은 infra-up 필요)
make e2e-trace      # AC ↔ 테스트 추적(누락·고아 검사)
make test-models    # 실제 Docling 모델 테스트
```

CI(`.github/workflows/ci.yml`)는 lint·typecheck·unit, DB·infra·E2E·restore, 이미지 빌드, Storybook·앱 visual regression을 실행합니다. `develop` push는 CI 통과 후 staging에 자동 배포되고, production은 `main`에서 승인 후 수동 배포합니다([배포 runbook](docs/runbook-deploy.md)).

## 개발 방식

- **화면 명세 → 실패하는 Playwright E2E(RED) → 구현(GREEN) → Codex 리뷰** 순서로 Task 단위로 진행합니다. Task 계층·의존 그래프·결정 기록·진행 현황은 [구현 계획](docs/implementation-plan.md)에 있습니다.
- 브랜치: `task/*` → `feature/*` → `develop` → `main` 단방향으로만 merge하고, `develop`·`main`에는 PR로만 들어갑니다. 작업 규칙 전체는 [AGENTS.md](AGENTS.md)를 따릅니다.

## 설계 문서

- [아키텍처](docs/architecture.md) · [구현 계획](docs/implementation-plan.md)
- [인증](docs/auth.md) · [Workspace 공유·Fork 및 보안](docs/workspace-sharing.md)
- [Questions](docs/questions.md) · [디자인 시스템](docs/design-system.md)
- [배포](docs/deployment.md) · [배포 runbook](docs/runbook-deploy.md) · [E2E 전략](docs/e2e-strategy.md)
- [화면별 명세 목록](docs/screens/index.md)
