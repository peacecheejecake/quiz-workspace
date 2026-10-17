"""Share sessions: the read-only capability a guest gets for one share link (S1b).

docs/workspace-sharing.md §2: the link secret travels once, in the URL fragment, to
`POST /shared/{shareId}/sessions`, which answers with a short-lived `HttpOnly; Secure;
SameSite=Lax` cookie. The session is not a Supabase login and never a membership.

The cookie value is a stateless token, `v1.<link id>.<expiry>.<mac>`:
  * `mac` = HMAC-SHA-256 over the version, link id, expiry *and the link's stored digest*, so a
    session dies with its link: rotate issues a new link id and digest, and a forged or stale
    token never verifies;
  * the secret itself is never part of it (nor derivable from it);
  * it only *authenticates* the session. Usability (not revoked, not expired, workspace not
    deleted) is re-read from the database on every shared request (`SharedRepository`), so
    revoke / expiry / delete block existing sessions on the very next request.

Key: `SHARE_SESSION_SECRET` (≥ 32 characters). Locally and in tests an unset key is replaced by
a random per-process key (sessions end when the API restarts); preview/production without it
answer 503 on the shared routes instead of minting sessions other replicas cannot verify.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field

SHARE_COOKIE = "quiz_share_session"
FORMAT_VERSION = "v1"
MIN_KEY_CHARS = 32
_TOKEN = re.compile(r"v1\.([0-9a-f]{32})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})")


@dataclass(frozen=True)
class ShareSessionKey:
    value: bytes = field(repr=False)

    @classmethod
    def random(cls) -> ShareSessionKey:
        return cls(secrets.token_bytes(32))

    @classmethod
    def from_secret(cls, secret: str) -> ShareSessionKey:
        if len(secret) < MIN_KEY_CHARS:
            raise ValueError(f"SHARE_SESSION_SECRET must have at least {MIN_KEY_CHARS} characters")
        # Domain-separated derivation: the configured string never keys anything else.
        return cls(hmac.new(secret.encode(), b"quiz-share-session/v1", hashlib.sha256).digest())


@dataclass(frozen=True)
class ShareSessionClaims:
    link_id: uuid.UUID
    expires_at: int  # unix seconds


def _mac(key: ShareSessionKey, link_id: uuid.UUID, expires_at: int, token_digest: bytes) -> str:
    message = f"{FORMAT_VERSION}|{link_id.hex}|{expires_at}|".encode() + token_digest
    raw = hmac.new(key.value, message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def issue_token(
    key: ShareSessionKey,
    link_id: uuid.UUID,
    token_digest: bytes,
    ttl_seconds: int,
    *,
    now: float | None = None,
) -> tuple[str, int]:
    """(cookie value, expiry in unix seconds) of a new session for `link_id`."""
    expires_at = int(now if now is not None else time.time()) + ttl_seconds
    mac = _mac(key, link_id, expires_at, token_digest)
    return f"{FORMAT_VERSION}.{link_id.hex}.{expires_at}.{mac}", expires_at


def parse_token(value: str | None, *, now: float | None = None) -> ShareSessionClaims | None:
    """The claims of a well-formed, unexpired token (its MAC is checked by `verify_token`)."""
    if not value:
        return None
    match = _TOKEN.fullmatch(value)
    if match is None:
        return None
    expires_at = int(match.group(2))
    if expires_at <= int(now if now is not None else time.time()):
        return None
    return ShareSessionClaims(link_id=uuid.UUID(hex=match.group(1)), expires_at=expires_at)


def verify_token(
    key: ShareSessionKey, value: str, claims: ShareSessionClaims, token_digest: bytes
) -> bool:
    """Constant-time MAC check of a parsed token against the link's current digest."""
    presented = value.rsplit(".", 1)[-1]
    expected = _mac(key, claims.link_id, claims.expires_at, token_digest)
    return hmac.compare_digest(presented, expected)
