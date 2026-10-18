// AUTH-05 — 비밀번호 재설정 요청 (`/forgot-password`), docs/screens/auth-forgot.md + docs/auth.md §5/§7.
import type { Page } from '@playwright/test';
import {
  atPath,
  authUi,
  CAPTCHA_FAILED,
  CAPTCHA_LOAD_FAILED,
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
  waitForMailLink,
} from '../fixtures/test.ts';

const FORGOT_SCREEN = atPath(/^\/forgot-password$/);
const SUCCESS_NOTICE =
  /(재설정|비밀번호).*(메일|이메일|링크).*(보냈|발송|전송|확인)|(check your (email|inbox)|reset link (has been |was )?sent|if an account exists)/i;

async function requestReset(page: Page, email: string): Promise<void> {
  await page.goto('/forgot-password');
  await expect(authUi.email(page)).toBeVisible();
  await authUi.email(page).fill(email);
  await authUi.sendResetButton(page).click();
}

test(
  'AUTH-05-AC01 existing and unknown emails get the identical success notice',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const existing = await userFactory.create({ label: 'auth05-ac01' });
    const unknown = newCredentials('auth05-ac01-unknown');
    userFactory.adopt(unknown.email);

    const screens: string[] = [];
    const since = new Date();
    for (const email of [existing.email, unknown.email]) {
      await requestReset(page, email);
      await expect(page.getByRole('main').getByText(SUCCESS_NOTICE).first(), email).toBeVisible();
      await expect(page, email).toHaveURL(FORGOT_SCREEN);
      screens.push((await page.getByRole('main').innerText()).replaceAll(email, '<email>'));
    }
    expect(screens[1]).toBe(screens[0]);

    // The request was real: only the existing account receives a recovery link.
    const link = await waitForMailLink(existing.email, { since, match: /\/auth\/callback\?/ });
    expect(new URL(link).searchParams.get('type')).toBe('recovery');
  },
);

test('AUTH-05-AC02 malformed email shows a field error and sends no request', async ({ page }) => {
  await page.goto('/forgot-password');
  await expect(authUi.email(page)).toBeVisible();
  const mutations = recordMutations(page);
  await authUi.email(page).fill('not-an-email');
  await authUi.sendResetButton(page).click();

  await expectFieldError(authUi.email(page), /이메일 (형식|주소)|valid email|email address/i);
  await expect(page.getByRole('main').getByText(SUCCESS_NOTICE)).toHaveCount(0);
  expect(mutations.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
});

test('AUTH-05-AC03 rate limit and server failure show a retry notice without details', async ({
  page,
}) => {
  const { email } = newCredentials('auth05-ac03');
  const failures = [
    {
      status: 429,
      body: {
        code: 429,
        error_code: 'over_email_send_rate_limit',
        msg: 'Email rate limit exceeded',
      },
    },
    { status: 500, body: { code: 500, error_code: 'unexpected_failure', msg: 'Database error' } },
  ];
  for (const failure of failures) {
    let intercepted = 0;
    // Simulated Auth failure on the browser-side recovery call (see the A0 notes in the commit).
    await page.route('**/auth/v1/recover**', async (route) => {
      intercepted++;
      await route.fulfill({
        status: failure.status,
        contentType: 'application/json',
        body: JSON.stringify(failure.body),
      });
    });

    await requestReset(page, email);
    await expect.poll(() => intercepted, { message: 'reset request reached the Auth API' }).toBe(1);
    const alert = formAlert(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/잠시 후|다시 시도|try again/i);
    await expect(alert).not.toContainText(failure.body.error_code);
    await expect(alert).not.toContainText(failure.body.msg);
    await expect(alert).not.toContainText(email);
    await expect(page.getByRole('main').getByText(SUCCESS_NOTICE)).toHaveCount(0);
    await page.unrouteAll();
  }
});

test(
  'AUTH-05-AC04 security check gates the reset request, its token goes with it and is never reused',
  { tag: '@infra' },
  async ({ page, turnstile }) => {
    // Unknown address: the real Auth server answers like for an account but sends no mail.
    const { email } = newCredentials('auth05-ac04');
    turnstile.mode = 'interactive';
    const tokens: (string | undefined)[] = [];
    await page.route('**/auth/v1/recover**', async (route) => {
      tokens.push(captchaTokenOf(route.request().postData()));
      if (tokens.length === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 500, error_code: 'unexpected_failure', msg: 'x' }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/forgot-password');
    await expect(captchaUi.group(page)).toBeVisible();
    const button = authUi.sendResetButton(page);
    await expectBlockedForCaptcha(button);
    await authUi.email(page).fill(email);
    await authUi.email(page).press('Enter');
    await expect(page.getByRole('main').getByText(CAPTCHA_REQUIRED).first()).toBeVisible();
    await expect(captchaUi.group(page)).toBeFocused();
    expect(tokens).toEqual([]);

    await turnstile.solve(page);
    await button.click();
    await expect(formAlert(page)).toContainText(/잠시 후|다시 시도|try again/i);
    expect(tokens).toEqual([DUMMY_TOKEN]);

    await expect.poll(async () => (await turnstile.stats(page)).resets).toBeGreaterThanOrEqual(1);
    await expectBlockedForCaptcha(button);
    await authUi.email(page).press('Enter');
    expect(tokens).toHaveLength(1);

    await turnstile.solve(page);
    await button.click();
    await expect(page.getByRole('main').getByText(SUCCESS_NOTICE).first()).toBeVisible();
    expect(tokens).toEqual([DUMMY_TOKEN, DUMMY_TOKEN]);
  },
);

test('AUTH-05-AC05 rejected, failed or unavailable security check explains itself and recovers by keyboard', async ({
  page,
  turnstile,
}) => {
  const { email } = newCredentials('auth05-ac05');
  let calls = 0;
  await page.route('**/auth/v1/recover**', async (route) => {
    calls++;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 400,
        error_code: 'captcha_failed',
        msg: 'captcha protection: request disallowed (timeout-or-duplicate)',
      }),
    });
  });

  turnstile.mode = 'unreachable';
  await page.goto('/forgot-password');
  await expect(captchaUi.status(page)).toContainText(CAPTCHA_LOAD_FAILED);
  await expectBlockedForCaptcha(authUi.sendResetButton(page));
  turnstile.mode = 'fail';
  await captchaUi.retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(captchaUi.status(page)).toContainText(CAPTCHA_FAILED);
  await turnstile.setMode(page, 'pass');
  await captchaUi.retry(page).focus();
  await page.keyboard.press('Enter');
  await expectCaptchaVerified(page);

  await requestReset(page, email);
  await expect.poll(() => calls).toBe(1);
  const alert = formAlert(page);
  await expect(alert).toContainText(CAPTCHA_REJECTED);
  await expect(alert).not.toContainText(/captcha_failed|timeout-or-duplicate|400/);
  await expect(page.getByRole('main').getByText(SUCCESS_NOTICE)).toHaveCount(0);
  await expectCaptchaVerified(page);
  await expectNoMotion(captchaUi.group(page));
});
