# Common entry points for the pnpm (TypeScript) + uv (Python) monorepo.
# Every target runs both sides and fails on any real error. Targets succeed when a side has
# nothing to check yet (no TS packages / no Python members).
#
# Extension points:
#   - TS packages: add `typecheck` / `test` (and optionally extra `lint`) scripts to their own
#     package.json; `pnpm -r --if-present` picks them up. ESLint and Prettier run from the root
#     config over the whole repo, so packages should not re-run them in their own `lint` script.
#   - Python members: add the directory to PY_MEMBERS below *and* to
#     [tool.uv.workspace].members in pyproject.toml. mypy runs on each member that has a
#     pyproject.toml; pytest collects tests from the whole repo.
#   - Local infra: Qdrant + Redis via Docker Compose (infra/compose.yaml) and the Supabase local
#     stack via the pinned CLI (`pnpm exec supabase`, config in supabase/config.toml).

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

PY_MEMBERS := apps/api apps/worker packages/core
PY_PRESENT := $(foreach m,$(PY_MEMBERS),$(if $(wildcard $(m)/pyproject.toml),$(m)))

COMPOSE := docker compose -f infra/compose.yaml
SUPABASE := pnpm exec supabase
# Local Auth JWT signing key (private, ES256). Ignored by VCS; generated on demand.
SIGNING_KEYS := supabase/signing_keys.json

.PHONY: help install lint lint-ts lint-py fmt fmt-check typecheck typecheck-ts typecheck-py \
	test test-ts test-py test-infra test-models test-llm test-workers-ai eval eval-models eval-workers-ai auth-keys infra-up infra-down infra-status infra-reset \
	contracts contracts-check api-dev web-dev worker-dev db-reset db-lint db-test \
	e2e e2e-browsers e2e-trace test-red images image-api image-api-models image-worker image-web reindex backup restore \
	check-env smoke-local smoke-staging

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

install: ## Install JS (pnpm) and Python (uv) dependencies
	pnpm install
	uv sync

lint: lint-ts lint-py contracts-check ## Lint + format check (TS and Python) + contract staleness

lint-ts:
	pnpm exec eslint .
	pnpm exec prettier . --check
	pnpm -r --if-present run lint

lint-py:
	uv run ruff check .
	uv run ruff format --check .

fmt: ## Apply formatters and safe lint fixes (TS and Python)
	pnpm exec prettier . --write
	pnpm exec eslint . --fix
	uv run ruff check . --fix
	uv run ruff format .

fmt-check: ## Format check only, no lint
	pnpm exec prettier . --check
	uv run ruff format --check .

typecheck: typecheck-ts typecheck-py ## Type-check (tsc per package, mypy per Python member)

typecheck-ts:
	pnpm -r --if-present run typecheck
	pnpm exec tsc -p tests/e2e/tsconfig.json
	pnpm exec tsc -p tests/smoke/tsconfig.json

typecheck-py:
ifeq ($(strip $(PY_PRESENT)),)
	@echo "mypy: no Python workspace members yet ($(PY_MEMBERS)); skipping"
else
	uv run mypy $(PY_PRESENT)
endif

test: test-ts test-py ## Unit tests (Vitest per package, pytest)

test-ts:
	pnpm -r --if-present run test
	node --test 'scripts/*.test.ts'

# pytest exits 5 when no tests were collected; that is the only non-zero code tolerated.
# Tests marked `infra` skip (with a reason, listed by -ra) when the local stack is not running.
# Tests marked `models` (real model weights), `llm` (real LLM provider) or `workers_ai` (real
# Cloudflare Workers AI) never run here; see `make test-models` / `make test-llm` /
# `make test-workers-ai`.
test-py:
	@rc=0; uv run pytest -m "not infra and not models and not llm and not workers_ai" || rc=$$?; \
	if [ $$rc -eq 5 ]; then echo "pytest: no tests collected yet; ok"; exit 0; fi; \
	exit $$rc

# QUIZ_REQUIRE_INFRA=1 turns the "stack not running" skip into a failure, so this never passes
# vacuously.
test-infra: ## Integration tests against the running local stack (needs `make infra-up`), excluding RED-phase tests
	QUIZ_REQUIRE_INFRA=1 uv run pytest -m "infra and not red"

test-red: ## RED-phase integration tests (expected to fail until their phase is implemented)
	QUIZ_REQUIRE_INFRA=1 uv run pytest -m "infra and red"

# Real model weights (Docling layout/TableFormer ~0.5G, Qwen3-Embedding-0.6B ~1.2G; Hugging Face
# cache, HF_HOME). Never skips: missing weights without network access fail the run. Nightly /
# before parser or model-adapter changes.
test-models: ## Tests on real model weights (downloads into HF_HOME on first run)
	uv run pytest -m models

# Real LLM provider calls (opt-in, billed). Needs LLM_API_KEY and LLM_MODEL in the environment;
# fails, never skips, without them. Sends only synthetic text, never book content.
test-llm: ## Tests against the real LLM provider (needs LLM_API_KEY, LLM_MODEL)
	uv run pytest -m llm

# Real Cloudflare Workers AI calls (M7.4b; opt-in, uses the account's daily neuron quota). Needs
# CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; fails, never skips, without them. The parity test
# also loads the local Qwen3-Embedding weights (HF_HOME). Sends only synthetic text.
test-workers-ai: ## Workers AI round trip + parity with local Qwen3 (needs CLOUDFLARE_ACCOUNT_ID/_API_TOKEN)
	uv run pytest -m workers_ai

# Retrieval evaluation (M2.6) on the KO/EN seed set: JSON + Markdown reports in eval/reports/
# (gitignored except the committed sample-* report). `eval` uses the deterministic fakes and runs
# offline in seconds; `eval-models` uses Qwen3-Embedding (MRL 256) + Qwen3-Reranker on CPU
# (minutes; weights in HF_HOME). Both index into an in-process Qdrant.
EVAL_DATASET := eval/datasets/retrieval-seed.json

eval: ## Retrieval evaluation with fake models (fast, offline) -> eval/reports/seed-fake.{json,md}
	uv run core eval $(EVAL_DATASET) --config eval/configs/fake.json \
		-o eval/reports/seed-fake.json --markdown eval/reports/seed-fake.md

eval-models: ## Retrieval evaluation with Qwen3 embedder + reranker -> eval/reports/seed-qwen3.{json,md}
	uv run core eval $(EVAL_DATASET) --config eval/configs/models.json \
		-o eval/reports/seed-qwen3.json --markdown eval/reports/seed-qwen3.md

# Hosted embedder (M7.4b): Cloudflare Workers AI Qwen3-Embedding (1024 dims, no reranker, like
# staging/production). Needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN; sends the synthetic
# seed books (tests/fixtures/pdfs) to Cloudflare. First staging deploy only (runbook §3).
eval-workers-ai: ## Retrieval evaluation with the Workers AI embedder -> eval/reports/seed-workers-ai.{json,md}
	uv run core eval $(EVAL_DATASET) --config eval/configs/workers-ai.json \
		-o eval/reports/seed-workers-ai.json --markdown eval/reports/seed-workers-ai.md

auth-keys: $(SIGNING_KEYS) ## Generate the local Auth JWT signing key if missing (idempotent)

$(SIGNING_KEYS):
	@umask 077; echo '[]' > $@
	@$(SUPABASE) gen signing-key --algorithm ES256 --append || { rm -f $@; exit 1; }

infra-up: auth-keys ## Start local Qdrant + Redis (compose) and the Supabase local stack
	$(COMPOSE) up -d --wait
	$(SUPABASE) start

infra-down: ## Stop local infra, keeping data volumes
	$(SUPABASE) stop
	$(COMPOSE) down

infra-status: ## Show compose service health and Supabase local URLs
	$(COMPOSE) ps
	$(SUPABASE) status

infra-reset: ## Stop local infra and DELETE its data volumes (Postgres, Storage, Qdrant, Redis)
	$(SUPABASE) stop --no-backup
	$(COMPOSE) down --volumes

# Database (requires `make infra-up`). supabase/migrations is the only migration owner.
db-reset: ## Recreate the local DB from supabase/migrations + supabase/seed.sql
	$(SUPABASE) db reset

db-lint: ## Lint the local DB schema (plpgsql_check)
	$(SUPABASE) db lint --fail-on warning

db-test: ## Run pgTAP tests in supabase/tests against the local DB
	$(SUPABASE) test db

# OpenAPI contract: FastAPI app -> contracts/openapi.json -> packages/api-client TS types.
contracts: ## Export contracts/openapi.json and regenerate the TS API client
	uv run python -m quiz_api.openapi_export
	pnpm --filter @quiz/api-client run generate

contracts-check: ## Fail if contracts/openapi.json or the TS API client is stale
	uv run python -m quiz_api.openapi_export --check
	pnpm --filter @quiz/api-client run check:generated

api-dev: ## Run the API locally with reload (reads .env)
	uv run python -m quiz_api.serve --reload

web-dev: ## Run the Next.js web app locally (http://127.0.0.1:3000)
	pnpm --filter @quiz/web dev

worker-dev: ## Run the Celery worker locally (reads .env; needs Redis from infra-up)
	uv run python -m quiz_worker.serve

# E2E (Playwright; workflow in tests/e2e/README.md). `e2e` starts a production build of apps/web
# unless a server already answers on E2E_BASE_URL. Tests tagged @infra need `make infra-up`.
e2e-browsers: ## Install the Playwright browsers E2E uses (Chromium + WebKit only)
	pnpm exec playwright install chromium webkit

e2e: ## Run Playwright E2E, e.g. ARGS="--project harness-chromium"
	pnpm e2e $(ARGS)

e2e-trace: ## AC <-> test traceability report; ARGS="--strict --phase A0" gates a phase
	pnpm e2e:trace $(ARGS)

# Container images (M7.3; build context = repo root, .dockerignore is an allowlist). Local tags
# only, nothing is pushed. The web image inlines NEXT_PUBLIC_* at build time: override WEB_ARGS
# per environment (public values only, docs/deployment.md §6).
IMAGE_TAG ?= dev
WEB_ARGS ?= --build-arg NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
	--build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local-placeholder \
	--build-arg NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000

images: image-api image-worker image-web ## Build the api/worker/web container images (local tags)

image-api: ## API image without local models (hosted Workers AI query embedder, M7.4b)
	docker build -f apps/api/Dockerfile -t quiz-api:$(IMAGE_TAG) .

image-api-models: ## API image with local Qwen3 (torch + transformers) for eval/nightly/self-hosting
	docker build -f apps/api/Dockerfile --build-arg API_EXTRAS=models -t quiz-api-models:$(IMAGE_TAG) .

image-worker:
	docker build -f apps/worker/Dockerfile -t quiz-worker:$(IMAGE_TAG) .

image-web:
	docker build -f apps/web/Dockerfile -t quiz-web:$(IMAGE_TAG) $(WEB_ARGS) .

# Operations (M7.3, docs/deployment.md §7). Qdrant is a derived index: rebuild it from Postgres.
reindex: ## Rebuild Qdrant from published active revisions, ARGS="--all [--dry-run]" or "--workspace <uuid>"
	scripts/reindex $(ARGS)

backup: ## Postgres dump + Storage objects into DIR (needs infra-up locally), e.g. DIR=/secure/backups/2026-10-18
	@test -n "$(DIR)" || { echo 'usage: make backup DIR=<new directory>'; exit 2; }
	scripts/backup "$(DIR)"

restore: ## Restore DIR into an EMPTY target at the same migration version (RESTORE_DB_URL), ARGS="--yes --reindex"
	@test -n "$(DIR)" || { echo 'usage: make restore DIR=<backup directory> ARGS="--yes [--reindex]"'; exit 2; }
	scripts/restore "$(DIR)" $(ARGS)

# Deployment environment (M7.4a): validate env files against infra/deploy/env-manifest.toml without
# printing values, e.g. ENV=staging ARGS="--check api=api.staging.env --check web=web.staging.env"
# (`--template <service>` prints a fill-in file, `--list` the whole manifest).
check-env: ## Validate deployment env files against the manifest, ENV=staging|production ARGS="--check api=<file>"
	@test -n "$(ENV)$(findstring --list,$(ARGS))" || { echo 'usage: make check-env ENV=staging|production ARGS="--check <service>=<file>"'; exit 2; }
	uv run python scripts/check_env.py $(if $(ENV),--env $(ENV)) $(ARGS)

# Deployment smoke DEP-01..07 (M7.4a; tests/smoke, docs/runbook-deploy.md "Staging smoke").
# smoke-local: against the local stack (needs infra-up); e2e:log-audit starts web/API/worker on
# SMOKE_WEB_PORT/SMOKE_API_PORT with captured logs and fails on secrets in them. APP_ENV=test so the
# DEP-03 seed parses with the fixture parser. DEP-03 runs in two invocations around a restart:
#   make smoke-local ARGS=--grep=DEP-03 SMOKE_DEP03_PHASE=seed, then the same with =verify.
# smoke-staging: against a deployed environment; the SMOKE_* / E2E_BASE_URL variables come from
# the shell (infra/deploy/env-manifest.toml, service `smoke`).
SMOKE_WEB_PORT ?= 3160
SMOKE_API_PORT ?= 8160
smoke-local: ## DEP smoke against the local stack (starts web/API/worker with log audit; needs infra-up)
	APP_ENV=test SMOKE_TARGET=local pnpm e2e:log-audit --worker --web-port $(SMOKE_WEB_PORT) \
		--api-port $(SMOKE_API_PORT) $(if $(NO_BUILD),--no-build) -- --config tests/smoke/playwright.config.ts $(ARGS)

smoke-staging: ## DEP smoke against staging (env: SMOKE_* + E2E_BASE_URL); manual DEP steps: docs/runbook-deploy.md
	SMOKE_TARGET=$${SMOKE_TARGET:-staging} pnpm smoke $(ARGS)
	@echo 'smoke: automated DEP checks done. Manual: DEP-01 reset mail, DEP-03 restart, DEP-04, DEP-06, DEP-07 log export (docs/runbook-deploy.md).'
