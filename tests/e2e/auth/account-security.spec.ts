// ACCOUNT-01 — 계정 보안 설정 (`/settings/security`), docs/screens/account-security.md +
// docs/auth.md §2 (email, password change, sign-out) and §7 AUTH-API-AC03 (no refresh reuse).
//
// Authenticated project. AC01's security page check only reads, so it uses the shared `setup`
// session; its header check needs its own workspaces, so it signs in a workspaceFactory member
// (viewport resized per breakpoint). AC02/AC03 change the password or end the session, so each
// signs in its own userFactory user through /login in a cookie-less context instead of touching
// the shared user.
import { readFileSync } from 'node:fs';
import {
  authUi,
  canSignIn,
  expect,
  formAlert,
  homePath,
  LOGIN_SCREEN,
  newCredentials,
  refreshStatus,
  sessionRefreshToken,
  signInAs,
  submitLogin,
  test,
} from '../fixtures/test.ts';
import type { Locator, Page } from '@playwright/test';
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
    // The app-shell account button shows the same email (UX1), full value in its name/title.
    const account = authUi.accountButton(page);
    await expect(account).toContainText(email);
    expect(await account.getAttribute('aria-label')).toContain(email);
    await expect(account).toHaveAttribute('title', email);
    await expect(authUi.newPassword(page)).toBeVisible();
    await expect(authUi.confirmNewPassword(page)).toBeVisible();
    await expect(authUi.updatePasswordButton(page)).toBeVisible();
    await expect(authUi.signOutButton(page)).toBeVisible();
  },
);

test.describe('own session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test(
    'ACCOUNT-01-AC01 header account button shows the whole email from 768px, an account icon below, and truncates only without room',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const owner = await workspaceFactory.member('ac01');
      const { email } = owner.user;
      const short = await workspaceFactory.create(owner, '알고리즘 스터디');
      const crowded = await workspaceFactory.create(
        owner,
        `${'아주 긴 Workspace 이름 '.repeat(8)}끝`,
      );
      await signInAs(page, owner.user);
      const account = authUi.accountButton(page);
      const label = account.getByText(email, { exact: true });
      const icon = account.locator('svg');
      const switcher = page.getByRole('button', { name: /workspace 전환/i });

      // Wide (desktop, iPad portrait): the email is shown as text, no icon, and it is never cut
      // while the header still has free space (the old 280px cap left space and still cut it).
      // At 1280px the long test email fits on every platform, so it must be whole and wider
      // than the old cap; at 834px it may legitimately not fit (font metrics differ per OS).
      for (const width of [1280, 834]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(homePath(short.id));
        await expect(label).toBeVisible();
        await expect(icon).toBeHidden();
        if (await isTruncated(label)) {
          expect(
            await headerFreeSpace(account),
            `email truncated at ${width}px although the header has room`,
          ).toBeLessThanOrEqual(1);
        }
        if (width === 1280) {
          expect(await isTruncated(label), 'email truncated at 1280px').toBe(false);
          expect((await account.boundingBox())?.width ?? 0).toBeGreaterThan(280);
        }
        await expectHeaderFits(page, switcher, account);
      }

      // Narrow (phone): a square account icon button; the email stays in the name and title, and
      // the switcher keeps room for a short workspace name.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(homePath(short.id));
      await expect(icon).toBeVisible();
      await expect(label).toBeHidden();
      await expect(account).toHaveAccessibleName(new RegExp(escapeRegExp(email)));
      await expect(account).toHaveAttribute('title', email);
      const box = await account.boundingBox();
      expect(
        box && Math.abs(box.width - box.height) <= 1 && box.width >= 24 && box.width <= 36,
      ).toBe(true);
      expect(await isTruncated(switcher.getByText('알고리즘 스터디', { exact: true }))).toBe(false);
      await expectHeaderFits(page, switcher, account);
      await account.click();
      const menu = page.getByRole('dialog', { name: '계정 메뉴' });
      await expect(menu.getByText(email, { exact: true })).toBeVisible();
      expect(await isTruncated(menu.getByText(email, { exact: true }))).toBe(false);
      await page.keyboard.press('Escape');

      // Just above the breakpoint with a very long workspace name and a long email the header
      // genuinely lacks room: the email falls back to an ellipsis and the page never overflows.
      await page.setViewportSize({ width: 780, height: 900 });
      await page.goto(homePath(crowded.id));
      await expect(label).toBeVisible();
      expect(await isTruncated(label)).toBe(true);
      expect(await label.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
      expect(await headerFreeSpace(account)).toBeLessThanOrEqual(1);
      await expectHeaderFits(page, switcher, account);
    },
  );

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the element's text is clipped (ellipsis) rather than fully shown. */
async function isTruncated(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.scrollWidth > el.clientWidth);
}

/**
 * Unused horizontal space in the app-shell header row (the account button's flex container):
 * content width minus every item's width and the gaps between them.
 */
async function headerFreeSpace(account: Locator): Promise<number> {
  return account.evaluate((button) => {
    const header = button.parentElement;
    if (!header) return Number.POSITIVE_INFINITY;
    const style = getComputedStyle(header);
    const items = [...header.children].filter((el) => getComputedStyle(el).display !== 'none');
    const inner =
      header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const gap = parseFloat(style.columnGap) || 0;
    const used = items.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
    return inner - used - gap * Math.max(items.length - 1, 0);
  });
}

/** SMOKE-02's header constraints: the switcher ends left of the account button, no page overflow. */
async function expectHeaderFits(page: Page, switcher: Locator, account: Locator): Promise<void> {
  const [s, a] = await Promise.all([switcher.boundingBox(), account.boundingBox()]);
  expect(s && a && s.x + s.width <= a.x).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
