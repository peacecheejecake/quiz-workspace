"""FastAPI dependency that authenticates the caller from `Authorization: Bearer <token>`.

Only the Authorization header is read: tokens in query strings, cookies or other headers are
ignored, so a request carrying them is unauthenticated (401). 401 means "no valid credentials";
403 (authorization) is decided by later dependencies (A1.3). An Auth/JWKS outage is 503.
Tokens are never logged or echoed; rejections log a fixed reason code only.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from quiz_api.auth.jwks import JwksCache, JwksUnavailableError
from quiz_api.auth.verifier import AuthenticatedUser, InvalidTokenError, TokenVerifier
from quiz_api.settings import Settings

logger = logging.getLogger(__name__)

# auto_error=False: missing/non-Bearer credentials are turned into our own problem+json 401.
bearer_scheme = HTTPBearer(
    auto_error=False,
    scheme_name="SupabaseAccessToken",
    description="Supabase Auth access token (asymmetrically signed JWT).",
)

_MISSING = 'Bearer realm="api"'
_INVALID = 'Bearer realm="api", error="invalid_token"'


def build_token_verifier(settings: Settings) -> TokenVerifier | None:
    if not settings.supabase_jwks_url or not settings.supabase_jwt_issuer:
        return None
    jwks = JwksCache(
        settings.supabase_jwks_url,
        ttl_seconds=settings.jwks_cache_ttl_seconds,
        min_refresh_interval_seconds=settings.jwks_min_refresh_interval_seconds,
        max_stale_seconds=settings.jwks_max_stale_seconds,
        timeout_seconds=settings.jwks_fetch_timeout_seconds,
    )
    return TokenVerifier(
        jwks,
        issuer=settings.supabase_jwt_issuer,
        audience=settings.supabase_jwt_audience,
        leeway_seconds=settings.jwt_leeway_seconds,
    )


def get_token_verifier(request: Request) -> TokenVerifier:
    verifier: TokenVerifier | None = request.app.state.token_verifier
    if verifier is None:
        logger.error("Access-token verification is not configured (SUPABASE_JWKS_URL/ISSUER)")
        raise HTTPException(status_code=503, detail="Authentication is not configured.")
    return verifier


def _unauthorized(www_authenticate: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail="Missing or invalid access token.",
        headers={"WWW-Authenticate": www_authenticate},
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    verifier: Annotated[TokenVerifier, Depends(get_token_verifier)],
) -> AuthenticatedUser:
    if credentials is None:
        raise _unauthorized(_MISSING)
    try:
        return await verifier.verify(credentials.credentials)
    except InvalidTokenError as exc:
        logger.info("Rejected access token: %s", exc.reason)
        verifier.jwks.metrics.incr(f"token_rejected_{exc.reason}")
        raise _unauthorized(_INVALID) from None
    except JwksUnavailableError:
        verifier.jwks.metrics.incr("auth_unavailable")
        logger.warning("Access token not verifiable: signing keys unavailable")
        raise HTTPException(
            status_code=503,
            detail="Authentication is temporarily unavailable.",
            headers={"Retry-After": "5"},
        ) from None


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
