// DOC-02 — PDF 열람·원문 교정 (`/workspaces/:workspaceId/documents/:documentId`),
// docs/screens/documents-editor.md; revision/index flow docs/architecture.md §4.
//
// Each test uploads the synthetic `book-ko.pdf` into its own workspace through the public upload
// flow and waits for the parse/index job (expect.poll on GET /jobs/{id}). Block texts, sections
// and pages come from tests/fixtures/pdfs/book-ko.truth.json. Search assertions call the public
// search API as the owner (published-revision filter is enforced server-side, architecture §4).
// The shared-link Viewer half of AC05 is covered by WS-VIEW-01 (S0).
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';
import {
  block,
  book,
  DRAFT_SAVED,
  editorUi,
  expect,
  INDEX_FAILED,
  INDEX_FAILURE_MARKER,
  JOB_TIMEOUT_MS,
  PROBLEM_TYPES,
  PUBLISHED,
  search,
  section,
  seedMembership,
  sha256,
  signInAs,
  snippet,
  test,
  uploadReadyBook,
  type Member,
  type Problem,
  type SearchItem,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 60_000 });

const BOOK = book('book-ko');
const RAIN = block(BOOK, 'ch1-s2-p1'); // page 2, unchanged by the edits below
const CHLORINE = block(BOOK, 'ch2-s2-p2'); // page 4: "마지막으로 염소와 같은 소독제를 넣어 …"
const OLD_PHRASE = '염소와 같은 소독제';

function documentPath(workspaceId: string, documentId: string): string {
  return `/workspaces/${workspaceId}/documents/${documentId}`;
}

/** Keyword hits of `query` that belong to `documentId`. */
async function hits(owner: Member, workspaceId: string, documentId: string, query: string) {
  const items = await search(owner, workspaceId, { query, mode: 'keyword' });
  return items.filter((item: SearchItem) => item.document_id === documentId);
}

/** Opens the block containing `original`, replaces its text and saves a draft. */
async function editBlock(page: Page, original: string, replacement: string): Promise<void> {
  const target = editorUi.block(page, snippet(original));
  await editorUi.editButton(target).click();
  await editorUi.blockTextbox(page).fill(replacement);
  await editorUi.saveButton(page).click();
  await expect(editorUi.revisionStatus(page)).toContainText(DRAFT_SAVED);
}

async function setup(page: Page, workspaceFactory: WorkspaceFactory, label: string) {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  await signInAs(page, owner.user);
  await page.goto(documentPath(ws.id, documentId));
  return { owner, workspaceId: ws.id, documentId };
}

test(
  'DOC-02-AC01 choosing a chapter or section in the outline moves the PDF page and the text block',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await setup(page, workspaceFactory, 'doc02-ac01');

    for (const [sectionId, firstBlockId] of [
      ['ch2-s2', 'ch2-s2-p1'],
      ['ch1-s2', 'ch1-s2-p1'],
      ['ch2', 'ch2-p1'],
    ] as const) {
      const target = section(BOOK, sectionId);
      await editorUi.outlineItem(page, target.title).click();
      await expect(editorUi.currentPage(page), target.title).toHaveValue(String(target.page));
      await expect(editorUi.highlight(page), target.title).toBeVisible();
      await expect(editorUi.currentBlock(page), target.title).toContainText(
        snippet(block(BOOK, firstBlockId).text),
      );
    }
  },
);

test(
  'DOC-02-AC02 saving a corrected block creates a new draft revision and leaves the PDF untouched',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, documentId } = await setup(page, workspaceFactory, 'doc02-ac02');
    const token = `교정표지${randomUUID().slice(0, 8)}`;
    const corrected = `${RAIN.text} ${token}`;

    await editBlock(page, RAIN.text, corrected);

    // Reload: the draft persists, the original PDF bytes are served unchanged.
    const pdf = page.waitForResponse(
      (res) => res.status() === 200 && /application\/pdf/.test(res.headers()['content-type'] ?? ''),
    );
    await page.reload();
    expect(sha256(await (await pdf).body()), 'PDF bytes after the edit').toBe(BOOK.sha256);
    await expect(editorUi.textPanel(page)).toContainText(token);
    await expect(editorUi.revisionStatus(page)).toContainText(/초안|draft/i);

    // A draft is not searchable: the published revision still answers with the old text.
    expect(await hits(owner, workspaceId, documentId, token)).toEqual([]);
    expect(
      (await hits(owner, workspaceId, documentId, snippet(RAIN.text, 12))).length,
    ).toBeGreaterThan(0);
  },
);

test(
  'DOC-02-AC03 publishing a draft reindexes it and search serves only the new published revision',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, documentId } = await setup(page, workspaceFactory, 'doc02-ac03');
    const before = await hits(owner, workspaceId, documentId, OLD_PHRASE);
    expect(before.length, 'old phrase is indexed before the edit').toBeGreaterThan(0);
    const oldRevision = before[0]?.revision_id;

    const token = `소독어휘${randomUUID().slice(0, 8)}`;
    await editBlock(page, CHLORINE.text, `마지막으로 ${token} 처리를 하여 남은 미생물을 줄인다.`);
    await editorUi.publishButton(page).click();
    await expect(editorUi.revisionStatus(page)).toContainText(PUBLISHED, {
      timeout: JOB_TIMEOUT_MS,
    });

    await expect
      .poll(async () => (await hits(owner, workspaceId, documentId, token)).length, {
        timeout: JOB_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    const fresh = await hits(owner, workspaceId, documentId, token);
    expect(fresh[0]?.page).toBe(CHLORINE.parts[0]?.page);
    const newRevision = fresh[0]?.revision_id;
    expect(newRevision).toBeTruthy();
    expect(newRevision).not.toBe(oldRevision);

    // The stale revision is gone from search, also for unchanged blocks.
    const stale = await hits(owner, workspaceId, documentId, OLD_PHRASE);
    expect(stale.filter((h) => h.text.includes(OLD_PHRASE))).toEqual([]);
    const unchanged = await hits(owner, workspaceId, documentId, snippet(RAIN.text, 12));
    expect(unchanged.length).toBeGreaterThan(0);
    expect(new Set(unchanged.map((h) => h.revision_id))).toEqual(new Set([newRevision]));
  },
);

test(
  'DOC-02-AC04 a failed reindex keeps the previous published revision searchable and offers retry',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, documentId } = await setup(page, workspaceFactory, 'doc02-ac04');
    const before = await hits(owner, workspaceId, documentId, OLD_PHRASE);
    expect(before.length).toBeGreaterThan(0);
    const oldRevision = before[0]?.revision_id;

    // INDEX_FAILURE_MARKER makes the E2E fake embedder fail this reindex (fixtures/documents.ts).
    await editBlock(page, CHLORINE.text, `${INDEX_FAILURE_MARKER} 교정된 문단`);
    await editorUi.publishButton(page).click();

    await expect(page.getByRole('alert').filter({ hasText: INDEX_FAILED })).toBeVisible({
      timeout: JOB_TIMEOUT_MS,
    });
    await expect(editorUi.retryIndexButton(page)).toBeEnabled();

    const after = await hits(owner, workspaceId, documentId, OLD_PHRASE);
    expect(after.length, 'previous published revision still searchable').toBeGreaterThan(0);
    expect(new Set(after.map((h) => h.revision_id))).toEqual(new Set([oldRevision]));
    expect(await hits(owner, workspaceId, documentId, INDEX_FAILURE_MARKER)).toEqual([]);
  },
);

test(
  'DOC-02-AC05 a read-only member sees no editing UI and the write APIs refuse them',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc02-ac05-owner');
    const viewer = await workspaceFactory.member('doc02-ac05-viewer');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const [anyHit] = await hits(owner, ws.id, documentId, snippet(RAIN.text, 12));
    expect(anyHit?.block_id).toBeTruthy();
    // DB seed (fixtures/db.ts): no public membership API exists in M3 (MVP is owner-only), and
    // the AC is about the server refusing a viewer role.
    seedMembership(ws.id, viewer.user.id, 'viewer');

    await signInAs(page, viewer.user);
    await page.goto(documentPath(ws.id, documentId));
    await expect(editorUi.viewer(page)).toBeVisible();
    await expect(editorUi.textPanel(page)).toContainText(snippet(RAIN.text));
    await expect(editorUi.editButton(editorUi.textPanel(page))).toHaveCount(0);
    await expect(editorUi.publishButton(page)).toHaveCount(0);

    const patch = await viewer.api.request(
      'PATCH',
      `/documents/${documentId}/blocks/${anyHit?.block_id}`,
      { text: 'viewer edit' },
    );
    expect(patch.status).toBe(403);
    expect((patch.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
    const publish = await viewer.api.request('POST', `/documents/${documentId}/publish`, {});
    expect(publish.status).toBe(403);
    expect((publish.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
  },
);

test(
  'DOC-02-AC05 an archived workspace is read-only for its owner in the editor and the API',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc02-ac05-archived');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const [anyHit] = await hits(owner, ws.id, documentId, snippet(RAIN.text, 12));
    expect(anyHit?.block_id).toBeTruthy();
    await workspaceFactory.archive(owner, ws.id);

    await signInAs(page, owner.user);
    await page.goto(documentPath(ws.id, documentId));
    await expect(editorUi.viewer(page)).toBeVisible();
    await expect(editorUi.textPanel(page)).toContainText(snippet(RAIN.text));
    await expect(editorUi.editButton(editorUi.textPanel(page))).toHaveCount(0);
    await expect(editorUi.publishButton(page)).toHaveCount(0);

    const patch = await owner.api.request(
      'PATCH',
      `/documents/${documentId}/blocks/${anyHit?.block_id}`,
      { text: 'archived edit' },
    );
    expect(patch.status).toBe(403);
    expect((patch.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    const publish = await owner.api.request('POST', `/documents/${documentId}/publish`, {});
    expect(publish.status).toBe(403);
    expect((publish.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
  },
);
