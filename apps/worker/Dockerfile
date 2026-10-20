# Celery worker image (M7.3, docs/deployment.md §1). Build from the repo root:
#
#   docker build -f apps/worker/Dockerfile -t quiz-worker .
#
# - uv workspace, locked, no dev group, `quiz-worker[models]` = book-core[parser,models,llm]
#   (Docling on CPU torch, Qwen3-Embedding, the LLM provider client). OCR (`book-core[ocr]`) stays
#   out: it is off by default. Members are installed non-editable into /opt/venv.
# - Docling parser models ARE baked in (WRK-BAKE, user decision 2026-10-21; revises M7.3 for
#   these models only): the `models` stage downloads exactly what the parser loads, at pinned
#   revisions, into /opt/docling-models (Docling `artifacts_path` layout, root-owned, read-only),
#   and WORKER_MODELS_ARTIFACTS_PATH points there, so a deploy/restart never fetches them:
#     docling-project/docling-layout-heron   (layout, Transformers engine)
#     docling-project/docling-models          (TableFormer, accurate mode only)
#   The revisions are the ones the locked Docling requests (layout `main` pinned to its commit);
#   the stage fails if the locked Docling version or its model repos change, so an upgrade has to
#   revisit them. RapidOCR is not installed (no OCR models). Qwen3-Embedding/reranker weights
#   stay lazy in HF_HOME (/var/cache/huggingface; unused with WORKER_EMBEDDER=workers_ai): mount a
#   volume there and set WORKER_MODELS_OFFLINE=true once it is warm.
# - No secrets at build time (docs/deployment.md §6). APP_ENV defaults to production, which
#   refuses the fake parser/embedder adapters.
# - Runs `python -m quiz_worker.serve` (never bare `celery worker`) as an unprivileged user.
#   The same image runs the Qdrant rebuild: `python -m quiz_worker.reindex --help`.
#
# Base images are pinned by version and digest (both at least two weeks old when pinned).

ARG PYTHON_IMAGE=python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.7@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS deps
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

# Docling parser models (depends on the locked dependencies only, so source changes reuse it).
# Pins checked by infra/deploy/test_platform_config.py against uv.lock.
FROM deps AS models
ARG DOCLING_VERSION=2.131.0
ARG DOCLING_LAYOUT_REPO=docling-project/docling-layout-heron
ARG DOCLING_LAYOUT_REVISION=8f39ad3c0b4c58e9c2d2c84a38465abf757272d8
ARG DOCLING_TABLEFORMER_REPO=docling-project/docling-models
ARG DOCLING_TABLEFORMER_REVISION=v2.3.0
RUN HF_HOME=/tmp/hf /opt/venv/bin/python - <<'PY'
import importlib.metadata
import inspect
import os
import shutil
from pathlib import Path

from docling.datamodel.pipeline_options import (
    LayoutObjectDetectionOptions,
    TableFormerMode,
    TableStructureOptions,
)
from docling.models.stages.table_structure.table_structure_model import TableStructureModel
from huggingface_hub import snapshot_download

env = os.environ
# Fail when the locked Docling stops asking for these models (an upgrade must re-pin them).
assert importlib.metadata.version("docling-slim") == env["DOCLING_VERSION"], "docling changed"
spec = LayoutObjectDetectionOptions().model_spec
assert (spec.repo_id, spec.revision) == (env["DOCLING_LAYOUT_REPO"], "main"), spec
table_repo = env["DOCLING_TABLEFORMER_REPO"]
assert TableStructureModel._model_repo_folder == table_repo.replace("/", "--")
table_rev = env["DOCLING_TABLEFORMER_REVISION"]
assert f'revision="{table_rev}"' in inspect.getsource(TableStructureModel.download_models)
assert TableStructureOptions().mode is TableFormerMode.ACCURATE

out = Path("/opt/docling-models")
jobs = [
    (
        env["DOCLING_LAYOUT_REPO"],
        env["DOCLING_LAYOUT_REVISION"],
        ["config.json", "preprocessor_config.json", "model.safetensors"],
    ),
    (table_repo, table_rev, [f"{TableStructureModel._model_path}/accurate/*"]),
]
for repo, revision, patterns in jobs:
    target = out / repo.replace("/", "--")
    snapshot_download(repo, revision=revision, allow_patterns=patterns, local_dir=target)
    shutil.rmtree(target / ".cache", ignore_errors=True)
PY
RUN chmod -R a+rX,go-w /opt/docling-models

FROM deps AS build
COPY packages/core/src packages/core/src
COPY apps/worker/src apps/worker/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --package quiz-worker --extra models --no-editable

FROM ${PYTHON_IMAGE} AS runtime
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g app /var/cache/huggingface
COPY --from=build /opt/venv /opt/venv
# Root-owned and read-only for the app user (no --chown).
COPY --from=models /opt/docling-models /opt/docling-models
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/var/cache/huggingface \
    WORKER_MODELS_ARTIFACTS_PATH=/opt/docling-models \
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
