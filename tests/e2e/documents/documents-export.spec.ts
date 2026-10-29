// DOC-03 — 문서 전문 텍스트 내보내기 (DOC-01 row menu in the "문서 관리" dialog and the DOC-02 header
// menu), docs/screens/documents-text-export.md. Contract half (C01-C03):
// tests/integration/documents/test_document_text_export.py.
//
// Each test uploads the synthetic `book-ko.pdf` into its own workspace through the public upload
// flow and waits for the parse/index job. Expected lines (headings, the GFM table, the figure
// placeholder, page markers) come from tests/fixtures/pdfs/book-ko.truth.json: chapters on pages
// 2 and 4, sections 1.1-2.2, a figure on page 2 and a table on page 4; page 1 (the table of
// contents) has no canonical block. Request shape and UI contract assumptions D1-D6:
// tests/e2e/fixtures/export.ts.
//
// Exported book text must not reach a Playwright artifact (AC03): traces, screenshots and videos
// are off for this spec and file contents are only checked with boolean assertions. The sharing
// `test` is used for its share-link cleanup and secret hygiene (AC03 opens a share link).
import type { Browser, Locator, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  BOOK_KO_EXPORT as K,
  captureClipboard,
  copiedTexts,
  DOCUMENT_NOT_READY,
  download,
  exportUi,
  expectExportStatus,
  attachmentFilename,
  linesOf,
  NO_BODY_ARTIFACTS,
  previousNonBlank,
  requestExport,
  type DownloadedFile,
} from '../fixtures/export.ts';
import {
  createShareLink,
  openShareWithSecret,
  sharedUi,
  ShareSession,
  test,
  expect,
} from '../fixtures/sharing.ts';
import {
  block,
  book,
  docUi,
  documentsPath,
  editorUi,
  holdDocumentProcessing,
  homeUi,
  JOB_TIMEOUT_MS,
  listDocuments,
  PROBLEM_TYPES,
  seedMembership,
  signInAs,
  snippet,
  uploadReadyBook,
  type Member,
} from '../fixtures/test.ts';

// No page text attached on failure (the sharing fixture's default); assertions on shown text are
// boolean polls so a failure message never quotes document text.
test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_BODY_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 90_000 });

const BOOK = book('book-ko');
const RAIN = block(BOOK, 'ch1-s2-p1'); // page 2, corrected in AC02

interface ApiBlock {
  readonly type: string;
  readonly text: string;
}

function documentPath(workspaceId: string, documentId: string): string {
  return `/workspaces/${workspaceId}/documents/${documentId}`;
}

function escapeRegExp(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

async function titleOf(member: Member, workspaceId: string, documentId: string): Promise<string> {
  const doc = (await listDocuments(member, workspaceId)).find((d) => d.id === documentId);
  if (!doc?.title) throw new Error('uploaded document has no title');
  return doc.title;
}

/** Heading/text blocks of the published revision in the order the DOC-02 원문 pane shows them. */
async function paneBlocks(member: Member, documentId: string): Promise<ApiBlock[]> {
  const body = await member.api.ok<{ items: ApiBlock[] }>(
    'GET',
    `/documents/${documentId}/blocks?limit=500`,
    undefined,
    [200],
  );
  return body.items.filter((b) => (b.type === 'heading' || b.type === 'text') && b.text.trim());
}

/** True when every block's leading words appear in `text`, in the pane's order. */
function inPaneOrder(text: string, blocks: readonly ApiBlock[]): boolean {
  let at = -1;
  for (const b of blocks) {
    const next = text.indexOf(snippet(b.text, 20), at + 1);
    if (next <= at) return false;
    at = next;
  }
  return true;
}

/** Polls until `scope` shows `text`; on failure only `message` is printed, never the text. */
async function expectShown(scope: Locator, text: string, message: string): Promise<void> {
  await expect
    .poll(async () => (await scope.innerText().catch(() => '')).includes(text), { message })
    .toBe(true);
}

function lineIndex(lines: readonly string[], line: string): number {
  return lines.indexOf(line);
}

function cleanUtf8(file: DownloadedFile): boolean {
  return !(file.bytes[0] === 0xef && file.bytes[1] === 0xbb) && !file.text.includes('\r');
}

/** Opens a menu button with the keyboard (Enter); the first item takes focus. */
async function openWithKeyboard(page: Page, button: Locator): Promise<void> {
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(exportUi.menu(page)).toBeVisible();
}

async function newGuestPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  return context.newPage();
}

test(
  'DOC-03-AC01 a viewer exports Markdown and text from the 문서 관리 row by keyboard, deterministically',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc03-ac01-owner');
    const viewer = await workspaceFactory.member('doc03-ac01-viewer');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    seedMembership(ws.id, viewer.user.id, 'viewer');
    const title = await titleOf(owner, ws.id, documentId);
    const blocks = await paneBlocks(owner, documentId);

    await signInAs(page, viewer.user);
    await page.goto(documentsPath(ws.id));
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    const row = docUi.item(page, escapeRegExp(title));
    await expect(docUi.ready(row)).toBeVisible();
    const button = exportUi.rowButton(row);
    await expect(button).toHaveAccessibleName(escapeRegExp(title));

    // Markdown: open with Enter (first item focused), choose with Enter.
    await openWithKeyboard(page, button);
    await expect(exportUi.item(page, 'md')).toBeFocused();
    const md = await download(page, () => page.keyboard.press('Enter'));
    expect(md.name, 'Markdown file name').toBe(`${title}.md`);
    expect(cleanUtf8(md), 'UTF-8 without BOM, LF line endings').toBe(true);
    const mdLines = linesOf(md.text);
    expect(mdLines[0] === `# ${title}`, 'the document title is the `#` heading').toBe(true);
    for (const heading of [`## ${K.chapter1}`, `### ${K.section11}`, `## ${K.chapter2}`]) {
      expect(mdLines.includes(heading), `outline heading "${heading}"`).toBe(true);
    }
    const header = lineIndex(mdLines, `| ${K.tableHeader.join(' | ')} |`);
    expect(header >= 0, 'GFM table header row').toBe(true);
    expect(/^\|(\s*:?-{3,}:?\s*\|){3}$/.test(mdLines[header + 1] ?? ''), 'GFM delimiter row').toBe(
      true,
    );
    expect(mdLines[header + 2] === `| ${K.tableFirstRow.join(' | ')} |`, 'GFM body row').toBe(true);
    expect(mdLines.includes(K.figure), 'figure placeholder [그림 p.2]').toBe(true);
    expect(
      previousNonBlank(mdLines, lineIndex(mdLines, `## ${K.chapter1}`)) === '<!-- p.2 -->',
      'page 2 marker right before its first block',
    ).toBe(true);
    expect(
      previousNonBlank(mdLines, lineIndex(mdLines, `## ${K.chapter2}`)) === '<!-- p.4 -->',
      'page 4 marker right before its first block',
    ).toBe(true);
    expect(inPaneOrder(md.text, blocks), 'Markdown blocks in the DOC-02 원문 order').toBe(true);

    // Text: ArrowDown to the second item.
    await openWithKeyboard(page, button);
    await page.keyboard.press('ArrowDown');
    await expect(exportUi.item(page, 'txt')).toBeFocused();
    const txt = await download(page, () => page.keyboard.press('Enter'));
    expect(txt.name, 'text file name').toBe(`${title}.txt`);
    expect(cleanUtf8(txt), 'UTF-8 without BOM, LF line endings').toBe(true);
    const txtLines = linesOf(txt.text);
    expect(txtLines.includes(K.chapter1) && txtLines.includes(K.section21), 'heading lines').toBe(
      true,
    );
    expect(txtLines.includes(K.tableHeader.join('\t')), 'table row with tab-separated cells').toBe(
      true,
    );
    expect(txtLines.includes(K.figure), 'figure placeholder').toBe(true);
    expect(
      previousNonBlank(txtLines, lineIndex(txtLines, K.chapter1)) === '[p.2]' &&
        previousNonBlank(txtLines, lineIndex(txtLines, K.chapter2)) === '[p.4]',
      '[p.N] page lines before the first block of each page',
    ).toBe(true);
    expect(/<!--|^#|^\|/m.test(txt.text), 'no Markdown syntax in the text file').toBe(false);
    expect(inPaneOrder(txt.text, blocks), 'text blocks in the DOC-02 원문 order').toBe(true);

    // The same format again: the same bytes.
    await openWithKeyboard(page, button);
    const again = await download(page, () => page.keyboard.press('Enter'));
    expect(again.bytes.equals(md.bytes), 'a repeated Markdown export is identical').toBe(true);

    // Escape closes the menu and returns focus to the menu button.
    await openWithKeyboard(page, button);
    await page.keyboard.press('Escape');
    await expect(exportUi.menu(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  },
);

test(
  'DOC-03-AC02 an editor exports the correction draft and the published revision and copies the visible one; a viewer gets no draft',
  { tag: '@infra' },
  async ({ page, browser, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc03-ac02-owner');
    const viewer = await workspaceFactory.member('doc03-ac02-viewer');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    seedMembership(ws.id, viewer.user.id, 'viewer');
    const title = await titleOf(owner, ws.id, documentId);

    // Given: one block corrected and saved, not published (DOC-02 block correction API).
    const token = `교정표지${randomUUID().slice(0, 8)}`;
    const target = (
      await owner.api.ok<{ items: { block_id: string; text: string }[] }>(
        'GET',
        `/documents/${documentId}/blocks?limit=500`,
        undefined,
        [200],
      )
    ).items.find((b) => b.text.startsWith(snippet(RAIN.text, 12)));
    if (!target) throw new Error('book-ko ch1-s2-p1 block not found');
    await owner.api.ok(
      'PATCH',
      `/documents/${documentId}/blocks/${target.block_id}`,
      { text: `E2E 교정 문장 ${token}.` },
      [200],
    );
    const original = snippet(RAIN.text, 20);

    await captureClipboard(page);
    await signInAs(page, owner.user);
    await page.goto(documentPath(ws.id, documentId));
    await expectShown(editorUi.textPanel(page), token, 'the draft correction is shown');
    const button = exportUi.headerButton(page);

    await button.click();
    await expect(exportUi.draftGroup(page)).toBeVisible();
    await expect(exportUi.publishedGroup(page)).toBeVisible();
    const draft = await download(page, () =>
      exportUi.item(exportUi.draftGroup(page), 'md').click(),
    );
    expect(draft.name, 'draft file name').toBe(`${title} (초안).md`);
    expect(draft.text.includes(token), 'the draft holds the corrected sentence').toBe(true);
    expect(draft.text.includes(original), 'the draft no longer holds the old sentence').toBe(false);

    await button.click();
    const published = await download(page, () =>
      exportUi.item(exportUi.publishedGroup(page), 'md').click(),
    );
    expect(published.name, 'published file name').toBe(`${title}.md`);
    expect(published.text.includes(original), 'the published revision keeps the old one').toBe(
      true,
    );
    expect(published.text.includes(token), 'the draft never leaks into the published file').toBe(
      false,
    );

    // 전체 복사: the visible revision (the draft) as Markdown.
    await button.click();
    await exportUi.item(page, 'copy').click();
    await expect(exportUi.copied(page)).toBeVisible();
    const copied = await copiedTexts(page);
    expect(copied.length, 'one clipboard write').toBe(1);
    expect(copied[0] === draft.text, 'the clipboard holds the visible revision as Markdown').toBe(
      true,
    );

    // A viewer: published only, no draft group; the draft API is 403.
    const viewerPage = await newGuestPage(browser);
    try {
      await signInAs(viewerPage, viewer.user);
      await viewerPage.goto(documentPath(ws.id, documentId));
      await expectShown(
        editorUi.textPanel(viewerPage),
        original,
        'the viewer sees the published text',
      );
      await exportUi.headerButton(viewerPage).click();
      await expect(exportUi.item(viewerPage, 'md')).toBeVisible();
      await expect(exportUi.item(viewerPage, 'txt')).toBeVisible();
      await expect(exportUi.item(viewerPage, 'copy')).toBeVisible();
      await expect(exportUi.draftGroup(viewerPage)).toHaveCount(0);
    } finally {
      await viewerPage.context().close();
    }
    const refused = await requestExport({ member: viewer }, documentId, 'md', 'draft');
    expectExportStatus(refused, 403, 'viewer draft export');
    expect(refused.problemType).toBe(PROBLEM_TYPES.insufficientRole);
    expect(refused.text.includes(token), 'a refused export carries no draft text').toBe(false);
  },
);

test(
  'DOC-03-AC03 not-ready rows, share-link guests and other workspaces get no export; responses are private attachments',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc03-ac03-owner');
    const outsider = await workspaceFactory.member('doc03-ac03-outsider');
    const ws = await workspaceFactory.create(owner);
    await workspaceFactory.create(outsider);
    const ready = await uploadReadyBook(owner, ws.id, 'book-ko');
    const pending = await uploadReadyBook(owner, ws.id, 'book-en');
    holdDocumentProcessing(pending);
    const readyTitle = await titleOf(owner, ws.id, ready);
    const pendingTitle = await titleOf(owner, ws.id, pending);
    const link = await createShareLink(owner, ws.id);

    // 문서 관리: the ready row has the menu, the processing row has none.
    await signInAs(page, owner.user);
    await page.goto(documentsPath(ws.id));
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    const readyRow = docUi.item(page, escapeRegExp(readyTitle));
    const pendingRow = docUi.item(page, escapeRegExp(pendingTitle));
    await expect(docUi.processing(pendingRow).first()).toBeVisible();
    await expect(exportUi.rowButton(readyRow)).toBeVisible();
    await expect(exportUi.rowButton(pendingRow)).toHaveCount(0);

    // API: processing → 409 document-not-ready.
    const notReady = await requestExport({ member: owner }, pending, 'md');
    expectExportStatus(notReady, 409, 'processing document');
    expect(notReady.problemType).toBe(DOCUMENT_NOT_READY);

    // A successful export is a private, non-cached attachment.
    const ok = await requestExport({ member: owner }, ready, 'md');
    expectExportStatus(ok, 200, 'owner export');
    expect(ok.headers.get('cache-control') ?? '').toMatch(/private/);
    expect(ok.headers.get('cache-control') ?? '').toMatch(/no-store/);
    expect(ok.headers.get('content-disposition') ?? '').toMatch(/^attachment/i);
    expect(attachmentFilename(ok.headers)).toBe(`${readyTitle}.md`);

    // Another workspace's user: 404 for every variant.
    for (const [format, revision] of [
      ['md', undefined],
      ['txt', undefined],
      ['md', 'draft'],
    ] as const) {
      const res = await requestExport({ member: outsider }, ready, format, revision);
      expectExportStatus(res, 404, `outsider ${format} ${revision ?? 'published'}`);
      expect(res.text.includes(snippet(RAIN.text, 12)), 'a 404 carries no book text').toBe(false);
    }

    // The share session alone (no JWT) cannot call the export API.
    const session = await ShareSession.open(link.id, link.secret);
    const shared = await requestExport({ cookie: session.cookie }, ready, 'md');
    expectExportStatus(shared, 401, 'share session only');

    // The share screen and its document screen have no export entry point.
    const [sharedDoc] = (await session.workspace()).documents.filter((d) => d.id === ready);
    await page.context().clearCookies();
    await openShareWithSecret(page, link.id, link.secret);
    await expect(sharedUi.heading(page)).toBeVisible();
    await expect(exportUi.anyEntry(page)).toHaveCount(0);
    await sharedUi.documentLink(page, sharedDoc?.title ?? readyTitle).click();
    await expect(sharedUi.pdfViewer(page)).toBeVisible();
    await expectShown(page.locator('body'), snippet(RAIN.text), 'the shared document text');
    await expect(exportUi.anyEntry(page)).toHaveCount(0);
  },
);
