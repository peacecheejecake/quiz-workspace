import { expect, test } from '@playwright/test';

/** Recipient account must be distinct from original owner; allow_fork must be true. */
const forkUrl = process.env.E2E_FORK_SHARE_URL ?? '/share/e2e-fork-share';
test('WS-FORK-01-AC04 recipient forks into an owned workspace', async ({ page }) => {
  await page.goto(forkUrl);
  await page.getByRole('button', { name: /내 Workspace로 fork|fork workspace/i }).click();
  await page.getByRole('textbox', { name: /새 Workspace 이름|new workspace name/i }).fill('E2E Fork Workspace');
  await page.getByRole('button', { name: /fork 시작|confirm fork/i }).click();
  await expect(page.getByText(/fork 완료|fork completed/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /E2E Fork Workspace/i })).toBeVisible();
});
test('WS-FORK-01-AC02 fork button absent when owner forbids it', async ({ page }) => {
  await page.goto('/share/e2e-fork-disabled');
  await expect(page.getByRole('button', { name: /내 Workspace로 fork|fork workspace/i })).toHaveCount(0);
});
// Remaining AC: auth/no-link, snapshot copy, revoke race, fork independence.
