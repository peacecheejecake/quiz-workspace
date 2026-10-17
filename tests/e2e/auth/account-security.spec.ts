// ACCOUNT-01 — 계정 보안 설정 (`/settings/security`), docs/screens/account-security.md +
// docs/auth.md §2 (email, password change, sign-out) and §7 AUTH-API-AC03 (no refresh reuse).
//
// Authenticated project. AC01 only reads, so it uses the shared `setup` session. AC02/AC03 change
// the password or end the session, so each signs in its own userFactory user through /login in a
// cookie-less context instead of touching the shared user.
import { readFileSync } from 'node:fs';
import {
  authUi,
  canSignIn,
  expect,
  formAlert,
  LOGIN_SCREEN,
  newCredentials,
  refreshStatus,
  sessionRefreshToken,
  submitLogin,
  test,
} from '../fixtures/test.ts';
import { AUTH_META_PATH } from '../setup/paths.ts';

const SECURITY_PATH = '/settings/security';
const PASSWORD_CHANGED =
  /비밀번호.*(변경|저장)(되었|했|완료)|password (has been |was )?(updated|changed)/i;

test(
  'ACCOUNT-01-AC01 signed-in user sees their own email and the available security actions',
  { tag: '@infra' },
  async ({ page }) => {
    const { email } = JSON.parse(readFileSync(AUTH_META_PATH, 'utf8')) as { email: string };
    await page.goto(SECURITY_PATH);
    await expect(page).toHaveURL((url) => url.pathname === SECURITY_PATH);

    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      /계정 보안|보안 설정|security/i,
    );
    await expect(main.getByText(email, { exact: true })).toBeVisible();
    await expect(authUi.newPassword(page)).toBeVisible();
    await expect(authUi.confirmNewPassword(page)).toBeVisible();
    await expect(authUi.updatePasswordButton(page)).toBeVisible();
    await expect(authUi.signOutButton(page)).toBeVisible();
  },
);

test.describe('own session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test(
    'ACCOUNT-01-AC02 password change shows success and never echoes or logs the password',
    { tag: '@infra' },
    async ({ page, userFactory }) => {
      const user = await userFactory.create({ label: 'account01-ac02' });
      const consoleLines: string[] = [];
      page.on('console', (msg) => consoleLines.push(msg.text()));

      await submitLogin(page, user, SECURITY_PATH);
      await expect(page).toHaveURL((url) => url.pathname === SECURITY_PATH);

      const { password: newPassword } = newCredentials('account01-ac02');
      await authUi.newPassword(page).fill(newPassword);
      await authUi.confirmNewPassword(page).fill(newPassword);
      await authUi.updatePasswordButton(page).click();

      const main = page.getByRole('main');
      await expect(main.getByText(PASSWORD_CHANGED).first()).toBeVisible();
      await expect(formAlert(page).filter({ hasText: /오류|실패|error|failed/i })).toHaveCount(0);
      // The fields are cleared and the password appears nowhere: screen, URL, browser console.
      await expect(authUi.newPassword(page)).toHaveValue('');
      await expect(authUi.confirmNewPassword(page)).toHaveValue('');
      await expect(main).not.toContainText(newPassword);
      await expect(main).not.toContainText(user.password);
      expect(page.url()).not.toContain(newPassword);
      expect(
        consoleLines.filter((l) => l.includes(newPassword) || l.includes(user.password)),
      ).toEqual([]);

      expect(await canSignIn({ email: user.email, password: newPassword })).toBe(true);
      expect(await canSignIn(user)).toBe(false);
    },
  );

  test(
    'ACCOUNT-01-AC03 after sign-out protected pages require signing in and the refresh token is dead',
    { tag: '@infra' },
    async ({ page, context, userFactory }) => {
      const user = await userFactory.create({ label: 'account01-ac03' });
      await submitLogin(page, user, SECURITY_PATH);
      await expect(page).toHaveURL((url) => url.pathname === SECURITY_PATH);
      const refreshToken = await sessionRefreshToken(context);
      expect(refreshToken, 'Supabase SSR session cookie after sign-in').toBeTruthy();

      await authUi.signOutButton(page).click();
      await expect(page).toHaveURL(LOGIN_SCREEN);

      for (const target of [SECURITY_PATH, '/workspaces']) {
        await page.goto(target);
        await expect(page, target).toHaveURL(LOGIN_SCREEN);
        expect(new URL(page.url()).searchParams.get('next'), target).toBe(target);
      }
      // The signed-out session cannot be revived (docs/auth.md §7 AUTH-API-AC03).
      expect(await refreshStatus(refreshToken ?? '')).toBeGreaterThanOrEqual(400);

      // Signing in again works and lands on the protected page.
      await submitLogin(page, user, SECURITY_PATH);
      await expect(page).toHaveURL((url) => url.pathname === SECURITY_PATH);
    },
  );
});
