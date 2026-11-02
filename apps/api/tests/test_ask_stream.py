"""The API's reading of an answer's Redis Stream mirrors the worker's writing (ASK-01-C05)."""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
from quiz_api.ask_stream import STREAM_KEY_PREFIX, AskStreamReader, assemble, stream_key

ask_store = pytest.importorskip("quiz_worker.ask_store")


class FakeRedis:
    def __init__(self) -> None:
        self.entries: dict[str, list[tuple[bytes, dict[bytes, bytes]]]] = {}

    def add(self, key: str, fields: dict[str, str]) -> None:
        items = self.entries.setdefault(key, [])
        encoded = {k.encode(): v.encode() for k, v in fields.items()}
        items.append((f"{len(items) + 1}-0".encode(), encoded))

    def xrange(self, name: str, min: str = "-", max: str = "+") -> Any:
        return self.entries.get(name, [])

    def xread(
        self, streams: dict[str, str], count: int | None = None, block: int | None = None
    ) -> Any:
        [(key, after)] = streams.items()
        start = int(after.split("-")[0])
        items = [e for e in self.entries.get(key, []) if int(e[0].split(b"-")[0]) > start]
        return [(key.encode(), items)]


def test_key_layout_matches_the_worker() -> None:
    message_id = uuid.uuid4()
    assert STREAM_KEY_PREFIX == ask_store.STREAM_KEY_PREFIX
    assert stream_key(message_id) == ask_store.stream_key(message_id)


def test_reader_assembles_the_text_after_the_last_reset_and_reads_after_an_id() -> None:
    redis = FakeRedis()
    message_id = uuid.uuid4()
    key = stream_key(message_id)

    def add(event: str, seq: int, data: dict[str, Any]) -> None:
        redis.add(key, {"event": event, "seq": str(seq), "data": json.dumps(data)})

    add("delta", 1, {"seq": 1, "text": "old"})
    add("reset", 2, {})
    add("delta", 3, {"seq": 3, "text": "가나"})
    add("delta", 4, {"seq": 4, "text": "다 [S1]"})
    redis.add(key, {"event": "bogus", "seq": "x", "data": "{"})
    add("done", 5, {})
    reader = AskStreamReader(redis)
    entries = reader.entries(message_id)
    assert [e.event for e in entries] == ["delta", "reset", "delta", "delta", "done"]
    assert reader.text_so_far(message_id) == "가나다 [S1]"
    assert assemble(entries[:1]) == "old"
    later = reader.read_after(message_id, "3-0", block_ms=0)
    assert [e.seq for e in later] == [4, 5]
