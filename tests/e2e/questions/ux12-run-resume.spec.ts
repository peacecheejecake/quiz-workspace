// UX12-RESUME (docs/screens/ux12-run-resume.md): the viewer's unfinished bank runs in the mock exam
// list, `이어 풀기` at the next unanswered position, and `지우기`. Contract half:
// tests/integration/questions/practice_runs/test_practice_runs_contract.py (UX12-RESUME).
import type { Locator, Page } from '@playwright/test';
import { MOCK_TEXT, mockUi } from '../fixtures/mock-exams.ts';
import {
  CH1,
  createPracticeRun,
  createShuffleMockExam,
  getPracticeRun,
  openRunSession,
  practiceParam,
  practiceRunPath,
  questionAttemptCount,
  runUi,
  seedRangeWorkspace,
  type PracticeRun,
} from '../fixtures/practice-runs.ts';
import { rangePickerUi } from '../fixtures/range-picker.ts';
import {
  archiveQuestion,
  createNumberedQuestions,
  expect,
  homePath,
  main,
  overviewPath,
  signInAs,
  test,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const resumeList = (dialog: Locator) =>
  dialog.getByRole('list', { name: /^(이어 풀기 목록|unfinished runs)$/i });
const resumeRows = (dialog: Locator) => resumeList(dialog).getByRole('listitem');
const resume = (row: Locator) => row.getByRole('button', { name: /(이어 풀기|resume)$/i });
const rowMenu = (row: Locator) => row.getByRole('button', { name: /(메뉴|menu)$/i });
const remove = (page: Page) => mockUi.menuAction(page, /^(지우기|remove)$/i);
const openListButton = (page: Page) =>
  main(page).getByRole('button', { name: /^(모의고사|mock exams?)$/i });

async function openList(page: Page, workspaceId: string): Promise<Locator> {
  await page.goto(homePath(workspaceId, 'panel=mock-exams'));
  const dialog = mockUi.dialog(page);
  await expect(mockUi.add(dialog)).toBeVisible();
  return dialog;
}

function nth(questions: readonly Question[], index: number): Question {
  const question = questions[index];
  if (!question) throw new Error(`no question ${index}`);
  return question;
}

function firstOption(question: Question): { readonly id: string; readonly text: string } {
  const option = question.revision.options[0];
  if (!option) throw new Error('no options');
  return option;
}

/** A bank run over `questions` in order, its first `answered` positions submitted. */
async function partialRun(
  member: Member,
  workspaceId: string,
  questions: readonly Question[],
  answered: number,
): Promise<PracticeRun> {
  const run = await createPracticeRun(member, workspaceId, {
    source: 'bank',
    range: { question_ids: questions.map((q) => q.id) },
    random_order: false,
  });
  for (const [index, question] of questions.slice(0, answered).entries()) {
    const session = await openRunSession(member, question.id, run.id, index + 1);
    if (!session.body) throw new Error('no session');
    await member.api.ok(
      'POST',
      `/practice-sessions/${session.body.id}/submit`,
      { selected_option_ids: [firstOption(question).id] },
      [200],
    );
  }
  return run;
}

async function answer(panel: Locator, question: Question): Promise<void> {
  await runUi.option(panel, firstOption(question).text).check();
  await runUi.submit(panel).click();
  await expect(runUi.result(panel)).toBeVisible();
}

async function closeRun(panel: Locator): Promise<void> {
  await runUi.close(panel).click();
  await expect(panel).toHaveCount(0);
}

test(
  'UX12-RESUME-AC01 a closed bank run from 추가 stays in the list with its progress',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-resume-01');
    const ws = await workspaceFactory.create(owner);
    const questions = await createNumberedQuestions(owner, ws.id, 'ux12-resume-01', 3);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, 'panel=mock-exams&mock=new'));
    const form = mockUi.dialog(page);
    await rangePickerUi.selectAll(form).check();
    await mockUi.next(form).click();
    await form.getByRole('button', { name: /^(시작|start)$/i }).click();
    const panel = runUi.panel(page);
    await expect(runUi.progress(panel)).toBeVisible();
    await answer(panel, nth(questions, 0));
    await closeRun(panel);

    await openListButton(page).click();
    const dialog = mockUi.dialog(page);
    const row = resumeRows(dialog);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('원본 풀이');
    await expect(row).toContainText('1/3');
    await expect(row.locator('time')).toBeVisible();
    await expect(resume(row)).toBeVisible();
    await expect(row).not.toContainText(firstOption(nth(questions, 0)).text);
    await expect(mockUi.count(dialog, 0)).toBeVisible();
  },
);

test(
  'UX12-RESUME-AC02 이어 풀기 opens the next unanswered position and closing returns to the list',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-resume-02');
    const ws = await workspaceFactory.create(owner);
    const questions = await createNumberedQuestions(owner, ws.id, 'ux12-resume-02', 3);
    const run = await partialRun(owner, ws.id, questions, 1);
    await signInAs(page, owner.user);
    const dialog = await openList(page, ws.id);
    await resume(resumeRows(dialog)).click();
    const panel = runUi.panel(page);
    await expect(runUi.title(panel, 2)).toBeVisible();
    const url = new URL(page.url()).searchParams;
    expect(url.get('panel')).toBe('mock-exams');
    expect(url.get('practice')).toBe(run.id);
    expect(url.get('i')).toBe('2');

    await runUi.previous(panel).click();
    await expect(runUi.title(panel, 1)).toBeVisible();
    await page.goBack();
    await expect(runUi.title(panel, 2)).toBeVisible();

    await closeRun(panel);
    await expect.poll(() => practiceParam(page)).toBeNull();
    await expect(resumeRows(mockUi.dialog(page))).toHaveCount(1);
  },
);

test(
  'UX12-RESUME-AC03 the row follows the run without a reload and goes when the run ends',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-resume-03');
    const ws = await workspaceFactory.create(owner);
    const questions = await createNumberedQuestions(owner, ws.id, 'ux12-resume-03', 3);
    await partialRun(owner, ws.id, questions, 1);
    await signInAs(page, owner.user);
    const dialog = await openList(page, ws.id);
    const panel = runUi.panel(page);

    await resume(resumeRows(dialog)).click();
    await answer(panel, nth(questions, 1));
    await closeRun(panel);
    await expect(resumeRows(dialog)).toContainText('2/3');

    await resume(resumeRows(dialog)).click();
    await expect(runUi.title(panel, 3)).toBeVisible();
    await answer(panel, nth(questions, 2));
    await runUi.showResults(panel).click();
    await expect(runUi.restart(panel)).toBeVisible();
    await closeRun(panel);
    await expect(resumeRows(dialog)).toHaveCount(0);
  },
);

test(
  'UX12-RESUME-AC04 a chapter run appears under the chapter title',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-resume-04', { studyState: false });
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    await main(page)
      .getByRole('button', { name: new RegExp(`^${CH1} (풀기|practi[sc]e)$`, 'i') })
      .click();
    await page.getByRole('button', { name: /^(시작|start)$/i }).click();
    const panel = runUi.panel(page);
    await answer(panel, nth(s.confirmed, 0));
    await closeRun(panel);

    await openListButton(page).click();
    const dialog = mockUi.dialog(page);
    const row = resumeRows(dialog);
    await expect(row).toContainText(CH1);
    await expect(row).toContainText('1/3');
    await resume(row).click();
    await expect(runUi.progress(panel)).toHaveAttribute('aria-valuetext', /3문제 중 2번째/);
  },
);

test(
  'UX12-RESUME-AC05 the empty text waits for the last unfinished run',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-resume-05');
    const ws = await workspaceFactory.create(owner);
    const questions = await createNumberedQuestions(owner, ws.id, 'ux12-resume-05', 2);
    await partialRun(owner, ws.id, questions, 0);
    await signInAs(page, owner.user);
    const dialog = await openList(page, ws.id);
    await expect(resumeRows(dialog)).toHaveCount(1);
    await expect(mockUi.count(dialog, 0)).toBeVisible();
    await expect(dialog.getByText(MOCK_TEXT.empty)).toHaveCount(0);

    await rowMenu(resumeRows(dialog)).click();
    await remove(page).click();
    await expect(resumeRows(dialog)).toHaveCount(0);
    await expect(dialog.getByText(MOCK_TEXT.empty)).toBeVisible();
  },
);

test(
  'UX12-RESUME-AC06 지우기 removes the row only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-resume-06');
    const ws = await workspaceFactory.create(owner);
    const questions = await createNumberedQuestions(owner, ws.id, 'ux12-resume-06', 3);
    const run = await partialRun(owner, ws.id, questions, 1);
    await signInAs(page, owner.user);
    const dialog = await openList(page, ws.id);
    await rowMenu(resumeRows(dialog)).click();
    await remove(page).click();
    await expect(resumeRows(dialog)).toHaveCount(0);

    await page.reload();
    await expect(mockUi.add(dialog)).toBeVisible();
    await expect(resumeRows(dialog)).toHaveCount(0);
    expect(questionAttemptCount(ws.id)).toBe(1);
    expect((await getPracticeRun(owner, run.id)).body?.finished_at).toBeNull();

    await page.goto(practiceRunPath(ws.id, run.id, 2));
    const panel = runUi.panel(page);
    await expect(runUi.title(panel, 2)).toBeVisible();
    await expect(runUi.option(panel, firstOption(nth(questions, 1)).text)).toBeEnabled();
  },
);

test(
  'UX12-RESUME-AC07 a row is shown to its owner only, in any role and workspace state',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-resume-07', { studyState: false });
    const other = await workspaceFactory.create(s.owner);
    const outsider = await workspaceFactory.member('ux12-resume-07-out');
    const run = await partialRun(s.owner, s.workspaceId, s.confirmed, 1);
    await partialRun(s.viewer, s.workspaceId, s.confirmed, 2);

    await signInAs(page, s.viewer.user);
    let dialog = await openList(page, s.workspaceId);
    await expect(resumeRows(dialog)).toHaveCount(1);
    await expect(resumeRows(dialog)).toContainText('2/5');

    await page.context().clearCookies();
    await signInAs(page, s.owner.user);
    dialog = await openList(page, other.id);
    await expect(resumeRows(dialog)).toHaveCount(0);

    await s.owner.api.ok('POST', `/workspaces/${s.workspaceId}/archive`, undefined, [200]);
    dialog = await openList(page, s.workspaceId);
    await expect(resumeRows(dialog)).toHaveCount(1);
    await expect(resumeRows(dialog)).toContainText('1/5');

    const list = `/workspaces/${s.workspaceId}/practice-runs/unfinished`;
    expect((await outsider.api.request('GET', list)).status).toBe(404);
    const dismiss = await s.viewer.api.request('POST', `/practice-runs/${run.id}/dismiss`);
    expect(dismiss.status).toBe(404);
  },
);

test(
  'UX12-RESUME-AC08 a saved mock exam run keeps to its own row',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-resume-08');
    const ws = await workspaceFactory.create(owner);
    const questions = await createNumberedQuestions(owner, ws.id, 'ux12-resume-08', 2);
    const exam = await createShuffleMockExam(
      owner,
      ws.id,
      '중간 점검',
      questions.map((q) => q.id),
      2,
    );
    await createPracticeRun(owner, ws.id, {
      source: 'mock',
      mock_exam_id: exam.id,
      range: { all: true },
      random_order: false,
    });
    await signInAs(page, owner.user);
    const dialog = await openList(page, ws.id);
    await expect(mockUi.count(dialog, 1)).toBeVisible();
    await expect(mockUi.row(dialog, '중간 점검')).toBeVisible();
    await expect(resumeList(dialog)).toHaveCount(0);
  },
);

test(
  'UX12-RESUME-AC09 runs without a live question show nothing and others skip gone positions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-resume-09');
    const ws = await workspaceFactory.create(owner);
    const questions = await createNumberedQuestions(owner, ws.id, 'ux12-resume-09', 3);
    const gone = nth(questions, 0);
    const skipped = nth(questions, 1);
    await partialRun(owner, ws.id, [gone], 0);
    await partialRun(owner, ws.id, [skipped, nth(questions, 2)], 0);
    await archiveQuestion(owner, gone);
    await archiveQuestion(owner, skipped);

    await signInAs(page, owner.user);
    const dialog = await openList(page, ws.id);
    await expect(resumeRows(dialog)).toHaveCount(1);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await resume(resumeRows(dialog)).click();
    await expect(runUi.progress(runUi.panel(page))).toHaveAttribute(
      'aria-valuetext',
      /2문제 중 2번째/,
    );
  },
);
