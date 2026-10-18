// AUTH-01 — 로그인 (`/login`), docs/screens/auth-login.md + docs/auth.md §2/§7.
// Unauthenticated project: every test starts without cookies; users come from userFactory.
import {
  appPath,
  authUi,
  blockForeignHosts,
  CAPTCHA_EXPIRED,
  CAPTCHA_FAILED,
  CAPTCHA_LOAD_FAILED,
  CAPTCHA_REQUIRED,
  captchaUi,
  DUMMY_TOKEN,
  expect,
  expectBlockedForCaptcha,
  expectCaptchaVerified,
  expectNoMotion,
  formAlert,
  LOGIN_SCREEN,
  PROTECTED_LANDING,
  recordMutations,
  submitLogin,
  test,
  TEST_SITE_KEY,
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
    // CAPTCHA (A4): the always-passes check finishes on its own; Enter submits once it has.
    await expectCaptchaVerified(page);
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

test(
  'AUTH-01-AC05 security check gates sign-in, its token goes with the request and is never reused',
  { tag: '@infra' },
  async ({ page, userFactory, turnstile }) => {
    const user = await userFactory.create({ label: 'auth01-ac05' });
    turnstile.mode = 'interactive';
    await page.goto('/login');
    await expect(captchaUi.group(page)).toBeVisible();
    const stats = await turnstile.stats(page);
    expect(stats.sitekeys).toEqual([TEST_SITE_KEY]);
    expect(stats.languages).toEqual(['ko']);

    // No token yet: the button says why, and Enter sends nothing.
    const button = authUi.signInButton(page);
    await expectBlockedForCaptcha(button);
    const mutations = recordMutations(page);
    await authUi.email(page).fill(user.email);
    await authUi.password(page).fill(`Wrong-${user.password}`);
    await authUi.password(page).press('Enter');
    await expect(page.getByRole('main').getByText(CAPTCHA_REQUIRED).first()).toBeVisible();
    // Focus moves to the security-check region so a screen reader announces it.
    await expect(captchaUi.group(page)).toBeFocused();
    expect(mutations).toEqual([]);

    // Solved: the sign-in Server Action carries the token (Auth rejects the wrong password).
    await turnstile.solve(page);
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await button.click();
    await expect(formAlert(page)).toBeVisible();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.postData() ?? '').toContain(DUMMY_TOKEN);

    // The attempt spent the token: the widget was reset and the next submit waits for a new one.
    await expect.poll(async () => (await turnstile.stats(page)).resets).toBeGreaterThanOrEqual(1);
    await expectBlockedForCaptcha(button);
    await authUi.password(page).fill(user.password);
    await authUi.password(page).press('Enter');
    await expect(page.getByRole('main').getByText(CAPTCHA_REQUIRED).first()).toBeVisible();
    expect(mutations).toHaveLength(1);

    await turnstile.solve(page);
    await button.click();
    await expect(page).toHaveURL(PROTECTED_LANDING);
    expect(mutations).toHaveLength(2);
    expect(mutations[1]?.postData() ?? '').toContain(DUMMY_TOKEN);
  },
);

test('AUTH-01-AC06 failed, expired or unavailable security check explains itself and recovers by keyboard', async ({
  page,
  turnstile,
}) => {
  // Server-side rejection (`captcha_failed`) of the sign-in Server Action is not observable from
  // the browser; its copy is covered by apps/web/test/sign-in-action.test.ts.
  const button = authUi.signInButton(page);
  const status = captchaUi.status(page);
  const retryByKeyboard = async () => {
    await expect(captchaUi.retry(page)).toBeVisible();
    await captchaUi.retry(page).focus();
    await page.keyboard.press('Enter');
  };

  // The Turnstile script cannot be loaded.
  turnstile.mode = 'unreachable';
  await page.goto('/login');
  await expect(status).toContainText(CAPTCHA_LOAD_FAILED);
  await expectBlockedForCaptcha(button);
  turnstile.mode = 'pass';
  await retryByKeyboard();
  await expectCaptchaVerified(page);
  await expect(button).not.toHaveAttribute('aria-disabled', 'true');

  // The token expires before the user submits.
  await turnstile.expire(page);
  await expect(status).toContainText(CAPTCHA_EXPIRED);
  await expectBlockedForCaptcha(button);

  // The new challenge itself fails.
  await turnstile.setMode(page, 'fail');
  await retryByKeyboard();
  await expect(status).toContainText(CAPTCHA_FAILED);
  await expectBlockedForCaptcha(button);
  await turnstile.setMode(page, 'pass');
  await retryByKeyboard();
  await expectCaptchaVerified(page);

  // Reduced motion (pinned for every project): nothing in the region animates.
  await expectNoMotion(captchaUi.group(page));
});
