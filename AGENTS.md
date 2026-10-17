# AGENTS.md — Quiz Workspace

Operating rules for every agent working in this repository: Claude Code (orchestrator and
subagents) and Codex (reviewer). Design docs are in Korean; this file is the English
summary of the rules for carrying out the implementation plan.

## 1. Sources of truth

| Topic | Document |
|---|---|
| Task hierarchy, dependency graph, waves, progress | `docs/implementation-plan.md` |
| System architecture, DB model, API list, milestones | `docs/architecture.md` |
| Screen behaviour and acceptance criteria (87 ACs) | `docs/screens/*.md` (index: `docs/screens/index.md`) |
| Auth / authorization | `docs/auth.md` |
| Sharing and fork | `docs/workspace-sharing.md` |
| Question state, heatmap, variants | `docs/questions.md` |
| Tokens, components, accessibility | `docs/design-system.md` |
| Infra, CI/CD, secrets | `docs/deployment.md` |
| Test-first process and E2E rules | `docs/e2e-strategy.md` |

- If the design docs and the plan disagree, the design docs win. Record the conflict and its
  resolution in `docs/implementation-plan.md` §7 (Decision log). Do not silently diverge.
- If a spec is ambiguous and the choice is user-visible or hard to reverse, stop and ask the
  orchestrator instead of guessing.

## 2. Roles

**Orchestrator (main thread)**
- Does not write application code. It picks the next ready Task from the dependency graph,
  delegates it to a subagent, verifies the result, runs the Codex review gate, and updates
  `docs/implementation-plan.md` §8 (Progress).
- One subagent = one Task. The brief must include: Task ID, scope (directories it may touch),
  relevant spec sections and AC IDs, DoD from the plan, and the verification commands to run.
- Tasks in the same wave run in parallel only when their file scopes do not overlap; parallel
  subagents use isolated git worktrees merged into `develop` by the orchestrator. A worktree
  subagent cannot write to the main checkout: review fixes go on a new branch in its worktree
  created from current `develop`. Shared files (lockfiles, Makefile, root configs) are expected
  to conflict; the orchestrator resolves them and regenerates lockfiles.
- Reviews the subagent's report critically: re-runs the verification commands itself before
  accepting a Task.

**Implementation subagent**
- Works only inside its Task scope. Anything outside scope (shared config, other packages,
  migrations owned by another Task) is reported back, not changed.
- Follows the Task lifecycle in §3 and finishes with a commit plus a short report: what changed,
  commands run with results, RED evidence (if applicable), open issues.
- Never marks a Task done with failing, skipped, or deleted tests.

**Reviewer (Codex)**
- Runs via `scripts/codex-review.sh` (§4) on the Task's commit(s) with the default model.
- Follows the "Review guidelines" in §6.

## 3. Task lifecycle (spec → RED → GREEN → review)

1. Read the Task row in `docs/implementation-plan.md` and every linked spec section.
2. **RED tasks (`*.0`, `S0`, `A0`)**: write Playwright E2E / contract tests whose titles start
   with the AC ID (`QOV-01-AC03 ...`). Use the file path declared in the screen spec. Run them and
   confirm they fail because the feature is missing — not because of infrastructure, seed data or
   network. Commit with the failure reasons in the commit body.
3. **Implementation tasks**: make the referenced tests GREEN. Add unit/integration tests for logic
   the browser cannot observe (authorization, revision consistency, answer leakage, idempotency).
4. Run locally before committing: format, lint, typecheck, unit tests of touched packages, and the
   affected E2E/contract tests.
5. Commit (Conventional Commits, scope = package or Task ID, e.g. `feat(api): M3.1a workspace CRUD`).
6. Codex review gate (§4). Fix findings in follow-up commits.
7. Orchestrator re-verifies and marks the Task `✅` in the progress table with commit and review refs.

Branching: all Task commits land on `develop`. `main` is fast-forwarded only when every test that
exists on `develop` is GREEN. Therefore a phase's RED task is written right before that phase
starts — never in bulk ahead of time. Never push or force-push without explicit user approval.

## 4. Codex review gate

- **Unit of review = one Task** from the plan (including RED tasks). Trivial follow-ups (typos,
  plan status updates) do not need their own review.
- Command (from the repo root):
  ```bash
  scripts/codex-review.sh --commit <sha> --title "<Task ID>: <summary>"   # single commit
  scripts/codex-review.sh --base <ref>   --title "<Task ID>: <summary>"   # multi-commit Task
  ```
- Inside herdr the review runs in a side pane labelled `codex-review`, visible to the user. The
  pane is created once (split right of the orchestrator pane) and **reused** for every later
  review; its id is cached in `.reviews/.pane-id`. Do not open extra panes for reviews. Only one
  review runs at a time (`.reviews/.lock`).
- The script blocks until Codex finishes and prints `REVIEW_LOG=<path>`; read the log for findings.
- Handling findings:
  - P0/P1 (correctness, security, data isolation, spec violation): must be fixed before the Task
    is accepted. Delegate the fix to a subagent, then re-review the fix commit.
  - P2/P3: fix if cheap and in scope; otherwise record as a follow-up in the plan's progress table.
  - A finding that contradicts the specs is rejected with a one-line reason in the progress table.
- Use the default Codex model; do not pass `-m`/model overrides.

## 5. Engineering rules

**Repository layout** (`docs/architecture.md` §10): `apps/{api,worker,web}`,
`packages/{core,ui,design-tokens,api-client}`, `supabase/migrations`, `contracts/openapi.json`,
`tests/{e2e,integration}`, `eval/`, `infra/compose.yaml`. Python uses a `uv` workspace;
TypeScript uses a `pnpm` workspace. The TS API client (`packages/api-client`) is generated from
OpenAPI — never hand-edit it; run `make contracts` after API changes.

**Security and data isolation**
- FastAPI is the authorization boundary. Every request checks resource → workspace → membership
  in the DB; never trust a client-supplied `workspace_id`. Archived = read-only, soft-deleted = no access.
- `user_id` comes only from the verified JWT `sub`. Never derive auth state from cookie
  `getSession().user` on the server; use `getClaims()` or re-verification.
- Never log, persist in traces, or put in URLs: JWTs, refresh tokens, share secrets, signed
  Storage URLs, passwords, raw book text. Server-only secrets never get a `NEXT_PUBLIC_` prefix.
- No browser access to the Supabase Data API, Qdrant or Redis. All Storage buckets are private.
- Share links are a separate read-only capability (digest-only storage, fragment → HttpOnly
  session), never converted into a membership.
- Practice APIs never send correct answers or explanations before submission.

**Data**
- `supabase/migrations` is the only migration owner (no Alembic). Migrations are additive-first.
- PostgreSQL is canonical; Qdrant is a rebuildable index. History tables exist from the start.
- Grade by stable option IDs, never by display position. Attempts are immutable.
- Generated or imported questions stay in drafts until a human approves them.

**Frontend**
- Semantic design tokens only: no raw hex, ad-hoc shadows or radii in feature code.
- Radix primitives for dialogs/popovers/tooltips; shared `FloatingSidePanel` for all side panels.
- Keyboard and touch parity with hover; never convey state by color alone; respect
  `prefers-reduced-motion` and reduced transparency.
- Heatmap: one CONFIRMED question = one marker; favorite swaps rounded-square → rounded-star of the
  same size and color; only hover/focus-visible scales the marker; no grid shift.
- UI copy is Korean first. Tests locate elements by role/label with regexes that accept Korean
  and English (`/로그인|sign in/i`); `data-testid` only where the spec allows it.

**Tests**
- Playwright test titles start with the AC ID; `pnpm e2e:trace` must report no orphan ACs or tests
  for implemented phases. No `test.skip`/`fixme` to make a suite pass.
- E2E/CI use deterministic fake adapters for embedding, reranker and LLM; real models run only in
  `eval/` or nightly jobs. Freeze clocks, seeds, locale and timezone.
- Writing tests use per-test users/workspaces; no parallel writes to shared fixtures.
- Test-only seed/reset endpoints must not be built into production.
- Only synthetic PDF fixtures; never commit copyrighted books, user files, or credentials.

**Code style**
- Code, identifiers, comments and commit messages are in English.
- Python: ruff + mypy (strict in `packages/core`), pytest. TypeScript: strict mode, eslint,
  prettier, Vitest.
- Keep comments sparse and purposeful; match surrounding style.

## 6. Review guidelines (for Codex)

When reviewing a commit in this repository:
- Identify the Task ID from the commit title/review title and check the change against that Task's
  DoD in `docs/implementation-plan.md` and the referenced AC IDs in `docs/screens/*.md`.
- Prioritise: authorization and cross-workspace/cross-user leakage; secret/token leakage (logs,
  URLs, traces); answer/explanation leakage before submission; migration safety; idempotency of
  jobs; revision/index consistency; spec deviations; missing or weakened tests.
- Flag tests that would pass without the feature (false GREEN), RED tests failing for
  infrastructure reasons, `skip`/`only`, and AC IDs missing from test titles.
- Flag raw colors, inaccessible interactions (no keyboard path, color-only state, missing labels).
- Report findings with severity P0–P3, file:line, and a concrete failure scenario. Skip pure style
  nits already enforced by formatters.

## 7. Commands

Prerequisites: Node 24 (`.nvmrc`), pnpm 10 (`packageManager`), uv, Python 3.12 (`.python-version`).
Copy `.env.example` to `.env` for local values (never commit `.env`).

```bash
make install     # pnpm install + uv sync
make lint        # eslint + prettier --check + ruff + per-package lint + contracts-check
make fmt         # prettier --write, eslint --fix, ruff --fix, ruff format
make fmt-check   # format check only
make typecheck   # per-package `typecheck` scripts (tsc) + mypy on Python members
make test        # per-package `test` scripts (Vitest) + pytest
make contracts   # export contracts/openapi.json + regenerate packages/api-client types
make contracts-check   # fail if either generated contract file is stale
make api-dev     # run the FastAPI app locally with reload (python -m quiz_api.serve; never bare uvicorn)
make infra-up    # Docker required: Qdrant + Redis (infra/compose.yaml) + Supabase local stack
make infra-status  # compose health + Supabase local URLs (keys go only into .env)
make infra-down  # stop infra, keep data volumes
make infra-reset # stop infra and DELETE local data volumes
pnpm exec supabase <cmd>       # pinned Supabase CLI; never a global install
make db-reset    # recreate local DB from supabase/migrations + seed.sql (needs infra-up)
make db-lint     # supabase db lint --fail-on warning
make db-test     # pgTAP tests in supabase/tests
make web-dev     # Next.js dev server on http://127.0.0.1:3000 (reads root .env)
pnpm --filter @quiz/web build  # production build of apps/web
pnpm --filter <pkg> <script>   # run one TS package's script
uv run pytest apps/api         # run one Python member's tests
scripts/codex-review.sh --commit HEAD --title "<Task ID>: <summary>"
```

The API connects as the least-privilege role `quiz_api` (NOLOGIN in migrations). One-time local
step after `infra-up` (roles survive `db reset`; local-only password, never committed):
`psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "alter role quiz_api with login password 'change-me-local'"`.

New TS packages extend `tsconfig.base.json` and expose `typecheck`/`test` scripts; ESLint and
Prettier run from the root config. New Python members must be added to both
`[tool.uv.workspace].members` in `pyproject.toml` and `PY_MEMBERS` in the `Makefile`.
