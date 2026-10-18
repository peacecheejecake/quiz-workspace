// WS-VIEW-01 — 링크 기반 공유 Workspace 조회 (`/share/:shareId`), docs/screens/workspace-shared-view.md,
// docs/workspace-sharing.md §1–§3, docs/questions.md (shared privacy rules).
//
// Runs in the unauthenticated projects (playwright.config.ts): the browser is a guest with no
// session. Owners and their content are created through the public API by workspaceFactory and
// fixtures/sharing.ts; the share link is created first, so until S1a every test fails on the
// missing share-link route. Direct API checks use a Node-fetch ShareSession (secrets and cookies
// stay out of traces). The browser must open `/share/{id}#k=<secret>`; see the fixtures/sharing.ts
// header for that residual trace risk and for every API/UI assumption (S1–S9).
import type { Page, Request } from '@playwright/test';
import {
  createQuestion,
  JOB_TIMEOUT_MS,
  LOGIN_SCREEN,
  mcqInput,
  pageLabel,
  seedGradedAttempt,
  snippet,
  uniqueWorkspaceName,
} from '../fixtures/test.ts';
import {
  createShareLink,
  DRAFT_TEXT,
  exchangeRequest,
  expect,
  expectNoSecret,
  expireShareLinkNow,
  PERSONAL_KEYS,
  privateRowCounts,
  PUBLISHED_BLOCK,
  rawApi,
  revokeShareLink,
  seedOwnerStudyState,
  seedSharedContent,
  sharedUi,
  sharePath,
  ShareSession,
  stableProblem,
  test,
  updateShareLink,
  expectPrivacyHeaders,
  expectFragmentRemoved,
  expectUrl,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  seedUnpublishedQuestions,
  UNPUBLISHED_STEMS,
} from '../fixtures/sharing.ts';

test.use(NO_VISUAL_ARTIFACTS);
test.describe.configure({ timeout: JOB_TIMEOUT_MS + 90_000 });

const RANDOM_ID = '00000000-0000-4000-8000-000000000000';

/** Records every request URL and Referer the page sends (checked for the secret afterwards). */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req: Request) => {
    seen.push(req.url(), req.headers()['referer'] ?? '');
  });
  return seen;
}

/** Opens the link like a recipient would and waits for the exchange to remove the fragment. */
async function openShare(page: Page, shareId: string, secret: string): Promise<void> {
  await openShareWithSecret(page, shareId, secret);
  await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
  await expectFragmentRemoved(page, shareId);
}

test(
  'WS-VIEW-01-AC01 a signed-out guest with a valid link sees only the published outline, documents and questions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('view01-ac01');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('view01-ac01'));
    const link = await createShareLink(owner, ws.id);
    const content = await seedSharedContent(owner, ws.id);
    const requests = recordRequests(page);

    const res = await openShareWithSecret(page, link.id, link.secret);
    expect(res.headers()['cache-control'] ?? '').toMatch(/no-store/);
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['x-robots-tag'] ?? '').toMatch(/noindex/);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    await expectFragmentRemoved(page, link.id);
    expectNoSecret(page.url(), link.secret, 'the address bar after the exchange');

    await expect(sharedUi.heading(page)).toHaveText(ws.name);
    const session = await ShareSession.open(link.id, link.secret);
    const shared = await session.workspace();
    expect(shared.documents.map((d) => d.id)).toEqual([content.documentId]);
    await expect(sharedUi.documentLink(page, shared.documents[0]?.title ?? '?')).toBeVisible();
    for (const q of content.questions) {
      await expect(sharedUi.question(page, q.revision.stem)).toBeVisible();
    }
    await expect(page.getByText(DRAFT_TEXT)).toHaveCount(0);
    await expect(sharedUi.forbiddenControls(page)).toHaveCount(0);
    await expect(sharedUi.personalData(page)).toHaveCount(0);

    // The share cookie keeps the view without the fragment; it is not a login.
    await page.reload();
    await expect(sharedUi.heading(page)).toHaveText(ws.name);
    await page.goto(`/workspaces/${ws.id}/documents`);
    await expect(page).toHaveURL(LOGIN_SCREEN);

    for (const entry of requests) expectNoSecret(entry, link.secret, 'a request URL or Referer');
  },
);

test(
  'WS-VIEW-01-AC02 the guest opens document text, the PDF and search results with page locations',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('view01-ac02');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('view01-ac02'));
    const link = await createShareLink(owner, ws.id);
    const content = await seedSharedContent(owner, ws.id);
    const session = await ShareSession.open(link.id, link.secret);
    const [doc] = (await session.workspace()).documents;

    await openShare(page, link.id, link.secret);
    await sharedUi.documentLink(page, doc?.title ?? '?').click();
    await expect(sharedUi.pdfViewer(page)).toBeVisible();
    await expect(page.getByText(snippet(PUBLISHED_BLOCK.text)).first()).toBeVisible();

    await sharedUi.searchBox(page).fill(snippet(PUBLISHED_BLOCK.text, 12));
    await sharedUi.searchBox(page).press('Enter');
    const hit = sharedUi.results(page).getByRole('listitem').first();
    await expect(hit).toContainText(pageLabel(PUBLISHED_BLOCK.parts[0]?.page ?? 2));
    await hit.click();
    await expect(
      page.getByText(pageLabel(PUBLISHED_BLOCK.parts[0]?.page ?? 2)).first(),
    ).toBeVisible();

    // API: the PDF behind the session check, results only from this workspace's published docs.
    const pdf = await session.get(`/documents/${content.documentId}/pdf`);
    expect([200, 302, 303, 307]).toContain(pdf.status);
    expectPrivacyHeaders(pdf, 'shared pdf');
    if (pdf.status === 200) expect(pdf.contentType).toMatch(/^application\/pdf/);
    const found = await session.search(snippet(PUBLISHED_BLOCK.text, 12));
    expect(found.status).toBe(200);
    expect(found.body?.items.length).toBeGreaterThan(0);
    expect(new Set(found.body?.items.map((i) => i.document_id))).toEqual(
      new Set([content.documentId]),
    );
    expect((await session.search(DRAFT_TEXT)).body?.items).toEqual([]);
  },
);

test(
  'WS-VIEW-01-AC03 question preview and side panel are read-only and save no practice state',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('view01-ac03');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('view01-ac03'));
    const link = await createShareLink(owner, ws.id);
    const q = await createQuestion(owner, ws.id, {
      ...mcqInput('E2E 공유 미리보기 문제', ['가', '나', '다', '라'], 1),
      explanation: 'E2E 미리보기 해설',
    });
    seedOwnerStudyState(owner.user.id, ws.id, q.id);
    const before = privateRowCounts(ws.id);

    await openShare(page, link.id, link.secret);
    await sharedUi.question(page, q.revision.stem).click();
    const panel = sharedUi.questionPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute('aria-modal', 'true');
    await expect(panel).toContainText('나');
    await expect(panel).toContainText('E2E 미리보기 해설');
    await expect(panel).toContainText(/정답|answer/i);
    await expect(sharedUi.forbiddenControls(page)).toHaveCount(0);
    await expect(panel.getByRole('radio').or(panel.getByRole('checkbox'))).toHaveCount(0);
    await expect(page.getByText(/즐겨찾기|favou?rite|다시 풀기/i)).toHaveCount(0);

    // Nothing was recorded for anyone, and every write is refused for a share session.
    expect(privateRowCounts(ws.id)).toEqual(before);
    const session = await ShareSession.open(link.id, link.secret);
    for (const [method, path] of [
      ['PATCH', `/questions/${q.id}`],
      ['POST', `/workspaces/${ws.id}/questions`],
      ['POST', `/shared/${link.id}/questions/${q.id}/attempts`],
      ['PUT', `/shared/${link.id}/questions/${q.id}/favorite`],
    ] as const) {
      const res = await session.call(method, path, { body: { stem: 'guest' } });
      expect([401, 403, 404, 405], `${method} ${path}`).toContain(res.status);
    }
    expect(privateRowCounts(ws.id)).toEqual(before);
  },
);

test(
  'WS-VIEW-01-AC04 other workspace ids, unpublished revisions and owner personal data are blocked',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('view01-ac04');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('view01-ac04'));
    const link = await createShareLink(owner, ws.id);
    const other = await workspaceFactory.create(owner, uniqueWorkspaceName('view01-ac04-other'));
    const otherLink = await createShareLink(owner, other.id);
    const foreign = await createQuestion(
      owner,
      other.id,
      mcqInput('E2E 다른 workspace 문제', ['1', '2']),
    );
    const content = await seedSharedContent(owner, ws.id);
    const [first] = content.questions;
    if (!first) throw new Error('no seeded question');
    seedOwnerStudyState(owner.user.id, ws.id, first.id);
    seedGradedAttempt(ws.id, first.id, first.revision.id, owner.user.id);
    const hidden = await seedUnpublishedQuestions(owner, ws.id);
    const session = await ShareSession.open(link.id, link.secret);

    // Other workspace ids: 404 like ids that never existed.
    const missing = await session.get(`/questions/${RANDOM_ID}`);
    expect(missing.status).toBe(404);
    const cross = await session.get(`/questions/${foreign.id}`);
    expect(cross.status).toBe(404);
    expect(stableProblem(cross)).toEqual(stableProblem(missing));
    expect(cross.text.includes('E2E 다른 workspace 문제')).toBe(false);
    expect((await session.get(`/documents/${RANDOM_ID}`)).status).toBe(404);
    const reused = await rawApi('GET', `/shared/${otherLink.id}`, { cookie: session.cookie });
    expect(reused.status, 'a session never opens another link').toBe(404);

    // Unpublished revisions never: the draft text is not served nor searchable.
    const doc = await session.document(content.documentId);
    expect(JSON.stringify(doc).includes(DRAFT_TEXT)).toBe(false);
    expect(doc.blocks.some((b) => b.text.includes(snippet(PUBLISHED_BLOCK.text)))).toBe(true);
    expect((await session.search(DRAFT_TEXT)).body?.items).toEqual([]);

    // Only CONFIRMED questions: DRAFT, ARCHIVED, soft-deleted questions and import drafts are
    // absent from the list and search, and 404 by id exactly like a missing question.
    const questions = await session.get<{ items: Record<string, unknown>[] }>('/questions');
    expect(questions.status).toBe(200);
    expect(new Set(questions.body?.items.map((q) => q.id))).toEqual(
      new Set(content.questions.map((q) => q.id)),
    );
    for (const stem of Object.values(UNPUBLISHED_STEMS)) {
      expect(questions.text.includes(stem), stem).toBe(false);
      const found = await session.search(stem);
      expect(found.status).toBe(200);
      expect(found.text.includes(stem), `search ${stem}`).toBe(false);
    }
    for (const id of Object.values(hidden)) {
      const res = await session.get(`/questions/${id}`);
      expect(res.status, 'unpublished question by id').toBe(404);
      expect(stableProblem(res)).toEqual(stableProblem(missing));
    }

    // No owner personal data or identity.
    for (const item of questions.body?.items ?? []) {
      expect(PERSONAL_KEYS.filter((k) => k in item)).toEqual([]);
    }
    for (const res of [questions, await session.get()]) {
      expect(res.text.includes(owner.user.email)).toBe(false);
      expect(res.text.includes(owner.user.id)).toBe(false);
    }

    // The share cookie is not a login on the normal API.
    for (const path of [
      '/me',
      '/workspaces',
      `/workspaces/${ws.id}`,
      `/workspaces/${ws.id}/questions`,
    ]) {
      expect((await session.call('GET', path)).status, path).toBe(401);
    }

    // UI: another link id without its secret shows only the unavailable notice.
    await openShare(page, link.id, link.secret);
    for (const stem of Object.values(UNPUBLISHED_STEMS)) {
      await expect(page.getByText(stem)).toHaveCount(0);
    }
    await page.goto(sharePath(otherLink.id));
    await expect(sharedUi.unavailable(page)).toBeVisible();
    await expect(page.getByText(other.name)).toHaveCount(0);
  },
);

test(
  'WS-VIEW-01-AC05 wrong, expired, revoked and deleted links show one unavailable notice and end sessions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('view01-ac05');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('view01-ac05'));
    const expiring = await createShareLink(owner, ws.id);
    const revoked = await createShareLink(owner, ws.id);
    const doomedWs = await workspaceFactory.create(owner, uniqueWorkspaceName('view01-ac05-del'));
    const doomed = await createShareLink(owner, doomedWs.id);
    const never = await exchangeRequest(RANDOM_ID, expiring.secret);

    const expectUnavailable = async (name: string) => {
      await expect(sharedUi.unavailable(page)).toBeVisible();
      await expect(page.getByText(name)).toHaveCount(0);
      await expect(sharedUi.readOnlyNotice(page)).toHaveCount(0);
    };

    // Wrong secret.
    await openShareWithSecret(page, expiring.id, `${expiring.secret.slice(0, -4)}AAAA`);
    await expectUnavailable(ws.name);
    const wrong = await exchangeRequest(expiring.id, `${expiring.secret.slice(0, -4)}AAAA`);
    expect(wrong.status).toBe(404);
    expect(stableProblem(wrong)).toEqual(stableProblem(never));

    // Expired while a session is open: the next request is refused.
    await openShare(page, expiring.id, expiring.secret);
    expireShareLinkNow(expiring.id);
    await page.reload();
    await expectUnavailable(ws.name);

    // Revoked while open.
    await openShare(page, revoked.id, revoked.secret);
    await revokeShareLink(owner, ws.id, revoked.id);
    await page.reload();
    await expectUnavailable(ws.name);

    // Workspace deleted while open.
    await openShare(page, doomed.id, doomed.secret);
    await workspaceFactory.softDelete(owner, doomedWs.id);
    await page.reload();
    await expectUnavailable(doomedWs.name);

    for (const l of [expiring, revoked, doomed]) {
      const res = await exchangeRequest(l.id, l.secret);
      expect(res.status).toBe(404);
      expect(stableProblem(res)).toEqual(stableProblem(never));
    }
  },
);

test(
  'WS-VIEW-01-AC06 Fork OFF hides Fork; Fork ON offers it with a sign-in and independent-copy notice',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('view01-ac06');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('view01-ac06'));
    const link = await createShareLink(owner, ws.id);
    expect(link.allow_fork, 'Fork is OFF by default').toBe(false);

    await openShare(page, link.id, link.secret);
    await expect(sharedUi.heading(page)).toHaveText(ws.name);
    await expect(sharedUi.forkButton(page)).toHaveCount(0);
    await page.goto(`${sharePath(link.id)}?panel=fork`);
    await expect(page.getByRole('dialog', { name: /fork|복제/i })).toHaveCount(0);

    await updateShareLink(owner, ws.id, link.id, { allow_fork: true });
    await page.goto(sharePath(link.id));
    await expect(sharedUi.forkButton(page)).toBeVisible();
    await expect(page.getByText(/독립|independent/i).first()).toBeVisible();
    await expect(page.getByText(/로그인|sign in|log in/i).first()).toBeVisible();
    await sharedUi.forkButton(page).click();
    await expectUrl(
      page,
      (url) =>
        url.pathname === '/login' &&
        url.searchParams.get('next') === `/share/${link.id}?panel=fork`,
      'Fork sends a guest to /login?next=/share/{id}?panel=fork',
    );
  },
);
