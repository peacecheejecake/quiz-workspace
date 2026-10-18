import { describe, expect, it } from 'vitest';
import { classifySignInError, SIGN_IN_MESSAGES } from '../src/lib/auth/sign-in-errors';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://127.0.0.1:8000';

const { bearerHeaders, NotAuthenticatedError, verifiedAccessToken } =
  await import('../src/lib/api/server');

describe('classifySignInError', () => {
  it('uses one generic message for wrong password and unknown accounts', () => {
    expect(classifySignInError({ code: 'invalid_credentials', status: 400 })).toBe('credentials');
    expect(classifySignInError({ code: 'user_not_found', status: 400 })).toBe('credentials');
    expect(classifySignInError({ status: 422 })).toBe('credentials');
  });

  it('separates outages and rate limits from credential errors', () => {
    expect(classifySignInError({ status: 500 })).toBe('unavailable');
    expect(classifySignInError({ name: 'AuthRetryableFetchError' })).toBe('unavailable');
    expect(classifySignInError({ status: 429 })).toBe('rateLimited');
    expect(classifySignInError({ code: 'email_not_confirmed', status: 400 })).toBe(
      'emailNotConfirmed',
    );
  });

  it('never mentions whether an account exists', () => {
    expect(SIGN_IN_MESSAGES.credentials).not.toMatch(/존재|가입되지|없는 계정|not found/);
  });
});

describe('API Bearer wiring', () => {
  it('builds the Authorization header and refuses empty tokens', () => {
    expect(bearerHeaders('a.b.c')).toEqual({ Authorization: 'Bearer a.b.c' });
    expect(() => bearerHeaders('')).toThrow(NotAuthenticatedError);
    expect(() => bearerHeaders('a b')).toThrow(NotAuthenticatedError);
  });

  it('returns the session token only after getClaims() verified it', async () => {
    const client = (claims: unknown, token: string | null) =>
      ({
        auth: {
          getClaims: async () => ({ data: claims ? { claims } : null, error: null }),
          getSession: async () => ({
            data: { session: token ? { access_token: token } : null },
          }),
        },
      }) as unknown as Parameters<typeof verifiedAccessToken>[0];

    expect(await verifiedAccessToken(client({ sub: 'u1' }, 'tok'))).toBe('tok');
    expect(await verifiedAccessToken(client(null, 'tok'))).toBeNull();
    expect(await verifiedAccessToken(client({ sub: 'u1' }, null))).toBeNull();
  });

  it('treats a throwing session read (malformed cookie) as signed out', async () => {
    const throwing = {
      auth: {
        getClaims: () => Promise.reject(new SyntaxError('Unexpected token')),
        getSession: () => Promise.reject(new SyntaxError('Unexpected token')),
      },
    } as unknown as Parameters<typeof verifiedAccessToken>[0];
    expect(await verifiedAccessToken(throwing)).toBeNull();
    const { readVerifiedClaims } = await import('../src/lib/supabase/session-guard');
    expect(await readVerifiedClaims(throwing)).toEqual({ claims: null, corrupt: true });
  });
});

describe('relativeRedirect', () => {
  it('emits a relative Location for internal paths only', async () => {
    const { relativeRedirect } = await import('../src/lib/http/redirect');
    const res = relativeRedirect('/auth/error?reason=missing', 303);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/error?reason=missing');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'x']) {
      expect(() => relativeRedirect(bad)).toThrow();
    }
  });
});
