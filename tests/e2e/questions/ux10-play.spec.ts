import { test, expect, createNumberedQuestions, homePath, signInAs } from '../fixtures/test.ts';
import type { Locator, Page } from '@playwright/test';
import {
  createMockExam,
  getMockExam,
  mockExamsPath,
  mockUi,
  waitForMockExam,
} from '../fixtures/mock-exams.ts';

test.use({ storageState: { cookies: [], origins: [] } });

async function boxOf(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error('The control must have a layout box');
  return box;
}

/** Saving a name fails until the returned function is called. */
async function failRename(page: Page): Promise<() => Promise<void>> {
  const target = (url: URL) => /\/api\/mock-exams\/[^/]+$/.test(url.pathname);
  await page.route(target, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    return route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      body: JSON.stringify({ title: 'Internal Server Error', status: 500 }),
    });
  });
  return () => page.unroute(target);
}

/** 저장·취소 share one line under the input (UX10-PLAY-AC06). */
async function expectActionsUnderInput(scope: Locator): Promise<void> {
  const input = await boxOf(scope.getByRole('textbox', { name: /모의고사 이름/ }));
  const save = await boxOf(scope.getByRole('button', { name: '저장' }));
  const cancel = await boxOf(scope.getByRole('button', { name: '취소' }));
  expect(save.y).toBeGreaterThanOrEqual(input.y + input.height);
  expect(save.y).toBe(cancel.y);
  expect(cancel.x).toBeGreaterThan(save.x);
}

test('UX10-PLAY-AC01 original questions start a bank run without creating a mock', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-play-bank');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'ux10-play', 3);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id));
  await page.getByRole('button', { name: /^모의고사$/ }).click();
  const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });
  await expect(dialog).toBeVisible();
  await mockUi.add(dialog).click();
  await dialog.getByRole('checkbox', { name: /^전체 선택|select all/i }).check();
  await dialog.getByRole('button', { name: /다음|next/i }).click();
  await expect(dialog.getByRole('checkbox', { name: /보기 섞기|shuffle/i })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: /선택 범위의 모든 문항/i }).check();
  const request = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/practice-runs$/.test(new URL(r.url()).pathname),
  );
  await dialog.getByRole('button', { name: /시작|start/i }).click();
  const body = (await request).postDataJSON();
  expect(body.source).toBe('bank');
  expect(body.question_count).toBeNull();
  await expect(page).toHaveURL(/practice=/);
  await expect(page.getByText(/ux10-play-1 문제/)).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('heading', { name: /1번/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^모의고사$/ })).toBeFocused();
  const mocks = await owner.api.ok<{ items: unknown[] }>(
    'GET',
    `/workspaces/${workspace.id}/mock-exams`,
    undefined,
    [200],
  );
  expect(mocks.items).toHaveLength(0);
});

test('UX10-PLAY-AC02 rejects a count larger than the selected range', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-count');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'count', 3);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
  const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });
  await dialog.getByRole('checkbox', { name: /^전체 선택|select all/i }).check();
  await dialog.getByRole('button', { name: /다음|next/i }).click();
  await dialog.getByLabel(/문항 수|question count/i).fill('4');
  await expect(dialog.getByRole('button', { name: /시작|start/i })).toBeDisabled();
  await expect(dialog.getByText(/선택한 범위보다 문항 수가 많습니다/)).toBeVisible();
});

test('UX10-PLAY-AC03 uses steps instead of a generation progressbar', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-steps');
  const workspace = await workspaceFactory.create(owner);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
  const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });
  await expect(dialog.getByRole('list', { name: /모의고사 단계/ })).toBeVisible();
  await expect(dialog.getByRole('progressbar')).toHaveCount(0);
});

test('UX10-PLAY-AC03 aligns 문항 수 and 난이도 on desktop and stacks them on mobile', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-form-row');
  const workspace = await workspaceFactory.create(owner);
  await page.setViewportSize({ width: 1280, height: 800 });
  await createNumberedQuestions(owner, workspace.id, 'form-row', 1);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
  const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });
  await dialog.getByRole('checkbox', { name: /^전체 선택|select all/i }).check();
  await dialog.getByRole('button', { name: /다음|next/i }).click();
  await mockUi.variation(dialog, 'PARAPHRASE').check();

  const count = await boxOf(mockUi.questionCount(dialog));
  const difficulty = await boxOf(mockUi.difficulty(dialog));
  expect(Math.abs(count.width - difficulty.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(count.y - difficulty.y)).toBeLessThanOrEqual(1);
  expect(difficulty.x).toBeGreaterThanOrEqual(count.x + count.width);

  await page.setViewportSize({ width: 375, height: 800 });
  const mobileCount = await boxOf(mockUi.questionCount(dialog));
  const mobileDifficulty = await boxOf(mockUi.difficulty(dialog));
  expect(Math.abs(mobileCount.x - mobileDifficulty.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileCount.width - mobileDifficulty.width)).toBeLessThanOrEqual(1);
  expect(mobileDifficulty.y).toBeGreaterThanOrEqual(mobileCount.y + mobileCount.height);
});

test('UX10-PLAY-AC04 keeps action rows at the dialog bottom and fields reachable', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-footer');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'footer', 1);
  await signInAs(page, owner.user);
  for (const viewport of [
    { width: 390, height: 812 },
    { width: 1280, height: 900 },
    { width: 390, height: 450 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
    const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });
    const next = dialog.getByRole('button', { name: /다음|next/i });
    await expect(next).toBeInViewport();
    const dialogBox = await dialog.boundingBox();
    const footerBox = await next.locator('..').boundingBox();
    if (!dialogBox || !footerBox) throw new Error('Dialog and footer must be visible');
    expect(
      Math.abs(dialogBox.y + dialogBox.height - (footerBox.y + footerBox.height)),
    ).toBeLessThanOrEqual(2);
    const selectAll = dialog.getByRole('checkbox', { name: /^전체 선택|select all/i });
    await selectAll.check();
    await dialog.getByRole('button', { name: /챕터 없음.*펼치기/ }).click();
    const lastQuestion = dialog.getByRole('checkbox', { name: /1번 · footer-1/ });
    await lastQuestion.uncheck();
    await lastQuestion.check();
    await next.click();
    await dialog.getByRole('checkbox', { name: /선택 범위의 모든 문항/ }).check();
    const start = dialog.getByRole('button', { name: /시작|start/i });
    await expect(start).toBeInViewport();
    const rangeFooter = await start.locator('..').boundingBox();
    if (!rangeFooter) throw new Error('Range footer must be visible');
    expect(
      Math.abs(dialogBox.y + dialogBox.height - (rangeFooter.y + rangeFooter.height)),
    ).toBeLessThanOrEqual(2);
  }
});

test('UX10-PLAY-AC05 groups results and returns to the same run position', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-results');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'results', 2);
  const run = await owner.api.ok<{ id: string }>(
    'POST',
    `/workspaces/${workspace.id}/practice-runs`,
    { source: 'bank', range: { all: true }, random_order: false },
    [201],
  );
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, `practice=${run.id}&view=results`));
  const panel = page.getByRole('dialog', { name: /풀이 결과|results/i });
  const group = panel.getByRole('list', { name: /문제별 결과/ });
  await expect(group.getByRole('heading', { name: /장 없음/ })).toBeVisible();
  await expect(group.getByRole('cell', { name: /건너뜀/ }).first()).toBeVisible();
  await group.getByRole('button', { name: /2번/ }).click();
  await expect(page).toHaveURL(new RegExp(`practice=${run.id}.*i=2`));
  await expect(page.getByText(/results-2 문제/)).toBeVisible();
});

test('UX10-PLAY-AC06 only the edited mock is disabled and cancel restores it', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-rename');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'rename', 2);
  const first = await createMockExam(owner, workspace.id, '첫 시험', {
    variation_types: ['OPTION_SHUFFLE'],
    question_count: 1,
  });
  const second = await createMockExam(owner, workspace.id, '둘째 시험', {
    variation_types: ['OPTION_SHUFFLE'],
    question_count: 1,
  });
  await waitForMockExam(owner, first.id);
  await waitForMockExam(owner, second.id);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams'));
  const dialog = page.getByRole('dialog', { name: /모의고사|mock exams/i });
  const list = dialog.getByRole('list', { name: /모의고사 목록/ });
  const firstRow = list
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: /첫 시험 메뉴/ }) });
  const secondRow = list
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: /둘째 시험 메뉴/ }) });
  await firstRow.getByRole('button', { name: /첫 시험 메뉴/ }).click();
  await page.getByRole('menuitem', { name: /이름 바꾸기/ }).click();
  await expect(firstRow.getByRole('button', { name: '풀기' })).toBeDisabled();
  await expect(secondRow.getByRole('button', { name: '풀기' })).toBeEnabled();
  const input = firstRow.getByRole('textbox', { name: /모의고사 이름/ });
  const save = firstRow.getByRole('button', { name: '저장' });
  const cancel = firstRow.getByRole('button', { name: '취소' });
  const inputBox = await input.boundingBox();
  const saveBox = await save.boundingBox();
  const cancelBox = await cancel.boundingBox();
  if (!inputBox || !saveBox || !cancelBox) throw new Error('Rename controls must be visible');
  expect(saveBox.y).toBeGreaterThan(inputBox.y);
  expect(saveBox.y).toBe(cancelBox.y);
  await cancel.click();
  await expect(firstRow.getByRole('button', { name: '풀기' })).toBeEnabled();
});

test('UX10-PLAY-AC06 the detail header rename keeps its input and 풀기 off until saved', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-rename-detail');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'rename-detail', 2);
  const exam = await createMockExam(owner, workspace.id, '상세 시험', {
    variation_types: ['OPTION_SHUFFLE'],
    question_count: 1,
  });
  await waitForMockExam(owner, exam.id);
  await signInAs(page, owner.user);
  await page.goto(mockExamsPath(workspace.id, exam.id));
  const dialog = mockUi.dialog(page);
  const practise = dialog.getByRole('button', { name: /^풀기$/ });
  await expect(practise).toBeEnabled();

  await mockUi.chooseDetailAction(dialog, 'rename');
  await expect(practise).toBeDisabled();
  await expectActionsUnderInput(dialog);

  const input = dialog.getByRole('textbox', { name: /모의고사 이름/ });
  const save = dialog.getByRole('button', { name: '저장' });
  const restore = await failRename(page);
  await input.fill('바뀐 상세 시험');
  await save.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('바뀐 상세 시험');
  await expect(input).toBeEnabled();
  await expect(practise).toBeDisabled();
  expect((await getMockExam(owner, exam.id)).title).toBe('상세 시험');

  await restore();
  await save.click();
  await expect(input).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: '바뀐 상세 시험' })).toBeVisible();
  await expect(practise).toBeEnabled();
  expect((await getMockExam(owner, exam.id)).title).toBe('바뀐 상세 시험');
});

test('UX10-PLAY-AC06 a failed row rename keeps the input and that row 풀기 off', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-rename-fail');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'rename-fail', 2);
  const exam = await createMockExam(owner, workspace.id, '실패 시험', {
    variation_types: ['OPTION_SHUFFLE'],
    question_count: 1,
  });
  await waitForMockExam(owner, exam.id);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams'));
  const dialog = mockUi.dialog(page);
  // Named by its menu: the title button gives way to the input while renaming.
  const menu = page.getByRole('button', { name: /실패 시험 메뉴/ });
  const row = mockUi.rows(dialog).filter({ has: menu });
  await menu.click();
  await page.getByRole('menuitem', { name: /이름 바꾸기/ }).click();
  const input = row.getByRole('textbox', { name: /모의고사 이름/ });
  const practise = row.getByRole('button', { name: /^풀기$/ });

  const restore = await failRename(page);
  await input.fill('바뀐 시험');
  await row.getByRole('button', { name: '저장' }).click();
  await expect(row.getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('바뀐 시험');
  await expect(practise).toBeDisabled();

  await restore();
  await row.getByRole('button', { name: '취소' }).click();
  await expect(input).toHaveCount(0);
  await expect(practise).toBeEnabled();
  expect((await getMockExam(owner, exam.id)).title).toBe('실패 시험');
});

test('UX10-PLAY-AC01 selecting shuffle creates a mock instead of a bank run', async ({
  page,
  workspaceFactory,
}) => {
  const owner = await workspaceFactory.member('ux10-play-mock');
  const workspace = await workspaceFactory.create(owner);
  await createNumberedQuestions(owner, workspace.id, 'mock-route', 2);
  await signInAs(page, owner.user);
  await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
  const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });
  await dialog.getByRole('checkbox', { name: /^전체 선택|select all/i }).check();
  await dialog.getByRole('button', { name: /다음|next/i }).click();
  await dialog.getByRole('checkbox', { name: /보기 섞기/ }).check();
  await dialog.getByRole('checkbox', { name: /선택 범위의 모든 문항/ }).check();
  const request = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/mock-exams$/.test(new URL(r.url()).pathname),
  );
  await dialog.getByRole('button', { name: /만들기|create/i }).click();
  expect((await request).postDataJSON().config).toMatchObject({
    variation_types: ['OPTION_SHUFFLE'],
    question_count: null,
  });
  await expect(page).toHaveURL(/mock=[0-9a-f-]+/i);
});
