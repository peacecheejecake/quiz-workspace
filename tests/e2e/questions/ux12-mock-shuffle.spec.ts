// UX12-MOCKSHUFFLE (docs/screens/ux12-mock-shuffle.md): 보기 섞기 is drawn per run and kept inside
// one run; 보기 섞기 only saves at once, without a job. Contract half:
// tests/integration/questions/mock_exams/test_mock_exams_contract.py (UX12-MOCKSHUFFLE-C01~C06).
import type { Locator, Page } from '@playwright/test';
import {
  ALL,
  CH1,
  createMockExam,
  getMockExam,
  listMockQuestions,
  mockExamsPath,
  mockSource,
  mockSourceInput,
  mockUi,
  MOCK_TEXT,
  NORMAL_SOURCES,
  STATUS_TEXT,
  VARIATION_LABEL,
  waitForMockExam,
  type MockExam,
} from '../fixtures/mock-exams.ts';
import {
  createPracticeRun,
  goToResults,
  mockAttemptCount,
  practiceParam,
  practiceRunPath,
  questionAttemptCount,
  runItem,
  runUi,
} from '../fixtures/practice-runs.ts';
import { rangePickerUi as picker } from '../fixtures/range-picker.ts';
import {
  createNumberedQuestions,
  createQuestion,
  expect,
  homePath,
  outlineNodeId,
  RESULT_TEXT,
  signInAs,
  test,
  uploadReadyBook,
  type E2EFixtures,
  type Member,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

type Factory = E2EFixtures['workspaceFactory'];

const QUESTIONS = 4;

async function seedShuffleExam(factory: Factory, label: string) {
  const owner = await factory.member(label);
  const workspace = await factory.create(owner);
  const sources = await createNumberedQuestions(owner, workspace.id, label, QUESTIONS);
  const exam = await createMockExam(owner, workspace.id, '섞기 시험', {
    variation_types: ['OPTION_SHUFFLE'],
    question_count: QUESTIONS,
  });
  return { owner, workspaceId: workspace.id, sources, exam };
}

function startRun(owner: Member, workspaceId: string, exam: MockExam, seed: number) {
  return createPracticeRun(owner, workspaceId, {
    source: 'mock',
    mock_exam_id: exam.id,
    range: ALL,
    random_order: false,
    seed,
  });
}

/** Option texts of every position of a run, as the API shows them. */
async function runOptions(member: Member, runId: string, total: number): Promise<string[][]> {
  const out: string[][] = [];
  for (let k = 1; k <= total; k += 1) {
    const item = await runItem(member, runId, k);
    out.push((item.options ?? []).map((o) => o.text));
  }
  return out;
}

/** The option texts as the panel shows them, top to bottom. */
async function shownOrder(panel: Locator, texts: readonly string[]): Promise<string[]> {
  const rows = await Promise.all(
    texts.map(async (text) => {
      const box = await runUi.option(panel, text).boundingBox();
      if (!box) throw new Error(`no option ${text}`);
      return { text, y: box.y };
    }),
  );
  return rows.sort((a, b) => a.y - b.y).map((row) => row.text);
}

async function openRun(page: Page, workspaceId: string, runId: string, k = 1): Promise<Locator> {
  await page.goto(practiceRunPath(workspaceId, runId, k));
  const panel = runUi.panel(page);
  await expect(runUi.mockTitle(panel, k)).toBeVisible();
  return panel;
}

test(
  'UX12-MOCKSHUFFLE-AC01 보기 섞기 only is ready at once in the source order, and remakes at once',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-shuffle-01');
    const workspace = await workspaceFactory.create(owner);
    const sources = await createNumberedQuestions(owner, workspace.id, 'ux12-shuffle-01', 3);
    await signInAs(page, owner.user);
    await page.goto(homePath(workspace.id, 'panel=mock-exams&mock=new'));
    const dialog = mockUi.dialog(page);

    // A held-open poll would show 만드는 중: the page must never read a generating mock exam.
    const statuses: string[] = [];
    page.on('response', (response) => {
      if (!/\/api\/(workspaces\/[^/]+\/)?mock-exams(\/[^/]+)?(\?|$)/.test(response.url())) return;
      void response
        .json()
        .then((body: { status?: string }) => body.status && statuses.push(body.status))
        .catch(() => undefined);
    });

    await picker.selectAll(dialog).check();
    await mockUi.next(dialog).click();
    await mockUi.variation(dialog, 'OPTION_SHUFFLE').check();
    await mockUi.title(dialog).fill('바로 시험');
    await mockUi.questionCount(dialog).fill('3');
    await mockUi.make(dialog).click();

    await expect(mockUi.heading(dialog, '바로 시험')).toBeVisible();
    await expect(dialog.getByText(STATUS_TEXT.ready).first()).toBeVisible();
    await expect(mockUi.questions(dialog)).toHaveCount(3);
    await expect(mockUi.progress(dialog)).toHaveCount(0);
    expect(statuses).not.toContain('generating');

    const [listed] = (
      await owner.api.ok<{ items: MockExam[] }>(
        'GET',
        `/workspaces/${workspace.id}/mock-exams`,
        undefined,
        [200],
      )
    ).items;
    if (!listed) throw new Error('no mock exam');
    expect(listed.latest_generation?.job_id).toBeNull();
    const made = await listMockQuestions(owner, listed.id);
    for (const q of made) {
      const source = sources.find((s) => s.id === q.source.question_id);
      expect(q.options.map((o) => o.id)).toEqual(source?.revision.options.map((o) => o.id));
    }

    await mockUi.backToList(dialog).click();
    const row = mockUi.row(dialog, '바로 시험');
    await expect(row).toContainText(STATUS_TEXT.ready);
    await expect(row).toContainText(VARIATION_LABEL.OPTION_SHUFFLE);

    // 다시 만들기: the next round replaces the questions without a 만드는 중 state.
    await page.goto(mockExamsPath(workspace.id, listed.id));
    await mockUi.chooseDetailAction(dialog, 'remake');
    await mockUi.confirmButton(mockUi.confirm(page)).click();
    await expect(dialog).toContainText(/2회차|round 2/i);
    await expect(mockUi.questions(dialog)).toHaveCount(3);
    await expect(mockUi.progress(dialog)).toHaveCount(0);
    await expect(dialog.getByText(MOCK_TEXT.made)).toHaveCount(1);
    expect(statuses).not.toContain('generating');
  },
);

test(
  'UX12-MOCKSHUFFLE-AC02 one run keeps its order on reload, 이전 문제 and submit, and records only mock attempts',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedShuffleExam(workspaceFactory, 'ux12-shuffle-02');
    const questions = await listMockQuestions(s.owner, s.exam.id);
    const run = await startRun(s.owner, s.workspaceId, s.exam, 31);
    const expected = await runOptions(s.owner, run.id, QUESTIONS);
    const first = expected[0] ?? [];
    const second = expected[1] ?? [];
    const stored = questions.map((q) => q.options.map((o) => o.text));
    expect(expected, 'the run draws its own order').not.toEqual(stored);

    await signInAs(page, s.owner.user);
    let panel = await openRun(page, s.workspaceId, run.id);
    expect(await shownOrder(panel, first)).toEqual(first);

    await page.reload();
    panel = runUi.panel(page);
    await expect(runUi.mockTitle(panel, 1)).toBeVisible();
    expect(await shownOrder(panel, first)).toEqual(first);

    await runUi.next(panel).click();
    await expect(runUi.mockTitle(panel, 2)).toBeVisible();
    expect(await shownOrder(panel, second)).toEqual(second);
    await runUi.previous(panel).click();
    await expect(runUi.mockTitle(panel, 1)).toBeVisible();
    expect(await shownOrder(panel, first)).toEqual(first);

    // The source's first option is the answer, wherever this run shows it.
    const question = questions[0];
    const answer = question?.options.find((o) => question.correct_option_ids?.includes(o.id))?.text;
    if (!answer) throw new Error('no answer');
    await runUi.option(panel, answer).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(await shownOrder(panel, first)).toEqual(first);
    await page.reload();
    panel = runUi.panel(page);
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(await shownOrder(panel, first)).toEqual(first);

    expect(mockAttemptCount(s.exam.id)).toBe(1);
    expect(questionAttemptCount(s.workspaceId)).toBe(0);
  },
);

test(
  'UX12-MOCKSHUFFLE-AC03 a new run and 처음부터 다시 draw a new order',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedShuffleExam(workspaceFactory, 'ux12-shuffle-03');
    const run = await startRun(s.owner, s.workspaceId, s.exam, 41);
    const firstDraw = await runOptions(s.owner, run.id, QUESTIONS);
    const other = await startRun(s.owner, s.workspaceId, s.exam, 42);
    expect(await runOptions(s.owner, other.id, QUESTIONS)).not.toEqual(firstDraw);

    await signInAs(page, s.owner.user);
    const panel = await openRun(page, s.workspaceId, run.id);
    await goToResults(panel, QUESTIONS);
    // The test server's own seed is fixed, so the restart's request carries one.
    await page.route(/\/practice-runs$/, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.continue({ postData: JSON.stringify({ ...body, seed: 43 }) });
    });
    await runUi.restart(panel).click();
    await expect.poll(() => practiceParam(page)).not.toBe(run.id);
    const again = practiceParam(page) ?? '';
    await expect(runUi.mockTitle(runUi.panel(page), 1)).toBeVisible();

    const redrawn = await runOptions(s.owner, again, QUESTIONS);
    expect(redrawn).not.toEqual(firstDraw);
    const shown = redrawn[0] ?? [];
    expect(await shownOrder(runUi.panel(page), shown)).toEqual(shown);
  },
);

test(
  'UX12-MOCKSHUFFLE-AC04 a mixed mock exam is made ahead and shuffles only its 보기 섞기 questions per run',
  { tag: '@infra' },
  async ({ workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-shuffle-04');
    const workspace = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, workspace.id, 'book-ko');
    const chapter = await outlineNodeId(owner, documentId, CH1);
    for (const [i, name] of NORMAL_SOURCES.entries()) {
      const chapterId = mockSource(name).chapter === 1 ? chapter : null;
      await createQuestion(
        owner,
        workspace.id,
        mockSourceInput(name, documentId, i + 1, chapterId),
      );
    }
    const started = await createMockExam(owner, workspace.id, '혼합 시험', {
      variation_types: ['OPTION_SHUFFLE', 'PARAPHRASE'],
      question_count: QUESTIONS,
    });
    expect(started.latest_generation?.job_id).toBeTruthy();
    expect((await waitForMockExam(owner, started.id)).status).toBe('ready');
    const exam = await getMockExam(owner, started.id);
    const questions = await listMockQuestions(owner, exam.id);
    expect(new Set(questions.map((q) => q.variation_type))).toEqual(
      new Set(['OPTION_SHUFFLE', 'PARAPHRASE']),
    );

    const draws = await Promise.all(
      [51, 52, 53].map(async (seed) => {
        const run = await startRun(owner, workspace.id, exam, seed);
        return runOptions(owner, run.id, QUESTIONS);
      }),
    );
    for (const [i, question] of questions.entries()) {
      const stored = question.options.map((o) => o.text);
      const shown = draws.map((draw) => draw[i] ?? []);
      if (question.variation_type === 'OPTION_SHUFFLE') {
        expect(new Set(shown.map((order) => order.join('|'))).size).toBeGreaterThan(1);
        expect(new Set(shown[0])).toEqual(new Set(stored));
      } else {
        for (const order of shown) expect(order).toEqual(stored);
      }
    }
  },
);
