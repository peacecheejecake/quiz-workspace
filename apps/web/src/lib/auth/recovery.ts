// Recovery-session gate for `/reset-password` (AUTH-06, docs/auth.md §2/§3: "a password reset is
// only allowed with a valid recovery session"). Server-only (node:crypto); pure apart from that so
// it can be unit-tested.
//
// Supabase does not mark a recovery session in the JWT: verifyOtp sessions carry
// `amr: [{ method: 'otp', timestamp }]` whether the link was a recovery, sign-up confirmation or
// magic link. So a session counts as a recovery session only when ALL hold:
//   1. `/auth/callback` redeemed a `type=recovery` link and issued the marker cookie
//      (RECOVERY_COOKIE): an HMAC-SHA256-signed payload {purpose, session id, user id, issued-at,
//      expiry} under a server-only secret. HttpOnly does not authenticate what a client sends
//      back, the signature does: a client with any other OTP session cannot mint one.
//   2. The marker's session id and user id match the verified JWT (getClaims), and the marker has
//      not expired.
//   3. The JWT says the session was created by an OTP link within RECOVERY_WINDOW_SECONDS.
// The marker is cleared after a successful reset and whenever another link signs the user in.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const RECOVERY_COOKIE = 'qz_recovery';
/** The marker is only ever read by `/reset-password` (page render + its server action). */
export const RECOVERY_COOKIE_PATH = '/reset-password';
/** How long after redeeming the link a new password may be set (also the cookie lifetime). */
export const RECOVERY_WINDOW_SECONDS = 15 * 60;

const MARKER_VERSION = 'v1';
const MARKER_PURPOSE = 'recovery';
/** Allowance for clock skew between the Auth server and this server. */
const CLOCK_SKEW_SECONDS = 60;

export interface RecoveryClaims {
  readonly sub: string;
  readonly session_id?: unknown;
  readonly amr?: unknown;
}

export interface RecoveryIdentity {
  readonly sessionId: string;
  readonly sub: string;
}

interface MarkerPayload {
  readonly p: string;
  readonly sid: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${MARKER_VERSION}.${body}`).digest();
}

/** Signed marker value `v1.<payload>.<hmac>` (base64url) for a freshly redeemed recovery link. */
export function signRecoveryMarker(
  identity: RecoveryIdentity,
  now: number,
  secret: string,
): string {
  const payload: MarkerPayload = {
    p: MARKER_PURPOSE,
    sid: identity.sessionId,
    sub: identity.sub,
    iat: now,
    exp: now + RECOVERY_WINDOW_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${MARKER_VERSION}.${body}.${mac(secret, body).toString('base64url')}`;
}

/** The marker's identity when the signature, purpose and expiry check out; otherwise undefined. */
export function verifyRecoveryMarker(
  marker: string | undefined,
  now: number,
  secret: string,
): RecoveryIdentity | undefined {
  if (!marker || !secret) return undefined;
  const parts = marker.split('.');
  if (parts.length !== 3 || parts[0] !== MARKER_VERSION) return undefined;
  const [, body = '', signature = ''] = parts;
  const expected = mac(secret, body);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

  let payload: Partial<MarkerPayload>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<MarkerPayload>;
  } catch {
    return undefined;
  }
  const { p, sid, sub, iat, exp } = payload;
  if (p !== MARKER_PURPOSE || typeof sid !== 'string' || !sid || typeof sub !== 'string' || !sub) {
    return undefined;
  }
  if (typeof iat !== 'number' || typeof exp !== 'number') return undefined;
  if (iat > now + CLOCK_SKEW_SECONDS || now >= exp || exp - iat > RECOVERY_WINDOW_SECONDS) {
    return undefined;
  }
  return { sessionId: sid, sub };
}

export interface RecoveryCheck {
  /** Verified claims of the current session, or null when signed out. */
  readonly claims: RecoveryClaims | null;
  /** Value of the RECOVERY_COOKIE marker, if any. */
  readonly marker: string | undefined;
  /** Current time in Unix seconds. */
  readonly now: number;
  /** Server-only marker signing secret. */
  readonly secret: string;
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

export function isRecoverySession({ claims, marker, now, secret }: RecoveryCheck): boolean {
  if (!claims) return false;
  const identity = verifyRecoveryMarker(marker, now, secret);
  if (!identity) return false;
  if (typeof claims.session_id !== 'string' || claims.session_id !== identity.sessionId) {
    return false;
  }
  if (claims.sub !== identity.sub) return false;
  const otpAt = otpAuthenticatedAt(claims.amr);
  if (otpAt === undefined) return false;
  return otpAt <= now + CLOCK_SKEW_SECONDS && now - otpAt <= RECOVERY_WINDOW_SECONDS;
}

/**
 * `session_id` + `sub` of an access token the Auth server has just issued to this server (the
 * verifyOtp response in `/auth/callback`). Decoding without verification is fine only for that
 * case; every later read goes through getClaims().
 */
export function identityFromAccessToken(
  accessToken: string | undefined,
): RecoveryIdentity | undefined {
  const payload = accessToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      session_id?: unknown;
      sub?: unknown;
    };
    const { session_id: sessionId, sub } = claims;
    return typeof sessionId === 'string' && sessionId && typeof sub === 'string' && sub
      ? { sessionId, sub }
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

/** Cookie carrying a signed marker (`null` clears it with `maxAge: 0`). */
export function recoveryMarkerCookie(signedMarker: string | null, secure: boolean): MarkerCookie {
  return {
    name: RECOVERY_COOKIE,
    value: signedMarker ?? '',
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: RECOVERY_COOKIE_PATH,
      maxAge: signedMarker ? RECOVERY_WINDOW_SECONDS : 0,
    },
  };
}
