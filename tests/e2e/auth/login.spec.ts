// AUTH-01 — 로그인 (`/login`), docs/screens/auth-login.md + docs/auth.md §2/§7.
// Unauthenticated project: every test starts without cookies; users come from userFactory.
import {
  appPath,
  authUi,
  blockForeignHosts,
  expect,
  formAlert,
  LOGIN_SCREEN,
  PROTECTED_LANDING,
  submitLogin,
  test,
} from '../fixtures/test.ts';

const GENERIC_LOGIN_ERROR =
  /(이메일|비밀번호).*(올바르지|일치하지|확인)|invalid (email|login|credentials)|incorrect/i;
const ACCOUNT_EXISTENCE =
  /존재하지 않|가입되지 않|없는 (계정|사용자|이메일)|not found|no account|not registered|does not exist|unknown user/i;

test('AUTH-01-AC01 protected URL redirects to /login and keeps a safe relative next', async ({
  page,
  baseURL,
}) => {
  for (const target of [
    '/workspaces',
    '/workspaces/e2e-ws/documents?tab=all',
    '/settings/security',
  ]) {
    await page.goto(target);
    await expect(page, target).toHaveURL(LOGIN_SCREEN);
    const url = new URL(page.url());
    expect(url.origin, target).toBe(new URL(baseURL ?? '').origin);
    expect(url.searchParams.get('next'), target).toBe(target);
    await expect(authUi.email(page), target).toBeVisible();
    await expect(authUi.password(page), target).toBeVisible();
  }
});

test('AUTH-01-AC01 a malformed session cookie reads as signed out and is cleared', async ({
  page,
  context,
  baseURL,
}) => {
  // A structurally valid SSR session whose access token is not a JWT (`notjson` header): the
  // pinned SDK throws while verifying it. Synthetic value, no real credential.
  const session = {
    access_token: 'bm90anNvbg.e30.YQ',
    refresh_token: 'not-a-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: '00000000-0000-4000-8000-000000000000' },
  };
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const sessionCookies = async () =>
    (await context.cookies()).filter((c) => /^sb-.+-auth-token(?:\.\d+)?$/.test(c.name));

  await context.addCookies([{ name: 'sb-127-auth-token', value, url: baseURL ?? '' }]);
  const res = await page.goto('/login');
  expect(res?.status()).toBe(200);
  await expect(authUi.email(page)).toBeVisible();
  expect(await sessionCookies()).toEqual([]);

  await context.addCookies([{ name: 'sb-127-auth-token', value, url: baseURL ?? '' }]);
  await page.goto('/workspaces');
  await expect(page).toHaveURL(LOGIN_SCREEN);
  expect(new URL(page.url()).searchParams.get('next')).toBe('/workspaces');
  expect(await sessionCookies()).toEqual([]);
});

test(
  'AUTH-01-AC01 external or protocol-relative next is dropped after sign-in',
  { tag: '@infra' },
  async ({ page, context, userFactory }) => {
    const attempts = await blockForeignHosts(context);
    for (const next of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example']) {
      const user = await userFactory.create({ label: 'auth01-ac01' });
      await context.clearCookies();
      await submitLogin(page, user, next);
      await expect(page, next).toHaveURL(PROTECTED_LANDING);
    }
    expect(attempts).toEqual([]);
  },
);

test(
  'AUTH-01-AC02 confirmed user signs in and returns to the requested internal path',
  { tag: '@infra' },
  async ({ page, baseURL, userFactory }) => {
    const user = await userFactory.create({ label: 'auth01-ac02' });
    await page.goto('/workspaces?tab=archived');
    await expect(page).toHaveURL(LOGIN_SCREEN);
    await authUi.email(page).fill(user.email);
    await authUi.password(page).fill(user.password);
    await authUi.signInButton(page).click();

    await expect(page).toHaveURL(
      (url) => url.pathname === '/workspaces' && url.search === '?tab=archived',
    );
    expect(appPath(page, baseURL)).toBe('/workspaces?tab=archived');
    // The session is real: a reload stays on the protected page.
    await page.reload();
    await expect(page).toHaveURL(
      (url) => url.pathname === '/workspaces' && url.search === '?tab=archived',
    );
    await expect(authUi.email(page)).toHaveCount(0);
  },
);

test(
  'AUTH-01-AC02 signed-in user opening /login is sent to the workspace list',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'auth01-ac02' });
    await submitLogin(page, user);
    await expect(page).toHaveURL(PROTECTED_LANDING);
    await page.goto('/login');
    await expect(page).toHaveURL(PROTECTED_LANDING);
  },
);

test(
  'AUTH-01-AC02 keyboard-only sign-in on a mobile viewport',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'auth01-ac02' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');
    // No horizontal scrolling at phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await expect(authUi.email(page)).toBeVisible();
    await authUi.email(page).focus();
    await page.keyboard.type(user.email);
    await page.keyboard.press('Tab');
    await expect(authUi.password(page)).toBeFocused();
    await page.keyboard.type(user.password);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(PROTECTED_LANDING);
  },
);

test(
  'AUTH-01-AC03 wrong credentials show the same generic error without leaking account existence',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'auth01-ac03' });
    const wrongPassword = `Wrong-${user.password}`;
    const messages: string[] = [];

    for (const email of [user.email, `nobody-${user.id}@example.test`]) {
      await submitLogin(page, { email, password: wrongPassword });
      const alert = formAlert(page);
      await expect(alert, email).toBeVisible();
      await expect(alert).toContainText(GENERIC_LOGIN_ERROR);
      await expect(alert).not.toContainText(ACCOUNT_EXISTENCE);
      await expect(page).toHaveURL(LOGIN_SCREEN);
      // Nothing sensitive is echoed: not the password (page or URL), not raw Auth error codes.
      expect(page.url()).not.toContain(encodeURIComponent(wrongPassword));
      await expect(page.getByRole('main')).not.toContainText(wrongPassword);
      await expect(page.getByRole('main')).not.toContainText(/invalid_credentials|AuthApiError/);
      // Retry stays possible from the same form.
      await expect(authUi.signInButton(page)).toBeEnabled();
      messages.push(((await alert.textContent()) ?? '').trim());
    }
    expect(messages[0]).toBe(messages[1]);

    // Retrying with the right credentials from the same form succeeds.
    await authUi.email(page).fill(user.email);
    await authUi.password(page).fill(user.password);
    await authUi.signInButton(page).click();
    await expect(page).toHaveURL(PROTECTED_LANDING);
  },
);

test(
  'AUTH-01-AC04 after sign-out, reload and direct protected URLs return to /login',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'auth01-ac04' });
    await submitLogin(page, user);
    await expect(page).toHaveURL(PROTECTED_LANDING);

    // Sign-out control on the account screen (ACCOUNT-01 provides it, docs/auth.md §2).
    await page.goto('/settings/security');
    await authUi.signOutButton(page).click();
    await expect(page).toHaveURL(LOGIN_SCREEN);

    await page.reload();
    await expect(page).toHaveURL(LOGIN_SCREEN);
    for (const target of ['/workspaces', '/settings/security']) {
      await page.goto(target);
      await expect(page, target).toHaveURL(LOGIN_SCREEN);
      expect(new URL(page.url()).searchParams.get('next'), target).toBe(target);
    }
  },
);
