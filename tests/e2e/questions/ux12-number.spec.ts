// UX12-NUMBER: the textbook's printed number comes first; no chapter prefix, no position fallback
// (docs/screens/ux12-number.md). The dot's accessible name keeps the chapter on purpose.
import type { Locator, Page } from '@playwright/test';
import { CH1, CH2, openRangePicker, runUi, seedRangeWorkspace } from '../fixtures/practice-runs.ts';
import { rangePickerUi } from '../fixtures/range-picker.ts';
import {
  createQuestion,
  expect,
  mcqInput,
  overviewPath,
  overviewUi,
  signInAs,
  test,
  type Member,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

async function openHeatmap(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

const dot = (page: Page, name: RegExp): Locator =>
  overviewUi.heatmap(page).getByRole('button', { name });

test(
  'UX12-NUMBER-AC01 the preview and panel show the number alone and the dot name keeps the chapter',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-number-ac01', { studyState: false });
    await openHeatmap(page, s.owner, s.workspaceId);

    const dots = overviewUi.dots(page);
    await expect(dots).toHaveCount(5);
    await expect(dots.nth(0)).toHaveAccessibleName(/^1장 1번 문제, /);
    await expect(dots.nth(3)).toHaveAccessibleName(/^2장 1번 문제, /);

    const second = dot(page, /^2장 1번 문제, /);
    await second.hover();
    const preview = overviewUi.tooltip(page);
    await expect(preview).toContainText(/객관식\s*·\s*1번 문제/);
    await expect(preview).toContainText(CH2);

    await second.click();
    const panel = page.getByRole('dialog', { name: /^1번 문제$/ });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(CH2);
  },
);

test(
  'UX12-NUMBER-AC02 range rows and the solving title show the number alone inside their chapter',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-number-ac02', { studyState: false });
    await openHeatmap(page, s.owner, s.workspaceId);

    const panel = await openRangePicker(page);
    await runUi.expand(panel, CH1).click();
    await runUi.expand(panel, CH2).click();
    for (const title of [CH1, CH2]) {
      await expect(
        rangePickerUi.group(panel, title).getByRole('checkbox', { name: /^1번 · / }),
      ).toBeVisible();
    }

    await runUi.selectAll(panel).check();
    await runUi.start(panel).click();
    await expect(panel.getByRole('heading', { name: /^1번$/ })).toBeVisible();
  },
);

test(
  'UX12-NUMBER-AC03 an unnumbered question reads 번호 없음 and never a position',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = 'ux12-number-ac03';
    const owner = await workspaceFactory.member(label);
    const ws = await workspaceFactory.create(owner);
    const texts = ['가', '나', '다', '라'].map((x) => `${label} 보기 ${x}`);
    await createQuestion(owner, ws.id, mcqInput(`${label} 문제: 알맞은 것은?`, texts, 0));
    await openHeatmap(page, owner, ws.id);

    const marker = dot(page, /^챕터 없음 번호 없음, /);
    await marker.hover();
    await expect(overviewUi.tooltip(page)).toContainText(/객관식\s*·\s*번호 없음/);
    await marker.click();
    const dialog = page.getByRole('dialog', { name: /^번호 없음$/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /패널 닫기|^닫기$|^close/i }).click();
    await expect(dialog).toHaveCount(0);

    const panel = await openRangePicker(page);
    await runUi.expand(panel, '챕터 없음').click();
    await expect(panel.getByRole('checkbox', { name: /^번호 없음 · / })).toBeVisible();
    await runUi.selectAll(panel).check();
    await runUi.start(panel).click();
    await expect(panel.getByRole('heading', { name: /^번호 없음$/ })).toBeVisible();

    await runUi.option(panel, texts[0] ?? '').check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toBeVisible();
    await runUi.showResults(panel).click();
    await expect(runUi.resultRows(panel).first()).toContainText('번호 없음');
  },
);
