// Defensive wrappers for server-side session reads. With a malformed `sb-…-auth-token` cookie
// (e.g. a non-JSON JWT segment) the SDK can throw instead of returning `{ error }`; every server
// read treats that as "signed out" so a bad cookie never turns into a 500.
import type { SupabaseClient } from '@supabase/supabase-js';

/** Supabase session cookie, possibly chunked (`.0`, `.1`, …). Not the PKCE code-verifier cookie. */
export const SESSION_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;

export function isSessionCookie(name: string): boolean {
  return SESSION_COOKIE.test(name);
}

/** The JWT claims the web app reads (all verified by getClaims()). */
export interface VerifiedClaims {
  readonly sub: string;
  readonly email?: unknown;
  readonly session_id?: unknown;
  readonly amr?: unknown;
}

export interface ClaimsResult {
  /** Verified claims, or null when signed out or unverifiable. */
  readonly claims: VerifiedClaims | null;
  /** True when reading the session threw (corrupt cookie): callers should clear the cookies. */
  readonly corrupt: boolean;
}

export async function readVerifiedClaims(supabase: SupabaseClient): Promise<ClaimsResult> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (error || !claims?.sub) return { claims: null, corrupt: false };
    return { claims, corrupt: false };
  } catch {
    return { claims: null, corrupt: true };
  }
}
