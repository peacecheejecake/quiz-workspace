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
#   - Infra targets (`infra-up`, ...) are added by P0.2.

SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

PY_MEMBERS := apps/api apps/worker packages/core
PY_PRESENT := $(foreach m,$(PY_MEMBERS),$(if $(wildcard $(m)/pyproject.toml),$(m)))

.PHONY: help install lint lint-ts lint-py fmt fmt-check typecheck typecheck-ts typecheck-py \
	test test-ts test-py

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

install: ## Install JS (pnpm) and Python (uv) dependencies
	pnpm install
	uv sync

lint: lint-ts lint-py ## Lint + format check (TS and Python)

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
