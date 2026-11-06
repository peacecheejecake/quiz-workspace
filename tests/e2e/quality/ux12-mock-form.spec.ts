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
  openStatusFilters,
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

    await picker.selectAll(dialog).check();
    await picker.expand(dialog, '챕터 없음').click();
    await expect(picker.questions(dialog)).toHaveCount(40);

    const steps = mockUi.steps(dialog);
    const stepsBefore = await steps.boundingBox();
    await scrollToEnd(dialog);
    await expect(picker.questions(dialog).last()).toBeInViewport();
    await expectAtPanelBottom(dialog, next);
    await expect(steps).toBeInViewport({ ratio: 1 });
    expect(await steps.boundingBox()).toEqual(stepsBefore);
    await expectNoSidewaysScroll(dialog);

    await next.click();
    const start = dialog.getByRole('button', { name: /^(시작|start)$/i });
    await expect(start).toBeVisible();
    await expectAtPanelBottom(dialog, start);
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
  const home = await swatches(await openStatusFilters(page));
  expect(home).toHaveLength(5);

  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
  const dialog = createDialog(page);
  await expect(picker.selectAll(dialog)).toBeVisible();

  const group = picker.filters(dialog);
  await expect(group).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^(상태 필터|status filter)$/i })).toHaveCount(0);
  expect((await swatches(group)).sort()).toEqual([...home].sort());
  await expect(group.getByRole('button', { name: /^틀린 문제$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // UX12-MOCKFORM3: the selected count sits at the end of the 전체 선택 row, in its font size.
  await picker.selectAll(dialog).check();
  const selectAll = await picker.selectAll(dialog).locator('xpath=ancestor::div[1]').boundingBox();
  const count = picker.selected(dialog, 2);
  const countBox = await count.boundingBox();
  if (!selectAll || !countBox) throw new Error('The 전체 선택 row must be visible');
  const labelSize = await dialog
    .getByText(/^전체 선택$/)
    .evaluate((el) => getComputedStyle(el).fontSize);
  await expect(count).toHaveCSS('font-size', labelSize);
  expect(
    Math.abs(countBox.y + countBox.height / 2 - (selectAll.y + selectAll.height / 2)),
  ).toBeLessThan(12);
  const dialogBox = await dialog.boundingBox();
  if (!dialogBox) throw new Error('The dialog must be visible');
  expect(countBox.x).toBeGreaterThan(dialogBox.x + dialogBox.width / 2);
});

test('UX12-MOCKFORM-AC04 유형 is a checkbox group: every type checked, none shows no question', async ({
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
  await expect(picker.selectAll(dialog)).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: /^(유형|type)$/i })).toHaveCount(0);
  // The group is named by its aria-label only: no visible legend, no hint line.
  await expect(dialog.getByText(/^유형$/)).toHaveCount(0);
  await expect(dialog.getByText(/모든 유형을 보여 줍니다/)).toHaveCount(0);
  await expect(picker.resetFilters(dialog)).toHaveCount(0);
  await picker.selectAll(dialog).check();
  await expect(picker.selected(dialog, 4)).toBeVisible();

  const types = picker.typeFilters(dialog);
  const box = (name: RegExp) => types.getByRole('checkbox', { name });
  const mcq = box(/^(객관식|multiple choice)$/i);
  const essay = box(/^(서술형|essay)$/i);
  const short = box(/^(단답형|short answer)$/i);
  await expect(types.getByRole('checkbox')).toHaveCount(3);
  for (const checkbox of [mcq, essay, short]) await expect(checkbox).toBeChecked();

  await essay.uncheck();
  // A filter drops what it hides from the selection; no sibling gets disabled.
  await expect(picker.selected(dialog, 3)).toBeVisible();
  await expect(mcq).toBeEnabled();
  await expect(short).toBeEnabled();
  await expect(picker.resetFilters(dialog)).toBeVisible();
  await essay.check();
  await picker.expand(dialog, '챕터 없음').click();
  await expect(picker.questions(dialog)).toHaveCount(4);

  // None checked shows no question, not every one, and `다음` says why it is off.
  await mcq.uncheck();
  await short.uncheck();
  await essay.uncheck();
  await expect(dialog.getByText(/조건에 맞는 문제가 없습니다/)).toBeVisible();
  await expect(picker.questions(dialog)).toHaveCount(0);
  await expect(mockUi.next(dialog)).toBeDisabled();
  await expect(mockUi.next(dialog)).toHaveAccessibleDescription(/출제 범위를 고르세요/);

  await picker.resetFilters(dialog).first().click();
  await expect(mcq).toBeChecked();
  await expect(essay).toBeChecked();
  await expect(short).toBeChecked();
  // The chapter group stays expanded.
  await expect(picker.questions(dialog)).toHaveCount(4);
});

test('UX12-MOCKFORM-AC04 a type without questions is disabled and unchecked', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-mockform-types-missing');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'only-mcq', 2);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));

  const dialog = createDialog(page);
  await expect(picker.selectAll(dialog)).toBeVisible();
  const types = picker.typeFilters(dialog);
  const mcq = types.getByRole('checkbox', { name: /^(객관식|multiple choice)$/i });
  await expect(mcq).toBeChecked();
  for (const name of [/^(서술형|essay)$/i, /^(단답형|short answer)$/i]) {
    const other = types.getByRole('checkbox', { name });
    await expect(other).toBeDisabled();
    await expect(other).not.toBeChecked();
  }
  // Without a missing type counted as unchecked, nothing is filtered.
  await expect(picker.resetFilters(dialog)).toHaveCount(0);
  await picker.selectAll(dialog).check();
  await expect(picker.selected(dialog, 2)).toBeVisible();
});

test('UX12-MOCKFORM-AC05 the done step goes back with its values kept, by mouse and keyboard', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-mockform-back');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'back', 3);
  await createQuestion(owner, workspace.id, {
    question_type: 'ESSAY',
    stem: 'back 서술 1',
    question_number: 4,
  });
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));

  const dialog = createDialog(page);
  await expect(picker.selectAll(dialog)).toBeVisible();
  await expect(mockUi.backToRange(dialog)).toHaveCount(0);
  await picker.selectAll(dialog).check();
  const essay = picker.typeFilters(dialog).getByRole('checkbox', { name: /^(서술형|essay)$/i });
  await essay.uncheck();
  await expect(picker.selected(dialog, 3)).toBeVisible();
  await mockUi.next(dialog).click();

  await expect(dialog.getByRole('button', { name: /^(이전|back|previous)$/i })).toHaveCount(0);
  await mockUi.variation(dialog, 'OPTION_SHUFFLE').check();
  await mockUi.title(dialog).fill('돌아가기 점검');
  await mockUi.questionCount(dialog).fill('2');

  const back = mockUi.backToRange(dialog);
  const box = await back.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
  await back.click();
  await expect(picker.selected(dialog, 3)).toBeVisible();
  await expect(essay).not.toBeChecked();

  await mockUi.next(dialog).click();
  await expect(mockUi.title(dialog)).toHaveValue('돌아가기 점검');
  await expect(mockUi.questionCount(dialog)).toHaveValue('2');
  await expect(mockUi.variation(dialog, 'OPTION_SHUFFLE')).toBeChecked();

  await back.focus();
  await page.keyboard.press('Enter');
  await expect(picker.selected(dialog, 3)).toBeVisible();
});

test('UX12-MOCKFORM-AC05 the header back button steps back, and the dim closes at once on the options step', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-mockform-header');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'header', 3);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));

  const dialog = createDialog(page);
  await expect(picker.selectAll(dialog)).toBeVisible();
  // One back button, in the header before the title: 모의고사 목록 on the first step.
  const header = dialog.getByRole('button', { name: /^(모의고사 목록|mock exam list)$/i });
  await expect(header).toBeVisible();
  await expect(dialog.getByRole('link', { name: /모의고사 목록|mock exam list/i })).toHaveCount(0);
  const title = await dialog
    .getByRole('heading', { name: /^(모의고사|mock exams?)$/i })
    .boundingBox();
  const button = await header.boundingBox();
  if (!title || !button) throw new Error('The header and its back button must be visible');
  expect(button.x + button.width).toBeLessThanOrEqual(title.x + 1);

  // Step 2: 이전 단계 goes back to the range with the range and options kept; focus on 범위.
  await picker.selectAll(dialog).check();
  await mockUi.next(dialog).click();
  await mockUi.variation(dialog, 'OPTION_SHUFFLE').check();
  await mockUi.title(dialog).fill('헤더 점검');
  await dialog.getByRole('button', { name: /^(이전 단계|previous step)$/i }).click();
  await expect(dialog.getByRole('heading', { name: /^(범위|range)$/i })).toBeFocused();
  await expect(picker.selected(dialog, 3)).toBeVisible();
  await mockUi.next(dialog).click();
  await expect(mockUi.title(dialog)).toHaveValue('헤더 점검');

  // On the options step the dim closes the dialog at once, edited options or not.
  const box = await dialog.boundingBox();
  if (!box) throw new Error('The dialog must be visible');
  await page.mouse.click(Math.max(2, box.x / 2), box.y + box.height / 2);
  await expect(dialog).toBeHidden();

  // On the range step a touched range keeps it open.
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
  await picker.selectAll(dialog).check();
  await page.mouse.click(Math.max(2, box.x / 2), box.y + box.height / 2);
  await expect(dialog).toBeVisible();
  // The first step's back button returns to the list.
  await dialog.getByRole('button', { name: /^(모의고사 목록|mock exam list)$/i }).click();
  await expect(mockUi.count(dialog, 0)).toBeVisible();
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
  await mockUi.chooseDetailAction(dialog, 'settings');
  await expect(mockUi.steps(dialog)).toBeVisible();
  await expect(picker.selectAll(dialog)).toBeVisible();
  await expect(
    picker.typeFilters(dialog).getByRole('checkbox', { name: /^(객관식|multiple choice)$/i }),
  ).toBeChecked();
  await mockUi.next(dialog).click();
  await expect(mockUi.remake(dialog)).toBeInViewport({ ratio: 1 });
  await expect(mockUi.variation(dialog, 'OPTION_SHUFFLE')).toBeChecked();
});
