"""`Idempotency-Key` request header support for POST operations (docs/architecture.md §6).

Semantics (aligned with the IETF httpapi Idempotency-Key draft):
  * Optional header, 1-200 visible ASCII characters. Without it a POST behaves normally.
  * Scope: (verified user id, operation scope such as `POST /workspaces`, key). Keys never
    collide across users or endpoints.
  * Same key + same request body within the retention window (24 h): the first response is
    returned again (same status and body) with `Idempotent-Replayed: true`; nothing is re-run.
  * Same key + different body: 409 `ProblemType.IDEMPOTENCY_KEY_REUSED`.
  * Concurrent requests with the same key are serialised (advisory lock) instead of racing.
  * Only successful responses are stored, in the same transaction as the operation's writes, so
    a failed request can be retried with the same key.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any

from fastapi import Header
from fastapi.responses import JSONResponse

from quiz_api.errors import ProblemException, ProblemType
from quiz_api.repositories.idempotency import StoredResponse

IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"
REPLAYED_HEADER = "Idempotent-Replayed"
KEY_PATTERN = r"^[!-~]{1,200}$"

IdempotencyKey = Annotated[
    str | None,
    Header(
        alias=IDEMPOTENCY_KEY_HEADER,
        pattern=KEY_PATTERN,
        description=(
            "Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). "
            "Retrying with the same key and body within 24 hours returns the original response "
            f"(marked `{REPLAYED_HEADER}: true`); the same key with a different body is 409."
        ),
    ),
]


def request_hash(body: Any) -> str:
    """SHA-256 of the canonical JSON of the validated request body."""
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def replay(stored: StoredResponse, expected_hash: str) -> JSONResponse:
    """The stored response for a retry, or 409 if the key was used for a different body."""
    if stored.request_hash != expected_hash:
        raise ProblemException(
            409,
            ProblemType.IDEMPOTENCY_KEY_REUSED,
            detail="This Idempotency-Key was already used with a different request body.",
        )
    return JSONResponse(stored.body, status_code=stored.status, headers={REPLAYED_HEADER: "true"})
