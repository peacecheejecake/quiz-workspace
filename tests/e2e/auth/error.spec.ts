// AUTH-07 — 인증 오류 안내 (`/auth/error`), docs/screens/auth-error.md + docs/auth.md §2/§7
// (`next=https://evil.example` must be rejected).
import {
  atPath,
  blockForeignHosts,
  expect,
  LOGIN_SCREEN,
  test,
  waitForMailLink,
} from '../fixtures/test.ts';

const ERROR_SCREEN = atPath(/^\/auth\/error$/);
const EXPIRED_NOTICE = /만료|유효하지 않|잘못된 링크|expired|invalid|no longer valid/i;

test(
  'AUTH-07-AC01 expired confirmation link offers resend or a way back to sign-in',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const since = new Date();
    const user = await userFactory.signUp({ label: 'auth07-ac01' });
    const link = new URL(await waitForMailLink(user.email, { since, match: /\/auth\/callback\?/ }));
    // A confirmation link whose token no longer verifies (GoTrue reports it as otp_expired).
    link.searchParams.set('token_hash', `${link.searchParams.get('token_hash') ?? ''}0`);

    await page.goto(link.toString());
    await expect(page).toHaveURL(ERROR_SCREEN);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading').first()).toBeVisible();
    await expect(main.getByText(EXPIRED_NOTICE).first()).toBeVisible();
    // Nothing from the link (token, raw Auth error codes) is echoed on screen.
    await expect(main).not.toContainText(link.searchParams.get('token_hash') ?? '');
    await expect(main).not.toContainText(/otp_expired|access_denied|AuthApiError/);

    const actions = main.getByRole('link').or(main.getByRole('button'));
    await expect(
      actions.filter({ hasText: /재전송|다시 보내|로그인|resend|sign in/i }).first(),
    ).toBeVisible();
    await main
      .getByRole('link', { name: /로그인|sign in/i })
      .first()
      .click();
    await expect(page).toHaveURL(LOGIN_SCREEN);
  },
);

test('AUTH-07-AC02 external next/returnUrl is never used by the error screen', async ({
  page,
  context,
  baseURL,
}) => {
  const attempts = await blockForeignHosts(context);
  const origin = new URL(baseURL ?? '').origin;
  for (const query of [
    'next=https://evil.example/steal',
    'next=//evil.example/steal',
    'returnUrl=https://evil.example/steal',
  ]) {
    await page.goto(`/auth/error?error=expired&${query}`);
    await expect(page, query).toHaveURL(ERROR_SCREEN);
    const main = page.getByRole('main');
    const login = main.getByRole('link', { name: /로그인|sign in/i }).first();
    await expect(login, query).toBeVisible();

    // Every link on the screen stays inside the app.
    for (const href of await main
      .getByRole('link')
      .evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href))) {
      expect(new URL(href).origin, `${query}: ${href}`).toBe(origin);
    }
    await login.click();
    await expect(page, query).toHaveURL(LOGIN_SCREEN);
    expect(new URL(page.url()).origin).toBe(origin);
    const next = new URL(page.url()).searchParams.get('next');
    if (next !== null) expect(next, query).toMatch(/^\/(?![/\\])/);
  }
  expect(attempts).toEqual([]);
});
