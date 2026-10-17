// signInAction with mocked Supabase + next/headers: an unconfirmed account (correct password)
// hands the attempted address to /auth/verify via the pending-email cookie; no other failure
// touches it (that would reveal nothing new, but would overwrite a real pending address).
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
