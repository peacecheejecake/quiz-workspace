// signInAction with mocked Supabase + next/headers: an unconfirmed account (correct password)
// hands the attempted address to /auth/verify via the pending-email cookie; no other failure
// touches it (that would reveal nothing new, but would overwrite a real pending address).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_EMAIL_COOKIE, PENDING_EMAIL_PATH } from '../src/lib/auth/pending-email';

const auth = { signInWithPassword: vi.fn() };
const cookieSets: { name: string; value: string; options: Record<string, unknown> }[] = [];
let origin = 'http://127.0.0.1:3000';

vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin }),
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieSets.push({ name, value, options });
    },
    delete: () => undefined,
  }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://127.0.0.1:8000';

const { signInAction } = await import('../src/lib/auth/actions');

function form(email: string, password = 'some-password'): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  return data;
}

describe('signInAction pending verification address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieSets.length = 0;
    origin = 'http://127.0.0.1:3000';
  });

  it('sets the pending-email cookie to the attempted address when it is unconfirmed', async () => {
    auth.signInWithPassword.mockResolvedValue({
      error: { code: 'email_not_confirmed', status: 400 },
    });
    const state = await signInAction({}, form('  b@example.com '));

    expect(state.emailNotConfirmed).toBe(true);
    expect(cookieSets).toEqual([
      {
        name: PENDING_EMAIL_COOKIE,
        value: 'b@example.com',
        options: {
          path: PENDING_EMAIL_PATH,
          maxAge: 3600,
          sameSite: 'lax',
          secure: false,
          httpOnly: false,
        },
      },
    ]);
  });

  it('marks the cookie Secure on https', async () => {
    origin = 'https://quiz.example';
    auth.signInWithPassword.mockResolvedValue({
      error: { code: 'email_not_confirmed', status: 400 },
    });
    await signInAction({}, form('b@example.com'));
    expect(cookieSets[0]?.options.secure).toBe(true);
  });

  it('leaves the cookie alone for wrong credentials and outages', async () => {
    auth.signInWithPassword.mockResolvedValue({
      error: { code: 'invalid_credentials', status: 400 },
    });
    expect((await signInAction({}, form('b@example.com'))).emailNotConfirmed).toBeUndefined();
    auth.signInWithPassword.mockResolvedValue({ error: { status: 500 } });
    await signInAction({}, form('b@example.com'));
    expect(cookieSets).toEqual([]);
  });
});

describe('signInAction CAPTCHA token (docs/auth.md §5.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieSets.length = 0;
    origin = 'http://127.0.0.1:3000';
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  });

  function withToken(token: string): FormData {
    const data = form('b@example.com');
    data.set('captchaToken', token);
    return data;
  }

  it('passes the token to Supabase as options.captchaToken', async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    auth.signInWithPassword.mockResolvedValue({ error: { code: 'invalid_credentials' } });
    await signInAction({}, withToken('XXXX.DUMMY.TOKEN.XXXX'));
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'b@example.com',
      password: 'some-password',
      options: { captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' },
    });
  });

  it('never calls Auth without a token while CAPTCHA is on', async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    const state = await signInAction({}, withToken('  '));
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(state).toEqual({
      error: '보안 확인을 완료하면 로그인할 수 있습니다.',
      email: 'b@example.com',
    });
  });

  it('sends no captcha option when CAPTCHA is off', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { code: 'invalid_credentials' } });
    await signInAction({}, form('b@example.com'));
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'b@example.com',
      password: 'some-password',
    });
  });

  it('explains a refused token without Auth details', async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    auth.signInWithPassword.mockResolvedValue({
      error: { code: 'captcha_failed', status: 400, message: 'captcha protection: x' },
    });
    const state = await signInAction({}, withToken('spent-token'));
    expect(state.error).toBe('보안 확인에 실패했습니다. 보안 확인을 마친 뒤 다시 시도해 주세요.');
    expect(cookieSets).toEqual([]);
  });
});
