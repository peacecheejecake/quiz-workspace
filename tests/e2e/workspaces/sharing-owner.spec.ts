import { expect, test } from '@playwright/test';

/** Pre-implementation RED: requires isolated owner/share fixture. */
test('WS-SHARE-01-AC01 owner sees sharing OFF and fork OFF by default', async ({ page }) => {
  await page.goto('/workspaces/e2e-owned-ws/settings/sharing');
  await expect(page.getByRole('heading', { name: /공유 설정|Sharing/i })).toBeVisible();
  await expect(page.getByRole('switch', { name: /fork 허용|allow fork/i })).not.toBeChecked();
  await expect(page.getByText(/읽기 전용|view.only/i)).toBeVisible();
});
test('WS-SHARE-01-AC02 creates a revocable view-only link', async ({ page }) => {
  await page.goto('/workspaces/e2e-owned-ws/settings/sharing');
  await page.getByRole('button', { name: /링크 생성|create link/i }).click();
  await expect(page.getByRole('button', { name: /링크 복사|copy link/i })).toBeVisible();
  await expect(page.getByText(/링크 철회|revoke link/i)).toBeVisible();
});
test('WS-SHARE-01-AC03 toggles fork policy only as owner', async ({ page }) => {
  await page.goto('/workspaces/e2e-owned-ws/settings/sharing');
  const allowFork = page.getByRole('switch', { name: /fork 허용|allow fork/i });
  await allowFork.check();
  await expect(allowFork).toBeChecked();
  await page.reload();
  await expect(allowFork).toBeChecked();
});
test('WS-SHARE-01-AC04 revokes active links', async ({ page }) => {
  await page.goto('/workspaces/e2e-owned-ws/settings/sharing');
  await page.getByRole('button', { name: /링크 철회|revoke link/i }).click();
  await page.getByRole('button', { name: /철회 확인|confirm revoke/i }).click();
  await expect(page.getByText(/철회됨|revoked/i)).toBeVisible();
});
// AC05: archived/deleted fixtures and backend authorization assertions required.
