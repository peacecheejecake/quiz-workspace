// UX12-MOCKFORM (docs/screens/ux12-mock-form.md): the create and 설정 바꾸기 screens: steps and
// actions in the panel's fixed areas, no sideways scroll, always-on filters with the home's status
// swatches, multi-select 유형, going back through the step list.
import type { Locator, Page } from '@playwright/test';
import { ALL, createMockExam, mockUi, waitForMockExam } from '../fixtures/mock-exams.ts';
import { rangePickerUi as picker } from '../fixtures/range-picker.ts';
import { createQuestion } from '../fixtures/questions.ts';
import {
  createNumberedQuestions,
  expect,
  homePath,
  overviewPath,
  signInAs,
  test,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 375, height: 667 },
];

function createDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: /^(모의고사|mock exams?)$/i });
}

/** The panel's scrolling body: the parent of the view's own root. */
function scroller(dialog: Locator): Locator {
  return dialog.locator('[data-screen-id]').locator('xpath=..');
}

async function expectNoSidewaysScroll(dialog: Locator): Promise<void> {
  const box = await scroller(dialog).evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollLeft: el.scrollLeft,
  }));
  expect(box.scrollWidth, 'no content is wider than the body').toBeLessThanOrEqual(box.clientWidth);
  expect(box.scrollLeft).toBe(0);
}

async function scrollToEnd(dialog: Locator): Promise<void> {
  await scroller(dialog).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

async function expectAtPanelBottom(dialog: Locator, action: Locator): Promise<void> {
  await expect(action).toBeInViewport({ ratio: 1 });
  const panel = await dialog.boundingBox();
  const button = await action.boundingBox();
  if (!panel || !button) throw new Error('The panel and its action must be visible');
  const gap = panel.y + panel.height - (button.y + button.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(32);
}

test('UX12-MOCKFORM-AC01 the screen is titled 모의고사 and shows a step list, not a progress bar', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-mockform-steps');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'steps', 1);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));

  const dialog = createDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /문제 풀기/ })).toHaveCount(0);
  const steps = mockUi.steps(dialog);
  await expect(steps).toBeVisible();
  await expect(steps.getByRole('listitem').first()).toHaveAttribute('aria-current', 'step');
  await expect(dialog.getByRole('progressbar')).toHaveCount(0);

  const back = await mockUi.backToList(dialog).boundingBox();
  const list = await steps.boundingBox();
  if (!back || !list) throw new Error('BackLink and steps must be visible');
  expect(back.y + back.height).toBeLessThanOrEqual(list.y);
});

for (const viewport of VIEWPORTS) {
  test(`UX12-MOCKFORM-AC02 steps and actions hold and nothing scrolls sideways at ${viewport.width}px`, async ({
    page,
    workspaceFactory,
  }) => {
    const owner = await workspaceFactory.member(`ux12-mockform-layout-${viewport.width}`);
    const workspace = await workspaceFactory.create(owner);
    await createNumberedQuestions(owner, workspace.id, 'layout', 40);
    await signInAs(page, owner.user);
    await page.setViewportSize(viewport);
    await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));

    const dialog = createDialog(page);
    const next = mockUi.next(dialog);
    await expect(next).toBeVisible();
    await expectNoSidewaysScroll(dialog);
    await expectAtPanelBottom(dialog, next);

    await next.click();
    await picker.selectAll(dialog).check();
    await picker.expand(dialog, '챕터 없음').click();
    await expect(picker.questions(dialog)).toHaveCount(40);

    const start = dialog.getByRole('button', { name: /^(시작|start)$/i });
    const steps = mockUi.steps(dialog);
    const stepsBefore = await steps.boundingBox();
    await scrollToEnd(dialog);
    await expect(picker.questions(dialog).last()).toBeInViewport();
    await expectAtPanelBottom(dialog, start);
    await expect(steps).toBeInViewport({ ratio: 1 });
    expect(await steps.boundingBox()).toEqual(stepsBefore);
    await expectNoSidewaysScroll(dialog);
  });
}

test('UX12-MOCKFORM-AC03 filters are always shown with the home swatches and text', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-mockform-chips');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'chips', 2);
  await signInAs(page, owner.user);

  const swatches = (group: Locator) =>
    group
      .locator('span[data-status]')
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.getAttribute('data-status'),
          getComputedStyle(node).backgroundColor,
        ]),
      );

  await page.goto(overviewPath(workspace.id));
  const home = await swatches(page.getByRole('group', { name: /^(상태 필터|status filter)$/i }));
  expect(home).toHaveLength(5);

  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
  const dialog = createDialog(page);
  await mockUi.next(dialog).click();
  await expect(picker.selectAll(dialog)).toBeVisible();

  const group = picker.filters(dialog);
  await expect(group).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^(상태 필터|status filter)$/i })).toHaveCount(0);
  expect((await swatches(group)).sort()).toEqual([...home].sort());
  await expect(group.getByRole('button', { name: /^틀린 문제$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('UX12-MOCKFORM-AC04 유형 is a multi-select checkbox group and none means every type', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-mockform-types');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'types', 2);
  await createQuestion(owner, workspace.id, {
    question_type: 'ESSAY',
    stem: 'types 서술 1',
    question_number: 3,
  });
  await createQuestion(owner, workspace.id, {
    question_type: 'SHORT_ANSWER',
    stem: 'types 단답 1',
    question_number: 4,
    accepted_answers: ['답'],
  });
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));

  const dialog = createDialog(page);
  await mockUi.next(dialog).click();
  await expect(picker.selectAll(dialog)).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: /^(유형|type)$/i })).toHaveCount(0);
  await picker.selectAll(dialog).check();
  await expect(picker.selected(dialog, 4)).toBeVisible();

  const types = picker.typeFilters(dialog);
  await expect(types.getByRole('checkbox')).toHaveCount(3);
  await types.getByRole('checkbox', { name: /^(객관식|multiple choice)$/i }).check();
  await types.getByRole('checkbox', { name: /^(서술형|essay)$/i }).check();
  await picker.expand(dialog, '챕터 없음').click();
  await expect(picker.questions(dialog)).toHaveCount(3);
  // A filter drops what it hides from the selection; widening it does not bring that back.
  await expect(picker.selected(dialog, 2)).toBeVisible();

  await picker.resetFilters(dialog).click();
  await expect(picker.questions(dialog)).toHaveCount(4);
  await expect(types.getByRole('checkbox', { name: /^(서술형|essay)$/i })).not.toBeChecked();
});

test('UX12-MOCKFORM-AC05 the done step goes back with its values kept, by mouse and keyboard', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-mockform-back');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'back', 3);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));

  const dialog = createDialog(page);
  await mockUi.variation(dialog, 'OPTION_SHUFFLE').check();
  await mockUi.title(dialog).fill('돌아가기 점검');
  await mockUi.questionCount(dialog).fill('2');
  await expect(mockUi.backToOptions(dialog)).toHaveCount(0);
  await mockUi.next(dialog).click();

  await expect(picker.selectAll(dialog)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^(이전|back|previous)$/i })).toHaveCount(0);
  await picker.selectAll(dialog).check();
  const mcq = picker
    .typeFilters(dialog)
    .getByRole('checkbox', { name: /^(객관식|multiple choice)$/i });
  await mcq.check();
  await expect(picker.selected(dialog, 3)).toBeVisible();

  const back = mockUi.backToOptions(dialog);
  const box = await back.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
  await back.click();
  await expect(mockUi.title(dialog)).toHaveValue('돌아가기 점검');
  await expect(mockUi.questionCount(dialog)).toHaveValue('2');
  await expect(mockUi.variation(dialog, 'OPTION_SHUFFLE')).toBeChecked();

  await mockUi.next(dialog).click();
  await expect(picker.selected(dialog, 3)).toBeVisible();
  await expect(mcq).toBeChecked();

  await back.focus();
  await page.keyboard.press('Enter');
  await expect(mockUi.title(dialog)).toHaveValue('돌아가기 점검');
});

test('UX12-MOCKFORM-AC06 설정 바꾸기 shares the screen and restores the saved types', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-mockform-settings');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'settings', 3);
  const exam = await createMockExam(
    owner,
    workspace.id,
    '유형 저장',
    { variation_types: ['OPTION_SHUFFLE'], question_count: 2 },
    { ...ALL, filters: { types: ['MCQ'] } },
  );
  await waitForMockExam(owner, exam.id);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, `panel=mock-exams&mock=${exam.id}`));

  const dialog = createDialog(page);
  await mockUi.changeSettings(dialog).click();
  await expect(mockUi.steps(dialog)).toBeVisible();
  await mockUi.next(dialog).click();
  await expect(picker.selectAll(dialog)).toBeVisible();
  await expect(
    picker.typeFilters(dialog).getByRole('checkbox', { name: /^(객관식|multiple choice)$/i }),
  ).toBeChecked();
  await expect(mockUi.remake(dialog)).toBeInViewport({ ratio: 1 });
  await mockUi.backToOptions(dialog).click();
  await expect(mockUi.variation(dialog, 'OPTION_SHUFFLE')).toBeChecked();
});
