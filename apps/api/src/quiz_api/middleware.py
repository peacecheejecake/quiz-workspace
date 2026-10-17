"""Request-id / correlation-id middleware with a header-free access log."""

from __future__ import annotations

import logging
import re
import time
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from quiz_api.logging_config import request_id_var

REQUEST_ID_HEADER = "X-Request-ID"
_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

access_logger = logging.getLogger("quiz_api.access")


def _resolve_request_id(scope: Scope) -> str:
    incoming = Headers(scope=scope).get(REQUEST_ID_HEADER)
    if incoming and _VALID_REQUEST_ID.fullmatch(incoming):
        return incoming
    return uuid.uuid4().hex


class RequestIdMiddleware:
    """Assigns a request id, exposes it on the response and logs one access line.

    The access line records method, path (never the query string), status and duration.
    Request headers, including `Authorization`, are never logged.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _resolve_request_id(scope)
        scope.setdefault("state", {})["request_id"] = request_id
        token = request_id_var.set(request_id)
        status_code = 500
        started = time.perf_counter()

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        except Exception as exc:
            access_logger.error(
                "Unhandled %s on %s %s",
                type(exc).__name__,
                scope["method"],
                scope["path"],
                exc_info=exc,
            )
            raise
        finally:
            access_logger.info(
                "%s %s %s %.1fms",
                scope["method"],
                scope["path"],
                status_code,
                (time.perf_counter() - started) * 1000,
            )
            request_id_var.reset(token)


class NoStoreMiddleware:
    """`Cache-Control: no-store` for per-user API responses (docs/auth.md §5).

    Applied to every response under `path_prefix` (success and error alike), and to any
    response to a request that carried an `Authorization` header, overriding whatever the
    route set: authenticated responses must never land in a shared cache. Public endpoints
    outside the prefix that want caching set their own header.
    """

    def __init__(self, app: ASGIApp, *, path_prefix: str) -> None:
        self.app = app
        self.path_prefix = path_prefix.rstrip("/")

    def _applies(self, scope: Scope) -> bool:
        path: str = scope["path"]
        if path == self.path_prefix or path.startswith(f"{self.path_prefix}/"):
            return True
        return "authorization" in Headers(scope=scope)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self._applies(scope):
            await self.app(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_no_store)
