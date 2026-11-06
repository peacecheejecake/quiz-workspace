// UX12-MOCKRESUME (docs/screens/ux12-mock-resume.md): the caller's unfinished run on a saved mock
// exam's row and detail. Contract half:
// tests/integration/questions/practice_runs/test_practice_runs_contract.py (UX12-MOCKRESUME).
import type { Locator, Page } from '@playwright/test';
import { mockUi } from '../fixtures/mock-exams.ts';
import {
  closeUnfinishedRun,
  createPracticeRun,
  createShuffleMockExam,
  getPracticeRun,
  mockAttemptCount,
  practiceParam,
  practiceRunPath,
  questionAttemptCount,
  runItem,
  runUi,
  seedRangeWorkspace,
  type PracticeRun,
} from '../fixtures/practice-runs.ts';
import {
  createNumberedQuestions,
  expect,
  homePath,
  seedMembership,
  signInAs,
  test,
  type Member,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

interface Exam {
  readonly id: string;
  readonly title: string;
}

// The list row's button is a plain 풀기; the detail's keeps `이어 풀기 3/10`.
const resumeButton = (scope: Locator, progress: string) =>
  scope.getByRole('button', { name: new RegExp(`이어 풀기 ${progress}$`) });
// The row's title starts or resumes the run: the list has no 풀기 button.
const rowResume = (row: Locator, title: string) => mockUi.open(row, title);
const anyResume = (scope: Locator) => scope.getByRole('button', { name: /이어 풀기/ });
const menuItem = (page: Page, name: RegExp) => mockUi.menuAction(page, name);

async function seedExam(
  owner: Member,
  workspaceId: string,
  label: string,
  count: number,
): Promise<Exam> {
  const questions = await createNumberedQuestions(owner, workspaceId, label, count);
  return createShuffleMockExam(
    owner,
    workspaceId,
    label,
    questions.map((q) => q.id),
    count,
  );
}

function startRun(member: Member, workspaceId: string, exam: Exam): Promise<PracticeRun> {
  return createPracticeRun(member, workspaceId, {
    source: 'mock',
    mock_exam_id: exam.id,
    range: { all: true },
    random_order: false,
  });
}

/** Submits positions `from`..`to` through the mock practice routes, first option each. */
async function answer(member: Member, run: PracticeRun, from: number, to: number): Promise<void> {
  for (let position = from; position <= to; position += 1) {
    const item = await runItem(member, run.id, position);
    const session = await member.api.ok<{ id: string }>(
      'POST',
      `/mock-exam-questions/${item.question_id}/practice-sessions`,
      { practice_run_id: run.id, run_position: position },
      [201],
    );
    await member.api.ok(
      'POST',
      `/mock-practice-sessions/${session.id}/submit`,
      { selected_option_ids: [item.options?.[0]?.id] },
      [200],
    );
  }
}

async function openList(page: Page, workspaceId: string): Promise<Locator> {
  await page.goto(homePath(workspaceId, 'panel=mock-exams'));
  const dialog = mockUi.dialog(page);
  await expect(mockUi.add(dialog)).toBeVisible();
  return dialog;
}

async function openDetail(page: Page, workspaceId: string, exam: Exam): Promise<Locator> {
  await page.goto(homePath(workspaceId, `panel=mock-exams&mock=${exam.id}`));
  const dialog = mockUi.dialog(page);
  await expect(dialog.getByRole('heading', { name: exam.title })).toBeVisible();
  return dialog;
}

async function pickFromRowMenu(page: Page, row: Locator, title: string, name: RegExp) {
  await mockUi.rowMenu(row, title).click();
  await menuItem(page, name).click();
}

test(
  'UX12-MOCKRESUME-AC01 a row has no button but its title and keeps 처음부터 풀기 in its menu',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-mres-01');
    const ws = await workspaceFactory.create(owner);
    const exam = await seedExam(owner, ws.id, 'ux12-mres-01', 4);
    const idle = await seedExam(owner, ws.id, 'ux12-mres-01b', 2);
    await answer(owner, await startRun(owner, ws.id, exam), 1, 3);
    await signInAs(page, owner.user);
    const dialog = await openList(page, ws.id);

    const row = mockUi.row(dialog, exam.title);
    await expect(rowResume(row, exam.title)).toBeVisible();
    await expect(row).toContainText('3/4');
    await expect(row.getByText('모의고사', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: /풀기|practi[cs]e/i })).toHaveCount(0);
    await expect(mockUi.rowTitle(mockUi.row(dialog, idle.title))).toBeVisible();
    await expect(mockUi.row(dialog, idle.title)).toContainText('0/2');

    await pickFromRowMenu(page, row, exam.title, /^(처음부터 풀기|practi[cs]e from the start)$/i);
    const panel = runUi.panel(page);
    await expect(runUi.start(panel)).toBeVisible();
    expect(new URL(page.url()).searchParams.get('practice')).toBe('new');
  },
);

test(
  'UX12-MOCKRESUME-AC02 the detail shows one button and moves 풀기 to 더보기',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-mres-02');
    const ws = await workspaceFactory.create(owner);
    const exam = await seedExam(owner, ws.id, 'ux12-mres-02', 3);
    await answer(owner, await startRun(owner, ws.id, exam), 1, 1);
    await signInAs(page, owner.user);
    const dialog = await openDetail(page, ws.id, exam);

    await expect(resumeButton(dialog, '1/3')).toBeVisible();
    await expect(mockUi.practise(dialog)).toHaveCount(0);
    await dialog.getByRole('button', { name: /^(더보기|more)$/i }).click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([
      '풀기',
      '이어 풀기 지우기',
      '설정 바꾸기',
      '다시 만들기',
      '이름 바꾸기',
      '삭제',
    ]);
  },
);

test(
  'UX12-MOCKRESUME-AC03 이어 풀기 opens the next position and closing returns where it opened',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-mres-03');
    const ws = await workspaceFactory.create(owner);
    const exam = await seedExam(owner, ws.id, 'ux12-mres-03', 4);
    const run = await startRun(owner, ws.id, exam);
    await answer(owner, run, 1, 1);
    await signInAs(page, owner.user);
    const panel = runUi.panel(page);

    // From the list.
    const dialog = await openList(page, ws.id);
    await rowResume(mockUi.row(dialog, exam.title), exam.title).click();
    await expect(runUi.mockTitle(panel, 2)).toBeVisible();
    const url = new URL(page.url()).searchParams;
    expect(url.get('practice')).toBe(run.id);
    expect(url.get('i')).toBe('2');
    expect(url.get('mock')).toBeNull();
    await closeUnfinishedRun(panel);
    await expect(panel).toHaveCount(0);
    await expect(mockUi.row(dialog, exam.title)).toContainText('1/4');

    // From the detail: `mock` stays the dialog's view, and the progress follows without a reload.
    await mockUi.openDetail(mockUi.row(dialog, exam.title), exam.title);
    await resumeButton(dialog, '1/4').click();
    await expect(runUi.mockTitle(panel, 2)).toBeVisible();
    expect(new URL(page.url()).searchParams.get('mock')).toBe(exam.id);
    const item = await runItem(owner, run.id, 2);
    await runUi.option(panel, item.options?.[0]?.text ?? '').check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toBeVisible();
    await closeUnfinishedRun(panel);
    await expect(panel).toHaveCount(0);
    await expect.poll(() => practiceParam(page)).toBeNull();
    expect(new URL(page.url()).searchParams.get('mock')).toBe(exam.id);
    await expect(resumeButton(dialog, '2/4')).toBeVisible();
  },
);

test(
  'UX12-MOCKRESUME-AC04 the options keep their order when the run is resumed',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-mres-04');
    const ws = await workspaceFactory.create(owner);
    const exam = await seedExam(owner, ws.id, 'ux12-mres-04', 3);
    const run = await startRun(owner, ws.id, exam);
    await answer(owner, run, 1, 1);
    await signInAs(page, owner.user);
    const shown = (panel: Locator) =>
      panel
        .getByRole('radio')
        .evaluateAll((radios) => radios.map((r) => r.closest('label')?.textContent));
    const panel = runUi.panel(page);

    const dialog = await openList(page, ws.id);
    await rowResume(mockUi.row(dialog, exam.title), exam.title).click();
    await expect(runUi.mockTitle(panel, 2)).toBeVisible();
    await expect(panel.getByRole('radio').first()).toBeVisible();
    const before = await shown(panel);
    await closeUnfinishedRun(panel);
    await expect(panel).toHaveCount(0);

    await rowResume(mockUi.row(dialog, exam.title), exam.title).click();
    await expect(runUi.mockTitle(panel, 2)).toBeVisible();
    await expect(panel.getByRole('radio').first()).toBeVisible();
    expect(await shown(panel)).toEqual(before);
  },
);

test(
  'UX12-MOCKRESUME-AC05 removed questions, a new round and a deleted exam leave no error',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-mres-05');
    const ws = await workspaceFactory.create(owner);
    const exam = await seedExam(owner, ws.id, 'ux12-mres-05', 3);
    const run = await startRun(owner, ws.id, exam);
    await answer(owner, run, 1, 1);
    await signInAs(page, owner.user);
    const panel = runUi.panel(page);
    const take = async (position: number) => {
      const item = await runItem(owner, run.id, position);
      await owner.api.ok('DELETE', `/mock-exam-questions/${item.question_id}`, undefined, [204]);
    };

    await take(2);
    let dialog = await openList(page, ws.id);
    await rowResume(mockUi.row(dialog, exam.title), exam.title).click();
    await expect(runUi.mockTitle(panel, 3)).toBeVisible();
    await closeUnfinishedRun(panel);
    await expect(panel).toHaveCount(0);

    // A new round: 풀기 alone, and the old run still opens by its URL.
    await owner.api.ok('POST', `/mock-exams/${exam.id}/generations`, {}, [202]);
    dialog = await openList(page, ws.id);
    await expect(mockUi.rowTitle(mockUi.row(dialog, exam.title))).toBeVisible();
    await expect(mockUi.row(dialog, exam.title)).toContainText(/\b0\/\d+/);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await page.goto(practiceRunPath(ws.id, run.id, 3));
    await expect(runUi.mockTitle(panel, 3)).toBeVisible();

    await owner.api.ok('DELETE', `/mock-exams/${exam.id}`, undefined, [204]);
    dialog = await openList(page, ws.id);
    await expect(mockUi.count(dialog, 0)).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  },
);

test(
  'UX12-MOCKRESUME-AC06 ending a run brings the older one and then 풀기 back',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-mres-06');
    const ws = await workspaceFactory.create(owner);
    const exam = await seedExam(owner, ws.id, 'ux12-mres-06', 2);
    const older = await startRun(owner, ws.id, exam);
    await answer(owner, older, 1, 1);
    const newer = await startRun(owner, ws.id, exam);
    await answer(owner, newer, 1, 1);
    await owner.api.ok('POST', `/practice-runs/${newer.id}/finish`, undefined, [200]);
    await signInAs(page, owner.user);

    let dialog = await openList(page, ws.id);
    await rowResume(mockUi.row(dialog, exam.title), exam.title).click();
    const panel = runUi.panel(page);
    await expect(runUi.mockTitle(panel, 2)).toBeVisible();
    expect(practiceParam(page)).toBe(older.id);

    await answer(owner, older, 2, 2);
    dialog = await openList(page, ws.id);
    await expect(mockUi.rowTitle(mockUi.row(dialog, exam.title))).toBeVisible();
    await expect(mockUi.row(dialog, exam.title)).toContainText(/\b0\/\d+/);
  },
);

test(
  'UX12-MOCKRESUME-AC07 이어 풀기 지우기 on the detail drops the run and the row no longer offers it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-mres-07');
    const ws = await workspaceFactory.create(owner);
    const exam = await seedExam(owner, ws.id, 'ux12-mres-07', 3);
    const run = await startRun(owner, ws.id, exam);
    await answer(owner, run, 1, 1);
    await signInAs(page, owner.user);
    let dialog = await openList(page, ws.id);
    let row = mockUi.row(dialog, exam.title);

    await mockUi.rowMenu(row, exam.title).click();
    await expect(menuItem(page, /^이어 풀기 지우기$/)).toHaveCount(0);
    await page.keyboard.press('Escape');

    dialog = await openDetail(page, ws.id, exam);
    await dialog.getByRole('button', { name: /^(더보기|more)$/i }).click();
    await menuItem(page, /^이어 풀기 지우기$/).click();
    await expect(mockUi.practise(dialog)).toBeVisible();
    dialog = await openList(page, ws.id);
    row = mockUi.row(dialog, exam.title);
    await expect(mockUi.rowTitle(row)).toBeVisible();
    await expect(row).toContainText(/\b0\/\d+/);
    expect(mockAttemptCount(exam.id)).toBe(1);
    expect((await getPracticeRun(owner, run.id)).body?.finished_at).toBeNull();
  },
);

test(
  'UX12-MOCKRESUME-AC08 a run shows to its owner only, in any role and workspace state',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-mres-08', { studyState: false });
    const editor = await workspaceFactory.member('ux12-mres-08-b');
    const outsider = await workspaceFactory.member('ux12-mres-08-out');
    seedMembership(s.workspaceId, editor.user.id, 'editor');
    const attemptsBefore = questionAttemptCount(s.workspaceId);
    const exam = await createShuffleMockExam(
      s.owner,
      s.workspaceId,
      'ux12-mres-08',
      s.confirmed.map((q) => q.id),
      3,
    );
    await answer(s.viewer, await startRun(s.viewer, s.workspaceId, exam), 1, 2);

    await signInAs(page, editor.user);
    let dialog = await openList(page, s.workspaceId);
    await expect(mockUi.rowTitle(mockUi.row(dialog, exam.title))).toBeVisible();
    await expect(anyResume(dialog)).toHaveCount(0);

    await page.context().clearCookies();
    await signInAs(page, s.viewer.user);
    await s.owner.api.ok('POST', `/workspaces/${s.workspaceId}/archive`, undefined, [200]);
    dialog = await openList(page, s.workspaceId);
    await expect(mockUi.row(dialog, exam.title)).toContainText('2/3');

    const list = `/workspaces/${s.workspaceId}/mock-exams`;
    expect((await outsider.api.request('GET', list)).status).toBe(404);
    expect(mockAttemptCount(exam.id)).toBe(2);
    expect(questionAttemptCount(s.workspaceId)).toBe(attemptsBefore);
  },
);
