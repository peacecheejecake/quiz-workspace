import { test as setup, expect } from '@playwright/test';

setup('create authenticated state with a dedicated E2E user', async ({ page }) => {
  const email = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;
  if (!email || !password) throw new Error('E2E auth user missing (seed fixture required)');
  await page.goto('/login');
  await page.getByRole('textbox', { name: /이메일|email/i }).fill(email);
  await page.getByLabel(/비밀번호|password/i).fill(password);
  await page.getByRole('button', { name: /로그인|sign in/i }).click();
  await expect(page).toHaveURL(/\/workspaces/);
  await page.context().storageState({ path: 'playwright/.auth/user.json' });
});
