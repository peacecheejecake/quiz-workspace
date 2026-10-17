// AUTH-05 — 비밀번호 재설정 요청 (`/forgot-password`), docs/screens/auth-forgot.md + docs/auth.md §5/§7.
import type { Page } from '@playwright/test';
import {
  atPath,
  authUi,
  expect,
  expectFieldError,
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
