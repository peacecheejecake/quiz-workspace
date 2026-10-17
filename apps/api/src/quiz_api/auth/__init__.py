"""Authentication: Supabase Auth access-token verification (docs/auth.md §3/§5)."""

from quiz_api.auth.dependencies import CurrentUser, get_current_user
from quiz_api.auth.verifier import AuthenticatedUser

__all__ = ["AuthenticatedUser", "CurrentUser", "get_current_user"]
