// AUTH-06 — 새 비밀번호 설정 (`/reset-password`), docs/screens/auth-reset.md + docs/auth.md §2/§3.
// The recovery mail links to `/auth/callback?token_hash=…&type=recovery&next=/reset-password`;
// only that recovery session may set a new password.
import type { Page } from '@playwright/test';
import {
  atPath,
  authUi,
  canSignIn,
  expect,
  expectFieldError,
  newCredentials,
  PROTECTED_LANDING,
  recordMutations,
  requestPasswordRecovery,
  submitLogin,
  test,
  waitForMailLink,
  type TestUser,
} from '../fixtures/test.ts';

const RESET_SCREEN = atPath(/^\/reset-password$/);
const UPDATED_NOTICE =
  /비밀번호.*(변경|재설정|설정)(되었|했|완료)|password (has been |was )?(updated|changed|reset)/i;

async function recoveryLink(user: TestUser): Promise<string> {
  const since = new Date();
  await requestPasswordRecovery(user.email);
  return waitForMailLink(user.email, { since, match: /\/auth\/callback\?/ });
}

/** Opens the recovery link and waits for the new-password form. */
async function openResetForm(page: Page, user: TestUser): Promise<void> {
  await page.goto(await recoveryLink(user));
  await expect(page).toHaveURL(RESET_SCREEN);
  await expect(authUi.newPassword(page)).toBeVisible();
}

/** The link to request a new recovery mail; asserted to point at `/forgot-password`. */
function newLinkPath(page: Page) {
  return page
    .getByRole('main')
    .getByRole('link', { name: /재설정|복구|새 링크|비밀번호 찾기|reset|new link|forgot/i })
    .first();
}

async function expectNewLinkOffer(page: Page): Promise<void> {
  await expect(authUi.newPassword(page)).toHaveCount(0);
  await expect(newLinkPath(page)).toBeVisible();
  await expect(newLinkPath(page)).toHaveAttribute('href', /^\/forgot-password(?:[?#]|$)/);
}

test(
  'AUTH-06-AC01 recovery session plus a valid new password shows the success notice',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'auth06-ac01' });
    await openResetForm(page, user);

    const { password: newPassword } = newCredentials('auth06-ac01');
    await authUi.newPassword(page).fill(newPassword);
    await authUi.confirmNewPassword(page).fill(newPassword);
    await authUi.updatePasswordButton(page).click();

    await expect(page.getByRole('main').getByText(UPDATED_NOTICE).first()).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText(newPassword);
    expect(page.url()).not.toContain(newPassword);
    expect(await canSignIn({ email: user.email, password: newPassword })).toBe(true);
    expect(await canSignIn(user)).toBe(false);
  },
);

test(
  'AUTH-06-AC02 tampered or used recovery links and no recovery session cannot change the password',
  { tag: '@infra' },
  async ({ page, context, userFactory }) => {
    const user = await userFactory.create({ label: 'auth06-ac02' });

    // 1) Tampered token_hash.
    const link = new URL(await recoveryLink(user));
    const hash = link.searchParams.get('token_hash') ?? '';
    link.searchParams.set('token_hash', `${hash.slice(0, -4)}beef`);
    await page.goto(link.toString());
    await expectNewLinkOffer(page);

    // 2) A recovery link used once cannot be replayed in a fresh browser.
    const used = await recoveryLink(user);
    await page.goto(used);
    await expect(page).toHaveURL(RESET_SCREEN);
    await context.clearCookies();
    await page.goto(used);
    await expectNewLinkOffer(page);

    // 3) /reset-password without a recovery session offers a new link instead of the form.
    await context.clearCookies();
    await page.goto('/reset-password');
    await expectNewLinkOffer(page);
    await newLinkPath(page).click();
    await expect(page).toHaveURL(atPath(/^\/forgot-password$/));

    expect(await canSignIn(user)).toBe(true);
  },
);

test(
  'AUTH-06-AC02 a normal (non-recovery) session cannot use /reset-password',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'auth06-ac02-session' });
    // Regular password sign-in: authenticated, but not a recovery session.
    await submitLogin(page, user);
    await expect(page).toHaveURL(PROTECTED_LANDING);

    await page.goto('/reset-password');
    // Denied: no new-password form, only the way to request a recovery link (here or on
    // /auth/error), and the session is not turned into a password change.
    await expect(page).toHaveURL(atPath(/^\/(reset-password|auth\/error)$/));
    await expectNewLinkOffer(page);
    expect(await canSignIn(user)).toBe(true);
  },
);

test(
  'AUTH-06-AC03 mismatched confirmation shows a field error without a request',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'auth06-ac03' });
    await openResetForm(page, user);

    const { password: newPassword } = newCredentials('auth06-ac03');
    const mutations = recordMutations(page);
    await authUi.newPassword(page).fill(newPassword);
    await authUi.confirmNewPassword(page).fill(`${newPassword}-typo`);
    await authUi.updatePasswordButton(page).click();

    await expectFieldError(
      authUi.confirmNewPassword(page),
      /일치하지 않|do(es)? not match|doesn't match/i,
    );
    expect(mutations.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
    expect(await canSignIn(user)).toBe(true);
  },
);
