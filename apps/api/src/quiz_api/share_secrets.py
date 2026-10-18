"""Share-link secrets (docs/workspace-sharing.md §2).

A secret is 32 bytes from the OS CSPRNG, handed out once as unpadded base64url (43 characters)
inside the URL fragment `#k=`. The server stores only `SHA-256(secret bytes)`.

Why plain SHA-256 and no server-side pepper (HMAC): the secret carries 256 bits of entropy, so a
leaked digest can be neither inverted nor brute-forced offline; a pepper would add a key that has
to be provisioned per environment and whose rotation silently kills every link, for no gain in
this threat model. (Peppers matter for low-entropy inputs such as passwords.)

Secrets never go to logs, exceptions, activity metadata or the idempotency store; `IssuedSecret`
keeps the value out of `repr()`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass, field

SECRET_BYTES = 32
DIGEST_BYTES = 32
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
