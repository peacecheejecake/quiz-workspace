// UX12-MOCKFORM2 (docs/screens/ux12-mock-form-order.md): 범위 before 옵션, the name taken from the
// chosen chapters, the removed notes and the single help button of the variation types.
import type { Page } from '@playwright/test';
import { ALL, CH1, CH2, createMockExam, mockUi, waitForMockExam } from '../fixtures/mock-exams.ts';
import { rangePickerUi as picker } from '../fixtures/range-picker.ts';
import {
  createNumberedQuestions,
  createQuestion,
  expect,
  homePath,
  mcqInput,
  outlineNodeId,
  seedMembership,
  signInAs,
  test,
  uploadReadyBook,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

/** 1장 with two questions, 2장 with one. */
async function bookWithChapters(factory: E2EFixtures['workspaceFactory'], label: string) {
  const owner = await factory.member(label);
  const workspace = await factory.create(owner);
  const documentId = await uploadReadyBook(owner, workspace.id, 'book-ko');
  for (const [title, number] of [
    [CH1, 1],
    [CH1, 2],
    [CH2, 1],
  ] as const) {
    await createQuestion(owner, workspace.id, {
      ...mcqInput(`${label} ${title} ${number}번: 알맞은 것은?`, ['가', '나', '다', '라'], 0),
      chapter_id: await outlineNodeId(owner, documentId, title),
      question_number: number,
    });
  }
  return { owner, workspace };
}

async function openCreate(page: Page, workspaceId: string) {
  await page.goto(homePath(workspaceId, 'panel=mock-exams&mock=new'));
  const dialog = mockUi.dialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test(
  'UX12-MOCKFORM2-AC01 범위 comes first and the last step holds the action, its count and notice',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace } = await bookWithChapters(workspaceFactory, 'ux12-order-steps');
    await signInAs(page, owner.user);
    const dialog = await openCreate(page, workspace.id);

    const steps = mockUi.steps(dialog).getByRole('listitem');
    await expect(steps.first()).toContainText(/범위/);
    await expect(steps.first()).toHaveAttribute('aria-current', 'step');
    await expect(steps.last()).toContainText(/옵션/);

    await expect(picker.selectAll(dialog)).toBeVisible();
    await expect(mockUi.next(dialog)).toBeDisabled();
    await expect(mockUi.next(dialog)).toHaveAccessibleDescription(/출제 범위를 고르세요/);
    await expect(mockUi.variations(dialog)).toHaveCount(0);
    await expect(dialog.getByText(/문항을 만듭니다/)).toHaveCount(0);

    await picker.chapter(dialog, CH1).check();
    await expect(picker.selected(dialog, 2)).toBeVisible();
    await mockUi.next(dialog).click();

    await expect(dialog.getByRole('heading', { name: /^(옵션|options)$/i })).toBeFocused();
    await expect(dialog.getByRole('button', { name: /^(시작|start)$/i })).toBeVisible();
    await mockUi.variation(dialog, 'PARAPHRASE').check();
    await expect(mockUi.make(dialog)).toBeVisible();
    await expect(dialog.getByText(/선택 2문제 중 2문항을 만듭니다/)).toBeVisible();
    await expect(dialog.getByText(/AI 서비스로 전송됩니다/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^(이전|back|previous)$/i })).toHaveCount(0);

    await mockUi.backToRange(dialog).click();
    await expect(dialog.getByRole('heading', { name: /^(범위|range)$/i })).toBeFocused();
    await expect(picker.chapter(dialog, CH1)).toBeChecked();
    await mockUi.next(dialog).click();
    await expect(mockUi.variation(dialog, 'PARAPHRASE')).toBeChecked();
  },
);

test(
  'UX12-MOCKFORM2-AC02 the name follows the chosen chapters until it is edited',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace } = await bookWithChapters(workspaceFactory, 'ux12-order-name');
    await signInAs(page, owner.user);
    const dialog = await openCreate(page, workspace.id);

    // Part of a chapter names that chapter.
    await picker.expand(dialog, CH1).click();
    await picker.question(dialog, 1, 1).check();
    await mockUi.next(dialog).click();
    await expect(mockUi.title(dialog)).toHaveCount(0);
    await mockUi.variation(dialog, 'OPTION_SHUFFLE').check();
    await expect(mockUi.title(dialog)).toHaveValue(CH1);

    // Both chapters, with one question left out: selecting everything would be 전체 선택.
    await mockUi.backToRange(dialog).click();
    await picker.chapter(dialog, CH2).check();
    await mockUi.next(dialog).click();
    await expect(mockUi.title(dialog)).toHaveValue(`${CH1} 외 1개`);

    await mockUi.backToRange(dialog).click();
    await picker.selectAll(dialog).check();
    await mockUi.next(dialog).click();
    await expect(mockUi.title(dialog)).toHaveValue('모의고사 1');

    // A typed name survives a changed range.
    await mockUi.title(dialog).fill('내 이름');
    await mockUi.backToRange(dialog).click();
    await picker.chapter(dialog, CH2).uncheck();
    await mockUi.next(dialog).click();
    await expect(mockUi.title(dialog)).toHaveValue('내 이름');
  },
);

test('UX12-MOCKFORM2-AC03 the three notes are gone', async ({ page, workspaceFactory }) => {
  const owner = await workspaceFactory.member('ux12-order-notes');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'notes', 2);
  await signInAs(page, owner.user);
  const dialog = await openCreate(page, workspace.id);
  await picker.selectAll(dialog).check();
  await mockUi.next(dialog).click();

  await mockUi.variation(dialog, 'OPTION_SHUFFLE').check();
  await expect(dialog.getByRole('checkbox', { name: /선택 범위의 모든 문항/ })).toBeVisible();
  await expect(dialog.getByText(/선택 범위까지 풀 수 있습니다/)).toHaveCount(0);
  await expect(dialog.getByText(/난이도는 원본과 같습니다/)).toHaveCount(0);
  await expect(dialog.getByText(/선택한 범위의 문제를 모두 사용합니다/)).toHaveCount(0);
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('UX12-MOCKFORM2-AC04 one help button opens every description by tap and by keyboard', async ({
    page,
    workspaceFactory,
  }) => {
    const owner = await workspaceFactory.member('ux12-order-help');
    const workspace = await workspaceFactory.create(owner);
    await createNumberedQuestions(owner, workspace.id, 'help', 2);
    await signInAs(page, owner.user);
    const dialog = await openCreate(page, workspace.id);
    await picker.selectAll(dialog).check();
    await mockUi.next(dialog).click();

    await expect(mockUi.variationGroup(dialog)).toBeVisible();
    await expect(dialog.getByRole('button', { name: / 설명$/ })).toHaveCount(1);
    const help = mockUi.variationHelp(dialog);
    const panel = mockUi.variationHelpPanel(page);

    await help.tap();
    await expect(panel).toBeVisible();
    for (const text of [
      /보기 순서만 섞습니다/,
      /문제 문구를 바꿉니다/,
      /'옳은 것'을 묻도록 뒤집습니다/,
      /비슷한 개념을 묻는 문제를 만듭니다/,
    ]) {
      await expect(panel).toContainText(text);
    }
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(help).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
});

test('UX12-MOCKFORM2-AC04 without edit rights the reason stays in plain text', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-order-reason');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'reason', 2);
  const viewer = await workspaceFactory.member('ux12-order-reason-viewer');
  seedMembership(workspace.id, viewer.user.id, 'viewer');
  await signInAs(page, viewer.user);
  const dialog = await openCreate(page, workspace.id);
  await picker.selectAll(dialog).check();
  await mockUi.next(dialog).click();

  for (const box of await mockUi.variations(dialog).all()) await expect(box).toBeDisabled();
  await expect(dialog.getByText(/변형 출제에는 편집 권한이 필요합니다/)).toBeVisible();
});

test('UX12-MOCKFORM2-AC05 설정 바꾸기 opens on the saved range and keeps the saved name', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-order-settings');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'settings', 3);
  const exam = await createMockExam(
    owner,
    workspace.id,
    '저장된 이름',
    { variation_types: ['OPTION_SHUFFLE'], question_count: 2 },
    ALL,
  );
  await waitForMockExam(owner, exam.id);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, `panel=mock-exams&mock=${exam.id}`));

  const dialog = mockUi.dialog(page);
  await mockUi.chooseDetailAction(dialog, 'settings');
  await expect(picker.selectAll(dialog)).toBeChecked();
  await expect(mockUi.next(dialog)).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /^(취소|cancel)$/i })).toBeVisible();
  await mockUi.next(dialog).click();

  await expect(mockUi.title(dialog)).toHaveValue('저장된 이름');
  await expect(mockUi.questionCount(dialog)).toHaveValue('2');
  await expect(mockUi.variation(dialog, 'OPTION_SHUFFLE')).toBeChecked();
  await expect(mockUi.remake(dialog)).toBeEnabled();
});

test('UX12-MOCKFORM2-AC06 options are checked at the last action and 문항 수 starts at the selection', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-order-check');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'check', 3);
  await signInAs(page, owner.user);
  const dialog = await openCreate(page, workspace.id);
  await picker.selectAll(dialog).check();
  await mockUi.next(dialog).click();

  await expect(mockUi.questionCount(dialog)).toHaveValue('3');
  await mockUi.variation(dialog, 'OPTION_SHUFFLE').check();
  await mockUi.title(dialog).fill('');
  await mockUi.make(dialog).click();
  await expect(dialog.getByText(/이름을 입력하세요/)).toBeVisible();
  await expect(mockUi.title(dialog)).toBeFocused();

  await mockUi.title(dialog).fill('문항 수 점검');
  await mockUi.questionCount(dialog).fill('4');
  await expect(mockUi.make(dialog)).toBeDisabled();
  await expect(dialog.getByText(/선택한 범위보다 문항 수가 많습니다/)).toBeVisible();
});
