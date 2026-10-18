// AUTH-03 — 이메일 인증 대기 (`/auth/verify`), docs/screens/auth-verify.md + docs/auth.md §1/§7.
// Confirmation mails link to `/auth/callback?token_hash=…&type=email` (implementation-plan §7).
import type { BrowserContext, Page } from '@playwright/test';
import type { UserFactory } from '../fixtures/auth.ts';
import {
  atPath,
  authUi,
  canSignIn,
  CAPTCHA_EXPIRED,
  CAPTCHA_REJECTED,
  CAPTCHA_REQUIRED,
  captchaTokenOf,
  captchaUi,
  DUMMY_TOKEN,
  expect,
  expectBlockedForCaptcha,
  expectCaptchaVerified,
  expectNoMotion,
  formAlert,
  findUserIdByEmail,
  isEmailConfirmed,
  newCredentials,
  submitLogin,
  test,
  waitForLatestMessage,
  waitForMailLink,
} from '../fixtures/test.ts';

const VERIFY_SCREEN = atPath(/^\/auth\/verify$/);
const CALLBACK_LINK = /\/auth\/callback\?/;

/** Signs up through the app UI and waits for the verify screen; returns the credentials. */
async function signUpThroughUi(page: Page, userFactory: UserFactory, label: string) {
  const creds = newCredentials(label);
  userFactory.adopt(creds.email);
  await page.goto('/signup');
  await expect(authUi.email(page)).toBeVisible();
  await authUi.email(page).fill(creds.email);
  await authUi.password(page).fill(creds.password);
  await authUi.confirmPassword(page).fill(creds.password);
  await authUi.signUpButton(page).click();
  await expect(page).toHaveURL(VERIFY_SCREEN);
  return creds;
}

test(
  'AUTH-03-AC01 Mailpit confirmation link confirms the email and returns to the sign-in flow',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const since = new Date();
    const creds = await signUpThroughUi(page, userFactory, 'auth03-ac01');
    expect(await canSignIn(creds)).toBe(false);

    const link = await waitForMailLink(creds.email, { since, match: CALLBACK_LINK });
    await page.goto(link);
    // Back in the sign-in flow: signed in on the workspace list, or on /login to sign in.
    await expect(page).toHaveURL(atPath(/^\/(workspaces|login)$/));
    const id = await findUserIdByEmail(creds.email);
    expect(id).toBeDefined();
    expect(await isEmailConfirmed(id ?? '')).toBe(true);
    expect(await canSignIn(creds)).toBe(true);
  },
);

test(
  'AUTH-03-AC02 resend is throttled: one mail, then a disabled button with the reason',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const since = new Date();
    const creds = await signUpThroughUi(page, userFactory, 'auth03-ac02');
    const signupMail = await waitForLatestMessage(creds.email, { since });

    const resend = authUi.resendButton(page);
    await resend.click();
    // A second (resent) confirmation mail arrives.
    await expect
      .poll(async () => (await waitForLatestMessage(creds.email)).id, { timeout: 15_000 })
      .not.toBe(signupMail.id);

    // During the cooldown the control is blocked and says why (countdown or "try later").
    await expect(resend).toBeDisabled();
    await expect(page.getByRole('main')).toContainText(
      /\d+\s*초|잠시 후|다시 보낼 수|\d+\s*s(ec(ond)?s?)?\b|try again (in|later)/i,
    );
  },
);

test(
  'AUTH-03-AC03 unconfirmed user cannot reach protected workspace routes',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'auth03-ac03', confirmed: false });
    await submitLogin(page, user);
    // Sign-in is refused (verify notice or a login error), never a workspace.
    await expect(page).toHaveURL(atPath(/^\/(login|auth\/verify)$/));
    await expect(
      page
        .getByRole('main')
        .getByText(
          /이메일.*(확인|인증)|(confirm|verify).*email|email.*(not )?(confirmed|verified)/i,
        )
        .first(),
    ).toBeVisible();

    for (const target of ['/workspaces', '/workspaces/e2e-ws/documents']) {
      await page.goto(target);
      await expect(page, target).toHaveURL(atPath(/^\/(login|auth\/verify)$/));
    }
  },
);

test(
  'AUTH-03-AC03 unconfirmed sign-in sends the verify screen to that address, which can be changed',
  { tag: '@infra' },
  async ({ page, context, baseURL, userFactory }) => {
    // No mail is sent here: the user is created unconfirmed through the admin API and resend is
    // never clicked.
    const user = await userFactory.create({ label: 'auth03-ac03-addr', confirmed: false });
    const stale = newCredentials('auth03-ac03-stale').email;
    // An older pending address from a previous sign-up in this browser (same cookie the sign-up
    // form writes: path /auth/verify, host-only).
    await context.addCookies([
      {
        name: 'qz_verify_email',
        value: encodeURIComponent(stale),
        domain: new URL(baseURL ?? '').hostname,
        path: '/auth/verify',
        sameSite: 'Lax',
      },
    ]);

    await submitLogin(page, user);
    await page
      .getByRole('main')
      .getByRole('link', { name: /인증 메일|verification/i })
      .click();
    await expect(page).toHaveURL(VERIFY_SCREEN);
    const main = page.getByRole('main');
    await expect(main).toContainText(user.email);
    await expect(main).not.toContainText(stale);

    // The target address can be changed on demand.
    await expect(authUi.email(page)).toHaveCount(0);
    await main.getByRole('button', { name: /받는 주소 바꾸기|change address/i }).click();
    await expect(authUi.email(page)).toBeFocused();
    await expect(authUi.email(page)).toHaveValue(user.email);
    await expect(authUi.resendButton(page)).toBeEnabled();
  },
);

/** Pending-address cookie as the sign-up form writes it, so /auth/verify offers "resend" to it. */
async function pendingAddress(context: BrowserContext, baseURL: string | undefined, email: string) {
  await context.addCookies([
    {
      name: 'qz_verify_email',
      value: encodeURIComponent(email),
      domain: new URL(baseURL ?? '').hostname,
      path: '/auth/verify',
      sameSite: 'Lax',
    },
  ]);
}

/** Answers resend calls locally (no mail, no per-address frequency limit) and records tokens. */
async function stubResend(page: Page, answer: { status: number; body: unknown }) {
  const tokens: (string | undefined)[] = [];
  await page.route('**/auth/v1/resend**', async (route) => {
    tokens.push(captchaTokenOf(route.request().postData()));
    await route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  return tokens;
}

test('AUTH-03-AC04 security check gates resend, its token goes with the request and is never reused', async ({
  page,
  context,
  baseURL,
  turnstile,
}) => {
  await pendingAddress(context, baseURL, newCredentials('auth03-ac04').email);
  const tokens = await stubResend(page, { status: 200, body: {} });
  turnstile.mode = 'interactive';
  await page.clock.install();
  await page.goto('/auth/verify');
  await expect(captchaUi.group(page)).toBeVisible();

  const resend = authUi.resendButton(page);
  await expectBlockedForCaptcha(resend);
  await resend.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main').getByText(CAPTCHA_REQUIRED).first()).toBeVisible();
  await expect(captchaUi.group(page)).toBeFocused();
  expect(tokens).toEqual([]);

  await turnstile.solve(page);
  await resend.click();
  await expect(page.getByRole('main')).toContainText(/다시 보냈|resent|sent again/i);
  expect(tokens).toEqual([DUMMY_TOKEN]);
  await expect.poll(async () => (await turnstile.stats(page)).resets).toBeGreaterThanOrEqual(1);

  // After the cooldown the control still waits for a new token before sending again.
  await page.clock.fastForward('01:05');
  await expectBlockedForCaptcha(resend);
  await turnstile.solve(page);
  await resend.click();
  await expect.poll(() => tokens.length).toBe(2);
  expect(tokens).toEqual([DUMMY_TOKEN, DUMMY_TOKEN]);
});

test('AUTH-03-AC05 rejected or expired security check on resend explains itself and recovers by keyboard', async ({
  page,
  context,
  baseURL,
  turnstile,
}) => {
  await pendingAddress(context, baseURL, newCredentials('auth03-ac05').email);
  const tokens = await stubResend(page, {
    status: 400,
    body: {
      code: 400,
      error_code: 'captcha_failed',
      msg: 'captcha protection: request disallowed',
    },
  });
  await page.goto('/auth/verify');
  await expectCaptchaVerified(page);
  await authUi.resendButton(page).click();
  await expect.poll(() => tokens.length).toBe(1);
  const alert = formAlert(page);
  await expect(alert).toContainText(CAPTCHA_REJECTED);
  await expect(alert).not.toContainText(/captcha_failed|request disallowed|400/);
  // No cooldown for a refused check: a fresh token makes resend available again.
  await expectCaptchaVerified(page);
  await expect(authUi.resendButton(page)).not.toHaveAttribute('aria-disabled', 'true');

  await turnstile.expire(page);
  await expect(captchaUi.status(page)).toContainText(CAPTCHA_EXPIRED);
  await expectBlockedForCaptcha(authUi.resendButton(page));
  await captchaUi.retry(page).focus();
  await page.keyboard.press('Enter');
  await expectCaptchaVerified(page);
  await expectNoMotion(captchaUi.group(page));
});
