// UX12-SOLVEDOPEN — a solved question opens to be answered; `해설 보기` asks for the earlier result
// (docs/screens/ux12-solved-open.md). The contract is in tests/integration/questions/
// test_practice_open.py.
import type { Locator, Page, Response } from '@playwright/test';
import {
  answerCorrectly,
  createQuestion,
  expect,
  historyPath,
  historyUi,
  listAttempts,
  numberedMcq,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  signInAs,
  startPractice,
  submitPractice,
  test,
  type E2EFixtures,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const AGAIN = /^다시 풀기$|^solve again$/i;
const EXPLANATION = /UX12-SOLVEDOPEN 해설/;
const explained = { explanation: 'UX12-SOLVEDOPEN 해설: 첫 보기가 답이다.' };

interface Seeded {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly questions: Question[];
}

async function seed(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  count: number,
): Promise<Seeded> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const questions: Question[] = [];
  for (let n = 1; n <= count; n += 1) {
    questions.push(
      await createQuestion(owner, ws.id, numberedMcq(`${label}-${Date.now()}`, n, 0, explained)),
    );
  }
  return { owner, workspaceId: ws.id, questions };
}

function at(s: Seeded, n: number): Question {
  const question = s.questions[n - 1];
  if (!question) throw new Error(`no question ${n}`);
  return question;
}

function optionText(question: Question, index: number): string {
  const text = question.revision.options[index]?.text;
  if (!text) throw new Error(`no option ${index}`);
  return text;
}

async function answerWrong(owner: Member, question: Question): Promise<void> {
  const session = await startPractice(owner, question.id);
  const wrong = question.revision.options[1]?.id;
  if (!wrong) throw new Error('no wrong option');
  await submitPractice(owner, session.id, { selected_option_ids: [wrong] });
}

async function openHome(page: Page, s: Seeded): Promise<void> {
  await signInAs(page, s.owner.user);
  await page.goto(overviewPath(s.workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

async function openDot(page: Page, n: number): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  return panel;
}

async function closePanel(panel: Locator): Promise<void> {
  await panelUi.close(panel).click();
  await expect(panel).toBeHidden();
}

function isOpening(response: Response): boolean {
  return response.url().endsWith('/practice-open');
}

/** Question first: nothing chosen, no result, no explanation, 해설 보기 in the footer. */
async function expectQuestionFirst(panel: Locator): Promise<void> {
  await expect(panelUi.reveal(panel)).toBeVisible();
  await expect(panelUi.submit(panel)).toBeDisabled();
  for (const option of await panelUi.options(panel).all()) await expect(option).not.toBeChecked();
  await expect(panel).not.toContainText(EXPLANATION);
  await expect(panel).not.toContainText(RESULT_TEXT.correct);
  await expect(panel).not.toContainText(RESULT_TEXT.incorrect);
}

test(
  'UX12-SOLVEDOPEN-AC01 every solved question opens with the question first',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-solvedopen-1', 2);
    await answerCorrectly(s.owner, at(s, 1));
    await answerWrong(s.owner, at(s, 2));
    await openHome(page, s);

    for (const n of [1, 2]) {
      const opening = page.waitForResponse(isOpening);
      const panel = await openDot(page, n);
      const opened = (await (await opening).json()) as Record<string, unknown>;
      expect(opened.result).toBeNull();
      expect(opened.submitted_answer ?? null).toBeNull();
      expect(JSON.stringify(opened)).not.toMatch(EXPLANATION);
      await expectQuestionFirst(panel);
      await expect(panel.getByRole('button', { name: AGAIN })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await closePanel(panel);
    }
  },
);

test(
  'UX12-SOLVEDOPEN-AC02 a question never solved has no 해설 보기',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-solvedopen-2', 1);
    await openHome(page, s);
    const panel = await openDot(page, 1);
    await expect(panelUi.submit(panel)).toBeVisible();
    await expect(panelUi.reveal(panel)).toHaveCount(0);
  },
);

test(
  'UX12-SOLVEDOPEN-AC03 해설 보기 shows the earlier result and 다시 풀기 starts a new try',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-solvedopen-3', 1);
    const question = at(s, 1);
    await answerWrong(s.owner, question);
    const before = await listAttempts(s.owner, question.id);
    await openHome(page, s);

    const panel = await openDot(page, 1);
    await panelUi.reveal(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expect(panel).toContainText(EXPLANATION);
    await expect(panelUi.option(panel, optionText(question, 1))).toBeChecked();
    await expect(panelUi.option(panel, optionText(question, 1))).toBeDisabled();
    await expect(panelUi.submit(panel)).toHaveCount(0);
    await expect(panelUi.reveal(panel)).toHaveCount(0);
    expect(await listAttempts(s.owner, question.id)).toEqual(before);

    await panel.getByRole('button', { name: AGAIN }).click();
    await expect(panelUi.submit(panel)).toBeDisabled();
    await expect(panelUi.option(panel, optionText(question, 1))).not.toBeChecked();
    await panelUi.option(panel, optionText(question, 0)).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(await listAttempts(s.owner, question.id)).toHaveLength(2);
  },
);

test(
  'UX12-SOLVEDOPEN-AC04 an answer being written waits for a confirm and is never submitted',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-solvedopen-4', 1);
    const question = at(s, 1);
    await answerWrong(s.owner, question);
    await openHome(page, s);

    const panel = await openDot(page, 1);
    await panelUi.option(panel, optionText(question, 0)).check();
    await panelUi.reveal(panel).click();
    const confirm = page.getByRole('alertdialog', { name: /작성 중인 답안 버리기/ });
    await confirm.getByRole('button', { name: /취소|cancel/i }).click();
    await expect(confirm).toBeHidden();
    await expect(panelUi.option(panel, optionText(question, 0))).toBeChecked();
    await expect(panel).not.toContainText(EXPLANATION);

    await panelUi.reveal(panel).click();
    await confirm.getByRole('button', { name: /해설 보기/ }).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expect(panelUi.option(panel, optionText(question, 1))).toBeChecked();
    expect(await listAttempts(s.owner, question.id)).toHaveLength(1);
  },
);

test(
  'UX12-SOLVEDOPEN-AC05 the session of a revealed result can no longer be submitted',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-solvedopen-5', 1);
    const question = at(s, 1);
    await answerWrong(s.owner, question);
    await openHome(page, s);

    const opening = page.waitForResponse(isOpening);
    const panel = await openDot(page, 1);
    const opened = (await (await opening).json()) as { session: { id: string } };
    await panelUi.reveal(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);

    const refused = await s.owner.api.request(
      'POST',
      `/practice-sessions/${opened.session.id}/submit`,
      { selected_option_ids: [question.revision.options[0]?.id ?? ''] },
    );
    expect(refused.status).toBe(409);
    expect(await listAttempts(s.owner, question.id)).toHaveLength(1);
  },
);

test(
  'UX12-SOLVEDOPEN-AC06 a history link and the return bar open a solved question the same way',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-solvedopen-6', 1);
    await answerCorrectly(s.owner, at(s, 1));
    await signInAs(page, s.owner.user);
    await page.goto(historyPath(s.workspaceId));

    const attempts = historyUi.ofKind(page, 'attempt');
    await expect(attempts).toHaveCount(1);
    await expect(attempts.first()).toContainText(RESULT_TEXT.correct);
    await attempts.first().getByRole('link').first().click();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await expectQuestionFirst(panel);
    await closePanel(panel);

    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.heatmap(page)).toBeVisible();
    const reopened = await openDot(page, 1);
    await closePanel(reopened);
    await page.getByRole('button', { name: '보던 문제로 돌아가기' }).click();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await expectQuestionFirst(panelUi.numbered(page, 1));
  },
);

test(
  'UX12-SOLVEDOPEN-AC07 previous and next bring back what this opening of the panel solved',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seed(workspaceFactory, 'ux12-solvedopen-7', 3);
    await answerWrong(s.owner, at(s, 3));
    await openHome(page, s);

    // Submitted here: back through previous, with its result, and no second session.
    const first = await openDot(page, 1);
    await panelUi.option(first, optionText(at(s, 1), 0)).check();
    await panelUi.submit(first).click();
    await expect(panelUi.result(first)).toContainText(RESULT_TEXT.correct);
    await panelUi.next(first).click();
    const second = panelUi.numbered(page, 2);
    await expect(panelUi.submit(second)).toBeVisible();
    await panelUi.previous(second).click();
    await expect(panelUi.result(panelUi.numbered(page, 1))).toContainText(RESULT_TEXT.correct);
    await expect(panelUi.numbered(page, 1)).toContainText(EXPLANATION);

    // Revealed here: the same.
    await panelUi.next(panelUi.numbered(page, 1)).click();
    await panelUi.next(panelUi.numbered(page, 2)).click();
    const third = panelUi.numbered(page, 3);
    await panelUi.reveal(third).click();
    await expect(panelUi.result(third)).toContainText(RESULT_TEXT.incorrect);
    await panelUi.previous(third).click();
    await expect(panelUi.submit(panelUi.numbered(page, 2))).toBeVisible();
    await panelUi.next(panelUi.numbered(page, 2)).click();
    await expect(panelUi.result(panelUi.numbered(page, 3))).toContainText(RESULT_TEXT.incorrect);

    // Closing ends it: the same questions open with the question first.
    await closePanel(panelUi.numbered(page, 3));
    await expectQuestionFirst(await openDot(page, 3));
    await closePanel(panelUi.numbered(page, 3));
    await expectQuestionFirst(await openDot(page, 1));
  },
);
