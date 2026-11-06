// AIEXPL-01 — AI 문제 해설 (제출 후): the `AI 해설` area of the QuestionViewer result
// (docs/screens/ai-explanations.md; docs/questions.md §13). Contract half (AIEXPL-01-C01–C09):
// tests/integration/questions/ai_explanations/.
//
// Each test signs in its own members and works in its own workspace (book-ko uploaded, chapter
// "1장 물의 순환", CONFIRMED MCQs about evaporation with a human explanation and the book source
// page 2 — fixtures/ai-explanations.ts `explMcq`). Explanations come from the APP_ENV=test fake
// explainer (markers E2E-EXPL-*, call log, hold barrier); every API, fake and label assumption
// (E1–E9, the UI contract) is in the header of fixtures/ai-explanations.ts. EXPL.0 stays out of
// CI `E2E_PHASES` until EXPL-W turns AC01–AC07 GREEN; the main stack needs
// WORKER_AI_EXPLANATIONS=true (E8).
//
// Results show answers and explanations: traces, screenshots and videos are off and the page
// text is not attached on failure; assertions use synthetic strings only.
import { randomUUID } from 'node:crypto';
import {
  devices,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { outlineNodeId, uploadReadyBook } from '../fixtures/documents.ts';
import {
  bank,
  correctText,
  EXPL_MARKERS,
  EXPL_PROBLEMS,
  EXPL_TEXT,
  EXPL_TIMEOUT_MS,
  ExplHold,
  explainCalls,
  explMcq,
  explUi,
  expectDone,
  FAKE_RAW_SENTINEL,
  getExplanation,
  mock,
  latestMockQuestionId,
  latestSessionId,
  postExplanation,
  postRegenerate,
  readStream,
  recordAnnouncements,
  seedExplanation,
  SOURCE_PAGE,
  stackRequest,
  startExplanationsOffStack,
  startRateLimitedStack,
  versionText,
  waitForExplanation,
  wrongText,
  type ExplanationState,
} from '../fixtures/ai-explanations.ts';
import { expectAccessible } from '../fixtures/a11y.ts';
import { listMockQuestions, type MockQuestion } from '../fixtures/mock-exams.ts';
import {
  createShuffleMockExam,
  mockAttemptCount,
  openRangePicker,
  questionAttemptCount,
  runUi,
} from '../fixtures/practice-runs.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  ShareSession,
  sharedUi,
  test,
} from '../fixtures/sharing.ts';
import {
  answerKeysIn,
  createQuestion,
  detailUi,
  editorUi,
  FakeTurnstile,
  getOverview,
  getQuestion,
  homePath,
  homeUi,
  listAttempts,
  overviewPath,
  overviewUi,
  panelUi,
  PANEL_MANAGE_ITEMS,
  pageLabel,
  RESULT_TEXT,
  searchUi,
  seedMembership,
  signInAs,
  startPractice,
  submitPractice,
  type Member,
  type Problem,
  type Question,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: EXPL_TIMEOUT_MS * 2 + 120_000 });

const CH1 = '1장 물의 순환';
/** A string no response contains (fallback for an optional field in `not.toContain`). */
const NEVER = '\u0000never\u0000';

function unique(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function nth<T>(items: readonly T[], i: number): T {
  const found = items[i];
  if (found === undefined) throw new Error(`no item ${i}`);
  return found;
}

interface BookWorkspace {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly ch1: string;
}

async function seedBook(workspaceFactory: WorkspaceFactory, label: string): Promise<BookWorkspace> {
  const owner = await workspaceFactory.member(`${label}-owner`);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  const ch1 = await outlineNodeId(owner, documentId, CH1);
  return { owner, workspaceId: ws.id, documentId, ch1 };
}

async function addQuestion(
  s: BookWorkspace,
  label: string,
  n: number,
  markers: readonly string[] = [],
): Promise<Question> {
  return createQuestion(s.owner, s.workspaceId, explMcq(label, n, s.documentId, s.ch1, markers));
}

async function viewerOf(
  workspaceFactory: WorkspaceFactory,
  s: BookWorkspace,
  label: string,
  role = 'viewer',
): Promise<Member> {
  const member = await workspaceFactory.member(label);
  seedMembership(s.workspaceId, member.user.id, role);
  return member;
}

/** A second browser context (own cookies + fake Turnstile), signed in as `member` unless null. */
async function contextFor(
  browser: Browser,
  member: Member | null,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    ...options,
  });
  await new FakeTurnstile().install(context);
  const page = await context.newPage();
  if (member) await signInAs(page, member.user);
  return { context, page };
}

async function openHome(page: Page, member: Member | null, workspaceId: string): Promise<void> {
  if (member) await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

/** Opens Heatmap marker `n` and waits for its practice panel. */
async function openPanel(page: Page, n: number): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  return panel;
}

function result(panel: Locator): Locator {
  return panel.getByRole('status').filter({ hasText: /정답|오답|채점 대기|correct|pending/i });
}

/** Chooses option `text` and submits; waits for the graded result. */
async function submit(panel: Locator, text: string, expected: RegExp): Promise<void> {
  await panelUi.option(panel, text).check();
  await panelUi.submit(panel).click();
  await expect(result(panel)).toContainText(expected);
}

/** Opens marker `n` and submits `text`; returns the panel. */
async function openAndSubmit(
  page: Page,
  n: number,
  text: string,
  expected: RegExp,
): Promise<{ panel: Locator }> {
  const panel = await openPanel(page, n);
  await submit(panel, text, expected);
  return { panel };
}

/** The newest practice session `member` opened on `question` (the panel's, DB read). */
function sessionOf(member: Member, question: Question): Promise<string> {
  return latestSessionId(member.user.id, bank(question.id));
}

/** A submitted practice session of `member` on `question` through the API. */
async function submittedSession(
  member: Member,
  question: Question,
  correct = true,
): Promise<string> {
  const session = await startPractice(member, question.id);
  const text = correct ? correctText(question) : wrongText(question);
  const option = question.revision.options.find((o) => o.text === text);
  await submitPractice(member, session.id, { selected_option_ids: [option?.id ?? ''] });
  return session.id;
}

function problemType(res: { body: unknown }): string | undefined {
  return (res.body as Problem | undefined)?.type;
}

async function openDetail(page: Page, panel: Locator): Promise<Locator> {
  await panelUi.manage(panel).or(panelUi.info(panel)).click();
  await page.getByRole('menu').getByRole('menuitem', { name: PANEL_MANAGE_ITEMS.answers }).click();
  const detail = detailUi.dialog(page);
  await expect(detail).toBeVisible();
  return detail;
}

test(
  'AIEXPL-01-AC01 after a submission the AI 해설 area streams one shared explanation covering every option, with a working footnote',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('aiexpl01-ac01');
    const s = await seedBook(workspaceFactory, 'aiexpl01-ac01');
    const question = await addQuestion(s, label, 1, [EXPL_MARKERS.slow]);

    await openHome(page, s.owner, s.workspaceId);
    const panel = await openPanel(page, 1);
    const sessionId = await sessionOf(s.owner, question);
    // Before the submission: no area, no button.
    await expect(panelUi.options(panel)).toHaveCount(4);
    await expect(explUi.area(panel)).toHaveCount(0);
    await expect(explUi.create(panel)).toHaveCount(0);

    await submit(panel, correctText(question), RESULT_TEXT.correct);
    await expect(panel).toContainText(question.revision.explanation ?? '');
    const area = explUi.area(panel);
    await expect(area).toBeVisible();
    // No explanation yet: the button and notice only, no area (region / heading).
    await expect(explUi.region(panel)).toHaveCount(0);
    await expect(explUi.heading(area)).toHaveCount(0);
    await expect(area.getByText(EXPL_TEXT.sendNotice)).toHaveCount(0);
    // The area sits below the result and the human explanation.
    const resultBox = await result(panel).boundingBox();
    const areaBox = await area.boundingBox();
    expect(resultBox && areaBox && areaBox.y > resultBox.y).toBe(true);

    const announcements = await recordAnnouncements(page);
    await explUi.create(area).dblclick();
    await expect(area.getByText(EXPL_TEXT.working).first()).toBeVisible();
    const gate = { practice_session_id: sessionId };
    let explanationId = '';
    await expect
      .poll(
        async () =>
          (explanationId =
            (await getExplanation(s.owner, bank(question.id), gate)).body?.explanation?.id ?? ''),
        { timeout: EXPL_TIMEOUT_MS },
      )
      .not.toBe('');
    // SLOW: the API stream replays from seq 0 and grows in several deltas.
    const stream = await readStream(s.owner, explanationId, gate);
    expect(stream.status).toBe(200);
    expect(stream.deltas).toBeGreaterThanOrEqual(2);
    expect(stream.seqs).toEqual(stream.seqs.map((_, i) => i));
    expect(stream.terminal).toBe('done');

    await expectDone(area);
    for (const option of question.revision.options) await expect(area).toContainText(option.text);
    await expect(explUi.footnote(area, 1).first()).toBeVisible();
    await expect(explUi.sources(area)).not.toHaveCount(0);
    const firstSource = explUi.sources(area).first();
    await expect(firstSource).toContainText(CH1);
    await expect(firstSource).toContainText(pageLabel(SOURCE_PAGE));
    // A double click made one explanation: one fake call, the same id.
    expect(explainCalls(question.id)).toBe(1);
    const final = await getExplanation(s.owner, bank(question.id), gate);
    expect(final.body?.explanation?.id).toBe(explanationId);
    expect(await announcements.read()).toEqual([
      expect.stringMatching(EXPL_TEXT.started),
      expect.stringMatching(EXPL_TEXT.ready),
    ]);

    // [1] → 본문 발췌 → PDF에서 보기 opens DOC-02 at that page.
    await explUi.footnote(area, 1).first().click();
    const excerpt = searchUi.excerptPanel(page);
    await expect(excerpt).toBeVisible();
    await searchUi.openInPdf(excerpt).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === `/workspaces/${s.workspaceId}/documents/${s.documentId}`,
    );
    await expect(editorUi.currentPage(page)).toHaveValue(String(SOURCE_PAGE));
  },
);

test(
  'AIEXPL-01-AC02 the server refuses AI explanations before a submission and for other users’ sessions without calling the explainer',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('aiexpl01-ac02');
    const s = await seedBook(workspaceFactory, 'aiexpl01-ac02');
    const question = await addQuestion(s, label, 1);
    const stored = await seedExplanation(s.owner, bank(question.id));
    const learner = await viewerOf(workspaceFactory, s, 'aiexpl01-ac02-learner');
    const other = await viewerOf(workspaceFactory, s, 'aiexpl01-ac02-other');
    const otherSession = await submittedSession(other, question);
    const calls = explainCalls(question.id);

    // The practice-session response still carries no answer or AI explanation field.
    const sessionBody = await startPractice(other, question.id);
    expect(answerKeysIn(sessionBody)).toEqual([]);
    expect(JSON.stringify(sessionBody)).not.toMatch(/ai_explanation|explanation_id/);

    await signInAs(page, learner.user);
    await page.goto(overviewPath(s.workspaceId));
    const panel = await openPanel(page, 1);
    const sessionId = await sessionOf(learner, question);
    await panelUi.option(panel, wrongText(question)).check();
    await expect(explUi.area(panel)).toHaveCount(0);

    const refusals: [string, Promise<{ status: number; body: unknown; text: string }>][] = [
      [
        'POST before submit',
        postExplanation(learner, bank(question.id), { practice_session_id: sessionId }),
      ],
      [
        'GET before submit',
        getExplanation(learner, bank(question.id), { practice_session_id: sessionId }),
      ],
      ['POST without a session', postExplanation(learner, bank(question.id), {})],
      ['GET without a session', getExplanation(learner, bank(question.id), {})],
    ];
    for (const [what, call] of refusals) {
      const res = await call;
      expect(res.status, what).toBe(409);
      expect(problemType(res), what).toBe(EXPL_PROBLEMS.beforeSubmit);
      expect(answerKeysIn(res.body), what).toEqual([]);
      expect(res.text, what).not.toContain(stored.body?.summary_md ?? NEVER);
      expect(res.text, what).not.toContain(question.revision.explanation ?? NEVER);
    }
    for (const call of [
      postExplanation(learner, bank(question.id), { practice_session_id: otherSession }),
      getExplanation(learner, bank(question.id), { practice_session_id: otherSession }),
    ]) {
      const res = await call;
      expect(res.status).toBe(404);
      expect(answerKeysIn(res.body)).toEqual([]);
    }
    expect(explainCalls(question.id)).toBe(calls);

    // After the submission the same session reads the stored one (no new call).
    await panelUi.submit(panel).click();
    await expect(result(panel)).toContainText(RESULT_TEXT.incorrect);
    const after = await getExplanation(learner, bank(question.id), {
      practice_session_id: sessionId,
    });
    expect(after.status).toBe(200);
    expect(after.body?.explanation?.id).toBe(stored.id);
    const post = await postExplanation(learner, bank(question.id), {
      practice_session_id: sessionId,
    });
    expect([200, 202]).toContain(post.status);
    expect(post.body?.explanation?.id).toBe(stored.id);
    expect(explainCalls(question.id)).toBe(calls);
  },
);

test(
  'AIEXPL-01-AC03 one explanation per question revision is shared by members, generated once under concurrency and redone after an edit',
  { tag: '@infra' },
  async ({ browser, page, workspaceFactory }) => {
    const label = unique('aiexpl01-ac03');
    const s = await seedBook(workspaceFactory, 'aiexpl01-ac03');
    const hold = new ExplHold();
    const first = await addQuestion(s, label, 1);
    const second = await addQuestion(s, label, 2, [hold.marker]);
    const stored = await seedExplanation(s.owner, bank(first.id));
    const a = await viewerOf(workspaceFactory, s, 'aiexpl01-ac03-a');
    const b = await viewerOf(workspaceFactory, s, 'aiexpl01-ac03-b');
    const firstCalls = explainCalls(first.id);

    // A: the cached one opens without a generation.
    await openHome(page, a, s.workspaceId);
    let { panel } = await openAndSubmit(page, 1, wrongText(first), RESULT_TEXT.incorrect);
    let area = explUi.area(panel);
    await expect(explUi.show(area)).toHaveAttribute('aria-expanded', 'true');
    await expect(explUi.create(area)).toHaveCount(0);
    await expect(area).toContainText(nth(first.revision.options, 0).text);
    expect(explainCalls(first.id)).toBe(firstCalls);
    const viaFirst = await getExplanation(a, bank(first.id), {
      practice_session_id: await sessionOf(a, first),
    });
    expect(viaFirst.body?.explanation?.id).toBe(stored.id);
    await panelUi.close(panel).click();

    // The second question: A (wrong) and B (right) start it at once; one generation, held.
    const other = await contextFor(browser, b);
    try {
      await other.page.goto(overviewPath(s.workspaceId));
      const panelA = (await openAndSubmit(page, 2, wrongText(second), RESULT_TEXT.incorrect)).panel;
      const panelB = (await openAndSubmit(other.page, 2, correctText(second), RESULT_TEXT.correct))
        .panel;
      const [areaA, areaB] = [explUi.area(panelA), explUi.area(panelB)];
      await Promise.all([explUi.create(areaA).click(), explUi.create(areaB).click()]);
      await hold.held();
      await expect(areaA.getByText(EXPL_TEXT.working).first()).toBeVisible();
      await expect(areaB.getByText(EXPL_TEXT.working).first()).toBeVisible();
      hold.release();
      await expectDone(areaA);
      await expectDone(areaB);
      expect(explainCalls(second.id)).toBe(1);
      // The same text whatever each chose.
      const textA = await areaA.innerText();
      expect(await areaB.innerText()).toBe(textA);
      const sessionA = await submittedSession(a, second, false);
      const sessionB = await submittedSession(b, second, true);
      const viaA = await getExplanation(a, bank(second.id), { practice_session_id: sessionA });
      const viaB = await getExplanation(b, bank(second.id), { practice_session_id: sessionB });
      expect(viaA.body?.explanation?.id).toBeTruthy();
      expect(viaB.body?.explanation?.id).toBe(viaA.body?.explanation?.id);
      expect(viaB.body?.explanation?.body).toEqual(viaA.body?.explanation?.body);
      await panelUi.close(panelA).click();
    } finally {
      hold.release();
      await other.context.close();
    }

    // An editor rewrites the human explanation: a new revision, so no AI explanation yet.
    const current = await getQuestion(s.owner, first.id);
    await s.owner.api.ok(
      'PATCH',
      `/questions/${first.id}`,
      { base_revision_id: current.revision.id, explanation: `${label} 고친 사람 해설` },
      [200],
    );
    await page.reload();
    ({ panel } = await openAndSubmit(page, 1, correctText(first), RESULT_TEXT.correct));
    area = explUi.area(panel);
    await expect(explUi.create(area)).toBeVisible();
    await expect(explUi.show(area)).toHaveCount(0);
    await expect(area).not.toContainText(stored.body?.summary_md ?? NEVER);
    expect(explainCalls(first.id)).toBe(firstCalls);
  },
);

test(
  'AIEXPL-01-AC04 regenerate for editors up to the daily cap, create for viewers, read-only for archived workspaces, outsiders and share guests',
  { tag: '@infra' },
  async ({ browser, page, workspaceFactory }) => {
    const label = unique('aiexpl01-ac04');
    const s = await seedBook(workspaceFactory, 'aiexpl01-ac04');
    const withExpl = await addQuestion(s, label, 1);
    const withoutExpl = await addQuestion(s, label, 2);
    // Never explained by anyone: the guest's absence checks (withoutExpl gets one from the viewer).
    const unexplained = await addQuestion(s, label, 3);
    await seedExplanation(s.owner, bank(withExpl.id));
    const viewer = await viewerOf(workspaceFactory, s, 'aiexpl01-ac04-viewer');
    const outsider = await workspaceFactory.member('aiexpl01-ac04-outsider');
    const link = await createShareLink(s.owner, s.workspaceId);

    // Archived workspace: one question with an explanation and one without, both submitted.
    const archived = await seedBook(workspaceFactory, 'aiexpl01-ac04-archived');
    const archivedWith = await addQuestion(archived, `${label}-arch`, 1);
    const archivedWithout = await addQuestion(archived, `${label}-arch`, 2);
    await seedExplanation(archived.owner, bank(archivedWith.id));
    const archivedWithSession = await submittedSession(archived.owner, archivedWith);
    const archivedWithoutSession = await submittedSession(archived.owner, archivedWithout);
    await workspaceFactory.archive(archived.owner, archived.workspaceId);

    // Editor: 다시 만들기 three times (versions 2–4), the fourth is refused with its reason.
    await openHome(page, s.owner, s.workspaceId);
    const { panel } = await openAndSubmit(page, 1, correctText(withExpl), RESULT_TEXT.correct);
    const sessionId = await sessionOf(s.owner, withExpl);
    const area = explUi.area(panel);

    await expectDone(area);
    for (const k of [2, 3, 4]) {
      await explUi.regenerate(area).click();
      await expect(area.getByText(versionText(k))).toBeVisible({ timeout: EXPL_TIMEOUT_MS });
      await expectDone(area);
    }
    await explUi.regenerate(area).click();
    await expect(area.getByText(EXPL_TEXT.regenerateLimit)).toBeVisible();
    const capped = await postRegenerate(s.owner, bank(withExpl.id), {
      practice_session_id: sessionId,
    });
    expect(capped.status).toBe(409);
    expect(problemType(capped)).toBe(EXPL_PROBLEMS.regenerateLimit);

    // Viewer: creates the missing one, has no 다시 만들기, and the API refuses it.
    const viewerCtx = await contextFor(browser, viewer);
    try {
      await viewerCtx.page.goto(overviewPath(s.workspaceId));
      const v = await openAndSubmit(
        viewerCtx.page,
        2,
        wrongText(withoutExpl),
        RESULT_TEXT.incorrect,
      );
      const vArea = explUi.area(v.panel);
      await explUi.create(vArea).click();
      await expectDone(vArea);
      await expect(explUi.regenerate(vArea)).toHaveCount(0);
      const refused = await postRegenerate(viewer, bank(withoutExpl.id), {
        practice_session_id: await sessionOf(viewer, withoutExpl),
      });
      expect(refused.status).toBe(403);
      expect(problemType(refused)).toBe(EXPL_PROBLEMS.insufficientRole);
    } finally {
      await viewerCtx.context.close();
    }

    // Archived workspace: only the existing one, no create; POST is 403 workspace-archived.
    const archivedCtx = await contextFor(browser, archived.owner);
    try {
      const p = archivedCtx.page;
      await p.goto(overviewPath(archived.workspaceId));
      let detail = await openDetail(p, await openPanel(p, 1));
      let dArea = explUi.area(detail);

      await expectDone(dArea);
      await expect(explUi.create(dArea)).toHaveCount(0);
      await expect(explUi.regenerate(dArea)).toHaveCount(0);
      await p.keyboard.press('Escape');
      await p.keyboard.press('Escape');
      detail = await openDetail(p, await openPanel(p, 2));
      dArea = explUi.area(detail);
      await expect(dArea.getByText(EXPL_TEXT.archived)).toBeVisible();
      await expect(explUi.create(dArea)).toHaveCount(0);
    } finally {
      await archivedCtx.context.close();
    }
    const archivedPost = await postExplanation(archived.owner, bank(archivedWithout.id), {
      practice_session_id: archivedWithoutSession,
    });
    expect(archivedPost.status).toBe(403);
    expect(problemType(archivedPost)).toBe(EXPL_PROBLEMS.archived);
    const archivedRead = await getExplanation(archived.owner, bank(archivedWith.id), {
      practice_session_id: archivedWithSession,
    });
    expect(archivedRead.status).toBe(200);
    expect(archivedRead.body?.explanation?.status).toBe('succeeded');

    // Another user: 404 whatever the gate.
    for (const res of [
      await getExplanation(outsider, bank(withExpl.id), { view: 'detail' }),
      await postExplanation(outsider, bank(withExpl.id), { view: 'detail' }),
      await getExplanation(outsider, bank(withExpl.id), { practice_session_id: sessionId }),
    ]) {
      expect(res.status).toBe(404);
      expect(answerKeysIn(res.body)).toEqual([]);
    }

    // Share guest: read-only "AI 해설" on the question that has one; 404 for the other.
    const guest = await contextFor(browser, null);
    try {
      await openShareWithSecret(guest.page, link.id, link.secret);
      await sharedUi.question(guest.page, withExpl.revision.stem).click();
      let shared = sharedUi.questionPanel(guest.page);
      await expect(shared).toBeVisible();
      const sArea = explUi.sharedArea(shared);
      await expect(explUi.sharedToggle(sArea)).toHaveAttribute('aria-expanded', 'true');
      await expect(explUi.badge(sArea)).toBeVisible();
      await expect(sArea).toContainText(nth(withExpl.revision.options, 0).text);
      for (const absent of [
        explUi.create(sArea),
        explUi.regenerate(sArea),
        explUi.alert(sArea),
        sArea.getByText(/버전 \d|version \d/i),
      ]) {
        await expect(absent).toHaveCount(0);
      }
      await guest.page.keyboard.press('Escape');
      await sharedUi.question(guest.page, unexplained.revision.stem).click();
      shared = sharedUi.questionPanel(guest.page);
      await expect(shared).toContainText(unexplained.revision.stem);
      await expect(explUi.sharedArea(shared)).toHaveCount(0);
    } finally {
      await guest.context.close();
    }
    const share = await ShareSession.open(link.id, link.secret);
    const sharedRead = await share.get<Record<string, unknown>>(
      `/questions/${withExpl.id}/ai-explanation`,
    );
    expect(sharedRead.status).toBe(200);
    for (const key of ['status', 'version', 'error_code', 'usage']) {
      expect(Object.keys(sharedRead.body ?? {})).not.toContain(key);
    }
    expect((await share.get(`/questions/${unexplained.id}/ai-explanation`)).status).toBe(404);
    // The viewer's explanation of withoutExpl is shared too (the latest succeeded one).
    expect((await share.get(`/questions/${withoutExpl.id}/ai-explanation`)).status).toBe(200);
  },
);

test(
  'AIEXPL-01-AC05 failures, answer mismatches, the per-minute limit and the feature switch show their reasons without raw model output',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('aiexpl01-ac05');
    const s = await seedBook(workspaceFactory, 'aiexpl01-ac05');
    const failing = await addQuestion(s, label, 1, [EXPL_MARKERS.fail]);
    const mismatching = await addQuestion(s, label, 2, [EXPL_MARKERS.mismatch]);
    const plain = [3, 4, 5];
    const plainQuestions: Question[] = [];
    for (const n of plain) plainQuestions.push(await addQuestion(s, label, n));
    const withExpl = await addQuestion(s, label, 6);
    const withoutExpl = await addQuestion(s, label, 7);
    await seedExplanation(s.owner, bank(withExpl.id));

    // FAIL, then 다시 시도 succeeds; MISMATCH is neither stored nor shown, then 다시 시도 succeeds.
    await openHome(page, s.owner, s.workspaceId);
    for (const [n, question, reason] of [
      [1, failing, EXPL_TEXT.unavailable],
      [2, mismatching, EXPL_TEXT.mismatch],
    ] as const) {
      const { panel } = await openAndSubmit(page, n, correctText(question), RESULT_TEXT.correct);
      const sessionId = await sessionOf(s.owner, question);
      const area = explUi.area(panel);
      await explUi.create(area).click();
      await expect(explUi.alert(area)).toContainText(reason, { timeout: EXPL_TIMEOUT_MS });
      await expect(area).not.toContainText(FAKE_RAW_SENTINEL);
      const failed = await getExplanation(s.owner, bank(question.id), {
        practice_session_id: sessionId,
      });
      expect(failed.body?.explanation?.status).toBe('failed');
      expect(failed.body?.explanation?.body ?? null).toBeNull();
      expect(failed.text).not.toContain(FAKE_RAW_SENTINEL);
      await explUi.retry(area).click();
      await expectDone(area);
      await expect(area).not.toContainText(FAKE_RAW_SENTINEL);
      const retried = await waitForExplanation(s.owner, bank(question.id), {
        practice_session_id: sessionId,
      });
      expect(retried.status).toBe('succeeded');
      expect(retried.id).not.toBe(failed.body?.explanation?.id);
      expect(explainCalls(question.id)).toBe(2);
      await panelUi.close(panel).click();
    }

    // The per-minute limit (2 on this stack): the third new one in a minute is refused (429);
    // a cached explanation still opens.
    const limited = await startRateLimitedStack();
    try {
      const learner = await viewerOf(workspaceFactory, s, 'aiexpl01-ac05-learner');
      await page.context().clearCookies();
      await signInAs(page, learner.user);
      await page.goto(`${limited.webUrl}${overviewPath(s.workspaceId)}`);
      for (const [i, n] of plain.entries()) {
        const question = nth(plainQuestions, i);
        const { panel } = await openAndSubmit(page, n, correctText(question), RESULT_TEXT.correct);
        const area = explUi.area(panel);
        await explUi.create(area).click();
        if (i < 2) {
          await expectDone(area);
        } else {
          await expect(area.getByText(EXPL_TEXT.rateLimited)).toBeVisible();
          expect(explainCalls(question.id)).toBe(0);
        }
        await panelUi.close(panel).click();
      }
      const { panel } = await openAndSubmit(page, 6, correctText(withExpl), RESULT_TEXT.correct);

      await expectDone(explUi.area(panel));
      const third = nth(plainQuestions, 2);
      const session = await submittedSession(learner, third);
      const direct = await stackRequest<Problem>(
        limited,
        learner,
        'POST',
        `/questions/${third.id}/ai-explanation`,
        { practice_session_id: session },
      );
      expect(direct.status).toBe(429);
      expect(direct.body?.type).toBe(EXPL_PROBLEMS.rateLimited);
    } finally {
      await limited.stop();
    }

    // Feature off: the reason instead of a button; existing explanations still read.
    const off = await startExplanationsOffStack();
    try {
      await page.goto(`${off.webUrl}${overviewPath(s.workspaceId)}`);
      let { panel } = await openAndSubmit(page, 7, correctText(withoutExpl), RESULT_TEXT.correct);
      await expect(explUi.area(panel).getByText(EXPL_TEXT.disabled)).toBeVisible();
      await expect(explUi.create(explUi.area(panel))).toHaveCount(0);
      await panelUi.close(panel).click();
      panel = await openPanel(page, 6);
      await expect(result(panel)).toContainText(RESULT_TEXT.correct);
      await expectDone(explUi.area(panel));
      const session = await submittedSession(s.owner, withoutExpl);
      const refused = await stackRequest<Problem>(
        off,
        s.owner,
        'POST',
        `/questions/${withoutExpl.id}/ai-explanation`,
        { practice_session_id: session },
      );
      expect(refused.status).toBe(409);
      expect(refused.body?.type).toBe(EXPL_PROBLEMS.disabled);
      expect(refused.text).not.toContain(FAKE_RAW_SENTINEL);
    } finally {
      await off.stop();
    }
  },
);

test(
  'AIEXPL-01-AC06 the 문제 상세 dialog makes the shared explanation without a submission by keyboard; the phone sheet keeps it below the result',
  { tag: '@infra' },
  async ({ browser, page, workspaceFactory }) => {
    const label = unique('aiexpl01-ac06');
    const s = await seedBook(workspaceFactory, 'aiexpl01-ac06');
    const question = await addQuestion(s, label, 1);
    const phoneQuestion = await addQuestion(s, label, 2);
    const viewer = await viewerOf(workspaceFactory, s, 'aiexpl01-ac06-viewer');

    await openHome(page, viewer, s.workspaceId);
    const panel = await openPanel(page, 1);
    await panelUi.option(panel, wrongText(question)).check();
    // Keyboard only: 문제 정보 › 정답·해설 보기, then AI 해설.
    const menuButton = panelUi.info(panel);
    await menuButton.focus();
    await page.keyboard.press('Enter');
    const item = page.getByRole('menu').getByRole('menuitem', { name: PANEL_MANAGE_ITEMS.answers });
    await expect(item).toBeVisible();
    await item.focus();
    await page.keyboard.press('Enter');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    const area = explUi.area(detail);
    await expect(explUi.create(area)).toBeVisible();
    await explUi.create(area).focus();
    await page.keyboard.press('Enter');
    await expect(explUi.heading(area)).toBeFocused();
    await expectDone(area);
    await expect(explUi.heading(area)).toBeFocused();
    await expectAccessible(page, 'AI 해설 완료 (문제 상세)', { include: ['[role="dialog"]'] });
    expect(explainCalls(question.id)).toBe(1);

    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await expect(menuButton).toBeFocused();
    // The unanswered practice is untouched and nothing was recorded.
    await expect(panelUi.option(panel, wrongText(question))).toBeChecked();
    await expect(panelUi.submit(panel)).toBeVisible();
    expect(await listAttempts(viewer, question.id)).toEqual([]);
    // The same cache reaches another member's submitted result.
    const ownerSession = await submittedSession(s.owner, question);
    const shared = await getExplanation(s.owner, bank(question.id), {
      practice_session_id: ownerSession,
    });
    expect(shared.body?.explanation?.status).toBe('succeeded');
    expect(explainCalls(question.id)).toBe(1);

    // Phone: the bottom sheet keeps the area below the result, no horizontal scroll.
    const phone = await contextFor(browser, viewer, { ...devices['iPhone 13'] });
    try {
      const p = phone.page;
      await p.goto(overviewPath(s.workspaceId));
      await overviewUi.dot(p, 2).tap();
      const sheet = panelUi.numbered(p, 2);
      await expect(sheet).toBeVisible();
      await panelUi.option(sheet, correctText(phoneQuestion)).tap();
      await panelUi.submit(sheet).tap();
      await expect(result(sheet)).toContainText(RESULT_TEXT.correct);
      const phoneArea = explUi.area(sheet);
      const button = explUi.create(phoneArea);
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box && box.height >= 24 && box.width >= 24).toBe(true);
      await button.tap();
      await expectDone(phoneArea);
      const r = await result(sheet).boundingBox();
      const a = await phoneArea.boundingBox();
      expect(r && a && a.y > r.y).toBe(true);
      expect(
        await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expectAccessible(p, 'AI 해설 완료 (휴대폰)', {
        include: ['[role="dialog"]'],
        schemes: ['light'],
      });
    } finally {
      await phone.context.close();
    }
  },
);

test(
  'AIEXPL-01-AC07 range runs share the bank cache; a 보기 섞기 mock question gets its own gated explanation that an edit resets',
  { tag: '@infra' },
  async ({ browser, page, workspaceFactory }) => {
    const label = unique('aiexpl01-ac07');
    const s = await seedBook(workspaceFactory, 'aiexpl01-ac07');
    const q1 = await addQuestion(s, label, 1);
    const q2 = await addQuestion(s, label, 2);
    const a = await viewerOf(workspaceFactory, s, 'aiexpl01-ac07-a');
    const b = await viewerOf(workspaceFactory, s, 'aiexpl01-ac07-b');
    const name = `모의 ${label}`;
    const exam = await createShuffleMockExam(s.owner, s.workspaceId, name, [q1.id, q2.id], 2);
    const mockQuestions: MockQuestion[] = await listMockQuestions(s.owner, exam.id, true);
    // q2 has a bank explanation; q1 gets its own through A's run below.
    const bankExplanations = new Map<string, string>([
      [q2.id, (await seedExplanation(s.owner, bank(q2.id))).id],
    ]);
    const q1Calls = explainCalls(q1.id);

    // A: 문제 › 문제 풀기 over both, submit position 1, make its explanation, 다음, 이전.
    await openHome(page, a, s.workspaceId);
    let run = await openRangePicker(page);
    await runUi.selectAll(run).check();
    await runUi.start(run).click();
    run = runUi.panel(page);
    await expect(runUi.title(run, 1)).toBeVisible();
    await runUi.option(run, correctText(q1)).check();
    await runUi.submit(run).click();
    await expect(runUi.result(run)).toContainText(RESULT_TEXT.correct);
    let area = explUi.area(run);
    await explUi.create(area).click();
    await expectDone(area);
    expect(explainCalls(q1.id)).toBe(q1Calls + 1);
    const runExplanationId =
      (await getExplanation(a, bank(q1.id), { view: 'detail' })).body?.explanation?.id ?? '';
    expect(runExplanationId).not.toBe('');
    bankExplanations.set(q1.id, runExplanationId);
    await runUi.next(run).click();
    await expect(runUi.title(run, 2)).toBeVisible();
    await expect(explUi.area(run)).toHaveCount(0); // not submitted yet
    await runUi.previous(run).click();
    await expect(runUi.title(run, 1)).toBeVisible();
    area = explUi.area(run);

    await expectDone(area);
    await page.keyboard.press('Escape');
    await expect(run).toBeHidden();
    // The same cache from the Heatmap's practice panel.
    const panel = await openPanel(page, 1);
    await expect(result(panel)).toContainText(RESULT_TEXT.correct);
    await expectDone(explUi.area(panel));
    const viaPanel = await getExplanation(a, bank(q1.id), {
      practice_session_id: await sessionOf(a, q1),
    });
    expect(viaPanel.body?.explanation?.id).toBe(runExplanationId);
    expect(explainCalls(q1.id)).toBe(q1Calls + 1);
    await panelUi.close(panel).click();
    // Closing navigates back to the bare home; a goto that starts before that settles is
    // interrupted by it (WebKit).
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL((url) => url.search === '');

    // A: the mock exam's first question — refused before the submission, then its own one.
    const overviewBefore = await getOverview(a, s.workspaceId);
    const bankAttempts = questionAttemptCount(s.workspaceId);
    await page.goto(homePath(s.workspaceId, 'panel=mock-exams'));
    const list = page.getByRole('dialog', { name: /^(모의고사|mock exams?)$/i });
    await list
      .getByRole('listitem')
      .filter({ hasText: name })
      .getByRole('button', { name: /^(풀기|practi[sc]e|start)$/i })
      .click();
    let mockRun = runUi.panel(page);
    await runUi.start(mockRun).click();
    mockRun = runUi.panel(page);
    await expect(runUi.mockTitle(mockRun, 1)).toBeVisible();
    const mqId = await latestMockQuestionId(a.user.id, exam.id);
    const mq = mockQuestions.find((m) => m.id === mqId);
    if (!mq) throw new Error('mock question of position 1 not found');
    const mockSession = { id: await latestSessionId(a.user.id, mock(mq.id)) };
    const early = await getExplanation(a, mock(mq.id), {
      mock_practice_session_id: mockSession.id,
    });
    expect(early.status).toBe(409);
    expect(problemType(early)).toBe(EXPL_PROBLEMS.beforeSubmit);
    expect(answerKeysIn(early.body)).toEqual([]);
    expect(explainCalls(mq.id)).toBe(0);
    await expect(explUi.area(mockRun)).toHaveCount(0);
    const correctMock = mq.options.find((o) => (mq.correct_option_ids ?? []).includes(o.id));
    await runUi.option(mockRun, correctMock?.text ?? '').check();
    await runUi.submit(mockRun).click();
    await expect(runUi.result(mockRun)).toContainText(RESULT_TEXT.correct);
    const mockAttempts = mockAttemptCount(exam.id);
    const mockArea = explUi.area(mockRun);
    await explUi.create(mockArea).click();
    await expectDone(mockArea);
    expect(explainCalls(mq.id)).toBe(1);
    const mockState = await getExplanation(a, mock(mq.id), {
      mock_practice_session_id: mockSession.id,
    });
    const mockExplanationId = mockState.body?.explanation?.id;
    expect(mockExplanationId).toBeTruthy();
    expect(mockExplanationId).not.toBe(bankExplanations.get(mq.source.question_id ?? ''));
    expect(mockExplanationId).not.toBe(runExplanationId);
    // Making it recorded no attempt and changed no Heatmap state.
    expect(mockAttemptCount(exam.id)).toBe(mockAttempts);
    expect(questionAttemptCount(s.workspaceId)).toBe(bankAttempts);
    const overviewAfter = await getOverview(a, s.workspaceId);
    expect(overviewAfter.items.map((i) => [i.question_id, i.status])).toEqual(
      overviewBefore.items.map((i) => [i.question_id, i.status]),
    );

    // B: the same mock question, no generation; after an edit (new revision) none again.
    const other = await contextFor(browser, b);
    try {
      const p = other.page;
      const startMock = async (): Promise<Locator> => {
        await p.goto(homePath(s.workspaceId, 'panel=mock-exams'));
        await p
          .getByRole('dialog', { name: /^(모의고사|mock exams?)$/i })
          .getByRole('listitem')
          .filter({ hasText: name })
          .getByRole('button', { name: /^(풀기|practi[sc]e|start)$/i })
          .click();
        await runUi.start(runUi.panel(p)).click();
        const r = runUi.panel(p);
        await expect(runUi.mockTitle(r, 1)).toBeVisible();
        await runUi.option(r, correctMock?.text ?? '').check();
        await runUi.submit(r).click();
        await expect(runUi.result(r)).toContainText(RESULT_TEXT.correct);
        return r;
      };
      let r = await startMock();

      await expectDone(explUi.area(r));
      expect(explainCalls(mq.id)).toBe(1);
      await p.keyboard.press('Escape');
      await s.owner.api.ok(
        'PATCH',
        `/mock-exam-questions/${mq.id}`,
        { base_revision_id: mq.revision.id, explanation: `${label} 고친 모의고사 해설` },
        [200],
      );
      r = await startMock();
      await expect(explUi.create(explUi.area(r))).toBeVisible();
      await expect(explUi.show(explUi.area(r))).toHaveCount(0);
    } finally {
      await other.context.close();
    }
    const stateAfterEdit: ExplanationState | undefined = (
      await getExplanation(s.owner, mock(mq.id), { view: 'manage' })
    ).body;
    expect(stateAfterEdit?.explanation ?? null).toBeNull();
  },
);
