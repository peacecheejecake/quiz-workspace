import { test, expect } from '@playwright/test';

test('AUTH-01-AC01 unauthenticated users are redirected', async ({ page }) => {
  await page.goto('/workspaces');
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole('textbox', { name: /이메일|email/i })).toBeVisible();
});

test('AUTH-01-AC03 invalid credentials give a safe error', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /이메일|email/i }).fill('nonexistent@example.invalid');
  await page.getByLabel(/비밀번호|password/i).fill('Incorrect-Password-123!');
  await page.getByRole('button', { name: /로그인|sign in/i }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText(/user not found|계정이 존재하지/);
});
