// ACCOUNT-01 password change: changePasswordAction / reauthenticateAction with mocked Supabase +
// Next, and the Auth error mapping. Any verified session may change its password (no recovery
// gate); the password never comes back in the state.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyAccountPasswordError } from '../src/lib/auth/account-errors';

const auth = { getClaims: vi.fn(), updateUser: vi.fn(), signOut: vi.fn() };
const cookieJar = new Map<string, string>();
const deleted: unknown[] = [];

vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
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

const { changePasswordAction, reauthenticateAction } =
  await import('../src/lib/auth/account-actions');

const LOGIN_REDIRECT = 'REDIRECT /login?next=%2Fsettings%2Fsecurity';
const NEW_PASSWORD = 'new-password-1';

function form(password: string, confirm = password): FormData {
  const data = new FormData();
  data.set('password', password);
  data.set('confirm', confirm);
  return data;
}

function signedIn() {
  auth.getClaims.mockResolvedValue({
    data: { claims: { sub: 'user-1', email: 'a@example.com', session_id: 'sess-1' } },
    error: null,
  });
}

const idle = { status: 'idle' } as const;

describe('classifyAccountPasswordError', () => {
  it('separates reauthentication from a dead session', () => {
    expect(classifyAccountPasswordError({ code: 'reauthentication_needed', status: 400 })).toBe(
      'reauthenticate',
    );
    expect(classifyAccountPasswordError({ code: 'reauthentication_not_valid', status: 400 })).toBe(
      'reauthenticate',
    );
    expect(classifyAccountPasswordError({ code: 'session_not_found', status: 403 })).toBe(
      'signedOut',
    );
    expect(classifyAccountPasswordError({ name: 'AuthSessionMissingError' })).toBe('signedOut');
  });

  it('keeps the AUTH-06 policy, rate limit and outage kinds', () => {
    expect(classifyAccountPasswordError({ code: 'weak_password', status: 422 })).toBe(
      'weakPassword',
    );
    expect(classifyAccountPasswordError({ code: 'same_password', status: 422 })).toBe(
      'samePassword',
    );
    expect(classifyAccountPasswordError({ code: 'over_request_rate_limit', status: 429 })).toBe(
      'rateLimited',
    );
    expect(classifyAccountPasswordError({ name: 'AuthRetryableFetchError' })).toBe('unavailable');
    expect(classifyAccountPasswordError({ code: 'something_new', status: 400 })).toBe(
      'unavailable',
    );
  });
});

describe('changePasswordAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieJar.clear();
    deleted.length = 0;
    auth.updateUser.mockResolvedValue({ error: null });
    auth.signOut.mockResolvedValue({ error: null });
  });

  it('changes the password of a normal signed-in session and ends the other sessions', async () => {
    signedIn();
    const result = await changePasswordAction(idle, form(NEW_PASSWORD));

    expect(result).toEqual({ status: 'done' });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: NEW_PASSWORD });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(JSON.stringify(result)).not.toContain(NEW_PASSWORD);
  });

  it('still reports success when ending the other sessions fails', async () => {
    signedIn();
    auth.signOut.mockRejectedValue(new Error('network down'));
    expect(await changePasswordAction(idle, form(NEW_PASSWORD))).toEqual({ status: 'done' });
  });

  it('re-validates the policy and confirmation on the server', async () => {
    signedIn();
    expect(await changePasswordAction(idle, form('short'))).toMatchObject({
      status: 'error',
      fieldErrors: { password: expect.stringMatching(/10자/) as unknown },
    });
    expect(await changePasswordAction(idle, form(NEW_PASSWORD, 'new-password-2'))).toMatchObject({
      status: 'error',
      fieldErrors: { confirm: expect.any(String) as unknown },
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('sends a signed-out request to /login?next=/settings/security without calling updateUser', async () => {
    auth.getClaims.mockResolvedValue({ data: null, error: new Error('no session') });
    await expect(changePasswordAction(idle, form(NEW_PASSWORD))).rejects.toThrow(LOGIN_REDIRECT);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('asks for a fresh sign-in when Auth requires reauthentication', async () => {
    signedIn();
    auth.updateUser.mockResolvedValue({ error: { code: 'reauthentication_needed', status: 400 } });
    const result = await changePasswordAction(idle, form(NEW_PASSWORD));
    expect(result.status).toBe('reauthenticate');
    expect(result.error).toMatch(/다시 로그인/);
    expect(result.error).not.toMatch(/reauthentication_needed/);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('drops a session Auth no longer knows and redirects to /login', async () => {
    signedIn();
    auth.updateUser.mockResolvedValue({ error: { code: 'session_not_found', status: 403 } });
    await expect(changePasswordAction(idle, form(NEW_PASSWORD))).rejects.toThrow(LOGIN_REDIRECT);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('maps policy, rate limit and outage failures without leaking codes', async () => {
    signedIn();
    auth.updateUser.mockResolvedValue({ error: { code: 'same_password', status: 422 } });
    const same = await changePasswordAction(idle, form(NEW_PASSWORD));
    expect(same).toMatchObject({ status: 'error' });
    expect(same.fieldErrors?.password).toMatch(/이전 비밀번호와 달라야/);

    auth.updateUser.mockResolvedValue({ error: { code: 'over_request_rate_limit', status: 429 } });
    expect((await changePasswordAction(idle, form(NEW_PASSWORD))).error).toMatch(/요청이 너무/);

    auth.updateUser.mockRejectedValue(new Error('network down'));
    const down = await changePasswordAction(idle, form(NEW_PASSWORD));
    expect(down.error).toMatch(/잠시 후 다시 시도/);
    expect(JSON.stringify(down)).not.toContain(NEW_PASSWORD);
  });
});

describe('reauthenticateAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieJar.clear();
    deleted.length = 0;
  });

  it('signs this browser out and returns to the screen through /login', async () => {
    auth.signOut.mockResolvedValue({ error: null });
    await expect(reauthenticateAction()).rejects.toThrow(LOGIN_REDIRECT);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(deleted).toEqual([]);
  });

  it('clears the session cookies locally when Auth cannot be reached', async () => {
    cookieJar.set('sb-127-auth-token', 'x');
    cookieJar.set('other', 'y');
    auth.signOut.mockRejectedValue(new Error('network down'));
    await expect(reauthenticateAction()).rejects.toThrow(LOGIN_REDIRECT);
    expect(deleted).toEqual(['sb-127-auth-token']);
  });
});
