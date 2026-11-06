import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  createPracticeRun,
  createShuffleMockExam,
  mockAttemptCount,
  questionAttemptCount,
  openRunSession,
  practiceRunPath,
  runResults,
  runUi,
} from '../fixtures/practice-runs.ts';
import {
  createShareLink,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharedUi,
  test,
} from '../fixtures/sharing.ts';
import {
  createQuestion,
  expect,
  listAttempts,
  numberedMcq,
  overviewPath,
  overviewUi,
  homeUi,
  uploadReadyBook,
  panelUi,
  RESULT_TEXT,
  signInAs,
  seedMembership,
  startPractice,
  submitPractice,
} from '../fixtures/test.ts';

/** Records whether the fail-closed attribute ever appears, not only whether it is set afterwards. */
async function watchIdentityPending(page: Page) {
  await page.evaluate(() => {
    const flags = window as unknown as { identityPendingSeen?: boolean };
    flags.identityPendingSeen = false;
    new MutationObserver(() => {
      if (document.body.hasAttribute('data-identity-pending')) flags.identityPendingSeen = true;
    }).observe(document.body, { attributes: true, attributeFilter: ['data-identity-pending'] });
  });
}
const identityPendingSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { identityPendingSeen?: boolean }).identityPendingSeen);

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});

test(
  'UX11-RETURN-AC03 standalone retry preserves the old attempt and return control only dismisses',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`return-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    const question = await createQuestion(owner, ws.id, numberedMcq('return-test', 1, 1));
    const previous = await startPractice(owner, question.id);
    await submitPractice(owner, previous.id, {
      selected_option_ids: question.revision.correct_option_ids ?? [],
    });
    const before = await listAttempts(owner, question.id);
    expect(before).toHaveLength(1);

    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await expect(panelUi.submit(panel)).toBeVisible();
    const correct = question.revision.options.find((option) =>
      question.revision.correct_option_ids?.includes(option.id),
    );
    if (!correct) throw new Error('Expected a correct option');
    await panelUi.option(panel, correct.text).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    const after = await listAttempts(owner, question.id);
    expect(after).toHaveLength(2);
    expect(after.map((attempt) => attempt.id)).toContain(before[0]?.id);

    await panelUi.close(panel).click();
    const returnButton = page.getByRole('button', { name: '보던 문제로 돌아가기' });
    await expect(returnButton).toBeVisible();
    await returnButton.click();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await panelUi.close(panelUi.numbered(page, 1)).click();
    await page.getByRole('button', { name: '복귀 버튼 닫기' }).click();
    await expect(returnButton).toBeHidden();
    await overviewUi.dot(page, 1).click();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await panelUi.close(panelUi.numbered(page, 1)).click();
    await expect(returnButton).toBeVisible();
    expect(await listAttempts(owner, question.id)).toHaveLength(2);
  },
);

test(
  'UX11-RETURN-AC02 returns to the same run position after a retry in a finished run without changing its result',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`return-run-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    const question = await createQuestion(owner, ws.id, numberedMcq('return-run', 1, 1));
    const run = await createPracticeRun(owner, ws.id, {
      source: 'bank',
      range: { all: true },
      random_order: false,
    });
    const original = await openRunSession(owner, question.id, run.id, 1);
    if (!original.body) throw new Error('Expected run session');
    const wrong = question.revision.options.find(
      (option) => !question.revision.correct_option_ids?.includes(option.id),
    );
    const correct = question.revision.options.find((option) =>
      question.revision.correct_option_ids?.includes(option.id),
    );
    if (!wrong || !correct) throw new Error('Expected correct and incorrect options');
    await submitPractice(owner, original.body.id, { selected_option_ids: [wrong.id] });
    await owner.api.ok('POST', `/practice-runs/${run.id}/finish`, {}, [200]);
    const before = await runResults(owner, run.id);
    await signInAs(page, owner.user);
    await page.goto(practiceRunPath(ws.id, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await runUi.option(panel, correct.text).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(await runResults(owner, run.id)).toEqual(before);
    await runUi.close(panel).click();
    await page.getByRole('button', { name: '보던 문제로 돌아가기' }).click();
    await expect(page).toHaveURL(new RegExp(`practice=${run.id}.*i=1`));
    await expect(runUi.result(runUi.panel(page))).toContainText(RESULT_TEXT.incorrect);
  },
);

test(
  'UX11-RETURN-AC01 a mock retry after the run finished is a separate attempt and leaves the run result unchanged',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`return-mock-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    const question = await createQuestion(owner, ws.id, numberedMcq('return-mock', 1, 1));
    const exam = await createShuffleMockExam(owner, ws.id, '복귀 모의고사', [question.id], 1);
    const run = await createPracticeRun(owner, ws.id, {
      source: 'mock',
      mock_exam_id: exam.id,
      range: { all: true },
      random_order: false,
    });
    await signInAs(page, owner.user);
    await page.goto(practiceRunPath(ws.id, run.id, 1));
    const panel = runUi.panel(page);
    await expect(runUi.mockTitle(panel, 1)).toBeVisible();
    await panel.getByRole('radio').first().check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(/정답|오답/);
    await owner.api.ok('POST', `/practice-runs/${run.id}/finish`, {}, [200]);
    const before = await runResults(owner, run.id);
    await page.reload();
    await expect(runUi.result(panel)).toContainText(/정답|오답/);
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await panel.getByRole('radio').first().check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(/정답|오답/);
    expect(await runResults(owner, run.id)).toEqual(before);
    expect(questionAttemptCount(ws.id)).toBe(0);
    expect(mockAttemptCount(exam.id)).toBe(2);
  },
);

test(
  'UX11-RETURN-AC04 a cookie account change hides the previous user’s open answer without a browser auth event',
  { tag: '@infra' },
  async ({ page, browser, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`return-owner-${randomUUID().slice(0, 8)}`);
    const other = await workspaceFactory.member(`return-other-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    await createQuestion(owner, ws.id, numberedMcq('return-private', 1, 1));
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panelUi.options(panel).first()).toBeVisible();
    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await signInAs(otherPage, other.user);
      const replacement = await otherContext.cookies();
      await page.context().clearCookies();
      await page.context().addCookies(replacement);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(panel).toBeHidden();
      await expect(page).toHaveURL(/\/workspaces$/);
      await expect(page.getByRole('button', { name: '보던 문제로 돌아가기' })).toBeHidden();
      const forbidden = await page.goto(`/workspaces/${ws.id}`);
      expect(forbidden?.status()).toBe(404);
    } finally {
      await otherContext.close();
    }
  },
);

test(
  'UX11-RETURN-AC05 control fits a narrow screen and hides beneath a modal',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`return-a11y-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    await createQuestion(owner, ws.id, numberedMcq('return-a11y', 1, 1));
    await page.setViewportSize({ width: 375, height: 667 });
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panelUi.options(panel).first()).toBeVisible();
    await panelUi.close(panel).click();
    const button = page.getByRole('button', { name: '보던 문제로 돌아가기' });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375 && box.height >= 44).toBeTruthy();
    await page.getByRole('link', { name: 'Quiz Workspace' }).click();
    await page.getByRole('button', { name: 'Workspace 만들기' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Workspace 만들기' });
    await expect(dialog).toBeVisible();
    await expect(button).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(button).toBeVisible();
  },
);

test(
  'UX11-RETURN-AC04 confirmed account refresh preserves same-user drafts and clears the old account search draft',
  { tag: '@infra' },
  async ({ page, browser, workspaceFactory }) => {
    test.setTimeout(180_000);
    const owner = await workspaceFactory.member(`return-search-a-${randomUUID().slice(0, 8)}`);
    const other = await workspaceFactory.member(`return-search-b-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    seedMembership(ws.id, other.user.id, 'viewer');
    // The 본문 search box needs a published book (SEARCH-01-AC09).
    await uploadReadyBook(owner, ws.id, 'book-ko');
    await signInAs(page, owner.user);
    await page.goto(`/workspaces/${ws.id}/search`);
    const search = page.getByRole('searchbox', { name: '본문 검색어' });
    await page.waitForLoadState('networkidle');
    await search.fill('private draft from account A');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(search).toHaveValue('private draft from account A');
    const otherContext = await browser.newContext();
    try {
      await signInAs(await otherContext.newPage(), other.user);
      const replacement = await otherContext.cookies();
      await page.context().clearCookies();
      await page.context().addCookies(replacement);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page).toHaveURL(/\/workspaces$/);
      await page.goto(`/workspaces/${ws.id}/search`);
      await expect(search).toHaveValue('');
      await expect(page.getByText('private draft from account A')).toHaveCount(0);
    } finally {
      await otherContext.close();
    }
  },
);

test(
  'UX11-RETURN-AC05 return control remains usable in the fullscreen document viewer',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(180_000);
    const owner = await workspaceFactory.member(`return-doc-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    await createQuestion(owner, ws.id, numberedMcq('return-doc', 1, 1));
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panelUi.options(panel).first()).toBeVisible();
    await panelUi.close(panel).click();
    const control = page.getByRole('button', { name: '보던 문제로 돌아가기' });
    await expect(control).toBeVisible();
    await homeUi.openDocuments(page);
    const docs = homeUi.documentsDialog(page);
    await docs.locator(`a[href="/workspaces/${ws.id}/documents/${documentId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/documents/${documentId}`));
    await expect(control).toBeVisible();
    await control.click();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
  },
);

test(
  'UX11-RETURN-AC04 a public share remains visible after cookies change',
  { tag: '@infra' },
  async ({ page, browser, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`return-share-a-${randomUUID().slice(0, 8)}`);
    const other = await workspaceFactory.member(`return-share-b-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    const share = await createShareLink(owner, ws.id);
    await signInAs(page, owner.user);
    await openShareWithSecret(page, share.id, share.secret);
    await expect(sharedUi.heading(page)).toBeVisible();
    const otherContext = await browser.newContext();
    try {
      await signInAs(await otherContext.newPage(), other.user);
      const replacement = await otherContext.cookies();
      const authCookies = replacement.filter((cookie) => cookie.name.startsWith('sb-'));
      await page.context().addCookies(authCookies);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(sharedUi.heading(page)).toBeVisible();
      await expect(page.locator('body')).not.toHaveAttribute('data-identity-pending');
    } finally {
      await otherContext.close();
    }
  },
);

test(
  'UX11-RETURN-AC04 same-user re-entry and the return click never hide the page or flash a message',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`return-silent-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    await createQuestion(owner, ws.id, numberedMcq('return-silent', 1, 1));
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panelUi.options(panel).first()).toBeVisible();
    await panelUi.close(panel).click();
    const control = page.getByRole('button', { name: '보던 문제로 돌아가기' });
    await expect(control).toBeVisible();

    await page.route('**/api/auth/identity', async (route) => {
      await new Promise((done) => setTimeout(done, 300));
      await route.continue();
    });
    await watchIdentityPending(page);
    const checked = page.waitForResponse('**/api/auth/identity');
    await page.evaluate(() => {
      (window as unknown as { returnControl?: Element | null }).returnControl =
        document.querySelector('[data-app-global-control="practice-return"] button');
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
    });
    await expect(control).toBeVisible();
    await checked;
    await expect(
      page.locator('[data-app-global-control="practice-return"]').getByRole('status'),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { returnControl?: Element | null }).returnControl?.isConnected,
      ),
    ).toBe(true);

    await control.click();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    expect(await identityPendingSeen(page)).toBe(false);
  },
);

test(
  'UX11-RETURN-AC04 an identity outage keeps the page visible and retries with a late notice',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`return-outage-${randomUUID().slice(0, 8)}`);
    const ws = await workspaceFactory.create(owner);
    await createQuestion(owner, ws.id, numberedMcq('return-outage', 1, 1));
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dot(page, 1)).toBeVisible();
    await page.route('**/api/auth/identity', (route) => route.abort());
    await watchIdentityPending(page);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const notice = page.getByRole('status').filter({ hasText: /연결이 불안정/ });
    await expect(notice).toHaveCount(0);
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(overviewUi.dot(page, 1)).toBeVisible();
    await page.unroute('**/api/auth/identity');
    await expect(notice).toBeHidden({ timeout: 10_000 });
    expect(await identityPendingSeen(page)).toBe(false);
  },
);
