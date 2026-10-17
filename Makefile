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

.PHONY: help install lint lint-ts lint-py fmt fmt-check typecheck typecheck-ts typecheck-py \
	test test-ts test-py infra-up infra-down infra-status infra-reset \
	contracts contracts-check api-dev web-dev worker-dev db-reset db-lint db-test

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

typecheck-py:
ifeq ($(strip $(PY_PRESENT)),)
	@echo "mypy: no Python workspace members yet ($(PY_MEMBERS)); skipping"
else
	uv run mypy $(PY_PRESENT)
endif

test: test-ts test-py ## Unit tests (Vitest per package, pytest)

test-ts:
	pnpm -r --if-present run test

# pytest exits 5 when no tests were collected; that is the only non-zero code tolerated.
test-py:
	@rc=0; uv run pytest || rc=$$?; \
	if [ $$rc -eq 5 ]; then echo "pytest: no tests collected yet; ok"; exit 0; fi; \
	exit $$rc

infra-up: ## Start local Qdrant + Redis (compose) and the Supabase local stack
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
