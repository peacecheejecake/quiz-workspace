import { test, expect } from '@playwright/test';

test('WS-01-AC02 creates a workspace for the signed-in owner', async ({ page }) => {
  await page.goto('/workspaces');
  await page.getByRole('button', { name: /Workspace 만들기|Create workspace/i }).click();
  const name = `E2E Create ${test.info().parallelIndex}-${Date.now()}`;
  await page.getByRole('textbox', { name: /Workspace 이름|Workspace name/i }).fill(name);
  await page.getByRole('button', { name: /생성|Create/i }).last().click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  // Fixture teardown must remove this workspace.
});
