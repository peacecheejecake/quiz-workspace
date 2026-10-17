import { expect, test } from '@playwright/test';

/** E2E_SHARE_URL must be an isolated seeded test link. */
const shareUrl = process.env.E2E_SHARE_URL ?? '/share/e2e-public-share#k=e2e-secret';
test('WS-VIEW-01-AC01 guest can open a share without login', async ({ page }) => {
  await page.goto(shareUrl);
  await expect(page.getByText(/읽기 전용|view.only/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /공유 Workspace|shared workspace/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /문제 수정|edit question/i })).toHaveCount(0);
});
test('WS-VIEW-01-AC03 guest cannot save learning state', async ({ page }) => {
  await page.goto(shareUrl);
  await expect(page.getByRole('button', { name: /즐겨찾기|favorite/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /답안 제출|submit answer/i })).toHaveCount(0);
});
test('WS-VIEW-01-AC05 removes link secret from URL after exchange', async ({ page }) => {
  await page.goto(shareUrl);
  await expect(page.getByText(/읽기 전용|view.only/i)).toBeVisible();
  await expect(page).not.toHaveURL(/#k=/);
});
// AC02/04/06: add cross-workspace, published-only, revoked/expired and Fork controls fixtures.
