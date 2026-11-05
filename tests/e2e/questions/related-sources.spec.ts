// RELSRC-01 — 관련 본문 (제출 후): docs/screens/related-sources.md, docs/questions.md §13,
// docs/workspace-sharing.md §10. Contract half (RELSRC-01-C01–C07):
// tests/integration/questions/related_sources/.
//
// Each test signs in its own members and works in its own workspace. The book is book-ko with three
// passages corrected through DOC-02 and published (fixtures/related-sources.ts R10: "가나다 원리" on
// p.2 twice — the question's source block and a second block of the same page — and "가나다 응용" on
// p.4). Questions come from the public question API; their source block is stamped as the
// superuser (R9). Every API, marker and label assumption (R1–R10, the UI contract) is in the header
// of fixtures/related-sources.ts. The search fakes are the deterministic embedder and reranker of
// APP_ENV=test; no LLM. RELSRC.0 stays out of CI `E2E_PHASES` until RELSRC-W.
//
// The viewer shows answers and explanations after a submission: traces, screenshots and videos are
// off, and shown text is checked with role/text assertions on synthetic strings only.
import { randomUUID } from 'node:crypto';
import type { Locator, Page, Route } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import { isMissingRoute, type ApiResponse } from '../fixtures/api.ts';
import { questionPaper, waitForLatestImport } from '../fixtures/questions.ts';
import {
  createShuffleMockExam,
  mockAttemptCount,
  openRangePicker,
  questionAttemptCount,
  runUi,
} from '../fixtures/practice-runs.ts';
import { mockExamsPath, mockUi, questionRow } from '../fixtures/mock-exams.ts';
import {
  addImportedSource,
  ANSWER,
  ANSWER_PAGE,
  APPLIED,
  APPLIED_PAGE,
  blockIdOf,
  CH1,
  CH2,
  correctAndPublish,
  countText,
  createSourcedQuestion,
  DENSE_MARKER,
  editStem,
  expandRelated,
  expectCollapsedWithoutRequest,
  expectProblem,
  FAIL_MARKER,
  getMockRelated,
  getRelated,
  keysIn,
  listBlocks,
  mockRelatedRowCount,
  openSessionId,
  pageText,
  practiceFootprint,
  RELATED_LIMIT,
  RELATED_PROBLEMS,
  relatedResponse,
  relatedRowCount,
  relatedRows,
  relatedUi,
  RelsrcHold,
  relsrcInput,
  relsrcStem,
  requestMockRelated,
  requestRelated,
  rowPages,
  searchCalls,
  seedRelsrcBook,
  sharedRelatedPath,
  submitAndRead,
  submitOnce,
  TEXT,
  trackRelatedRequests,
  UI_TEXT,
  type RelatedSources,
  type RelsrcBook,
} from '../fixtures/related-sources.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharedUi,
  ShareSession,
  test,
} from '../fixtures/sharing.ts';
import {
  archiveQuestion,
  choosePanelMenu,
  createQuestion,
  detailUi,
  editorUi,
  getOverview,
  homePath,
  homeUi,
  inactiveUi,
  JOB_TIMEOUT_MS,
  listDocuments,
  mcqInput,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  seedMembership,
  setDocumentKind,
  signInAs,
  uploadPdf,
  waitForJob,
  type Member,
  type Question,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 120_000 });

function unique(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function openHome(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

async function switchUser(page: Page, member: Member, workspaceId: string): Promise<void> {
  await page.context().clearCookies();
  await openHome(page, member, workspaceId);
}

/** Fails with a clear reason while the endpoint does not exist (RED evidence). */
function expectRoute(res: ApiResponse, what: string): void {
  expect(isMissingRoute(res), `${what} is implemented (got HTTP ${res.status})`).toBe(false);
}

interface Seeded {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly book: RelsrcBook;
}

async function seedWorkspace(workspaceFactory: WorkspaceFactory, label: string): Promise<Seeded> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const book = await seedRelsrcBook(owner, ws.id);
  return { owner, workspaceId: ws.id, book };
}

async function viewer(
  workspaceFactory: WorkspaceFactory,
  s: Seeded,
  label: string,
): Promise<Member> {
  const member = await workspaceFactory.member(label);
  // fixtures/db.ts use 2: no membership API creates a viewer.
  seedMembership(s.workspaceId, member.user.id, 'viewer');
  return member;
}

/** Opens question `n` from the Heatmap, answers it with `answer` and waits for the result. */
async function answerInPanel(page: Page, n: number, answer: string): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  await panelUi.option(panel, answer).check();
  await panelUi.submit(panel).click();
  await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
  return panel;
}

/**
 * Waits until a closed practice panel has finished its navigation back to the bare home; a
 * `goto` that starts before that settles is interrupted by it (WebKit).
 */
async function expectClosedToHome(page: Page, panel: Locator): Promise<void> {
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL((url) => url.search === '');
}

/** Reopens the submitted result with `?question=` and checks its restored grading. */
async function reopenSubmitted(
  page: Page,
  workspaceId: string,
  question: Question,
): Promise<Locator> {
  await page.goto(overviewPath(workspaceId, question.id));
  const panel = panelUi.panel(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
  return panel;
}

/** Holds the page's related-sources requests until `release()` (to see the loading state). */
async function holdRelatedRequests(
  page: Page,
): Promise<{ release: () => void; done: () => Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held: Promise<void>[] = [];
  const matches = (url: URL) => url.pathname.endsWith('/related-sources');
  await page.route(matches, (route: Route) => {
    const continued = gate.then(() => route.continue());
    held.push(continued);
    return continued;
  });
  return {
    release,
    done: async () => {
      await Promise.all(held);
      await page.unroute(matches);
    },
  };
}

async function expectBoldUnderlined(mark: Locator): Promise<void> {
  const style = await mark.evaluate((el) => {
    const s = getComputedStyle(el);
    return { weight: Number(s.fontWeight), decoration: s.textDecorationLine };
  });
  expect(style.weight, '<mark> is bold').toBeGreaterThanOrEqual(600);
  expect(style.decoration, '<mark> is underlined').toContain('underline');
}

function excerpts(list: RelatedSources): string {
  return list.items.map((i) => i.excerpt).join('\n');
}

test(
  'RELSRC-01-AC01 after submitting, 관련 본문 is collapsed and requests nothing; expanded, it lists the question-source passage first, then the 2장 passage, and opens the excerpt and the PDF page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('relsrc01-ac01');
    const s = await seedWorkspace(workspaceFactory, 'relsrc01-ac01');
    const question = await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
      ...relsrcInput(label, s.book),
      question_number: 1,
    });
    await openHome(page, s.owner, s.workspaceId);
    const requests = trackRelatedRequests(page);

    // Before the submission the result area has no 관련 본문.
    await overviewUi.dot(page, 1).click();
    let panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await expect(panelUi.submit(panel)).toBeVisible();
    await expect(relatedUi.toggle(panel)).toHaveCount(0);

    const hold = await holdRelatedRequests(page);
    await panelUi.option(panel, ANSWER).check();
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    // Collapsed after the submission and nothing requested; the expand reads the list (held here,
    // so the loading state shows).
    const toggle = relatedUi.toggle(panel);
    await expectCollapsedWithoutRequest(panel, requests);
    let body = await expandRelated(panel);
    await expect(relatedUi.status(body, UI_TEXT.loading)).toBeVisible();
    const read = relatedResponse(page, 'questions', question.id);
    hold.release();
    await hold.done();
    const list = await read;

    // Below the result and the explanation (no AI 해설 in this environment).
    const explanation = panel.getByText(question.revision.explanation ?? '?');
    await expect(explanation).toBeVisible();
    const above = await explanation.boundingBox();
    const below = await toggle.boundingBox();
    expect((above?.y ?? 0) < (below?.y ?? 0), 'explanation above 관련 본문').toBe(true);

    const rows = relatedUi.rows(body);
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(RELATED_LIMIT);
    expect(list.items).toHaveLength(n);
    await expect(relatedUi.status(body, countText(n))).toHaveCount(1);
    // Collapsing and expanding again reuses the loaded list: no second request.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rows).toHaveCount(n);
    expect(requests.count(), 'one request for one expand').toBe(1);

    // 1: the question's own source (장 1, p.2) with the badge; 2: "가나다 응용" (장 2, p.4).
    const first = relatedUi.row(body, 0);
    await expect(relatedUi.badge(first)).toBeVisible();
    await expect(first).toContainText(s.book.title);
    await expect(first).toContainText(CH1);
    await expect(first).toContainText(pageText(ANSWER_PAGE));
    await expect(first).toContainText(ANSWER);
    const second = relatedUi.row(body, 1);
    await expect(relatedUi.badge(second)).toHaveCount(0);
    await expect(second).toContainText(CH2);
    await expect(second).toContainText(pageText(APPLIED_PAGE));
    await expect(second).toContainText(APPLIED);
    expect(list.items[0]?.block_id).toBe(s.book.answerBlockId);
    expect(list.items[0]?.from_question_source).toBe(true);
    expect(list.items[1]?.block_id).toBe(s.book.appliedBlockId);
    // One row per page: the second p.2 block is dropped.
    const pages = await rowPages(body);
    expect(new Set(pages).size, `pages ${pages.join(',')}`).toBe(pages.length);
    expect(list.items.map((i) => i.block_id)).not.toContain(s.book.samePageBlockId);
    // Query words are marked bold + underlined.
    const mark = relatedUi.marks(first).first();
    await expect(mark).toHaveText(/가나다|원리/);
    await expectBoldUnderlined(mark);

    // Row → "본문 발췌" panel → "PDF에서 보기" opens DOC-02 at p.2.
    await relatedUi.open(first).click();
    const excerpt = relatedUi.excerptPanel(page);
    await expect(excerpt).toBeVisible();
    await expect(excerpt).toContainText(TEXT.answer.slice(0, 30));
    await relatedUi.openInPdf(excerpt).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === `/workspaces/${s.workspaceId}/documents/${s.book.documentId}`,
    );
    await expect(editorUi.currentPage(page)).toHaveValue(String(ANSWER_PAGE));

    // Back on the home, the submitted result is restored, then the second row's
    // "PDF" link opens DOC-02 at p.4.
    panel = await reopenSubmitted(page, s.workspaceId, question);
    await expect(relatedUi.toggle(panel)).toHaveAttribute('aria-expanded', 'false');
    body = await expandRelated(panel);
    const link = relatedUi.pdf(relatedUi.row(body, 1));
    await expect(link).toHaveAttribute('href', /[?&]page=4(&|$)/);
    await link.click();
    await expect(page).toHaveURL(
      (url) => url.pathname === `/workspaces/${s.workspaceId}/documents/${s.book.documentId}`,
    );
    await expect(editorUi.currentPage(page)).toHaveValue(String(APPLIED_PAGE));
  },
);

test(
  'RELSRC-01-AC02 the related-sources API refuses an unsubmitted or missing session with 409 and another user’s session with 404, storing nothing',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('relsrc01-ac02');
    const s = await seedWorkspace(workspaceFactory, 'relsrc01-ac02');
    const question = await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
      ...relsrcInput(label, s.book),
      question_number: 1,
    });
    const a = await viewer(workspaceFactory, s, 'relsrc01-ac02-a');
    const other = await viewer(workspaceFactory, s, 'relsrc01-ac02-b');
    // The other member's submitted session; the practice API responses carry no related field.
    const opened = await other.api.ok<{ id: string }>(
      'POST',
      `/questions/${question.id}/practice-sessions`,
      {},
      [201],
    );
    const graded = await other.api.ok(
      'POST',
      `/practice-sessions/${opened.id}/submit`,
      { selected_option_ids: question.revision.correct_option_ids ?? [] },
      [200],
    );
    expect(keysIn([opened, graded]).filter((k) => /related/i.test(k))).toEqual([]);
    const otherSession = opened.id;

    // A's open practice panel (a session without a submission, R11).
    await openHome(page, a, s.workspaceId);
    const requests = trackRelatedRequests(page);
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panelUi.submit(panel)).toBeVisible();
    const session = { id: await openSessionId(a.user.id, question.id) };
    await expect(relatedUi.toggle(panel)).toHaveCount(0);

    const secrets = [TEXT.answer, TEXT.applied, s.book.documentId, s.book.answerBlockId];
    const refused = [
      [await requestRelated(a, question.id, { practice_session_id: session.id }), 409],
      [await requestRelated(a, question.id), 409],
      [await requestRelated(a, question.id, { practice_session_id: otherSession }), 404],
    ] as const;
    for (const [res, status] of refused) {
      expectRoute(res, 'GET /questions/{id}/related-sources');
      if (status === 409) expectProblem(res, 409, RELATED_PROBLEMS.beforeSubmit);
      else expectProblem(res, 404);
      for (const secret of secrets) expect(res.text.includes(secret), 'nothing leaks').toBe(false);
    }
    // A missing session and another user's session are the same 404 as an unknown session.
    const unknown = await requestRelated(a, question.id, { practice_session_id: randomUUID() });
    expect(unknown.status).toBe(404);
    expect(searchCalls(question.revision.id), 'no search before a submission').toBe(0);
    expect(relatedRowCount(question.id), 'nothing stored before a submission').toBe(0);

    // A submits in the panel: the area appears and the API answers 200.
    await panelUi.option(panel, ANSWER).check();
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    await expectCollapsedWithoutRequest(panel, requests);
    const ok = await requestRelated(a, question.id, { practice_session_id: session.id });
    expect(ok.status).toBe(200);
    expect(ok.body?.items.length ?? 0).toBeGreaterThan(0);
    // The panel's own area stays collapsed and unrequested until A expands it.
    expect(requests.count()).toBe(0);
  },
);

test(
  'RELSRC-01-AC03 a stored list is reused, concurrent first reads compute once, and a book publish or a question edit computes a new list',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('relsrc01-ac03');
    const s = await seedWorkspace(workspaceFactory, 'relsrc01-ac03');
    const hold = new RelsrcHold();
    try {
      const first = await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
        ...relsrcInput(`${label}-1`, s.book),
        question_number: 1,
      });
      const second = await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
        ...relsrcInput(`${label}-2`, s.book, { markers: [hold.marker] }),
        question_number: 2,
      });
      const a = await viewer(workspaceFactory, s, 'relsrc01-ac03-a');
      const b = await viewer(workspaceFactory, s, 'relsrc01-ac03-b');
      // AC01's state: the owner's submission computed and stored the first question's list.
      const stored = await submitAndRead(s.owner, first);
      expect(stored.stored).toBe(true);
      expect(searchCalls(first.revision.id)).toBe(1);

      // A reads the stored list: the same row, no new search.
      await openHome(page, a, s.workspaceId);
      const requests = trackRelatedRequests(page);
      let read = relatedResponse(page, 'questions', first.id);
      let panel = await answerInPanel(page, 1, ANSWER);
      await expectCollapsedWithoutRequest(panel, requests);
      await expect(relatedUi.rows(await expandRelated(panel)).first()).toBeVisible();
      expect((await read).id).toBe(stored.id);
      expect(searchCalls(first.revision.id)).toBe(1);
      await panelUi.close(panel).click();

      // A (in the page) and B (API) submit the second question at about the same time; the first
      // computation holds (R5) while the other waits on the lock.
      read = relatedResponse(page, 'questions', second.id);
      panel = await answerInPanel(page, 2, ANSWER);
      const heldBody = await expandRelated(panel);
      const bRead = submitAndRead(b, second);
      await hold.held();
      await expect(relatedUi.status(heldBody, UI_TEXT.loading)).toBeVisible();
      hold.release();
      const [aList, bList] = await Promise.all([read, bRead]);
      expect(aList.id).not.toBeNull();
      expect(bList.id).toBe(aList.id);
      expect(bList.items).toEqual(aList.items);
      expect(searchCalls(second.revision.id), 'one computation').toBe(1);
      expect(relatedRowCount(second.id), 'one stored list').toBe(1);
      await expect(relatedUi.rows(await expandRelated(panel)).first()).toBeVisible();

      // The editor removes "가나다 응용" from 장 2 and publishes: a new corpus fingerprint.
      await correctAndPublish(s.owner, s.book.documentId, [
        { blockId: s.book.appliedBlockId, text: TEXT.appliedRemoved },
      ]);
      read = relatedResponse(page, 'questions', first.id);
      panel = await reopenSubmitted(page, s.workspaceId, first);
      await expect(relatedUi.rows(await expandRelated(panel)).first()).toBeVisible();
      const fresh = await read;
      expect(fresh.id).not.toBe(stored.id);
      expect(excerpts(fresh)).not.toContain(APPLIED);
      await expect(relatedUi.list(await expandRelated(panel))).not.toContainText(APPLIED);
      expect(searchCalls(first.revision.id)).toBe(2);
      const rows = relatedRows(first.id);
      expect(rows.map((r) => [r.id, r.superseded])).toEqual([
        [stored.id, true],
        [fresh.id, false],
      ]);

      // The editor edits the question: a new question revision, a new list.
      const edited = await editStem(s.owner, first, relsrcStem(`${label}-1 수정`));
      const afterEdit = await submitAndRead(a, edited);
      expect(afterEdit.id).not.toBe(fresh.id);
      expect(afterEdit.question_revision_id).toBe(edited.revision.id);
      expect(searchCalls(edited.revision.id)).toBe(1);
    } finally {
      hold.release();
      hold.cleanup();
    }
  },
);

test(
  'RELSRC-01-AC04 question papers and mixed question segments never appear, an empty list says so, an outage offers 다시 시도, and degraded search is shown but not stored',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('relsrc01-ac04');
    const s = await seedWorkspace(workspaceFactory, 'relsrc01-ac04');
    const paper = questionPaper();
    const q1 = paper.questions.find((q) => q.number === 1)?.stem ?? '?';
    const q2 = paper.questions.find((q) => q.number === 2)?.stem ?? '?';

    // A question paper whose question 2 prints "라마바 정답표" (only there) …
    const uploaded = await uploadPdf(s.owner, s.workspaceId, paper, 'question_paper');
    await waitForJob(s.owner, uploaded.jobId);
    await waitForLatestImport(s.owner, s.workspaceId);
    const paperDoc = uploaded.documentId;
    const paperBlock = await blockIdOf(s.owner, paperDoc, (t) => t.includes(q2));
    const paperText = (await listBlocks(s.owner, paperDoc)).items.find(
      (b) => b.block_id === paperBlock,
    )?.text;
    await correctAndPublish(s.owner, paperDoc, [
      { blockId: paperBlock, text: (paperText ?? q2).replace(q2, `${TEXT.paperOnly}: ${q2}`) },
    ]);
    // … and a `mixed` book whose question segment (question 1) prints "사아자 해설".
    const mixedUpload = await uploadPdf(s.owner, s.workspaceId, paper, 'book');
    await waitForJob(s.owner, mixedUpload.jobId);
    const mixedDoc = mixedUpload.documentId;
    await setDocumentKind(s.owner, mixedDoc, 'mixed', false);
    const mixedBlock = await blockIdOf(s.owner, mixedDoc, (t) => t.includes(q1));
    const mixedText = (await listBlocks(s.owner, mixedDoc)).items.find(
      (b) => b.block_id === mixedBlock,
    )?.text;
    await correctAndPublish(s.owner, mixedDoc, [
      {
        blockId: mixedBlock,
        text: (mixedText ?? q1).replace(q1, `${TEXT.mixedQuestionOnly}: ${q1}`),
      },
    ]);
    const kinds = new Map((await listDocuments(s.owner, s.workspaceId)).map((d) => [d.id, d]));
    expect(kinds.get(mixedDoc)?.kind).toBe('mixed');

    const ask = (n: number, answer: string, markers: string[] = []) =>
      createSourcedQuestion(s.owner, s.workspaceId, s.book, {
        ...relsrcInput(`${label}-${n}`, s.book, { answer, markers }),
        question_number: n,
      });
    const paperQ = await ask(1, TEXT.paperOnly);
    const mixedQ = await ask(2, TEXT.mixedQuestionOnly);
    const nowhere = await createQuestion(s.owner, s.workspaceId, {
      ...mcqInput(`RELSRC ${label}-3: ${TEXT.nowhere}?`, [
        'zqxjv-보기-1',
        'zqxjv-보기-2',
        'zqxjv-보기-3',
      ]),
      // In 1장 like the others: in the 챕터 없음 group its dot's focus tooltip covers dot 4 above.
      chapter_id: s.book.ch1,
      question_number: 3,
    });
    const failing = await ask(4, ANSWER, [FAIL_MARKER]);
    const degraded = await ask(5, ANSWER, [DENSE_MARKER]);

    await openHome(page, s.owner, s.workspaceId);
    const requests = trackRelatedRequests(page);
    // Question paper and mixed question segment: never a candidate.
    for (const [n, q, only] of [
      [1, paperQ, TEXT.paperOnly],
      [2, mixedQ, TEXT.mixedQuestionOnly],
    ] as const) {
      const read = relatedResponse(page, 'questions', q.id);
      const before = requests.count();
      const panel = await answerInPanel(page, n, only);
      await expectCollapsedWithoutRequest(panel, requests, before);
      const body = await expandRelated(panel);
      const list = await read;
      await expect(
        relatedUi.rows(body).first().or(relatedUi.status(body, UI_TEXT.empty)),
      ).toBeVisible();
      await expect(body).not.toContainText(only);
      expect(list.items.map((i) => i.document_id)).not.toContain(paperDoc);
      expect(list.items.map((i) => i.block_id)).not.toContain(mixedBlock);
      expect(excerpts(list)).not.toContain(only);
      await panelUi.close(panel).click();
    }

    // Nothing related anywhere: the empty state, and no question paper in the response.
    let read = relatedResponse(page, 'questions', nowhere.id);
    let before = requests.count();
    let panel = await answerInPanel(page, 3, 'zqxjv-보기-1');
    await expectCollapsedWithoutRequest(panel, requests, before);
    await expect(relatedUi.status(await expandRelated(panel), UI_TEXT.empty)).toBeVisible();
    expect((await read).items).toEqual([]);
    await panelUi.close(panel).click();

    // Outage (R6): alert + 다시 시도; the retry shows the list.
    before = requests.count();
    panel = await answerInPanel(page, 4, ANSWER);
    await expectCollapsedWithoutRequest(panel, requests, before);
    let body = await expandRelated(panel);
    await expect(relatedUi.alert(body)).toBeVisible();
    expect(relatedRowCount(failing.id)).toBe(0);
    read = relatedResponse(page, 'questions', failing.id);
    await relatedUi.retry(body).click();
    await read;
    await expect(relatedUi.rows(body).first()).toBeVisible();
    await expect(relatedUi.alert(body)).toHaveCount(0);
    await panelUi.close(panel).click();

    // Dense unavailable (R7): keyword rows + the non-blocking notice, nothing stored …
    read = relatedResponse(page, 'questions', degraded.id);
    panel = await answerInPanel(page, 5, ANSWER);
    await expect(relatedUi.toggle(panel)).toHaveAttribute('aria-expanded', 'false');
    body = await expandRelated(panel);
    const weak = await read;
    expect(weak.degraded).toEqual(['dense_unavailable']);
    expect(weak.stored).toBe(false);
    await expect(relatedUi.degraded(body)).toBeVisible();
    await expect(relatedUi.rows(body).first()).toBeVisible();
    expect(relatedRowCount(degraded.id)).toBe(0);
    await panelUi.close(panel).click();
    await expectClosedToHome(page, panel);
    // … and in the normal state the same question is computed and stored.
    const healthy = await editStem(s.owner, degraded, relsrcStem(`${label}-5`));
    read = relatedResponse(page, 'questions', degraded.id);
    await page.goto(overviewPath(s.workspaceId, healthy.id));
    panel = panelUi.panel(page);
    await expect(panel).toBeVisible();
    await panelUi.option(panel, ANSWER).check();
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    await expect(relatedUi.rows(await expandRelated(panel)).first()).toBeVisible();
    const normal = await read;
    expect(normal.degraded).toEqual([]);
    expect(normal.stored).toBe(true);
    await expect(relatedUi.degraded(await expandRelated(panel))).toHaveCount(0);
    expect(relatedRowCount(degraded.id)).toBe(1);
  },
);

test(
  'RELSRC-01-AC05 question details show 관련 본문 without a submission and by keyboard, archived workspaces compute without storing, and guests see stored lists only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('relsrc01-ac05');
    const s = await seedWorkspace(workspaceFactory, 'relsrc01-ac05');
    const stored = await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
      ...relsrcInput(`${label}-1`, s.book),
      question_number: 1,
    });
    const unstored = await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
      ...relsrcInput(`${label}-2`, s.book),
      question_number: 2,
    });
    const archivedQ = await archiveQuestion(
      s.owner,
      await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
        ...relsrcInput(`${label}-3`, s.book),
        question_number: 3,
      }),
    );
    const draft = await createQuestion(s.owner, s.workspaceId, {
      ...relsrcInput(`${label}-4`, s.book),
      question_number: 4,
      publication_status: 'DRAFT',
    });
    await submitAndRead(s.owner, stored);
    const member = await viewer(workspaceFactory, s, 'relsrc01-ac05-viewer');
    const link = await createShareLink(s.owner, s.workspaceId);

    // A viewer who has not answered: 문제 정보 › 정답·해설 보기 shows the list (view: detail).
    await openHome(page, member, s.workspaceId);
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await expect(panelUi.submit(panel)).toBeVisible();
    const footprint = practiceFootprint(member.user.id, stored.id);
    const requests = trackRelatedRequests(page);
    await choosePanelMenu(page, panel, 'answers');
    const dialog = detailUi.dialog(page);
    await expect(dialog).toBeVisible();
    // Collapsed with no request; the keyboard expands it (view: detail), a second toggle pair
    // reuses the loaded list.
    const toggle = relatedUi.toggle(dialog);
    await expectCollapsedWithoutRequest(dialog, requests);
    const detailRequest = page.waitForRequest((r) =>
      /\/related-sources\?(.*&)?view=detail(&|$)/.test(r.url()),
    );
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await detailRequest;
    const body = await expandRelated(dialog);
    const firstRow = relatedUi.row(body, 0);
    await expect(firstRow).toBeVisible();
    await expectAccessible(page, 'question details with 관련 본문');
    // Keyboard: Space collapses, Enter expands again without a new request, Enter on a row opens
    // the excerpt, Escape returns.
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(firstRow).toBeVisible();
    expect(requests.count(), 'collapse and expand reuse the loaded list').toBe(1);
    const rowButton = relatedUi.open(firstRow);
    await rowButton.focus();
    await page.keyboard.press('Enter');
    const excerpt = relatedUi.excerptPanel(page);
    await expect(excerpt).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(excerpt).toBeHidden();
    await expect(rowButton).toBeFocused();
    expect(practiceFootprint(member.user.id, stored.id), 'no attempt, same session').toBe(
      footprint,
    );

    // Archived question: its own list in the detail; DRAFT: no area and a 409 (ASK-SYNC (b)).
    await switchUser(page, s.owner, s.workspaceId);
    await page.goto(homePath(s.workspaceId, 'panel=inactive-questions'));
    const inactive = inactiveUi.dialog(page);
    await expect(inactive).toBeVisible();
    await inactiveUi.open(inactiveUi.row(inactive, `${label}-3:`)).click();
    const archivedDetail = detailUi.dialog(page);
    await expect(archivedDetail).toBeVisible();
    await expect(relatedUi.toggle(archivedDetail)).toHaveAttribute('aria-expanded', 'false');
    await expect(relatedUi.rows(await expandRelated(archivedDetail)).first()).toBeVisible();
    expect((await requestRelated(s.owner, archivedQ.id, { view: 'detail' })).status).toBe(200);
    await page.keyboard.press('Escape');
    await expect(archivedDetail).toBeHidden();
    await inactiveUi.open(inactiveUi.row(inactive, `${label}-4:`)).click();
    const draftDetail = detailUi.dialog(page);
    await expect(draftDetail).toBeVisible();
    await expect(draftDetail.getByText(`${label}-4:`).first()).toBeVisible();
    await expect(relatedUi.toggle(draftDetail)).toHaveCount(0);
    const draftRes = await requestRelated(s.owner, draft.id, { view: 'detail' });
    expectRoute(draftRes, 'GET /questions/{id}/related-sources');
    expectProblem(draftRes, 409, RELATED_PROBLEMS.draft);
    expect(searchCalls(draft.revision.id)).toBe(0);

    // Archived workspace: the owner's earlier submission and the details compute, store nothing.
    const archivedWs = await workspaceFactory.create(s.owner);
    const archivedBook = await seedRelsrcBook(s.owner, archivedWs.id);
    const inArchive = await createSourcedQuestion(s.owner, archivedWs.id, archivedBook, {
      ...relsrcInput(`${label}-arch`, archivedBook),
      question_number: 1,
    });
    const earlier = await submitOnce(
      s.owner,
      inArchive.id,
      inArchive.revision.correct_option_ids ?? [],
    );
    await workspaceFactory.archive(s.owner, archivedWs.id);
    await page.goto(overviewPath(archivedWs.id));
    await overviewUi.dot(page, 1).click();
    const archivedPanel = panelUi.numbered(page, 1);
    await expect(archivedPanel).toBeVisible();
    await choosePanelMenu(page, archivedPanel, 'answers');
    const archivedWsDetail = detailUi.dialog(page);
    await expect(relatedUi.rows(await expandRelated(archivedWsDetail)).first()).toBeVisible();
    const computed = await getRelated(s.owner, inArchive.id, { practice_session_id: earlier });
    expect(computed.stored).toBe(false);
    expect(computed.id).toBeNull();
    expect(computed.items.length).toBeGreaterThan(0);
    expect(relatedRowCount(inArchive.id), 'archived: nothing stored').toBe(0);

    // Guest: the stored question shows a read-only list; the other has no area and a 404.
    await page.context().clearCookies();
    await openShareWithSecret(page, link.id, link.secret);
    await sharedUi.question(page, stored.revision.stem).click();
    let shared = sharedUi.questionPanel(page);
    await expect(shared).toBeVisible();
    // Read-only follows the same rule: collapsed, nothing requested, the expand reads the list.
    const guestRequests = trackRelatedRequests(page);
    await expectCollapsedWithoutRequest(shared, guestRequests);
    const sharedBody = await expandRelated(shared);
    await expect(relatedUi.rows(sharedBody).first()).toBeVisible();
    await expect(relatedUi.retry(sharedBody)).toHaveCount(0);
    const guestBefore = guestRequests.count();
    await page.keyboard.press('Escape');
    // No stored list: the area is collapsed too, and the expand says there is nothing.
    await sharedUi.question(page, unstored.revision.stem).click();
    shared = sharedUi.questionPanel(page);
    await expect(shared).toBeVisible();
    await expect(shared).toContainText(`${label}-2:`);
    await expectCollapsedWithoutRequest(shared, guestRequests, guestBefore);
    const emptyBody = await expandRelated(shared);
    await expect(relatedUi.status(emptyBody, UI_TEXT.empty)).toBeVisible();
    await expect(relatedUi.rows(emptyBody)).toHaveCount(0);
    const guest = await ShareSession.open(link.id, link.secret);
    const ok = await guest.call<{ items: unknown[] }>('GET', sharedRelatedPath(link.id, stored.id));
    expect(ok.status).toBe(200);
    const leaked = keysIn(ok.body).filter((k) =>
      /^(score|stale|revision_id|question_revision_id|corpus_fingerprint|retrieval_version)$/.test(
        k,
      ),
    );
    expect(leaked, 'no score, key or version for guests').toEqual([]);
    const missing = await guest.call('GET', sharedRelatedPath(link.id, unstored.id));
    expect(missing.status).toBe(404);
    expect(searchCalls(unstored.revision.id), 'guests never compute').toBe(0);
    expect(relatedRowCount(unstored.id)).toBe(0);
  },
);

test(
  'RELSRC-01-AC06 range practice and mock exam questions show 관련 본문 after submitting, without the imported question-PDF source, in their own stored lists',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('relsrc01-ac06');
    const s = await seedWorkspace(workspaceFactory, 'relsrc01-ac06');
    // The question PDF import gives a real import run and the paper's blocks (R9).
    const uploaded = await uploadPdf(s.owner, s.workspaceId, questionPaper(), 'question_paper');
    await waitForJob(s.owner, uploaded.jobId);
    const run = await waitForLatestImport(s.owner, s.workspaceId);
    const paperDoc = uploaded.documentId;
    const paperBlocks = (await listBlocks(s.owner, paperDoc)).items.filter((b) => b.page === 1);
    const paperTitle =
      (await listDocuments(s.owner, s.workspaceId)).find((d) => d.id === paperDoc)?.title ?? '?';
    const question = await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
      ...relsrcInput(label, s.book),
      question_number: 1,
    });
    addImportedSource(
      question.id,
      paperDoc,
      run.id,
      1,
      paperBlocks.slice(0, 1).map((b) => b.block_id),
    );
    const examName = `모의 ${label}`;
    const exam = await createShuffleMockExam(s.owner, s.workspaceId, examName, [question.id], 1);
    const mockQuestions = await s.owner.api.ok<{
      items: { id: string; revision: { id: string } }[];
    }>('GET', `/mock-exams/${exam.id}/questions?include=answers`, undefined, [200]);
    const mq = mockQuestions.items[0];
    if (!mq) throw new Error('mock exam has no question');
    const a = await viewer(workspaceFactory, s, 'relsrc01-ac06-a');
    const b = await viewer(workspaceFactory, s, 'relsrc01-ac06-b');

    // A: `문제` › `문제 풀기` (sequence(bank)) → submit → 관련 본문 under the result.
    await openHome(page, a, s.workspaceId);
    let runPanel = await openRangePicker(page);
    await runUi.selectAll(runPanel).check();
    await runUi.start(runPanel).click();
    await expect(page).toHaveURL(/[?&]practice=[0-9a-f-]{36}(&|$)/);
    runPanel = runUi.panel(page);
    const requests = trackRelatedRequests(page);
    let read = relatedResponse(page, 'questions', question.id);
    await runUi.option(runPanel, ANSWER).check();
    await runUi.submit(runPanel).click();
    await expect(runUi.result(runPanel)).toContainText(RESULT_TEXT.correct);
    await expectCollapsedWithoutRequest(runPanel, requests);
    let body = await expandRelated(runPanel);
    const inRun = await read;
    await expect(relatedUi.toggle(runPanel)).toHaveAttribute('aria-expanded', 'true');
    await expect(relatedUi.badge(relatedUi.row(body, 0))).toBeVisible();
    await page.keyboard.press('Escape');
    await expectClosedToHome(page, runPanel);
    // The practice panel reads the same stored list.
    read = relatedResponse(page, 'questions', question.id);
    const panel = await reopenSubmitted(page, s.workspaceId, question);
    await expect(relatedUi.rows(await expandRelated(panel)).first()).toBeVisible();
    expect((await read).id).toBe(inRun.id);
    await page.keyboard.press('Escape');
    await expectClosedToHome(page, panel);

    // A: the mock exam's 풀기; before submitting the mock API refuses with 409.
    await page.goto(homePath(s.workspaceId, 'panel=mock-exams'));
    const list = mockUi.dialog(page);
    await expect(list).toBeVisible();
    await mockUi.practise(list.getByRole('listitem').filter({ hasText: examName })).click();
    const mockPanel = mockUi.practicePanel(page);
    await expect(mockUi.practiceTitle(mockPanel, examName)).toBeVisible();
    const opened = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.endsWith(`/mock-exam-questions/${mq.id}/practice-sessions`),
    );
    await runUi.start(mockPanel).click();
    const mockSession = (await (await opened).json()) as { id: string };
    await expect(runUi.mockTitle(mockPanel, 1)).toBeVisible();
    await expect(relatedUi.toggle(mockPanel)).toHaveCount(0);
    const early = await requestMockRelated(a, mq.id, { mock_practice_session_id: mockSession.id });
    expectRoute(early, 'GET /mock-exam-questions/{id}/related-sources');
    expectProblem(early, 409, RELATED_PROBLEMS.beforeSubmit);
    expect(mockRelatedRowCount(mq.id)).toBe(0);
    expect(searchCalls(mq.revision.id)).toBe(0);

    // After submitting: the 장 1 source first (문제 출처), no question-PDF page in any row.
    read = relatedResponse(page, 'mock-exam-questions', mq.id);
    const beforeMock = requests.count();
    await runUi.option(mockPanel, ANSWER).check();
    await runUi.submit(mockPanel).click();
    await expect(runUi.result(mockPanel)).toContainText(RESULT_TEXT.correct);
    await expectCollapsedWithoutRequest(mockPanel, requests, beforeMock);
    body = await expandRelated(mockPanel);
    const mockList = await read;
    const first = relatedUi.row(body, 0);
    await expect(relatedUi.badge(first)).toBeVisible();
    await expect(first).toContainText(CH1);
    await expect(relatedUi.list(body)).not.toContainText(paperTitle);
    expect(mockList.items[0]?.block_id).toBe(s.book.answerBlockId);
    expect(mockList.items.map((i) => i.document_id)).not.toContain(paperDoc);
    expect(mockList.id).not.toBeNull();
    expect(mockList.id).not.toBe(inRun.id);
    expect(mockList.mock_exam_question_revision_id).toBe(mq.revision.id);
    expect(searchCalls(mq.revision.id)).toBe(1);

    // B submits the same mock question: the stored list, no search; reading changes no attempts.
    const bSession = await b.api.ok<{ id: string }>(
      'POST',
      `/mock-exam-questions/${mq.id}/practice-sessions`,
      {},
      [201],
    );
    await b.api.ok(
      'POST',
      `/mock-practice-sessions/${bSession.id}/submit`,
      { selected_option_ids: question.revision.correct_option_ids ?? [] },
      [200],
    );
    const mockAttempts = mockAttemptCount(exam.id);
    const bankAttempts = questionAttemptCount(s.workspaceId);
    const overview = await getOverview(b, s.workspaceId);
    const bList = await getMockRelated(b, mq.id, { mock_practice_session_id: bSession.id });
    expect(bList.id).toBe(mockList.id);
    expect(searchCalls(mq.revision.id)).toBe(1);
    expect(mockAttemptCount(exam.id)).toBe(mockAttempts);
    expect(questionAttemptCount(s.workspaceId)).toBe(bankAttempts);
    expect((await getOverview(b, s.workspaceId)).items).toEqual(overview.items);
    expect(mockRelatedRowCount(mq.id)).toBe(1);

    // Editors: the mock question's manage view shows the list without a submission
    // (view: manage, ASK-SYNC (a)).
    await switchUser(page, s.owner, s.workspaceId);
    await page.goto(mockExamsPath(s.workspaceId, exam.id));
    const manageRequests = trackRelatedRequests(page);
    const detail = mockUi.dialog(page);
    await expect(mockUi.heading(detail, examName)).toBeVisible();
    await questionRow(detail, 1).click();
    const manage = mockUi.viewer(page, 1);
    await expect(manage).toBeVisible();
    await expectCollapsedWithoutRequest(manage, manageRequests);
    const manageRequest = page.waitForRequest((r) =>
      /\/related-sources\?(.*&)?view=manage(&|$)/.test(r.url()),
    );
    await expect(relatedUi.rows(await expandRelated(manage)).first()).toBeVisible();
    await manageRequest;
  },
);
