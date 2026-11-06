// UX12-RUNASK — a mock exam run shows `질문하기` only once the position is graded
// (docs/screens/ux12-run-ask.md). The server's `hint` rule stays: ASK-01-C10 in
// tests/integration/ask/test_ask_contract.py.
import { randomUUID } from 'node:crypto';
import { ASK_TEXT, askUi, seedAskBook, seedSecretMockExam } from '../fixtures/ask.ts';
import { mockExamsPath, mockUi } from '../fixtures/mock-exams.ts';
import { runUi } from '../fixtures/practice-runs.ts';
import { expect, RESULT_TEXT, signInAs, test } from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test(
  'UX12-RUNASK-AC01 질문하기 appears in a mock exam run only after the position is graded',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-runask');
    const ws = await workspaceFactory.create(owner);
    const book = await seedAskBook(owner, ws.id);
    const label = `ux12-runask-${randomUUID().slice(0, 8)}`;
    const { exam } = await seedSecretMockExam(owner, ws.id, book, label);

    await signInAs(page, owner.user);
    await page.goto(mockExamsPath(ws.id));
    const list = mockUi.dialog(page);
    await expect(list).toBeVisible();
    await mockUi.rowTitle(list.getByRole('listitem').filter({ hasText: exam.title })).click();
    await runUi.start(runUi.panel(page)).click();
    const run = runUi.panel(page);
    await expect(runUi.mockTitle(run, 1)).toBeVisible();
    await expect(askUi.questionButton(run)).toHaveCount(0);

    await run.getByRole('radio', { name: /^보기 가 \d$/ }).check();
    await expect(askUi.questionButton(run)).toHaveCount(0);
    await runUi.submit(run).click();
    await expect(runUi.result(run)).toContainText(RESULT_TEXT.incorrect);
    await expect(askUi.questionButton(run)).toBeVisible();

    await runUi.next(run).click();
    await expect(runUi.mockTitle(run, 2)).toBeVisible();
    await expect(askUi.questionButton(run)).toHaveCount(0);

    await runUi.previous(run).click();
    await expect(runUi.mockTitle(run, 1)).toBeVisible();
    await askUi.questionButton(run).click();
    const panel = askUi.panel(page);
    await expect(askUi.chip(panel).getByText(ASK_TEXT.afterSubmit)).toBeVisible();
  },
);
