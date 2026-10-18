# Celery worker image (M7.3, docs/deployment.md §1). Build from the repo root:
#
#   docker build -f apps/worker/Dockerfile -t quiz-worker .
#
# - uv workspace, locked, no dev group, `quiz-worker[models]` = book-core[parser,models,llm]
#   (Docling on CPU torch, Qwen3-Embedding, the LLM provider client). OCR (`book-core[ocr]`) stays
#   out: it is off by default. Members are installed non-editable into /opt/venv.
# - Model weights are NOT baked in (multi-GB, rebuildable): Docling layout/table models and
#   Qwen3-Embedding download into HF_HOME (/var/cache/huggingface) on first use. Mount a
#   persistent volume there; once it is warm set WORKER_MODELS_OFFLINE=true so jobs never contact
#   the Hugging Face Hub (or point WORKER_MODELS_ARTIFACTS_PATH at pre-downloaded Docling models).
# - No secrets at build time (docs/deployment.md §6). APP_ENV defaults to production, which
#   refuses the fake parser/embedder adapters.
# - Runs `python -m quiz_worker.serve` (never bare `celery worker`) as an unprivileged user.
#   The same image runs the Qdrant rebuild: `python -m quiz_worker.reindex --help`.
#
# Base images are pinned by version and digest (both at least two weeks old when pinned).

ARG PYTHON_IMAGE=python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.7@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock ./
COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY apps/worker/pyproject.toml apps/worker/pyproject.toml
COPY packages/core/pyproject.toml packages/core/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --package quiz-worker --extra models --no-install-workspace
COPY packages/core/src packages/core/src
COPY apps/worker/src apps/worker/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --package quiz-worker --extra models --no-editable

FROM ${PYTHON_IMAGE} AS runtime
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g app /var/cache/huggingface
COPY --from=build /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/var/cache/huggingface \
    APP_ENV=production
# Parse jobs write temporary PDFs under TMPDIR; /tmp is writable for the app user.
WORKDIR /srv
USER app:app
VOLUME ["/var/cache/huggingface"]
# Liveness: the worker's own Celery node answers a control ping (needs the broker, like the
# worker itself). Generous start period: model-less boot is seconds, but beat + pool start first.
HEALTHCHECK --interval=60s --timeout=15s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import socket, sys; from quiz_worker.celery_app import app_from_environment; sys.exit(0 if app_from_environment().control.ping(destination=['celery@' + socket.gethostname()], timeout=10) else 1)"]
CMD ["python", "-m", "quiz_worker.serve"]
