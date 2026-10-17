"""Application factory.

Run with `make api-dev` / `python -m quiz_api.serve`, not bare `uvicorn`: the launcher turns
off uvicorn's query-logging access log and routes its loggers through the redacting handler.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

from fastapi import FastAPI

from quiz_api import __version__
from quiz_api.api import API_V1_PREFIX, api_router
from quiz_api.auth.dependencies import build_token_verifier
from quiz_api.db import create_database
from quiz_api.errors import Problem, install_error_handlers
from quiz_api.health import ReadinessChecker, default_readiness_checkers
from quiz_api.health import router as health_router
from quiz_api.logging_config import configure_logging
from quiz_api.middleware import NoStoreMiddleware, RequestIdMiddleware
from quiz_api.security import SecurityHeadersMiddleware, install_browser_security
from quiz_api.settings import Environment, Settings, get_settings

API_TITLE = "Quiz Workspace API"


def create_app(
    settings: Settings | None = None,
    *,
    readiness_checkers: Sequence[ReadinessChecker] | None = None,
) -> FastAPI:
    settings = (settings or get_settings()).ensure_secure_deployment()
    configure_logging(settings.log_level)
    database = create_database(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            if database is not None:
                database.dispose()

    app = FastAPI(
        title=API_TITLE,
        version=__version__,
        lifespan=lifespan,
        openapi_url=f"{API_V1_PREFIX}/openapi.json",
        docs_url=None if settings.app_env is Environment.PRODUCTION else f"{API_V1_PREFIX}/docs",
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.database = database
    app.state.token_verifier = build_token_verifier(settings)
    app.state.readiness_checkers = (
        list(readiness_checkers)
        if readiness_checkers is not None
        else default_readiness_checkers(settings, database)
    )

    install_error_handlers(app)
    # Outermost last: RequestId → SecurityHeaders → NoStore → Origin guard → CORS → routes.
    install_browser_security(
        app,
        allowed_origins=settings.effective_cors_origins,
        max_age=settings.cors_max_age_seconds,
    )
    app.add_middleware(
        NoStoreMiddleware, path_prefix=API_V1_PREFIX, shared_prefix=f"{API_V1_PREFIX}/shared"
    )
    app.add_middleware(
        SecurityHeadersMiddleware,
        force_hsts=settings.is_deployed,
        csp_exempt_paths={app.docs_url} if app.docs_url else (),
    )
    app.add_middleware(RequestIdMiddleware)

    app.include_router(health_router)
    app.include_router(api_router, prefix=API_V1_PREFIX)
    _register_problem_schema(app)
    return app


def _register_problem_schema(app: FastAPI) -> None:
    """Always publish `Problem` in components so generated clients can type errors."""
    original = app.openapi

    def openapi() -> dict[str, object]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = original()
        components = schema.setdefault("components", {})
        schemas = components.setdefault("schemas", {})
        for name, model_schema in _problem_schemas().items():
            schemas.setdefault(name, model_schema)
        app.openapi_schema = schema
        return schema

    app.openapi = openapi  # type: ignore[method-assign]


def _problem_schemas() -> dict[str, object]:
    schema = Problem.model_json_schema(ref_template="#/components/schemas/{model}")
    defs: dict[str, object] = schema.pop("$defs", {})
    return {"Problem": schema, **defs}
