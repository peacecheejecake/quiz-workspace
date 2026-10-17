// AUTH-03 — 이메일 인증 대기 (`/auth/verify`), docs/screens/auth-verify.md + docs/auth.md §1/§7.
// Confirmation mails link to `/auth/callback?token_hash=…&type=email` (implementation-plan §7).
import type { Page } from '@playwright/test';
import type { UserFactory } from '../fixtures/auth.ts';
import {
  atPath,
  authUi,
  canSignIn,
  expect,
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
