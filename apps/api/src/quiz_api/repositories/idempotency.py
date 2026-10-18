"""`Idempotency-Key` replay store over `public.idempotency_keys` (M3.1a).

Used inside the request transaction of the operation it protects:

    store.lock(user, scope, key)          # serialise concurrent requests with the same key
    stored = store.find(user, scope, key) # replay or reject (different body) if present
    ... perform the operation ...
    store.save(user, scope, key, request_hash, status, body)
    commit                                # operation + stored response commit together

The lock is a transaction-scoped advisory lock, released at commit/rollback, so a concurrent
retry waits for the first request to finish and then finds its stored response. Expired rows
are ignored by `find` and overwritten by `save`.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from quiz_api.repositories.tables import idempotency_keys

DEFAULT_TTL = timedelta(hours=24)


@dataclass(frozen=True)
class StoredResponse:
    request_hash: str
    status: int
    body: Any


class IdempotencyStore:
    def __init__(self, session: Session, ttl: timedelta = DEFAULT_TTL) -> None:
        self._session = session
        self._ttl = ttl

    def lock(self, user_id: uuid.UUID, scope: str, key: str) -> None:
        # 64-bit hash of the full scope; a collision only serialises two unrelated requests.
        lock_id = func.hashtextextended(f"idempotency:{user_id}:{scope}:{key}", 0)
        self._session.execute(select(func.pg_advisory_xact_lock(lock_id)))

    def find(self, user_id: uuid.UUID, scope: str, key: str) -> StoredResponse | None:
        row = self._session.execute(
            select(
                idempotency_keys.c.request_hash,
                idempotency_keys.c.response_status,
                idempotency_keys.c.response_body,
            ).where(
                idempotency_keys.c.user_id == user_id,
                idempotency_keys.c.scope == scope,
                idempotency_keys.c.key == key,
                idempotency_keys.c.expires_at > func.now(),
            )
        ).one_or_none()
        if row is None:
            return None
        return StoredResponse(row.request_hash, row.response_status, row.response_body)

    def save(
        self,
        user_id: uuid.UUID,
        scope: str,
        key: str,
        request_hash: str,
        status: int,
        body: Any,
    ) -> None:
        values = {
            "request_hash": request_hash,
            "response_status": status,
            "response_body": body,
            "created_at": func.now(),
            "expires_at": func.now() + self._ttl,
        }
        stmt = insert(idempotency_keys).values(user_id=user_id, scope=scope, key=key, **values)
        # Only an expired row can conflict here: a live one was returned by `find` under the lock.
        self._session.execute(
            stmt.on_conflict_do_update(
                index_elements=[
                    idempotency_keys.c.user_id,
                    idempotency_keys.c.scope,
                    idempotency_keys.c.key,
                ],
                set_=values,
                where=idempotency_keys.c.expires_at <= func.now(),
            )
        )
