// MOCK-01 — 모의고사 목록·만들기·편집 Floating Dialog (`/workspaces/:id?panel=mock-exams`),
// docs/screens/mock-exams.md; rules docs/questions.md §11. Contract half (C01–C09):
// tests/integration/questions/mock_exams/.
//
// Each test signs in its own owner with a fresh workspace, uploads the synthetic book-ko.pdf
// (chapters "1장 물의 순환" p.2 / "2장 정수 처리" p.4) and creates CONFIRMED MCQs from the
// `mock_exam` block of tests/fixtures/llm/generation-scenarios.json through the public question
// API: each stem ends with its scenario marker, which the APP_ENV=test worker's batched fake LLM
// answers (fixtures/mock-exams.ts K4–K5); the hold barrier (K6) makes "만드는 중" observable.
// Server state (bank counts, mock exam questions, LLM call counts) is checked through the public
// API. Every endpoint/label assumption is in the fixtures/mock-exams.ts header (K1–K9).
//
// The main stack runs with WORKER_MOCK_EXAMS=true; AC08 starts its own LLM-off stack (K8).
// Mock exam questions carry answers and explanations (manage view): traces, screenshots, videos
// and the page text on failure are off.
import type { Locator, Page } from '@playwright/test';
import {
  ALL,
  CH1,
  CH2,
  chaptersRange,
  createMockExam,
  createMockExamRequest,
  getMockExam,
  listMockExams,
  listMockQuestions,
  llmCalls,
  MOCK_PROBLEMS,
  MOCK_TEXT,
  MOCK_TIMEOUT_MS,
  MockHold,
  mockExamsPath,
  mockSource,
  mockSourceInput,
  mockUi,
  NORMAL_SOURCES,
  openMockExams,
  partialText,
  practiseMockQuestion,
  progressText,
  questionRow,
  scriptedStems,
  makeText,
  NO_CHAPTER,
  startMockExamsOffStack,
  STATUS_TEXT,
  VARIATION_LABEL,
  waitForMockExam,
  type MockExam,
  type MockSourceName,
  type VariationType,
} from '../fixtures/mock-exams.ts';
import { openRangeFilters, rangePickerUi as picker } from '../fixtures/range-picker.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharedUi,
  test,
} from '../fixtures/sharing.ts';
import {
  answerKeysIn,
  createQuestion,
  getOverview,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  listQuestions,
  numberedMcq,
  outlineNodeId,
  overviewUi,
  questionFormUi,
  seedMembership,
  setMyState,
  signInAs,
  uploadReadyBook,
  type Member,
  type Problem,
  type Question,
} from '../fixtures/test.ts';
import { homeBackgroundUi, homeDialogUi, isBlocked } from '../fixtures/ux9-pages.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: 4 * JOB_TIMEOUT_MS + 2 * MOCK_TIMEOUT_MS });

interface BookWorkspace {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly ch1: string;
  readonly ch2: string;
}

async function bookWorkspace(workspaceFactory: WorkspaceFactory, label: string) {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  const ch1 = await outlineNodeId(owner, documentId, CH1);
  const ch2 = await outlineNodeId(owner, documentId, CH2);
  return { owner, workspaceId: ws.id, documentId, ch1, ch2 } satisfies BookWorkspace;
}

function chapterOf(s: BookWorkspace, name: MockSourceName): string | null {
  const chapter = mockSource(name).chapter;
  return chapter === 1 ? s.ch1 : chapter === 2 ? s.ch2 : null;
}

/** Creates `names` as CONFIRMED questions numbered from `first`, in their scenario chapters. */
async function seedSources(
  s: BookWorkspace,
  names: readonly MockSourceName[],
  first = 1,
  hold?: MockHold,
): Promise<Question[]> {
  const out: Question[] = [];
  for (const [i, name] of names.entries()) {
    out.push(
      await createQuestion(
        s.owner,
        s.workspaceId,
        mockSourceInput(name, s.documentId, first + i, chapterOf(s, name), hold),
      ),
    );
  }
  return out;
}

async function openHome(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(homePath(workspaceId));
  await expect(overviewUi.heatmap(page)).toBeVisible();
}

async function switchUser(page: Page, member: Member, workspaceId: string): Promise<void> {
  await page.context().clearCookies();
  await openHome(page, member, workspaceId);
}

/** Step 1 of 만들기: name, variation types, 문항 수 → 다음. */
async function fillOptions(
  dialog: Locator,
  title: string,
  types: readonly VariationType[],
  count: number,
): Promise<void> {
  for (const type of ['OPTION_SHUFFLE', 'PARAPHRASE', 'INVERT_POLARITY'] as const) {
    const box = mockUi.variation(dialog, type);
    if (types.includes(type)) await box.check();
    else if ((await box.count()) > 0 && (await box.isChecked())) await box.uncheck();
  }
  await mockUi.title(dialog).fill(title);
  await mockUi.questionCount(dialog).fill(String(count));
  await mockUi.next(dialog).click();
}

/** The whole 만들기 flow with a range of whole chapters, by title (CH1, CH2, NO_CHAPTER). */
async function createInUi(
  dialog: Locator,
  title: string,
  types: readonly VariationType[],
  count: number,
  chapterTitles: readonly string[],
): Promise<void> {
  await mockUi.add(dialog).click();
  await fillOptions(dialog, title, types, count);
  for (const chapter of chapterTitles) await picker.chapter(dialog, chapter).check();
  await mockUi.make(dialog).click();
  await expect(mockUi.heading(dialog, title)).toBeVisible();
}

async function expectProblem(
  res: { status: number; body?: unknown },
  status: number,
  type?: string,
): Promise<void> {
  expect(res.status).toBe(status);
  if (type) expect((res.body as Problem | undefined)?.type).toBe(type);
}

test(
  'MOCK-01-AC01 the saved mock list link shows a skeleton and an empty state with 추가 for editors only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('mock01-ac01');
    const ws = await workspaceFactory.create(owner);
    await createQuestion(owner, ws.id, numberedMcq('mock01-ac01', 1));
    const viewer = await workspaceFactory.member('mock01-ac01-viewer');
    seedMembership(ws.id, viewer.user.id, 'viewer');

    await openHome(page, owner, ws.id);

    // The dialog opens before the list arrives: busy skeleton, then the empty state.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => /\/api\/workspaces\/[^/]+\/mock-exams$/.test(url.pathname),
      async (route) => {
        await gate;
        await route.fallback();
      },
    );
    await page.goto(homePath(ws.id, 'panel=mock-exams'));
    const dialog = mockUi.dialog(page);
    await expect(dialog).toBeVisible();
    // UX9 (HOMEDLG-01): a modal dialog.
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(page).toHaveURL((url) => url.searchParams.getAll('panel').includes('mock-exams'));
    await expect(mockUi.busy(dialog)).toBeVisible();
    await expect(mockUi.loading(dialog)).toBeVisible();
    release();
    await expect(dialog.getByText(MOCK_TEXT.empty)).toBeVisible();
    await expect(mockUi.busy(dialog)).toHaveCount(0);
    await expect(dialog.getByText(MOCK_TEXT.emptyHint)).toBeVisible();
    await expect(mockUi.add(dialog)).toHaveCount(1);
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // UX9 (HOMEDLG-01): modal — the header behind it is inert, so 문서 관리 does not open beside
    // it; a deep link listing both stacks them in URL order, the last one on top.
    expect(await isBlocked(homeBackgroundUi.documentsButton(page)), '문서 n is inert').toBe(true);
    await page.goto(homePath(ws.id, 'panel=mock-exams&panel=documents'));
    const documents = homeDialogUi.documents(page);
    const stacked = homeDialogUi.mockExams(page);
    await expect(documents).toBeVisible();
    await expect(stacked).toBeVisible();
    const z = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).zIndex));
    expect(await z(documents)).toBeGreaterThan(await z(stacked));
    expect(await isBlocked(stacked), '모의고사 under 문서 관리').toBe(true);

    // The retired 문제 생성 dialog URL lands on 모의고사.
    await page.goto(homePath(ws.id, 'panel=generate'));
    await expect(page).toHaveURL((url) => url.searchParams.getAll('panel').includes('mock-exams'));
    await expect(mockUi.dialog(page)).toBeVisible();
    await expect(homeUi.generateDialog(page)).toHaveCount(0);

    // A viewer gets the same entry (enabled), the empty state and 추가, without the hint.
    await switchUser(page, viewer, ws.id);
    await page.goto(homePath(ws.id, 'panel=mock-exams'));
    const viewerDialog = mockUi.dialog(page);
    await expect(viewerDialog.getByText(MOCK_TEXT.empty)).toBeVisible();
    await expect(mockUi.add(viewerDialog)).toHaveCount(1);
    await expect(viewerDialog.getByText(MOCK_TEXT.emptyHint)).toHaveCount(0);
  },
);

test(
  'MOCK-01-AC02 추가 makes a mock exam in two steps from the confirmed questions only, shows its progress and leaves the bank untouched',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'mock01-ac02');
    const hold = new MockHold();
    const confirmed = await seedSources(s, NORMAL_SOURCES, 1, hold);
    const drafts = await Promise.all(
      [7, 8].map((n) =>
        createQuestion(s.owner, s.workspaceId, {
          ...numberedMcq('mock01-ac02-draft', n),
          chapter_id: s.ch1,
          publication_status: 'DRAFT',
        }),
      ),
    );
    const before = await getOverview(s.owner, s.workspaceId);
    expect(before.counts.total).toBe(6);
    const bankBefore = (await listQuestions(s.owner, s.workspaceId)).length;

    await openHome(page, s.owner, s.workspaceId);
    const dialog = await openMockExams(page);
    await mockUi.add(dialog).click();

    // Step 1: options (two steps 옵션 → 범위; four variation types).
    await expect(mockUi.steps(dialog).getByRole('listitem')).toHaveText([
      /옵션|options/i,
      /범위|range/i,
    ]);
    await expect(mockUi.variations(dialog)).toHaveCount(4);
    for (const type of [
      'OPTION_SHUFFLE',
      'PARAPHRASE',
      'INVERT_POLARITY',
      'ANALOGOUS_CONCEPT',
    ] as const) {
      await expect(mockUi.variation(dialog, type)).toBeVisible();
    }
    await fillOptions(dialog, '중간 점검', ['PARAPHRASE', 'INVERT_POLARITY'], 4);

    // Step 2: the range lists the six confirmed questions, never the drafts.
    await picker.selectAll(dialog).check();
    for (const chapter of [CH1, CH2]) await picker.expand(dialog, chapter).click();
    await expect(picker.questions(dialog)).toHaveCount(6);
    for (const draft of drafts) {
      await expect(dialog.getByText(draft.revision.stem.slice(0, 12))).toHaveCount(0);
    }
    await expect(dialog.getByText(makeText(6, 4))).toBeVisible();
    await expect(dialog.getByText(MOCK_TEXT.aiNotice)).toBeVisible();
    await mockUi.make(dialog).click();

    // Detail: 만드는 중 with "4개 중 k개", then 준비됨 with four questions.
    await expect(mockUi.heading(dialog, '중간 점검')).toBeVisible();
    await hold.held();
    await expect(dialog.getByText(STATUS_TEXT.generating).first()).toBeVisible();
    await expect(mockUi.progress(dialog)).toBeVisible();
    await expect(dialog).toContainText(progressText(4));
    hold.release();
    await expect(dialog.getByText(STATUS_TEXT.ready).first()).toBeVisible({
      timeout: MOCK_TIMEOUT_MS,
    });
    await expect(mockUi.questions(dialog)).toHaveCount(4);
    for (let k = 1; k <= 4; k += 1) {
      const row = questionRow(dialog, k);
      await expect(row).toContainText(/문구 변형|정오 반전|paraphrase|invert/i);
      await expect(row).toContainText(/[12]장 \d번/);
    }

    // Mock exam questions are the fake's variants, outside the bank.
    const exam = (await listMockExams(s.owner, s.workspaceId)).items[0] as MockExam;
    const items = await listMockQuestions(s.owner, exam.id);
    const scripted = new Set(NORMAL_SOURCES.flatMap((n) => scriptedStems(n)));
    expect(items.map((q) => scripted.has(q.stem))).toEqual([true, true, true, true]);
    const after = await getOverview(s.owner, s.workspaceId);
    expect(after.counts).toEqual(before.counts);
    expect(after.items.map((i) => i.question_id).sort()).toEqual(confirmed.map((q) => q.id).sort());
    expect((await listQuestions(s.owner, s.workspaceId)).length).toBe(bankBefore);

    await mockUi.backToList(dialog).click();
    const row = mockUi.row(dialog, '중간 점검');
    await expect(row).toContainText(STATUS_TEXT.ready);
    await expect(row).toContainText(/문제 4개|4 questions/i);
    await expect(row).toContainText(/문구 변형, 정오 반전|paraphrase, invert/i);
    await mockUi.close(dialog).click();
    await expect(overviewUi.markers(page)).toHaveCount(6);
  },
);

test(
  'MOCK-01-AC03 the range picker selects all, chapters and single questions with mixed states, follows filters and works by keyboard',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'mock01-ac03');
    const [favorite] = await seedSources(s, NORMAL_SOURCES);
    if (!favorite) throw new Error('no source');
    await setMyState(s.owner, favorite.id, { is_favorite: true });

    await openHome(page, s.owner, s.workspaceId);
    const dialog = await openMockExams(page);
    await mockUi.add(dialog).click();
    await fillOptions(dialog, '범위 점검', ['PARAPHRASE'], 4);

    const all = picker.selectAll(dialog);
    await all.check();
    await expect(picker.selected(dialog, 6)).toBeVisible();
    await picker.chapter(dialog, CH2).uncheck();
    await expect(picker.selected(dialog, 4)).toBeVisible();
    await expect(all).toHaveAttribute('aria-checked', 'mixed');
    await picker.expand(dialog, CH1).click();
    await expect(picker.expand(dialog, CH1)).toHaveAttribute('aria-expanded', 'true');
    await picker.question(dialog, 1, 2).uncheck();
    await expect(picker.chapter(dialog, CH1)).toHaveAttribute('aria-checked', 'mixed');
    await expect(picker.selected(dialog, 3)).toBeVisible();

    // A filter keeps only the visible questions in the selection.
    await openRangeFilters(dialog);
    await picker.favoriteFilter(dialog).click();
    await expect(picker.questions(dialog)).toHaveCount(1);
    await expect(picker.selected(dialog, 1)).toBeVisible();
    await picker.favoriteFilter(dialog).click();
    await expect(picker.selected(dialog, 1)).toBeVisible();

    await all.click();
    await expect(picker.selected(dialog, 6)).toBeVisible();
    await all.click();
    await expect(picker.selected(dialog, 0)).toBeVisible();
    await expect(mockUi.make(dialog)).toBeDisabled();
    await expect(dialog.getByText(MOCK_TEXT.noRange)).toBeVisible();

    // The same with the keyboard only (Space toggles, Tab moves on).
    await all.focus();
    await page.keyboard.press('Space');
    await expect(picker.selected(dialog, 6)).toBeVisible();
    await picker.chapter(dialog, CH2).focus();
    await page.keyboard.press('Space');
    await expect(picker.selected(dialog, 4)).toBeVisible();
    await expect(all).toHaveAttribute('aria-checked', 'mixed');
    await picker.question(dialog, 1, 3).focus();
    await page.keyboard.press('Space');
    await expect(picker.chapter(dialog, CH1)).toHaveAttribute('aria-checked', 'mixed');
    await expect(picker.selected(dialog, 3)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await all.focus();
    await page.keyboard.press('Space');
    await expect(picker.selected(dialog, 6)).toBeVisible();
    await page.keyboard.press('Space');
    await expect(picker.selected(dialog, 0)).toBeVisible();
    await expect(mockUi.make(dialog)).toBeDisabled();
  },
);

test(
  'MOCK-01-AC04 a mock exam is saved, renamed in place and deleted after a confirmation; its URL then says not found',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'mock01-ac04');
    await seedSources(s, NORMAL_SOURCES);
    const exam = await createMockExam(s.owner, s.workspaceId, '중간 점검', {
      variation_types: ['PARAPHRASE', 'INVERT_POLARITY'],
      question_count: 4,
    });
    const doomed = await createMockExam(s.owner, s.workspaceId, '지울 모의고사', {
      variation_types: ['OPTION_SHUFFLE'],
      question_count: 2,
    });
    await waitForMockExam(s.owner, exam.id);
    await waitForMockExam(s.owner, doomed.id);

    await openHome(page, s.owner, s.workspaceId);
    await page.reload();
    let dialog = await openMockExams(page);
    await expect(mockUi.count(dialog, 2)).toBeVisible();
    await mockUi.open(mockUi.row(dialog, '중간 점검'), '중간 점검').click();
    await expect(mockUi.questions(dialog)).toHaveCount(4);
    await mockUi.backToList(dialog).click();

    // Escape in the rename field cancels only the rename: the dialog stays open and focus goes
    // back to the row menu that started it. The next Escape closes the dialog.
    const rowMenu = mockUi.rowMenu(mockUi.row(dialog, '중간 점검'), '중간 점검');
    await rowMenu.click();
    await mockUi.menuAction(page, /^(이름 바꾸기|rename)$/i).click();
    const field = mockUi.renameField(dialog);
    await field.fill('버릴 이름');
    await field.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(mockUi.row(dialog, '중간 점검')).toBeVisible();
    await expect(rowMenu).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    dialog = await openMockExams(page);

    // Rename in place (Enter saves); it sticks after a reload.
    await mockUi.rowMenu(mockUi.row(dialog, '중간 점검'), '중간 점검').click();
    await mockUi.menuAction(page, /^(이름 바꾸기|rename)$/i).click();
    await field.fill('기말 대비');
    await field.press('Enter');
    await expect(mockUi.row(dialog, '기말 대비')).toBeVisible();
    await mockUi.open(mockUi.row(dialog, '기말 대비'), '기말 대비').click();
    await expect(mockUi.heading(dialog, '기말 대비')).toBeVisible();
    // The detail header's rename: Escape cancels it and focus returns to `더보기`.
    await mockUi.chooseDetailAction(dialog, 'rename');
    await mockUi.renameField(dialog).fill('버릴 이름');
    await mockUi.renameField(dialog).press('Escape');
    await expect(mockUi.renameField(dialog)).toHaveCount(0);
    await expect(mockUi.heading(dialog, '기말 대비')).toBeVisible();
    await expect(mockUi.more(dialog)).toBeFocused();
    await page.reload();
    dialog = mockUi.dialog(page);
    await expect(mockUi.heading(dialog, '기말 대비')).toBeVisible();
    expect((await getMockExam(s.owner, exam.id)).title).toBe('기말 대비');
    await mockUi.backToList(dialog).click();

    // Delete after the confirmation dialog.
    await mockUi.rowMenu(mockUi.row(dialog, '지울 모의고사'), '지울 모의고사').click();
    await mockUi.menuAction(page, /^(삭제|delete)$/i).click();
    const confirm = mockUi.confirm(page);
    await expect(confirm).toContainText(/지울 모의고사.*삭제할까요|delete/i);
    await mockUi.confirmButton(confirm).click();
    await expect(mockUi.row(dialog, '지울 모의고사')).toHaveCount(0);
    await expect(mockUi.count(dialog, 1)).toBeVisible();

    await page.goto(mockExamsPath(s.workspaceId, doomed.id));
    await expect(mockUi.dialog(page).getByText(MOCK_TEXT.notFound)).toBeVisible();
    expect((await s.owner.api.request('GET', `/mock-exams/${doomed.id}`)).status).toBe(404);
  },
);

test(
  'MOCK-01-AC05 editors edit a question in the manage viewer and remove one; viewers see neither the actions nor the answers',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'mock01-ac05');
    await seedSources(s, NORMAL_SOURCES);
    const viewer = await workspaceFactory.member('mock01-ac05-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    const exam = await createMockExam(
      s.owner,
      s.workspaceId,
      '편집 점검',
      { variation_types: ['PARAPHRASE'], question_count: 4 },
      chaptersRange(s.ch1),
    );
    await waitForMockExam(s.owner, exam.id);
    const [first, second] = await listMockQuestions(s.owner, exam.id, true);
    if (!first || !second) throw new Error('expected four questions');
    await practiseMockQuestion(s.owner, first.id, first.correct_option_ids ?? []);

    await openHome(page, s.owner, s.workspaceId);
    await page.goto(mockExamsPath(s.workspaceId, exam.id));
    const dialog = mockUi.dialog(page);
    await expect(mockUi.heading(dialog, '편집 점검')).toBeVisible();
    await questionRow(dialog, 1).click();
    let viewerPanel = mockUi.viewer(page, 1);
    await expect(viewerPanel).toBeVisible();
    await expect(viewerPanel).toContainText(first.explanation ?? '');
    await expect(viewerPanel.getByText(/^(정답|correct)$/i).first()).toBeVisible();

    await mockUi.edit(viewerPanel).click();
    const form = questionFormUi.form(page);
    await questionFormUi.stem(form).fill(`${first.stem} (고친 발문)`);
    await form.getByRole('textbox', { name: /해설|explanation/i }).fill('고친 해설입니다.');
    await questionFormUi.save(form).click();
    await expect(viewerPanel).toContainText('(고친 발문)');
    await expect(viewerPanel).toContainText('고친 해설입니다.');
    await page.keyboard.press('Escape');
    await expect(questionRow(dialog, 1).getByText(MOCK_TEXT.edited)).toBeVisible();
    const edited = (await listMockQuestions(s.owner, exam.id, true))[0];
    expect(edited?.revision.version).toBe(2);
    expect(edited?.edited).toBe(true);

    await questionRow(dialog, 2).click();
    await mockUi.remove(mockUi.viewer(page, 2)).click();
    await mockUi.confirmButton(mockUi.confirm(page)).click();
    await expect(mockUi.questions(dialog)).toHaveCount(3);
    await expect(dialog).toContainText(/문제 3개|3 questions/i);
    const left = await listMockQuestions(s.owner, exam.id);
    expect(left.map((q) => q.id)).not.toContain(second.id);

    await questionRow(dialog, 1).click();
    viewerPanel = mockUi.viewer(page, 1);
    await expect(viewerPanel).toContainText('(고친 발문)');
    await page.keyboard.press('Escape');

    // A viewer: no editing actions; a row shows no answer or explanation.
    await switchUser(page, viewer, s.workspaceId);
    await page.goto(mockExamsPath(s.workspaceId, exam.id));
    const viewerDialog = mockUi.dialog(page);
    await expect(mockUi.heading(viewerDialog, '편집 점검')).toBeVisible();
    await expect(mockUi.more(viewerDialog)).toHaveCount(0);
    await questionRow(viewerDialog, 1).click();
    const preview = mockUi.viewer(page, 1);
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('(고친 발문)');
    await expect(mockUi.edit(preview)).toHaveCount(0);
    await expect(mockUi.remove(preview)).toHaveCount(0);
    await expect(preview.getByText('고친 해설입니다.')).toHaveCount(0);
    await expect(preview.getByText(/^(정답|correct)$/i)).toHaveCount(0);
    const res = await viewer.api.request('GET', `/mock-exams/${exam.id}/questions?include=answers`);
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      expect((res.body as { items?: unknown[] } | undefined)?.items?.length).toBe(3);
      expect(answerKeysIn(res.body)).toEqual([]);
    }
    const plain = await listMockQuestions(viewer, exam.id);
    expect(plain).toHaveLength(3);
    expect(answerKeysIn(plain)).toEqual([]);
  },
);

test(
  'MOCK-01-AC06 다시 만들기 with new settings replaces the questions as a new round; a failed round keeps them',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'mock01-ac06');
    const hold = new MockHold();
    await seedSources(s, ['evaporation', 'condensation', 'precipitation', 'infiltration']);
    // 2장: the shuffle-only round uses them; their AI round fails (provider unavailable).
    const ch2 = await seedSources(s, ['down-chlorine', 'down-raw'], 5, hold);
    const exam = await createMockExam(
      s.owner,
      s.workspaceId,
      '다시 만들기 점검',
      { variation_types: ['PARAPHRASE'], question_count: 4 },
      chaptersRange(s.ch1),
    );
    expect((await waitForMockExam(s.owner, exam.id)).status).toBe('ready');

    await openHome(page, s.owner, s.workspaceId);
    await page.goto(mockExamsPath(s.workspaceId, exam.id));
    const dialog = mockUi.dialog(page);
    await expect(mockUi.questions(dialog)).toHaveCount(4);

    // 설정 바꾸기: 보기 섞기 only, 2장 only → 다시 만들기 (confirmed).
    await mockUi.chooseDetailAction(dialog, 'settings');
    await mockUi.variation(dialog, 'PARAPHRASE').uncheck();
    await mockUi.variation(dialog, 'OPTION_SHUFFLE').check();
    await mockUi.questionCount(dialog).fill('2');
    await mockUi.next(dialog).click();
    await picker.chapter(dialog, CH1).uncheck();
    await picker.chapter(dialog, CH2).check();
    await mockUi.remake(dialog).click();
    let confirm = mockUi.confirm(page);
    await expect(confirm).toContainText(MOCK_TEXT.replaceConfirm);
    await expect(confirm).toContainText(/문제 4개|4 questions/i);
    await mockUi.confirmButton(confirm).click();
    await expect(dialog).toContainText(/2회차|round 2/i, { timeout: MOCK_TIMEOUT_MS });
    await expect(mockUi.questions(dialog)).toHaveCount(2);
    for (const row of await mockUi.questions(dialog).all()) {
      await expect(row).toContainText(VARIATION_LABEL.OPTION_SHUFFLE);
      await expect(row).toContainText(/2장 [56]번/);
    }
    const shuffled = await listMockQuestions(s.owner, exam.id);
    expect(shuffled.map((q) => q.source.question_id).sort()).toEqual(ch2.map((q) => q.id).sort());

    // The changed settings survive a reload.
    await page.reload();
    await mockUi.chooseDetailAction(dialog, 'settings');
    await expect(mockUi.variation(dialog, 'OPTION_SHUFFLE')).toBeChecked();
    await expect(mockUi.variation(dialog, 'PARAPHRASE')).not.toBeChecked();
    await mockUi.next(dialog).click();
    await expect(picker.chapter(dialog, CH2)).toBeChecked();
    await expect(picker.chapter(dialog, CH1)).not.toBeChecked();

    // A failing round (문구 변형 on 2장, provider unavailable): progress over the old questions,
    // then the alert; the 2회차 questions stay.
    await mockUi.previous(dialog).click();
    await mockUi.variation(dialog, 'OPTION_SHUFFLE').uncheck();
    await mockUi.variation(dialog, 'PARAPHRASE').check();
    await mockUi.next(dialog).click();
    await mockUi.remake(dialog).click();
    confirm = mockUi.confirm(page);
    await mockUi.confirmButton(confirm).click();
    await hold.held();
    await expect(mockUi.progress(dialog)).toBeVisible();
    await expect(mockUi.questions(dialog)).toHaveCount(2);
    hold.release();
    await expect(mockUi.alert(dialog)).toBeVisible({ timeout: MOCK_TIMEOUT_MS });
    await expect(mockUi.alert(dialog)).toContainText(MOCK_TEXT.llmUnavailable);
    await expect(mockUi.retry(dialog)).toBeVisible();
    await expect(mockUi.questions(dialog)).toHaveCount(2);
    await expect(dialog).toContainText(/2회차|round 2/i);
    const kept = await getMockExam(s.owner, exam.id);
    expect(kept.latest_generation?.error_code).toBe('llm_unavailable');
    expect(kept.current_generation?.version).toBe(2);
  },
);

test(
  'MOCK-01-AC07 viewers only list and practise, archived workspaces are read-only, share guests see no entry and other workspaces get 404',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'mock01-ac07');
    await seedSources(s, NORMAL_SOURCES);
    const exam = await createMockExam(s.owner, s.workspaceId, '권한 점검', {
      variation_types: ['OPTION_SHUFFLE'],
      question_count: 3,
    });
    await waitForMockExam(s.owner, exam.id);
    const viewer = await workspaceFactory.member('mock01-ac07-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    const outsider = await workspaceFactory.member('mock01-ac07-outsider');
    await workspaceFactory.create(outsider);

    // Viewer: the list, 풀기 and 추가 for a variation-free run; writes are 403.
    await openHome(page, viewer, s.workspaceId);
    let dialog = await openMockExams(page);
    const row = mockUi.row(dialog, '권한 점검');
    await expect(row).toBeVisible();
    await expect(mockUi.practise(row)).toBeVisible();
    await expect(mockUi.add(dialog)).toHaveCount(1);
    await expect(mockUi.rowMenu(row, '권한 점검')).toHaveCount(0);
    const config = { variation_types: ['OPTION_SHUFFLE'] as VariationType[], question_count: 1 };
    await expectProblem(
      await createMockExamRequest(viewer, s.workspaceId, { title: 'x', config, range: ALL }),
      403,
      MOCK_PROBLEMS.insufficientRole,
    );
    await expectProblem(
      await viewer.api.request('PATCH', `/mock-exams/${exam.id}`, { title: 'x' }),
      403,
      MOCK_PROBLEMS.insufficientRole,
    );
    await expectProblem(
      await viewer.api.request('DELETE', `/mock-exams/${exam.id}`),
      403,
      MOCK_PROBLEMS.insufficientRole,
    );

    // Share guest: no 모의고사 entry on the share page.
    const link = await createShareLink(s.owner, s.workspaceId);
    await page.context().clearCookies();
    await openShareWithSecret(page, link.id, link.secret);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /모의고사|mock exam/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /모의고사|mock exam/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /모의고사|mock exam/i })).toHaveCount(0);

    // Another workspace's editor: 404 on read and write.
    expect((await outsider.api.request('GET', `/mock-exams/${exam.id}`)).status).toBe(404);
    expect(
      (await outsider.api.request('PATCH', `/mock-exams/${exam.id}`, { title: 'x' })).status,
    ).toBe(404);

    // Archived workspace: the owner reads and opens 풀기, but cannot write or submit.
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await switchUser(page, s.owner, s.workspaceId);
    dialog = await openMockExams(page);
    const archivedRow = mockUi.row(dialog, '권한 점검');
    await expect(archivedRow).toBeVisible();
    await expect(mockUi.add(dialog)).toHaveCount(1);
    await expect(mockUi.rowMenu(archivedRow, '권한 점검')).toHaveCount(0);
    await mockUi.open(archivedRow, '권한 점검').click();
    await expect(mockUi.more(dialog)).toHaveCount(0);
    await mockUi.practise(dialog).click();
    const practice = mockUi.practicePanel(page);
    await expect(mockUi.practiceTitle(practice, '권한 점검')).toBeVisible();
    await practice.getByRole('button', { name: /^(시작|start)$/i }).click();
    await practice.getByRole('radio').first().check();
    await expect(practice.getByRole('button', { name: /^(제출|submit)/i })).toBeDisabled();
    await expectProblem(
      await createMockExamRequest(s.owner, s.workspaceId, { title: 'x', config, range: ALL }),
      403,
      MOCK_PROBLEMS.archived,
    );
    await expectProblem(
      await s.owner.api.request('PATCH', `/mock-exams/${exam.id}`, { title: 'x' }),
      403,
      MOCK_PROBLEMS.archived,
    );
    await expectProblem(
      await s.owner.api.request('POST', `/mock-exams/${exam.id}/generations`, {}),
      403,
      MOCK_PROBLEMS.archived,
    );
  },
);

test(
  'MOCK-01-AC08 failed items are dropped, a broken batch is split and recovered, all-failed ranges fail, and without the LLM only 보기 섞기 is offered',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await bookWorkspace(workspaceFactory, 'mock01-ac08');
    await seedSources(s, ['inv-runoff', 'inv-filtration', 'inv-multi']);
    await seedSources(s, ['brk-sediment', 'brk-backwash', 'brk-cloud', 'brk-snow'], 4);
    await seedSources(s, ['fail-quote', 'fail-answer'], 8);
    const exams = async (title: string) =>
      (await listMockExams(s.owner, s.workspaceId)).items.find((e) => e.title === title);

    await openHome(page, s.owner, s.workspaceId);
    const dialog = await openMockExams(page);

    // 정오 반전 × 3 in one call: the multi-answer inversion fails twice and is dropped.
    await createInUi(dialog, '정오 반전 점검', ['INVERT_POLARITY'], 3, [CH1]);
    await expect(dialog.getByText(STATUS_TEXT.partial).first()).toBeVisible({
      timeout: MOCK_TIMEOUT_MS,
    });
    await expect(dialog.getByText(partialText(3, 2))).toBeVisible();
    await expect(mockUi.questions(dialog)).toHaveCount(2);
    const [multiStem] = scriptedStems('inv-multi');
    if (!multiStem) throw new Error('inv-multi has no scripted item');
    await expect(dialog.getByText(multiStem.slice(0, 20))).toHaveCount(0);
    const inverted = await exams('정오 반전 점검');
    if (!inverted?.latest_generation) throw new Error('no generation');
    const invQuestions = await listMockQuestions(s.owner, inverted.id, true);
    expect(invQuestions).toHaveLength(2);
    expect(invQuestions.map((q) => q.stem)).not.toContain(multiStem);
    expect(await llmCalls(s.owner, inverted.latest_generation)).toBe(2);

    // A batch the model cannot answer as a whole: halved once, every source recovered.
    await mockUi.backToList(dialog).click();
    await createInUi(dialog, '깨진 묶음 점검', ['PARAPHRASE'], 4, [CH2]);
    await expect(dialog.getByText(STATUS_TEXT.ready).first()).toBeVisible({
      timeout: MOCK_TIMEOUT_MS,
    });
    await expect(mockUi.questions(dialog)).toHaveCount(4);
    const broken = await exams('깨진 묶음 점검');
    if (!broken?.latest_generation) throw new Error('no generation');
    expect(await llmCalls(s.owner, broken.latest_generation)).toBe(3);

    // Every candidate fails validation: 실패 with the reason.
    await mockUi.backToList(dialog).click();
    await createInUi(dialog, '전부 실패 점검', ['PARAPHRASE'], 2, [NO_CHAPTER]);
    await expect(mockUi.alert(dialog)).toBeVisible({ timeout: MOCK_TIMEOUT_MS });
    await expect(mockUi.alert(dialog)).toContainText(MOCK_TEXT.noValid);
    await expect(dialog.getByText(STATUS_TEXT.failed).first()).toBeVisible();
    await expect(mockUi.questions(dialog)).toHaveCount(0);

    // The LLM-off stack: AI types disabled with the reason; 보기 섞기 alone still works.
    const off = await startMockExamsOffStack();
    try {
      await page.goto(`${off.webUrl}${mockExamsPath(s.workspaceId)}`);
      const offDialog = mockUi.dialog(page);
      await expect(offDialog).toBeVisible();
      await mockUi.add(offDialog).click();
      for (const type of ['PARAPHRASE', 'INVERT_POLARITY', 'ANALOGOUS_CONCEPT'] as const) {
        const box = mockUi.variation(offDialog, type);
        await expect(box).toHaveCount(0);
      }
      await expect(mockUi.variation(offDialog, 'OPTION_SHUFFLE')).toBeEnabled();
      await fillOptions(offDialog, '섞기만', ['OPTION_SHUFFLE'], 2);
      await picker.chapter(offDialog, CH1).check();
      await mockUi.make(offDialog).click();
      await expect(offDialog.getByText(STATUS_TEXT.ready).first()).toBeVisible({
        timeout: MOCK_TIMEOUT_MS,
      });
      await expect(mockUi.questions(offDialog)).toHaveCount(2);
      const listed = await off.request<{ llm_available: boolean }>(
        s.owner,
        'GET',
        `/workspaces/${s.workspaceId}/mock-exams`,
      );
      expect(listed.status).toBe(200);
      expect(listed.body?.llm_available).toBe(false);
    } finally {
      await off.stop();
    }
  },
);
