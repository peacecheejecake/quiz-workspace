// M7.2 accessibility of the mock exam screens and the QuestionViewer range practice (MOCK-X):
// axe in the light and dark theme (fixtures/a11y.ts) on MOCK-01 (list, the two create steps, the
// detail while generating / failed / partly made / in its second round, the per-question manage
// dialog and its edit form, the confirm dialogs) and QVIEW-01 (range step with a tri-state
// 전체 선택, the status filter, a virtualized chapter, solving, graded, results, and a run of a mock
// exam), plus a keyboard-only path through creating and practising each.
//
// The manage dialog, graded positions and the mock exam questions carry answers and explanations
// (synthetic text only): no trace/screenshot/video and no page text on failure; axe reports only
// rule ids, CSS targets and axe's own summaries. Mock exams come from the APP_ENV=test batched
// scenario fake (fixtures/mock-exams.ts K4–K6; the stack runs with WORKER_MOCK_EXAMS=true).
import type { Locator, Page } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import {
  CH1,
  CH2,
  createMockExam,
  MOCK_TEXT,
  MOCK_TIMEOUT_MS,
  MockHold,
  mockExamsPath,
  mockSource,
  mockSourceInput,
  mockUi,
  NORMAL_SOURCES,
  questionRow,
  questionsRange,
  STATUS_TEXT,
  waitForMockExam,
  type MockSourceName,
} from '../fixtures/mock-exams.ts';
import {
  createShuffleMockExam,
  goToResults,
  openRangePicker,
  runUi,
} from '../fixtures/practice-runs.ts';
import { openRangeFilters, rangePickerUi as picker } from '../fixtures/range-picker.ts';
import { expect, NO_VISUAL_ARTIFACTS, test } from '../fixtures/sharing.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';
import {
  createNumberedQuestions,
  createQuestion,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  mcqInput,
  numberedMcq,
  outlineNodeId,
  questionFormUi,
  RESULT_TEXT,
  signInAs,
  uploadReadyBook,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ ...NO_VISUAL_ARTIFACTS, attachPageTextOnFailure: false });
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 3 * MOCK_TIMEOUT_MS + 60_000 });

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

async function openHome(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(homePath(workspaceId));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

/** Presses `key` (Tab by default) until `target` has focus; fails after `max` presses. */
async function keyTo(page: Page, target: Locator, key = 'Tab', max = 60): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(key);
  }
  await expect(target, `reached by ${key} alone`).toBeFocused();
}

/** Opens the primary practice flow using the keyboard. */
async function openPlayByKeyboard(page: Page): Promise<Locator> {
  const play = page.getByRole('button', { name: /^모의고사$/ });
  await keyTo(page, play);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: /모의고사|mock exam/i });
  await expect(dialog).toBeVisible();
  await keyTo(page, mockUi.add(dialog));
  await page.keyboard.press('Enter');
  await expect(mockUi.next(dialog)).toBeVisible();
  return dialog;
}

/** Sets a checkbox reached by Tab to `checked` with Space only. */
async function spaceTo(page: Page, box: Locator, checked: boolean): Promise<void> {
  await keyTo(page, box);
  if ((await box.isChecked()) !== checked) await page.keyboard.press('Space');
  if (checked) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
}

interface BookWorkspace {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly ch1: string;
  readonly ch2: string;
}

async function bookWorkspace(
  workspaceFactory: WorkspaceFactory,
  label: string,
): Promise<BookWorkspace> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  return {
    owner,
    workspaceId: ws.id,
    documentId,
    ch1: await outlineNodeId(owner, documentId, CH1),
    ch2: await outlineNodeId(owner, documentId, CH2),
  };
}

async function seed(
  s: BookWorkspace,
  names: readonly MockSourceName[],
  first: number,
  hold?: MockHold,
): Promise<Question[]> {
  const out: Question[] = [];
  for (const [i, name] of names.entries()) {
    const chapter = mockSource(name).chapter;
    const chapterId = chapter === 1 ? s.ch1 : chapter === 2 ? s.ch2 : null;
    out.push(
      await createQuestion(
        s.owner,
        s.workspaceId,
        mockSourceInput(name, s.documentId, first + i, chapterId, hold),
      ),
    );
  }
  return out;
}

const ids = (qs: readonly Question[]) => qs.map((q) => q.id);

test(
  'A11Y-14 모의고사 list, both create steps, detail (generating, failed, partly made, round 2), the manage dialog and the confirm dialogs',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    // An empty list first (no book needed).
    const lonely = await workspaceFactory.member('a11y14-empty');
    const empty = await workspaceFactory.create(lonely);
    await openHome(page, lonely, empty.id);
    await page.goto(mockExamsPath(empty.id));
    let dialog = mockUi.dialog(page);
    await expect(dialog.getByText(MOCK_TEXT.empty)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'mock exams list, empty');

    const s = await bookWorkspace(workspaceFactory, 'a11y14');
    const normal = await seed(s, NORMAL_SOURCES.slice(0, 4), 1);
    const inversions = await seed(s, ['inv-runoff', 'inv-filtration', 'inv-multi'], 5);
    const failing = await seed(s, ['fail-quote', 'fail-answer'], 8);
    const hold = new MockHold();
    const held = await seed(s, ['flocculation'], 10, hold);
    try {
      const ready = await createMockExam(
        s.owner,
        s.workspaceId,
        '중간 점검',
        { variation_types: ['PARAPHRASE'], question_count: 4 },
        questionsRange(...ids(normal)),
      );
      const partial = await createMockExam(
        s.owner,
        s.workspaceId,
        '정오 반전 점검',
        { variation_types: ['INVERT_POLARITY'], question_count: 3 },
        questionsRange(...ids(inversions)),
      );
      const failed = await createMockExam(
        s.owner,
        s.workspaceId,
        '전부 실패 점검',
        { variation_types: ['PARAPHRASE'], question_count: 2 },
        questionsRange(...ids(failing)),
      );
      expect((await waitForMockExam(s.owner, ready.id)).status).toBe('ready');
      expect((await waitForMockExam(s.owner, partial.id)).status).toBe('partial');
      expect((await waitForMockExam(s.owner, failed.id)).status).toBe('failed');
      // A second round of the ready one (same settings).
      await s.owner.api.ok('POST', `/mock-exams/${ready.id}/generations`, {}, [202]);
      expect((await waitForMockExam(s.owner, ready.id)).current_generation?.version).toBe(2);
      const generating = await createMockExam(
        s.owner,
        s.workspaceId,
        '만드는 중 점검',
        { variation_types: ['PARAPHRASE'], question_count: 1 },
        questionsRange(...ids(held)),
      );
      await hold.held();

      // List with every status, the progress bar and a row menu.
      await page.context().clearCookies();
      await openHome(page, s.owner, s.workspaceId);
      await page.goto(mockExamsPath(s.workspaceId));
      dialog = mockUi.dialog(page);
      await expect(mockUi.rows(dialog)).toHaveCount(4);
      await expect(mockUi.progress(dialog)).toBeVisible();
      await settle(page);
      await expectAccessible(page, 'mock exams list with ready, partial, failed and generating');
      const readyRow = mockUi.row(dialog, '중간 점검');
      await mockUi.rowMenu(readyRow, '중간 점검').click();
      await expect(mockUi.menuAction(page, /^(이름 바꾸기|rename)$/i)).toBeVisible();
      await expectAccessible(page, 'mock exam row menu');
      // Inline rename field, cancelled by keyboard with its 취소 button.
      await mockUi.menuAction(page, /^(이름 바꾸기|rename)$/i).click();
      await expect(mockUi.renameField(dialog)).toBeFocused();
      await expectAccessible(page, 'mock exam inline rename');
      await keyTo(page, dialog.getByRole('button', { name: /^(취소|cancel)$/i }));
      await page.keyboard.press('Enter');
      await expect(mockUi.renameField(dialog)).toHaveCount(0);

      // Create, step 1 (options) and step 2 (range, AI notice, filters open).
      await mockUi.add(dialog).click();
      await expect(mockUi.steps(dialog)).toBeVisible();
      await expect(mockUi.variations(dialog)).toHaveCount(4);
      await settle(page);
      await expectAccessible(page, 'mock exam create, options step');
      await mockUi.variation(dialog, 'PARAPHRASE').check();
      await mockUi.title(dialog).fill('접근성 점검');
      await mockUi.next(dialog).click();
      await expect(picker.selectAll(dialog)).toBeVisible();
      await expect(mockUi.make(dialog)).toBeDisabled();
      await expect(dialog.getByText(MOCK_TEXT.noRange)).toBeVisible();
      await expectAccessible(page, 'mock exam create, range step with nothing selected');
      await picker.chapter(dialog, CH1).check();
      await picker.expand(dialog, CH1).click();
      await picker.question(dialog, 1, 1).uncheck();
      await expect(picker.selectAll(dialog)).toHaveAttribute('aria-checked', 'mixed');
      await openRangeFilters(dialog);
      await expect(dialog.getByText(MOCK_TEXT.aiNotice)).toBeVisible();
      await expectAccessible(page, 'mock exam create, range step mixed with filters and AI notice');
      await mockUi.backToOptions(dialog).click();
      await mockUi.backToList(dialog).click();

      // Detail while generating (held), then failed, partly made and round 2.
      await mockUi.open(mockUi.row(dialog, '만드는 중 점검'), '만드는 중 점검').click();
      await expect(dialog.getByText(MOCK_TEXT.working)).toBeVisible();
      await expect(mockUi.progress(dialog)).toBeVisible();
      await expectAccessible(page, 'mock exam detail while generating');
      hold.release();
      await expect(dialog.getByText(STATUS_TEXT.ready).first()).toBeVisible({
        timeout: MOCK_TIMEOUT_MS,
      });
      await waitForMockExam(s.owner, generating.id);

      await page.goto(mockExamsPath(s.workspaceId, failed.id));
      dialog = mockUi.dialog(page);
      await expect(mockUi.alert(dialog)).toContainText(MOCK_TEXT.noValid);
      await expect(mockUi.retry(dialog)).toBeVisible();
      await settle(page);
      await expectAccessible(page, 'mock exam detail failed with 다시 시도');

      await page.goto(mockExamsPath(s.workspaceId, partial.id));
      await expect(dialog.getByText(STATUS_TEXT.partial).first()).toBeVisible();
      await expect(mockUi.questions(dialog)).toHaveCount(2);
      await settle(page);
      await expectAccessible(page, 'mock exam detail partly made');

      await page.goto(mockExamsPath(s.workspaceId, ready.id));
      await expect(dialog).toContainText(/2회차|round 2/i);
      await expect(mockUi.questions(dialog)).toHaveCount(4);
      await settle(page);
      await expectAccessible(page, 'mock exam detail in round 2 with its questions');

      // The 더보기 menu, then its 다시 만들기 and 삭제 confirmations (both cancelled).
      await mockUi.more(dialog).click();
      await expect(mockUi.detailAction(page, 'remake')).toBeVisible();
      await expectAccessible(page, 'mock exam detail menu');
      await mockUi.detailAction(page, 'remake').click();
      let confirm = mockUi.confirm(page);
      await expect(confirm).toContainText(MOCK_TEXT.replaceConfirm);
      await expectAccessible(page, 'mock exam regenerate confirmation');
      await page.keyboard.press('Escape');
      await expect(confirm).toHaveCount(0);
      await mockUi.chooseDetailAction(dialog, 'delete');
      confirm = mockUi.confirm(page);
      await expect(confirm).toContainText(/삭제할까요|delete/i);
      await expectAccessible(page, 'mock exam delete confirmation');
      await page.keyboard.press('Escape');
      await expect(confirm).toHaveCount(0);

      // 설정 바꾸기 (the two steps with the current values).
      await mockUi.chooseDetailAction(dialog, 'settings');
      await expect(mockUi.variation(dialog, 'PARAPHRASE')).toBeChecked();
      await expectAccessible(page, 'mock exam change settings, options step');
      await mockUi.next(dialog).click();
      await expect(mockUi.remake(dialog)).toBeVisible();
      await expectAccessible(page, 'mock exam change settings, range step');
      await mockUi.backToList(dialog).click();
      await mockUi.open(mockUi.row(dialog, '중간 점검'), '중간 점검').click();

      // The manage viewer (answer and explanation shown), its edit form and the remove confirm.
      await questionRow(dialog, 1).click();
      const viewer = mockUi.viewer(page, 1);
      await expect(viewer).toBeVisible();
      await expect(mockUi.edit(viewer)).toBeVisible();
      await settle(page);
      await expectAccessible(page, 'mock exam question manage dialog');
      await mockUi.edit(viewer).click();
      const form = questionFormUi.form(page);
      await expect(questionFormUi.stem(form)).toBeVisible();
      await expectAccessible(page, 'mock exam question edit form');
      await page.keyboard.press('Escape');
      await expect(form).toHaveCount(0);
      await mockUi.remove(viewer).click();
      confirm = mockUi.confirm(page);
      await expect(confirm).toBeVisible();
      await expectAccessible(page, 'remove from mock exam confirmation');
      await page.keyboard.press('Escape');
      await expect(confirm).toHaveCount(0);
    } finally {
      hold.release();
    }
  },
);

test(
  'A11Y-14 keyboard only: 모의고사, both steps, 만들기, then practise to the results',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'a11y14-keys');
    await seed(s, NORMAL_SOURCES.slice(0, 4), 1);
    await openHome(page, s.owner, s.workspaceId);
    await page.locator('body').focus();

    let dialog = await openPlayByKeyboard(page);
    await spaceTo(page, mockUi.variation(dialog, 'PARAPHRASE'), true);
    // Step 1: name, 문구 변형 only, 2 questions → 다음.
    await keyTo(page, mockUi.title(dialog));
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('키보드 점검');
    for (const type of ['OPTION_SHUFFLE', 'PARAPHRASE', 'INVERT_POLARITY'] as const) {
      await spaceTo(page, mockUi.variation(dialog, type), type === 'PARAPHRASE');
    }
    await keyTo(page, mockUi.questionCount(dialog));
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('2');
    await keyTo(page, mockUi.next(dialog));
    await page.keyboard.press('Enter');

    // Step 2: Space on 1장, Tab to 만들기.
    await spaceTo(page, picker.chapter(dialog, CH1), true);
    await keyTo(page, mockUi.make(dialog));
    await page.keyboard.press('Enter');
    dialog = mockUi.dialog(page);
    await expect(mockUi.heading(dialog, '키보드 점검')).toBeFocused();
    await expect(dialog.getByText(STATUS_TEXT.ready).first()).toBeVisible({
      timeout: MOCK_TIMEOUT_MS,
    });

    // 풀기 → the run's range step (every question checked) → 시작 → answer both → results.
    await keyTo(page, mockUi.practise(dialog));
    await page.keyboard.press('Enter');
    const panel = runUi.panel(page);
    await expect(mockUi.practiceTitle(panel, '키보드 점검')).toBeVisible();
    await expect(runUi.selectAll(panel)).toBeChecked();
    await keyTo(page, runUi.start(panel));
    await page.keyboard.press('Enter');
    for (let k = 1; k <= 2; k += 1) {
      await expect(runUi.mockTitle(panel, k)).toBeFocused();
      await keyTo(page, panel.getByRole('radio').first());
      await page.keyboard.press('Space');
      await expect(panel.getByRole('radio', { checked: true })).toHaveCount(1);
      await keyTo(page, runUi.submit(panel));
      await page.keyboard.press('Enter');
      await expect(runUi.result(panel)).toContainText(/정답|오답|correct|incorrect/i);
      await keyTo(page, k < 2 ? runUi.next(panel) : runUi.showResults(panel));
      await page.keyboard.press('Enter');
    }
    await expect(runUi.restart(panel)).toBeVisible();
    await expect(runUi.resultRows(panel)).toHaveCount(2);
    await expectAccessible(page, 'mock exam run results reached by keyboard');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(mockUi.practise(dialog)).toBeFocused();
  },
);

/** 1장: `VIRTUAL_COUNT` MCQs (a virtualized chapter), 2장: two MCQs with fixed option texts. */
const VIRTUAL_COUNT = 82;

async function rangeWorkspace(workspaceFactory: WorkspaceFactory, label: string) {
  const s = await bookWorkspace(workspaceFactory, label);
  await createNumberedQuestions(s.owner, s.workspaceId, label, VIRTUAL_COUNT, (n) => ({
    ...numberedMcq(label, n),
    chapter_id: s.ch1,
    question_number: n,
  }));
  const ch2: Question[] = [];
  for (const n of [1, 2]) {
    ch2.push(
      await createQuestion(s.owner, s.workspaceId, {
        ...mcqInput(
          `${label} 2장 ${n}번: 정수 처리에서 알맞은 것은?`,
          ['응집', '침전', '여과', '소독'].map((t) => `${label}-${n} ${t}`),
          0,
        ),
        explanation: `${label}-${n} 해설`,
        chapter_id: s.ch2,
        question_number: n,
      }),
    );
  }
  return { ...s, ch2Questions: ch2 };
}

test(
  'A11Y-15 QuestionViewer range practice: range step (tri-state, filters, virtualized chapter, no match), solving, graded, results and a mock exam run',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await rangeWorkspace(workspaceFactory, 'a11y15');
    const [first, second] = s.ch2Questions;
    if (!first || !second) throw new Error('2장 questions');
    await openHome(page, s.owner, s.workspaceId);

    let panel = await openRangePicker(page);
    await expect(runUi.pickerTitle(panel)).toBeVisible();
    await expect(runUi.busy(panel)).toHaveCount(0);
    await expect(runUi.start(panel)).toBeDisabled();
    await expectAccessible(page, 'range step, nothing selected');

    // 전체 선택 then one question off: mixed; 1장 expanded is virtualized.
    await runUi.selectAll(panel).check();
    await runUi.expand(panel, CH1).click();
    await expect(runUi.question(panel, 1, 1)).toBeVisible();
    const rendered = await runUi.questions(panel).count();
    expect(rendered, '1장 renders only the rows in view').toBeLessThan(VIRTUAL_COUNT);
    await runUi.question(panel, 1, 1).uncheck();
    await expect(runUi.selectAll(panel)).toHaveAttribute('aria-checked', 'mixed');
    await expect(runUi.chapter(panel, CH1)).toHaveAttribute('aria-checked', 'mixed');
    await expectAccessible(page, 'range step mixed with a virtualized chapter');
    await runUi.expand(panel, CH1).click();

    // Filters open; 즐겨찾기만 matches nothing.
    await openRangeFilters(panel);
    await expectAccessible(page, 'range step with the status filter open');
    await picker.favoriteFilter(panel).click();
    await expect(runUi.noMatch(panel)).toBeVisible();
    await expectAccessible(page, 'range step, the filter matches no question');
    await picker.favoriteFilter(panel).click();
    await expect(runUi.noMatch(panel)).toHaveCount(0);

    // Only 2장: solving, graded (answer shown), results.
    // From mixed, one click selects everything and the next clears it.
    for (
      let i = 0;
      i < 2 && (await runUi.selectAll(panel).getAttribute('aria-checked')) !== 'false';
      i += 1
    ) {
      await runUi.selectAll(panel).click();
    }
    await expect(runUi.selectAll(panel)).toHaveAttribute('aria-checked', 'false');
    await runUi.chapter(panel, CH2).check();
    await runUi.start(panel).click();
    panel = runUi.panel(page);
    await expect(runUi.title(panel, 1)).toBeVisible();
    await expect(runUi.submit(panel)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'range run, a position before submitting');
    const wrong = first.revision.options[1]?.text ?? '';
    await runUi.option(panel, wrong).check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expectAccessible(page, 'range run, a graded position with the answer');
    await runUi.next(panel).click();
    await expect(runUi.title(panel, 2)).toBeVisible();
    await goToResults(panel); // the last position is left without an answer
    await expect(
      runUi.summary(panel, { correct: 0, incorrect: 1, pending: 0, skipped: 1 }),
    ).toBeVisible();
    await expectAccessible(page, 'range run results');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // A mock exam run (sequence(mock)): its range step grouped by source chapter and a position.
    const exam = await createShuffleMockExam(
      s.owner,
      s.workspaceId,
      '섞기 점검',
      ids(s.ch2Questions),
      2,
    );
    await page.goto(mockExamsPath(s.workspaceId));
    const dialog = mockUi.dialog(page);
    await mockUi.practise(mockUi.row(dialog, exam.title)).click();
    panel = runUi.panel(page);
    await expect(mockUi.practiceTitle(panel, exam.title)).toBeVisible();
    await expect(runUi.selectAll(panel)).toBeChecked();
    await expect(runUi.chapter(panel, CH2)).toBeChecked();
    await runUi.expand(panel, CH2).click();
    await expect(runUi.expand(panel, CH2)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByRole('checkbox', { name: /^(문제|question) \d+ · /i })).toHaveCount(2);
    await expectAccessible(page, 'mock exam run, range step grouped by source chapter');
    await runUi.start(panel).click();
    await expect(runUi.mockTitle(panel, 1)).toBeVisible();
    await expect(runUi.favorite(panel)).toHaveCount(0);
    await settle(page);
    await expectAccessible(page, 'mock exam run, a position before submitting');
  },
);

test(
  'A11Y-15 keyboard only: 모의고사, a chapter by Space, 시작, answer, 결과 보기 and back to 모의고사',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await rangeWorkspace(workspaceFactory, 'a11y15-keys');
    const [first, second] = s.ch2Questions;
    if (!first || !second) throw new Error('2장 questions');
    await openHome(page, s.owner, s.workspaceId);
    await page.locator('body').focus();

    const dialog = await openPlayByKeyboard(page);
    await keyTo(page, mockUi.questionCount(dialog));
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('2');
    await keyTo(page, mockUi.next(dialog));
    await page.keyboard.press('Enter');
    await spaceTo(page, picker.chapter(dialog, CH2), true);
    await expect(picker.selected(dialog, 2)).toBeVisible();
    await keyTo(page, picker.expand(dialog, CH2));
    await page.keyboard.press('Enter');
    await expect(picker.expand(dialog, CH2)).toHaveAttribute('aria-expanded', 'true');
    await spaceTo(page, picker.question(dialog, 2, 2), false);
    await expect(picker.selected(dialog, 1)).toBeVisible();
    await expect(picker.chapter(dialog, CH2)).toHaveAttribute('aria-checked', 'mixed');
    await spaceTo(page, picker.question(dialog, 2, 2), true);
    await keyTo(page, dialog.getByRole('button', { name: /^(시작|start)$/i }));
    await page.keyboard.press('Enter');
    const panel = runUi.panel(page);

    for (const [i, q] of [first, second].entries()) {
      await expect(runUi.title(panel, i + 1)).toBeFocused();
      const correct = q.revision.options.find((o) =>
        (q.revision.correct_option_ids ?? []).includes(o.id),
      );
      const option = runUi.option(panel, correct?.text ?? '');
      // Arrow keys move inside the radio group (the shuffle decides where the answer is).
      await keyTo(page, panel.getByRole('radio').first());
      await keyTo(page, option, 'ArrowDown', 6);
      await page.keyboard.press('Space');
      await expect(option).toBeChecked();
      await keyTo(page, runUi.submit(panel));
      await page.keyboard.press('Enter');
      await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
      await keyTo(page, i === 0 ? runUi.next(panel) : runUi.showResults(panel));
      await page.keyboard.press('Enter');
    }
    await expect(
      runUi.summary(panel, { correct: 2, incorrect: 0, pending: 0, skipped: 0 }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.getByRole('button', { name: /^모의고사$/ })).toBeFocused();
  },
);
