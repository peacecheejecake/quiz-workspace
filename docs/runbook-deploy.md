# Deployment Runbook — v1.0 (M7.4a, Platform v1.2)

**상태:** 계정 없이 준비 완료(M7.4a), 실제 배포는 M7.4  
**연계:** `deployment.md`(설계 기준), `auth.md` §5, `implementation-plan.md` §7·§8  
**결정(2026-10-18, 사용자):** 구성 **A**(Vercel web + Supabase + Railway api/worker/Redis + Qdrant Cloud). Supabase는 **환경마다 별도 project**, Supabase branching은 쓰지 않는다.  
**결정(2026-10-19, 사용자, M7.4p):** staging 7일 부하·비용 게이트를 **면제**하고 production을 지금 배포한다. **staging = `develop`**(CI GREEN 후 자동 배포, 수동 dispatch도 `develop`만), **production = `main`**(수동 dispatch + GitHub Environment `production` 승인). production web origin `https://quiz.red-10-proto.xyz`(staging과 **별도 Vercel project**), Railway는 같은 project의 environment `production`, Qdrant는 staging과 같은 Free cluster를 `QDRANT_COLLECTION_PREFIX=prod_`로 분리, Supabase는 새 Singapore project.

이 문서는 사용자가 직접 수행하는 단계(계정, secret 생성·입력, 첫 배포, 롤백)를 순서대로 적는다. 저장소에 들어 있는 것:

| 파일 | 역할 |
|---|---|
| `apps/web/vercel.json` | Vercel 빌드 설정(Root Directory `apps/web`, git 자동 배포 끔) |
| `infra/deploy/railway-services.toml` | Railway api/worker 배포 설정(이미지 CMD, healthcheck, restart, replica, volume 경로) |
| `supabase/config.toml` `[remotes.staging]` / `[remotes.production]` | hosted Auth 설정 delta(site_url, redirect, SMTP, rate limit, Turnstile CAPTCHA) |
| `infra/deploy/env-manifest.toml` | 서비스·환경별 변수 전체 목록(공개/비밀, 필수/선택/금지, 제공자) |
| `scripts/check_env.py` (`make check-env`) | env 파일 검증(값은 출력하지 않음), `--template`으로 빈 양식 생성 |
| `.github/workflows/deploy.yml` | 배포(staging: `develop` CI 후 자동·수동, production: `main` 수동): preflight → 이미지(digest) → migration → Railway → Vercel → smoke |
| `scripts/deploy_prepare.py` (`make deploy-prepare`) | 한 ref의 배포 준비 점검 + 로컬 이미지 빌드(배포·원격 변경 없음, 4장 "배포 준비 점검") |
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
6. **Cloudflare Turnstile**(Auth CAPTCHA, auth.md §5.1): 가입·로그인·인증 메일 재전송·재설정 메일 요청은 Turnstile 토큰이 있어야 Supabase Auth가 받아 준다. web의 sitekey와 Supabase의 secret은 **같은 widget에서 나온 한 쌍**이어야 한다(한쪽만 바뀌면 모든 가입·로그인이 실패).
   - **staging 기본: Cloudflare 공식 테스트 키 쌍** — sitekey `1x00000000000000000000AA`(항상 통과, 위젯 표시), secret `1x0000000000000000000000000000000AA`(항상 통과, dummy token만 수락). 실제 위젯·실제 Supabase 검증 경로를 그대로 타면서 smoke 계정의 자동 로그인(`tests/smoke`가 dummy token을 보냄)이 가능하다. 봇 방어는 없으므로 staging 도메인을 공개 홍보하지 않는다.
   - staging에 실제 키를 쓰려면(선택) 아래 production과 같은 방법으로 staging 전용 widget을 만든다. 그러면 DEP smoke의 로그인 단계(DEP-01 UI 로그인, password grant)는 자동으로 통과하지 못하므로 수동 점검으로 바꾼다.
   - **production**: Cloudflare dashboard → Turnstile → **Add widget**: 이름 `quiz-production`, **Hostname management**에 production web 도메인만(`quiz.red-10-proto.xyz`; wildcard·`localhost`·preview 도메인 넣지 않음), Widget mode **Managed**, pre-clearance **No**. 발급된 **Site Key**(`0x…`, 공개) → Vercel `NEXT_PUBLIC_TURNSTILE_SITE_KEY`(Production), **Secret Key**(`0x…`, 비밀) → `config push` 셸의 `SUPABASE_AUTH_CAPTCHA_SECRET`. production은 테스트 키를 넣으면 `check_env.py`가 거부한다.
7. **GitHub**: Settings → Environments → `staging` → Deployment branches and tags → **Selected branches** → `develop` **하나만**(`main`은 지운다; 사용자 결정 2026-10-19). `develop` push의 CI가 GREEN이면 CI의 `deploy-staging` job이 이 environment로 자동 배포하므로 staging에는 required reviewers를 두지 않는다(두면 매 push마다 승인 대기). workflow preflight도 staging은 `refs/heads/develop`만 허용한다. production environment는 §6.
8. **Cloudflare (Workers AI embedding, M7.4b)**: Cloudflare 계정을 만들고 Workers **Free** plan으로 둔다(하루 10,000 neurons, 초과 시 오류; deployment.md §8).
   - Account ID: dashboard → Workers & Pages → 우측 Account details(또는 URL의 `/<account id>/`) → `CLOUDFLARE_ACCOUNT_ID`(secret은 아니지만 저장소에 쓰지 않음).
   - API token: My Profile → API Tokens → Create Token → **Custom token**, 권한은 **Workers AI만**(Cloudflare 문서의 "Workers AI" template = Account · Workers AI · Read + Edit; 다른 권한·zone 권한은 넣지 않는다. Read만으로 `ai/run`이 되는지는 첫 parity 실행에서 확인하고 되면 Edit를 뺀다), Account Resources는 이 account 하나, 만료일 지정, client IP 제한 없음(Railway egress IP가 고정이 아님) → `CLOUDFLARE_API_TOKEN`.
   - 보관: 두 값을 `~/.secrets/quiz-workspace/staging/cloudflare.env`(`chmod 600`, 저장소 밖)에 `CLOUDFLARE_ACCOUNT_ID=…`, `CLOUDFLARE_API_TOKEN=…`로 저장하고 Railway `api`·`worker` 변수에 넣는다(Vercel 금지). 채팅·이슈에 붙이지 않는다.
   - `WORKER_EMBEDDER=workers_ai`를 Railway `api`·`worker` 양쪽에 같은 값으로 둔다(check-env `same`).
   - 이 모드에서 API는 모델을 읽지 않고, worker의 Docling 모델은 image에 들어 있으므로(WRK-BAKE, `/opt/docling-models`) `api`·`worker` 모두 `/var/cache/huggingface` volume이 필요 없다.

## 2. Secret 생성

| 변수 | 생성 방법 | 넣는 곳 |
|---|---|---|
| `AUTH_RECOVERY_MARKER_SECRET` | `openssl rand -base64 48` (환경마다 다르게) | Vercel (staging project의 Preview / production project의 Production) |
| `RELAY_CLIENT_SECRET` | `openssl rand -base64 48` (web·api **같은 값**, 환경마다 다르게) | Vercel + Railway `api` |
| `SHARE_SESSION_SECRET` | `openssl rand -base64 48` (환경마다 다르게) | Railway `api` |
| `quiz_api` / `quiz_worker` DB 비밀번호 | `openssl rand -hex 32` (hex: URL percent-encoding 불필요) | `DATABASE_URL` / `WORKER_DATABASE_URL` |
| Supabase DB(postgres) 비밀번호 | project 생성 시 `openssl rand -hex 32` | GitHub `SUPABASE_DB_URL`, ops |
| `SUPABASE_SECRET_KEY` | Supabase → API Keys → secret key | Railway `api`, `worker` (Vercel 금지) |
| `QDRANT_API_KEY` | Qdrant Cloud | Railway `api`, `worker` |
| `REDIS_URL` | Railway reference variable `${{Redis.REDIS_URL}}` | Railway `api`, `worker` |
| `SUPABASE_AUTH_SMTP_*` | SMTP 제공자 | `config push` 셸에서만 |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | 1장 6단계(staging: 테스트 sitekey, production: widget Site Key). 공개 값, build 시 inline | Vercel (staging project의 Preview / production project의 Production) — 값을 바꾸면 **재배포**해야 반영 |
| `SUPABASE_AUTH_CAPTCHA_SECRET` | 1장 6단계(staging: 테스트 secret, production: widget Secret Key) | `config push` 셸에서만 (web·Railway·GitHub에 넣지 않음) |
| `SUPABASE_ACCESS_TOKEN` | Supabase → Account → Access Tokens (운영자 전용, CI에 넣지 않음) | `config push` 셸에서만 |
| `VERCEL_TOKEN`, `RAILWAY_TOKEN`, `SUPABASE_DB_URL` | 위 1장 | GitHub Environment secrets |
| `SMOKE_USER_{A,B}_{EMAIL,PASSWORD}` | 3장 5단계의 smoke 계정 | GitHub Environment secrets |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | 1장 8단계(Workers AI 권한만의 custom token) | Railway `api`, `worker` (Vercel 금지; `WORKER_EMBEDDER=workers_ai`일 때 필수) |
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

검증은 필수 누락, `https://` 아님, Turnstile 키 형식(항상 실패/challenge 테스트 키 거부, production의 테스트 키 거부, web sitekey와 Supabase secret 중 하나만 테스트 키인 짝 불일치 — `--check web=… --check supabase-config=…`를 함께 줄 때), CORS wildcard·path, 32자 미만 HMAC key, 공개 key/secret key 바뀜, fake adapter·test 전용 변수(`WORKER_TASK_ALWAYS_EAGER`, `FORWARDED_ALLOW_IPS`, `RAILWAY_RUN_UID` 등), manifest에 없는 `NEXT_PUBLIC_*`, web·api의 `RELAY_CLIENT_SECRET` 불일치를 오류로 낸다. 출력에는 변수 이름만 나온다.

주요 값:

- `APP_ENV=preview`(staging; production은 `production`) — web·api·worker 모두.
- `CORS_ALLOWED_ORIGINS` = `WEB_ORIGIN` = staging web origin(`https://staging.quiz.example`, ASCII/punycode).
- `SUPABASE_JWT_ISSUER=https://<ref>.supabase.co/auth/v1`, `SUPABASE_JWKS_URL=…/auth/v1/.well-known/jwks.json`, `SUPABASE_URL=https://<ref>.supabase.co`.
- `DATABASE_URL`/`WORKER_DATABASE_URL`: Supabase **session pooler**(IPv4) URL, 사용자 이름은 `quiz_api.<ref>` / `quiz_worker.<ref>`.
- `RELAY_CLIENT_IP_HEADER=x-real-ip`(Vercel이 client 주소로 덮어씀).
- `WORKER_MODELS_OFFLINE=true`(`WORKER_EMBEDDER=workers_ai`): Docling 모델은 worker image에 구워져 있고(`WORKER_MODELS_ARTIFACTS_PATH=/opt/docling-models`가 image 기본값, 변수로 넣지 않는다) 그 밖에 Hub에서 받는 모델이 없다. 로컬 Qwen3 embedder를 쓰는 경우에만 `false`로 시작해 HF_HOME volume이 채워진 뒤 `true`.
- Worker 메모리·시간(M7.4c, 기본값 그대로 두면 됨): Docling 동시 처리 page 수 `WORKER_PARSE_QUEUE_MAX_SIZE=8`·`WORKER_PARSE_PAGE_BATCH_SIZE=4`(300쪽 기준 Docling 약 2.6 GB, Docling 기본 100이면 약 4.5 GB), `document.parse`만 별도 시간 한도 `WORKER_DOCUMENT_TASK_SOFT/TIME_LIMIT_SECONDS=6900/7200`(lease·broker visibility는 가장 긴 한도 + grace를 따름), `WORKER_PARSE_TIMEOUT_SECONDS=3600`(document soft 한도보다 작아야 함). thread 수는 `WORKER_NUM_THREADS` 미설정 시 container CPU quota에서 정하므로 `OMP_NUM_THREADS`는 넣지 않는다. Railway처럼 상주 메모리가 과금되는 곳은 `WORKER_MAX_TASKS_PER_CHILD=1`(job마다 pool process 교체 → 모델 메모리 반환)을 검토한다. 이 값은 job task(`quiz.jobs.*`)만 센다: 매분 도는 `quiz.maintenance.reconcile_jobs` 같은 maintenance task로는 pool process가 교체되지 않으므로 PDF parser warm-up도 job 뒤에만 다시 일어난다(WRK-RECYCLE). pool process가 OOM 등으로 죽으면 그 attempt는 즉시 `worker_lost: worker process killed (out of memory?)`로 재큐(마지막 attempt면 failed)되므로 job이 lease 만료까지 `running`으로 남지 않는다. trial(1 GB/service)에서는 Docling 모델만으로 빠듯하므로 소형 PDF만 기대한다.

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
2. **Auth 설정 push**(SMTP·site_url·redirect·rate limit·Turnstile CAPTCHA·메일 템플릿). CAPTCHA는 push 즉시 켜지므로 같은 짝의 `NEXT_PUBLIC_TURNSTILE_SITE_KEY`로 build된 web을 함께 배포한다(첫 배포 전이면 순서 무관):
   ```bash
   set -a; . ~/secure/quiz/supabase-config.staging.env; set +a   # SUPABASE_ACCESS_TOKEN, SUPABASE_AUTH_* (CAPTCHA secret 포함)
   uv run python scripts/check_env.py --env staging --check supabase-config=- \
     --check web=$HOME/secure/quiz/web.staging.env      # sitekey ↔ secret 짝 검사 포함
   pnpm exec supabase config push --project-ref jpyupavjpmlxtuolrvvs
   ```
   Dashboard에서 확인·설정: JWT signing key를 비대칭(ES256)으로 rotate, access token 만료 3600s, Storage bucket `source-pdfs`·`parsed-artifacts`가 private, Auth → URL Configuration의 redirect 목록이 `https://<web>/auth/callback` 하나뿐인지, Auth → Attack Protection에서 CAPTCHA가 Turnstile로 켜져 있는지.
3. **Railway / Vercel 변수 입력**: 2장에서 검증한 값만 넣는다.
4. **GitHub Environment `staging`**: secrets `SUPABASE_DB_URL`, `VERCEL_TOKEN`, `RAILWAY_TOKEN`, `SMOKE_USER_*`; variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID`, `RAILWAY_WORKER_SERVICE_ID`, `WEB_ORIGIN`, `SMOKE_API_URL`, `SMOKE_SUPABASE_URL`, `SMOKE_SUPABASE_PUBLISHABLE_KEY`, (선택) `SMOKE_QDRANT_URL`. Repository variable `VERCEL_CLI_VERSION`(2주 이상 지난 정확한 `x.y.z`).
5. **첫 workflow 실행(bootstrap)**: smoke 계정은 staging 화면에서 가입해야 하므로 첫 실행만 Actions → Deploy → `environment=staging`, **`bootstrap=true`**(ref `develop`). preflight가 `SMOKE_USER_*`를 요구하지 않고, smoke는 `@readonly` 점검만 실행하며 run에 BOOTSTRAP 경고가 남는다. 이 run은 배포 완료로 보지 않는다. 누락 이름이 출력되면 채우고 다시 실행. `bootstrap`은 staging에서만 허용된다.
6. **Smoke 계정 → 정식 실행**: staging 화면에서 실제 메일함으로 두 번 가입·메일 확인(SMTP와 DEP-01 가입 흐름 확인) → GitHub secrets `SMOKE_USER_{A,B}_*`에 넣고 **`bootstrap` 없이** workflow를 다시 실행(전체 smoke: DEP-01 로그인, DEP-02 업로드 객체, DEP-05). 이후 배포는 항상 bootstrap 없이 실행한다. 2026-10-19부터 staging 배포는 `develop` push마다 CI GREEN 후 자동으로 돈다(CI run의 마지막 job `deploy · staging`; 이 경로는 bootstrap·skip_migrations 없이 실행). 자동 배포가 진행 중일 때 새 push가 오면 CI·배포는 대기열에 들어가고(진행 중인 배포를 취소하지 않음), 대기 중인 run이 여럿이면 GitHub이 가장 최신 것만 남긴다. (Supabase Admin으로 계정을 미리 만드는 방법은 secret key를 운영자 셸에 꺼내야 하고 실제 메일 흐름을 건너뛰므로 쓰지 않는다.)
7. **수동 DEP 점검**(4장).
8. **Docling 모델(WRK-BAKE)**: worker 로그에서 `PDF parser ready`가 Hugging Face 다운로드 로그 없이 몇 초 안에 찍히는지 확인한다(모델은 image의 `/opt/docling-models`). `WORKER_EMBEDDER=workers_ai`에서는 HF_HOME volume을 만들지 않는다. 로컬 Qwen3 embedder를 쓸 때만 volume을 만들고, 첫 검색 후 모델이 남으면 `WORKER_MODELS_OFFLINE=true`; 비root(uid 10001)가 volume에 쓰지 못하면 `RAILWAY_RUN_UID=0`을 쓰지 말고 volume 없이 운영하면서 기록한다.
9. **Workers AI parity·eval(첫 staging 배포 때 1회, M7.4b)**: 운영자 셸에서만 실행한다(합성 KO/EN 텍스트만 전송, 책 원문 없음).
   ```bash
   set -a; . ~/.secrets/quiz-workspace/staging/cloudflare.env; set +a
   make test-workers-ai     # 로컬 Qwen3(HF_HOME) vs Workers AI cosine parity + 오류 계약; 자격 없으면 실패(skip 아님)
   make eval-workers-ai     # eval/configs/workers-ai.json(1024차원, rerank off) → eval/reports/seed-workers-ai.{json,md}
   ```
   parity가 실패하면(평균 cosine 기준 미달) 요청 형식(`documents` / `queries`+`instruction`) 가정을 먼저 확인하고 결과를 implementation-plan §7에 기록한다. Cloudflare dashboard → AI → Workers AI에서 neuron 사용량을 확인해 deployment.md §8의 환산을 갱신한다.
10. **부하·비용 측정**(deployment.md §8): worker RAM/CPU, 검색 지연, Supabase·Qdrant 사용량. production 진행의 게이트였던 7일 측정은 사용자 결정(2026-10-19)으로 면제됐다; 측정은 운영 참고용으로 계속한다.

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

### 배포 준비 점검 (`make deploy-prepare`, DEP-PREP)

배포 전에 한 ref를 **배포하지 않고** 점검·빌드한다. 원격에는 읽기만 한다(`git fetch`, `gh run`/`gh api` GET, read-only DB 트랜잭션). push·workflow dispatch·배포 API 호출은 스크립트가 명령 단위로 막는다.

```bash
make deploy-prepare REF=origin/develop ENV=staging ARGS="--skip-images"
make deploy-prepare REF=main ENV=production                       # 이미지까지 빌드(디스크 8 GiB 이상 필요)
make deploy-prepare REF=main ENV=production ARGS="--db-url-env SUPABASE_DB_URL --only api,worker"
```

| 단계 | 내용 |
|---|---|
| ref | `git fetch` 후 ref → 전체 SHA(브랜치 이름은 `origin/<branch>`의 tip), commit 표시 |
| ref rule | `deploy.yml` preflight의 `case "$TARGET/$REF"` 허용 목록을 **그 SHA의 workflow에서 읽어** 적용(staging ← `develop`, production ← `main`). SHA를 주면 그 브랜치의 현재 tip이어야 한다(dispatch는 tip을 배포). `--allow-any-ref`는 경고로 낮추고 로컬 빌드만 한다 |
| ci | 그 SHA의 최신 CI push run에서 `deploy.yml`의 `REQUIRED_CI_JOBS`가 모두 success인지(진행 중·실패·누락을 구분해 출력). `--skip-ci`. production은 `PRODUCTION_DEPLOY_ENABLED`도 확인(경고) |
| worktree | 임시 디렉터리에 그 SHA의 깨끗한 `git worktree`(사용 중인 checkout은 건드리지 않음). 끝나면 삭제, `--keep`이면 유지 |
| env | 그 SHA의 `scripts/check_env.py`로 `--env-dir`(기본 `~/.secrets/quiz-workspace/<env>/`)의 `web`·`api`·`worker` 파일 검증(`<svc>.check.env`가 있으면 우선). 이름만 출력하고 값은 출력하지 않는다. `supabase-config`·`smoke` 파일은 `env ops`로 참고 검사(배포에는 쓰이지 않아 경고만). 디렉터리가 없으면 "not checked"로 건너뛴다 |
| migrations | 그 SHA의 `supabase/migrations` 중 대상이 아직 적용하지 않은 것. `--db-url-env NAME`/`--db-url-file FILE`이 있으면 `supabase_migrations.schema_migrations`를 read-only로 조회(URL·비밀번호는 argv·출력에 나오지 않음), 없으면 `--since <ref>` 또는 GitHub Environment의 마지막 성공 배포 SHA와 파일 diff. DROP TABLE/COLUMN, `ALTER … DROP`, TRUNCATE, RENAME, DELETE는 경고, DROP POLICY/TRIGGER/CONSTRAINT 등은 note. DB가 이 commit에 없는 migration을 이미 갖고 있으면(구 commit 배포) `skip_migrations`를 안내 |
| images | 여유 공간(`--min-free-gb`, 기본 8) 확인 후 worktree에서 `make image-{api,worker,web}`, 태그 `quiz-<svc>:<sha 12자>`. web은 env 파일의 `NEXT_PUBLIC_*` 공개 값만 build arg로 쓰거나 `--web-args`. `--skip-images`, `--only api,worker` |
| summary | 단계별 ✓/✗/!/- 표와, 배포할 때 쓸 `gh workflow run deploy.yml --ref <branch> -f environment=<env>` 명령(**출력만**, 실행하지 않음) |

종료 코드: 0 = 필수 점검 통과(경고 허용), 1 = 필수 점검 실패, 2 = 사용법 오류. 로컬 이미지는 호스트 아키텍처(arm64일 수 있음)로 빌드되고 push하지 않는다. 실제 배포 이미지는 workflow가 linux/amd64로 다시 빌드한다.

## 5. 롤백

- **Web**: Vercel → Deployments → 이전 배포 **Instant Rollback**(staging은 이전 배포에 alias 재지정).
- **API/Worker**: Railway → 서비스 → Deployments → 이전 배포 **Rollback**. 또는 이전 commit에서 workflow를 `skip_migrations=true`로 실행(이전 commit에는 최신 migration 파일이 없어 `db push`가 실패하므로).
- **DB**: migration은 additive-first(deployment.md §5)라 이전 코드가 새 schema에서 동작한다. down migration은 없다: 문제는 forward fix migration으로 고친다. 데이터 손상 시에만 DEP-06 절차로 **빈 대상**에 restore 후 전환한다.
- **Qdrant**: 파생 인덱스이므로 `make reindex ARGS="--all"`(worker 이미지에서 `python -m quiz_worker.reindex`)로 재구축.

## 6. Production

7일 부하·비용 게이트는 사용자 결정(2026-10-19)으로 면제됐다. production은 **`main`에서만**, 수동 dispatch + GitHub Environment `production` 승인으로 배포한다. workflow는 repository variable `PRODUCTION_DEPLOY_ENABLED=true`가 없으면 production을 preflight에서 거부한다(운영자가 켜는 스위치). 값은 모두 **production 전용으로 새로** 만든다: staging 값을 복사하지 않는다(예외: Qdrant cluster URL, 같은 SMTP 발신 도메인, Cloudflare account). 아래 env 파일은 `~/secure/quiz/*.production.env`(저장소 밖, `chmod 600`).

1. **Supabase production project**(Singapore):
   - Free plan은 활성 project가 2개까지다. 먼저 DEP-06 rehearsal용 임시 restore project(`zgzvapywhdvtlbnhbgij`, Mumbai)를 Dashboard → Project Settings → General → **Delete project**로 지운다(staging `jpyupavjpmlxtuolrvvs`는 유지).
   - New project: 지역 **Southeast Asia (Singapore)** `ap-southeast-1`, DB 비밀번호 `openssl rand -hex 32`(password manager). branching 미사용.
   - ref를 `supabase/config.toml` `[remotes.production] project_id`에 넣고 커밋한다(production: `tvviozfacsxpxkmvbevu`, Singapore)(ref는 secret 아님; 오케스트레이터).
   - Dashboard: JWT signing key를 비대칭(ES256)으로 rotate, access token 만료 3600s. API Keys → publishable key(web·smoke)와 secret key(Railway api·worker만; CLI로 꺼낼 때는 가려진 값 말고 `--reveal`).
   - session pooler URL(IPv4) → GitHub `SUPABASE_DB_URL`(`postgres.<ref>`), `DATABASE_URL`(`quiz_api.<ref>`), `WORKER_DATABASE_URL`(`quiz_worker.<ref>`).
2. **Railway environment `production`**(staging과 **같은 project**):
   - Project → Environments → **New Environment** `production`. **Duplicate는 쓰지 않는다**(staging 변수·secret이 복사됨) — 빈 environment에 서비스 3개를 1장 4단계와 같은 설정으로 둔다: `Redis`(public TCP proxy 없음), `api`(Empty Service, public domain 생성 → `NEXT_PUBLIC_API_BASE_URL`·`SMOKE_API_URL`), `worker`(Empty Service, domain 없음, Volume `/var/cache/huggingface`). Region은 모두 `asia-southeast1-eqsg3a`.
   - Project Settings → Tokens → **production environment용 project token**(staging token과 별개) → GitHub `production`의 `RAILWAY_TOKEN`. production environment id와 api·worker service id → `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID`, `RAILWAY_WORKER_SERVICE_ID`.
   - api·worker 변수(2장 표; `--template`으로 양식 생성): `APP_ENV=production`, `CORS_ALLOWED_ORIGINS=https://quiz.red-10-proto.xyz`, `REDIS_URL=${{Redis.REDIS_URL}}`(production environment의 Redis), production Supabase 값, `RELAY_CLIENT_SECRET`·`SHARE_SESSION_SECRET`·role 비밀번호는 새로 생성, `WORKER_EMBEDDER=workers_ai`와 Cloudflare 자격(staging과 같은 account면 Free quota 하루 10,000 neurons를 **staging과 나눠 씀**), Qdrant는 3단계.
3. **Qdrant**: staging과 같은 Free cluster(`QDRANT_URL` 동일). api·worker 모두 `QDRANT_COLLECTION_PREFIX=prod_`(check-env `same`; production에서 빈 값은 오류). staging은 빈 prefix(무접두 namespace)이므로 `prod_…` collection과 겹치지 않는다. `QDRANT_API_KEY`는 cluster key를 그대로 쓰거나 production용 key를 따로 발급해 따로 폐기할 수 있게 한다(권장). 운영 중 staging에서 `make reindex`/collection 정리를 할 때 `prod_` collection을 건드리지 않는다.
4. **Cloudflare Turnstile**: 1장 6단계의 production widget(`quiz-production`, Hostname `quiz.red-10-proto.xyz`만) — Site Key → Vercel Production `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, Secret Key → `config push` 셸의 `SUPABASE_AUTH_CAPTCHA_SECRET`. 테스트 키는 check-env가 거부한다.
5. **Vercel — production 전용 project를 따로 만든다**(사용자 결정 2026-10-19, Codex P1): staging alias `quiz-workspace-stg.vercel.app`은 staging project의 기본 **production** domain이라, 같은 project에 `--prod` 배포를 하면 그 alias가 production 배포로 옮겨 간다. 그래서 staging project는 그대로(preview 배포 + alias, `--prod` 없음) 두고:
   - Add New → Project → 같은 GitHub repo import, 이름 예: `quiz-workspace`, Root Directory `apps/web`, Framework Next.js, Node 24, Functions region `sin1`. `vercel.json`이 git 자동 배포를 끈다. Project ID → GitHub Environment `production`의 `VERCEL_PROJECT_ID`(staging과 다른 값; `VERCEL_ORG_ID`는 같은 team이면 같음). Deployment Protection은 production domain에 걸리지 않는지 확인한다.
   - 이 project의 Settings → Environment Variables → **Production**에 production 값(`NEXT_PUBLIC_SUPABASE_URL`·publishable key·`NEXT_PUBLIC_API_BASE_URL`·`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `APP_ENV=production`, 새 `AUTH_RECOVERY_MARKER_SECRET`, api와 같은 production `RELAY_CLIENT_SECRET`, `RELAY_CLIENT_IP_HEADER=x-real-ip`). staging project의 값은 건드리지 않는다.
   - 이 project의 Settings → Domains → **Add** `quiz.red-10-proto.xyz` → Production에 연결. Vercel이 보여 주는 CNAME 값(project별 `….vercel-dns….com` 또는 `cname.vercel-dns.com`)을 **가비아 DNS**(My가비아 → 도메인 → `red-10-proto.xyz` → DNS 관리 → 레코드 추가)에 type `CNAME`, 호스트 `quiz`, 값 = Vercel 표시값(끝의 `.` 포함 여부는 가비아 입력 형식에 따름), TTL 기본으로 넣는다. 기존 `mail` 하위 SPF/DKIM/DMARC 레코드는 건드리지 않는다. Vercel에서 Valid Configuration + 인증서 발급을 확인한다.
   - workflow는 production에서만 `vercel deploy --prebuilt --prod`로 이 project에 배포하고, Production domain이 그 배포에 자동으로 붙는다. staging은 `--prod` 없이 preview 배포 후 alias(workflow test가 고정).
6. **Auth 설정 push**(3장 2단계를 production 값으로):
   ```bash
   set -a; . ~/secure/quiz/supabase-config.production.env; set +a   # SITE_URL=https://quiz.red-10-proto.xyz, REDIRECT=…/auth/callback, SMTP, 실제 CAPTCHA secret
   uv run python scripts/check_env.py --env production --check supabase-config=- \
     --check web=$HOME/secure/quiz/web.production.env
   pnpm exec supabase config push --project-ref <production ref>
   ```
   Dashboard에서 URL Configuration redirect가 `https://quiz.red-10-proto.xyz/auth/callback` 하나뿐인지, Attack Protection CAPTCHA가 Turnstile로 켜졌는지 확인한다.
7. **첫 migration + role 비밀번호**(최초 1회 수동, 3장 1단계와 같음):
   ```bash
   export SUPABASE_DB_URL='postgresql://postgres.<production ref>:<db password>@<pooler host>:5432/postgres'
   pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" --dry-run
   pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"
   psql "$SUPABASE_DB_URL" -c "alter role quiz_api with login password '<hex>'"
   psql "$SUPABASE_DB_URL" -c "alter role quiz_worker with login password '<hex>'"
   ```
   이어서 Storage bucket `source-pdfs`·`parsed-artifacts`가 private인지 확인한다.
8. **env 검증**(플랫폼에 넣기 전):
   ```bash
   make check-env ENV=production ARGS="--check api=$HOME/secure/quiz/api.production.env \
     --check worker=$HOME/secure/quiz/worker.production.env --check web=$HOME/secure/quiz/web.production.env"
   ```
9. **GitHub Environment `production`**: Settings → Environments → New → `production` → Deployment branches **Selected branches** `main`만, **Required reviewers**(사용자; 혼자 운영하면 "Prevent self-review"는 끈다). secrets `SUPABASE_DB_URL`, `VERCEL_TOKEN`, `RAILWAY_TOKEN`(production token); variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`(**production project**의 id, 5단계), `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID`, `RAILWAY_WORKER_SERVICE_ID`, `WEB_ORIGIN=https://quiz.red-10-proto.xyz`, `SMOKE_API_URL`, `SMOKE_SUPABASE_URL`, `SMOKE_SUPABASE_PUBLISHABLE_KEY`, (선택) `SMOKE_QDRANT_URL`. smoke 계정 secrets는 필요 없다(`@readonly`만). Repository variable `PRODUCTION_DEPLOY_ENABLED=true`.
10. **`main` 준비**: 배포할 commit이 `main`에 있어야 한다. `develop`의 모든 테스트가 GREEN일 때만 `main`을 `develop`으로 fast-forward하고(push는 사용자 승인), `main` push의 CI가 GREEN인지 확인한다(dispatch는 그 commit의 최신 CI push run에서 선행 job — checks·images·integration·visual-ui — 이 모두 success인지 확인한다. `develop`에서 자동 배포 job만 실패한 commit도 수동 재배포·bootstrap은 가능).
11. **배포**: Actions → Deploy → Run workflow → **Use workflow from `main`**, `environment=production`(bootstrap·skip_migrations 끔) → 승인. preflight가 누락 이름을 출력하면 채우고 다시 실행.
12. **`@readonly` smoke**: workflow의 Smoke step이 `pnpm smoke --grep @readonly`를 production에 실행한다(DEP-01 HTTPS·HSTS·CORS, DEP-02 익명 Storage 거부, DEP-07 header·Data API·bundle·Qdrant 무키). 필요하면 운영자 셸에서 다시:
    ```bash
    SMOKE_TARGET=production E2E_BASE_URL=https://quiz.red-10-proto.xyz SMOKE_API_URL=https://<production api domain> \
      SMOKE_SUPABASE_URL=https://<production ref>.supabase.co SMOKE_SUPABASE_PUBLISHABLE_KEY=<publishable> \
      SMOKE_QDRANT_URL=https://<cluster>:6333 pnpm smoke --grep @readonly
    ```
13. **운영 확인**: 실제 메일로 가입·재설정 1회(Turnstile 위젯이 뜨고 통과하는지, 위젯 없이 Auth API를 직접 부르면 `captcha_failed`로 거부되는지), `/health/ready`(db·redis·qdrant ok), 업로드 1건이 `prod_` collection에 색인되는지, 백업 정책(플랜의 일일 백업 + `make backup`), 예산 알림(Railway·Vercel·Supabase).

## 7. 남은 사용자 결정

- 플랜·비용: Vercel(Hobby는 비상업 제한), Supabase(Free는 pause·메일 제한), Railway 사용량, Qdrant(Free는 테스트 전용인데 production도 공유 중 — 유료 전환 시점). (7일 비용 게이트는 2026-10-19 면제.)
- api 도메인(현재 Railway 기본 domain). (지역 Singapore, production web `quiz.red-10-proto.xyz`, SMTP Resend `mail.red-10-proto.xyz`는 결정됨.)
- GHCR 이미지 공개 여부 vs Railway registry credential.
- staging 도메인의 Vercel Deployment Protection.
- LLM 사용 여부·모델·예산(`LLM_API_KEY`/`LLM_MODEL`; 미설정 시 문제 생성 비활성).
- `/terms`, `/privacy` 실제 문구(현재 placeholder).
- CAPTCHA(A4 구현 완료): staging을 기본값인 Turnstile 테스트 키 쌍으로 둘지, staging 전용 실제 widget을 쓸지(그 경우 DEP smoke 로그인 단계는 수동). production은 실제 widget 필수.

## 8. 첫 staging 배포에서 확인할 가정

- Workers AI `@cf/qwen/qwen3-embedding-0.6b` 입력 형식(`documents` 배열, query는 `queries` + `instruction`)과 출력(`result.data`, 1024차원)이 adapter 가정과 같은지(3장 9단계 parity), 한 요청 batch 상한(기본 `CLOUDFLARE_AI_BATCH_SIZE=16`), Free plan quota 초과 응답의 status/code(adapter는 429와 quota 관련 오류 code를 `embedding_quota_exceeded`로 분류).

- Railway GraphQL(`serviceInstanceUpdate`, `serviceInstanceDeployV2`, `deployment`)과 `Project-Access-Token` header — 실패 시 `railway_deploy.py`가 단계 이름과 Railway 메시지를 출력한다.
- Railway volume이 uid 10001에 쓰기 가능한지(로컬 Qwen3 embedder로 volume을 쓸 때만, 3장 8단계).
- Vercel이 `x-real-ip`를 client 주소로 덮어쓰는지(공유 링크 rate limit의 client 구분).
- Supabase session pooler로 `quiz_api.<ref>`/`quiz_worker.<ref>` 로그인, GitHub runner(IPv4)에서 `db push`.
- `supabase config push`가 `[remotes.staging]`을 적용하는지(`--project-ref`가 `project_id`와 같아야 함). `[remotes.staging.auth.captcha]`(Turnstile)가 Dashboard Attack Protection에 반영되는지.
- Turnstile 테스트 sitekey 위젯이 headless Chromium(DEP-01 UI 로그인)에서 상호작용 없이 통과하는지.
