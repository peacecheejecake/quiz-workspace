// Recovery-session gate (lib/auth/recovery.ts) and the `/reset-password` server action with
// mocked Supabase + next/headers: the marker must be server-signed for the current session and
// user; the action re-checks the gate itself, never calls updateUser for a normal session, a
// forged/stale/foreign marker or invalid input, and consumes the marker.
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  identityFromAccessToken,
  isRecoverySession,
  otpAuthenticatedAt,
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_PATH,
  RECOVERY_WINDOW_SECONDS,
  recoveryMarkerCookie,
  signRecoveryMarker,
  verifyRecoveryMarker,
} from '../src/lib/auth/recovery';
import { resolveRecoveryMarkerSecret } from '../src/lib/auth/recovery-secret';

const NOW = 1_800_000_000;
const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const IDENTITY = { sessionId: 'sess-1', sub: 'user-1' };
const recoveryClaims = (overrides: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  session_id: 'sess-1',
  amr: [{ method: 'otp', timestamp: NOW - 60 }],
  ...overrides,
});
const genuine = (issuedAt = NOW - 60, secret = SECRET) =>
  signRecoveryMarker(IDENTITY, issuedAt, secret);
const check = (marker: string | undefined, claims = recoveryClaims(), now = NOW) =>
  isRecoverySession({ claims, marker, now, secret: SECRET });

/** A marker body re-signed with `secret` (to model forgery with a guessed or wrong key). */
function forge(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(`v1.${body}`).digest('base64url');
  return `v1.${body}.${mac}`;
}

describe('isRecoverySession', () => {
  it('accepts a fresh OTP session with a genuine marker for that session and user', () => {
    expect(check(genuine())).toBe(true);
  });

  it('rejects a client-made marker holding its own session id (the P2 forgery)', () => {
    // A sign-up confirmation / magic-link session also has amr=otp; it only knows its own sid.
    expect(check('sess-1')).toBe(false);
    expect(
      check(
        forge({ p: 'recovery', sid: 'sess-1', sub: 'user-1', iat: NOW, exp: NOW + 60 }, 'guess'),
      ),
    ).toBe(false);
  });

  it('rejects tampered markers', () => {
    const [v, body, mac] = genuine().split('.') as [string, string, string];
    const otherBody = Buffer.from(
      JSON.stringify({ p: 'recovery', sid: 'sess-2', sub: 'user-1', iat: NOW, exp: NOW + 60 }),
    ).toString('base64url');
    expect(check(`${v}.${otherBody}.${mac}`)).toBe(false);
    expect(check(`${v}.${body}.${mac.slice(0, -2)}AA`)).toBe(false);
    expect(check(`v2.${body}.${mac}`)).toBe(false);
    expect(check(`${body}.${mac}`)).toBe(false);
    expect(check(genuine(NOW - 60, 'another-secret-0123456789abcdefghijklmnop'))).toBe(false);
  });

  it('rejects a marker for another purpose, session or user', () => {
    expect(
      check(forge({ p: 'signup', sid: 'sess-1', sub: 'user-1', iat: NOW, exp: NOW + 60 }, SECRET)),
    ).toBe(false);
    expect(check(genuine(), recoveryClaims({ session_id: 'sess-2' }))).toBe(false);
    expect(check(genuine(), recoveryClaims({ sub: 'user-2' }))).toBe(false);
    expect(check(genuine(), recoveryClaims({ session_id: undefined }))).toBe(false);
  });

  it('rejects expired markers and markers with an overlong lifetime', () => {
    expect(check(genuine(NOW - RECOVERY_WINDOW_SECONDS))).toBe(false);
    expect(check(genuine(NOW - RECOVERY_WINDOW_SECONDS + 1))).toBe(true);
    const long = forge(
      { p: 'recovery', sid: 'sess-1', sub: 'user-1', iat: NOW - 10, exp: NOW + 86_400 },
      SECRET,
    );
    expect(check(long)).toBe(false);
  });

  it('rejects a normal password session even with a genuine marker', () => {
    const claims = recoveryClaims({ amr: [{ method: 'password', timestamp: NOW - 5 }] });
    expect(check(genuine(), claims)).toBe(false);
  });

  it('rejects an old OTP session, missing markers and signed-out requests', () => {
    const old = recoveryClaims({
      amr: [{ method: 'otp', timestamp: NOW - RECOVERY_WINDOW_SECONDS - 1 }],
    });
    expect(check(genuine(), old)).toBe(false);
    expect(check(undefined)).toBe(false);
    expect(isRecoverySession({ claims: null, marker: genuine(), now: NOW, secret: SECRET })).toBe(
      false,
    );
    expect(
      isRecoverySession({ claims: recoveryClaims(), marker: genuine(), now: NOW, secret: '' }),
    ).toBe(false);
  });

  it('round-trips the identity through sign/verify', () => {
    expect(verifyRecoveryMarker(genuine(), NOW, SECRET)).toEqual(IDENTITY);
  });

  it('reads the latest otp time and ignores malformed amr entries', () => {
    expect(otpAuthenticatedAt('otp')).toBeUndefined();
    expect(
      otpAuthenticatedAt([
        null,
        { method: 'otp', timestamp: 'x' },
        { method: 'otp', timestamp: 5 },
        { method: 'password', timestamp: 9 },
        { method: 'otp', timestamp: 7 },
      ]),
    ).toBe(7);
  });
});

describe('recovery marker cookie and secret', () => {
  it('is HttpOnly, path-scoped and lives as long as the recovery window', () => {
    expect(recoveryMarkerCookie('signed', true)).toEqual({
      name: RECOVERY_COOKIE,
      value: 'signed',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: RECOVERY_COOKIE_PATH,
        maxAge: RECOVERY_WINDOW_SECONDS,
      },
    });
    expect(recoveryMarkerCookie(null, false).options.maxAge).toBe(0);
  });

  it('takes session id and user id from a freshly issued access token', () => {
    const payload = Buffer.from(JSON.stringify({ session_id: 'sess-9', sub: 'u-9' })).toString(
      'base64url',
    );
    expect(identityFromAccessToken(`h.${payload}.s`)).toEqual({ sessionId: 'sess-9', sub: 'u-9' });
    expect(identityFromAccessToken('h.bm90anNvbg.s')).toBeUndefined();
    expect(identityFromAccessToken(undefined)).toBeUndefined();
  });

  it('requires a configured secret outside local/test and rejects short ones', () => {
    expect(() => resolveRecoveryMarkerSecret({ APP_ENV: 'production' })).toThrow(
      /AUTH_RECOVERY_MARKER_SECRET is required/,
    );
    expect(() => resolveRecoveryMarkerSecret({ APP_ENV: 'preview' })).toThrow();
    expect(() =>
      resolveRecoveryMarkerSecret({ AUTH_RECOVERY_MARKER_SECRET: 'short', APP_ENV: 'local' }),
    ).toThrow(/at least 32/);
    expect(
      resolveRecoveryMarkerSecret({ AUTH_RECOVERY_MARKER_SECRET: SECRET, APP_ENV: 'production' }),
    ).toBe(SECRET);
  });

  it('falls back to one stable random secret locally', () => {
    const a = resolveRecoveryMarkerSecret({});
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(resolveRecoveryMarkerSecret({ APP_ENV: 'test' })).toBe(a);
  });
});

// --- updatePasswordAction --------------------------------------------------------------------

const auth = { getClaims: vi.fn(), updateUser: vi.fn(), signOut: vi.fn() };
const cookieJar = new Map<string, string>();
const deleted: unknown[] = [];

vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth }) }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
    set: () => undefined,
    delete: (arg: unknown) => {
      deleted.push(arg);
    },
  }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://127.0.0.1:8000';
process.env.AUTH_RECOVERY_MARKER_SECRET = SECRET;

const { updatePasswordAction } = await import('../src/lib/auth/reset-actions');

function form(password: string, confirm = password): FormData {
  const data = new FormData();
  data.set('password', password);
  data.set('confirm', confirm);
  return data;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('updatePasswordAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieJar.clear();
    deleted.length = 0;
    auth.updateUser.mockResolvedValue({ error: null });
    auth.signOut.mockResolvedValue({ error: null });
  });

  function otpSession(amrMethod = 'otp') {
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: 'user-1',
          session_id: 'sess-1',
          amr: [{ method: amrMethod, timestamp: nowSeconds() - 30 }],
        },
      },
      error: null,
    });
  }

  function asRecoverySession() {
    cookieJar.set(RECOVERY_COOKIE, signRecoveryMarker(IDENTITY, nowSeconds() - 30, SECRET));
    otpSession();
  }

  it('changes the password for a recovery session, consumes the marker, ends other sessions', async () => {
    asRecoverySession();
    const result = await updatePasswordAction({ status: 'idle' }, form('new-password-1'));

    expect(result).toEqual({ status: 'done' });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new-password-1' });
    expect(deleted).toEqual([{ name: RECOVERY_COOKIE, path: RECOVERY_COOKIE_PATH }]);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(JSON.stringify(result)).not.toContain('new-password-1');
  });

  it('refuses an OTP session carrying a self-made marker without calling updateUser', async () => {
    cookieJar.set(RECOVERY_COOKIE, 'sess-1');
    otpSession();
    expect(await updatePasswordAction({ status: 'idle' }, form('new-password-1'))).toEqual({
      status: 'expired',
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('refuses a normal (password) session even with a genuine marker', async () => {
    cookieJar.set(RECOVERY_COOKIE, signRecoveryMarker(IDENTITY, nowSeconds(), SECRET));
    otpSession('password');
    expect((await updatePasswordAction({ status: 'idle' }, form('new-password-1'))).status).toBe(
      'expired',
    );
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('refuses without a marker or when signed out', async () => {
    auth.getClaims.mockResolvedValue({ data: null, error: new Error('no session') });
    expect((await updatePasswordAction({ status: 'idle' }, form('new-password-1'))).status).toBe(
      'expired',
    );
    cookieJar.set(RECOVERY_COOKIE, signRecoveryMarker(IDENTITY, nowSeconds(), SECRET));
    expect((await updatePasswordAction({ status: 'idle' }, form('new-password-1'))).status).toBe(
      'expired',
    );
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('re-validates the policy and confirmation on the server', async () => {
    asRecoverySession();
    expect(await updatePasswordAction({ status: 'idle' }, form('short'))).toMatchObject({
      status: 'error',
      fieldErrors: { password: expect.stringMatching(/10자/) as unknown },
    });
    expect(
      await updatePasswordAction({ status: 'idle' }, form('new-password-1', 'new-password-2')),
    ).toMatchObject({ status: 'error', fieldErrors: { confirm: expect.any(String) as unknown } });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('maps Auth failures without leaking codes and keeps the marker', async () => {
    asRecoverySession();
    auth.updateUser.mockResolvedValue({ error: { code: 'same_password', status: 422 } });
    const same = await updatePasswordAction({ status: 'idle' }, form('new-password-1'));
    expect(same.status).toBe('error');
    expect(same.fieldErrors?.password).toMatch(/이전 비밀번호와 달라야/);

    auth.updateUser.mockResolvedValue({ error: { code: 'session_not_found', status: 403 } });
    expect((await updatePasswordAction({ status: 'idle' }, form('new-password-1'))).status).toBe(
      'expired',
    );

    auth.updateUser.mockRejectedValue(new Error('network down'));
    const down = await updatePasswordAction({ status: 'idle' }, form('new-password-1'));
    expect(down.error).toMatch(/잠시 후 다시 시도/);
    expect(deleted).toEqual([]);
  });
});
