"""Client identity behind the web relay (BFF), for per-client rate limits (S1b).

The browser reaches the guest share routes only through the Next.js relay
(apps/web/src/lib/shared), so the socket peer of every such request is the relay itself. Keying
a limiter on it would let one visitor's failed exchanges lock everyone out of a link. The relay
therefore states which client it acts for:

    X-Quiz-Relay-Client:    opaque client id (the relay sends a SHA-256 of the client address
                            from the hosting edge's header, base64url; never the raw address)
    X-Quiz-Relay-Signature: hex HMAC-SHA-256(RELAY_CLIENT_SECRET, "quiz-relay-client/v1|" + id)

`RELAY_CLIENT_SECRET` is server-only (API and web server, never NEXT_PUBLIC_). The headers are
honoured only when the secret is configured and the signature verifies; otherwise they are
ignored and the socket peer is the client (a plain X-Forwarded-For is never trusted). An
attacker on the internet cannot mint a signature, and the relay derives the id from the edge's
client-address header, not from anything the browser controls.
"""

from __future__ import annotations

import hashlib
import hmac
import re

from starlette.requests import Request

from quiz_api.settings import Settings

CLIENT_HEADER = "X-Quiz-Relay-Client"
SIGNATURE_HEADER = "X-Quiz-Relay-Signature"
_DOMAIN = b"quiz-relay-client/v1|"
_CLIENT = re.compile(r"[A-Za-z0-9_-]{1,64}")
_SIGNATURE = re.compile(r"[0-9a-f]{64}")


def relay_signature(secret: str, client_id: str) -> str:
    return hmac.new(secret.encode(), _DOMAIN + client_id.encode(), hashlib.sha256).hexdigest()


def relay_configured(settings: Settings) -> bool:
    secret = settings.relay_client_secret
    return secret is not None and bool(secret.get_secret_value())


def client_key(request: Request) -> str:
    """`relay:<id>` for a verified relay statement, else `peer:<socket address>`."""
    settings: Settings = request.app.state.settings
    secret = settings.relay_client_secret
    client_id = request.headers.get(CLIENT_HEADER)
    signature = request.headers.get(SIGNATURE_HEADER)
    if (
        secret is not None
        and secret.get_secret_value()
        and client_id is not None
        and signature is not None
        and _CLIENT.fullmatch(client_id)
        and _SIGNATURE.fullmatch(signature)
        and hmac.compare_digest(signature, relay_signature(secret.get_secret_value(), client_id))
    ):
        return f"relay:{client_id}"
    return f"peer:{request.client.host if request.client else 'unknown'}"
