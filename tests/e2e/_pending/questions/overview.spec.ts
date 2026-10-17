import { test, expect } from '@playwright/test';

// Seed: e2e-ws chapter 3 question 12, status correct, not favorite.
test('QOV-01-AC03 favorite changes a square to a rounded star without changing color', async ({ page }) => {
  await page.goto('/workspaces/e2e-ws/questions');
  const dot = page.getByRole('button', { name: /3장 12번 문제/ });
  const marker = dot.getByTestId('question-marker');
  await expect(marker).toHaveAttribute('data-shape', 'square');
  const initialColor = await marker.evaluate(element => getComputedStyle(element).color);
  await dot.click();
  await page.getByRole('button', { name: /즐겨찾기 추가/ }).click();
  await page.getByRole('button', { name: /패널 닫기/ }).click();
  await expect(marker).toHaveAttribute('data-shape', 'star');
  await expect(marker).toHaveCSS('color', initialColor);
  await expect(dot).toHaveAttribute('aria-label', /즐겨찾기/);
});

test('QOV-01-AC04 marker enlarges on hover without grid layout shift', async ({ page }) => {
  await page.goto('/workspaces/e2e-ws/questions');
  const dot = page.getByRole('button', { name: /3장 12번 문제/ });
  const marker = dot.getByTestId('question-marker');
  const before = await dot.boundingBox();
  await dot.hover();
  await expect.poll(() => marker.evaluate(el => getComputedStyle(el).transform)).not.toBe('none');
  const after = await dot.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after!.x).toBeCloseTo(before!.x, 2);
  expect(after!.y).toBeCloseTo(before!.y, 2);
});

test('QOV-01-AC02 hover must not mark a problem viewed', async ({ page }) => {
  await page.goto('/workspaces/e2e-ws/questions');
  const dot = page.getByRole('button', { name: /3장 13번 문제/ });
  await dot.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(dot).toHaveAttribute('data-status', 'unseen');
});
