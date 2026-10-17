"""Browser-facing hardening: CORS allowlist, Origin guard and security response headers.

docs/auth.md §5 and docs/deployment.md §1/§6: the browser calls the API with a Bearer token from
an explicit list of web origins only (no wildcard, no cookies → no credentialed CORS); every
response carries `nosniff`, `Referrer-Policy: no-referrer` and, when served over HTTPS, HSTS.
The `Server` header is turned off in the launcher (`quiz_api.serve`).
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import FastAPI
from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from quiz_api.errors import problem_response
from quiz_api.idempotency import IDEMPOTENCY_KEY_HEADER
from quiz_api.middleware import REQUEST_ID_HEADER, security_headers

CORS_ALLOWED_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
CORS_ALLOWED_HEADERS = ("Authorization", "Content-Type", IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER)
CORS_EXPOSED_HEADERS = (REQUEST_ID_HEADER,)


class SecurityHeadersMiddleware:
    """Adds the security headers to every HTTP response (errors and CORS preflights included).

    HSTS is sent when `force_hsts` (preview/production, where TLS terminates at the platform
    edge) or when the request itself arrived over https.
    """

    def __init__(
        self, app: ASGIApp, *, force_hsts: bool, csp_exempt_paths: Iterable[str] = ()
    ) -> None:
        self.app = app
        self.force_hsts = force_hsts
        self.csp_exempt_paths = frozenset(csp_exempt_paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = security_headers(
            https=self.force_hsts or scope.get("scheme") == "https",
            csp=scope["path"] not in self.csp_exempt_paths,
        )

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = MutableHeaders(scope=message)
                for key, value in headers.items():
                    response_headers[key] = value
                if "server" in response_headers:
                    del response_headers["server"]
            await send(message)

        await self.app(scope, receive, send_with_headers)


class OriginGuardMiddleware:
    """Rejects (403) any request whose `Origin` is neither allowlisted nor the API's own origin.

    CORS alone only stops the browser from *reading* a response; a cross-origin write would still
    run. Requests without `Origin` (server-to-server, e.g. the Next.js server) are not affected.
    `Origin: null` (sandboxed/opaque contexts) is never allowlisted.
    """

    def __init__(self, app: ASGIApp, *, allowed_origins: Iterable[str]) -> None:
        self.app = app
        self.allowed_origins = frozenset(allowed_origins)

    def _allowed(self, origin: str, headers: Headers) -> bool:
        if origin in self.allowed_origins:
            return True
        host = headers.get("host")
        # Same-origin (e.g. the local interactive docs page): compare authority only, since TLS
        # may terminate in front of the app.
        return host is not None and origin.split("://", 1)[-1] == host.lower()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        origin = headers.get("origin")
        if origin is None or self._allowed(origin.strip().lower().rstrip("/"), headers):
            await self.app(scope, receive, send)
            return
        response = problem_response(Request(scope), 403, detail="Origin not allowed.")
        await response(scope, receive, send)


def install_browser_security(app: FastAPI, *, allowed_origins: Iterable[str], max_age: int) -> None:
    """CORS + Origin guard. Call before `RequestIdMiddleware`/headers so those wrap them."""
    origins = list(allowed_origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=list(CORS_ALLOWED_METHODS),
        allow_headers=list(CORS_ALLOWED_HEADERS),
        expose_headers=list(CORS_EXPOSED_HEADERS),
        max_age=max_age,
    )
    app.add_middleware(OriginGuardMiddleware, allowed_origins=origins)
