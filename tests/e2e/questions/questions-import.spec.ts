// QIMPORT-01 — 문제 PDF 가져오기 (`/workspaces/:workspaceId/questions/import`),
// docs/screens/questions-import.md; import rules docs/questions.md §6 (drafts isolated until a
// human approves them, answers only from the PDF's own answer key — never invented — and page
// provenance), AGENTS.md §5 (imported questions stay drafts until approved).
//
// Each test signs in its own owner, uploads the synthetic `questions-ko.pdf` (8 questions, answer
// key for 1, 2, 4, 5, 8 only; tests/fixtures/pdfs/questions-ko.truth.json) through the home's
// 문서 관리 dialog (UX6-UPLOAD: the one upload place; the server classifies it as 문제지 and starts
// the extraction), follows its `문제 검토` link to the import page and waits for the import job; E2E runs the worker with the deterministic fake LLM adapter
// (docs/e2e-strategy.md §3, §6). Draft/bank state is checked through the public API
// (fixtures/questions.ts, whose header lists the endpoint/label assumptions, incl. A5: the AC's
// "5 questions" becomes the paper's 8). Failures: a job failure comes from the APP_ENV=test fake
// extractor via the IMPORT_FAILURE_MARKER file name (A7); a network failure drops a response the
// server already produced.
import { mkdirSync } from 'node:fs';
import type { Locator, Page, Route } from '@playwright/test';
import { localEndpoints } from '../fixtures/local-env.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';
import {
  bankPath,
  bankUi,
  chooseQuestionMenu,
  draftFor,
  expect,
  docUi,
  expectProgressSteps,
  failingOnceCopy,
  forgetImportRuns,
  homePath,
  homeUi,
  importPaperDrafts,
  importPath,
  importUi,
  JOB_TIMEOUT_MS,
  waitForImportStatus,
  listDocuments,
  bookChapterOptions,
  listDrafts,
  listImports,
  listQuestions,
  main,
  pageLabel,
  progressStepsUi,
  questionFormUi,
  questionPaper,
  seedBookChapters,
  seedImportDraftCopies,
  setDocumentKind,
  signInAs,
  startImport,
  test,
  truthQuestion,
  uploadPdf,
  uploadQuestionPaper,
  uploadReadyBook,
  waitForJob,
  waitForLatestImport,
  type Draft,
  type TruthQuestion,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 60_000 });

const PAPER = questionPaper();
const Q = (n: number): TruthQuestion => truthQuestion(PAPER, n);
/** The paper's only outline node (its title heading, questions-ko.truth.json `title`). */
const PAPER_CHAPTER = '제1회 합성 확인 평가 — 물의 순환과 정수 처리';
const UNANSWERED = PAPER.questions.filter((q) => q.answer === null); // 3 (MCQ), 6, 7

/** Owner + workspace, questions-ko.pdf imported through the UI, drafts listed by the API. */
async function importPaper(page: Page, workspaceFactory: WorkspaceFactory, label: string) {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  expect(await listImports(owner, ws.id)).toEqual([]);

  await signInAs(page, owner.user);
  await uploadQuestionPaper(page, ws.id, PAPER);
  await expect(importUi.heading(page)).toHaveText(/문제 pdf 가져오기|가져오기|import/i);
  await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length, {
    timeout: JOB_TIMEOUT_MS,
  });

  const run = await waitForLatestImport(owner, ws.id);
  const drafts = await listDrafts(owner, run.id);
  return { owner, workspaceId: ws.id, run, drafts };
}

function optionIds(draft: Draft, texts: readonly string[]): string[] {
  return texts.map((text) => {
    const option = draft.payload.options.find((o) => o.text === text);
    if (!option) throw new Error(`draft has no option "${text}"`);
    return option.id;
  });
}

function truthOptionTexts(q: TruthQuestion, labels: readonly string[]): string[] {
  return labels.map((label) => q.options.find((o) => o.label === label)?.text ?? label);
}

test(
  'QIMPORT-01-AC01 importing a question PDF shows one draft per question, each linked to its PDF page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, run, drafts } = await importPaper(
      page,
      workspaceFactory,
      'qimport01-ac01',
    );

    for (const q of PAPER.questions) {
      const item = importUi.draft(page, q.stem);
      await expect(item, `question ${q.number}`).toHaveCount(1);
      await expect(item, `question ${q.number}`).toContainText(importUi.number(q.number));
      await expect(item.getByText(pageLabel(q.page)).first(), `question ${q.number}`).toBeVisible();
    }

    // Compare view: the draft next to its source page.
    const q5 = Q(5);
    await importUi.compare(importUi.draft(page, q5.stem)).click();
    await expect(importUi.sourceView(page)).toBeVisible();
    await expect(importUi.sourceView(page)).toContainText(pageLabel(q5.page));

    // Server: 8 pending drafts with page provenance into the uploaded PDF.
    expect(drafts).toHaveLength(PAPER.questions.length);
    for (const q of PAPER.questions) {
      const draft = draftFor(drafts, q);
      expect(draft.question_type, `question ${q.number}`).toBe(q.question_type);
      expect(draft.review_status).toBe('pending');
      expect(draft.published_question_id).toBeNull();
      expect(draft.payload.options.map((o) => o.text)).toEqual(q.options.map((o) => o.text));
      const ids = draft.payload.options.map((o) => o.id);
      expect(new Set(ids).size, `unique option ids of question ${q.number}`).toBe(ids.length);
      const evidence = draft.payload.evidence[0];
      expect(evidence?.document_id).toBe(run.source_document_id);
      expect(evidence?.locations.map((l) => l.page)).toContain(q.page);
    }

    // Drafts are isolated: nothing is in the bank yet.
    expect(await listQuestions(owner, workspaceId)).toEqual([]);
    await page.goto(bankPath(workspaceId));
    await expect(bankUi.emptyState(page)).toBeVisible();
  },
);

test(
  'QIMPORT-01-AC01 the steps show as they pass: the upload in 문서 관리, then 업로드 → PDF 분석 → 문제 추출 on the import page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(2 * JOB_TIMEOUT_MS + 60_000);
    const owner = await workspaceFactory.member('qimport01-ac01-steps');
    const ws = await workspaceFactory.create(owner);
    mkdirSync(test.info().outputDir, { recursive: true });
    // Its first extraction job fails (fake extractor, A7), so the page itself restarts one.
    const failing = failingOnceCopy(PAPER, test.info().outputDir);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, 'panel=documents'));

    // UX6-UPLOAD: uploads happen in 문서 관리. Hold the Storage upload to see its step.
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => (releaseUpload = resolve));
    await page.route(`${localEndpoints().supabaseUrl}/storage/v1/**`, async (route: Route) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.fallback();
      await uploadGate;
      await route.fallback();
    });
    const chooser = page.waitForEvent('filechooser');
    await docUi.uploadButton(page).click();
    await (await chooser).setFiles(failing.path);
    const row = homeUi
      .documentsDialog(page)
      .getByRole('listitem')
      .filter({ hasText: /questions-ko/ });
    await expectProgressSteps(row, [
      [/업로드|upload/i, 'current'],
      [/분석|analy/i, 'pending'],
      [/색인|index/i, 'pending'],
    ]);
    releaseUpload();
    await docUi.reviewLink(row).click({ timeout: JOB_TIMEOUT_MS });
    await expect(importUi.alert(page)).toContainText(/실패|오류|failed|error/i, {
      timeout: JOB_TIMEOUT_MS,
    });

    // Hold the job progress the page follows, so the extraction step is observable.
    let releaseJobs!: () => void;
    const jobGate = new Promise<void>((resolve) => (releaseJobs = resolve));
    await page.route('**/api/jobs/**', async (route: Route) => {
      await jobGate;
      await route.fallback();
    });
    await importUi.retry(page).click();
    const scope = main(page);
    await expect(importUi.progress(page)).toBeVisible();
    await expectProgressSteps(scope, [
      [/업로드|upload/i, 'done'],
      [/pdf 분석|analy/i, 'done'],
      [/문제 추출|extract/i, 'current'],
    ]);
    // One bar split into the steps: it never drops back to an earlier step's level.
    await expect(importUi.progress(page)).toHaveAttribute('aria-valuetext', /^3\/3단계/);

    releaseJobs();
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length, {
      timeout: 2 * JOB_TIMEOUT_MS,
    });
    await expect(progressStepsUi.list(scope)).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
);

test(
  'QIMPORT-01-AC02 questions the answer key does not cover keep a null answer; covered ones match the key',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { drafts } = await importPaper(page, workspaceFactory, 'qimport01-ac02');
    expect(UNANSWERED.map((q) => q.number)).toEqual([3, 6, 7]);

    for (const q of UNANSWERED) {
      const draft = draftFor(drafts, q);
      expect(draft.payload.correct_option_ids, `question ${q.number}`).toBeNull();
      expect(draft.payload.accepted_answers, `question ${q.number}`).toBeNull();
      await expect(
        importUi.noAnswer(importUi.draft(page, q.stem)),
        `question ${q.number}`,
      ).toBeVisible();
    }

    for (const q of PAPER.questions.filter((x) => x.answer !== null)) {
      const draft = draftFor(drafts, q);
      const labels = q.answer?.correct_option_labels;
      if (labels) {
        expect(draft.payload.correct_option_ids, `question ${q.number}`).toEqual(
          optionIds(draft, truthOptionTexts(q, labels)),
        );
      } else {
        expect(draft.payload.accepted_answers, `question ${q.number}`).toEqual(
          q.answer?.accepted_answers,
        );
      }
      await expect(
        importUi.noAnswer(importUi.draft(page, q.stem)),
        `question ${q.number}`,
      ).toHaveCount(0);
    }
  },
);

test(
  'QIMPORT-01-AC03 only reviewed and selected drafts are approved and registered in the bank, one marker each',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, run } = await importPaper(page, workspaceFactory, 'qimport01-ac03');
    expect(await listQuestions(owner, workspaceId)).toEqual([]);

    // Select 1 and 2 as extracted; 3 (no answer in the key) cannot be selected until completed by
    // hand. Selecting sends nothing (QIMP-BULK): approval happens with the registration.
    const writes: string[] = [];
    page.on('request', (r) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method())) writes.push(new URL(r.url()).pathname);
    });
    await importUi.select(importUi.draft(page, Q(1).stem)).check();
    await importUi.select(importUi.draft(page, Q(2).stem)).check();
    const q3 = importUi.draft(page, Q(3).stem);
    await expect(importUi.select(q3)).toBeDisabled();
    expect(writes).toEqual([]);
    await importUi.edit(q3).click();
    const form = questionFormUi.form(page);
    const evaporation = Q(3).options.findIndex((o) => o.text === '증발') + 1;
    await questionFormUi.correct(form, evaporation).check();
    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();
    await expect(importUi.noAnswer(q3)).toHaveCount(0);
    await importUi.select(q3).check();
    expect(writes.filter((w) => w.endsWith('/publish'))).toEqual([]);
    for (const t of PAPER.questions) {
      const draft = draftFor(await listDrafts(owner, run.id), t);
      expect(draft.review_status, `question ${t.number} before registering`).toBe('pending');
    }

    await expect(importUi.publish(page)).toContainText(/\(3\)/);
    await importUi.publish(page).click();
    await expect(importUi.alert(page).or(page.getByRole('status')).first()).toContainText(
      /3\s*(개|문제).*(등록|확정)|registered 3|3 (questions )?(registered|published)/i,
    );

    const approved = [Q(1), Q(2), Q(3)];
    const bank = await listQuestions(owner, workspaceId);
    expect(bank).toHaveLength(approved.length);
    expect(bank.every((q) => q.publication_status === 'CONFIRMED')).toBe(true);
    for (const t of approved) {
      const question = bank.find((q) => q.revision.stem.includes(t.stem));
      expect(question, `question ${t.number} is in the bank`).toBeDefined();
      expect(question?.sources.map((s) => s.page_start)).toContain(t.page);
    }
    const q3Question = bank.find((q) => q.revision.stem.includes(Q(3).stem));
    const q3Evaporation = q3Question?.revision.options.find((o) => o.text === '증발');
    expect(q3Question?.revision.correct_option_ids).toEqual([q3Evaporation?.id]);

    const drafts = await listDrafts(owner, run.id);
    for (const t of PAPER.questions) {
      const draft = draftFor(drafts, t);
      if (approved.includes(t)) {
        expect(draft.review_status, `question ${t.number}`).toBe('approved');
        expect(bank.map((q) => q.id)).toContain(draft.published_question_id);
      } else {
        expect(draft.review_status, `question ${t.number}`).toBe('pending');
        expect(draft.published_question_id, `question ${t.number}`).toBeNull();
      }
    }

    await page.goto(bankPath(workspaceId));
    await expect(bankUi.items(page)).toHaveCount(approved.length);
    for (const t of PAPER.questions.filter((x) => !approved.includes(x))) {
      await expect(bankUi.item(page, t.stem), `question ${t.number}`).toHaveCount(0);
    }
  },
);

test(
  'QIMPORT-01-AC03 전체 선택 selects every registrable draft and 선택한 문제 승인 및 등록 registers them in one action',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, run } = await importPaper(page, workspaceFactory, 'qimport01-bulk');
    // Drafts without an answer in the key (3, 6, 7) are left out: 3 (MCQ) cannot be confirmed,
    // 6 and 7 (short answer, essay) only by an explicit, individual choice.
    const registrable = PAPER.questions.filter((q) => q.answer !== null);
    const all = importUi.selectAll(page);
    await expect(all).toHaveAccessibleName(new RegExp(`\\(${registrable.length}개\\)`));
    await expect(all).not.toBeChecked();

    await all.check();
    await expect(all).toBeChecked();
    for (const t of registrable)
      await expect(importUi.select(importUi.draft(page, t.stem))).toBeChecked();
    for (const t of UNANSWERED) {
      await expect(importUi.select(importUi.draft(page, t.stem))).not.toBeChecked();
    }
    await expect(importUi.select(importUi.draft(page, Q(3).stem))).toBeDisabled();
    // Partly selected: the select-all box shows the mixed state.
    const first = importUi.select(importUi.draft(page, Q(1).stem));
    await first.uncheck();
    await expect(all).toHaveAttribute('aria-checked', 'mixed');
    await first.check();
    await expect(all).toBeChecked();
    // Nothing was approved by checking.
    expect((await listDrafts(owner, run.id)).every((d) => d.review_status === 'pending')).toBe(
      true,
    );

    await expect(importUi.publish(page)).toContainText(new RegExp(`\\(${registrable.length}\\)`));
    await importUi.publish(page).click();
    await expect(importUi.alert(page).or(page.getByRole('status')).first()).toContainText(
      new RegExp(`${registrable.length}\\s*개.*등록`),
    );

    const bank = await listQuestions(owner, workspaceId);
    expect(bank).toHaveLength(registrable.length);
    const drafts = await listDrafts(owner, run.id);
    for (const t of PAPER.questions) {
      const draft = draftFor(drafts, t);
      if (registrable.includes(t)) {
        expect(draft.review_status, `question ${t.number}`).toBe('approved');
        expect(bank.map((q) => q.id)).toContain(draft.published_question_id);
      } else {
        expect(draft.review_status, `question ${t.number}`).toBe('pending');
        expect(draft.published_question_id, `question ${t.number}`).toBeNull();
      }
    }
    // Registered drafts leave the selection; nothing is left for "전체 선택".
    await expect(importUi.selectAll(page)).toHaveAccessibleName(/\(0개\)/);
    await expect(importUi.selectAll(page)).toBeDisabled();
    await expect(importUi.publish(page)).toContainText(/\(0\)/);
    for (const t of registrable) {
      await expect(importUi.draft(page, t.stem)).toContainText(/등록됨|registered/i);
    }

    await page.goto(bankPath(workspaceId));
    await expect(bankUi.items(page)).toHaveCount(registrable.length);
  },
);

test(
  'QIMPORT-01-AC04 retrying a failed import job yields each draft once and publishing registers unique questions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac04-job');
    const ws = await workspaceFactory.create(owner);
    expect(await listImports(owner, ws.id)).toEqual([]);
    mkdirSync(test.info().outputDir, { recursive: true });
    const failing = failingOnceCopy(PAPER, test.info().outputDir);

    await signInAs(page, owner.user);
    await uploadQuestionPaper(page, ws.id, failing);

    // The first job fails after persisting part of the drafts (fake extractor, A7).
    await expect
      .poll(async () => (await listImports(owner, ws.id)).length, { timeout: JOB_TIMEOUT_MS })
      .toBe(1);
    const [run] = await listImports(owner, ws.id);
    if (!run) throw new Error('no import run');
    await waitForImportStatus(owner, run.id, 'failed');
    await expect(importUi.alert(page)).toContainText(/실패|오류|failed|error/i, {
      timeout: JOB_TIMEOUT_MS,
    });
    // Some but not all drafts survived the failure (A7), so the retry has to reconcile with them.
    const partial = await listDrafts(owner, run.id);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(PAPER.questions.length);
    expect(partial.every((d) => d.published_question_id === null)).toBe(true);
    await expect(importUi.draftItems(page)).toHaveCount(partial.length);

    await importUi.retry(page).click();
    await waitForImportStatus(owner, run.id, 'succeeded');
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length, {
      timeout: JOB_TIMEOUT_MS,
    });
    for (const q of PAPER.questions) {
      await expect(importUi.draft(page, q.stem), `question ${q.number}`).toHaveCount(1);
    }

    // Server: still one run; one draft per question, none left over from the failed attempt.
    expect((await listImports(owner, ws.id)).map((r) => r.id)).toEqual([run.id]);
    const drafts = await listDrafts(owner, run.id);
    expect(drafts).toHaveLength(PAPER.questions.length);
    expect(new Set(drafts.map((d) => d.position)).size).toBe(drafts.length);
    for (const q of PAPER.questions) {
      const copies = drafts.filter((d) => d.payload.stem.includes(q.stem));
      expect(copies, `drafts of question ${q.number}`).toHaveLength(1);
    }

    const approved = [Q(1), Q(2)];
    for (const t of approved) await importUi.select(importUi.draft(page, t.stem)).check();
    await importUi.publish(page).click();
    await expect(importUi.alert(page).or(page.getByRole('status')).first()).toContainText(
      /2\s*(개|문제).*(등록|확정)|registered 2|2 (questions )?(registered|published)/i,
    );
    const bank = await listQuestions(owner, ws.id);
    expect(bank).toHaveLength(approved.length);
    expect(new Set(bank.map((q) => q.id)).size).toBe(approved.length);
    for (const t of approved) {
      expect(bank.filter((q) => q.revision.stem.includes(t.stem))).toHaveLength(1);
    }
  },
);

test(
  'QIMPORT-01-AC04 retrying after a failed publish does not register drafts or questions twice',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, run } = await importPaper(page, workspaceFactory, 'qimport01-ac04');
    const approved = [Q(1), Q(5)];
    for (const t of approved) {
      const select = importUi.select(importUi.draft(page, t.stem));
      await select.check();
      await expect(select).toBeChecked();
    }

    // The first write after this point reaches the server, but its response never arrives.
    let dropped = 0;
    await page.route('**/*', async (route: Route) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) || dropped > 0) {
        return route.fallback();
      }
      dropped += 1;
      const response = await route.fetch();
      await response.body().catch(() => undefined);
      await route.abort('internetdisconnected');
    });

    await importUi.publish(page).click();
    await expect(importUi.alert(page)).toBeVisible();
    await expect(importUi.retry(page)).toBeVisible();
    expect(dropped).toBe(1);

    await importUi.retry(page).click();
    await expect(importUi.alert(page).or(page.getByRole('status')).first()).toContainText(
      /2\s*(개|문제).*(등록|확정)|registered 2|2 (questions )?(registered|published)/i,
    );
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    const bank = await listQuestions(owner, workspaceId);
    expect(bank).toHaveLength(approved.length);
    const drafts = await listDrafts(owner, run.id);
    expect(drafts).toHaveLength(PAPER.questions.length);
    const published = drafts.map((d) => d.published_question_id).filter((id) => id !== null);
    expect(published).toHaveLength(approved.length);
    expect([...published].sort()).toEqual(bank.map((q) => q.id).sort());

    // Reloading shows the same single import with the two drafts marked as registered.
    await page.reload();
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length);
    for (const t of approved) {
      await expect(importUi.draft(page, t.stem)).toContainText(
        /등록됨|등록 완료|registered|published/i,
      );
    }
    expect((await listImports(owner, workspaceId)).map((r) => r.id)).toEqual([run.id]);
    await page.goto(bankPath(workspaceId));
    await expect(bankUi.items(page)).toHaveCount(approved.length);
  },
);

test(
  'QIMPORT-01-AC05 문제 › PDF 관리 lists the PDFs with questions and sends uploads to 문서 관리; the import page has no upload',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(2 * JOB_TIMEOUT_MS + 60_000);
    const owner = await workspaceFactory.member('qimport01-ac05');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-ko');
    const uploaded = await uploadPdf(owner, ws.id, PAPER, 'question_paper');
    await waitForJob(owner, uploaded.jobId);
    // A book with questions whose extraction waits for 문제 추출 (low-confidence 교재+문제).
    const mixed = await uploadReadyBook(owner, ws.id, 'book-en');
    await setDocumentKind(owner, mixed, 'mixed', false);
    const empty = await workspaceFactory.create(owner);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    // Neither the home nor the dialog has a "PDF 가져오기" button (UX4).
    const importButton = (scope: Locator) =>
      scope
        .getByRole('link', { name: /^pdf 가져오기$|^import pdf$/i })
        .or(scope.getByRole('button', { name: /^pdf 가져오기$|^import pdf$/i }));
    await expect(importButton(main(page))).toHaveCount(0);
    await chooseQuestionMenu(page, 'pdfs');
    await expect(page).toHaveURL(/[?&]panel=question-pdfs(&|$)/);
    const dialog = homeUi.questionPdfsDialog(page);
    await expect(dialog).toBeVisible();
    const list = dialog.getByRole('list', { name: /문제 pdf 목록|question pdfs/i });
    // The PDFs with questions only, each with its kind badge; the plain book is not listed.
    await expect(list.getByRole('listitem')).toHaveCount(2);
    const paperRow = list.getByRole('listitem').filter({ hasText: /questions-ko/ });
    const mixedRow = list.getByRole('listitem').filter({ hasText: /book-en/ });
    await expect(docUi.kindBadge(paperRow, '문제지')).toBeVisible();
    await expect(docUi.kindBadge(mixedRow, '교재+문제')).toBeVisible();
    await expect(list).not.toContainText(/book-ko/);
    await expect(docUi.reviewLink(paperRow)).toBeVisible();
    await expect(docUi.extractButton(mixedRow)).toBeVisible();
    // UX6-UPLOAD: no Dropzone or file input here; uploads go to 문서 관리.
    await expect(dialog.getByText(/여기에 끌어다 놓으세요|drop/i)).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: /pdf (선택|업로드)|choose|upload/i }),
    ).toHaveCount(0);
    await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
    await expect(
      dialog.getByText('PDF는 문서 관리에서 올립니다. 문제가 있는 PDF는 자동으로 추출됩니다.'),
    ).toBeVisible();
    await expect(importButton(dialog)).toHaveCount(0);
    await importUi.openDocuments(dialog).click();
    await expect(page).toHaveURL(/[?&]panel=documents(&|$)/);
    await expect(homeUi.documentsDialog(page)).toBeVisible();

    // No PDF with questions yet: the empty text, still pointing at 문서 관리.
    await page.goto(homePath(empty.id, 'panel=question-pdfs'));
    const emptyDialog = homeUi.questionPdfsDialog(page);
    await expect(emptyDialog.getByText('등록된 문제 pdf가 없습니다.')).toBeVisible();
    await expect(importUi.openDocuments(emptyDialog)).toBeVisible();

    // The import page uploads nothing; without an extraction it points at 문서 관리.
    await page.goto(importPath(empty.id));
    await expect(importUi.heading(page)).toBeVisible();
    await expect(main(page).getByText(/추출된 문제가 없습니다/)).toBeVisible();
    await expect(
      main(page).getByRole('button', { name: /pdf (업로드|선택)|upload|choose/i }),
    ).toHaveCount(0);
    await expect(main(page).locator('input[type="file"]')).toHaveCount(0);
    await importUi.openDocuments(main(page)).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === homePath(empty.id) && url.searchParams.get('panel') === 'documents',
    );

    // Two extracted PDFs: `검토할 PDF` switches between their reviews (one per PDF).
    const mixedRun = await startImport(owner, ws.id, mixed);
    await waitForImportStatus(owner, mixedRun.id, 'succeeded');
    await page.goto(importPath(ws.id));
    const switcher = importUi.pdfSwitcher(page);
    await expect(switcher).toContainText(/book-en/); // the newest extraction
    await expect(
      main(page).getByRole('button', { name: /pdf (업로드|선택)|upload|choose/i }),
    ).toHaveCount(0);
    await switcher.click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.filter({ hasText: /book-en/ })).toContainText('교재+문제');
    await options.filter({ hasText: /questions-ko/ }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === importPath(ws.id) &&
        url.searchParams.get('document') === uploaded.documentId,
    );
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length);
    await expect(importUi.pdfSwitcher(page)).toContainText(/questions-ko/);
  },
);

test(
  'QIMPORT-01-AC06 extraction runs on the server: leaving 문서 관리 during processing still yields the drafts under 문제 검토',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac06-leave');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, 'panel=documents'));
    // The browser never starts the extraction itself: any start request it sends fails.
    let browserStarts = 0;
    await page.route('**/api/workspaces/*/question-imports', async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      browserStarts += 1;
      await route.abort('internetdisconnected');
    });
    const chooser = page.waitForEvent('filechooser');
    await docUi.uploadButton(page).click();
    await (await chooser).setFiles(PAPER.path);
    // The upload is complete (the server has the document and its processing job): leave.
    await expect
      .poll(async () => (await listDocuments(owner, ws.id)).length, {
        message: 'the uploaded question PDF exists',
        timeout: JOB_TIMEOUT_MS,
      })
      .toBe(1);
    await page.goto(homePath(ws.id));
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // The server started exactly one import for the uploader and it finishes without the page.
    const run = await waitForLatestImport(owner, ws.id);
    const [document] = await listDocuments(owner, ws.id);
    expect(run.source_document_id).toBe(document?.id);
    expect(document?.kind).toBe('question_paper');
    expect(await listImports(owner, ws.id)).toHaveLength(1);
    expect(await waitForImportStatus(owner, run.id, 'succeeded')).toMatchObject({
      draft_count: PAPER.questions.length,
    });
    expect(browserStarts).toBe(0);

    // Coming back: the PDF's 문제 검토 shows the extracted drafts for review.
    await page.goto(homePath(ws.id, 'panel=question-pdfs'));
    const row = homeUi
      .questionPdfsDialog(page)
      .getByRole('listitem')
      .filter({ hasText: /questions-ko/ });
    await docUi.reviewLink(row).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('document') === document?.id);
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length);
    await expect(importUi.draft(page, Q(1).stem)).toHaveCount(1);
    expect((await listImports(owner, ws.id)).map((r) => r.id)).toEqual([run.id]);
  },
);

test(
  'QIMPORT-01-AC06 a processed question PDF without an extraction offers 문제 추출 in 문제 PDF 관리',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac06-extract');
    const ws = await workspaceFactory.create(owner);
    const uploaded = await uploadPdf(owner, ws.id, PAPER, 'question_paper');
    await waitForJob(owner, uploaded.jobId);
    // A paper processed before the server started extractions: no import run.
    await waitForLatestImport(owner, ws.id);
    forgetImportRuns(ws.id, uploaded.documentId);
    expect(await listImports(owner, ws.id)).toEqual([]);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, 'panel=question-pdfs'));
    const dialog = homeUi.questionPdfsDialog(page);
    const list = dialog.getByRole('list', { name: /문제 pdf 목록|question pdfs/i });
    const row = list.getByRole('listitem').filter({ hasText: PAPER.file.replace(/\.pdf$/, '') });
    const extract = row.getByRole('button', { name: /문제 추출|extract questions/i });
    await expect(extract).toBeVisible();
    await expect(row.getByRole('link', { name: /문제 검토|review questions/i })).toHaveCount(0);

    await extract.click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === importPath(ws.id) &&
        url.searchParams.get('document') === uploaded.documentId,
    );
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length, {
      timeout: JOB_TIMEOUT_MS,
    });
    const runs = await listImports(owner, ws.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.source_document_id).toBe(uploaded.documentId);

    // With its extraction in place the row links to the review instead.
    await page.goto(homePath(ws.id, 'panel=question-pdfs'));
    const review = row.getByRole('link', { name: /문제 검토|review questions/i });
    await expect(review).toBeVisible();
    await expect(row.getByRole('button', { name: /문제 추출|extract questions/i })).toHaveCount(0);
    await review.click();
    await expect(page).toHaveURL((url) => url.searchParams.get('document') === uploaded.documentId);
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length);
    expect(await listImports(owner, ws.id)).toHaveLength(1);
  },
);

test(
  'QIMPORT-01-AC07 the server registers every selected draft after the page is left, and the page shows them registered on return',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, run } = await importPaper(page, workspaceFactory, 'qimport01-ac07');
    const registrable = PAPER.questions.filter((q) => q.answer !== null);
    await importUi.selectAll(page).check();
    await expect(importUi.publish(page)).toContainText(new RegExp(`\\(${registrable.length}\\)`));

    // The page cannot follow the registration at all: only the server can finish it (QIMP-JOB).
    await page.route('**/api/question-imports/*/registrations/*', (route) => route.abort());
    const submitted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/registrations'),
    );
    await importUi.publish(page).click();
    expect((await submitted).status()).toBe(202);
    await page.goto(homePath(workspaceId));

    await expect
      .poll(async () => (await listQuestions(owner, workspaceId)).length, {
        timeout: JOB_TIMEOUT_MS,
      })
      .toBe(registrable.length);
    const bank = await listQuestions(owner, workspaceId);
    expect(bank.every((q) => q.publication_status === 'CONFIRMED')).toBe(true);
    const drafts = await listDrafts(owner, run.id);
    for (const t of PAPER.questions) {
      const draft = draftFor(drafts, t);
      if (registrable.includes(t)) {
        expect(draft.review_status, `question ${t.number}`).toBe('approved');
        expect(bank.map((q) => q.id)).toContain(draft.published_question_id);
      } else {
        expect(draft.published_question_id, `question ${t.number}`).toBeNull();
      }
    }

    await page.unroute('**/api/question-imports/*/registrations/*');
    await page.goto(importPath(workspaceId));
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length);
    for (const t of registrable) {
      const item = importUi.draft(page, t.stem);
      await expect(item.getByText(/등록됨|registered/i), `question ${t.number}`).toBeVisible();
      await expect(importUi.select(item), `question ${t.number}`).toHaveCount(0);
    }
    await expect(page.getByRole('progressbar', { name: /등록 진행률/ })).toHaveCount(0);
    // Nothing was registered twice.
    expect(await listQuestions(owner, workspaceId)).toHaveLength(registrable.length);
  },
);

test(
  'QIMPORT-01-AC08 each draft shows the book chapter matched from the question PDF, can be changed, and registers under it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac08');
    const ws = await workspaceFactory.create(owner);
    // book-ko: "1장 물의 순환" / "2장 정수 처리"; the paper uploaded as a book has a chapter with
    // exactly the paper's own chapter title (its title heading), so that one is the suggestion.
    await uploadReadyBook(owner, ws.id, 'book-ko');
    const titled = await uploadPdf(owner, ws.id, PAPER, 'book');
    await waitForJob(owner, titled.jobId);

    await signInAs(page, owner.user);
    await uploadQuestionPaper(page, ws.id, PAPER);
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length, {
      timeout: JOB_TIMEOUT_MS,
    });
    const run = await waitForLatestImport(owner, ws.id);

    const q1 = importUi.draft(page, Q(1).stem);
    const q2 = importUi.draft(page, Q(2).stem);
    const picker = (item: Locator) => item.getByRole('combobox', { name: /챕터|chapter/i });
    await expect(picker(q1)).toContainText(PAPER_CHAPTER);
    await expect(q1.getByText(/자동으로 골랐습니다|suggested/i)).toBeVisible();
    await expect(picker(q2)).toContainText(PAPER_CHAPTER);

    // Move question 1 to another book chapter (saved at once, keyboard-free path: click).
    await picker(q1).click();
    await page.getByRole('option', { name: /^1장 물의 순환/ }).click();
    await expect(picker(q1)).toContainText('1장 물의 순환');
    await expect(q1.getByText(/직접 고른 챕터|chosen/i)).toBeVisible();
    await expect
      .poll(async () => draftFor(await listDrafts(owner, run.id), Q(1)).chapter_choice)
      .toBe('manual');

    await importUi.select(q1).check();
    await importUi.select(q2).check();
    await importUi.publish(page).click();
    await expect(page.getByRole('status')).toContainText(/2\s*개 문제를 문제은행에 등록/, {
      timeout: JOB_TIMEOUT_MS,
    });

    const drafts = await listDrafts(owner, run.id);
    const bank = await listQuestions(owner, ws.id);
    const chapterOf = (t: TruthQuestion) =>
      bank.find((q) => q.id === draftFor(drafts, t).published_question_id)?.chapter_id;
    const moved = draftFor(drafts, Q(1)).chapter;
    const suggested = draftFor(drafts, Q(2)).chapter;
    expect(moved?.title).toBe('1장 물의 순환');
    expect(suggested?.title).toBe(PAPER_CHAPTER);
    expect(chapterOf(Q(1))).toBe(moved?.id);
    expect(chapterOf(Q(2))).toBe(suggested?.id);

    // The bank lists each under its chapter.
    await page.goto(`${bankPath(ws.id)}?chapter=${suggested?.id}`);
    await expect(bankUi.items(page)).toHaveCount(1);
    await expect(bankUi.item(page, Q(2).stem)).toHaveCount(1);
    await page.goto(`${bankPath(ws.id)}?chapter=${moved?.id}`);
    await expect(bankUi.items(page)).toHaveCount(1);
    await expect(bankUi.item(page, Q(1).stem)).toHaveCount(1);
  },
);

/**
 * Clicks a checkbox in the page and returns how long until React commits `expected` (ms): the
 * click's synchronous handling plus the render it triggers, i.e. how long the main thread is busy.
 * A MutationObserver sees the commit itself, so the value is not rounded up to animation frames
 * (headless WebKit on a loaded CI runner delivers requestAnimationFrame late). The page first
 * settles for a frame so the previous click's layout and paint are not counted.
 */
async function clickLatency(box: Locator, expected: 'true' | 'false'): Promise<number> {
  return box.evaluate(async (el, want) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    let end = 0;
    const committed = new Promise<void>((resolve) => {
      const done = () => {
        if (el.getAttribute('aria-checked') !== want) return false;
        end ||= performance.now();
        observer.disconnect();
        resolve();
        return true;
      };
      const observer = new MutationObserver(done);
      observer.observe(el, { attributes: true, attributeFilter: ['aria-checked'] });
      // Fallback if the element were replaced instead of updated.
      const poll = () => done() || requestAnimationFrame(poll);
      requestAnimationFrame(poll);
    });
    const start = performance.now();
    (el as HTMLElement).click();
    await committed;
    return end - start;
  }, expected);
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? NaN) : ((s[mid - 1] ?? NaN) + (s[mid] ?? NaN)) / 2;
};

/**
 * Click-to-commit checks (QIMPORT-01-AC09). Before UX6-SELECT every click re-rendered every
 * draft, so at 512 drafts one checkbox cost as much as "전체 선택" (~170–200 ms each, local
 * Chromium). Now one checkbox re-renders one row and "전체 선택" only the 320 checkboxes that
 * change. Single wall-clock samples are noisy on shared CI runners, so each check uses the median
 * of several toggles, and the regression itself — one checkbox costing like the whole list — is
 * checked relative to "전체 선택" on the same page, which a slow or loaded machine scales alike.
 * The absolute budgets only catch a frozen screen: locally one checkbox is ~3–5 ms and "전체 선택"
 * ~40–60 ms in Chromium and WebKit, also with 6 parallel workers.
 */
const ONE_BUDGET_MS = 80;
const ALL_BUDGET_MS = 400;
/** One checkbox must cost at most this share of "전체 선택" (before the fix: ~1). */
const ONE_TO_ALL_MAX_RATIO = 0.25;
/** Below this, one checkbox is fast regardless of the ratio (both are then just noise). */
const ONE_NOISE_FLOOR_MS = 8;
const TOGGLES = 5;
/** Copies of the paper's 8 drafts: 8 × 64 = 512 drafts, 5 × 64 = 320 in "전체 선택". */
const COPIES = 63;
/** Drafts per page of the review (QIMP-REVIEW-SCALE, apps/web/src/lib/questions/draft-pages.ts). */
const REVIEW_PAGE_SIZE = 100;
/** Drafts numbered `from..to` that "전체 선택" covers: draft k is a copy of question (k-1) % 8 + 1. */
const registrableIn = (from: number, to: number): number => {
  let n = 0;
  for (let k = from; k <= to; k++)
    if (Q(((k - 1) % PAPER.questions.length) + 1).answer !== null) n++;
  return n;
};

test(
  'QIMPORT-01-AC09 with hundreds of drafts, selecting and 전체 선택 respond at once without a request; 승인 및 등록 sends the selection',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac09');
    const ws = await workspaceFactory.create(owner);
    // Book chapters, so every draft has a chapter picker like a real import.
    await uploadReadyBook(owner, ws.id, 'book-ko');
    const { run } = await importPaperDrafts(owner, ws.id);
    const total = seedImportDraftCopies(run.id, COPIES);
    expect(total).toBe(PAPER.questions.length * (COPIES + 1));
    const registrable = PAPER.questions.filter((q) => q.answer !== null).length * (COPIES + 1);

    await signInAs(page, owner.user);
    await page.goto(importPath(ws.id));
    // QIMP-REVIEW-SCALE: one page of drafts is rendered; the counts are over all of them.
    await expect(importUi.draftsHeading(page)).toContainText(`${total}개`, { timeout: 30_000 });
    await expect(importUi.draftItems(page)).toHaveCount(REVIEW_PAGE_SIZE);
    const all = importUi.selectAll(page);
    await expect(all).toHaveAccessibleName(new RegExp(`\\(${registrable}개\\)`));

    // Selecting is screen state only: no request of any kind while checking.
    const sent: string[] = [];
    const onRequest = (r: { method(): string; url(): string }) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) sent.push(`${r.method()} ${r.url()}`);
    };
    page.on('request', onRequest);

    const allMs = [await clickLatency(all, 'true')];
    await expect(importUi.publish(page)).toContainText(`(${registrable})`);
    await expect(
      importUi.drafts(page).getByRole('checkbox', { name: /번 문제 선택/, checked: true }),
    ).toHaveCount(registrableIn(1, REVIEW_PAGE_SIZE));
    const q1 = importUi.select(importUi.draft(page, Q(1).stem).first());
    const oneMs: number[] = [];
    for (let i = 0; i < TOGGLES; i++) {
      oneMs.push(await clickLatency(q1, 'false'));
      if (i === 0) {
        await expect(all).toHaveAttribute('aria-checked', 'mixed');
        await expect(importUi.publish(page)).toContainText(`(${registrable - 1})`);
      }
      oneMs.push(await clickLatency(q1, 'true'));
    }
    await expect(importUi.publish(page)).toContainText(`(${registrable})`);
    for (let i = 0; i < TOGGLES - 1; i++) {
      allMs.push(await clickLatency(all, 'false'));
      if (i === 0) await expect(importUi.publish(page)).toContainText('(0)');
      allMs.push(await clickLatency(all, 'true'));
    }
    await expect(importUi.publish(page)).toContainText(`(${registrable})`);

    const one = median(oneMs);
    const allMedian = median(allMs);
    test.info().annotations.push({
      type: 'selection latency (ms)',
      description: JSON.stringify({ one, all: allMedian, oneMs, allMs }),
    });
    expect
      .soft(one, `one checkbox (median) within ${ONE_BUDGET_MS} ms`)
      .toBeLessThan(ONE_BUDGET_MS);
    expect
      .soft(allMedian, `전체 선택 (median) within ${ALL_BUDGET_MS} ms`)
      .toBeLessThan(ALL_BUDGET_MS);
    // Pre-fix, one checkbox cost about as much as 전체 선택 (it re-rendered every row).
    expect
      .soft(
        one <= ONE_NOISE_FLOOR_MS || one < allMedian * ONE_TO_ALL_MAX_RATIO,
        `one checkbox (median ${one} ms) must not re-render the list like 전체 선택 (median ${allMedian} ms)`,
      )
      .toBe(true);
    page.off('request', onRequest);
    expect(sent, 'no request while selecting').toEqual([]);
    expect((await listDrafts(owner, run.id)).every((d) => d.review_status === 'pending')).toBe(
      true,
    );

    // The button sends the whole selection in one request.
    const submitted = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/registrations'),
    );
    await importUi.publish(page).click();
    const body = (await submitted).postDataJSON() as { drafts: { draft_id: string }[] };
    expect(body.drafts).toHaveLength(registrable);
    await expect(page.getByRole('status')).toContainText(
      new RegExp(`${registrable}\\s*개 문제를 문제은행에 등록`),
      { timeout: JOB_TIMEOUT_MS },
    );
    const registered = (await listDrafts(owner, run.id)).filter((d) => d.published_question_id);
    expect(registered).toHaveLength(registrable);
  },
);

/**
 * QIMP-REVIEW-SCALE (QIMPORT-01-AC09 at the size of a real paper): 316 pages gave ~750 drafts, and
 * the review crashed the tab — every closed chapter picker rendered the whole book outline (~3.4 GB
 * heap for 752 drafts × 300 chapters). With ~1000 drafts over a long outline the page renders one
 * page of drafts with closed pickers that hold no options, and `전체 선택` still covers every draft.
 */
const SCALE_COPIES = 124; // 8 × 125 = 1000 drafts
const SCALE_CHAPTERS = 300;
/** Elements on the page with one page of drafts (~40 per draft, plus the app shell). */
const SCALE_MAX_ELEMENTS = 8000;
/**
 * Chromium's count of every node the renderer holds, incl. detached ones: closed Radix pickers
 * render their options into detached fragments (one page × 301 options ≈ 120k nodes before the
 * fix; ~17k after).
 */
const SCALE_MAX_NODES = 40_000;

test(
  'QIMPORT-01-AC09 a review of 1000 drafts over a long book outline renders one page and 전체 선택 covers every page',
  { tag: '@infra' },
  async ({ page, workspaceFactory, browserName }) => {
    const owner = await workspaceFactory.member('qimport01-ac09-scale');
    const ws = await workspaceFactory.create(owner);
    const bookId = await uploadReadyBook(owner, ws.id, 'book-ko');
    seedBookChapters(bookId, SCALE_CHAPTERS);
    const { run } = await importPaperDrafts(owner, ws.id);
    const total = seedImportDraftCopies(run.id, SCALE_COPIES);
    expect(total).toBe(1000);
    const registrable = registrableIn(1, total);

    await signInAs(page, owner.user);
    await page.goto(importPath(ws.id));
    await expect(importUi.draftsHeading(page)).toContainText(`${total}개`, { timeout: 30_000 });
    const all = importUi.selectAll(page);
    await expect(all).toHaveAccessibleName(new RegExp(`\\(${registrable}개\\)`));

    // Bounded: one page of drafts, and no picker renders its options while closed.
    await expect(importUi.draftItems(page)).toHaveCount(REVIEW_PAGE_SIZE);
    const chapterPickers = importUi.drafts(page).getByRole('combobox', { name: /번 문제 챕터/ });
    await expect(chapterPickers).toHaveCount(REVIEW_PAGE_SIZE);
    const elements = await page.evaluate(() => document.getElementsByTagName('*').length);
    expect(elements, 'elements on the page').toBeLessThan(SCALE_MAX_ELEMENTS);
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const nodes = metrics.find((m) => m.name === 'Nodes')?.value ?? Infinity;
      test.info().annotations.push({ type: 'renderer nodes', description: String(nodes) });
      expect(nodes, 'nodes held by the renderer (incl. detached)').toBeLessThan(SCALE_MAX_NODES);
      await cdp.detach();
    }
    // The picker still lists the whole outline once opened.
    await chapterPickers.first().click();
    await expect(page.getByRole('option')).toHaveCount(await bookChapterOptions(owner, run.id));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(chapterPickers.first()).toBeFocused();

    // 전체 선택 covers the drafts on every page, not only the rendered one.
    await all.click();
    await expect(importUi.publish(page)).toContainText(`(${registrable})`);
    const pager = importUi.pager(page);
    // Keyboard: the page button keeps focus on the new page (WebKit does not focus on click).
    await importUi.pagerPage(pager, 10).focus();
    await page.keyboard.press('Enter');
    await expect(importUi.pagerPage(pager, 10)).toHaveAttribute('aria-current', 'page');
    await expect(importUi.pagerPage(pager, 10)).toBeFocused();
    await expect(importUi.draftItems(page)).toHaveCount(REVIEW_PAGE_SIZE);
    await expect(
      importUi.drafts(page).getByRole('checkbox', { name: /번 문제 선택/, checked: true }),
    ).toHaveCount(registrableIn(total - REVIEW_PAGE_SIZE + 1, total));
    await expect(
      importUi.drafts(page).getByRole('checkbox', { name: `${total}번 문제 선택` }),
    ).toBeChecked();

    // The pager below the list brings keyboard users to the top of the new page.
    const below = main(page).getByRole('navigation', { name: /초안 페이지 \(목록 아래\)/ });
    await below.getByRole('button', { name: /^(이전|previous)$/i }).click();
    await expect(importUi.draftsHeading(page)).toBeFocused();
    await expect(pager).toContainText(`801–900 / ${total}`);
    await expect(importUi.publish(page)).toContainText(`(${registrable})`);
  },
);
