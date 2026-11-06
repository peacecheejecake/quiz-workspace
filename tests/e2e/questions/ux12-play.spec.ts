import { test, expect, createNumberedQuestions, homePath, signInAs } from '../fixtures/test.ts';
import { mockUi } from '../fixtures/mock-exams.ts';
import { rangePickerUi } from '../fixtures/range-picker.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test('UX12-PLAY-AC01 asks for a name only when a variation makes a mock exam', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux12-play-name');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'ux12-play', 2);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
  const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });

  // 변형 없음 = a bank run: nothing stores a name.
  await expect(mockUi.variations(dialog).first()).toBeVisible();
  await expect(mockUi.title(dialog)).toHaveCount(0);

  // A variation brings it back, required.
  await mockUi.variation(dialog, 'PARAPHRASE').check();
  await expect(mockUi.title(dialog)).toBeVisible();
  await mockUi.title(dialog).fill('');
  await mockUi.next(dialog).click();
  await expect(dialog.getByText(/이름을 입력하세요/)).toBeVisible();
  await expect(mockUi.title(dialog)).toBeFocused();

  // Back to a bank run: the empty name no longer blocks 다음.
  await mockUi.variation(dialog, 'PARAPHRASE').uncheck();
  await expect(mockUi.title(dialog)).toHaveCount(0);
  await expect(dialog.getByText(/이름을 입력하세요/)).toHaveCount(0);
  await mockUi.next(dialog).click();
  await expect(rangePickerUi.selectAll(dialog)).toBeVisible();
});
