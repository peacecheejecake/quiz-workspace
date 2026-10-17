// AUTH-04 — 인증 콜백 (`/auth/callback`), docs/screens/auth-callback.md + docs/auth.md §2/§3.
// Mail links carry `token_hash` + `type` (verifyOtp); OAuth/PKCE would carry `code`
// (implementation-plan §7). `next` must be an internal relative path.
import {
  atPath,
  blockForeignHosts,
  canSignIn,
  expect,
  LOGIN_SCREEN,
  PROTECTED_LANDING,
  test,
  verifyTokenHashStatus,
  waitForMailLink,
} from '../fixtures/test.ts';

const CALLBACK_LINK = /\/auth\/callback\?/;
const ERROR_SCREEN = atPath(/^\/auth\/error$/);

function withNext(link: string, next: string): string {
  const url = new URL(link);
  url.searchParams.set('next', next);
  return url.toString();
}

test(
  'AUTH-04-AC01 valid token_hash link creates a session and goes to the allowed next path',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const since = new Date();
    const user = await userFactory.signUp({ label: 'auth04-ac01' });
    const link = await waitForMailLink(user.email, { since, match: CALLBACK_LINK });

    await page.goto(withNext(link, '/settings/security'));
    await expect(page).toHaveURL(atPath(/^\/settings\/security$/));
    // The exchange produced a real session: a reload stays on the protected page.
    await page.reload();
    await expect(page).toHaveURL(atPath(/^\/settings\/security$/));
    expect(await canSignIn(user)).toBe(true);
  },
);

test(
  'AUTH-04-AC02 external or protocol-relative next is ignored for the default path',
  { tag: '@infra' },
  async ({ page, context, userFactory }) => {
    const attempts = await blockForeignHosts(context);
    for (const next of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example']) {
      await context.clearCookies();
      const since = new Date();
      const user = await userFactory.signUp({ label: 'auth04-ac02' });
      const link = await waitForMailLink(user.email, { since, match: CALLBACK_LINK });

      await page.goto(withNext(link, next));
      await expect(page, next).toHaveURL(PROTECTED_LANDING);
      expect(new URL(page.url()).host, next).toBe(new URL(link).host);
    }
    expect(attempts).toEqual([]);
  },
);

test(
  'AUTH-04-AC03 invalid, reused or missing codes go to /auth/error with a retry path',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const since = new Date();
    const user = await userFactory.signUp({ label: 'auth04-ac03' });
    const link = await waitForMailLink(user.email, { since, match: CALLBACK_LINK });
    const tokenHash = new URL(link).searchParams.get('token_hash') ?? '';
    // Redeem the link outside the app first: the app then sees a used (expired) token.
    expect(await verifyTokenHashStatus('email', tokenHash)).toBe(200);

    // Labels only in assertion messages: the used link is a credential-like URL (README).
    const bad: [string, string][] = [
      ['used token_hash', link],
      ['bogus token_hash', '/auth/callback?token_hash=not-a-real-token-hash&type=email'],
      [
        'bogus recovery token_hash',
        '/auth/callback?token_hash=not-a-real-token-hash&type=recovery&next=/reset-password',
      ],
      ['bogus PKCE code', '/auth/callback?code=00000000-0000-4000-8000-000000000000'],
      ['no parameters', '/auth/callback'],
    ];
    for (const [label, target] of bad) {
      await page.goto(target);
      await expect(page, label).toHaveURL(ERROR_SCREEN);
      // Retry guidance: a way back to sign-in (or to request a new mail).
      const retry = page
        .getByRole('main')
        .getByRole('link', { name: /로그인|다시|재전송|새 (링크|메일)|sign in|try again|resend/i })
        .first();
      await expect(retry, label).toBeVisible();
    }
    await page
      .getByRole('main')
      .getByRole('link', { name: /로그인|sign in/i })
      .first()
      .click();
    await expect(page).toHaveURL(LOGIN_SCREEN);
  },
);
