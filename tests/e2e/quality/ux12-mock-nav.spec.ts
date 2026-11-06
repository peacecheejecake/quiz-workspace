// UX12-MOCKNAV (docs/screens/ux12-mock-nav.md): the home's 모의고사 opens the 모의고사 list, the detail
// keeps only 풀기 as a button with the rest under 더보기, and 문제 풀기 is called 모의고사.
import type { Locator, Page } from '@playwright/test';
import {
  createNumberedQuestions,
  expect,
  homePath,
  main,
  seedMembership,
  signInAs,
  test,
  type E2EFixtures,
} from '../fixtures/test.ts';
import { createMockExam, mockExamsPath, mockUi, waitForMockExam } from '../fixtures/mock-exams.ts';
import { openRangePicker, runUi } from '../fixtures/practice-runs.ts';

test.use({ storageState: { cookies: [], origins: [] } });

type Factory = E2EFixtures['workspaceFactory'];

const homePlay = (page: Page) => main(page).getByRole('button', { name: /^모의고사$/ });

async function seedExam(workspaceFactory: Factory, label: string) {
  const owner = await workspaceFactory.member(label);
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, label, 2);
  const exam = await createMockExam(owner, workspace.id, '상세 메뉴', {
    variation_types: ['OPTION_SHUFFLE'],
    question_count: 2,
  });
  await waitForMockExam(owner, exam.id);
  return { owner, workspace, exam };
}

/** The actions that moved under 더보기, were they still buttons. */
const movedButtons = (dialog: Locator) =>
  dialog.getByRole('button', {
    name: /^(설정 바꾸기|다시 만들기|이름 바꾸기|삭제|change settings|regenerate|rename|delete)$/i,
  });

test(
  'UX12-MOCKNAV-AC01 the home 모의고사 opens the list, 추가 opens 만들기 and closing returns focus',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace } = await seedExam(workspaceFactory, 'ux12-mocknav-ac01');
    await signInAs(page, owner.user);
    await page.goto(homePath(workspace.id));

    await homePlay(page).click();
    const dialog = mockUi.dialog(page);
    await expect(mockUi.row(dialog, '상세 메뉴')).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.getAll('panel').includes('mock-exams') && !url.searchParams.has('mock'),
    );

    await mockUi.add(dialog).click();
    await expect(page).toHaveURL(/[?&]mock=new/);
    await expect(mockUi.next(dialog)).toBeVisible();

    await page.goBack();
    await expect(mockUi.row(dialog, '상세 메뉴')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(homePlay(page)).toBeFocused();
  },
);

test(
  'UX12-MOCKNAV-AC02 the detail shows 풀기 and 더보기; every action returns focus to 더보기',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace, exam } = await seedExam(workspaceFactory, 'ux12-mocknav-ac02');
    await signInAs(page, owner.user);
    await page.goto(mockExamsPath(workspace.id, exam.id));
    const dialog = mockUi.dialog(page);
    await expect(mockUi.heading(dialog, '상세 메뉴')).toBeVisible();
    await expect(mockUi.practise(dialog)).toBeVisible();
    await expect(mockUi.more(dialog)).toBeVisible();
    await expect(movedButtons(dialog)).toHaveCount(0);

    await mockUi.more(dialog).click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([
      /설정 바꾸기|change settings/i,
      /다시 만들기|regenerate/i,
      /이름 바꾸기|rename/i,
      /삭제|delete/i,
    ]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(mockUi.more(dialog)).toBeFocused();

    await mockUi.chooseDetailAction(dialog, 'rename');
    await expect(mockUi.renameField(dialog)).toBeFocused();
    await mockUi.renameField(dialog).press('Escape');
    await expect(mockUi.more(dialog)).toBeFocused();

    await mockUi.chooseDetailAction(dialog, 'remake');
    let confirm = mockUi.confirm(page);
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(mockUi.more(dialog)).toBeFocused();

    await mockUi.chooseDetailAction(dialog, 'delete');
    confirm = mockUi.confirm(page);
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(mockUi.more(dialog)).toBeFocused();

    await mockUi.chooseDetailAction(dialog, 'settings');
    await dialog.getByRole('button', { name: /^(취소|cancel)$/i }).click();
    await expect(mockUi.more(dialog)).toBeFocused();
  },
);

test(
  'UX12-MOCKNAV-AC03 a viewer sees 풀기 without 더보기',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { workspace, exam } = await seedExam(workspaceFactory, 'ux12-mocknav-ac03');
    const viewer = await workspaceFactory.member('ux12-mocknav-ac03-viewer');
    seedMembership(workspace.id, viewer.user.id, 'viewer');
    await signInAs(page, viewer.user);
    await page.goto(mockExamsPath(workspace.id, exam.id));
    const dialog = mockUi.dialog(page);
    await expect(mockUi.practise(dialog)).toBeVisible();
    await expect(mockUi.more(dialog)).toHaveCount(0);
    await expect(movedButtons(dialog)).toHaveCount(0);
  },
);

test(
  'UX12-MOCKNAV-AC04 help and the range step call it 모의고사',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-mocknav-ac04');
    const workspace = await workspaceFactory.create(owner);
    await createNumberedQuestions(owner, workspace.id, 'ux12-mocknav-ac04', 1);
    await signInAs(page, owner.user);

    await page.goto('/help');
    await expect(page.getByRole('heading', { level: 2, name: /^모의고사$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /문제 ?풀기/ })).toHaveCount(0);

    await page.goto(homePath(workspace.id));
    const panel = await openRangePicker(page);
    await expect(runUi.pickerTitle(panel)).toHaveText(/^모의고사$/);
    await expect(panel.getByText(/문제 ?풀기/)).toHaveCount(0);
  },
);

test(
  'UX12-MOCKNAV-AC05 without edit rights 추가 starts only a variation-free run',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace } = await seedExam(workspaceFactory, 'ux12-mocknav-ac05');
    const viewer = await workspaceFactory.member('ux12-mocknav-ac05-viewer');
    seedMembership(workspace.id, viewer.user.id, 'viewer');

    const startRun = async (dialog: Locator) => {
      await mockUi.add(dialog).click();
      await expect(page).toHaveURL(/[?&]mock=new/);
      await dialog.getByRole('checkbox', { name: /^전체 선택|select all/i }).check();
      await mockUi.next(dialog).click();
      await expect(mockUi.variations(dialog)).not.toHaveCount(0);
      for (const box of await mockUi.variations(dialog).all()) await expect(box).toBeDisabled();
      await expect(dialog.getByText(/변형 출제에는 편집 권한이 필요합니다/)).toBeVisible();
      await dialog.getByRole('checkbox', { name: /선택 범위의 모든 문항/ }).check();
      const request = page.waitForRequest(
        (r) => r.method() === 'POST' && /\/practice-runs$/.test(new URL(r.url()).pathname),
      );
      await dialog.getByRole('button', { name: /^(시작|start)$/i }).click();
      expect((await request).postDataJSON().source).toBe('bank');
      await expect(page).toHaveURL(/practice=/);
    };

    await signInAs(page, viewer.user);
    await page.goto(homePath(workspace.id));
    await homePlay(page).click();
    await startRun(mockUi.dialog(page));

    await workspaceFactory.archive(owner, workspace.id);
    await page.context().clearCookies();
    await signInAs(page, owner.user);
    await page.goto(homePath(workspace.id));
    await homePlay(page).click();
    await startRun(mockUi.dialog(page));

    const saved = await owner.api.ok<{ items: unknown[] }>(
      'GET',
      `/workspaces/${workspace.id}/mock-exams`,
      undefined,
    );
    expect(saved.items).toHaveLength(1);
  },
);
