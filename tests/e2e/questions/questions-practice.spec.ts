// QPLAY-01 — 문제 풀이 Floating Side Panel (`/workspaces/:workspaceId?question=:id`),
// docs/screens/questions-practice.md; rules docs/questions.md §2, §3.2, §4,
// docs/design-system.md §5, docs/e2e-strategy.md §6 (answer leak by network interception, URL
// panel state across back/forward/reload, focus return).
//
// Each test signs in its own owner and works in its own workspace; questions come from the public
// question API (A1, A9) and results are cross-checked through the public overview / attempts API
// (A8, A10). Every endpoint and label assumption is in the header of fixtures/questions.ts.
// Server-side contracts the browser cannot observe (100 shuffles, revision pinning, viewer and
// archived rules, cross-user isolation) are in tests/integration/questions/
// test_practice_api_contract.py. AC07/AC08 (문제 관리: 편집·삭제, moved from the retired QBANK-01 by
// UX7-BANK) seed one graded attempt as superuser (fixtures/db.ts) and reuse the question editor's
// labels (questionFormUi). AC09–AC11 (UX7-BANK-2: 정답·해설 보기, 수정 이력·출처, 보관 — the retired
// bank detail panel's read view and archive, restored on the panel's header menu) read the
// answer only through the "문제 상세" dialog (detailUi) and check the practice session stays
// answer-free. AC12/AC13 (UX7-QDISPLAY: result borders, no visible 보기 label, trailing empty
// answer parentheses hidden) compare row borders with the semantic tokens the browser resolves
// (tokenColor) rather than with a screenshot. AC14 (STEM-ITEMS: stem item lists in a 제시 항목 box)
// checks the list by role and name and its place between the question sentence and the options
// by bounding boxes.
import { randomUUID } from 'node:crypto';
import { createPracticeRun, openRunSession } from '../fixtures/practice-runs.ts';
import type { Locator, Page, Request, Response } from '@playwright/test';
import {
  answerKeysIn,
  attemptRevision,
  chooseFilter,
  choosePanelManage,
  choosePanelMenu,
  chooseQuestionMenu,
  detailUi,
  INACTIVE_STATUS_OPTIONS,
  inactiveUi,
  JOB_TIMEOUT_MS,
  PANEL_MANAGE_ITEMS,
  uploadReadyBook,
  createNumberedQuestions,
  createQuestion,
  expect,
  getQuestion,
  listAttempts,
  mcqInput,
  notFoundHeading,
  numberedMcq,
  optionRowBorder,
  optionRowBox,
  overviewItem,
  overviewPath,
  overviewUi,
  panelUi,
  practiceSessionIds,
  PROBLEM_TYPES,
  questionFormUi,
  RESULT_TEXT,
  seedGradedAttempt,
  seedMembership,
  signInAs,
  startPractice,
  submitPractice,
  test,
  tokenColor,
  TRANSPARENT,
  type ApiResponse,
  type E2EFixtures,
  type Member,
  type Problem,
  type Question,
  type QuestionInput,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

interface Seeded {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly questions: Question[];
}

async function seedOne(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  input: QuestionInput,
): Promise<Seeded> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const question = await createQuestion(owner, ws.id, { question_number: 1, ...input });
  return { owner, workspaceId: ws.id, questions: [question] };
}

async function seedMany(
  workspaceFactory: E2EFixtures['workspaceFactory'],
  label: string,
  count: number,
): Promise<Seeded> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const questions = await createNumberedQuestions(owner, ws.id, label, count);
  return { owner, workspaceId: ws.id, questions };
}

function q(s: Seeded, n: number): Question {
  const found = s.questions[n - 1];
  if (!found) throw new Error(`no question ${n}`);
  return found;
}

async function openOverview(page: Page, s: Seeded): Promise<void> {
  await signInAs(page, s.owner.user);
  await page.goto(overviewPath(s.workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

async function openPanel(page: Page, n: number): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  return panel;
}

function unique(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

/** Option texts of the panel in on-screen (top-to-bottom) order. */
async function displayedOrder(panel: Locator, texts: readonly string[]): Promise<string[]> {
  const placed = await Promise.all(
    texts.map(async (text) => ({ text, y: (await panelUi.option(panel, text).boundingBox())?.y })),
  );
  for (const p of placed) expect(p.y, `option "${p.text}" is shown`).toBeDefined();
  return placed.sort((a, b) => (a.y ?? 0) - (b.y ?? 0)).map((p) => p.text);
}

function idsOf(question: Question, texts: readonly string[]): string[] {
  return texts.map((t) => {
    const option = question.revision.options.find((o) => o.text === t);
    if (!option) throw new Error(`no option "${t}"`);
    return option.id;
  });
}

interface Captured {
  readonly path: string;
  readonly contentType: string;
  readonly text: string;
}

/**
 * Records every document/fetch/xhr response body the page receives (the browser's view: API
 * JSON, HTML and RSC payloads alike) until `stop()` is called.
 */
function captureResponses(page: Page): { stop: () => Promise<Captured[]> } {
  const pending: Promise<Captured | undefined>[] = [];
  const onResponse = (res: Response) => {
    const request = res.request();
    const type = request.resourceType();
    if (!['document', 'fetch', 'xhr'].includes(type)) return;
    // Router prefetches of OTHER screens (nav links) are not this screen's data; one cut short by
    // `page.reload()` never yields a body in Chromium, which would hang `stop()`. Prefetches of
    // this screen's own path are still captured.
    const prefetch = request.headers()['next-router-prefetch'] !== undefined;
    if (prefetch && new URL(res.url()).pathname !== new URL(page.url()).pathname) return;
    pending.push(
      res
        .text()
        .then((text) => ({
          path: new URL(res.url()).pathname,
          contentType: res.headers()['content-type'] ?? '',
          text,
        }))
        .catch(() => undefined), // redirects have no body
    );
  };
  page.on('response', onResponse);
  return {
    stop: async () => {
      page.off('response', onResponse);
      const done = await Promise.all([...pending]);
      return done.filter((c): c is Captured => c !== undefined);
    },
  };
}

const ANSWER_KEY_IN_TEXT =
  /\\?"(correct_option_ids|accepted_answers|explanation|rubric|correct_answer)\\?"\s*:/;

/** Answer fields or secret texts found in captured bodies, as `path: finding`. */
function leaks(captured: readonly Captured[], secrets: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of captured) {
    if (c.contentType.includes('json')) {
      try {
        out.push(...answerKeysIn(JSON.parse(c.text)).map((k) => `${c.path}: ${k}`));
      } catch {
        out.push(`${c.path}: unparsable JSON`);
      }
    } else if (ANSWER_KEY_IN_TEXT.test(c.text)) {
      out.push(`${c.path}: answer field in ${c.contentType}`);
    }
    for (const secret of secrets) if (c.text.includes(secret)) out.push(`${c.path}: answer text`);
  }
  return out;
}

test(
  'QPLAY-01-AC01 opening an unseen question records viewed while no response carries the answer or explanation before submit',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const explanation = `해설 ${unique('qplay01-ac01')}: 증발은 액체가 기체로 변하는 현상이다.`;
    const label = unique('qplay01-ac01');
    const s = await seedOne(
      workspaceFactory,
      'qplay01-ac01',
      numberedMcq(label, 1, 2, { explanation }),
    );
    const question = q(s, 1);
    expect((await overviewItem(s.owner, s.workspaceId, question.id)).status).toBe('unseen');

    await signInAs(page, s.owner.user);
    const capture = captureResponses(page);
    await page.goto(overviewPath(s.workspaceId));
    const panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    await expect(panel).not.toContainText(explanation);
    // Reloading the deep link is another full fetch of the open panel.
    await page.reload();
    await expect(panelUi.numbered(page, 1)).toBeVisible();
    await expect(panelUi.options(panelUi.numbered(page, 1))).toHaveCount(4);
    const beforeSubmit = await capture.stop();
    expect(beforeSubmit.length).toBeGreaterThan(0);
    expect(leaks(beforeSubmit, [explanation])).toEqual([]);

    const item = await overviewItem(s.owner, s.workspaceId, question.id);
    expect(item.status).toBe('viewed');
    expect(item.last_graded_result).toBeNull();

    // Positive control: the same panel reveals the explanation only after submitting.
    const reopened = panelUi.numbered(page, 1);
    const correctText = question.revision.options[2]?.text ?? '';
    await panelUi.option(reopened, correctText).check();
    await panelUi.submit(reopened).click();
    await expect(panelUi.result(reopened)).toContainText(RESULT_TEXT.correct);
    await expect(reopened).toContainText(explanation);
  },
);

test(
  'QPLAY-01-AC02 a single-answer MCQ keeps its authored order and is graded by option id',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qplay01-ac02');
    const s = await seedOne(workspaceFactory, 'qplay01-ac02', numberedMcq(label, 1, 2));
    const question = q(s, 1);
    const texts = question.revision.options.map((o) => o.text);
    const correctText = texts[2] ?? '';
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    await expect(panel.getByRole('radio')).toHaveCount(4);
    const order = await displayedOrder(panel, texts);
    // Every option shows its display number (1. 2. 3. 4. top to bottom, UX5-UI) on its own row;
    // the radio stays named by the option text, and grading below still goes by option id.
    for (const [i, text] of order.entries()) {
      const number = panel.getByText(`${i + 1}.`, { exact: true });
      await expect(number).toBeVisible();
      const [numberBox, optionBox] = await Promise.all([
        number.boundingBox(),
        panelUi.option(panel, text).boundingBox(),
      ]);
      expect(numberBox && optionBox && Math.abs(numberBox.y - optionBox.y) < optionBox.height).toBe(
        true,
      );
    }

    // Pick the correct option by its stable id, independently of its position.
    await panelUi.option(panel, correctText).check();
    expect(await displayedOrder(panel, texts)).toEqual(order);
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(panelUi.result(panel)).not.toContainText(RESULT_TEXT.incorrect);
    expect(await displayedOrder(panel, texts)).toEqual(order);

    // The attempt stores the displayed order and the chosen stable id, not a position.
    const [attempt, ...older] = await listAttempts(s.owner, question.id);
    expect(older).toEqual([]);
    expect(attempt).toMatchObject({ result: 'correct', grading_method: 'auto' });
    expect(attempt?.displayed_option_ids).toEqual(idsOf(question, order));
    expect(attempt?.submitted_answer.selected_option_ids).toEqual(idsOf(question, [correctText]));
    expect(attempt?.question_revision_id).toBe(question.revision.id);
  },
);

test(
  'QPLAY-01-AC02 a multi-answer MCQ is correct only for the exact set of correct option ids',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qplay01-ac02-multi');
    const base = numberedMcq(label, 1);
    const options = base.options ?? [];
    const s = await seedOne(workspaceFactory, 'qplay01-ac02-multi', {
      ...base,
      is_multi_answer: true,
      correct_option_ids: [options[0]?.id ?? '', options[2]?.id ?? ''],
    });
    const question = q(s, 1);
    const [a, , c] = question.revision.options.map((o) => o.text);
    await openOverview(page, s);

    let panel = await openPanel(page, 1);
    await expect(panel.getByRole('checkbox')).toHaveCount(4);
    await panelUi.option(panel, c ?? '').check();
    await panelUi.option(panel, a ?? '').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // A new session: a subset of the correct answers is wrong.
    panel = await openPanel(page, 1);
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await panelUi.option(panel, a ?? '').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);

    const attempts = await listAttempts(s.owner, question.id);
    expect(attempts.map((x) => x.result)).toEqual(['incorrect', 'correct']);
    expect([...(attempts[1]?.submitted_answer.selected_option_ids ?? [])].sort()).toEqual(
      idsOf(question, [a ?? '', c ?? '']).sort(),
    );
    expect((await overviewItem(s.owner, s.workspaceId, question.id)).status).toBe('incorrect');
  },
);

test(
  'QPLAY-01-AC02 a short answer is auto-graded against normalized accepted answers that never reach the browser early',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const accepted = `Evaporation${randomUUID().slice(0, 6)}`;
    const s = await seedOne(workspaceFactory, 'qplay01-ac02-short', {
      question_type: 'SHORT_ANSWER',
      stem: `${unique('qplay01-ac02-short')} 액체가 기체로 변하는 현상은?`,
      accepted_answers: [accepted, '증발'],
      explanation: null,
    });
    const question = q(s, 1);
    await signInAs(page, s.owner.user);
    const capture = captureResponses(page);
    await page.goto(overviewPath(s.workspaceId));
    let panel = await openPanel(page, 1);
    await expect(panelUi.answerText(panel)).toBeVisible();
    expect(leaks(await capture.stop(), [accepted])).toEqual([]);

    // A11: case, surrounding and repeated whitespace do not matter.
    await panelUi.answerText(panel).fill(`   ${accepted.toUpperCase()}   `);
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await page.keyboard.press('Escape');

    panel = await openPanel(page, 1);
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await panelUi.answerText(panel).fill('응결');
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);

    const attempts = await listAttempts(s.owner, question.id);
    expect(attempts.map((x) => [x.result, x.grading_method])).toEqual([
      ['incorrect', 'auto'],
      ['correct', 'auto'],
    ]);
  },
);

test(
  'QPLAY-01-AC03 answering correctly with the retry flag on keeps the marker yellow and records the correct result',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qplay01-ac03');
    const s = await seedOne(workspaceFactory, 'qplay01-ac03', numberedMcq(label, 1, 1));
    const question = q(s, 1);
    await openOverview(page, s);
    const panel = await openPanel(page, 1);

    // RETRY-01: the toggle appears after the first correct answer; set it, then answer again.
    await expect(panelUi.retryOn(panel)).toHaveCount(0);
    await panelUi.option(panel, question.revision.options[1]?.text ?? '').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await panelUi.retryOn(panel).click();
    await expect(panelUi.retryOff(panel)).toBeVisible();
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await panelUi.option(panel, question.revision.options[1]?.text ?? '').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    // Never cleared automatically by a correct answer (questions.md §2.1).
    await expect(panelUi.retryOff(panel)).toBeVisible();
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();

    const dot = overviewUi.dot(page, 1);
    await expect(dot).toHaveAttribute('data-status', 'retry');
    await expect(dot).toHaveAttribute('aria-label', /마지막 결과 정답/);
    const item = await overviewItem(s.owner, s.workspaceId, question.id);
    expect(item).toMatchObject({
      status: 'retry',
      needs_retry: true,
      last_graded_result: 'correct',
    });
    expect((await listAttempts(s.owner, question.id)).map((a) => a.result)).toEqual([
      'correct',
      'correct',
    ]);
    await page.reload();
    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'retry');
  },
);

test(
  'QPLAY-01-AC04 an essay submission stays PENDING until the user self-grades it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const rubric = `채점 기준 ${unique('qplay01-ac04')}: 증발과 응결을 모두 언급`;
    const s = await seedOne(workspaceFactory, 'qplay01-ac04', {
      question_type: 'ESSAY',
      stem: `${unique('qplay01-ac04')} 물의 순환을 서술하시오.`,
      rubric,
    });
    const question = q(s, 1);
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    await expect(panel).not.toContainText(rubric);
    await panelUi.answerText(panel).fill('바닷물이 증발하여 구름이 되고 비로 내린다.');
    await panelUi.submit(panel).click();

    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.pending);
    await expect(panelUi.result(panel)).not.toContainText(/오답|incorrect/i);
    await expect(panelUi.selfGradeCorrect(panel)).toBeVisible();
    await expect(panelUi.selfGradeIncorrect(panel)).toBeVisible();
    const pendingItem = await overviewItem(s.owner, s.workspaceId, question.id);
    expect(pendingItem).toMatchObject({
      status: 'viewed',
      last_graded_result: null,
      is_pending_grading: true,
    });
    const [pending] = await listAttempts(s.owner, question.id);
    expect(pending).toMatchObject({ result: 'pending', grading_method: null });

    await panelUi.selfGradeCorrect(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await panelUi.close(panel).click();
    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'correct');

    // Self-grading appends a graded attempt; the pending one is unchanged (immutable history).
    const attempts = await listAttempts(s.owner, question.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      result: 'correct',
      grading_method: 'self',
      grades_attempt_id: pending?.id,
    });
    expect(attempts[1]).toEqual(pending);
  },
);

test(
  'QPLAY-01-AC05 Escape or the close button removes ?question= and returns focus to the opening marker',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedMany(workspaceFactory, 'qplay01-ac05', 3);
    await openOverview(page, s);
    const dot = overviewUi.dot(page, 2);

    await dot.click();
    const panel = panelUi.numbered(page, 2);
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get('question') === q(s, 2).id);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('question'));
    await expect(dot).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get('question') === q(s, 2).id);
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('question'));
    await expect(dot).toBeFocused();
  },
);

test(
  'QPLAY-01-AC05 previous/next update ?question= and back, forward and reload restore the open question',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedMany(workspaceFactory, 'qplay01-ac05-nav', 3);
    const at = (n: number) => (url: URL) => url.searchParams.get('question') === q(s, n).id;
    await openOverview(page, s);

    let panel = await openPanel(page, 1);
    await expect(page).toHaveURL(at(1));
    await expect(panelUi.options(panel)).toHaveCount(4);
    await panelUi.next(panel).click();
    panel = panelUi.numbered(page, 2);
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(at(2));
    await expect(panelUi.options(panel)).toHaveCount(4);
    await panelUi.next(panel).click();
    await expect(panelUi.numbered(page, 3)).toBeVisible();
    await expect(page).toHaveURL(at(3));
    await expect(panelUi.options(panelUi.numbered(page, 3))).toHaveCount(4);
    await panelUi.previous(panelUi.numbered(page, 3)).click();
    await expect(panelUi.numbered(page, 2)).toBeVisible();
    await expect(page).toHaveURL(at(2));

    await page.goBack();
    await expect(page).toHaveURL(at(3));
    await expect(panelUi.numbered(page, 3)).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(at(2));
    await expect(panelUi.numbered(page, 2)).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(at(2));
    await expect(panelUi.numbered(page, 2)).toBeVisible();
    await expect(panelUi.numbered(page, 2)).toContainText(q(s, 2).revision.stem);

    // A deep link opens the panel directly; every question visited was recorded as viewed.
    await page.goto(overviewPath(s.workspaceId, q(s, 3).id));
    await expect(panelUi.numbered(page, 3)).toBeVisible();
    await expect(panelUi.options(panelUi.numbered(page, 3))).toHaveCount(4);
    for (const n of [1, 2, 3]) {
      expect((await overviewItem(s.owner, s.workspaceId, q(s, n).id)).status).toBe('viewed');
    }
  },
);

/**
 * Counts the page's question-content loads: server-action POSTs (`Next-Action`, the BFF relay of
 * the practice session) and any browser call to the API. Router RSC refreshes of the overview
 * are not question content.
 */
function countContentLoads(page: Page): { count: () => number; stop: () => void } {
  let n = 0;
  const api = new URL(process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || 'http://127.0.0.1:8000');
  const onRequest = (req: Request) => {
    const url = new URL(req.url());
    if (req.method() === 'POST' && req.headers()['next-action'] !== undefined) n += 1;
    else if (url.host === api.host) n += 1;
  };
  page.on('request', onRequest);
  return { count: () => n, stop: () => page.off('request', onRequest) };
}

test(
  'QPLAY-01-AC06 re-opening a viewed unanswered question checks recent state and reuses its session',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedMany(workspaceFactory, 'qplay01-ac06', 2);
    const texts = q(s, 1).revision.options.map((o) => o.text);
    await openOverview(page, s);

    let panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    const order = await displayedOrder(panel, texts);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    panel = await openPanel(page, 2);
    await expect(panelUi.options(panel)).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    const firstSessions = practiceSessionIds(s.owner.user.id, q(s, 1).id);
    const secondSessions = practiceSessionIds(s.owner.user.id, q(s, 2).id);
    expect(firstSessions).toHaveLength(1);
    expect(secondSessions).toHaveLength(1);

    // Close/reopen and previous/next check recent metadata and reuse the open sessions.
    const loads = countContentLoads(page);
    panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    // The same open session retains its displayed order.
    expect(await displayedOrder(panel, texts)).toEqual(order);
    await panelUi.next(panel).click();
    await expect(panelUi.options(panelUi.numbered(page, 2))).toHaveCount(4);
    await panelUi.previous(panelUi.numbered(page, 2)).click();
    panel = panelUi.numbered(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    expect(loads.count(), 'recent metadata requests while reopening').toBeGreaterThan(0);
    expect(practiceSessionIds(s.owner.user.id, q(s, 1).id)).toEqual(firstSessions);
    expect(practiceSessionIds(s.owner.user.id, q(s, 2).id)).toEqual(secondSessions);
    loads.stop();

    // The cached session is the server's open session: submitting it grades once.
    const correctText = q(s, 1).revision.options[0]?.text ?? '';
    await panelUi.option(panel, correctText).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    const attempts = await listAttempts(s.owner, q(s, 1).id);
    expect(attempts.map((a) => a.result)).toEqual(['correct']);
    expect(attempts[0]?.practice_session_id).toBe(firstSessions[0]);

    // A submitted session is not served from the open-session cache: the server restores
    // the caller's result for the current revision (UX10-QVIEW-AC03).
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    const after = countContentLoads(page);
    panel = await openPanel(page, 1);
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expect(panelUi.option(panel, correctText)).toBeChecked();
    expect(after.count()).toBeGreaterThan(0);
    after.stop();
  },
);

const RANDOM_ID = '00000000-0000-4000-8000-000000000000';

function stableProblem(res: ApiResponse): Partial<Problem> {
  const { type, title, status, detail } = (res.body ?? {}) as Problem;
  return { type, title, status, detail };
}

test(
  'QPLAY-01-AC07 문제 관리 › 편집 saves a new revision with the same option ids; past attempts keep the old revision',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const original = unique('염소 소독의 주된 목적은?');
    const s = await seedOne(workspaceFactory, 'qplay01-ac07', {
      ...mcqInput(
        original,
        ['색을 진하게 한다', '미생물을 줄인다', '온도를 높인다', '침전을 늘린다'],
        1,
      ),
      explanation: `해설 ${unique('qplay01-ac07')}`,
    });
    const created = q(s, 1);
    const v1 = created.revision;
    expect(v1.version).toBe(1);
    // A graded attempt that already exists on revision 1.
    const attemptId = seedGradedAttempt(s.workspaceId, created.id, v1.id, s.owner.user.id);

    await signInAs(page, s.owner.user);
    // The existing result is restored; a new retry remains answer-free until submitted.
    await page.goto(overviewPath(s.workspaceId));
    const panel = await openPanel(page, 1);
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await expect(panelUi.submit(panel)).toBeVisible();
    await expect(panelUi.options(panel)).toHaveCount(4);
    expect(answerKeysIn(await startPractice(s.owner, created.id))).toEqual([]);

    await choosePanelManage(page, panel, 'edit');
    const form = questionFormUi.form(page);
    await expect(form).toBeVisible();
    await expect(form).toHaveAccessibleName(/문제 편집|edit question/i);
    await expect(questionFormUi.stem(form)).toHaveValue(original);
    const edited = unique('염소 소독을 하는 가장 중요한 이유는?');
    await questionFormUi.stem(form).fill(edited);
    await questionFormUi.option(form, 3).fill('물의 온도를 높인다');
    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();
    // The panel stays open and practises the new revision.
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(edited);
    await expect(panel).not.toContainText(original);
    await expect(panelUi.option(panel, '물의 온도를 높인다')).toBeVisible();

    const after = await getQuestion(s.owner, created.id);
    expect(after.revision.version).toBe(2);
    expect(after.revision.id).not.toBe(v1.id);
    expect(after.revision.stem).toBe(edited);
    // Option ids are stable across the edit; only the text of option 3 changed.
    expect(after.revision.options.map((o) => o.id)).toEqual(v1.options.map((o) => o.id));
    expect(after.revision.options[2]?.text).toBe('물의 온도를 높인다');
    expect(after.revision.correct_option_ids).toEqual(v1.correct_option_ids);
    // The earlier attempt still points at revision 1 with its original text.
    expect(attemptRevision(attemptId)).toEqual({ revisionId: v1.id, version: 1, stem: original });
  },
);

test(
  'QPLAY-01-AC08 문제 관리 › 삭제 removes the dot after confirming; viewers, archived workspaces and other users cannot edit or delete',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedMany(workspaceFactory, 'qplay01-ac08', 3);
    const [doomed, kept] = [q(s, 2), q(s, 3)];
    const viewer = await workspaceFactory.member('qplay01-ac08-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    const mallory = await workspaceFactory.member('qplay01-ac08-mallory');
    await workspaceFactory.create(mallory);

    // Owner: 삭제 asks first; cancelling keeps the question.
    await openOverview(page, s);
    await expect(overviewUi.dots(page)).toHaveCount(3);
    let panel = await openPanel(page, 2);
    await choosePanelManage(page, panel, 'delete');
    const confirm = panelUi.deleteConfirm(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /^(취소|cancel)$/i }).click();
    await expect(confirm).toBeHidden();
    await expect(panel).toBeVisible();
    expect((await getQuestion(s.owner, doomed.id)).id).toBe(doomed.id);

    await choosePanelManage(page, panel, 'delete');
    await panelUi
      .deleteConfirm(page)
      .getByRole('button', { name: /^(삭제|delete)$/i })
      .click();
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('question'));
    await expect(overviewUi.dots(page)).toHaveCount(2);
    await expect(overviewUi.dot(page, 2)).toHaveCount(0);
    const gone = await s.owner.api.request('GET', `/questions/${doomed.id}`);
    expect(gone.status).toBe(404);
    await page.reload();
    await expect(overviewUi.dots(page)).toHaveCount(2);

    // Other users: the same 404 as an unknown id for read, edit, delete and list; nothing leaks.
    const missing = await mallory.api.request('GET', `/questions/${RANDOM_ID}`);
    expect(missing.status).toBe(404);
    for (const [method, path, body] of [
      ['GET', `/questions/${kept.id}`, undefined],
      ['PATCH', `/questions/${kept.id}`, { base_revision_id: kept.revision.id, stem: 'mallory' }],
      ['DELETE', `/questions/${kept.id}`, undefined],
      ['GET', `/workspaces/${s.workspaceId}/questions`, undefined],
    ] as const) {
      const res = await mallory.api.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(stableProblem(res), `${method} ${path}`).toEqual(stableProblem(missing));
      expect(res.text).not.toContain(kept.revision.stem);
    }
    expect((await getQuestion(s.owner, kept.id)).revision).toEqual(kept.revision);
    await page.context().clearCookies();
    await signInAs(page, mallory.user);
    await page.goto(overviewPath(s.workspaceId, kept.id));
    await expect(notFoundHeading(page)).toBeVisible();
    await expect(page.getByText(kept.revision.stem)).toHaveCount(0);

    // Viewer: practises, but the panel has no 문제 관리 and the API refuses edits and deletes.
    for (const [method, path, body] of [
      ['PATCH', `/questions/${kept.id}`, { base_revision_id: kept.revision.id, stem: 'viewer' }],
      ['DELETE', `/questions/${kept.id}`, undefined],
    ] as const) {
      const res = await viewer.api.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((res.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
    }
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(overviewPath(s.workspaceId));
    panel = await openPanel(page, 3);
    await expect(panelUi.submit(panel)).toBeVisible();
    await expect(panelUi.manage(panel)).toHaveCount(0);

    // Archived: read-only for the owner too.
    await workspaceFactory.archive(s.owner, s.workspaceId);
    for (const [method, path, body] of [
      ['PATCH', `/questions/${kept.id}`, { base_revision_id: kept.revision.id, stem: 'archived' }],
      ['DELETE', `/questions/${kept.id}`, undefined],
    ] as const) {
      const res = await s.owner.api.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((res.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    }
    await page.context().clearCookies();
    await openOverview(page, s);
    panel = await openPanel(page, 3);
    await expect(panelUi.manage(panel)).toHaveCount(0);
    expect((await getQuestion(s.owner, kept.id)).revision).toEqual(kept.revision);
  },
);

/** The menu items of the panel's open header menu, in order. */
async function expectMenuItems(
  page: Page,
  items: readonly (keyof typeof PANEL_MANAGE_ITEMS)[],
): Promise<void> {
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(
    items.map((item) => PANEL_MANAGE_ITEMS[item]),
  );
}

test(
  'QPLAY-01-AC09 정답·해설 보기 shows the answer and explanation to every member without a practice attempt; an unanswered practice survives it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qplay01-ac09');
    const explanation = `해설 ${label}: 증발은 액체가 기체로 변하는 현상이다.`;
    const s = await seedOne(
      workspaceFactory,
      'qplay01-ac09',
      numberedMcq(label, 1, 2, { explanation }),
    );
    const question = q(s, 1);
    const correctText = question.revision.options[2]?.text ?? '';
    const wrongText = question.revision.options[0]?.text ?? '';
    const viewer = await workspaceFactory.member('qplay01-ac09-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');

    // Owner: the panel opens without the answer; an option is chosen but not submitted.
    await signInAs(page, s.owner.user);
    const capture = captureResponses(page);
    await page.goto(overviewPath(s.workspaceId));
    let panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    await panelUi.option(panel, wrongText).check();
    expect(leaks(await capture.stop(), [explanation])).toEqual([]);

    await panelUi.manage(panel).click();
    // QGEN-RM: no 변형 출제 (its review page was retired with QGEN-01).
    await expectMenuItems(page, ['answers', 'history', 'edit', 'archive', 'delete']);
    await expect(panelUi.manageItem(page, 'generate')).toHaveCount(0);
    await panelUi.manageItem(page, 'answers').click();
    let detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(question.revision.stem);
    await expect(detail).toContainText(explanation);
    await expect(detailUi.correctOptions(detail)).toHaveCount(1);
    await expect(detailUi.correctOptions(detail)).toContainText(correctText);
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    // The unanswered practice is untouched: same choice, nothing recorded.
    await expect(panel).toBeVisible();
    await expect(panelUi.option(panel, wrongText)).toBeChecked();
    expect(await listAttempts(s.owner, question.id)).toEqual([]);
    // …and its session still submits once, as usual.
    await panelUi.option(panel, correctText).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(await listAttempts(s.owner, question.id)).toHaveLength(1);

    // Viewer: a read-only 문제 정보 menu with just the read items.
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    const viewerCapture = captureResponses(page);
    await page.goto(overviewPath(s.workspaceId));
    panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    expect(leaks(await viewerCapture.stop(), [explanation])).toEqual([]);
    await expect(panelUi.manage(panel)).toHaveCount(0);
    await panelUi.info(panel).click();
    await expectMenuItems(page, ['answers', 'history']);
    await panelUi.manageItem(page, 'answers').click();
    detail = detailUi.dialog(page);
    await expect(detail).toContainText(explanation);
    await expect(detailUi.correctOptions(detail)).toContainText(correctText);
    await expect(inactiveUi.edit(detail)).toHaveCount(0);
    await detailUi.close(detail).click();
    await expect(detail).toBeHidden();
    await expect(panelUi.info(panel)).toBeFocused();
    expect(await listAttempts(viewer, question.id)).toEqual([]);
    // The practice session itself still carries no answer field (QPLAY-01-AC01).
    expect(answerKeysIn(await startPractice(viewer, question.id))).toEqual([]);

    // Archived workspace: the panel is read-only, the answers stay readable.
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await page.context().clearCookies();
    await openOverview(page, s);
    panel = await openPanel(page, 1);
    await expect(panelUi.manage(panel)).toHaveCount(0);
    await choosePanelMenu(page, panel, 'answers');
    await expect(detailUi.dialog(page)).toContainText(explanation);
  },
);

test(
  'QPLAY-01-AC10 수정 이력·출처 lists the revisions newest first, previews an older one and links each source to its PDF page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 90_000);
    const owner = await workspaceFactory.member('qplay01-ac10');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const label = unique('qplay01-ac10');
    const v1Stem = `${label} 처음 문제`;
    let question = await createQuestion(owner, ws.id, {
      ...mcqInput(v1Stem, ['가', '나', '다', '라'], 1),
      question_number: 1,
      sources: [{ document_id: documentId, page_start: 2, page_end: 3 }],
    });
    for (const stem of [`${label} 두 번째`, `${label} 세 번째`]) {
      question = await owner.api.ok<Question>(
        'PATCH',
        `/questions/${question.id}`,
        { base_revision_id: question.revision.id, stem },
        [200],
      );
    }
    expect(question.revision.version).toBe(3);
    const viewer = await workspaceFactory.member('qplay01-ac10-viewer');
    seedMembership(ws.id, viewer.user.id, 'viewer');

    await signInAs(page, viewer.user);
    await page.goto(overviewPath(ws.id));
    const panel = await openPanel(page, 1);
    await choosePanelMenu(page, panel, 'history');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(detailUi.historyHeading(detail)).toBeFocused();
    await expect(detailUi.revisions(detail)).toHaveText([
      /^(버전|version) 3 \((현재|current)\)/i,
      /^(버전|version) 2(?!\d)/i,
      /^(버전|version) 1(?!\d)/i,
    ]);
    await expect(detailUi.revision(detail, 3)).toHaveAttribute('aria-pressed', 'true');
    await expect(detail).not.toContainText(v1Stem);
    await detailUi.revision(detail, 1).click();
    await expect(detailUi.revision(detail, 1)).toHaveAttribute('aria-pressed', 'true');
    await expect(detailUi.revision(detail, 3)).toHaveAttribute('aria-pressed', 'false');
    await expect(detail).toContainText(v1Stem);

    await expect(detailUi.sourcesHeading(detail)).toBeVisible();
    const link = detail.getByRole('link', { name: /2–3쪽|pages? 2/i });
    await expect(link).toHaveAttribute(
      'href',
      `/workspaces/${ws.id}/documents/${documentId}?page=2`,
    );
    await link.click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${ws.id}/documents/${documentId}` &&
        url.searchParams.get('page') === '2',
    );
  },
);

test(
  'QPLAY-01-AC11 문제 관리 › 보관 archives after confirming and the dot leaves the heatmap; viewers and archived workspaces cannot archive',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedMany(workspaceFactory, 'qplay01-ac11', 2);
    const [target, kept] = [q(s, 1), q(s, 2)];
    const viewer = await workspaceFactory.member('qplay01-ac11-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');

    await openOverview(page, s);
    await expect(overviewUi.dots(page)).toHaveCount(2);
    const panel = await openPanel(page, 1);
    await choosePanelManage(page, panel, 'archive');
    let confirm = panelUi.archiveConfirm(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /^(취소|cancel)$/i }).click();
    await expect(confirm).toBeHidden();
    await expect(panel).toBeVisible();
    expect((await getQuestion(s.owner, target.id)).publication_status).toBe('CONFIRMED');

    await choosePanelManage(page, panel, 'archive');
    confirm = panelUi.archiveConfirm(page);
    await confirm.getByRole('button', { name: /^(보관|archive)$/i }).click();
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('question'));
    await expect(overviewUi.dots(page)).toHaveCount(1);
    await expect(overviewUi.dot(page, 1)).toHaveCount(0);
    expect((await getQuestion(s.owner, target.id)).publication_status).toBe('ARCHIVED');
    // Back never reopens the archived question.
    await page.goBack();
    await expect(panelUi.panel(page)).toHaveCount(0);
    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.dots(page)).toHaveCount(1);
    // It is listed under 보관·초안 문제 › 보관됨.
    await chooseQuestionMenu(page, 'inactive');
    const dialog = inactiveUi.dialog(page);
    await chooseFilter(page, inactiveUi.status(dialog), INACTIVE_STATUS_OPTIONS.archived);
    await expect(inactiveUi.rows(dialog)).toHaveCount(1);
    await expect(inactiveUi.rows(dialog)).toContainText(target.revision.stem);

    // Viewer: no 보관 in the read-only menu; the API refuses.
    const refused = await viewer.api.request('PATCH', `/questions/${kept.id}`, {
      base_revision_id: kept.revision.id,
      publication_status: 'ARCHIVED',
    });
    expect(refused.status).toBe(403);
    expect((refused.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(overviewPath(s.workspaceId));
    let other = await openPanel(page, 2);
    await panelUi.info(other).click();
    await expectMenuItems(page, ['answers', 'history']);
    await page.keyboard.press('Escape');

    // Archived workspace: no 보관 either; the API refuses.
    await workspaceFactory.archive(s.owner, s.workspaceId);
    const archived = await s.owner.api.request('PATCH', `/questions/${kept.id}`, {
      base_revision_id: kept.revision.id,
      publication_status: 'ARCHIVED',
    });
    expect(archived.status).toBe(403);
    expect((archived.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    await page.context().clearCookies();
    await openOverview(page, s);
    other = await openPanel(page, 2);
    await panelUi.info(other).click();
    await expectMenuItems(page, ['answers', 'history']);
    expect((await getQuestion(s.owner, kept.id)).publication_status).toBe('CONFIRMED');
  },
);

/** Border color, width and the accessible mark of each named option row, compared at once. */
async function expectRows(
  panel: Locator,
  rows: readonly { text: string; color: string; mark: RegExp | null }[],
  width: string,
): Promise<void> {
  for (const row of rows) {
    const option = panelUi.option(panel, row.text);
    // Read once on purpose: the tone renders with the result text the caller waited for, and the
    // row declares no transition and reduced motion adds none (base.css, UX7-CSS), so the final
    // color is there at once. A transition creeping back fails here instead of being polled away.
    const border = await optionRowBorder(option);
    expect(border, `row "${row.text}"`).toMatchObject({
      color: row.color,
      width,
      style: 'solid',
      uniform: true,
    });
    if (row.mark) {
      await expect(option).toHaveAccessibleDescription(row.mark);
      await expect(panel.getByText(row.mark)).not.toHaveCount(0);
    } else {
      await expect(option).toHaveAccessibleDescription('');
    }
  }
}

const MARK = {
  correctMine: /^(정답 · 내 선택|correct · your (choice|answer))$/i,
  correct: /^(정답|correct)$/i,
  mine: /^(내 선택|내 답|your (choice|answer))$/i,
} as const;

test(
  'QPLAY-01-AC12 after an MCQ submission the chosen correct option is bordered green, a wrong choice grey and the correct option red, each with a described mark',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('qplay01-ac12');
    const s = await seedOne(workspaceFactory, 'qplay01-ac12', numberedMcq(label, 1, 2));
    const multiBase = numberedMcq(label, 2);
    const multiOptions = multiBase.options ?? [];
    const multi = await createQuestion(s.owner, s.workspaceId, {
      ...multiBase,
      is_multi_answer: true,
      correct_option_ids: [multiOptions[0]?.id ?? '', multiOptions[2]?.id ?? ''],
    });
    const texts = q(s, 1).revision.options.map((o) => o.text);
    const [a = '', b = '', c = '', d = ''] = texts;
    const [ma = '', mb = '', mc = '', md = ''] = multi.revision.options.map((o) => o.text);
    await openOverview(page, s);
    const success = await tokenColor(page, 'color-success');
    const danger = await tokenColor(page, 'color-danger');
    const grey = await tokenColor(page, 'color-border-strong');
    expect(new Set([success, danger, grey, TRANSPARENT]).size).toBe(4);

    // Before submitting: every row has the same transparent border (nothing to see yet).
    let panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    const width = (await optionRowBorder(panelUi.option(panel, a))).width;
    expect(Number.parseFloat(width)).toBeGreaterThan(0);
    await expectRows(
      panel,
      texts.map((text) => ({ text, color: TRANSPARENT, mark: null })),
      width,
    );
    await panelUi.option(panel, c).check();
    const before = await Promise.all(texts.map((t) => optionRowBox(panelUi.option(panel, t))));

    // Correct: the chosen (correct) option is green with "정답 · 내 선택"; nothing else is marked.
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await expectRows(
      panel,
      [
        { text: c, color: success, mark: MARK.correctMine },
        { text: a, color: TRANSPARENT, mark: null },
        { text: b, color: TRANSPARENT, mark: null },
        { text: d, color: TRANSPARENT, mark: null },
      ],
      width,
    );
    // Same border width and a reserved icon slot: the rows keep their place and width.
    const after = await Promise.all(texts.map((t) => optionRowBox(panelUi.option(panel, t))));
    for (const [i, box] of after.entries()) {
      expect(box.x).toBeCloseTo(before[i]?.x ?? NaN, 1);
      expect(box.width).toBeCloseTo(before[i]?.width ?? NaN, 1);
    }
    const top = (boxes: readonly { y: number }[]) => Math.min(...boxes.map((x) => x.y));
    expect(top(after)).toBeCloseTo(top(before), 1);
    for (const [i, box] of after.entries()) expect(box.y).toBeCloseTo(before[i]?.y ?? NaN, 1);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Wrong: the chosen option grey with "내 선택", the correct option red with "정답".
    panel = await openPanel(page, 1);
    await panel.getByRole('button', { name: /^다시 풀기$/ }).click();
    await panelUi.option(panel, a).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expectRows(
      panel,
      [
        { text: a, color: grey, mark: MARK.mine },
        { text: c, color: danger, mark: MARK.correct },
        { text: b, color: TRANSPARENT, mark: null },
        { text: d, color: TRANSPARENT, mark: null },
      ],
      width,
    );

    // The same tokens in the dark theme (each theme resolves its own values).
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = {
      danger: await tokenColor(page, 'color-danger'),
      grey: await tokenColor(page, 'color-border-strong'),
    };
    expect(dark.danger).not.toBe(danger);
    await expectRows(
      panel,
      [
        { text: a, color: dark.grey, mark: MARK.mine },
        { text: c, color: dark.danger, mark: MARK.correct },
      ],
      width,
    );
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Multi-answer, one right and one wrong pick: both correct options red (the chosen one too).
    panel = await openPanel(page, 2);
    await expect(panel.getByRole('checkbox')).toHaveCount(4);
    await panelUi.option(panel, ma).check();
    await panelUi.option(panel, mb).check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.incorrect);
    await expectRows(
      panel,
      [
        { text: ma, color: danger, mark: MARK.correctMine },
        { text: mb, color: grey, mark: MARK.mine },
        { text: mc, color: danger, mark: MARK.correct },
        { text: md, color: TRANSPARENT, mark: null },
      ],
      width,
    );
  },
);

test(
  'QPLAY-01-AC13 stems are shown without the trailing empty answer parentheses and options without a visible 보기 label; stored text and the editor keep them',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const tag = unique('qplay01-ac13');
    const shown = `${tag} 빈칸 ( )에 들어갈 말로 옳은 것은?`;
    const stored = `${shown} ( )`;
    const s = await seedOne(workspaceFactory, 'qplay01-ac13', {
      ...mcqInput(stored, ['응결', '증발', '강수', '침투'], 1),
      explanation: `해설 ${tag}`,
    });
    const question = q(s, 1);
    expect(question.revision.stem).toBe(stored);
    await openOverview(page, s);

    // Heatmap preview: the trailing mark is gone, the fill-in blank stays.
    await overviewUi.dot(page, 1).focus();
    const tooltip = overviewUi.tooltip(page);
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByText(shown, { exact: true })).toBeVisible();
    await expect(tooltip).not.toContainText(stored);

    // Practice panel: the same stem; the options have no visible 보기 label but a named group.
    const panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    await expect(panel.getByText(shown, { exact: true })).toBeVisible();
    await expect(panel).not.toContainText(stored);
    await expect(panel.getByRole('radiogroup')).toHaveAccessibleName(/^(보기|답 선택|options)$/i);
    await expectNoVisibleLabel(panel);

    // 문제 상세: the same stem, the option list named 보기 without a visible 보기 heading.
    await choosePanelManage(page, panel, 'answers');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(detail.getByText(shown, { exact: true })).toBeVisible();
    await expect(detail).not.toContainText(stored);
    await expect(detail.getByRole('list', { name: /^(보기|options)$/i })).toBeVisible();
    await expect(detail.getByRole('heading', { name: /^보기/ })).toHaveCount(0);
    await expectNoVisibleLabel(detail);
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    // The editor shows (and the API keeps) the stored text, trailing mark included.
    await choosePanelManage(page, panel, 'edit');
    const form = questionFormUi.form(page);
    await expect(form).toBeVisible();
    await expect(questionFormUi.stem(form)).toHaveValue(stored);
    expect((await getQuestion(s.owner, question.id)).revision.stem).toBe(stored);
  },
);

test(
  'QPLAY-01-AC14 stem item lists are shown one per line in a 제시 항목 box between the question sentence and the options; inline mentions and stored text stay',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const tag = unique('qplay01-ac14');
    // (1) a one-line stem: question sentence, trailing empty answer mark, (가)~(라) items.
    const lead1 = `${tag} 수신 업무 내용 중 맞는 것으로만 묶인 것은?`;
    const items1 = [
      '(가) 개인과 법인은 공동명의 계좌개설이 불가하다.',
      '(나) 만 14세 미만 미성년자는 법정대리인의 동의를 받아야 한다.',
      '(다) 세법상 비거주자의 이자소득은 원천징수한다.',
      '(라) 임의단체는 법인과세 처리한다.',
    ];
    const stored1 = `${lead1} ( ) ${items1.join(' ')}`;
    const options1 = ['(가), (나)', '(나), (다)', '(다), (라)', '(가), (라)'];
    // (2) ㄱ.~ㄷ. items stored one per line, then a blank line and a closing sentence.
    const lead2 = `${tag} 다음은 물의 순환에 대한 설명이다.`;
    const items2 = [
      'ㄱ. 증발은 액체가 기체로 바뀌는 현상이다.',
      'ㄴ. 응결은 기체가 액체로 바뀌는 현상이다.',
      'ㄷ. 강수는 물이 땅속으로 스며드는 현상이다.',
    ];
    const tail2 = '위에서 옳은 것을 모두 고르면?';
    const stored2 = `${lead2}\n\n${items2.join('\n')}\n\n${tail2}`;
    // (3) labels only mentioned inside the sentence.
    const stored3 = `${tag} 빈칸 (가)와 (나)에 들어갈 말로 옳은 것은?`;

    const owner = await workspaceFactory.member('qplay01-ac14');
    const ws = await workspaceFactory.create(owner);
    const first = await createQuestion(owner, ws.id, {
      question_number: 1,
      ...mcqInput(stored1, options1, 2),
      explanation: `해설 ${tag}`,
    });
    const second = await createQuestion(owner, ws.id, {
      question_number: 2,
      ...mcqInput(stored2, ['ㄱ', 'ㄱ, ㄴ', 'ㄴ, ㄷ', 'ㄱ, ㄴ, ㄷ'], 1),
    });
    const third = await createQuestion(owner, ws.id, {
      question_number: 3,
      ...mcqInput(stored3, ['응결, 증발', '증발, 강수', '강수, 침투', '침투, 응결'], 0),
    });
    const s: Seeded = { owner, workspaceId: ws.id, questions: [first, second, third] };
    expect(first.revision.stem).toBe(stored1);
    await openOverview(page, s);

    // (1) Practice panel: question paragraph, then the 제시 항목 list, then the options.
    let panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    await expectItemBox(panel, lead1, items1, panel.getByRole('radiogroup'));
    await expect(panelUi.option(panel, '(다), (라)')).toBeVisible();

    // (1) 문제 상세: the same layout above the option list named 보기.
    await choosePanelManage(page, panel, 'answers');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expectItemBox(
      detail,
      lead1,
      items1,
      detail.getByRole('list', { name: /^(보기|options)$/i }),
    );
    await expect(
      detail
        .getByRole('list', { name: /^(보기|options)$/i })
        .getByText('(다), (라)', { exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    // (1) The editor shows (and the API keeps) the stored one-line text.
    await choosePanelManage(page, panel, 'edit');
    const form = questionFormUi.form(page);
    await expect(form).toBeVisible();
    await expect(questionFormUi.stem(form)).toHaveValue(stored1);
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    expect((await getQuestion(owner, first.id)).revision.stem).toBe(stored1);
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();

    // (2) Newline-stored items in the box; the paragraph after the blank line stays below it.
    panel = await openPanel(page, 2);
    await expectItemBox(panel, lead2, items2, panel.getByRole('radiogroup'));
    const tail = panel.getByText(tail2, { exact: true });
    await expect(tail).toBeVisible();
    await expect(itemList(panel).getByText(tail2)).toHaveCount(0);
    const listBox = await itemList(panel).boundingBox();
    const tailBox = await tail.boundingBox();
    expect(listBox && tailBox && tailBox.y >= listBox.y + listBox.height - 1).toBe(true);
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();

    // (3) Inline mentions are not items: no box, the stem is one paragraph as stored.
    panel = await openPanel(page, 3);
    await expect(panelUi.options(panel)).toHaveCount(4);
    await expect(panel.getByText(stored3, { exact: true })).toBeVisible();
    await expect(itemList(panel)).toHaveCount(0);
    await panelUi.close(panel).click();
    await expect(panel).toBeHidden();

    // 375 px: the box fits the panel without horizontal scrolling.
    await page.setViewportSize({ width: 375, height: 812 });
    panel = await openPanel(page, 1);
    // The overview preview draws the same list until the session replaces it (a detached box).
    await expect(panelUi.options(panel)).toHaveCount(4);
    const list = itemList(panel);
    await expect(list).toBeVisible();
    const box = await list.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375 + 0.5, 'box inside 375 px').toBe(true);
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
    expect(
      await list.evaluate((el) => el.scrollWidth - el.clientWidth),
      'no horizontal scroll inside the box',
    ).toBeLessThanOrEqual(0);
  },
);

/** The STEM-ITEMS list of stem items (QPLAY-01-AC14), named apart from the 보기 option list. */
function itemList(scope: Locator): Locator {
  return scope.getByRole('list', { name: /^(제시 항목|stem items)$/i });
}

/**
 * `scope` shows `lead` as its own paragraph (no trailing empty answer mark), then the 제시 항목
 * list with exactly `items` in order, then `options` below it; the list is not inside `options`.
 */
async function expectItemBox(
  scope: Locator,
  lead: string,
  items: readonly string[],
  options: Locator,
): Promise<void> {
  const question = scope.getByText(lead, { exact: true });
  await expect(question).toBeVisible();
  const list = itemList(scope);
  await expect(list).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveText([...items]);
  await expect(options.getByRole('list', { name: /^(제시 항목|stem items)$/i })).toHaveCount(0);
  const [q, l, o] = await Promise.all([
    question.boundingBox(),
    list.boundingBox(),
    options.boundingBox(),
  ]);
  if (!q || !l || !o) throw new Error('question, item list or options not laid out');
  expect(l.y, 'item list below the question sentence').toBeGreaterThanOrEqual(q.y + q.height - 1);
  expect(o.y, 'options below the item list').toBeGreaterThanOrEqual(l.y + l.height - 1);
}

/** No text "보기" a sighted user can see in `scope` (a visually hidden name is 1×1px). */
async function expectNoVisibleLabel(scope: Locator): Promise<void> {
  for (const label of await scope.getByText(/^보기$/).all()) {
    const box = await label.boundingBox();
    expect(box === null || (box.width <= 1 && box.height <= 1), 'visible "보기" label').toBe(true);
  }
}

test(
  'UX10-QVIEW-AC01 authored option order persists on reload',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedOne(
      workspaceFactory,
      'ux10-order',
      numberedMcq(unique('ux10-order'), 1, 2),
    );
    const texts = q(s, 1).revision.options.map((o) => o.text);
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    expect(await displayedOrder(panel, texts)).toEqual(texts);
    await page.reload();
    const reopened = panelUi.numbered(page, 1);
    await expect(panelUi.options(reopened)).toHaveCount(4);
    expect(await displayedOrder(reopened, texts)).toEqual(texts);
  },
);

test(
  'UX10-QVIEW-AC02 navigation arrows retain labels and submission height',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedMany(workspaceFactory, 'ux10-arrows', 2);
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    const previous = panel.getByRole('button', { name: /이전 문제|previous/i });
    const next = panel.getByRole('button', { name: /다음 문제|next/i });
    await expect(previous).toHaveAttribute('aria-disabled', 'true');
    await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    const [arrow, submit] = await Promise.all([
      next.boundingBox(),
      panelUi.submit(panel).boundingBox(),
    ]);
    expect(arrow?.height).toBe(submit?.height);
    await next.click();
    const second = panelUi.numbered(page, 2);
    await expect(second.getByRole('button', { name: /다음 문제|next/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
);

test(
  'UX10-QVIEW-AC03 reopening a submitted question restores its own result',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedOne(
      workspaceFactory,
      'ux10-result',
      numberedMcq(unique('ux10-result'), 1, 2),
    );
    const question = q(s, 1);
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    await panelUi.option(panel, question.revision.options[2]?.text ?? '').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await panelUi.close(panel).click();
    const reopened = await openPanel(page, 1);
    await expect(panelUi.result(reopened)).toContainText(RESULT_TEXT.correct);
    await expect(panelUi.option(reopened, question.revision.options[2]?.text ?? '')).toBeChecked();
  },
);

test(
  'UX10-QVIEW-AC03 a newer bank-run result replaces a cached unanswered session',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedOne(
      workspaceFactory,
      'ux10-cached-run',
      numberedMcq(unique('ux10-cached-run'), 1, 2),
    );
    const question = q(s, 1);
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    await expect(panelUi.options(panel)).toHaveCount(4);
    await panelUi.close(panel).click();
    const run = await createPracticeRun(s.owner, s.workspaceId, {
      source: 'bank',
      range: { all: true },
      random_order: false,
    });
    const opened = await openRunSession(s.owner, question.id, run.id, 1);
    expect(opened.status).toBe(201);
    if (!opened.body) throw new Error('missing run session');
    await submitPractice(s.owner, opened.body.id, {
      selected_option_ids: [question.revision.options[2]?.id ?? ''],
    });
    const reopened = await openPanel(page, 1);
    await expect(panelUi.result(reopened)).toContainText(RESULT_TEXT.correct);
    await expect(panelUi.option(reopened, question.revision.options[2]?.text ?? '')).toBeChecked();
    await panelUi.close(reopened).click();
    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'correct');
  },
);

test(
  'UX10-QVIEW-AC04 reset clears personal attempts and the heatmap',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedOne(
      workspaceFactory,
      'ux10-reset',
      numberedMcq(unique('ux10-reset'), 1, 2),
    );
    const question = q(s, 1);
    await openOverview(page, s);
    const panel = await openPanel(page, 1);
    await panelUi.option(panel, question.revision.options[2]?.text ?? '').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    const otherTab = await page.context().newPage();
    await otherTab.goto(overviewPath(s.workspaceId));
    const otherPanel = await openPanel(otherTab, 1);
    await expect(panelUi.result(otherPanel)).toContainText(RESULT_TEXT.correct);
    await panel.getByRole('button', { name: /^초기화$/ }).click();
    const confirmation = page.getByRole('alertdialog', { name: /풀이 기록 초기화/ });
    await expect(confirmation).toContainText(/Heatmap/);
    await confirmation.getByRole('button', { name: /취소|cancel/i }).click();
    expect(await listAttempts(s.owner, question.id)).toHaveLength(1);
    await panel.getByRole('button', { name: /^초기화$/ }).click();
    await confirmation.getByRole('button', { name: /^초기화$/ }).click();
    await expect(panel).not.toBeVisible();
    await expect(otherPanel).not.toBeVisible();
    await otherTab.close();
    await expect
      .poll(async () => (await overviewItem(s.owner, s.workspaceId, question.id)).status)
      .toBe('unseen');
    expect(await listAttempts(s.owner, question.id)).toEqual([]);
    const reopened = await openPanel(page, 1);
    await expect(panelUi.submit(reopened)).toBeVisible();
    await expect(panelUi.result(reopened)).toHaveCount(0);
  },
);
