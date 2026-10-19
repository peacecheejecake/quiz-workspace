// HISTORY-01 — 작업·변경·풀이 이력, since UX3c the workspace home's "이력" dialog
// (`/workspaces/:workspaceId?panel=history`, one chronological list), docs/screens/history-jobs.md; history data model docs/architecture.md §5 (`activity_events`,
// `async_jobs`, `question_attempts`), personal study history private to its user
// (questions.md §2, workspace-sharing.md, implementation-plan §7).
//
// Each test signs in its own user with a fresh workspace and produces the history through the
// public API first (document upload + block correction / reindex, question create + edit,
// practice attempts). A failing reindex comes from the APP_ENV=test fake embedder via
// INDEX_FAILURE_MARKER (DOC-02-AC04). Read-API shapes and the UI label contract are assumptions
// H1–H4 in the fixtures/history.ts header.
import type { Locator } from '@playwright/test';
import {
  answerCorrectly,
  block,
  book,
  correctBlock,
  createQuestion,
  expect,
  historyPath,
  historyUi,
  INDEX_FAILURE_MARKER,
  JOB_TIMEOUT_MS,
  listActivities,
  listAttempts,
  listDocuments,
  listWorkspaceAttempts,
  listWorkspaceJobs,
  numberedMcq,
  publishDocument,
  RESULT_TEXT,
  seedMembership,
  signInAs,
  startPractice,
  submitPractice,
  test,
  uploadReadyBook,
  waitForJobStatus,
  type Job,
  type Member,
  type Problem,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 60_000 });

const BOOK = book('book-ko');
const CHLORINE = block(BOOK, 'ch2-s2-p2'); // page 4
const CHLORINE_SNIPPET = '염소와 같은 소독제';

/** The ISO time in the entry's <time datetime> lies within [from, now]. */
async function expectTimeBetween(item: Locator, from: number): Promise<void> {
  const time = historyUi.time(item).first();
  await expect(time).toBeVisible();
  const at = Date.parse((await time.getAttribute('datetime')) ?? '');
  expect(at, 'entry time').toBeGreaterThanOrEqual(from - 60_000);
  expect(at, 'entry time').toBeLessThanOrEqual(Date.now() + 60_000);
}

async function documentTitle(owner: Member, workspaceId: string, id: string): Promise<string> {
  const doc = (await listDocuments(owner, workspaceId)).find((d) => d.id === id);
  if (!doc?.title) throw new Error('uploaded document has no title');
  return doc.title;
}

test(
  'HISTORY-01-AC01 document corrections and question changes list actor, time, target and revision',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const started = Date.now();
    const owner = await workspaceFactory.member('history01-ac01');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const title = await documentTitle(owner, ws.id, documentId);
    const corrected = await correctBlock(
      owner,
      documentId,
      4,
      CHLORINE_SNIPPET,
      `${CHLORINE.text} (교정)`,
    );
    const question = await createQuestion(owner, ws.id, numberedMcq('history01-ac01', 1));
    await owner.api.ok(
      'PATCH',
      `/questions/${question.id}`,
      { base_revision_id: question.revision.id, stem: 'history01-ac01 수정된 문제' },
      [200],
    );

    await signInAs(page, owner.user);
    await page.goto(historyPath(ws.id));
    await expect(historyUi.dialog(page)).toBeVisible();
    await expect(historyUi.list(page)).toBeVisible();
    const activities = historyUi.ofKind(page, 'activity');

    const correction = activities.filter({ hasText: title }).filter({ hasText: /교정|correct/i });
    await expect(correction).toHaveCount(1);
    await expect(correction).toContainText(historyUi.me);
    await expect(correction).toContainText(historyUi.revision(corrected.revisionNumber));
    await expectTimeBetween(correction, started);

    const edit = activities
      .filter({ hasText: /(?<!\d)1번 문제|question 1(?!\d)/i })
      // Not "변경": every activity row carries that kind badge.
      .filter({ hasText: /수정|updated|edited/i });
    await expect(edit).toHaveCount(1);
    await expect(edit).toContainText(historyUi.me);
    await expect(edit).toContainText(historyUi.revision(2));
    await expectTimeBetween(edit, started);

    // The API behind it names the same actor, target and revision (H1).
    const items = await listActivities(owner, ws.id);
    expect(items).toContainEqual(
      expect.objectContaining({
        event_type: 'document.block_corrected',
        target_id: documentId,
        actor: expect.objectContaining({ id: owner.user.id }),
        revision: { id: corrected.revisionId, number: corrected.revisionNumber },
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        event_type: 'question.updated',
        target_id: question.id,
        actor: expect.objectContaining({ id: owner.user.id }),
        revision: expect.objectContaining({ number: 2 }),
      }),
    );
  },
);

test(
  'HISTORY-01-AC02 a failed indexing job shows its cause, that it can be retried, and a retry action',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('history01-ac02');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    // INDEX_FAILURE_MARKER makes the E2E fake embedder fail this reindex (DOC-02-AC04).
    await correctBlock(owner, documentId, 4, CHLORINE_SNIPPET, `${INDEX_FAILURE_MARKER} 교정`);
    const failedId = await publishDocument(owner, documentId);
    await waitForJobStatus(owner, failedId, 'failed');
    const failed = await owner.api.ok<Job & { created_at: string }>(
      'GET',
      `/jobs/${failedId}`,
      undefined,
      [200],
    );

    await signInAs(page, owner.user);
    await page.goto(historyPath(ws.id));
    await expect(historyUi.list(page)).toBeVisible();

    const entry = historyUi.ofKind(page, 'job').filter({ hasText: historyUi.indexFailed });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText(historyUi.retryable);
    const retry = historyUi.retry(entry);
    await expect(retry).toBeEnabled();
    await retry.click();

    // The action starts a new reindex job for the same document; the failed one stays listed.
    await expect
      .poll(
        async () =>
          (await listWorkspaceJobs(owner, ws.id)).filter(
            (j) =>
              j.target_id === documentId &&
              j.id !== failedId &&
              Date.parse(j.created_at) > Date.parse(failed.created_at),
          ).length,
        { message: 'retry created a new job', timeout: JOB_TIMEOUT_MS },
      )
      .toBeGreaterThan(0);
    const listed = (await listWorkspaceJobs(owner, ws.id)).find((j) => j.id === failedId);
    expect(listed).toMatchObject({
      status: 'failed',
      error_code: 'indexing_failed',
      retryable: true,
      target_type: 'document',
      target_id: documentId,
    });
  },
);

test(
  'HISTORY-01-AC03 practice history shows only the signed-in user’s own attempts',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('history01-ac03-owner');
    const viewer = await workspaceFactory.member('history01-ac03-viewer');
    const ws = await workspaceFactory.create(owner);
    const question = await createQuestion(owner, ws.id, numberedMcq('history01-ac03', 1, 0));
    // DB seed (fixtures/db.ts use 2): no membership-management API exists yet.
    seedMembership(ws.id, viewer.user.id, 'viewer');

    // Owner answers wrong, the viewer answers right (A10 practice API).
    const session = await startPractice(owner, question.id);
    const wrong = question.revision.options[1]?.id ?? '';
    expect((await submitPractice(owner, session.id, { selected_option_ids: [wrong] })).result).toBe(
      'incorrect',
    );
    await answerCorrectly(viewer, question);
    const [ownerAttempt] = await listAttempts(owner, question.id);
    const [viewerAttempt] = await listAttempts(viewer, question.id);

    await signInAs(page, viewer.user);
    await page.goto(historyPath(ws.id));
    await expect(historyUi.list(page)).toBeVisible();
    const attempts = historyUi.ofKind(page, 'attempt');
    await expect(attempts).toHaveCount(1);
    await expect(attempts.first()).toContainText(RESULT_TEXT.correct);
    await expect(attempts.first()).not.toContainText(RESULT_TEXT.incorrect);

    // Each account reads only its own attempts; another user's id is never honoured (H3).
    expect((await listWorkspaceAttempts(viewer, ws.id)).map((a) => a.id)).toEqual([
      viewerAttempt?.id,
    ]);
    expect((await listWorkspaceAttempts(owner, ws.id)).map((a) => a.id)).toEqual([
      ownerAttempt?.id,
    ]);
    const probe = await viewer.api.request(
      'GET',
      `/workspaces/${ws.id}/attempts?user_id=${owner.user.id}`,
    );
    if (probe.status === 200) {
      const ids = (probe.body as { items: { id: string }[] }).items.map((a) => a.id);
      expect(ids).not.toContain(ownerAttempt?.id);
    } else {
      expect([400, 403, 422]).toContain(probe.status);
    }
    const outsider = await workspaceFactory.member('history01-ac03-outsider');
    const denied = await outsider.api.request('GET', `/workspaces/${ws.id}/attempts`);
    expect(denied.status).toBe(404);
    expect((denied.body as Problem | undefined)?.detail, 'an authorization 404').toBeTruthy();
  },
);

test(
  'HISTORY-01-AC04 the 이력 button opens one chronological list with a kind badge per entry',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('history01-ac04');
    const ws = await workspaceFactory.create(owner);
    const question = await createQuestion(owner, ws.id, numberedMcq('history01-ac04', 1, 0));
    await answerCorrectly(owner, question);
    await owner.api.ok(
      'PATCH',
      `/questions/${question.id}`,
      { base_revision_id: question.revision.id, stem: 'history01-ac04 수정된 문제' },
      [200],
    );

    await signInAs(page, owner.user);
    await page.goto(`/workspaces/${ws.id}`);
    // The icon button sits left of 공유하기 in the workspace header.
    const button = historyUi.button(page);
    const share = page.getByRole('button', { name: /^(공유하기|share)$/i });
    await expect(button).toBeVisible();
    const [b, s] = await Promise.all([button.boundingBox(), share.boundingBox()]);
    expect((b?.x ?? 0) < (s?.x ?? 0), 'history button left of 공유하기').toBe(true);
    await button.click();

    await expect(page).toHaveURL(/[?&]panel=history(&|$)/);
    const dialog = historyUi.dialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
    await expect(historyUi.list(page)).toBeVisible();
    await expect(historyUi.ofKind(page, 'attempt')).toHaveCount(1);
    await expect(historyUi.ofKind(page, 'activity').first()).toBeVisible();

    // Newest first across the three kinds.
    const times = await historyUi
      .list(page)
      .locator(':scope > li time[datetime]')
      .evaluateAll((els) => els.map((el) => Date.parse(el.getAttribute('datetime') ?? '')));
    expect(times.length).toBeGreaterThan(1);
    expect([...times].sort((x, y) => y - x)).toEqual(times);

    await dialog.getByRole('button', { name: /이력 닫기|close/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/panel=history/);
  },
);
