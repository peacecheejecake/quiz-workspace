"""Supabase Auth access-token verification (docs/auth.md §3, AUTH-API-AC01).

Every check is done by PyJWT against a key from the issuer's JWKS: the header must name an
allowlisted asymmetric algorithm and a `kid`, the key published under that `kid` must be of the
same algorithm, and the signature, `iss`, `aud`, `exp`/`iat` (small leeway) must verify. On top,
`sub` must be a UUID and `role` must be `authenticated` (anon/service tokens are not users).

`InvalidTokenError.reason` is a fixed code for logs and tests; it never carries token content.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

import jwt
from jwt.exceptions import (
    ExpiredSignatureError,
    ImmatureSignatureError,
    InvalidAudienceError,
    InvalidIssuerError,
    InvalidSignatureError,
    MissingRequiredClaimError,
)
from jwt.exceptions import InvalidTokenError as PyJWTInvalidTokenError

from quiz_api.auth.jwks import ALLOWED_ALGORITHMS, JwksCache

logger = logging.getLogger(__name__)

# Real access tokens are ~1 KB; anything far larger is rejected before parsing.
MAX_TOKEN_LENGTH = 8192
AUTHENTICATED_ROLE = "authenticated"


class InvalidTokenError(Exception):
    """The presented token is not a valid access token for this API (→ 401)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class AuthenticatedUser:
    """The caller, derived only from a verified access token."""

    id: uuid.UUID
    session_id: str | None = None


class TokenVerifier:
    def __init__(
        self,
        jwks: JwksCache,
        *,
        issuer: str,
        audience: str,
        leeway_seconds: float = 30.0,
    ) -> None:
        self.jwks = jwks
        self._issuer = issuer
        self._audience = audience
        self._leeway = leeway_seconds

    async def verify(self, token: str) -> AuthenticatedUser:
        """Raises `InvalidTokenError` (401) or `JwksUnavailableError` (503)."""
        if not token or len(token) > MAX_TOKEN_LENGTH or token.count(".") != 2:
            raise InvalidTokenError("malformed")
        try:
            header = jwt.get_unverified_header(token)
        except PyJWTInvalidTokenError:
            raise InvalidTokenError("malformed") from None

        alg = header.get("alg")
        if not isinstance(alg, str) or alg not in ALLOWED_ALGORITHMS:
            raise InvalidTokenError("algorithm_not_allowed")
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise InvalidTokenError("missing_kid")

        key = await self.jwks.get_key(kid)
        if key is None:
            raise InvalidTokenError("unknown_kid")
        if key.algorithm_name != alg:
            raise InvalidTokenError("algorithm_key_mismatch")

        claims = self._decode(token, key.key, alg)
        return self._principal(claims)

    def _decode(self, token: str, key: Any, alg: str) -> dict[str, Any]:
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                key=key,
                algorithms=[alg],
                audience=self._audience,
                issuer=self._issuer,
                leeway=self._leeway,
                options={
                    "require": ["exp", "iat", "iss", "aud", "sub"],
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_iat": True,
                    "verify_nbf": True,
                    "verify_iss": True,
                    "verify_aud": True,
                    "strict_aud": False,
                },
            )
        except InvalidSignatureError:
            raise InvalidTokenError("invalid_signature") from None
        except ExpiredSignatureError:
            raise InvalidTokenError("expired") from None
        except ImmatureSignatureError:
            raise InvalidTokenError("not_yet_valid") from None
        except InvalidAudienceError:
            raise InvalidTokenError("invalid_audience") from None
        except InvalidIssuerError:
            raise InvalidTokenError("invalid_issuer") from None
        except MissingRequiredClaimError:
            raise InvalidTokenError("missing_claim") from None
        except PyJWTInvalidTokenError:
            raise InvalidTokenError("invalid") from None
        return claims

    @staticmethod
    def _principal(claims: dict[str, Any]) -> AuthenticatedUser:
        sub = claims.get("sub")
        try:
            user_id = uuid.UUID(sub) if isinstance(sub, str) else None
        except ValueError:
            user_id = None
        if user_id is None or str(user_id) != sub:
            raise InvalidTokenError("invalid_sub")
        if claims.get("role") != AUTHENTICATED_ROLE:
            raise InvalidTokenError("invalid_role")
        session_id = claims.get("session_id")
        return AuthenticatedUser(
            id=user_id, session_id=session_id if isinstance(session_id, str) else None
        )
