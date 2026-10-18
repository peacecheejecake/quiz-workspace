# FastAPI service image (M7.3, docs/deployment.md §1). Build from the repo root:
#
#   docker build -f apps/api/Dockerfile -t quiz-api .
#
# - uv workspace, locked (`uv sync --locked`), no dev group, `quiz-api[models]`: workspace search
#   embeds queries with Qwen3-Embedding outside APP_ENV=test (implementation-plan §7, M3.6a), so
#   the image carries transformers + CPU torch. Workspace members are installed non-editable into
#   /opt/venv; the runtime stage copies only that venv.
# - Model weights are NOT baked in: they load into HF_HOME (/var/cache/huggingface) on the first
#   search. Mount a persistent volume there and, once it is warm, set WORKER_MODELS_OFFLINE=true
#   (the API reads the worker's variable) so the process never contacts the Hugging Face Hub.
# - No secrets at build time; every credential is a runtime environment variable
#   (docs/deployment.md §6). APP_ENV defaults to production so the startup guard refuses an
#   insecure configuration unless local/test is chosen explicitly.
# - Runs as an unprivileged user via `python -m quiz_api.serve` (the only supported launcher:
#   no uvicorn access log, proxy_headers off). Listens on $PORT (default 8000).
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
# Third-party dependencies first (cached until uv.lock or a member's pyproject.toml changes).
COPY pyproject.toml uv.lock ./
COPY apps/api/pyproject.toml apps/api/pyproject.toml
COPY apps/worker/pyproject.toml apps/worker/pyproject.toml
COPY packages/core/pyproject.toml packages/core/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --package quiz-api --extra models --no-install-workspace
COPY packages/core/src packages/core/src
COPY apps/api/src apps/api/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --package quiz-api --extra models --no-editable

FROM ${PYTHON_IMAGE} AS runtime
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g app /var/cache/huggingface
COPY --from=build /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/var/cache/huggingface \
    APP_ENV=production \
    PORT=8000
WORKDIR /srv
USER app:app
EXPOSE 8000
VOLUME ["/var/cache/huggingface"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health/live' % os.environ.get('PORT', '8000'), timeout=4)"]
CMD ["sh", "-c", "exec python -m quiz_api.serve --host 0.0.0.0 --port \"${PORT}\""]
