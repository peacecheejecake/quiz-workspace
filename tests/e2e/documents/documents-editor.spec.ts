// DOC-02 — PDF 열람·원문 교정 (`/workspaces/:workspaceId/documents/:documentId`),
// docs/screens/documents-editor.md; revision/index flow docs/architecture.md §4.
//
// Each test uploads the synthetic `book-ko.pdf` into its own workspace through the public upload
// flow and waits for the parse/index job (expect.poll on GET /jobs/{id}). Block texts, sections
// and pages come from tests/fixtures/pdfs/book-ko.truth.json. Search assertions call the public
// search API as the owner (published-revision filter is enforced server-side, architecture §4).
// The shared-link Viewer half of AC05 is covered by WS-VIEW-01 (S0).
import { randomUUID } from 'node:crypto';
import type { Locator, Page, Request } from '@playwright/test';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';
import {
  block,
  book,
  draftFor,
  DRAFT_SAVED,
  editorUi,
  expect,
  INDEX_FAILED,
  importPaperDrafts,
  INDEX_FAILURE_MARKER,
  JOB_TIMEOUT_MS,
  PROBLEM_TYPES,
  publishDrafts,
  PUBLISHED,
  questionPaper,
  search,
  section,
  seedMembership,
  sha256,
  signInAs,
  snippet,
  test,
  truthQuestion,
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

// --- DOCVIEW (user feedback 2026-11-01): outline panel, paging, sync, page groups, splitter,
// question format. book-ko: page 1 = title + TOC (no blocks), blocks start on pages 2 and 4, and
// ch1-s2-p3 continues from page 2 onto page 3.

const LAST_BODY_BLOCK = block(BOOK, 'ch1-s2-p3'); // pages 2 → 3

/** True once the canvas holds a drawn page (some non-white pixels), not just a placeholder. */
async function painted(canvas: Locator): Promise<boolean> {
  return canvas
    .evaluate((el) => {
      if (!(el instanceof HTMLCanvasElement) || el.width === 0 || el.height === 0) return false;
      const ctx = el.getContext('2d');
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, el.width, el.height);
      for (let i = 0; i < data.length; i += 4 * 97) {
        if ((data[i] ?? 255) < 200 || (data[i + 1] ?? 255) < 200 || (data[i + 2] ?? 255) < 200) {
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

async function expectPainted(page: Page, n: number, timeout = 10_000): Promise<void> {
  await expect
    .poll(() => painted(editorUi.pdfPage(page, n)), { message: `PDF page ${n} drawn`, timeout })
    .toBe(true);
}

/** Wheel-scrolls the PDF pages until the viewer reports page `n` as the current page. */
async function scrollPdfTo(page: Page, n: number): Promise<void> {
  await editorUi.pdfPages(page).hover();
  await expect(async () => {
    const current = Number(await editorUi.currentPage(page).inputValue());
    await page.mouse.wheel(0, current < n ? 300 : -300);
    await expect(editorUi.currentPage(page)).toHaveValue(String(n), { timeout: 300 });
  }).toPass({ timeout: 20_000 });
}

test(
  'DOC-02-AC06 the outline is a floating panel that folds away and remembers its state',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await setup(page, workspaceFactory, 'doc02-ac06');
    const toggle = editorUi.outlineToggle(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(editorUi.outlinePanel(page)).toBeVisible();
    await expect(editorUi.outlinePanel(page).getByRole('tree')).toBeVisible();
    const openWidth = (await editorUi.viewer(page).boundingBox())?.width ?? 0;

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(editorUi.outline(page)).toBeHidden();
    await expect
      .poll(async () => (await editorUi.viewer(page).boundingBox())?.width ?? 0)
      .toBeGreaterThan(openWidth + 100);

    await page.reload();
    await expect(editorUi.outlineToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(editorUi.outline(page)).toBeHidden();

    await editorUi.outlineToggle(page).click();
    await expect(editorUi.outlineToggle(page)).toHaveAttribute('aria-expanded', 'true');
    const target = section(BOOK, 'ch2-s2');
    await editorUi.outlineItem(page, target.title).click();
    await expect(editorUi.currentPage(page)).toHaveValue(String(target.page));
    await expect(editorUi.currentBlock(page)).toContainText(snippet(block(BOOK, 'ch2-s2-p1').text));
    await page.reload();
    await expect(editorUi.outlineToggle(page)).toHaveAttribute('aria-expanded', 'true');
  },
);

test(
  'DOC-02-AC07 page turns draw from the PDF already in memory, the next page is pre-drawn and no request is sent',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await setup(page, workspaceFactory, 'doc02-ac07');
    await expectPainted(page, 1);
    await page.waitForLoadState('networkidle');
    // Neighbour prefetch: page 2 is drawn before anyone asks for it.
    await expectPainted(page, 2);

    const requests: string[] = [];
    const onRequest = (request: Request) => {
      if (request.headers()['next-router-prefetch'] === '1') return; // Next <Link> prefetch
      requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    };
    page.on('request', onRequest);

    const turn = async (go: () => Promise<void>, n: number) => {
      const started = Date.now();
      await go();
      await expect(editorUi.currentPage(page)).toHaveValue(String(n));
      await expectPainted(page, n, 1_000);
      expect(Date.now() - started, `page ${n} drawn within 1 s`).toBeLessThan(1_000);
    };
    const next = editorUi.viewer(page).getByRole('button', { name: /다음 페이지|next page/i });
    const previous = editorUi
      .viewer(page)
      .getByRole('button', { name: /이전 페이지|previous page/i });
    await turn(() => next.click(), 2);
    await turn(() => next.click(), 3);
    await turn(async () => {
      await editorUi.currentPage(page).fill('1');
      await editorUi.currentPage(page).press('Enter');
    }, 1);
    await turn(async () => {
      await editorUi.currentPage(page).fill('4');
      await editorUi.currentPage(page).press('Enter');
    }, 4);
    await turn(() => previous.click(), 3);

    page.off('request', onRequest);
    expect(requests, 'no network request while turning pages').toEqual([]);
  },
);

test(
  'DOC-02-AC08 scrolling or turning PDF pages scrolls the text pane to that page, except while editing',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await setup(page, workspaceFactory, 'doc02-ac08');
    await expectPainted(page, 1);
    await expect(editorUi.pageHeading(page, 2)).toBeVisible();

    await scrollPdfTo(page, 4);
    await expect(editorUi.pageHeading(page, 4)).toBeInViewport();
    await expect(editorUi.pageHeading(page, 2)).not.toBeInViewport();

    const previous = editorUi
      .viewer(page)
      .getByRole('button', { name: /이전 페이지|previous page/i });
    await previous.click();
    await expect(editorUi.currentPage(page)).toHaveValue('3');
    // No block starts on page 3: the block that continues onto it is shown.
    await expect(editorUi.block(page, snippet(LAST_BODY_BLOCK.text))).toBeInViewport();

    await scrollPdfTo(page, 2);
    await expect(editorUi.pageHeading(page, 2)).toBeInViewport();

    // While a block is being edited the text pane stays where it is.
    await editorUi.editButton(editorUi.block(page, snippet(RAIN.text))).click();
    await expect(editorUi.blockTextbox(page)).toBeInViewport();
    await scrollPdfTo(page, 4);
    await expect(editorUi.blockTextbox(page)).toBeInViewport();
    await expect(editorUi.pageHeading(page, 4)).not.toBeInViewport();
  },
);

test(
  'DOC-02-AC09 the text pane groups blocks by the page they start on',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await setup(page, workspaceFactory, 'doc02-ac09');
    const starts = new Map<number, string[]>();
    for (const b of BOOK.blocks) {
      if (b.type === 'image' || !b.text) continue;
      const first = b.parts[0]?.page ?? 0;
      starts.set(first, [...(starts.get(first) ?? []), b.text]);
    }
    const headings = editorUi.textPanel(page).getByRole('heading', { name: /^\d+쪽$|^page \d+$/i });
    await expect(headings).toHaveText(
      [...starts.keys()].sort((a, b) => a - b).map((n) => `${n}쪽`),
    );
    for (const [n, texts] of starts) {
      const group = editorUi.pageGroup(page, n);
      for (const text of texts) await expect(group).toContainText(snippet(text));
      for (const [other, otherTexts] of starts) {
        if (other === n) continue;
        await expect(group).not.toContainText(snippet(otherTexts[0] ?? ''));
      }
    }

    const target = section(BOOK, 'ch2-s2');
    await editorUi.outlineItem(page, target.title).click();
    await expect(editorUi.pageHeading(page, target.page)).toHaveAttribute('aria-current', 'page');
    await expect(editorUi.pageHeading(page, 2)).not.toHaveAttribute('aria-current', 'page');
  },
);

test(
  'DOC-02-AC10 a separator resizes the PDF and text panes by pointer and keyboard and keeps the ratio',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await setup(page, workspaceFactory, 'doc02-ac10');
    const splitter = editorUi.splitter(page);
    await expect(splitter).toBeVisible();
    await expect(splitter).toHaveAttribute('aria-orientation', 'vertical');
    await expect(splitter).toHaveAttribute('aria-valuemin', '25');
    await expect(splitter).toHaveAttribute('aria-valuemax', '75');
    const value = async () => Number(await splitter.getAttribute('aria-valuenow'));
    const pdfWidth = async () => (await editorUi.viewer(page).boundingBox())?.width ?? 0;
    const start = await value();
    const startWidth = await pdfWidth();

    await splitter.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(value).toBe(start - 5);
    await expect.poll(pdfWidth).toBeLessThan(startWidth - 20);
    await page.keyboard.press('End');
    await expect.poll(value).toBe(75);
    await page.keyboard.press('Home');
    await expect.poll(value).toBe(25);

    // Pointer drag to the right widens the PDF pane.
    const box = await splitter.boundingBox();
    if (!box) throw new Error('separator has no box');
    const before = await pdfWidth();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(pdfWidth).toBeGreaterThan(before + 150);
    const dragged = await value();
    expect(dragged).toBeGreaterThan(25);
    expect(dragged).toBeLessThanOrEqual(75);

    await page.reload();
    await expect(editorUi.splitter(page)).toHaveAttribute('aria-valuenow', String(dragged));

    // Phones keep the PDF / 원문 view switch and have no separator.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(editorUi.splitter(page)).toBeHidden();
  },
);

test(
  'DOC-02-AC11 confirmed imported questions show in question format with the answer folded away',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc02-ac11');
    const ws = await workspaceFactory.create(owner);
    const { run, drafts } = await importPaperDrafts(owner, ws.id);
    const paper = questionPaper();
    const [q1, q2, q3] = [1, 2, 3].map((n) => truthQuestion(paper, n));
    if (!q1 || !q2 || !q3) throw new Error('questions-ko truth');
    await publishDrafts(owner, run.id, [draftFor(drafts, q1).id, draftFor(drafts, q2).id]);
    const documentId = run.source_document_id;
    expect(documentId, 'import run source document').toBeTruthy();

    await signInAs(page, owner.user);
    await page.goto(documentPath(ws.id, documentId ?? ''));

    const card = editorUi.questionCard(page, 1);
    await expect(card).toBeVisible();
    await expect(card).toContainText(q1.stem);
    const options = card.getByRole('list', { name: /보기|options/i }).getByRole('listitem');
    await expect(options).toHaveCount(q1.options.length);
    for (const [i, option] of q1.options.entries()) {
      await expect(options.nth(i)).toContainText(option.text);
    }
    // The stem is not shown a second time as a raw block.
    await expect(editorUi.block(page, snippet(q1.stem, 16))).toHaveCount(0);

    // Answer folded away until asked for.
    const answer = card.getByText(/정답\s*[:：]?\s*②|answer\s*[:：]?\s*②/i);
    await expect(answer).toBeHidden();
    const reveal = editorUi.answerToggle(card);
    await expect(reveal).toHaveAttribute('aria-expanded', 'false');
    await reveal.click();
    await expect(reveal).toHaveAttribute('aria-expanded', 'true');
    await expect(answer).toBeVisible();

    // The source blocks stay reachable (and correctable) from the card.
    await editorUi.sourceBlocksToggle(card).click();
    await expect(card.getByRole('article').first()).toBeVisible();
    await expect(editorUi.editButton(card).first()).toBeVisible();

    await expect(editorUi.questionCard(page, 2)).toContainText(q2.stem);
    // Not confirmed: question 3 stays raw text.
    await expect(editorUi.questionCard(page, 3)).toHaveCount(0);
    await expect(editorUi.block(page, snippet(q3.stem, 16))).toBeVisible();
  },
);
