"""`Server-Timing` on the question opening routes (UX12-OPEN, docs/screens/ux12-question-open.md).

Only durations and a statement count leave the process, never SQL or parameters. `db` adds up the
cursor time of the request (BEGIN/COMMIT excluded), `app` is the whole request. The routes run in
a worker thread with a copy of this context, so the counters live in one shared mutable object.
"""

from __future__ import annotations

import re
import time
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Engine, event
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

SERVER_TIMING_HEADER = "Server-Timing"
_TIMED_PATH = re.compile(r"^/api/v1/questions/[^/]+/practice-(?:open|recent|sessions)$")
_STARTED_AT = "quiz_server_timing_started_at"


@dataclass
class _Timing:
    db_seconds: float = 0.0
    statements: int = 0


_timing: ContextVar[_Timing | None] = ContextVar("quiz_server_timing", default=None)


def install_statement_timing(engine: Engine) -> None:
    """Add each statement's duration to the timed request running it (no-op elsewhere)."""

    @event.listens_for(engine, "before_cursor_execute")
    def _before(
        _conn: Any, _cursor: Any, _statement: Any, _params: Any, context: Any, _many: Any
    ) -> None:
        if _timing.get() is not None:
            setattr(context, _STARTED_AT, time.perf_counter())

    @event.listens_for(engine, "after_cursor_execute")
    def _after(
        _conn: Any, _cursor: Any, _statement: Any, _params: Any, context: Any, _many: Any
    ) -> None:
        timing = _timing.get()
        started = getattr(context, _STARTED_AT, None)
        if timing is not None and started is not None:
            timing.db_seconds += time.perf_counter() - started
            timing.statements += 1


class ServerTimingMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _TIMED_PATH.fullmatch(scope["path"]):
            await self.app(scope, receive, send)
            return

        timing = _Timing()
        token = _timing.set(timing)
        started = time.perf_counter()

        async def send_with_timing(message: Message) -> None:
            if message["type"] == "http.response.start":
                total = (time.perf_counter() - started) * 1000
                MutableHeaders(scope=message)[SERVER_TIMING_HEADER] = (
                    f'db;dur={timing.db_seconds * 1000:.1f};desc="{timing.statements}", '
                    f"app;dur={total:.1f}"
                )
            await send(message)

        try:
            await self.app(scope, receive, send_with_timing)
        finally:
            _timing.reset(token)
