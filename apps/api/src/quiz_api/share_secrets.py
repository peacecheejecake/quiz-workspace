"""Share-link secrets (docs/workspace-sharing.md §2).

A secret is 32 bytes (256 bits), encoded as unpadded base64url (43 characters) inside the URL
fragment `#k=`. PostgreSQL stores only `SHA-256(secret bytes)` (`token_digest`).

Owner links derive those 32 bytes deterministically via domain-separated HMAC-SHA-256 from the
server's `ShareSessionKey` (`SHARE_SESSION_SECRET`) and the link's UUID (`derive_secret`). That
lets the server reconstruct `share_url` on owner reads (`reconstruct_secret`) only when the
candidate's SHA-256 matches `token_digest` — while keeping the DB strictly digest-only (a leaked
table reveals neither the link secret nor the server key) and never emitting a broken URL for
legacy random-secret rows or key changes.

Secrets never go to logs, exceptions, activity metadata or the idempotency store; `IssuedSecret`
keeps the value out of `repr()`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import uuid
from dataclasses import dataclass, field

SECRET_BYTES = 32
DIGEST_BYTES = 32
LINK_SECRET_DOMAIN = b"quiz-share-link/v1|"
# Unpadded base64url of exactly 32 bytes.
_SECRET_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")


@dataclass(frozen=True)
class IssuedSecret:
    value: str = field(repr=False)
    digest: bytes = field(repr=False)


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _digest(raw: bytes) -> bytes:
    return hashlib.sha256(raw).digest()


def issue_secret() -> IssuedSecret:
    raw = secrets.token_bytes(SECRET_BYTES)
    return IssuedSecret(value=_encode(raw), digest=_digest(raw))


def derive_secret(key_bytes: bytes, link_id: uuid.UUID) -> IssuedSecret:
    """Domain-separated deterministic secret for `link_id` under `key_bytes`."""
    raw = hmac.new(key_bytes, LINK_SECRET_DOMAIN + link_id.bytes, hashlib.sha256).digest()
    return IssuedSecret(value=_encode(raw), digest=_digest(raw))


def reconstruct_secret(key_bytes: bytes, link_id: uuid.UUID, stored_digest: bytes) -> str | None:
    """Re-derive `link_id`'s secret when its SHA-256 matches `stored_digest`; else None."""
    candidate = derive_secret(key_bytes, link_id)
    if hmac.compare_digest(candidate.digest, stored_digest):
        return candidate.value
    return None


def digest_of(secret: str) -> bytes | None:
    """The stored digest for a presented secret, or None if it is not a well-formed secret.

    Only the canonical encoding is accepted (the last character's unused bits must be zero), so
    one secret has exactly one spelling.
    """
    if not _SECRET_PATTERN.fullmatch(secret):
        return None
    raw = base64.urlsafe_b64decode(secret + "=")
    if _encode(raw) != secret:
        return None
    return _digest(raw)


def secret_matches(secret: str, stored_digest: bytes) -> bool:
    """Constant-time check of a presented secret against a stored digest (S1b exchange)."""
    presented = digest_of(secret)
    if presented is None:
        # Still compare once so malformed and wrong secrets take the same path.
        hmac.compare_digest(stored_digest, bytes(DIGEST_BYTES))
        return False
    return hmac.compare_digest(presented, stored_digest)
