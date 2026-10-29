// M7.2 accessibility of the doc-summary surfaces (DOCSUM-X): the DOC-03 text-export menus, the
// DOCSUM-01 document summary panel and the CHNOTE-01 chapter note panel, axe in the light and dark
// theme (fixtures/a11y.ts) in their main states — empty, generating, done (disclosures open),
// failed, confirmation dialog, versions.
//
// The chapter note body and the practice panel carry answers and explanations, and summaries and
// exports carry (synthetic) book text: no trace/screenshot/video and no page text on failure; axe
// reports only rule ids, CSS targets and axe's own summaries. Summaries come from the APP_ENV=test
// extractive fake (fixtures/summary.ts D7), notes from the scenario fake with its hold barrier
// (fixtures/chapter-notes.ts N6/N8).
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import {
  NOTE_TIMEOUT_MS,
  NoteHold,
  generateNote,
  noteBody,
  notePanelPath,
  noteQuestion,
  noteUi,
  startNote,
  waitForNote,
  type NoteScenario,
} from '../fixtures/chapter-notes.ts';
import { exportUi } from '../fixtures/export.ts';
import { expect, NO_VISUAL_ARTIFACTS, test } from '../fixtures/sharing.ts';
import {
  slowSummaryBook,
  startSummary,
  SUMMARY_FAILURE_MARKER,
  SUMMARY_TIMEOUT_MS,
  summaryPanelPath,
  summaryUi,
  getSummary,
  waitForPublishedRevision,
  waitForSummaryRun,
} from '../fixtures/summary.ts';
import {
  block,
  book,
  correctBlock,
  createQuestion,
  docUi,
  documentsPath,
  homeUi,
  JOB_TIMEOUT_MS,
  listDocuments,
  outlineNodeId,
  overviewPath,
  panelUi,
  publishDocument,
  signInAs,
  snippet,
  uploadPdf,
  waitForJob,
  waitForJobStatus,
  type Member,
  type PdfFile,
} from '../fixtures/test.ts';

test.use({ ...NO_VISUAL_ARTIFACTS, attachPageTextOnFailure: false });
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 2 * SUMMARY_TIMEOUT_MS + 60_000 });

const BOOK = book('book-ko');
const CHAPTER_1 = '1장 물의 순환';
const CHAPTER_2 = '2장 정수 처리';
const B_PARAGRAPH = block(BOOK, 'ch2-p1'); // page 4, first body block of chapter 2

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

function escapeRegExp(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** Uploads `fixture`, waits for READY and returns the document id and its listed title. */
async function readyDoc(owner: Member, workspaceId: string, fixture: PdfFile) {
  const { documentId, jobId } = await uploadPdf(owner, workspaceId, fixture);
  await waitForJob(owner, jobId);
  const listed = (await listDocuments(owner, workspaceId)).find((d) => d.id === documentId);
  expect(listed?.title, 'uploaded document is listed with a title').toBeTruthy();
  return { documentId, title: listed?.title ?? '' };
}

async function openSummary(page: Page, workspaceId: string, documentId: string): Promise<Locator> {
  await page.goto(summaryPanelPath(workspaceId, documentId));
  const panel = summaryUi.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function openNote(page: Page, workspaceId: string, chapterId: string): Promise<Locator> {
  await page.goto(notePanelPath(workspaceId, chapterId));
  const panel = noteUi.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

test(
  'A11Y-11 document text export menus and the document summary panel (empty, running, done, confirmation, failed with a stale summary)',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y11');
    const ws = await workspaceFactory.create(owner);
    const doc = await readyDoc(owner, ws.id, BOOK);
    await signInAs(page, owner.user);

    // DOC-03: the 문서 관리 row's export menu.
    await page.goto(documentsPath(ws.id));
    await expect(homeUi.documentsDialog(page)).toBeVisible();
    const row = docUi.item(page, escapeRegExp(doc.title));
    await expect(docUi.ready(row)).toBeVisible();
    await exportUi.rowButton(row).click();
    await expect(exportUi.item(page, 'md')).toBeVisible();
    await expectAccessible(page, 'export menu of a documents row');
    await page.keyboard.press('Escape');
    await expect(exportUi.menu(page)).toHaveCount(0);

    // DOCSUM-01: no summary yet.
    let panel = await openSummary(page, ws.id, doc.documentId);
    await expect(summaryUi.empty(panel)).toBeVisible();
    await expect(summaryUi.createButton(panel)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'summary panel without a summary');

    // Running: a book under the slow marker's file name waits before each step (D7).
    const slow = await readyDoc(owner, ws.id, slowSummaryBook());
    await startSummary(owner, slow.documentId);
    panel = await openSummary(page, ws.id, slow.documentId);
    await expect(summaryUi.queued(panel).or(summaryUi.running(panel)).first()).toBeVisible();
    await expectAccessible(page, 'summary panel while summarizing');

    // Done: the overall summary, key point page links and one chapter disclosure open.
    await startSummary(owner, doc.documentId);
    await waitForSummaryRun(owner, doc.documentId, 'succeeded');
    panel = await openSummary(page, ws.id, doc.documentId);
    await expect(summaryUi.overallHeading(panel)).toBeVisible();
    const chapter = summaryUi.chapter(panel, CHAPTER_1);
    await chapter.click();
    await expect(chapter).toHaveAttribute('aria-expanded', 'true');
    await settle(page);
    await expectAccessible(page, 'summary panel with a chapter expanded');

    // The 자동 갱신 끄기 confirmation (cancelled).
    await summaryUi.disableAuto(panel).click();
    const confirm = summaryUi.confirm(page);
    await expect(confirm).toBeVisible();
    await expectAccessible(page, 'turn off auto refresh confirmation');
    await summaryUi.confirmCancel(confirm).click();
    await expect(confirm).toHaveCount(0);

    // DOC-03 on the editor: a correction draft adds the 교정 중 초안 group to the header menu. The
    // correction carries the summary failure marker, so publishing it fails the re-summary.
    await correctBlock(
      owner,
      doc.documentId,
      4,
      snippet(B_PARAGRAPH.text),
      `${SUMMARY_FAILURE_MARKER} a11y${randomUUID().slice(0, 6)} 문장이다. ${B_PARAGRAPH.text}`,
    );
    await page.goto(`/workspaces/${ws.id}/documents/${doc.documentId}`);
    await exportUi.headerButton(page).click();
    await expect(exportUi.draftGroup(page)).toBeVisible();
    await expect(exportUi.publishedGroup(page)).toBeVisible();
    await expectAccessible(page, 'editor export menu with draft and published groups');
    await page.keyboard.press('Escape');

    // Failed re-summary: the previous summary stays, marked stale, with the reason and 다시 시도.
    const before = (await getSummary(owner, doc.documentId)).published_revision_id ?? '';
    await waitForJobStatus(owner, await publishDocument(owner, doc.documentId), 'succeeded');
    const revision = await waitForPublishedRevision(owner, doc.documentId, before);
    await waitForSummaryRun(owner, doc.documentId, 'failed', revision);
    panel = await openSummary(page, ws.id, doc.documentId);
    await expect(summaryUi.failure(panel)).toBeVisible();
    await expect(summaryUi.stale(panel)).toBeVisible();
    await expect(summaryUi.retry(panel)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'summary panel with a failed re-summary');
  },
);

test(
  'A11Y-12 chapter note panel: Heatmap openers, empty, generating, collapsed and expanded note, footnote question panel, versions, failure',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y12');
    const ws = await workspaceFactory.create(owner);
    const { documentId } = await readyDoc(owner, ws.id, BOOK);
    const ch1 = await outlineNodeId(owner, documentId, CHAPTER_1);
    const ch2 = await outlineNodeId(owner, documentId, CHAPTER_2);
    const hold = new NoteHold();
    const label = `a11y12-${randomUUID().slice(0, 4)}`;
    const seed = async (chapterId: string, scenario: NoteScenario, pages: [number, number]) => {
      for (let n = 1; n <= 2; n += 1) {
        await createQuestion(
          owner,
          ws.id,
          noteQuestion(label, n, chapterId, scenario, {
            hold: n === 1 ? hold : undefined,
            sources: [{ document_id: documentId, page_start: pages[0], page_end: pages[1] }],
          }),
        );
      }
    };
    await seed(ch1, 'ok', [2, 3]);
    await seed(ch2, 'fail', [4, 4]);

    try {
      await signInAs(page, owner.user);
      await page.goto(overviewPath(ws.id));
      await expect(noteUi.opener(page, CHAPTER_1)).toBeVisible();
      await settle(page);
      await expectAccessible(page, 'heatmap with chapter note openers');

      // Empty: the send notice and 정리 노트 만들기.
      let panel = await openNote(page, ws.id, ch1);
      await expect(noteUi.empty(panel)).toBeVisible();
      await expect(noteUi.create(panel)).toBeVisible();
      await settle(page);
      await expectAccessible(page, 'chapter note panel without a note');

      // Generating (held by the fake's barrier).
      await noteUi.create(panel).click();
      await hold.held();
      await expect(noteUi.generating(panel)).toBeVisible();
      await expectAccessible(page, 'chapter note panel while generating');
      hold.release();

      // Done: the body folded behind "정답·해설 포함", then expanded with its footnotes.
      const disclosure = noteUi.disclosure(panel);
      await expect(disclosure).toBeVisible({ timeout: NOTE_TIMEOUT_MS });
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await settle(page);
      await expectAccessible(page, 'chapter note collapsed');
      await disclosure.click();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      const body = await noteBody(panel);
      await expect(noteUi.footnoteList(body)).toBeVisible();
      await expectAccessible(page, 'chapter note expanded with footnotes');

      // A footnote opens its question's practice panel over the note (the note body folds).
      await noteUi.footnoteList(body).getByRole('link').first().click();
      const play = panelUi.numbered(page, 1);
      await expect(play).toBeVisible();
      await settle(page);
      await expectAccessible(page, 'footnote question panel over the chapter note');
      await panelUi.close(play).click();
      await expect(play).toHaveCount(0);

      // Two versions: the 버전 select.
      await generateNote(owner, ch1);
      panel = await openNote(page, ws.id, ch1);
      await expect(noteUi.version(panel)).toBeVisible();
      await expect(noteUi.regenerate(panel)).toBeVisible();
      await settle(page);
      await expectAccessible(page, 'chapter note with versions');
    } finally {
      hold.release();
    }

    // Failure: the alert with its reason and 다시 시도.
    await startNote(owner, ch2);
    await waitForNote(owner, ch2, 'failed');
    const failed = await openNote(page, ws.id, ch2);
    await expect(noteUi.failure(failed)).toBeVisible();
    await expect(noteUi.retry(failed)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'chapter note generation failed');
  },
);
