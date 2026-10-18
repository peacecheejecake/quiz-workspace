// AUTH-02 — 회원가입 (`/signup`), docs/screens/auth-signup.md + docs/auth.md §1/§5.
// Password policy: at least 10 characters, no composition rules (implementation-plan §7).
import {
  atPath,
  authUi,
  CAPTCHA_FAILED,
  CAPTCHA_REJECTED,
  CAPTCHA_REQUIRED,
  captchaTokenOf,
  captchaUi,
  DUMMY_TOKEN,
  expect,
  expectBlockedForCaptcha,
  expectCaptchaVerified,
  expectFieldError,
  expectNoMotion,
  formAlert,
  newCredentials,
  recordMutations,
  test,
  waitForLatestMessage,
} from '../fixtures/test.ts';
import type { Page } from '@playwright/test';

const VERIFY_SCREEN = atPath(/^\/auth\/verify$/);
const ACCOUNT_EXISTENCE =
  /이미 (가입|등록|사용)|already (registered|exists|in use|taken)|user_already_exists|email_exists/i;

async function fillSignup(page: Page, email: string, password: string, confirm = password) {
  await page.goto('/signup');
  await expect(authUi.email(page)).toBeVisible();
  await authUi.email(page).fill(email);
  await authUi.password(page).fill(password);
  await authUi.confirmPassword(page).fill(confirm);
  await authUi.signUpButton(page).click();
}

test(
  'AUTH-02-AC01 valid sign-up goes to the email confirmation notice and stays locked out',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const { email, password } = newCredentials('auth02-ac01');
    userFactory.adopt(email);
    const since = new Date();

    await fillSignup(page, email, password);
    await expect(page).toHaveURL(VERIFY_SCREEN);
    await expect(
      page.getByRole('heading', { name: /이메일.*(확인|인증)|(check|verify|confirm) your email/i }),
    ).toBeVisible();
    // The Auth server really sent the confirmation mail.
    const mail = await waitForLatestMessage(email, { since });
    expect(mail.to).toContain(email);

    // Not confirmed yet: protected screens stay closed.
    for (const target of ['/workspaces', '/settings/security']) {
      await page.goto(target);
      await expect(page, target).toHaveURL(atPath(/^\/(login|auth\/verify)$/));
    }
  },
);

test('AUTH-02-AC02 short password shows a field error and never calls sign-up', async ({
  page,
}) => {
  const { email } = newCredentials('auth02-ac02');
  await page.goto('/signup');
  await expect(authUi.email(page)).toBeVisible();
  const mutations = recordMutations(page);
  await authUi.email(page).fill(email);
  await authUi.password(page).fill('short-9ch');
  await authUi.confirmPassword(page).fill('short-9ch');
  await authUi.signUpButton(page).click();

  await expectFieldError(authUi.password(page), /10\s*자|10 characters/i);
  await expect(page).toHaveURL(atPath(/^\/signup$/));
  expect(mutations.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
});

test('AUTH-02-AC02 mismatched confirmation shows a field error and never calls sign-up', async ({
  page,
}) => {
  const { email, password } = newCredentials('auth02-ac02');
  await page.goto('/signup');
  await expect(authUi.email(page)).toBeVisible();
  const mutations = recordMutations(page);
  await authUi.email(page).fill(email);
  await authUi.password(page).fill(password);
  await authUi.confirmPassword(page).fill(`${password}-typo`);
  await authUi.signUpButton(page).click();

  await expectFieldError(
    authUi.confirmPassword(page),
    /일치하지 않|do(es)? not match|doesn't match/i,
  );
  await expect(page).toHaveURL(atPath(/^\/signup$/));
  expect(mutations.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
});

test(
  'AUTH-02-AC03 signing up with an existing email looks the same as a new sign-up',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const existing = await userFactory.create({ label: 'auth02-ac03' });
    const fresh = newCredentials('auth02-ac03');
    userFactory.adopt(fresh.email);

    const screens: string[] = [];
    for (const email of [fresh.email, existing.email]) {
      await fillSignup(page, email, fresh.password);
      await expect(page, email).toHaveURL(VERIFY_SCREEN);
      await expect(page.getByRole('main')).not.toContainText(ACCOUNT_EXISTENCE);
      // Compare settled screens: the resend form's security check (A4) has finished.
      await expectCaptchaVerified(page);
      screens.push(((await page.getByRole('main').innerText()) ?? '').replaceAll(email, '<email>'));
    }
    expect(screens[1]).toBe(screens[0]);
  },
);

test('AUTH-02-AC03 rate-limited sign-up shows a generic retry notice', async ({ page }) => {
  const { email, password } = newCredentials('auth02-ac03');
  let intercepted = 0;
  // Simulated Auth rate limit (the browser-side Auth call; see the A0 notes in the commit body).
  await page.route('**/auth/v1/signup**', async (route) => {
    intercepted++;
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 429,
        error_code: 'over_request_rate_limit',
        msg: 'Request rate limit reached',
      }),
    });
  });

  await fillSignup(page, email, password);
  await expect.poll(() => intercepted, { message: 'sign-up reached the Auth API' }).toBe(1);
  const alert = formAlert(page);
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/잠시 후|다시 시도|try again/i);
  await expect(alert).not.toContainText(/over_request_rate_limit|429|rate limit reached/i);
  await expect(alert).not.toContainText(email);
  await expect(page).toHaveURL(atPath(/^\/signup$/));
});

test(
  'AUTH-02-AC04 security check gates sign-up, its token goes with the request and is never reused',
  { tag: '@infra' },
  async ({ page, userFactory, turnstile }) => {
    const { email, password } = newCredentials('auth02-ac04');
    userFactory.adopt(email);
    turnstile.mode = 'interactive';
    const tokens: (string | undefined)[] = [];
    // First attempt: Auth throttles it (simulated); the second goes to the real Auth server.
    await page.route('**/auth/v1/signup**', async (route) => {
      tokens.push(captchaTokenOf(route.request().postData()));
      if (tokens.length === 1) {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'limit' }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/signup');
    await expect(captchaUi.group(page)).toBeVisible();
    const button = authUi.signUpButton(page);
    await expectBlockedForCaptcha(button);
    await authUi.email(page).fill(email);
    await authUi.password(page).fill(password);
    await authUi.confirmPassword(page).fill(password);
    await authUi.confirmPassword(page).press('Enter');
    await expect(page.getByRole('main').getByText(CAPTCHA_REQUIRED).first()).toBeVisible();
    await expect(captchaUi.group(page)).toBeFocused();
    expect(tokens).toEqual([]);

    await turnstile.solve(page);
    await button.click();
    await expect(formAlert(page)).toContainText(/잠시 후|다시 시도|try again/i);
    expect(tokens).toEqual([DUMMY_TOKEN]);

    // Spent: reset, blocked again until a new token exists.
    await expect.poll(async () => (await turnstile.stats(page)).resets).toBeGreaterThanOrEqual(1);
    await expectBlockedForCaptcha(button);
    await authUi.confirmPassword(page).press('Enter');
    expect(tokens).toHaveLength(1);

    await turnstile.solve(page);
    await button.click();
    await expect(page).toHaveURL(VERIFY_SCREEN);
    expect(tokens).toEqual([DUMMY_TOKEN, DUMMY_TOKEN]);
  },
);

test('AUTH-02-AC05 rejected or failed security check shows a Korean notice and a keyboard retry', async ({
  page,
  turnstile,
}) => {
  const { email, password } = newCredentials('auth02-ac05');
  let calls = 0;
  // Auth refuses the token (what Supabase answers when CAPTCHA verification fails).
  await page.route('**/auth/v1/signup**', async (route) => {
    calls++;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 400,
        error_code: 'captcha_failed',
        msg: 'captcha protection: request disallowed (invalid-input-response)',
      }),
    });
  });

  await fillSignup(page, email, password);
  await expect.poll(() => calls).toBe(1);
  const alert = formAlert(page);
  await expect(alert).toContainText(CAPTCHA_REJECTED);
  await expect(alert).not.toContainText(/captcha_failed|invalid-input-response|400/);
  await expect(alert).not.toContainText(email);
  // A fresh token is fetched for the next attempt (always-passes mode).
  await expectCaptchaVerified(page);

  // The token expires, and the new challenge fails; retry by keyboard once it works again.
  await turnstile.expire(page);
  await turnstile.setMode(page, 'fail');
  await captchaUi.retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(captchaUi.status(page)).toContainText(CAPTCHA_FAILED);
  await expectBlockedForCaptcha(authUi.signUpButton(page));
  await turnstile.setMode(page, 'pass');
  await captchaUi.retry(page).focus();
  await page.keyboard.press('Enter');
  await expectCaptchaVerified(page);
  await expectNoMotion(captchaUi.group(page));
});
