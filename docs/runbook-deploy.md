# Deployment Runbook — v1.0 (M7.4a, Platform v1.2)

**상태:** 계정 없이 준비 완료(M7.4a), 실제 배포는 M7.4  
**연계:** `deployment.md`(설계 기준), `auth.md` §5, `implementation-plan.md` §7·§8  
**결정(2026-10-18, 사용자):** 구성 **A**(Vercel web + Supabase + Railway api/worker/Redis + Qdrant Cloud). **staging 먼저** 배포하고, production은 staging 7일 부하 시험·비용 게이트 통과 후 진행한다. Supabase는 **환경마다 별도 project**(지금은 staging만, production은 나중), Supabase branching은 쓰지 않는다.

이 문서는 사용자가 직접 수행하는 단계(계정, secret 생성·입력, 첫 배포, 롤백)를 순서대로 적는다. 저장소에 들어 있는 것:

| 파일 | 역할 |
|---|---|
| `apps/web/vercel.json` | Vercel 빌드 설정(Root Directory `apps/web`, git 자동 배포 끔) |
| `infra/deploy/railway-services.toml` | Railway api/worker 배포 설정(이미지 CMD, healthcheck, restart, replica, volume 경로) |
| `supabase/config.toml` `[remotes.staging]` / `[remotes.production]` | hosted Auth 설정 delta(site_url, redirect, SMTP, rate limit) |
| `infra/deploy/env-manifest.toml` | 서비스·환경별 변수 전체 목록(공개/비밀, 필수/선택/금지, 제공자) |
| `scripts/check_env.py` (`make check-env`) | env 파일 검증(값은 출력하지 않음), `--template`으로 빈 양식 생성 |
| `.github/workflows/deploy.yml` | 수동 배포: preflight → 이미지(digest) → migration → Railway → Vercel → smoke |
| `scripts/deploy/railway_deploy.py` | Railway 서비스를 이미지 digest로 갱신·배포·SUCCESS 대기 |
| `tests/smoke/` (`make smoke-local`, `make smoke-staging`) | DEP-01~07 자동 점검 |

> secret 값은 저장소·이슈·채팅에 쓰지 않는다. 생성한 값은 password manager에 보관하고 각 플랫폼 화면에 직접 붙여 넣는다. 로컬에서 env 파일을 만들 때는 저장소 밖(예: `~/secure/quiz/`)에 두고 `chmod 600`.

## 1. 계정·프로젝트 만들기 (staging)

순서대로 진행한다. 지역(region)은 **Singapore**로 맞춘다(사용자 결정 2026-10-18): Supabase `ap-southeast-1`, Railway `asia-southeast1-eqsg3a`(Railway에는 Tokyo 지역이 없음), Vercel function region은 Singapore(`sin1`)를 권장한다(Vercel project Settings → Functions; 아직 확정 아님).

1. **SMTP 제공자**: 발신 도메인을 등록하고 SPF·DKIM(가능하면 DMARC) DNS를 설정한다. SMTP host/port 587/user/password(API key), 발신 주소를 받는다.
2. **Supabase**: staging project는 생성됨 — ref `jpyupavjpmlxtuolrvvs`, 지역 Singapore(`ap-southeast-1`), `supabase/config.toml`의 `[remotes.staging] project_id`에 반영됨(ref는 secret 아님). DB 비밀번호는 `openssl rand -hex 32`로 재설정해 두고 password manager에 보관한다. URL은 `https://jpyupavjpmlxtuolrvvs.supabase.co`.
3. **Qdrant Cloud**: staging cluster 생성(Free tier는 개발·테스트 전용, deployment.md §8), API key 발급, cluster URL(`https://…:6333`).
4. **Railway**: project(staging project는 생성됨), environment `staging`. 서비스 3개 모두 Settings → Deploy → Regions에서 `asia-southeast1-eqsg3a`(Singapore)로 둔다(`infra/deploy/railway-services.toml` `[project] region`; 배포 script는 region을 바꾸지 않음):
   - `Redis`(Railway Redis 템플릿). public TCP proxy는 만들지 않는다.
   - `api`: **Empty Service**(소스는 배포 workflow가 이미지 digest로 지정). Settings → Networking → public domain 생성(→ `NEXT_PUBLIC_API_BASE_URL`, `SMOKE_API_URL`). Volume을 `/var/cache/huggingface`에 연결.
   - `worker`: Empty Service, public domain 없음, Volume `/var/cache/huggingface`.
   - Project Settings → Tokens: **staging environment용 project token**(→ `RAILWAY_TOKEN`). 각 서비스·environment id(→ `RAILWAY_*_ID`).
   - 이미지 pull: GHCR package를 public으로 두거나(이미지에는 코드만 있고 secret 없음), private이면 Railway 서비스 설정의 registry credential(플랜 확인)에 GHCR read-only token을 넣는다 — **사용자 결정**.
5. **Vercel**: GitHub repo import → Root Directory `apps/web`, Framework Next.js, Node 24. `vercel.json`이 git 자동 배포를 끄므로 배포는 workflow만 한다. staging 도메인(예: `staging.quiz.example`)을 project에 추가(production branch에 연결하지 않음; workflow가 preview 배포에 alias). Team id / Project id(→ `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`), Account → Tokens에서 만료가 있는 token(→ `VERCEL_TOKEN`).
   - Deployment Protection(Vercel Authentication)이 staging 도메인을 막으면 smoke와 사용자가 401을 받는다. staging 도메인에 대해 끌지 여부는 **사용자 결정**(staging 데이터는 합성 계정만 사용).
6. **GitHub**: Settings → Environments → `staging`(deployment branches: `develop`, `main`). production environment는 비용 게이트 후 만든다(§9).
7. **Cloudflare (Workers AI embedding, M7.4b)**: Cloudflare 계정을 만들고 Workers **Free** plan으로 둔다(하루 10,000 neurons, 초과 시 오류; deployment.md §8).
   - Account ID: dashboard → Workers & Pages → 우측 Account details(또는 URL의 `/<account id>/`) → `CLOUDFLARE_ACCOUNT_ID`(secret은 아니지만 저장소에 쓰지 않음).
   - API token: My Profile → API Tokens → Create Token → **Custom token**, 권한은 **Workers AI만**(Cloudflare 문서의 "Workers AI" template = Account · Workers AI · Read + Edit; 다른 권한·zone 권한은 넣지 않는다. Read만으로 `ai/run`이 되는지는 첫 parity 실행에서 확인하고 되면 Edit를 뺀다), Account Resources는 이 account 하나, 만료일 지정, client IP 제한 없음(Railway egress IP가 고정이 아님) → `CLOUDFLARE_API_TOKEN`.
   - 보관: 두 값을 `~/.secrets/quiz-workspace/staging/cloudflare.env`(`chmod 600`, 저장소 밖)에 `CLOUDFLARE_ACCOUNT_ID=…`, `CLOUDFLARE_API_TOKEN=…`로 저장하고 Railway `api`·`worker` 변수에 넣는다(Vercel 금지). 채팅·이슈에 붙이지 않는다.
   - `WORKER_EMBEDDER=workers_ai`를 Railway `api`·`worker` 양쪽에 같은 값으로 둔다(check-env `same`).
   - 이 모드에서 API는 모델을 읽지 않으므로 `api`의 `/var/cache/huggingface` volume은 필요 없다(worker는 Docling 모델 때문에 유지).

## 2. Secret 생성

| 변수 | 생성 방법 | 넣는 곳 |
|---|---|---|
| `AUTH_RECOVERY_MARKER_SECRET` | `openssl rand -base64 48` (환경마다 다르게) | Vercel (Preview=staging) |
| `RELAY_CLIENT_SECRET` | `openssl rand -base64 48` (web·api **같은 값**, 환경마다 다르게) | Vercel + Railway `api` |
| `SHARE_SESSION_SECRET` | `openssl rand -base64 48` (환경마다 다르게) | Railway `api` |
| `quiz_api` / `quiz_worker` DB 비밀번호 | `openssl rand -hex 32` (hex: URL percent-encoding 불필요) | `DATABASE_URL` / `WORKER_DATABASE_URL` |
| Supabase DB(postgres) 비밀번호 | project 생성 시 `openssl rand -hex 32` | GitHub `SUPABASE_DB_URL`, ops |
| `SUPABASE_SECRET_KEY` | Supabase → API Keys → secret key | Railway `api`, `worker` (Vercel 금지) |
| `QDRANT_API_KEY` | Qdrant Cloud | Railway `api`, `worker` |
| `REDIS_URL` | Railway reference variable `${{Redis.REDIS_URL}}` | Railway `api`, `worker` |
| `SUPABASE_AUTH_SMTP_*` | SMTP 제공자 | `config push` 셸에서만 |
| `SUPABASE_ACCESS_TOKEN` | Supabase → Account → Access Tokens (운영자 전용, CI에 넣지 않음) | `config push` 셸에서만 |
| `VERCEL_TOKEN`, `RAILWAY_TOKEN`, `SUPABASE_DB_URL` | 위 1장 | GitHub Environment secrets |
| `SMOKE_USER_{A,B}_{EMAIL,PASSWORD}` | 3장 5단계의 smoke 계정 | GitHub Environment secrets |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | 1장 7단계(Workers AI Read 권한만의 custom token) | Railway `api`, `worker` (Vercel 금지; `WORKER_EMBEDDER=workers_ai`일 때 필수) |
| `LLM_API_KEY`, `LLM_MODEL` | LLM 제공자(선택, **사용자 결정**: 비용·데이터 정책) | Railway `worker` |

서비스별 전체 목록과 기본값은 manifest가 기준이다:

```bash
uv run python scripts/check_env.py --list --service api
uv run python scripts/check_env.py --env staging --template api    > ~/secure/quiz/api.staging.env
uv run python scripts/check_env.py --env staging --template worker > ~/secure/quiz/worker.staging.env
uv run python scripts/check_env.py --env staging --template web    > ~/secure/quiz/web.staging.env
# 값을 채운 뒤(파일은 저장소 밖), 플랫폼에 넣기 전에 함께 검증한다:
make check-env ENV=staging ARGS="--check api=$HOME/secure/quiz/api.staging.env \
  --check worker=$HOME/secure/quiz/worker.staging.env --check web=$HOME/secure/quiz/web.staging.env"
```

검증은 필수 누락, `https://` 아님, CORS wildcard·path, 32자 미만 HMAC key, 공개 key/secret key 바뀜, fake adapter·test 전용 변수(`WORKER_TASK_ALWAYS_EAGER`, `FORWARDED_ALLOW_IPS`, `RAILWAY_RUN_UID` 등), manifest에 없는 `NEXT_PUBLIC_*`, web·api의 `RELAY_CLIENT_SECRET` 불일치를 오류로 낸다. 출력에는 변수 이름만 나온다.

주요 값:

- `APP_ENV=preview`(staging; production은 `production`) — web·api·worker 모두.
- `CORS_ALLOWED_ORIGINS` = `WEB_ORIGIN` = staging web origin(`https://staging.quiz.example`, ASCII/punycode).
- `SUPABASE_JWT_ISSUER=https://<ref>.supabase.co/auth/v1`, `SUPABASE_JWKS_URL=…/auth/v1/.well-known/jwks.json`, `SUPABASE_URL=https://<ref>.supabase.co`.
- `DATABASE_URL`/`WORKER_DATABASE_URL`: Supabase **session pooler**(IPv4) URL, 사용자 이름은 `quiz_api.<ref>` / `quiz_worker.<ref>`.
- `RELAY_CLIENT_IP_HEADER=x-real-ip`(Vercel이 client 주소로 덮어씀).
- `WORKER_MODELS_OFFLINE=false`로 시작, HF_HOME volume에 모델이 받아진 뒤 `true`.

## 3. 첫 staging 배포 순서

1. **Migration(최초 1회는 수동)**: role 비밀번호를 migration 뒤에 설정해야 API readiness가 통과하므로 첫 migration은 운영자가 직접 적용한다.
   ```bash
   export SUPABASE_DB_URL='postgresql://postgres.<ref>:<db password>@<pooler host>:5432/postgres'
   pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" --dry-run
   pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"
   psql "$SUPABASE_DB_URL" -c "alter role quiz_api with login password '<hex>'"
   psql "$SUPABASE_DB_URL" -c "alter role quiz_worker with login password '<hex>'"
   ```
   이후 migration은 workflow가 rollout 전에 적용한다(`db push`는 role을 다시 만들지 않으므로 login은 유지).
2. **Auth 설정 push**(SMTP·site_url·redirect·rate limit·메일 템플릿):
   ```bash
   set -a; . ~/secure/quiz/supabase-config.staging.env; set +a   # SUPABASE_ACCESS_TOKEN, SUPABASE_AUTH_*
   uv run python scripts/check_env.py --env staging --check supabase-config=-
   pnpm exec supabase config push --project-ref jpyupavjpmlxtuolrvvs
   ```
   Dashboard에서 확인·설정: JWT signing key를 비대칭(ES256)으로 rotate, access token 만료 3600s, Storage bucket `source-pdfs`·`parsed-artifacts`가 private, Auth → URL Configuration의 redirect 목록이 `https://<web>/auth/callback` 하나뿐인지.
3. **Railway / Vercel 변수 입력**: 2장에서 검증한 값만 넣는다.
4. **GitHub Environment `staging`**: secrets `SUPABASE_DB_URL`, `VERCEL_TOKEN`, `RAILWAY_TOKEN`, `SMOKE_USER_*`; variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID`, `RAILWAY_WORKER_SERVICE_ID`, `WEB_ORIGIN`, `SMOKE_API_URL`, `SMOKE_SUPABASE_URL`, `SMOKE_SUPABASE_PUBLISHABLE_KEY`, (선택) `SMOKE_QDRANT_URL`. Repository variable `VERCEL_CLI_VERSION`(2주 이상 지난 정확한 `x.y.z`).
5. **첫 workflow 실행(bootstrap)**: smoke 계정은 staging 화면에서 가입해야 하므로 첫 실행만 Actions → Deploy → `environment=staging`, **`bootstrap=true`**(ref `develop` 또는 `main`). preflight가 `SMOKE_USER_*`를 요구하지 않고, smoke는 `@readonly` 점검만 실행하며 run에 BOOTSTRAP 경고가 남는다. 이 run은 배포 완료로 보지 않는다. 누락 이름이 출력되면 채우고 다시 실행. `bootstrap`은 staging에서만 허용된다.
6. **Smoke 계정 → 정식 실행**: staging 화면에서 실제 메일함으로 두 번 가입·메일 확인(SMTP와 DEP-01 가입 흐름 확인) → GitHub secrets `SMOKE_USER_{A,B}_*`에 넣고 **`bootstrap` 없이** workflow를 다시 실행(전체 smoke: DEP-01 로그인, DEP-02 업로드 객체, DEP-05). 이후 배포는 항상 bootstrap 없이 실행한다. (Supabase Admin으로 계정을 미리 만드는 방법은 secret key를 운영자 셸에 꺼내야 하고 실제 메일 흐름을 건너뛰므로 쓰지 않는다.)
7. **수동 DEP 점검**(4장).
8. **HF_HOME volume**: 첫 검색·파싱 후 모델이 volume에 남는지 확인하고 `WORKER_MODELS_OFFLINE=true`. 비root(uid 10001)가 volume에 쓰지 못하면 `RAILWAY_RUN_UID=0`을 쓰지 말고 volume 없이(재시작마다 다운로드) 운영하면서 기록한다.
9. **Workers AI parity·eval(첫 staging 배포 때 1회, M7.4b)**: 운영자 셸에서만 실행한다(합성 KO/EN 텍스트만 전송, 책 원문 없음).
   ```bash
   set -a; . ~/.secrets/quiz-workspace/staging/cloudflare.env; set +a
   make test-workers-ai     # 로컬 Qwen3(HF_HOME) vs Workers AI cosine parity + 오류 계약; 자격 없으면 실패(skip 아님)
   make eval-workers-ai     # eval/configs/workers-ai.json(1024차원, rerank off) → eval/reports/seed-workers-ai.{json,md}
   ```
   parity가 실패하면(평균 cosine 기준 미달) 요청 형식(`documents` / `queries`+`instruction`) 가정을 먼저 확인하고 결과를 implementation-plan §7에 기록한다. Cloudflare dashboard → AI → Workers AI에서 neuron 사용량을 확인해 deployment.md §8의 환산을 갱신한다.
10. **7일 부하·비용 측정**(deployment.md §8): worker RAM/CPU, 검색 지연, Supabase·Qdrant 사용량 → 비용 게이트 판단.

## 4. Staging smoke (DEP-01~07)

```bash
export SMOKE_TARGET=staging E2E_BASE_URL=https://staging.quiz.example \
  SMOKE_API_URL=https://<api domain> SMOKE_SUPABASE_URL=https://jpyupavjpmlxtuolrvvs.supabase.co \
  SMOKE_SUPABASE_PUBLISHABLE_KEY=<publishable> SMOKE_QDRANT_URL=https://<cluster>:6333
# SMOKE_USER_{A,B}_{EMAIL,PASSWORD}는 password manager에서 셸로만 export
make smoke-staging
```

로컬 리허설: `make smoke-local`(infra-up 필요; web/API/worker를 띄우고 로그 검사까지). trace·스크린샷·HTML report는 만들지 않는다.

| ID | 자동(local·staging) | staging 전용 자동 | 수동 |
|---|---|---|---|
| DEP-01 | CORS 허용/거부, Auth 메일 확인 필수·email만, UI 로그인 + 외부 `next` 차단, session cookie 속성 | HTTPS·HSTS·http→https | 비밀번호 재설정 메일 수신 → 링크 → 새 비밀번호 로그인 (실제 메일함) |
| DEP-02 | 익명 public/direct/list/upload 거부, 사용자 JWT로 Storage 직접 접근 거부, signed URL 발급은 인증 필요 | — | — |
| DEP-03 | `SMOKE_DEP03_PHASE=seed` → 재시작 → `=verify` (로컬은 `make smoke-local` 두 번) | 같음 | Railway에서 api·worker **Restart** 후 verify |
| DEP-04 | CI E2E(`APP_ENV=test` 실패 marker)로 검증 | — | staging에서 재파싱 실패 시 이전 published revision 검색 확인(UI) |
| DEP-05 | 다른 사용자 404(문서·업로드·검색·문제·풀이·job·삭제), 무토큰 401 | — | — |
| DEP-06 | CI rehearsal(backup → reset → restore → reindex) | — | staging `make backup` → **빈** 대상(로컬 또는 임시 project)에 `make restore ARGS="--yes --reindex"` |
| DEP-07 | Data API 테이블 비노출(anon·사용자), API/web 보안 header, BFF CSRF 403, readiness 비노출, bundle에 server secret·비-anon JWT 없음, 로컬은 서버 로그 검사 | Qdrant 무키 접근 거부 | Railway·Vercel 로그 export 후 `pnpm e2e:log-audit --scan api.log --scan worker.log --scan web.log`; Redis public proxy 없음 확인 |

DEP-03 staging:

```bash
SMOKE_DEP03_PHASE=seed   make smoke-staging ARGS="--grep DEP-03"   # 실제 Docling 파싱, 첫 실행은 모델 다운로드로 수 분
# Railway: api, worker → Restart
SMOKE_DEP03_PHASE=verify make smoke-staging ARGS="--grep DEP-03"   # 확인 후 workspace 삭제(SMOKE_KEEP=1이면 유지)
```

smoke 계정의 workspace는 API에서 soft-delete만 되므로 누적된다(합성 데이터). 필요하면 staging DB에서 smoke 계정 소유 workspace만 정리한다.

## 5. 롤백

- **Web**: Vercel → Deployments → 이전 배포 **Instant Rollback**(staging은 이전 배포에 alias 재지정).
- **API/Worker**: Railway → 서비스 → Deployments → 이전 배포 **Rollback**. 또는 이전 commit에서 workflow를 `skip_migrations=true`로 실행(이전 commit에는 최신 migration 파일이 없어 `db push`가 실패하므로).
- **DB**: migration은 additive-first(deployment.md §5)라 이전 코드가 새 schema에서 동작한다. down migration은 없다: 문제는 forward fix migration으로 고친다. 데이터 손상 시에만 DEP-06 절차로 **빈 대상**에 restore 후 전환한다.
- **Qdrant**: 파생 인덱스이므로 `make reindex ARGS="--all"`(worker 이미지에서 `python -m quiz_worker.reindex`)로 재구축.

## 6. Production (게이트 후)

staging 7일 부하·비용 게이트를 통과한 뒤에만 진행한다. workflow는 repository variable `PRODUCTION_DEPLOY_ENABLED=true`가 없으면 production을 preflight에서 거부한다.

1. Supabase production project를 **새로** 만든다(staging과 공유하지 않음, branching 미사용). ref를 `[remotes.production] project_id`(`replaceproductionref`)에 넣는다.
2. 1~3장을 production 값으로 반복(모든 HMAC secret은 새로 생성, Qdrant·Railway·Vercel production 환경, `APP_ENV=production`).
3. GitHub Environment `production`: deployment branch `main`만, required reviewers 지정. smoke 계정 secrets는 필요 없다(`@readonly` 점검만 실행).
4. `PRODUCTION_DEPLOY_ENABLED=true` 설정 → Deploy workflow `environment=production`(ref `main`) → 승인.
5. 운영 확인: 실제 메일로 가입·재설정 1회, 백업 정책(플랜의 일일 백업 + `make backup`), 예산 알림.

## 7. 남은 사용자 결정

- 플랜·비용: Vercel(Hobby는 비상업 제한), Supabase(Free는 pause·메일 제한), Railway 사용량, Qdrant(Free는 테스트 전용). 비용 게이트 기준(7일 측정 후).
- 도메인(web·api·staging), SMTP 제공자와 발신 도메인. (지역은 Singapore로 결정됨.)
- GHCR 이미지 공개 여부 vs Railway registry credential.
- staging 도메인의 Vercel Deployment Protection.
- LLM 사용 여부·모델·예산(`LLM_API_KEY`/`LLM_MODEL`; 미설정 시 문제 생성 비활성).
- `/terms`, `/privacy` 실제 문구(현재 placeholder).
- CAPTCHA: 문서(§6.1)는 Auth CAPTCHA를 요구하지만 web에 CAPTCHA 위젯이 없어 켜면 가입·로그인이 깨진다 → 별도 Task로 구현 후 활성화.

## 8. 첫 staging 배포에서 확인할 가정

- Workers AI `@cf/qwen/qwen3-embedding-0.6b` 입력 형식(`documents` 배열, query는 `queries` + `instruction`)과 출력(`result.data`, 1024차원)이 adapter 가정과 같은지(3장 9단계 parity), 한 요청 batch 상한(기본 `CLOUDFLARE_AI_BATCH_SIZE=16`), Free plan quota 초과 응답의 status/code(adapter는 429와 quota 관련 오류 code를 `embedding_quota_exceeded`로 분류).

- Railway GraphQL(`serviceInstanceUpdate`, `serviceInstanceDeployV2`, `deployment`)과 `Project-Access-Token` header — 실패 시 `railway_deploy.py`가 단계 이름과 Railway 메시지를 출력한다.
- Railway volume이 uid 10001에 쓰기 가능한지(3장 8단계).
- Vercel이 `x-real-ip`를 client 주소로 덮어쓰는지(공유 링크 rate limit의 client 구분).
- Supabase session pooler로 `quiz_api.<ref>`/`quiz_worker.<ref>` 로그인, GitHub runner(IPv4)에서 `db push`.
- `supabase config push`가 `[remotes.staging]`을 적용하는지(`--project-ref`가 `project_id`와 같아야 함).
