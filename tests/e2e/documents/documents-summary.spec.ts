// DOCSUM-01 — 문서 요약 Floating Side Panel (`/workspaces/:id?panel=document-summary&document=`),
// docs/screens/documents-summary.md; data model and jobs docs/architecture.md §5–§6, shared reads
// docs/workspace-sharing.md §8.
//
// Each test uploads synthetic books (tests/fixtures/pdfs) into its own workspace through the public
// upload flow. Summaries come from the APP_ENV=test deterministic fake summarizer (leading
// sentences of the blocks), so assertions use what the fake can satisfy: panel states, the AI
// badge, page links, chapter disclosures, a corrected token reaching chapter B's summary, run
// counts and `reused_units`, never exact prose. Every assumption about DOCSUM-B / DOCSUM-W (API
// shapes D1–D6, the fake's failure and latency markers D7, the feature-off stack D8, UI labels)
// is in the tests/e2e/fixtures/summary.ts header.
//
// Chapter A = "1장 물의 순환" (pages 2–3), chapter B = "2장 정수 처리" (page 4) of book-ko.
// Corrections and publishes go through the public API (fixtures/history.ts); viewer memberships
// through the documented db seed (fixtures/db.ts). A document whose parse is still running cannot
// be held on demand with the fake adapters, so DOCSUM-01-AC07 puts a parsed book back into
// `processing` with the db fixture (use 6) for both the 409 and the row.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  block,
  book,
  correctBlock,
  docUi,
  documentsPath,
  editorUi,
  homeUi,
  historyUi,
  JOB_TIMEOUT_MS,
  listActivities,
  listDocuments,
  PROBLEM_TYPES,
  publishDocument,
  questionPaper,
  seedMembership,
  signInAs,
  snippet,
  uploadPdf,
  waitForJob,
  waitForJobStatus,
  type Member,
  type PdfFile,
  type Problem,
} from '../fixtures/test.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  revokeShareLink,
  sharedUi,
  sharePath,
  ShareSession,
  stableProblem,
  test,
} from '../fixtures/sharing.ts';
import { holdDocumentProcessing } from '../fixtures/db.ts';
import {
  disableAutoSummary,
  getSummary,
  PAGE_LINK,
  requestSummary,
  retrySummary,
  slowSummaryBook,
  startSummary,
  startSummaryOffStack,
  SUMMARY_FAILURE_MARKER,
  SUMMARY_JOB_TYPE,
  SUMMARY_PROBLEMS,
  SUMMARY_TIMEOUT_MS,
  summaryJobs,
  summaryPanelPath,
  summaryUi,
  waitForPublishedRevision,
  waitForSummaryRun,
  type SummaryState,
} from '../fixtures/summary.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

// AC06 handles a share secret: no trace/screenshot/video for this file (fixtures/sharing.ts).
test.use({ storageState: { cookies: [], origins: [] }, ...NO_VISUAL_ARTIFACTS });
test.describe.configure({ timeout: 4 * JOB_TIMEOUT_MS + 2 * SUMMARY_TIMEOUT_MS });

const BOOK = book('book-ko');
const CHAPTER_A = '1장 물의 순환';
const CHAPTER_B = '2장 정수 처리';
const A_PARAGRAPH = block(BOOK, 'ch1-p1'); // page 2
const B_PARAGRAPH = block(BOOK, 'ch2-p1'); // page 4, first body block of chapter B
const RANDOM_ID = '00000000-0000-4000-8000-000000000000';

interface ReadyDoc {
  readonly documentId: string;
  readonly title: string;
}

/** Uploads `fixture` through the public flow, waits for READY and returns its listed title. */
async function readyDoc(
  owner: Member,
  workspaceId: string,
  fixture: PdfFile,
  type?: 'question_paper',
): Promise<ReadyDoc> {
  const { documentId, jobId } = await uploadPdf(owner, workspaceId, fixture, type);
  await waitForJob(owner, jobId);
  const listed = (await listDocuments(owner, workspaceId)).find((d) => d.id === documentId);
  expect(listed?.title, 'uploaded document is listed with a title').toBeTruthy();
  return { documentId, title: listed?.title ?? '' };
}

/** A ready book with a succeeded summary of its first published revision. */
async function summarizedDoc(
  owner: Member,
  workspaceId: string,
  fixture: PdfFile = BOOK,
): Promise<ReadyDoc & { readonly state: SummaryState }> {
  const doc = await readyDoc(owner, workspaceId, fixture);
  await startSummary(owner, doc.documentId);
  const state = await waitForSummaryRun(owner, doc.documentId, 'succeeded');
  return { ...doc, state };
}

function escapeRegExp(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function uniqueToken(label: string): string {
  return `${label}${randomUUID().slice(0, 8)}`;
}

/** Corrects chapter B's first paragraph (page 4) so its leading sentence carries `lead`. */
async function correctChapterB(owner: Member, documentId: string, current: string, lead: string) {
  return correctBlock(owner, documentId, 4, current, `${lead} ${B_PARAGRAPH.text}`);
}

/** Publishes the correction draft and waits for the reindex job; returns the new revision id. */
async function publishAndWait(owner: Member, documentId: string): Promise<string> {
  const before = (await getSummary(owner, documentId)).published_revision_id ?? '';
  const jobId = await publishDocument(owner, documentId);
  await waitForJobStatus(owner, jobId, 'succeeded');
  return waitForPublishedRevision(owner, documentId, before);
}

async function openPanel(page: Page, workspaceId: string, documentId: string): Promise<Locator> {
  await page.goto(summaryPanelPath(workspaceId, documentId));
  const panel = summaryUi.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function switchUser(page: Page, user: Member): Promise<void> {
  await page.context().clearCookies();
  await signInAs(page, user.user);
}

/** First page number in a key point link's accessible name. */
async function linkedPage(link: Locator): Promise<number> {
  const name = (await link.getAttribute('aria-label')) ?? (await link.innerText());
  const match = PAGE_LINK.exec(name);
  const page = Number(match?.[1] ?? match?.[3]);
  expect(page, `page link "${name}" names a page`).toBeGreaterThan(0);
  return page;
}

async function memberPair(workspaceFactory: WorkspaceFactory, label: string) {
  const owner = await workspaceFactory.member(`${label}-owner`);
  const viewer = await workspaceFactory.member(`${label}-viewer`);
  const ws = await workspaceFactory.create(owner);
  seedMembership(ws.id, viewer.user.id, 'viewer');
  return { owner, viewer, ws };
}

test(
  'DOCSUM-01-AC01 an editor opts in, the panel walks queued → running → summary, one run for a double click',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('docsum01-ac01');
    const ws = await workspaceFactory.create(owner);
    const doc = await readyDoc(owner, ws.id, slowSummaryBook());
    await signInAs(page, owner.user);
    await page.goto(documentsPath(ws.id));
    const library = homeUi.documentsDialog(page);
    await expect(docUi.ready(docUi.item(page, escapeRegExp(doc.title)))).toBeVisible();

    const opener = summaryUi.rowButton(library, doc.title);
    await opener.click();
    const panel = summaryUi.panel(page);
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.getAll('panel').includes('document-summary') &&
        url.searchParams.get('document') === doc.documentId,
    );
    await expect(panel).not.toHaveAttribute('aria-modal', 'true');
    await expect(summaryUi.empty(panel)).toBeVisible();
    await expect(summaryUi.sendNotice(panel)).toBeVisible();

    // Two quick presses: one run (Idempotency-Key), states as text.
    await summaryUi.createButton(panel).dblclick();
    await expect(summaryUi.queued(panel)).toBeVisible();
    await expect(summaryUi.running(panel)).toBeVisible({ timeout: SUMMARY_TIMEOUT_MS });
    await expect(summaryUi.progress(panel)).toBeVisible();

    await expect(summaryUi.overallHeading(panel)).toBeVisible({ timeout: SUMMARY_TIMEOUT_MS });
    await expect(summaryUi.aiBadge(panel)).toBeVisible();
    await expect(summaryUi.meta(panel)).toContainText(/발행본 기준/);
    await expect(summaryUi.meta(panel)).toContainText(/장\s*2개/);
    await expect(summaryUi.keyPoints(panel).first()).toBeVisible();
    await expect(summaryUi.pageLinks(summaryUi.keyPoints(panel).first()).first()).toBeVisible();
    await expect(summaryUi.chaptersHeading(panel)).toBeVisible();
    const chapterA = summaryUi.chapter(panel, CHAPTER_A);
    const chapterB = summaryUi.chapter(panel, CHAPTER_B);
    await expect(chapterA).toHaveAccessibleName(/2\s*[–-]\s*3/);
    await expect(chapterB).toHaveAccessibleName(/(?<!\d)4(?!\d)/);
    await expect(chapterA).toHaveAttribute('aria-expanded', 'false');
    await expect(chapterB).toHaveAttribute('aria-expanded', 'false');
    await expect(summaryUi.queued(panel)).toHaveCount(0);
    await expect(summaryUi.progress(panel)).toHaveCount(0);

    const state = await getSummary(owner, doc.documentId);
    expect(state.enabled).toBe(true);
    expect(state.run).toMatchObject({ status: 'succeeded', trigger: 'manual' });
    expect(state.summary?.chapters.map((c) => c.title)).toEqual([CHAPTER_A, CHAPTER_B]);
    expect(await summaryJobs(owner, ws.id, doc.documentId)).toHaveLength(1);

    // Escape (focus inside) closes the panel and returns focus to the row's 요약 button.
    await summaryUi.close(panel).focus();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(opener).toBeFocused();

    // A key point's page link opens DOC-02 at that page.
    await opener.click();
    await expect(summaryUi.overallHeading(panel)).toBeVisible();
    const link = summaryUi.pageLinks(summaryUi.keyPoints(panel).first()).first();
    const target = await linkedPage(link);
    await link.click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${ws.id}/documents/${doc.documentId}` &&
        url.searchParams.get('page') === String(target),
    );
    await expect(editorUi.currentPage(page)).toHaveValue(String(target));
  },
);

test(
  'DOCSUM-01-AC02 publishing a correction re-summarizes automatically, reusing the unchanged chapter',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('docsum01-ac02');
    const ws = await workspaceFactory.create(owner);
    const doc = await summarizedDoc(owner, ws.id, slowSummaryBook());
    const other = await readyDoc(owner, ws.id, book('book-en'));
    const first = doc.state.summary;
    expect(first?.revision_id).toBeTruthy();
    await signInAs(page, owner.user);

    const token = uniqueToken('교정표지');
    await correctChapterB(owner, doc.documentId, snippet(B_PARAGRAPH.text), `${token} 문장이다.`);
    const revision = await publishAndWait(owner, doc.documentId);

    // Nobody pressed anything: the publish started the new revision's run, the old summary stays.
    const panel = await openPanel(page, ws.id, doc.documentId);
    const stale = summaryUi.stale(panel);
    await expect(stale).toBeVisible();
    await expect(stale).toContainText(summaryUi.staleRunning);
    await expect(summaryUi.overallHeading(panel)).toBeVisible();
    const during = await getSummary(owner, doc.documentId);
    expect(during.run).toMatchObject({ revision_id: revision, trigger: 'publish' });
    expect(['queued', 'running']).toContain(during.run?.status);
    expect(during.summary?.revision_id).toBe(first?.revision_id);
    expect(during.stale).toBe(true);

    await expect(stale).toHaveCount(0, { timeout: SUMMARY_TIMEOUT_MS });
    const done = await waitForSummaryRun(owner, doc.documentId, 'succeeded', revision);
    expect(done.summary?.revision_id).toBe(revision);
    expect(done.summary?.published_at).not.toBe(first?.published_at);
    expect(done.stale).toBe(false);
    // Chapter A was reused; only chapter B and the document summary were generated.
    expect(done.summary?.usage?.reused_units).toBeGreaterThanOrEqual(1);
    expect(done.summary?.usage?.generated_units).toBe(2);

    const chapterB = summaryUi.chapter(panel, CHAPTER_B);
    await chapterB.click();
    await expect(chapterB).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByText(token).first()).toBeVisible();

    // A document that was never summarized: publishing creates no run.
    await correctBlock(
      owner,
      other.documentId,
      4,
      snippet(block(book('book-en'), 'ch2-p1').text),
      `${uniqueToken('Corrected')} sentence first. ${block(book('book-en'), 'ch2-p1').text}`,
    );
    await publishAndWait(owner, other.documentId);
    const untouched = await getSummary(owner, other.documentId);
    expect(untouched).toMatchObject({ enabled: false, run: null, summary: null });
    expect(await summaryJobs(owner, ws.id, other.documentId)).toEqual([]);
  },
);

test(
  'DOCSUM-01-AC03 a failed re-summary keeps the previous summary with a reason; retry and a fixed publish recover',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, viewer, ws } = await memberPair(workspaceFactory, 'docsum01-ac03');
    const doc = await summarizedDoc(owner, ws.id);
    const token = uniqueToken('실패표지');
    await correctChapterB(
      owner,
      doc.documentId,
      snippet(B_PARAGRAPH.text),
      `${SUMMARY_FAILURE_MARKER} ${token} 문장이다.`,
    );
    const revision = await publishAndWait(owner, doc.documentId);
    const failed = await waitForSummaryRun(owner, doc.documentId, 'failed', revision);
    expect(failed.run?.error_code).toBe('llm_invalid_output');
    expect(failed.summary?.revision_id).toBe(doc.state.summary?.revision_id);
    const raw = await owner.api.request('GET', `/documents/${doc.documentId}/summary`);
    expect(raw.text).not.toContain(token);

    await signInAs(page, owner.user);
    let panel = await openPanel(page, ws.id, doc.documentId);
    await expect(summaryUi.stale(panel)).toContainText(summaryUi.staleFailed);
    await expect(summaryUi.failure(panel)).toContainText(summaryUi.invalidOutputReason);
    await expect(summaryUi.retry(panel)).toBeVisible();
    await expect(summaryUi.overallHeading(panel)).toBeVisible();
    await expect(panel).not.toContainText(token);

    await switchUser(page, viewer);
    panel = await openPanel(page, ws.id, doc.documentId);
    await expect(summaryUi.stale(panel)).toContainText(summaryUi.staleFailed);
    await expect(summaryUi.failure(panel)).toBeVisible();
    await expect(summaryUi.retry(panel)).toHaveCount(0);

    // The marker is removed in a draft only; 다시 시도 re-runs the same (still marked) revision.
    await switchUser(page, owner);
    await correctBlock(owner, doc.documentId, 4, SUMMARY_FAILURE_MARKER, B_PARAGRAPH.text);
    panel = await openPanel(page, ws.id, doc.documentId);
    await summaryUi.retry(panel).click();
    await expect
      .poll(
        async () => {
          const run = (await getSummary(owner, doc.documentId)).run;
          return run && run.id !== failed.run?.id ? `${run.trigger}:${run.status}` : 'old run';
        },
        { timeout: SUMMARY_TIMEOUT_MS },
      )
      .toBe('retry:failed');
    const retried = await getSummary(owner, doc.documentId);
    expect(retried.run?.revision_id).toBe(revision);
    await expect(summaryUi.failure(panel)).toBeVisible({ timeout: SUMMARY_TIMEOUT_MS });
    await expect(summaryUi.stale(panel)).toContainText(summaryUi.staleFailed);

    // Publishing the fixed draft re-summarizes automatically and clears the notice.
    const fixed = await publishAndWait(owner, doc.documentId);
    const recovered = await waitForSummaryRun(owner, doc.documentId, 'succeeded', fixed);
    expect(recovered.stale).toBe(false);
    await expect(summaryUi.stale(panel)).toHaveCount(0, { timeout: SUMMARY_TIMEOUT_MS });
    await expect(summaryUi.failure(panel)).toHaveCount(0);
  },
);

test(
  'DOCSUM-01-AC04 viewers and archived workspaces read summaries but cannot create or retry them',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, viewer, ws } = await memberPair(workspaceFactory, 'docsum01-ac04');
    const withSummary = await summarizedDoc(owner, ws.id);
    const without = await readyDoc(owner, ws.id, book('book-en'));

    await signInAs(page, viewer.user);
    let panel = await openPanel(page, ws.id, withSummary.documentId);
    await expect(summaryUi.overallHeading(panel)).toBeVisible();
    await expect(summaryUi.createButton(panel)).toHaveCount(0);
    await expect(summaryUi.retry(panel)).toHaveCount(0);
    await expect(summaryUi.disableAuto(panel)).toHaveCount(0);
    panel = await openPanel(page, ws.id, without.documentId);
    await expect(summaryUi.empty(panel)).toBeVisible();
    await expect(summaryUi.createButton(panel)).toHaveCount(0);

    for (const id of [withSummary.documentId, without.documentId]) {
      const create = await requestSummary(viewer, id);
      expect(create.status).toBe(403);
      expect((create.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
      const retry = await retrySummary(viewer, id);
      expect(retry.status).toBe(403);
      expect((retry.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
    }

    await workspaceFactory.archive(owner, ws.id);
    await switchUser(page, owner);
    panel = await openPanel(page, ws.id, withSummary.documentId);
    await expect(summaryUi.overallHeading(panel)).toBeVisible();
    await expect(summaryUi.createButton(panel)).toHaveCount(0);
    await expect(summaryUi.retry(panel)).toHaveCount(0);
    await expect(summaryUi.disableAuto(panel)).toHaveCount(0);
    for (const id of [withSummary.documentId, without.documentId]) {
      const create = await requestSummary(owner, id);
      expect(create.status).toBe(403);
      expect((create.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    }
    const archived = await getSummary(owner, withSummary.documentId);
    expect(archived.summary?.run_id).toBe(withSummary.state.summary?.run_id);
  },
);

test(
  'DOCSUM-01-AC05 with the feature off create is disabled with a reason and publishing starts no run',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('docsum01-ac05');
    const ws = await workspaceFactory.create(owner);
    const withSummary = await summarizedDoc(owner, ws.id);
    const without = await readyDoc(owner, ws.id, book('book-en'));
    await signInAs(page, owner.user);

    const off = await startSummaryOffStack();
    try {
      await page.goto(`${off.webUrl}${summaryPanelPath(ws.id, without.documentId)}`);
      let panel = summaryUi.panel(page);
      await expect(panel).toBeVisible();
      const create = summaryUi.createButton(panel);
      await expect(create).toHaveAttribute('aria-disabled', 'true');
      await expect(create).toHaveAccessibleDescription(summaryUi.unavailableReason);
      await create.focus();
      await expect(create).toBeFocused();

      const state = await off.request<SummaryState>(
        owner,
        'GET',
        `/documents/${without.documentId}/summary`,
      );
      expect(state.status).toBe(200);
      expect(state.body?.available).toBe(false);
      const refused = await off.request<Problem>(
        owner,
        'POST',
        `/documents/${without.documentId}/summary`,
      );
      expect(refused.status).toBe(409);
      expect(refused.body?.type).toBe(SUMMARY_PROBLEMS.disabled);

      await page.goto(`${off.webUrl}${summaryPanelPath(ws.id, withSummary.documentId)}`);
      panel = summaryUi.panel(page);
      await expect(summaryUi.overallHeading(panel)).toBeVisible();
      await expect(summaryUi.aiBadge(panel)).toBeVisible();

      // Publishing on the feature-off stack creates no run; the summary turns stale only.
      await correctChapterB(
        owner,
        withSummary.documentId,
        snippet(B_PARAGRAPH.text),
        '꺼짐 교정 문장이다.',
      );
      const published = await off.request<{ job_id: string }>(
        owner,
        'POST',
        `/documents/${withSummary.documentId}/publish`,
      );
      expect(published.status).toBe(202);
      await waitForJobStatus(owner, published.body?.job_id ?? '', 'succeeded');
      const after = await off.request<SummaryState>(
        owner,
        'GET',
        `/documents/${withSummary.documentId}/summary`,
      );
      expect(after.body).toMatchObject({ available: false, run: null, stale: true });
      expect(after.body?.summary?.run_id).toBe(withSummary.state.summary?.run_id);
      expect(await summaryJobs(owner, ws.id, withSummary.documentId)).toHaveLength(1);

      await page.reload();
      await expect(summaryUi.stale(panel)).toBeVisible();
      await expect(summaryUi.stale(panel)).not.toContainText(summaryUi.staleRunning);
      await expect(summaryUi.overallHeading(panel)).toBeVisible();
    } finally {
      await off.stop();
    }
  },
);

test(
  'DOCSUM-01-AC06 a share guest reads only the current revision summary, read-only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('docsum01-ac06');
    const ws = await workspaceFactory.create(owner);
    const current = await summarizedDoc(owner, ws.id);
    const pending = await summarizedDoc(owner, ws.id, {
      ...book('book-en'),
      file: slowSummaryBook().file.replace('book-ko', 'book-en'),
    });
    const otherWs = await workspaceFactory.create(owner);
    const foreign = await summarizedDoc(owner, otherWs.id);
    const link = await createShareLink(owner, ws.id);
    const session = await ShareSession.open(link.id, link.secret);

    // The second book's new revision is being summarized (slow marker: both chapters changed).
    const en = book('book-en');
    for (const [pageNo, id] of [
      [2, 'ch1-p1'],
      [4, 'ch2-p1'],
    ] as const) {
      const original = block(en, id).text;
      await correctBlock(
        owner,
        pending.documentId,
        pageNo,
        snippet(original),
        `Changed. ${original}`,
      );
    }
    await publishAndWait(owner, pending.documentId);

    expect((await session.get(`/documents/${pending.documentId}/summary`)).status).toBe(404);
    await openShareWithSecret(page, link.id, link.secret);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    await expect(summaryUi.rowButton(page, current.title)).toBeVisible();
    await expect(summaryUi.rowButton(page, pending.title)).toHaveCount(0);
    // The checks above ran while that run was still in progress.
    expect(['queued', 'running']).toContain(
      (await getSummary(owner, pending.documentId)).run?.status,
    );

    const res = await session.get<Record<string, unknown>>(
      `/documents/${current.documentId}/summary`,
    );
    expect(res.status).toBe(200);
    for (const key of ['usage', 'run', 'run_id', 'stale', 'enabled', 'available']) {
      expect(Object.keys(res.body ?? {}), 'no run, status or cost data').not.toContain(key);
    }
    expect(res.text).not.toMatch(/cost_usd|error_code|tokens/);

    await summaryUi.rowButton(page, current.title).click();
    const panel = summaryUi.panel(page);
    await expect(summaryUi.overallHeading(panel)).toBeVisible();
    await expect(summaryUi.chaptersHeading(panel)).toBeVisible();
    await expect(summaryUi.createButton(panel)).toHaveCount(0);
    await expect(summaryUi.retry(panel)).toHaveCount(0);
    await expect(summaryUi.disableAuto(panel)).toHaveCount(0);
    await expect(summaryUi.progress(panel)).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel).not.toContainText(/비용|cost|\$\s*\d/i);

    const linkToPage = summaryUi.pageLinks(summaryUi.keyPoints(panel).first()).first();
    const target = await linkedPage(linkToPage);
    await linkToPage.click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return (
          url.pathname === sharePath(link.id) &&
          url.searchParams.get('document') === current.documentId &&
          url.searchParams.get('page') === String(target)
        );
      })
      .toBe(true);
    await expect(sharedUi.pdfViewer(page)).toBeVisible();

    const foreignRes = await session.get(`/documents/${foreign.documentId}/summary`);
    const unknownRes = await session.get(`/documents/${RANDOM_ID}/summary`);
    expect(foreignRes.status).toBe(404);
    expect(stableProblem(foreignRes)).toEqual(stableProblem(unknownRes));

    await revokeShareLink(owner, ws.id, link.id);
    expect((await session.get(`/documents/${current.documentId}/summary`)).status).toBe(404);
  },
);

test(
  'DOCSUM-01-AC07 only ready books offer 요약; DOC-02 links to the panel; foreign ids are not found; history stacks above',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('docsum01-ac07');
    const stranger = await workspaceFactory.member('docsum01-ac07-other');
    const ws = await workspaceFactory.create(owner);
    const paper = await readyDoc(owner, ws.id, questionPaper(), 'question_paper');
    const summarized = await summarizedDoc(owner, ws.id);

    // A book held in `processing` (db fixture use 6, as DOC-03-AC03): not ready for a summary.
    const processing = await readyDoc(owner, ws.id, book('book-en'));
    holdDocumentProcessing(processing.documentId);
    const early = await requestSummary(owner, processing.documentId);
    expect(early.status).toBe(409);
    expect((early.body as Problem).type).toBe(SUMMARY_PROBLEMS.notReady);

    const notApplicable = await requestSummary(owner, paper.documentId);
    expect(notApplicable.status).toBe(409);
    expect((notApplicable.body as Problem).type).toBe(SUMMARY_PROBLEMS.notApplicable);

    const foreignWs = await workspaceFactory.create(stranger);
    const foreign = await readyDoc(stranger, foreignWs.id, BOOK);
    const foreignRes = await owner.api.request('GET', `/documents/${foreign.documentId}/summary`);
    expect(foreignRes.status).toBe(404);

    await signInAs(page, owner.user);
    await page.goto(documentsPath(ws.id));
    const library = homeUi.documentsDialog(page);
    await expect(summaryUi.rowButton(library, summarized.title)).toBeVisible();
    await expect(docUi.item(page, escapeRegExp(paper.title))).toBeVisible();
    await expect(summaryUi.rowButton(library, paper.title)).toHaveCount(0);
    const processingRow = docUi.item(page, escapeRegExp(processing.title));
    await expect(processingRow).toBeVisible();
    await expect(docUi.ready(processingRow)).toHaveCount(0);
    await expect(summaryUi.rowButton(library, processing.title)).toHaveCount(0);

    // DOC-02 header 요약 → the home's summary panel of that document.
    await page.goto(`/workspaces/${ws.id}/documents/${summarized.documentId}`);
    await summaryUi.editorLink(page).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${ws.id}` &&
        url.searchParams.getAll('panel').includes('document-summary') &&
        url.searchParams.get('document') === summarized.documentId,
    );
    const panel = summaryUi.panel(page);
    await expect(summaryUi.overallHeading(panel)).toBeVisible();

    // The history dialog opened later stacks above the panel and lists 요약 만들기 + the job.
    await homeUi.historyButton(page).click();
    const history = historyUi.dialog(page);
    await expect(history).toBeVisible();
    await expect(panel).toBeVisible();
    const z = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).zIndex));
    expect(await z(history)).toBeGreaterThan(await z(panel));
    const enabled = historyUi
      .ofKind(page, 'activity')
      .filter({ hasText: /요약 만들기|summary enabled/i });
    await expect(enabled).toHaveCount(1);
    await expect(enabled).toContainText(summarized.title);
    const job = historyUi.ofKind(page, 'job').filter({ hasText: /문서 요약|document summary/i });
    await expect(job).toHaveCount(1);
    for (const row of [enabled, job]) {
      await expect(row).not.toContainText(snippet(A_PARAGRAPH.text, 12));
      await expect(row).not.toContainText(snippet(B_PARAGRAPH.text, 12));
    }
    const activities = await listActivities(owner, ws.id);
    expect(activities).toContainEqual(
      expect.objectContaining({
        event_type: 'document.summary_enabled',
        target_id: summarized.documentId,
      }),
    );
    expect(await summaryJobs(owner, ws.id, summarized.documentId)).toEqual([
      expect.objectContaining({ job_type: SUMMARY_JOB_TYPE, status: 'succeeded' }),
    ]);

    // A deep link to another workspace's document.
    await page.goto(summaryPanelPath(ws.id, foreign.documentId));
    await expect(summaryUi.notFound(summaryUi.panel(page))).toBeVisible();

    // Also when the user can read that other workspace: its summary never shows on this home.
    const ownOtherWs = await workspaceFactory.create(owner);
    const ownOther = await summarizedDoc(owner, ownOtherWs.id, book('book-en'));
    await page.goto(summaryPanelPath(ws.id, ownOther.documentId));
    const panelElsewhere = summaryUi.panel(page);
    await expect(summaryUi.notFound(panelElsewhere)).toBeVisible();
    await expect(summaryUi.overallHeading(panelElsewhere)).toHaveCount(0);
  },
);

test(
  'DOCSUM-01-AC08 an editor turns auto refresh off and on again; viewers cannot',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, viewer, ws } = await memberPair(workspaceFactory, 'docsum01-ac08');
    const doc = await summarizedDoc(owner, ws.id);
    await signInAs(page, owner.user);
    let panel = await openPanel(page, ws.id, doc.documentId);
    await expect(summaryUi.autoOn(panel)).toBeVisible();

    // 취소 changes nothing and returns focus to the button.
    const off = summaryUi.disableAuto(panel);
    await off.click();
    let dialog = summaryUi.confirm(page);
    await expect(dialog).toBeVisible();
    await summaryUi.confirmCancel(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(off).toBeFocused();
    expect((await getSummary(owner, doc.documentId)).enabled).toBe(true);

    await off.click();
    dialog = summaryUi.confirm(page);
    await summaryUi.confirmOff(dialog).click();
    await expect(summaryUi.autoOff(panel)).toBeVisible();
    await expect(summaryUi.createButton(panel)).toBeVisible();
    expect((await getSummary(owner, doc.documentId)).enabled).toBe(false);

    // Publishing with auto refresh off creates no run; the old summary turns stale.
    const token = uniqueToken('꺼짐표지');
    await correctChapterB(owner, doc.documentId, snippet(B_PARAGRAPH.text), `${token} 문장이다.`);
    const revision = await publishAndWait(owner, doc.documentId);
    const after = await getSummary(owner, doc.documentId);
    expect(after).toMatchObject({ enabled: false, run: null, stale: true });
    expect(await summaryJobs(owner, ws.id, doc.documentId)).toHaveLength(1);
    await page.reload();
    panel = summaryUi.panel(page);
    await expect(summaryUi.stale(panel)).toBeVisible();
    await expect(summaryUi.stale(panel)).not.toContainText(summaryUi.staleRunning);
    await expect(summaryUi.overallHeading(panel)).toBeVisible();

    await switchUser(page, viewer);
    panel = await openPanel(page, ws.id, doc.documentId);
    await expect(summaryUi.autoOff(panel)).toBeVisible();
    await expect(summaryUi.disableAuto(panel)).toHaveCount(0);
    await expect(summaryUi.createButton(panel)).toHaveCount(0);
    const refused = await disableAutoSummary(viewer, doc.documentId);
    expect(refused.status).toBe(403);
    expect((refused.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);

    // 요약 만들기 turns it back on and summarizes the current revision, reusing chapter A.
    await switchUser(page, owner);
    panel = await openPanel(page, ws.id, doc.documentId);
    await summaryUi.createButton(panel).click();
    const done = await waitForSummaryRun(owner, doc.documentId, 'succeeded', revision);
    expect(done.enabled).toBe(true);
    expect(done.summary?.usage?.reused_units).toBeGreaterThanOrEqual(1);
    await expect(summaryUi.stale(panel)).toHaveCount(0, { timeout: SUMMARY_TIMEOUT_MS });
    await expect(summaryUi.autoOn(panel)).toBeVisible();

    const events = (await listActivities(owner, ws.id))
      .filter((a) => a.target_id === doc.documentId)
      .map((a) => a.event_type);
    expect(events).toEqual(
      expect.arrayContaining(['document.summary_auto_disabled', 'document.summary_enabled']),
    );
    expect(events.filter((e) => e === 'document.summary_enabled')).toHaveLength(2);
    await homeUi.historyButton(page).click();
    const disabledRow = historyUi
      .ofKind(page, 'activity')
      .filter({ hasText: /자동 갱신 끄기|auto refresh (turned )?off/i });
    await expect(disabledRow).toHaveCount(1);
    await expect(disabledRow).not.toContainText(token);
    await expect(
      historyUi.ofKind(page, 'activity').filter({ hasText: /요약 만들기|summary enabled/i }),
    ).toHaveCount(2);
  },
);
