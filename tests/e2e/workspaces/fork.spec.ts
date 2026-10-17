// WS-FORK-01 — Workspace Fork (`/share/:shareId?panel=fork`), docs/screens/workspace-fork.md,
// docs/workspace-sharing.md §3–§6.
//
// The recipient is a separate per-test account signed in through /login in a cookie-less context;
// the owner shares through the public API (link created first, so until S1a the failure names the
// missing share-link route). API checks use a Node-fetch ShareSession plus the recipient's JWT.
// The mid-fork race uses the APP_ENV=test fork worker markers (fixtures/sharing.ts S6), never a
// test-only endpoint. Every API/UI assumption: fixtures/sharing.ts header.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  createQuestion,
  JOB_TIMEOUT_MS,
  listDocuments,
  listQuestions,
  mcqInput,
  search,
  seedGradedAttempt,
  signInAs,
  snippet,
  submitLogin,
  uniqueWorkspaceName,
  wsUi,
} from '../fixtures/test.ts';
import {
  activityCountBy,
  createShareLink,
  DRAFT_TEXT,
  expectFragmentRemoved,
  expectUrl,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  expect,
  expireShareLinkNow,
  FORK_FAILURE_MARKER,
  FORK_PAUSE_MARKER,
  FORK_TIMEOUT_MS,
  forkUi,
  getFork,
  membershipsOf,
  privateRowCounts,
  PUBLISHED_BLOCK,
  rawApi,
  revokeShareLink,
  seedOwnerStudyState,
  seedUnpublishedQuestions,
  seedSharedContent,
  sharedUi,
  sharePath,
  ShareSession,
  startFork,
  test,
  updateShareLink,
  waitForFork,
  workspaceRowsOwnedBy,
} from '../fixtures/sharing.ts';

test.use({ storageState: { cookies: [], origins: [] }, ...NO_VISUAL_ARTIFACTS });
test.describe.configure({ timeout: JOB_TIMEOUT_MS + 2 * FORK_TIMEOUT_MS + 60_000 });

const NO_PRIVATE_ROWS = {
  question_user_states: 0,
  question_attempts: 0,
  practice_sessions: 0,
  question_drafts: 0,
  workspace_share_links: 0,
};

/** Opens the share link, waits for the exchange, then opens the Fork dialog. */
async function openForkDialog(page: Page, id: string, secret: string) {
  await openShareWithSecret(page, id, secret);
  await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
  await expectFragmentRemoved(page, id);
  await sharedUi.forkButton(page).click();
  const dialog = forkUi.dialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test(
  'WS-FORK-01-AC01 only a signed-in viewer of a valid Fork ON link gets the Fork dialog',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('fork01-ac01');
    const recipient = await workspaceFactory.member('fork01-ac01-recipient');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('fork01-ac01'));
    const on = await createShareLink(owner, ws.id, { allow_fork: true });
    const off = await createShareLink(owner, ws.id);

    // Signed out: Fork leads to sign-in, and sign-in returns to the dialog (the share context is
    // restored from the share cookie; the fragment is long gone).
    await openShareWithSecret(page, on.id, on.secret);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    await sharedUi.forkButton(page).click();
    await expectUrl(page, (url) => url.pathname === '/login', 'Fork sends a guest to /login');
    await submitLogin(page, recipient.user, `/share/${on.id}?panel=fork`);
    await expectUrl(
      page,
      (url) => url.pathname === `/share/${on.id}` && url.searchParams.get('panel') === 'fork',
      'sign-in returns to /share/{id}?panel=fork',
    );
    await expect(forkUi.dialog(page)).toBeVisible();

    // Fork OFF: no button, and the panel URL opens no dialog.
    await openShareWithSecret(page, off.id, off.secret);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    await expect(sharedUi.forkButton(page)).toHaveCount(0);
    await page.goto(`${sharePath(off.id)}?panel=fork`);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    await expect(forkUi.dialog(page)).toHaveCount(0);
  },
);

test(
  'WS-FORK-01-AC02 the fork API refuses guests, Fork OFF, expired or revoked links and foreign sessions',
  { tag: '@infra' },
  async ({ workspaceFactory }) => {
    const owner = await workspaceFactory.member('fork01-ac02');
    const recipient = await workspaceFactory.member('fork01-ac02-recipient');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('fork01-ac02'));
    const on = await createShareLink(owner, ws.id, { allow_fork: true });
    const off = await createShareLink(owner, ws.id);
    const expiring = await createShareLink(owner, ws.id, { allow_fork: true });
    const onSession = await ShareSession.open(on.id, on.secret);
    const offSession = await ShareSession.open(off.id, off.secret);
    const expiringSession = await ShareSession.open(expiring.id, expiring.secret);

    expect((await onSession.fork(undefined, 'guest')).status, 'no JWT').toBe(401);
    const noSession = await rawApi('POST', `/shared/${on.id}/forks`, {
      bearer: recipient.session.accessToken,
      body: { name: 'no session' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect([403, 404], 'JWT without a share session').toContain(noSession.status);
    expect((await offSession.fork(recipient, 'off')).status, 'allow_fork OFF').toBe(403);
    const foreign = await rawApi('POST', `/shared/${on.id}/forks`, {
      cookie: offSession.cookie,
      bearer: recipient.session.accessToken,
      body: { name: 'foreign session' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect([403, 404], 'session of another link').toContain(foreign.status);
    expect((await onSession.fork(recipient, 'csrf', randomUUID(), null)).status, 'no Origin').toBe(
      403,
    );
    expect(
      (await onSession.fork(recipient, 'csrf', randomUUID(), 'https://evil.example')).status,
      'foreign Origin',
    ).toBe(403);
    expireShareLinkNow(expiring.id);
    expect((await expiringSession.fork(recipient, 'expired')).status, 'expired').toBe(404);
    await revokeShareLink(owner, ws.id, on.id);
    expect((await onSession.fork(recipient, 'revoked')).status, 'revoked').toBe(404);

    expect(workspaceRowsOwnedBy(recipient.user.id), 'no workspace from a refused fork').toBe(0);
    expect(await workspaceFactory.list(recipient)).toEqual([]);
  },
);

test(
  'WS-FORK-01-AC03 the dialog explains scope, independence, no progress copy and copyright, and asks a name',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('fork01-ac03');
    const recipient = await workspaceFactory.member('fork01-ac03-recipient');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('fork01-ac03'));
    const link = await createShareLink(owner, ws.id, { allow_fork: true });

    await signInAs(page, recipient.user);
    const dialog = await openForkDialog(page, link.id, link.secret);
    await expect(forkUi.scope(dialog)).toBeVisible();
    await expect(forkUi.independent(dialog)).toBeVisible();
    await expect(forkUi.noProgress(dialog)).toBeVisible();
    await expect(forkUi.copyright(dialog)).toBeVisible();
    const name = forkUi.nameField(dialog);
    await expect(name).toBeEditable();

    // A blank name is refused on the client; nothing is created.
    await name.fill('');
    await forkUi.submit(dialog).click();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(workspaceRowsOwnedBy(recipient.user.id)).toBe(0);
    await name.fill('E2E 내 Fork 이름');
    await expect(name).toHaveValue('E2E 내 Fork 이름');
    await expect(forkUi.submit(dialog)).toBeEnabled();
  },
);

test(
  'WS-FORK-01-AC04 starting a fork returns 202 + job id, is idempotent and shows progress, completion and failure',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('fork01-ac04');
    const recipient = await workspaceFactory.member('fork01-ac04-recipient');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('fork01-ac04'));
    const link = await createShareLink(owner, ws.id, { allow_fork: true });
    await createQuestion(owner, ws.id, mcqInput('E2E fork 진행 문제', ['1', '2', '3']));

    // API: 202 + job id; the same Idempotency-Key replays the same fork, another body conflicts.
    const session = await ShareSession.open(link.id, link.secret);
    const key = randomUUID();
    const fork = await startFork(recipient, session, 'E2E API fork', key);
    expect(fork.job_id).toBeTruthy();
    expect(['PENDING', 'COPYING', 'COMPLETED']).toContain(fork.status);
    expect((await startFork(recipient, session, 'E2E API fork', key)).id).toBe(fork.id);
    expect((await session.fork(recipient, 'E2E 다른 이름', key)).status).toBe(409);
    expect((await owner.api.request('GET', `/me/forks/${fork.id}`)).status, 'not yours').toBe(404);
    await waitForFork(recipient, fork.id, 'COMPLETED');

    // UI: progress then completion with a link to the new workspace.
    await signInAs(page, recipient.user);
    let dialog = await openForkDialog(page, link.id, link.secret);
    await forkUi.nameField(dialog).fill('E2E UI fork');
    await forkUi.submit(dialog).click();
    await expect(forkUi.progress(page).or(forkUi.done(page)).first()).toBeVisible();
    await expect(forkUi.done(page)).toBeVisible({ timeout: FORK_TIMEOUT_MS });
    await expect(page.getByRole('link', { name: 'E2E UI fork' })).toBeVisible();

    // Failure (fake worker marker): alert + retry, nothing left behind.
    const before = workspaceRowsOwnedBy(recipient.user.id);
    dialog = await openForkDialog(page, link.id, link.secret);
    await forkUi.nameField(dialog).fill(`E2E ${FORK_FAILURE_MARKER}`);
    await forkUi.submit(dialog).click();
    await expect(forkUi.alert(page)).toBeVisible({ timeout: FORK_TIMEOUT_MS });
    await expect(forkUi.retry(page)).toBeVisible();
    expect(workspaceRowsOwnedBy(recipient.user.id)).toBe(before);
  },
);

test(
  'WS-FORK-01-AC05 the fork has the same published content with new ids and owner, and fresh progress',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('fork01-ac05');
    const recipient = await workspaceFactory.member('fork01-ac05-recipient');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('fork01-ac05'));
    const link = await createShareLink(owner, ws.id, { allow_fork: true });
    const content = await seedSharedContent(owner, ws.id);
    const [first] = content.questions;
    if (!first) throw new Error('no seeded question');
    seedOwnerStudyState(owner.user.id, ws.id, first.id);
    seedGradedAttempt(ws.id, first.id, first.revision.id, owner.user.id);
    await seedUnpublishedQuestions(owner, ws.id);
    const sourceRows = privateRowCounts(ws.id);

    const session = await ShareSession.open(link.id, link.secret);
    const fork = await startFork(recipient, session, 'E2E 완성 fork');
    const done = await waitForFork(recipient, fork.id, 'COMPLETED');
    const target = done.target_workspace_id ?? '';
    expect(target).not.toBe('');
    expect(target).not.toBe(ws.id);

    // Owner and membership are the recipient's only.
    const mine = await workspaceFactory.list(recipient);
    expect(mine.map((w) => [w.id, w.name, w.role])).toEqual([[target, 'E2E 완성 fork', 'owner']]);
    expect(membershipsOf(target)).toEqual([[recipient.user.id, 'owner']]);

    // Same published documents and questions (answers, explanations), new ids.
    const srcDocs = await listDocuments(owner, ws.id);
    const dstDocs = await listDocuments(recipient, target);
    expect(dstDocs.map((d) => d.title)).toEqual(srcDocs.map((d) => d.title));
    expect(dstDocs.some((d) => srcDocs.some((s) => s.id === d.id))).toBe(false);
    const dstQuestions = await listQuestions(recipient, target);
    // Only CONFIRMED questions are forked (no DRAFT/ARCHIVED/deleted questions, no import drafts).
    expect(new Set(dstQuestions.map((q) => q.revision.stem))).toEqual(
      new Set(content.questions.map((q) => q.revision.stem)),
    );
    for (const src of content.questions) {
      const dst = dstQuestions.find((q) => q.revision.stem === src.revision.stem);
      expect(dst, src.revision.stem).toBeDefined();
      expect(dst?.id).not.toBe(src.id);
      expect(dst?.revision.id).not.toBe(src.revision.id);
      expect(dst?.revision.correct_option_ids).toEqual(src.revision.correct_option_ids);
      expect(dst?.revision.explanation).toBe(src.revision.explanation);
      expect(dst?.sources.map((s) => s.document_id)).toEqual(dstDocs.map((d) => d.id));
    }
    const hits = await search(recipient, target, {
      query: snippet(PUBLISHED_BLOCK.text, 12),
      mode: 'keyword',
    });
    expect(hits.length, 'the published copy is searchable in the fork').toBeGreaterThan(0);
    expect(await search(recipient, target, { query: DRAFT_TEXT, mode: 'keyword' })).toEqual([]);

    // Progress, favourites/retry, drafts, share links and owner activity are not copied.
    expect(privateRowCounts(target)).toEqual(NO_PRIVATE_ROWS);
    expect(activityCountBy(target, owner.user.id)).toBe(0);
    expect(privateRowCounts(ws.id)).toEqual(sourceRows);

    // The fork shows up in the recipient's workspace list.
    await signInAs(page, recipient.user);
    await page.goto('/workspaces');
    await expect(wsUi.item(wsUi.tabPanel(page), 'E2E 완성 fork')).toBeVisible();
  },
);

test(
  'WS-FORK-01-AC06 revoking or turning Fork OFF mid-copy cancels and cleans up; a completed fork survives',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('fork01-ac06');
    const recipient = await workspaceFactory.member('fork01-ac06-recipient');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('fork01-ac06'));
    const revoking = await createShareLink(owner, ws.id, { allow_fork: true });
    const turningOff = await createShareLink(owner, ws.id, { allow_fork: true });
    const keeper = await createShareLink(owner, ws.id, { allow_fork: true });
    await createQuestion(owner, ws.id, mcqInput('E2E fork 경쟁 문제', ['가', '나']));

    // UI: revoke while the worker holds at the commit-time re-check (pause marker).
    await signInAs(page, recipient.user);
    const dialog = await openForkDialog(page, revoking.id, revoking.secret);
    await forkUi.nameField(dialog).fill(`E2E ${FORK_PAUSE_MARKER} revoke`);
    await forkUi.submit(dialog).click();
    await expect(forkUi.progress(page)).toBeVisible();
    await revokeShareLink(owner, ws.id, revoking.id);
    await expect(forkUi.cancelled(page)).toBeVisible({ timeout: FORK_TIMEOUT_MS });
    expect(workspaceRowsOwnedBy(recipient.user.id), 'cancelled copy cleaned up').toBe(0);

    // API: allow_fork OFF mid-copy.
    const offSession = await ShareSession.open(turningOff.id, turningOff.secret);
    const paused = await startFork(recipient, offSession, `E2E ${FORK_PAUSE_MARKER} off`);
    await waitForFork(recipient, paused.id, 'COPYING');
    await updateShareLink(owner, ws.id, turningOff.id, { allow_fork: false });
    const cancelled = await waitForFork(recipient, paused.id, 'CANCELLED');
    expect(cancelled.target_workspace_id).toBeNull();
    expect(workspaceRowsOwnedBy(recipient.user.id)).toBe(0);
    expect(await workspaceFactory.list(recipient)).toEqual([]);

    // A completed fork outlives the source link and the source workspace.
    const keeperSession = await ShareSession.open(keeper.id, keeper.secret);
    const kept = await startFork(recipient, keeperSession, 'E2E 남는 fork');
    const target = (await waitForFork(recipient, kept.id, 'COMPLETED')).target_workspace_id ?? '';
    await revokeShareLink(owner, ws.id, keeper.id);
    await workspaceFactory.softDelete(owner, ws.id);
    expect((await workspaceFactory.list(recipient)).map((w) => w.id)).toEqual([target]);
    expect((await listQuestions(recipient, target)).map((q) => q.revision.stem)).toEqual([
      'E2E fork 경쟁 문제',
    ]);
    expect((await getFork(recipient, kept.id)).status).toBe('COMPLETED');
    await page.goto('/workspaces');
    await expect(wsUi.item(wsUi.tabPanel(page), 'E2E 남는 fork')).toBeVisible();
  },
);
