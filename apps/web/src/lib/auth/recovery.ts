// Recovery-session gate for `/reset-password` (AUTH-06, docs/auth.md §2/§3: "a password reset is
// only allowed with a valid recovery session"). Pure so it can be unit-tested.
//
// Supabase does not mark a recovery session in the JWT: verifyOtp sessions carry
// `amr: [{ method: 'otp', timestamp }]` whether the link was a recovery, sign-up confirmation or
// magic link. So a session counts as a recovery session only when BOTH hold:
//   1. `/auth/callback` redeemed a `type=recovery` link and stored that session's id in the
//      HttpOnly marker cookie (RECOVERY_COOKIE). The cookie must name the *current* session.
//   2. The verified JWT (getClaims) says the session was created by an OTP link within
//      RECOVERY_WINDOW_SECONDS. This is signed by Auth, so a stale or hand-made marker cannot
//      turn a password sign-in (amr=password) or an old session into a recovery session.
// The marker is cleared after a successful reset and whenever another link signs the user in.

export const RECOVERY_COOKIE = 'qz_recovery';
/** The marker is only ever read by `/reset-password` (page render + its server action). */
export const RECOVERY_COOKIE_PATH = '/reset-password';
/** How long after redeeming the link a new password may be set (also the cookie lifetime). */
export const RECOVERY_WINDOW_SECONDS = 15 * 60;

export interface RecoveryClaims {
  readonly sub: string;
  readonly session_id?: unknown;
  readonly amr?: unknown;
}

export interface RecoveryCheck {
  /** Verified claims of the current session, or null when signed out. */
  readonly claims: RecoveryClaims | null;
  /** Value of the RECOVERY_COOKIE marker, if any. */
  readonly marker: string | undefined;
  /** Current time in Unix seconds. */
  readonly now: number;
}

/** Latest `otp` authentication time recorded in the JWT `amr` claim, if any. */
export function otpAuthenticatedAt(amr: unknown): number | undefined {
  if (!Array.isArray(amr)) return undefined;
  let latest: number | undefined;
  for (const entry of amr as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (method !== 'otp' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    latest = latest === undefined ? timestamp : Math.max(latest, timestamp);
  }
  return latest;
}

export function isRecoverySession({ claims, marker, now }: RecoveryCheck): boolean {
  if (!claims || !marker) return false;
  if (typeof claims.session_id !== 'string' || claims.session_id !== marker) return false;
  const otpAt = otpAuthenticatedAt(claims.amr);
  if (otpAt === undefined) return false;
  // Small allowance for clock skew between the Auth server and this server.
  return otpAt <= now + 60 && now - otpAt <= RECOVERY_WINDOW_SECONDS;
}

/**
 * `session_id` claim of an access token the Auth server has just issued to this server (the
 * verifyOtp response in `/auth/callback`). Decoding without verification is fine only for that
 * case; every later read goes through getClaims().
 */
export function sessionIdFromAccessToken(accessToken: string | undefined): string | undefined {
  const payload = accessToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      session_id?: unknown;
    };
    return typeof claims.session_id === 'string' && claims.session_id
      ? claims.session_id
      : undefined;
  } catch {
    return undefined;
  }
}

export interface MarkerCookie {
  readonly name: string;
  readonly value: string;
  readonly options: {
    readonly httpOnly: true;
    readonly sameSite: 'lax';
    readonly secure: boolean;
    readonly path: string;
    readonly maxAge: number;
  };
}

/** Cookie that marks `sessionId` as a recovery session (`maxAge: 0` clears it). */
export function recoveryMarkerCookie(sessionId: string | null, secure: boolean): MarkerCookie {
  return {
    name: RECOVERY_COOKIE,
    value: sessionId ?? '',
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: RECOVERY_COOKIE_PATH,
      maxAge: sessionId ? RECOVERY_WINDOW_SECONDS : 0,
    },
  };
}
