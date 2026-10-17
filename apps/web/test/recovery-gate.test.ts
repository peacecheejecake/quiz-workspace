// Recovery-session gate (lib/auth/recovery.ts) and the `/reset-password` server action with
// mocked Supabase + next/headers: the action re-checks the gate itself, never calls updateUser
// for a normal session, a stale/foreign marker or invalid input, and consumes the marker.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRecoverySession,
  otpAuthenticatedAt,
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_PATH,
  RECOVERY_WINDOW_SECONDS,
  recoveryMarkerCookie,
  sessionIdFromAccessToken,
} from '../src/lib/auth/recovery';

const NOW = 1_800_000_000;
const recoveryClaims = (overrides: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  session_id: 'sess-1',
  amr: [{ method: 'otp', timestamp: NOW - 60 }],
  ...overrides,
});

describe('isRecoverySession', () => {
  it('accepts a fresh OTP session named by the marker', () => {
    expect(isRecoverySession({ claims: recoveryClaims(), marker: 'sess-1', now: NOW })).toBe(true);
  });

  it('rejects a normal password session even with a matching marker', () => {
    const claims = recoveryClaims({ amr: [{ method: 'password', timestamp: NOW - 5 }] });
    expect(isRecoverySession({ claims, marker: 'sess-1', now: NOW })).toBe(false);
  });

  it('rejects an OTP session without the marker (e.g. a sign-up confirmation link)', () => {
    expect(isRecoverySession({ claims: recoveryClaims(), marker: undefined, now: NOW })).toBe(
      false,
    );
  });

  it('rejects a marker that names another session', () => {
    expect(isRecoverySession({ claims: recoveryClaims(), marker: 'sess-2', now: NOW })).toBe(false);
    const noSid = recoveryClaims({ session_id: undefined });
    expect(isRecoverySession({ claims: noSid, marker: 'sess-1', now: NOW })).toBe(false);
  });

  it('expires after the recovery window and ignores future timestamps', () => {
    const old = recoveryClaims({
      amr: [{ method: 'otp', timestamp: NOW - RECOVERY_WINDOW_SECONDS - 1 }],
    });
    expect(isRecoverySession({ claims: old, marker: 'sess-1', now: NOW })).toBe(false);
    const future = recoveryClaims({ amr: [{ method: 'otp', timestamp: NOW + 3600 }] });
    expect(isRecoverySession({ claims: future, marker: 'sess-1', now: NOW })).toBe(false);
  });

  it('rejects signed-out requests', () => {
    expect(isRecoverySession({ claims: null, marker: 'sess-1', now: NOW })).toBe(false);
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

describe('recovery marker cookie', () => {
  it('is HttpOnly, path-scoped and lives as long as the recovery window', () => {
    const cookie = recoveryMarkerCookie('sess-1', true);
    expect(cookie).toEqual({
      name: RECOVERY_COOKIE,
      value: 'sess-1',
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

  it('takes the session id from a freshly issued access token', () => {
    const payload = Buffer.from(JSON.stringify({ session_id: 'sess-9' })).toString('base64url');
    expect(sessionIdFromAccessToken(`h.${payload}.s`)).toBe('sess-9');
    expect(sessionIdFromAccessToken('h.bm90anNvbg.s')).toBeUndefined();
    expect(sessionIdFromAccessToken(undefined)).toBeUndefined();
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

  function asRecoverySession() {
    cookieJar.set(RECOVERY_COOKIE, 'sess-1');
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: 'user-1',
          session_id: 'sess-1',
          amr: [{ method: 'otp', timestamp: nowSeconds() - 30 }],
        },
      },
      error: null,
    });
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

  it('refuses a normal (password) session without calling updateUser', async () => {
    cookieJar.set(RECOVERY_COOKIE, 'sess-1');
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: 'user-1',
          session_id: 'sess-1',
          amr: [{ method: 'password', timestamp: nowSeconds() }],
        },
      },
      error: null,
    });
    expect(await updatePasswordAction({ status: 'idle' }, form('new-password-1'))).toEqual({
      status: 'expired',
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('refuses without a marker or when signed out', async () => {
    auth.getClaims.mockResolvedValue({ data: null, error: new Error('no session') });
    expect((await updatePasswordAction({ status: 'idle' }, form('new-password-1'))).status).toBe(
      'expired',
    );
    cookieJar.set(RECOVERY_COOKIE, 'sess-1');
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
