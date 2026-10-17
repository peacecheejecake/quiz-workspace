// Route-level access rules (docs/auth.md §2), kept pure so the proxy decision is unit-testable.
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from './safe-next';

export const LOGIN_PATH = '/login';
export const AUTH_ERROR_PATH = '/auth/error';
export const RESET_PASSWORD_PATH = '/reset-password';
export const ACCOUNT_SECURITY_PATH = '/settings/security';

/** Areas that require a verified session. */
export const PROTECTED_PREFIXES = ['/workspaces', '/documents', '/questions', '/settings'] as const;

/**
 * Sign-in/sign-up entry pages a signed-in user is bounced away from. `/reset-password` (needs the
 * recovery session), `/auth/callback`, `/auth/error` and `/auth/verify` stay reachable.
 */
export const SIGNED_OUT_ONLY_PATHS = ['/login', '/signup', '/forgot-password'] as const;

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => underPrefix(pathname, prefix));
}

export function isSignedOutOnlyPath(pathname: string): boolean {
  return (SIGNED_OUT_ONLY_PATHS as readonly string[]).includes(pathname.replace(/\/+$/, '') || '/');
}

/** `/login?next=<path+query>`; `next` is omitted when the target is not a safe internal path. */
export function loginRedirectPath(target?: string): string {
  if (target === undefined) return LOGIN_PATH;
  const next = safeNextPath(target, '');
  return next ? `${LOGIN_PATH}?${new URLSearchParams({ next }).toString()}` : LOGIN_PATH;
}

export type AccessDecision =
  { readonly action: 'continue' } | { readonly action: 'redirect'; readonly location: string };

export interface AccessRequest {
  readonly pathname: string;
  /** Raw query string including the leading `?`, or empty. */
  readonly search: string;
  /** True only when the session's JWT was verified (`getClaims()`), never from cookie presence. */
  readonly authenticated: boolean;
}

/** What the proxy does with a request: let it through or redirect it (relative location). */
export function decideAccess({ pathname, search, authenticated }: AccessRequest): AccessDecision {
  if (!authenticated && isProtectedPath(pathname)) {
    return { action: 'redirect', location: loginRedirectPath(`${pathname}${search}`) };
  }
  if (authenticated && isSignedOutOnlyPath(pathname)) {
    const next = new URLSearchParams(search).get('next');
    return { action: 'redirect', location: safeNextPath(next, DEFAULT_AFTER_SIGN_IN) };
  }
  return { action: 'continue' };
}
