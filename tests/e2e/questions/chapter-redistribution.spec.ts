// CHREDIST-01 — 챕터 재분배 modal dialog (`/workspaces/:id?panel=chapter-redistribution`),
// docs/screens/chapter-redistribution.md; rules docs/questions.md §14. Contract half (C01–C08):
// tests/integration/questions/chapter_redistribution/.
//
// Each test uploads the synthetic book-ko.pdf (chapters "1장 물의 순환" / "2장 정수 처리") into its
// own workspace and creates CONFIRMED MCQs through the public question API; CHREDIST-01-AC03 also
// imports questions-ko.pdf and uploads it a second time as a book whose chapter carries the paper's
// own chapter title (fixtures/chapter-redistribution.ts R5). Every assumption about UX9-REDIST-B /
// UX9-REDIST-W (API shapes R1–R4, UI labels) is in the tests/e2e/fixtures/chapter-redistribution.ts
// header. Practice data and notes come from the existing public APIs (M5, CHNOTE-B).
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  generateNote,
  FOOTNOTE_GONE,
  noteQuestion,
  noteUi,
  notePanelPath,
} from '../fixtures/chapter-notes.ts';
import {
  assignChapters,
  chapterChangeCount,
  chooseTarget,
  expectFocusTrapped,
  expectNoHorizontalScroll,
  keyboardChoose,
  openRedistributionByKeyboard,
  PAPER_CHAPTER,
  reassignedActivityCount,
  REDIST_PANEL,
  redistributionList,
  redistributionPreview,
  redistUi,
  revisionCount,
  clearQuestionChapters,
  summaryText,
  tabTo,
} from '../fixtures/chapter-redistribution.ts';
import { rangePickerUi } from '../fixtures/range-picker.ts';
import { homeBackgroundUi } from '../fixtures/ux9-pages.ts';
import {
  answerCorrectly,
  archiveQuestion,
  createQuestion,
  draftFor,
  expect,
  getQuestion,
  homePath,
  homeUi,
  importPaperDrafts,
  JOB_TIMEOUT_MS,
  listDrafts,
  outlineNodeId,
  overviewPath,
  overviewUi,
  PROBLEM_TYPES,
  publishDrafts,
  questionPaper,
  QUESTION_MENU_REASONS,
  seedMembership,
  setMyState,
  signInAs,
  test,
  truthQuestion,
  uploadPdf,
  uploadReadyBook,
  waitForJob,
  type ApiResponse,
  type Member,
  type Problem,
  type Question,
  type QuestionInput,
  QUESTION_DOT_NAME,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 6 * JOB_TIMEOUT_MS });

const CH1 = '1장 물의 순환';
const CH2 = '2장 정수 처리';
const NO_CHAPTER = '챕터 없음';
const RANDOM_ID = '00000000-0000-4000-8000-000000000000';
const PAPER = questionPaper();

interface RedistWorkspace {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly ch1: string;
  readonly ch2: string;
  readonly label: string;
}

async function bookWorkspace(
  workspaceFactory: WorkspaceFactory,
  label: string,
  owner?: Member,
): Promise<RedistWorkspace> {
  const member = owner ?? (await workspaceFactory.member(label));
  const ws = await workspaceFactory.create(member);
  const documentId = await uploadReadyBook(member, ws.id, 'book-ko');
  return {
    owner: member,
    workspaceId: ws.id,
    documentId,
    ch1: await outlineNodeId(member, documentId, CH1),
    ch2: await outlineNodeId(member, documentId, CH2),
    label: `${label}-${randomUUID().slice(0, 4)}`,
  };
}

/** A CONFIRMED MCQ numbered `n` whose stem starts with the unique `<label>-<n>` tag. */
function mcq(
  label: string,
  n: number,
  chapterId: string | null,
  extra: Partial<QuestionInput> = {},
) {
  const options = ['가', '나', '다', '라'].map((x, i) => ({
    id: `opt-${i + 1}`,
    text: `${label}-${n} 보기 ${x}`,
  }));
  return {
    question_type: 'MCQ' as const,
    stem: `${label}-${n} 문제: 알맞은 것을 고르시오.`,
    options,
    correct_option_ids: ['opt-1'],
    is_multi_answer: false,
    explanation: `${label}-${n} 해설.`,
    chapter_id: chapterId,
    question_number: n,
    ...extra,
  };
}

function stemTag(label: string, n: number): string {
  return `${label}-${n} 문제`;
}

async function openHome(page: Page, user: Member, workspaceId: string): Promise<void> {
  await signInAs(page, user.user);
  await page.goto(overviewPath(workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

function problemType(res: ApiResponse): string | undefined {
  return (res.body as Problem | undefined)?.type;
}

/** Expands every chapter group of the range picker inside `dialog`. */
async function expandAll(dialog: Locator, titles: readonly string[]): Promise<void> {
  for (const title of titles) {
    const toggle = rangePickerUi.expand(dialog, title);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
}

/** The dialog is gone and so is its `panel` value (the app's URL write has landed). */
async function expectDialogClosed(page: Page): Promise<void> {
  await expect(redistUi.dialog(page)).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]panel=/);
}

/** The heatmap group of `title` holds `n` markers (0 = the group is gone). */
async function expectGroupSize(page: Page, title: string, n: number): Promise<void> {
  const group = redistUi.heatmapGroup(page, title);
  if (n === 0) {
    await expect(group).toHaveCount(0);
    return;
  }
  await expect(group.getByRole('button', { name: QUESTION_DOT_NAME })).toHaveCount(n);
}

/** Asks the server to move `ids` as the viewer / archived owner would: every call refused. */
async function expectRefused(
  member: Member,
  workspaceId: string,
  questionId: string,
  chapterId: string,
  type: string,
): Promise<void> {
  const list = await redistributionList(member, workspaceId);
  const preview = await redistributionPreview(member, workspaceId, {
    all: true,
    include_manual: false,
  });
  const move = await assignChapters(member, workspaceId, {
    source: 'manual',
    items: [{ question_id: questionId, chapter_id: chapterId, expected_chapter_id: null }],
  });
  for (const [what, res] of [
    ['list', list],
    ['preview', preview],
    ['move', move],
  ] as const) {
    expect(res.status, `${what} is refused`).toBe(403);
    expect(problemType(res), what).toBe(type);
  }
}

test(
  'CHREDIST-01-AC01 an owner opens the modal dialog from the 문제 menu and selects chapters and questions; viewers and archived workspaces cannot',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'chredist01-ac01');
    const confirmed: Question[] = [];
    for (const [n, chapter] of [
      [1, s.ch1],
      [2, s.ch1],
      [3, s.ch1],
      [4, s.ch2],
      [5, s.ch2],
      [6, null],
    ] as const) {
      confirmed.push(await createQuestion(s.owner, s.workspaceId, mcq(s.label, n, chapter)));
    }
    await createQuestion(
      s.owner,
      s.workspaceId,
      mcq(s.label, 7, s.ch1, { publication_status: 'DRAFT' }),
    );
    const archived = await createQuestion(s.owner, s.workspaceId, mcq(s.label, 8, s.ch2));
    await archiveQuestion(s.owner, archived);

    // Owner: keyboard path to the modal dialog without leaving the home.
    await openHome(page, s.owner, s.workspaceId);
    const dialog = await openRedistributionByKeyboard(page);
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/workspaces/${s.workspaceId}` &&
        url.searchParams.getAll('panel').includes(REDIST_PANEL),
    );
    // The modal hides the home from the accessibility tree; it is still there behind it.
    await expect(homeBackgroundUi.heatmap(page)).toBeAttached();
    await expectFocusTrapped(page, dialog, 40);
    await expectFocusTrapped(page, dialog, 10, 'Shift+Tab');

    // Chapter groups in Heatmap order; six confirmed questions; no draft or archived question.
    await expect(rangePickerUi.chapter(dialog, CH1)).toBeVisible();
    await expect(rangePickerUi.chapter(dialog, CH2)).toBeVisible();
    await expect(rangePickerUi.chapter(dialog, NO_CHAPTER)).toBeVisible();
    const tops = await Promise.all(
      [CH1, CH2, NO_CHAPTER].map(
        async (title) => (await rangePickerUi.chapter(dialog, title).boundingBox())?.y ?? -1,
      ),
    );
    expect(tops, 'Heatmap order: 1장, 2장, 챕터 없음 last').toEqual(
      [...tops].sort((a, b) => a - b),
    );
    await expandAll(dialog, [CH1, CH2, NO_CHAPTER]);
    for (let n = 1; n <= 6; n++) {
      const row = redistUi.questionByStem(dialog, stemTag(s.label, n));
      await expect(row, `question ${n} is listed`).toHaveCount(1);
      await expect(row).toHaveAccessibleName(/^\d+번 · .+ · (객관식|MCQ)/);
    }
    await expect(redistUi.questionByStem(dialog, stemTag(s.label, 7))).toHaveCount(0);
    await expect(redistUi.questionByStem(dialog, stemTag(s.label, 8))).toHaveCount(0);
    await expect(rangePickerUi.questions(dialog)).toHaveCount(6); // the 챕터 없음 row is numbered alike

    // Space on the 1장 checkbox selects its three questions; one 2장 question makes 2장 mixed.
    const ch1Box = rangePickerUi.chapter(dialog, CH1);
    await ch1Box.focus();
    await page.keyboard.press('Space');
    for (let n = 1; n <= 3; n++) {
      await expect(redistUi.questionByStem(dialog, stemTag(s.label, n))).toBeChecked();
    }
    const selected = rangePickerUi.selected(dialog, 3);
    await expect(selected).toBeVisible();
    await expect(selected).toHaveAttribute('aria-live', 'polite');
    await redistUi.questionByStem(dialog, stemTag(s.label, 4)).focus();
    await page.keyboard.press('Space');
    await expect(rangePickerUi.chapter(dialog, CH2)).toHaveAttribute('aria-checked', 'mixed');
    await expect(rangePickerUi.selected(dialog, 4)).toBeVisible();
    await ch1Box.focus();
    await page.keyboard.press('Space');
    await expect(rangePickerUi.selected(dialog, 1)).toBeVisible();
    for (let n = 1; n <= 3; n++) {
      await expect(redistUi.questionByStem(dialog, stemTag(s.label, n))).not.toBeChecked();
    }

    // Escape closes it (focus back on 문제); back/forward never reopen it (QOV-01-AC14).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(homeUi.questionMenuButton(page)).toBeFocused();
    await expect(page).toHaveURL((url) => !url.searchParams.getAll('panel').includes(REDIST_PANEL));
    await page.goBack();
    await expect(redistUi.dialog(page)).toHaveCount(0);
    await page.goForward();
    await expect(redistUi.dialog(page)).toHaveCount(0);

    // Viewer: the item is disabled with the reason, skipped by the arrows; deep link opens nothing.
    const viewer = await workspaceFactory.member('chredist01-ac01-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    await page.context().clearCookies();
    await signInAs(page, viewer.user);
    await page.goto(overviewPath(s.workspaceId));
    await expectDisabledItem(page, 'viewer');
    await page.goto(homePath(s.workspaceId, `panel=${REDIST_PANEL}`));
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(redistUi.dialog(page), 'the deep link opens nothing').toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.getAll('panel').includes(REDIST_PANEL));
    await expectRefused(
      viewer,
      s.workspaceId,
      confirmed[0]?.id ?? RANDOM_ID,
      s.ch2,
      PROBLEM_TYPES.insufficientRole,
    );

    // Archived workspace (its owner): same, with the archived reason and 403 workspace-archived.
    const a = await bookWorkspace(workspaceFactory, 'chredist01-ac01-archived', s.owner);
    const q = await createQuestion(a.owner, a.workspaceId, mcq(a.label, 1, a.ch1));
    await workspaceFactory.archive(a.owner, a.workspaceId);
    await page.context().clearCookies();
    await signInAs(page, a.owner.user);
    await page.goto(overviewPath(a.workspaceId));
    await expectDisabledItem(page, 'archived');
    await page.goto(homePath(a.workspaceId, `panel=${REDIST_PANEL}`));
    await expect(overviewUi.heatmap(page)).toBeVisible();
    await expect(redistUi.dialog(page)).toHaveCount(0);
    await expectRefused(a.owner, a.workspaceId, q.id, a.ch2, PROBLEM_TYPES.workspaceArchived);
  },
);

/** The `챕터 재분배` item is aria-disabled, explains why, is skipped by the arrows, opens nothing. */
async function expectDisabledItem(
  page: Page,
  reason: keyof typeof QUESTION_MENU_REASONS,
): Promise<void> {
  const button = homeUi.questionMenuButton(page);
  await button.focus();
  await page.keyboard.press('Enter');
  const item = redistUi.menuItem(page);
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAccessibleDescription(QUESTION_MENU_REASONS[reason]);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('ArrowDown');
    await expect(item).not.toBeFocused();
  }
  await page.keyboard.press('Escape');
  await button.click();
  await expect(item).toBeInViewport();
  await item.click({ force: true });
  await expect(redistUi.dialog(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
}

test(
  'CHREDIST-01-AC02 moving questions to another chapter keeps their records, marks both notes stale and refuses foreign chapters and allows a question-paper level-1 chapter',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'chredist01-ac02');
    const note = (n: number, chapter: string | null) =>
      noteQuestion(s.label, n, chapter, 'ok', { question_number: n });
    const q1 = await createQuestion(s.owner, s.workspaceId, note(1, s.ch1));
    const q2 = await createQuestion(s.owner, s.workspaceId, note(2, s.ch1));
    const q3 = await createQuestion(s.owner, s.workspaceId, note(3, s.ch1));
    const q4 = await createQuestion(s.owner, s.workspaceId, note(4, s.ch2));
    const q5 = await createQuestion(s.owner, s.workspaceId, note(5, null));
    // q1 has two attempts and is a favourite.
    await answerCorrectly(s.owner, q1);
    await answerCorrectly(s.owner, q1);
    await setMyState(s.owner, q1.id, { is_favorite: true });
    await generateNote(s.owner, s.ch1);
    await generateNote(s.owner, s.ch2);
    const revisionsBefore = revisionCount(q1.id);
    // A chapter of another workspace and a level-1 chapter of a question paper of this one.
    const other = await bookWorkspace(workspaceFactory, 'chredist01-ac02-other', s.owner);
    const paper = await uploadPdf(s.owner, s.workspaceId, PAPER, 'question_paper');
    await waitForJob(s.owner, paper.jobId);
    const paperChapter = await outlineNodeId(s.owner, paper.documentId, PAPER_CHAPTER);

    await openHome(page, s.owner, s.workspaceId);
    const q1Dot = overviewUi.dot(page, 1);
    const statusBefore = await q1Dot.getAttribute('data-status');
    await expect(overviewUi.marker(q1Dot)).toHaveAttribute('data-shape', 'star');

    await homeUi.questionMenuButton(page).click();
    await redistUi.menuItem(page).click();
    const dialog = redistUi.dialog(page);
    await expect(dialog).toBeVisible();
    await expandAll(dialog, [CH1, NO_CHAPTER]);
    for (const n of [1, 2, 5]) {
      await redistUi.questionByStem(dialog, stemTag(s.label, n)).check();
    }
    await expect(rangePickerUi.selected(dialog, 3)).toBeVisible();
    const move = redistUi.move(dialog);
    await expect(move).toBeDisabled();
    await expect(redistUi.pickChapterReason(dialog)).toBeVisible();
    await expect(move).toHaveAccessibleDescription(/옮길 챕터를 고르세요|choose a chapter/i);

    await chooseTarget(page, dialog, CH2);
    await expect(move).toBeEnabled();
    await expect(move).toHaveAccessibleName(redistUi.moveCount(3));
    await move.click();
    const confirm = redistUi.confirm(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveAccessibleName(/문제 3개를 2장 정수 처리.*로 옮길까요/);
    await expect(confirm).toContainText(/정리 노트가 최신이 아니게 됩니다/);
    await redistUi.confirmMove(confirm).click();
    await expect(redistUi.moved(page)).toContainText(/문제 3개를 .*옮겼습니다/);
    // The dialog stays open (refreshed); close it before reading the background Heatmap.
    await redistUi.close(dialog).click();
    await expect(redistUi.dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.getAll('panel').includes(REDIST_PANEL));

    // Heatmap: 1장 keeps q3, 2장 has four, the 챕터 없음 group is gone — also after a reload.
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await expectGroupSize(page, CH1, 1);
      await expectGroupSize(page, CH2, 4);
      await expectGroupSize(page, NO_CHAPTER, 0);
    }
    // The moved rows say "직접 정함"; q1 keeps its status, star and revisions.
    await homeUi.questionMenuButton(page).click();
    await redistUi.menuItem(page).click();
    await expect(redistUi.dialog(page)).toBeVisible();
    await expandAll(redistUi.dialog(page), [CH2]);
    for (const n of [1, 2, 5]) {
      await expect(
        redistUi.manualBadge(redistUi.rowByStem(redistUi.dialog(page), stemTag(s.label, n))),
      ).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expectDialogClosed(page);
    const moved = overviewUi.dot(page, 1);
    await expect(moved).toHaveAttribute('data-status', statusBefore ?? 'correct');
    await expect(overviewUi.marker(moved)).toHaveAttribute('data-shape', 'star');
    expect(revisionCount(q1.id), 'moving adds no revision').toBe(revisionsBefore);
    expect((await getQuestion(s.owner, q1.id)).revision.version).toBe(q1.revision.version);

    // Both notes are stale; 1장's footnote of a moved question reads "삭제되었거나 옮긴 문제".
    await page.goto(notePanelPath(s.workspaceId, s.ch1));
    const panel = noteUi.panel(page);
    await expect(noteUi.stale(panel)).toBeVisible();
    // The body is always open (UX9-NOTE-W, CHNOTE-02): the footnotes are read at once.
    await expect(
      noteUi.footnoteList(panel).getByRole('listitem').filter({ hasText: FOOTNOTE_GONE }),
    ).not.toHaveCount(0);
    await page.goto(notePanelPath(s.workspaceId, s.ch2));
    await expect(noteUi.stale(noteUi.panel(page))).toBeVisible();

    // Foreign chapter → 404 and nothing moved; a question paper's level-1 chapter is a valid target.
    const foreign = await assignChapters(s.owner, s.workspaceId, {
      source: 'manual',
      items: [{ question_id: q3.id, chapter_id: other.ch1, expected_chapter_id: s.ch1 }],
    });
    expect(foreign.status).toBe(404);
    expect((await getQuestion(s.owner, q3.id)).chapter_id).toBe(s.ch1);
    const allowed = await assignChapters(s.owner, s.workspaceId, {
      source: 'manual',
      items: [{ question_id: q3.id, chapter_id: paperChapter, expected_chapter_id: s.ch1 }],
    });
    expect(allowed.status).toBe(200);
    expect((await getQuestion(s.owner, q3.id)).chapter_id).toBe(paperChapter);
    expect((await getQuestion(s.owner, q4.id)).chapter_id).toBe(s.ch2);
    for (const q of [q1, q2, q5]) {
      expect((await getQuestion(s.owner, q.id)).chapter_id).toBe(s.ch2);
    }
  },
);

test(
  'CHREDIST-01-AC03 recommendations preview without writing, skip hand-set chapters by default, and apply only the checked rows',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'chredist01-ac03');
    // The question paper: before the titled book exists every draft suggests no chapter (auto).
    const { run, drafts } = await importPaperDrafts(s.owner, s.workspaceId);
    const dA = draftFor(drafts, truthQuestion(PAPER, 1));
    const dB = draftFor(drafts, truthQuestion(PAPER, 2));
    const dC = draftFor(drafts, truthQuestion(PAPER, 4));
    const dD = draftFor(drafts, truthQuestion(PAPER, 5));
    await publishDrafts(s.owner, run.id, [dA.id, dB.id]); // A, B: auto, 챕터 없음
    // C: the reviewer picks 1장 (manual).
    await s.owner.api.ok(
      'PATCH',
      `/question-drafts/${dC.id}`,
      { base_version: dC.version, chapter_id: s.ch1 },
      [200],
    );
    await publishDrafts(s.owner, run.id, [dC.id]);
    // The titled book: its chapter is the paper's chapter title (R5); D registers under it (auto).
    const titled = await uploadPdf(
      s.owner,
      s.workspaceId,
      { ...PAPER, file: 'chapter-book.pdf' },
      'book',
    );
    await waitForJob(s.owner, titled.jobId);
    const titledChapter = await outlineNodeId(s.owner, titled.documentId, PAPER_CHAPTER);
    await publishDrafts(s.owner, run.id, [dD.id]);
    // E: created directly, no source (manual).
    const e = await createQuestion(s.owner, s.workspaceId, mcq(s.label, 9, s.ch2));

    const registered = new Map(
      (await listDrafts(s.owner, run.id)).map((d) => [d.id, d.published_question_id ?? '']),
    );
    const id = (d: { id: string }) => registered.get(d.id) ?? '';
    // CHAP-MATCH: the titled book's parse already re-matched A and B (auto, no chapter); put them back.
    clearQuestionChapters([id(dA), id(dB)]);
    const chapterOf = async (questionId: string) =>
      (await getQuestion(s.owner, questionId)).chapter_id;
    expect(await chapterOf(id(dA))).toBeNull();
    expect(await chapterOf(id(dB))).toBeNull();
    expect(await chapterOf(id(dC))).toBe(s.ch1);
    expect(await chapterOf(id(dD))).toBe(titledChapter);
    const before = await Promise.all([dA, dB, dC, dD].map((d) => chapterOf(id(d))));

    const stemOf = (n: number) => truthQuestion(PAPER, n).stem.slice(0, 12);
    await openHome(page, s.owner, s.workspaceId);
    await homeUi.questionMenuButton(page).click();
    await redistUi.menuItem(page).click();
    let dialog = redistUi.dialog(page);
    await expect(dialog).toBeVisible();
    await expect(redistUi.includeManual(dialog)).not.toBeChecked();
    await expect(redistUi.allScope(dialog)).toBeVisible();
    await redistUi.recommend(dialog).click();
    await expect(redistUi.summary(dialog)).toHaveText(
      summaryText({ change: 2, unchanged: 1, skipped: 2 }),
    );
    await expect(page).toHaveURL((url) => !url.searchParams.has('step'));
    const rows = redistUi.previewRows(dialog);
    await expect(rows).toHaveCount(2);
    for (const n of [1, 2]) {
      const row = redistUi.previewRow(dialog, stemOf(n));
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(
        new RegExp(`현재:\\s*${NO_CHAPTER}\\s*→\\s*추천:\\s*${PAPER_CHAPTER.slice(0, 8)}`),
      );
      await expect(row).toContainText(/문제지 장 제목과 일치|matches the question paper/);
      await expect(redistUi.applyRow(row)).toBeChecked();
    }
    for (const n of [4, 5]) {
      await expect(redistUi.previewRow(dialog, stemOf(n))).toHaveCount(0);
    }
    // The preview wrote nothing.
    expect(await Promise.all([dA, dB, dC, dD].map((d) => chapterOf(id(d))))).toEqual(before);

    // Apply A only.
    await redistUi.applyRow(redistUi.previewRow(dialog, stemOf(2))).uncheck();
    await expect(redistUi.applyAll(dialog)).toHaveAttribute('aria-checked', 'mixed');
    // The changed 적용 choices are unsaved input (no question selected, no target): a click on
    // the backdrop keeps the dialog and the choices (HOMEDLG-01).
    const panelBox = await dialog.boundingBox();
    if (!panelBox || panelBox.x < 40) throw new Error('no backdrop beside the dialog');
    await page.mouse.click(panelBox.x / 2, panelBox.y + panelBox.height / 2);
    await expect(dialog).toBeVisible();
    await expect(redistUi.applyRow(redistUi.previewRow(dialog, stemOf(2)))).not.toBeChecked();
    await expect(redistUi.applyRow(redistUi.previewRow(dialog, stemOf(1)))).toBeChecked();
    const apply = redistUi.applySelected(dialog);
    await expect(apply).toHaveAccessibleName(/\(1\)$/);
    await apply.click();
    const confirm = redistUi.confirm(page);
    await expect(confirm).toHaveAccessibleName(/추천한 챕터로 문제 1개를 옮길까요/);
    await redistUi.confirmMove(confirm).click();
    await expect(redistUi.applied(page)).toContainText(/문제 1개의 챕터를 추천대로 바꿨습니다/);
    // Back on the list step.
    dialog = redistUi.dialog(page);
    await expect(redistUi.recommend(dialog)).toBeVisible();
    expect(await chapterOf(id(dA))).toBe(titledChapter);
    expect(await chapterOf(id(dB))).toBeNull();
    await expandAll(dialog, [PAPER_CHAPTER, NO_CHAPTER]);
    const aRow = redistUi.rowByStem(dialog, stemOf(1));
    await expect(aRow).toBeVisible();
    await expect(redistUi.manualBadge(aRow)).toHaveCount(0);
    expect(
      (await getQuestion(s.owner, id(dA))) as unknown as { chapter_source?: string },
    ).toMatchObject({
      chapter_source: 'auto',
    });

    // With hand-set chapters included: B and C change, A and D stay, E has no source.
    await redistUi.includeManual(dialog).check();
    await redistUi.recommend(dialog).click();
    await expect(redistUi.summary(dialog)).toHaveText(
      summaryText({ change: 2, unchanged: 2, none: 1 }),
    );
    await expect(redistUi.previewRows(dialog)).toHaveCount(2);
    for (const n of [2, 4]) {
      await expect(redistUi.previewRow(dialog, stemOf(n))).toHaveCount(1);
    }
    const preview = await redistributionPreview(s.owner, s.workspaceId, {
      all: true,
      include_manual: true,
    });
    expect(preview.status).toBe(200);
    expect(
      (preview.body as { no_recommendation?: Record<string, number> }).no_recommendation,
    ).toMatchObject({ no_source: 1 });
    expect(await chapterOf(e.id)).toBe(s.ch2);
  },
);

test(
  'CHREDIST-01-AC04 a question changed in another tab refuses the whole move; a double press moves once; the keyboard path works at 375px',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'chredist01-ac04');
    const qs: Question[] = [];
    for (const n of [1, 2, 3]) {
      qs.push(await createQuestion(s.owner, s.workspaceId, mcq(s.label, n, s.ch1)));
    }
    const [q1, q2, q3] = qs as [Question, Question, Question];
    const keys: (string | null)[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('chapter-assignments')) {
        keys.push(req.headers()['idempotency-key'] ?? null);
      }
    });

    await openHome(page, s.owner, s.workspaceId);
    await homeUi.questionMenuButton(page).click();
    await redistUi.menuItem(page).click();
    let dialog = redistUi.dialog(page);
    await rangePickerUi.chapter(dialog, CH1).check();
    await chooseTarget(page, dialog, CH2);
    await redistUi.move(dialog).click();
    let confirm = redistUi.confirm(page);
    await expect(confirm).toBeVisible();

    // The second tab moves q2 to 챕터 없음 with 편집 (the PATCH the edit dialog sends).
    const second = await page.context().newPage();
    await second.goto(overviewPath(s.workspaceId, q2.id));
    await expect(second.getByRole('dialog', { name: /2번 문제/ })).toBeVisible();
    await s.owner.api.ok(
      'PATCH',
      `/questions/${q2.id}`,
      { base_revision_id: q2.revision.id, chapter_id: null },
      [200],
    );
    await second.close();
    const changesBefore = chapterChangeCount(s.workspaceId);
    const activityBefore = reassignedActivityCount(s.workspaceId);

    await redistUi.confirmMove(confirm).click();
    await expect(redistUi.conflict(page)).toBeVisible();
    expect((await getQuestion(s.owner, q1.id)).chapter_id).toBe(s.ch1);
    expect((await getQuestion(s.owner, q3.id)).chapter_id).toBe(s.ch1);
    expect(chapterChangeCount(s.workspaceId)).toBe(changesBefore);
    dialog = redistUi.dialog(page);
    await expandAll(dialog, [NO_CHAPTER]);
    await expect(redistUi.questionByStem(dialog, stemTag(s.label, 2))).toBeVisible();
    await page.keyboard.press('Escape');
    await expectGroupSize(page, CH1, 2);
    await expectGroupSize(page, NO_CHAPTER, 1);

    // Two quick presses of 옮기기: one move, one activity, one history row per question.
    keys.length = 0;
    await homeUi.questionMenuButton(page).click();
    await redistUi.menuItem(page).click();
    dialog = redistUi.dialog(page);
    await rangePickerUi.chapter(dialog, CH1).check();
    await chooseTarget(page, dialog, CH2);
    await redistUi.move(dialog).click();
    confirm = redistUi.confirm(page);
    await redistUi.confirmMove(confirm).dblclick();
    await expect(redistUi.moved(page)).toContainText(/문제 2개를/);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size, 'retries reuse one Idempotency-Key').toBe(1);
    expect(keys[0]).toBeTruthy();
    expect(reassignedActivityCount(s.workspaceId)).toBe(activityBefore + 1);
    expect(chapterChangeCount(s.workspaceId)).toBe(changesBefore + 2);
    await page.keyboard.press('Escape');
    // The close drops `panel` with its own history write: a goto before it lands is interrupted.
    await expectDialogClosed(page);
    await expectGroupSize(page, CH2, 2);

    // Keyboard only at 375px: move the 챕터 없음 question to 1장.
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.heatmap(page)).toBeVisible();
    // Enter, arrows to 챕터 재분배 (asserted focused), Enter.
    dialog = await openRedistributionByKeyboard(page);
    await expectNoHorizontalScroll(page, dialog);
    const noChapter = rangePickerUi.chapter(dialog, NO_CHAPTER);
    await tabTo(page, noChapter);
    await page.keyboard.press('Space');
    await expect(rangePickerUi.selected(dialog, 1)).toBeVisible();
    const target = redistUi.target(dialog);
    await tabTo(page, target);
    await keyboardChoose(page, target, CH1);
    const move = redistUi.move(dialog);
    await tabTo(page, move);
    await page.keyboard.press('Enter');
    confirm = redistUi.confirm(page);
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(move).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirm).toBeVisible();
    await tabTo(page, redistUi.confirmMove(confirm), 6);
    await page.keyboard.press('Enter');
    await expect(redistUi.moved(page)).toContainText(/문제 1개를/);
    await expectNoHorizontalScroll(page, redistUi.dialog(page));
    expect((await getQuestion(s.owner, q2.id)).chapter_id).toBe(s.ch1);
  },
);
