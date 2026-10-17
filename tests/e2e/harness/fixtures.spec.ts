// Harness self-tests for tests/e2e/fixtures. Tests tagged @infra need `make infra-up` (local
// Supabase Auth + Mailpit) and fail, not skip, without it; `pnpm e2e --grep-invert @infra` runs
// the rest.
import { assertLocalUrl, localEndpoints, supabaseKeys } from '../fixtures/local-env.ts';
import { expect, signIn, test, userExists, waitForMailLink } from '../fixtures/test.ts';

test('HARNESS-06 fixtures refuse non-local URLs', () => {
  expect(assertLocalUrl('http://127.0.0.1:54321/', 'X')).toBe('http://127.0.0.1:54321');
  expect(assertLocalUrl('http://localhost:3000', 'X')).toBe('http://localhost:3000');
  for (const url of [
    'https://abc.supabase.co',
    'http://127.0.0.1.evil.example',
    'http://10.0.0.5:54321',
    'file:///etc/passwd',
    'not a url',
  ]) {
    expect(() => assertLocalUrl(url, 'X'), url).toThrow(/X/);
  }
});

test(
  'HARNESS-07 userFactory creates a confirmed user who can sign in and deletes it',
  { tag: '@infra' },
  async ({ userFactory }) => {
    const user = await userFactory.create({ label: 'harness-07' });
    expect(user.email).toMatch(/^e2e-harness-07-[0-9a-f-]{36}@example\.test$/);

    const session = await signIn(user);
    expect(session.userId).toBe(user.id);
    expect(session.expiresAt * 1000).toBeGreaterThan(Date.now());

    const other = await userFactory.create({ label: 'harness-07' });
    expect(other.id).not.toBe(user.id);
    expect(other.email).not.toBe(user.email);

    await userFactory.cleanup();
    expect(await userExists(user.id)).toBe(false);
    expect(await userExists(other.id)).toBe(false);
    expect(userFactory.created).toEqual([]);
  },
);

test('HARNESS-08 unconfirmed users cannot sign in', { tag: '@infra' }, async ({ userFactory }) => {
  const user = await userFactory.create({ label: 'harness-08', confirmed: false });
  await expect(signIn(user)).rejects.toThrow(/sign in failed: HTTP 400/);
});

test(
  'HARNESS-09 Mailpit helper returns the single link of the latest mail',
  { tag: '@infra' },
  async ({ userFactory }) => {
    const user = await userFactory.create({ label: 'harness-09' });
    const since = new Date();
    // Password recovery mail (AUTH-05 flow) sent through the public Auth API.
    const { supabaseUrl, baseUrl } = localEndpoints();
    const res = await fetch(`${supabaseUrl}/auth/v1/recover`, {
      method: 'POST',
      headers: { apikey: supabaseKeys().publishable, 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email }),
    });
    expect(res.status).toBe(200);

    const link = await waitForMailLink(user.email, { since });
    // Never print the link itself: it is a single-use credential.
    expect(new URL(link).origin).toBe(new URL(baseUrl).origin);
    expect(new URL(link).pathname).toBe('/auth/callback');
  },
);
