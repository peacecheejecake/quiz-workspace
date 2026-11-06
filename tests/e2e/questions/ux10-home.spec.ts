import {
  createNumberedQuestions,
  expect,
  openQuestionSearch,
  openStatusFilters,
  overviewPath,
  overviewUi,
  signInAs,
  test,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test(
  'UX10-HOME-AC01 primary play and the 문서 N menu',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux10-home-01');
    const workspace = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(workspace.id));
    await expect(page.getByRole('button', { name: /^모의고사$/ })).toBeVisible();
    const menu = page.getByRole('main').getByRole('button', { name: /^(문서|documents)\s*\d+$/i });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.getByRole('menuitem', { name: /모의고사|AI 질문/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^모의고사$/ }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.getAll('panel').includes('mock-exams') && !url.searchParams.has('mock'),
    );
  },
);

test(
  'UX10-HOME-AC03 status defaults to all and clearing every chip yields zero',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux10-home-03');
    const workspace = await workspaceFactory.create(owner);
    await createNumberedQuestions(owner, workspace.id, 'ux10-home-03', 1);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(workspace.id));
    await expect(overviewUi.markers(page)).toHaveCount(1);
    await openStatusFilters(page);
    const chips = page.locator('button[data-status][aria-pressed]');
    await expect(chips).toHaveCount(5);
    for (const chip of await chips.all()) {
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await chip.click();
    }
    await expect(page).toHaveURL(/status=none/);
    await expect(overviewUi.markers(page)).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await page.reload();
    await openStatusFilters(page);
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
    await expect(overviewUi.markers(page)).toHaveCount(0);
  },
);

test(
  'UX10-HOME-AC04 rapid status changes commit only the final selection',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux10-home-04');
    const workspace = await workspaceFactory.create(owner);
    await createNumberedQuestions(owner, workspace.id, 'ux10-home-04', 1);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(workspace.id));
    await expect(overviewUi.markers(page)).toHaveCount(1);
    await openStatusFilters(page);
    const unseen = page.locator('button[data-status="unseen"][aria-pressed]');
    await unseen.click();
    await unseen.click();
    await expect(unseen).toHaveAttribute('aria-pressed', 'true');
    await expect(page).not.toHaveURL(/status=/);
    await expect(overviewUi.markers(page)).toHaveCount(1);
    await page.evaluate(() => {
      history.pushState(null, '', `${location.pathname}?other=1`);
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await unseen.click();
    await page.goBack();
    await openStatusFilters(page);
    await expect(unseen).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(450); // the cancelled 350ms timer must not write after Back
    await expect(page).not.toHaveURL(/status=/);
    await unseen.click();
    const search = await openQuestionSearch(page);
    await search.fill('ux10');
    await expect(page).toHaveURL(/q=ux10/);
    await expect(page).toHaveURL(/status=/);
    await page.goto(overviewPath(workspace.id));
    await openStatusFilters(page);
    await unseen.click();
    await page.goBack();
    await expect(page).toHaveURL(/q=ux10/);
    await openStatusFilters(page);
    await expect(unseen).toHaveAttribute('aria-pressed', 'false');
  },
);

test(
  'UX10-HOME-AC05 chapter count has no visual unit on mobile',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const owner = await workspaceFactory.member('ux10-home-05');
    const workspace = await workspaceFactory.create(owner);
    await createNumberedQuestions(owner, workspace.id, 'ux10-home-05', 1);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(workspace.id));
    await expect(overviewUi.markers(page)).toHaveCount(1);
    await expect(page.getByLabel('1문제', { exact: true })).toHaveText('1');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  },
);

test(
  'UX10-HOME-AC03 clearing all range status chips loads no questions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux10-home-range-none');
    const workspace = await workspaceFactory.create(owner);
    await createNumberedQuestions(owner, workspace.id, 'ux10-range-none', 1);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(workspace.id));
    await expect(overviewUi.markers(page)).toHaveCount(1);
    await page.getByRole('button', { name: /^모의고사$/ }).click();
    const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });
    await dialog.getByRole('button', { name: /^(추가|add)$/i }).click();
    const group = dialog.getByRole('group', { name: /^(상태 필터|status filter)$/i });
    for (const label of ['안 푼 문제', '본 문제', '틀린 문제', '맞힌 문제', '다시 풀기']) {
      const chip = group.getByRole('button', { name: label, exact: true });
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await chip.click();
    }
    await expect(dialog.getByText(/조건에 맞는 문제가 없습니다/)).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /^전체 선택|select all/i })).toHaveCount(0);
    // The range is the first step since MOCKUX-8: an empty one never reaches 시작.
    await expect(dialog.getByRole('button', { name: /^(다음|next)$/i })).toBeDisabled();
  },
);
