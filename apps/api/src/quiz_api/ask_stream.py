"""Reading an answer's Redis Stream (ASK-01 "실행 경로" 3-4, C05).

The `ask.answer` worker appends to `ask:msg:<message id>` (XADD, approximate MAXLEN, TTL 10
minutes refreshed on every write) entries with three fields: `event` (`delta` | `reset` |
`done` | `error`), `seq` (1, 2, ... over all events of the message: a delta's SSE id) and `data`
(JSON: `{"seq", "text"}` for a delta, `{"code"}` for an error, `{}` otherwise). The key holds the
message id only. Redis is internal; browsers reach it through the API's SSE relay only. The
layout is mirrored (not imported) from `quiz_worker.ask_store`; `apps/api/tests/test_ask_stream.py`
checks they match.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

STREAM_KEY_PREFIX = "ask:msg:"
START = "0-0"


def stream_key(message_id: uuid.UUID | str) -> str:
    return f"{STREAM_KEY_PREFIX}{message_id}"


@dataclass(frozen=True)
class StreamEntry:
    stream_id: str
    event: str
    seq: int
    data: dict[str, Any]


class RedisLike(Protocol):
    def xrange(self, name: str, min: str = "-", max: str = "+") -> Any: ...

    def xread(
        self, streams: dict[str, str], count: int | None = None, block: int | None = None
    ) -> Any: ...


def _text(value: Any) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


def _entry(stream_id: Any, fields: dict[Any, Any]) -> StreamEntry | None:
    values = {_text(k): _text(v) for k, v in fields.items()}
    try:
        seq = int(values.get("seq", ""))
        data = json.loads(values.get("data") or "{}")
    except ValueError:
        return None
    event = values.get("event", "")
    if event not in {"delta", "reset", "done", "error"} or not isinstance(data, dict):
        return None
    return StreamEntry(_text(stream_id), event, seq, data)


class AskStreamReader:
    def __init__(self, client: RedisLike, *, key_prefix: str = STREAM_KEY_PREFIX) -> None:
        self._client = client
        # EXPL-B: AI explanations use the same layout under `explain:<id>`.
        self._prefix = key_prefix

    def _key(self, message_id: uuid.UUID) -> str:
        return f"{self._prefix}{message_id}"

    def entries(self, message_id: uuid.UUID) -> list[StreamEntry]:
        raw = self._client.xrange(self._key(message_id))
        return [e for sid, fields in raw or [] if (e := _entry(sid, fields)) is not None]

    def read_after(
        self, message_id: uuid.UUID, stream_id: str, *, block_ms: int
    ) -> list[StreamEntry]:
        """Entries after `stream_id`, waiting up to `block_ms` for the first one."""
        raw = self._client.xread({self._key(message_id): stream_id}, count=200, block=block_ms)
        out: list[StreamEntry] = []
        for _key, items in raw or []:
            for sid, fields in items:
                entry = _entry(sid, fields)
                if entry is not None:
                    out.append(entry)
        return out

    def text_so_far(self, message_id: uuid.UUID) -> str:
        """The streamed text after the last `reset` (empty without a stream)."""
        return assemble(self.entries(message_id))


def assemble(entries: list[StreamEntry]) -> str:
    parts: list[str] = []
    for entry in entries:
        if entry.event == "reset":
            parts = []
        elif entry.event == "delta":
            parts.append(str(entry.data.get("text", "")))
    return "".join(parts)


def build_redis(url: str) -> Any:
    import redis

    return redis.Redis.from_url(url, socket_timeout=10, socket_connect_timeout=3)
