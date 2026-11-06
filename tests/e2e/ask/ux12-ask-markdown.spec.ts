// UX12-ASKMD — tables and the rest of Markdown in an AI answer (docs/screens/ux12-ask-markdown.md).
// The answer is the APP_ENV=test fake's synthetic MARKDOWN_ANSWER (marker E2E-ASK-MARKDOWN), which
// cites `[S1]` in a heading-free paragraph, a table cell, a list and a quote. Every syntax and
// partial input has a unit test in apps/web/test/ask-markdown.test.tsx.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import { expectNoHorizontalScroll } from '../fixtures/chapter-redistribution.ts';
import {
  ask,
  ASK_MARKERS,
  askUi,
  openAskPanel,
  PASSAGES,
  seedAskBook,
  waitDone,
} from '../fixtures/ask.ts';
import { NO_VISUAL_ARTIFACTS } from '../fixtures/sharing.ts';
import { expect, signInAs, test } from '../fixtures/test.ts';
import { homePath, homeUi, searchUi } from '../fixtures/workspace-ui.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({ storageState: { cookies: [], origins: [] }, ...NO_VISUAL_ARTIFACTS });

const QUESTION = `${PASSAGES.book}을 설명해 줘`;

async function openAskOnHome(page: Page, factory: WorkspaceFactory, label: string) {
  const owner = await factory.member(`${label}-${randomUUID().slice(0, 8)}`);
  const ws = await factory.create(owner);
  await seedAskBook(owner, ws.id);
  await signInAs(page, owner.user);
  await page.goto(homePath(ws.id));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
  return openAskPanel(page);
}

test(
  'UX12-ASKMD-AC01 a wide table keeps its header, alignment and footnote and scrolls alone at 375px',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const panel = await openAskOnHome(page, workspaceFactory, 'askmd-ac01');
    const answer = await ask(panel, `${ASK_MARKERS.markdown} ${QUESTION}`);
    await waitDone(answer);

    const table = answer.getByRole('table');
    await expect(table).toHaveCount(1);
    await expect(table.getByRole('columnheader')).toHaveCount(3);
    const align = (name: RegExp) =>
      table.getByRole('cell', { name }).evaluate((cell) => getComputedStyle(cell).textAlign);
    expect(await align(/^물의순환/)).toMatch(/left|start/);
    expect(await align(/^증발과응결/)).toBe('center');
    expect(await align(/^1234567890/)).toBe('right');

    const scroller = answer.getByRole('group', { name: /^(표|table)$/i });
    await expect(scroller).toHaveAttribute('tabindex', '0');
    const widths = await scroller.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(widths[0] as number).toBeGreaterThan(widths[1] as number);
    await expectNoHorizontalScroll(page, askUi.log(panel));
    await scroller.focus();
    await expect
      .poll(async () => {
        await page.keyboard.press('ArrowRight');
        return scroller.evaluate((el) => el.scrollLeft);
      })
      .toBeGreaterThan(0);

    await table.getByRole('button', { name: /^(출처|source) 1: /i }).click();
    await expect(searchUi.excerptPanel(page)).toContainText(PASSAGES.book);
  },
);

test(
  'UX12-ASKMD-AC02 the answer shows each Markdown element and leaves HTML, images and unsafe links as text',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const panel = await openAskOnHome(page, workspaceFactory, 'askmd-ac02');
    const answer = await ask(panel, `${ASK_MARKERS.markdown} ${QUESTION}`);
    await waitDone(answer);

    await expect(answer.getByRole('heading', { level: 3, name: '핵심 정리' })).toBeVisible();
    await expect(answer.getByRole('heading', { level: 4, name: '세부 단계' })).toBeVisible();
    await expect(answer.locator('strong', { hasText: '굵게' })).toBeVisible();
    await expect(answer.locator('em', { hasText: '기울임' })).toBeVisible();
    await expect(answer.locator('del', { hasText: '취소선' })).toBeVisible();
    await expect(answer.locator('code', { hasText: '인라인 코드' })).toBeVisible();
    await expect(answer.locator('pre code')).toContainText('print(');
    await expect(answer.getByRole('separator')).toBeVisible();

    const body = answer.locator('ul').first();
    await expect(body.locator('ul').getByText('중첩 항목')).toBeVisible();
    await expect(body.getByRole('checkbox')).toHaveCount(2);
    await expect(body.getByRole('checkbox').first()).toBeChecked();
    await expect(body.getByRole('checkbox').last()).not.toBeChecked();
    await expect(answer.locator('ol').first().locator('li')).toHaveCount(2);

    await expect(body.getByRole('button', { name: /^(출처|source) 1: /i })).toBeVisible();
    const quote = answer.locator('blockquote');
    await expect(quote.getByRole('button', { name: /^(출처|source) 1: /i })).toBeVisible();

    const link = answer.getByRole('link', { name: /참고 링크/ });
    await expect(link).toHaveAttribute('href', 'https://example.com/guide');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);

    await expect(answer).toContainText('<script>alert(1)</script>');
    await expect(answer).toContainText('![그림](https://example.com/a.png)');
    await expect(answer).toContainText('[위험한 링크](javascript:alert(1))');
    await expect(answer.getByRole('img')).toHaveCount(0);
    await expect(answer.getByRole('link')).toHaveCount(1);
  },
);

test(
  'UX12-ASKMD-AC03 half-written Markdown shows a table without raw markers while streaming',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    const panel = await openAskOnHome(page, workspaceFactory, 'askmd-ac03');
    const answer = await ask(panel, `${ASK_MARKERS.markdown} ${ASK_MARKERS.slow} ${QUESTION}`);

    await expect(answer.getByRole('table')).toBeVisible({ timeout: 30_000 });
    await expect(answer).toHaveAttribute('aria-busy', 'true');
    await expect(answer).not.toContainText('---');
    await expect(answer).not.toContainText('**');

    await waitDone(answer);
    await expect(answer.getByRole('table')).toHaveCount(1);
    await expect(
      answer.getByRole('table').getByRole('button', { name: /^(출처|source) 1: /i }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  },
);

test(
  'UX12-ASKMD-AC04 a Markdown answer has no accessibility violations in either theme',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const panel = await openAskOnHome(page, workspaceFactory, 'askmd-ac04');
    await waitDone(await ask(panel, `${ASK_MARKERS.markdown} ${QUESTION}`));
    await expectAccessible(page, 'UX12-ASKMD markdown answer');
  },
);
