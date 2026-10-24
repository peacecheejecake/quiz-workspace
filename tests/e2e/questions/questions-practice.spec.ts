// QPLAY-01 — 문제 풀이 Floating Side Panel (`/workspaces/:workspaceId/questions?question=:id`),
// docs/screens/questions-practice.md; rules docs/questions.md §2, §3.2, §4,
// docs/design-system.md §5, docs/e2e-strategy.md §6 (answer leak by network interception, URL
// panel state across back/forward/reload, focus return).
//
// Each test signs in its own owner and works in its own workspace; questions come from the public
// question API (A1, A9) and results are cross-checked through the public overview / attempts API
// (A8, A10). Every endpoint and label assumption is in the header of fixtures/questions.ts.
// Server-side contracts the browser cannot observe (100 shuffles, revision pinning, viewer and
// archived rules, cross-user isolation) are in tests/integration/questions/
// test_practice_api_contract.py.
import { randomUUID } from 'node:crypto';
import type { Locator, Page, Response } from '@playwright/test';
import {
  answerKeysIn,
  createNumberedQuestions,
  createQuestion,
  expect,
  listAttempts,
  numberedMcq,
  overviewItem,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  signInAs,
  test,
  type E2EFixtures,
  type Member,
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
  'QPLAY-01-AC02 a shuffled single-answer MCQ keeps its order in the session and is graded by option id',
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

    // Pick the correct option by its text, wherever the shuffle put it.
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

    await panelUi.retryOn(panel).click();
    await expect(panelUi.retryOff(panel)).toBeVisible();
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
    expect((await listAttempts(s.owner, question.id)).map((a) => a.result)).toEqual(['correct']);
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
    await panelUi.next(panel).click();
    panel = panelUi.numbered(page, 2);
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(at(2));
    await panelUi.next(panel).click();
    await expect(panelUi.numbered(page, 3)).toBeVisible();
    await expect(page).toHaveURL(at(3));
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
    for (const n of [1, 2, 3]) {
      expect((await overviewItem(s.owner, s.workspaceId, q(s, n).id)).status).toBe('viewed');
    }
  },
);
