// UX12-SHARE — per-link scope and the owner's records, read only (docs/screens/ux12-share-scope.md,
// docs/workspace-sharing.md §12). The flag × route matrix, the other-member leak and pagination are
// in tests/integration/sharing/test_share_scope.py; the mid-fork flag changes in
// supabase/tests/31_share_link_scope.test.sql. This spec is what a browser and a real fork see.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { bank, explUi, seedExplanation } from '../fixtures/ai-explanations.ts';
import {
  CH1,
  highlightExplanation,
  highlightNote,
  itemText,
  noteSetup,
  type NoteSetup,
} from '../fixtures/highlights.ts';
import { noteUi } from '../fixtures/chapter-notes.ts';
import {
  createShareLink,
  expect,
  forkedContentCounts,
  listShareLinks,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  rawApi,
  rotateShareLink,
  sharedUi,
  sharingUi,
  ShareSession,
  stableProblem,
  startFork,
  updateShareLink,
  waitForFork,
  type IssuedShareLink,
} from '../fixtures/sharing.ts';
import { startSummary, waitForSummaryRun } from '../fixtures/summary.ts';
import {
  homeUi,
  JOB_TIMEOUT_MS,
  overviewPath,
  seedGradedAttempt,
  seedMembership,
  signInAs,
  test,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] }, ...NO_VISUAL_ARTIFACTS });
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 120_000 });

const RANDOM_ID = '00000000-0000-4000-8000-000000000000';
const SWITCH = {
  notes: /^정리 노트/,
  ai: /^AI 해설/,
  summary: /^문서 요약/,
  owner: /^내 풀이 이력·하이라이트/,
};

/** A quote that is sure to be in the question's written explanation. */
const quoteOf = (q: Question): string => (q.revision.explanation ?? '').slice(0, 6);

const summaryButton = (page: Page) => page.getByRole('button', { name: /요약$/ });

async function withSummary(s: NoteSetup): Promise<void> {
  await startSummary(s.owner, s.documentId);
  await waitForSummaryRun(s.owner, s.documentId, 'succeeded');
}

async function openGuest(page: Page, link: IssuedShareLink): Promise<void> {
  await openShareWithSecret(page, link.id, link.secret);
  await expect(sharedUi.heading(page)).toBeVisible();
}

test(
  'UX12-SHARE-AC01 the owner sets the scope, it survives reopening and rotation, and only the owner can change it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member(`share-ac01-${randomUUID().slice(0, 6)}`);
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await homeUi.shareButton(page).click();
    await expect(sharingUi.dialog(page)).toBeVisible();

    // Before a link exists the switches are the next link's scope.
    await expect(sharingUi.scopeSwitch(page, SWITCH.notes)).toBeChecked();
    await expect(sharingUi.scopeSwitch(page, SWITCH.ai)).toBeChecked();
    await expect(sharingUi.scopeSwitch(page, SWITCH.summary)).toBeChecked();
    await expect(sharingUi.scopeSwitch(page, SWITCH.owner)).not.toBeChecked();
    await sharingUi.scopeSwitch(page, SWITCH.summary).click();
    await sharingUi.createButton(page).click();
    await expect(sharingUi.linkField(page)).toBeVisible();
    await expect
      .poll(async () => (await listShareLinks(owner, ws.id))[0]?.include_summary)
      .toBe(false);

    // With a link each change saves at once.
    await sharingUi.scopeSwitch(page, SWITCH.notes).click();
    await expect
      .poll(async () => (await listShareLinks(owner, ws.id))[0]?.include_notes)
      .toBe(false);
    await page.reload();
    await expect(sharingUi.dialog(page)).toBeVisible();
    await expect(sharingUi.scopeSwitch(page, SWITCH.notes)).not.toBeChecked();
    await expect(sharingUi.scopeSwitch(page, SWITCH.summary)).not.toBeChecked();

    const [current] = await listShareLinks(owner, ws.id);
    if (!current) throw new Error('no link');
    const rotated = await rotateShareLink(owner, ws.id, current.id);
    expect([rotated.include_notes, rotated.include_summary]).toEqual([false, false]);

    const editor = await workspaceFactory.member(`share-ac01e-${randomUUID().slice(0, 6)}`);
    seedMembership(ws.id, editor.user.id, 'editor');
    const refused = await editor.api.request(
      'PATCH',
      `/workspaces/${ws.id}/share-links/${rotated.id}`,
      { include_owner_records: true },
    );
    expect(refused.status).toBe(403);
    expect((await listShareLinks(owner, ws.id))[0]?.include_owner_records).toBe(false);
  },
);

test(
  'UX12-SHARE-AC02 a link without summaries shows no 요약 button and the summary API answers like a missing document',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, `share-ac02-${randomUUID().slice(0, 6)}`, {
      count: 1,
      versions: 0,
    });
    await withSummary(s);
    const link = await createShareLink(s.owner, s.workspaceId);
    const session = await ShareSession.open(link.id, link.secret);
    await openGuest(page, link);
    await expect(summaryButton(page)).toBeVisible();
    expect((await session.get(`/documents/${s.documentId}/summary`)).status).toBe(200);

    await updateShareLink(s.owner, s.workspaceId, link.id, { include_summary: false });
    const off = await session.get(`/documents/${s.documentId}/summary`);
    expect(off.status).toBe(404);
    const missing = await session.get(`/documents/${RANDOM_ID}/summary`);
    expect(stableProblem(off)).toEqual(stableProblem(missing));
    await page.reload();
    await expect(sharedUi.heading(page)).toBeVisible();
    await expect(summaryButton(page)).toHaveCount(0);

    await updateShareLink(s.owner, s.workspaceId, link.id, { include_summary: true });
    await page.reload();
    await expect(summaryButton(page)).toBeVisible();
  },
);

test(
  'UX12-SHARE-AC03 a link without notes shows no 정리 노트 card and the note APIs answer 404',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, `share-ac03-${randomUUID().slice(0, 6)}`, {
      count: 1,
    });
    const link = await createShareLink(s.owner, s.workspaceId);
    const session = await ShareSession.open(link.id, link.secret);
    await openGuest(page, link);
    await expect(noteUi.sharedChapter(noteUi.sharedCard(page), CH1)).toBeVisible();
    expect((await session.get(`/chapters/${s.ch1}/note`)).status).toBe(200);

    await updateShareLink(s.owner, s.workspaceId, link.id, { include_notes: false });
    expect((await session.get('/chapter-notes')).status).toBe(404);
    const off = await session.get(`/chapters/${s.ch1}/note`);
    expect(off.status).toBe(404);
    expect(stableProblem(off)).toEqual(
      stableProblem(await session.get(`/chapters/${RANDOM_ID}/note`)),
    );
    await page.reload();
    await expect(sharedUi.heading(page)).toBeVisible();
    await expect(sharedUi.questions(page)).toBeVisible();
    await expect(noteUi.sharedCard(page)).toHaveCount(0);
  },
);

test(
  'UX12-SHARE-AC04 a link without AI explanations keeps the written explanation and hides the AI one',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, `share-ac04-${randomUUID().slice(0, 6)}`, {
      count: 1,
      versions: 0,
    });
    const [question] = s.questions;
    if (!question) throw new Error('no question');
    await seedExplanation(s.owner, bank(question.id));
    const link = await createShareLink(s.owner, s.workspaceId);
    const session = await ShareSession.open(link.id, link.secret);
    const path = `/questions/${question.id}/ai-explanation`;
    expect((await session.get(path)).status).toBe(200);

    await updateShareLink(s.owner, s.workspaceId, link.id, { include_ai_explanations: false });
    const off = await session.get(path);
    expect(off.status).toBe(404);
    expect(stableProblem(off)).toEqual(
      stableProblem(await session.get(`/questions/${RANDOM_ID}/ai-explanation`)),
    );

    await openGuest(page, link);
    await sharedUi.question(page, question.revision.stem).click();
    const panel = sharedUi.questionPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByText(question.revision.explanation ?? '').first()).toBeVisible();
    await expect(explUi.sharedArea(panel)).toHaveCount(0);
  },
);

test(
  'UX12-SHARE-AC05 a fork copies only what the link includes and never the owner records',
  { tag: '@infra' },
  async ({ workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, `share-ac05-${randomUUID().slice(0, 6)}`, {
      count: 1,
    });
    await withSummary(s);
    const [question] = s.questions;
    if (!question) throw new Error('no question');
    await seedExplanation(s.owner, bank(question.id));
    await highlightExplanation(s.owner, question, quoteOf(question), 'yellow');
    seedGradedAttempt(s.workspaceId, question.id, question.revision.id, s.owner.user.id);
    const recipient = await workspaceFactory.member(`share-ac05r-${randomUUID().slice(0, 6)}`);

    async function forkOf(scope: Parameters<typeof createShareLink>[2]): Promise<string> {
      const link = await createShareLink(s.owner, s.workspaceId, { allow_fork: true, ...scope });
      const session = await ShareSession.open(link.id, link.secret);
      const started = await startFork(recipient, session, `share-ac05-${randomUUID().slice(0, 6)}`);
      const done = await waitForFork(recipient, started.id, 'COMPLETED');
      if (!done.target_workspace_id) throw new Error('no target workspace');
      return done.target_workspace_id;
    }

    const full = await forkOf({ include_owner_records: true });
    expect(forkedContentCounts(full)).toEqual({
      summaries: 1,
      notes: 1,
      ai_explanations: 1,
      attempts: 0,
      highlights: 0,
    });
    const scoped = await forkOf({
      include_notes: false,
      include_ai_explanations: false,
      include_summary: false,
    });
    expect(forkedContentCounts(scoped)).toEqual({
      summaries: 0,
      notes: 0,
      ai_explanations: 0,
      attempts: 0,
      highlights: 0,
    });
  },
);

async function withRecords(s: NoteSetup, other: Member): Promise<void> {
  const [question] = s.questions;
  if (!question) throw new Error('no question');
  seedMembership(s.workspaceId, other.user.id, 'editor');
  await highlightExplanation(s.owner, question, quoteOf(question), 'blue');
  await highlightNote(s.owner, s.note, 0, 0, itemText(s.note, 0, 0).slice(0, 6), 'pink');
  seedGradedAttempt(s.workspaceId, question.id, question.revision.id, s.owner.user.id);
  seedGradedAttempt(s.workspaceId, question.id, question.revision.id, other.user.id);
  await highlightExplanation(other, question, quoteOf(question).slice(0, 3), 'yellow');
}

test(
  'UX12-SHARE-AC06 with the option off the records card is absent and both record APIs answer 404',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, `share-ac06-${randomUUID().slice(0, 6)}`, {
      count: 1,
    });
    const other = await workspaceFactory.member(`share-ac06o-${randomUUID().slice(0, 6)}`);
    await withRecords(s, other);
    const link = await createShareLink(s.owner, s.workspaceId);
    expect(link.include_owner_records).toBe(false);
    const session = await ShareSession.open(link.id, link.secret);
    const missing = await session.get(`/questions/${RANDOM_ID}`);
    for (const path of ['/owner-attempts', '/owner-highlights']) {
      const res = await session.get(path);
      expect(res.status, path).toBe(404);
      expect(stableProblem(res), path).toEqual(stableProblem(missing));
    }
    await openGuest(page, link);
    await expect(sharedUi.questions(page)).toBeVisible();
    await expect(sharedUi.ownerRecords(page)).toHaveCount(0);
    await expect(sharedUi.personalData(page)).toHaveCount(0);
  },
);

test(
  'UX12-SHARE-AC07 with the option on a guest reads only the owner records, without identity or any write',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, `share-ac07-${randomUUID().slice(0, 6)}`, {
      count: 1,
    });
    const other = await workspaceFactory.member(`share-ac07o-${randomUUID().slice(0, 6)}`);
    await withRecords(s, other);
    const [question] = s.questions;
    if (!question) throw new Error('no question');
    const link = await createShareLink(s.owner, s.workspaceId, { include_owner_records: true });
    const session = await ShareSession.open(link.id, link.secret);

    const attempts = await session.get<{ items: Record<string, unknown>[] }>('/owner-attempts');
    expect(attempts.status).toBe(200);
    expect(attempts.body?.items).toHaveLength(1);
    expect(Object.keys(attempts.body?.items[0] ?? {}).sort()).toEqual([
      'id',
      'question',
      'question_type',
      'result',
      'submitted_at',
    ]);
    const highlights = await session.get<{ items: { quote: string }[] }>('/owner-highlights');
    expect(highlights.status).toBe(200);
    expect(highlights.body?.items).toHaveLength(2);
    for (const res of [attempts, highlights]) {
      expect(res.text.includes(s.owner.user.id), 'no owner id').toBe(false);
      expect(res.text.includes(s.owner.user.email), 'no owner email').toBe(false);
      expect(res.text.includes(other.user.id), 'no other member').toBe(false);
    }

    // Read only: the session writes nothing on any member route.
    const writes = [
      rawApi('POST', '/my-highlights', {
        cookie: session.cookie,
        body: { target: { kind: 'explanation', question_id: question.id } },
      }),
      rawApi('PUT', `/questions/${question.id}/my-state`, {
        cookie: session.cookie,
        body: { is_favorite: true },
      }),
    ];
    for (const res of await Promise.all(writes)) expect([401, 404, 405]).toContain(res.status);

    await openGuest(page, link);
    await sharedUi
      .ownerRecords(page)
      .getByRole('button', { name: /기록 보기/ })
      .click();
    const panel = sharedUi.ownerRecordsPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('region', { name: '풀이 이력' }).getByText('정답')).toBeVisible();
    await expect(
      panel
        .getByRole('region', { name: '하이라이트' })
        .getByText(quoteOf(question), { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText(s.owner.user.email)).toHaveCount(0);
    await expect(sharedUi.forbiddenControls(page)).toHaveCount(0);

    // A row opens the published question, still read only.
    await panel.getByRole('region', { name: '풀이 이력' }).getByRole('button').first().click();
    await expect(sharedUi.questionPanel(page)).toBeVisible();
  },
);

test(
  'UX12-SHARE-AC08 records outside the share stay hidden and the owner notice says what is public',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteSetup(workspaceFactory, `share-ac08-${randomUUID().slice(0, 6)}`, {
      count: 2,
    });
    const other = await workspaceFactory.member(`share-ac08o-${randomUUID().slice(0, 6)}`);
    await withRecords(s, other);
    const [, second] = s.questions;
    if (!second) throw new Error('no second question');
    const link = await createShareLink(s.owner, s.workspaceId, { include_owner_records: true });
    const session = await ShareSession.open(link.id, link.secret);
    const kinds = async () =>
      (await session.ok<{ items: { kind: string }[] }>('/owner-highlights')).items.map(
        (i) => i.kind,
      );
    expect((await kinds()).sort()).toEqual(['explanation', 'note']);

    // Notes left out: their highlights go with them.
    await updateShareLink(s.owner, s.workspaceId, link.id, { include_notes: false });
    expect(await kinds()).toEqual(['explanation']);
    await updateShareLink(s.owner, s.workspaceId, link.id, { include_notes: true });

    // A question that leaves the share takes its attempts and highlights along.
    await highlightExplanation(s.owner, second, quoteOf(second), 'yellow');
    seedGradedAttempt(s.workspaceId, second.id, second.revision.id, s.owner.user.id);
    const attemptCount = async () =>
      (await session.ok<{ items: unknown[] }>('/owner-attempts')).items.length;
    expect(await attemptCount()).toBe(2);
    await s.owner.api.ok('DELETE', `/questions/${second.id}`, undefined, [200, 204]);
    expect(await attemptCount()).toBe(1);
    // The note cited that question: it no longer matches its sources, so its highlight goes too.
    expect(await kinds()).toEqual(['explanation']);

    // The owner's notice follows the option.
    await signInAs(page, s.owner.user);
    await page.goto(`${overviewPath(s.workspaceId)}?panel=share`);
    await expect(sharingUi.dialog(page)).toBeVisible();
    await expect(sharingUi.scopeNotice(page)).toContainText(/내 풀이 이력·하이라이트/);
    await sharingUi.scopeSwitch(page, SWITCH.owner).click();
    await expect(sharingUi.scopeNotice(page)).toContainText(/개인 풀이 기록·즐겨찾기는 공개되지/);
    expect((await session.get('/owner-attempts')).status).toBe(404);
  },
);
