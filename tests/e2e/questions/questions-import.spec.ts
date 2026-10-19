// QIMPORT-01 — 문제 PDF 가져오기 (`/workspaces/:workspaceId/questions/import`),
// docs/screens/questions-import.md; import rules docs/questions.md §6 (drafts isolated until a
// human approves them, answers only from the PDF's own answer key — never invented — and page
// provenance), AGENTS.md §5 (imported questions stay drafts until approved).
//
// Each test signs in its own owner, uploads the synthetic `questions-ko.pdf` (8 questions, answer
// key for 1, 2, 4, 5, 8 only; tests/fixtures/pdfs/questions-ko.truth.json) through the import
// screen and waits for the import job; E2E runs the worker with the deterministic fake LLM adapter
// (docs/e2e-strategy.md §3, §6). Draft/bank state is checked through the public API
// (fixtures/questions.ts, whose header lists the endpoint/label assumptions, incl. A5: the AC's
// "5 questions" becomes the paper's 8). Failures: a job failure comes from the APP_ENV=test fake
// extractor via the IMPORT_FAILURE_MARKER file name (A7); a network failure drops a response the
// server already produced.
import { mkdirSync } from 'node:fs';
import type { Locator, Page, Route } from '@playwright/test';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';
import {
  bankPath,
  bankUi,
  draftFor,
  expect,
  failingOnceCopy,
  homePath,
  homeUi,
  importPath,
  importUi,
  JOB_TIMEOUT_MS,
  waitForImportStatus,
  listDrafts,
  listImports,
  listQuestions,
  main,
  pageLabel,
  questionFormUi,
  questionPaper,
  signInAs,
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
const UNANSWERED = PAPER.questions.filter((q) => q.answer === null); // 3 (MCQ), 6, 7

/** Owner + workspace, questions-ko.pdf imported through the UI, drafts listed by the API. */
async function importPaper(page: Page, workspaceFactory: WorkspaceFactory, label: string) {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  expect(await listImports(owner, ws.id)).toEqual([]);

  await signInAs(page, owner.user);
  await page.goto(importPath(ws.id));
  await expect(importUi.heading(page)).toHaveText(/문제 pdf 가져오기|가져오기|import/i);
  await uploadQuestionPaper(page, PAPER);
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
  'QIMPORT-01-AC03 only reviewed and approved drafts are registered in the bank, one marker each',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspaceId, run } = await importPaper(page, workspaceFactory, 'qimport01-ac03');
    expect(await listQuestions(owner, workspaceId)).toEqual([]);

    // Approve 1 and 2 as extracted; complete 3 (no answer in the key) by hand, then approve it.
    await importUi.approve(importUi.draft(page, Q(1).stem)).check();
    await importUi.approve(importUi.draft(page, Q(2).stem)).check();
    const q3 = importUi.draft(page, Q(3).stem);
    await importUi.edit(q3).click();
    const form = questionFormUi.form(page);
    const evaporation = Q(3).options.findIndex((o) => o.text === '증발') + 1;
    await questionFormUi.correct(form, evaporation).check();
    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();
    await expect(importUi.noAnswer(q3)).toHaveCount(0);
    await importUi.approve(q3).check();

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
  'QIMPORT-01-AC04 retrying a failed import job yields each draft once and publishing registers unique questions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac04-job');
    const ws = await workspaceFactory.create(owner);
    expect(await listImports(owner, ws.id)).toEqual([]);
    mkdirSync(test.info().outputDir, { recursive: true });
    const failing = failingOnceCopy(PAPER, test.info().outputDir);

    await signInAs(page, owner.user);
    await page.goto(importPath(ws.id));
    await uploadQuestionPaper(page, failing);

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
    for (const t of approved) await importUi.approve(importUi.draft(page, t.stem)).check();
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
      const approve = importUi.approve(importUi.draft(page, t.stem));
      await approve.check();
      await expect(approve).toBeChecked();
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
  'QIMPORT-01-AC05 문제 PDF 관리 lists question PDFs apart from books, links PDF 가져오기 and hands a dropped PDF to the import',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac05');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-ko');
    const uploaded = await uploadPdf(owner, ws.id, PAPER, 'question_paper');
    await waitForJob(owner, uploaded.jobId);
    const empty = await workspaceFactory.create(owner);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    // The home has no other "PDF 가져오기" (the button sits in the dialog now).
    const importButton = (scope: Locator) =>
      scope.getByRole('link', { name: /^pdf 가져오기$|^import pdf$/i });
    await expect(importButton(main(page))).toHaveCount(0);
    await homeUi.questionPdfsButton(page).click();
    await expect(page).toHaveURL(/[?&]panel=question-pdfs(&|$)/);
    const dialog = homeUi.questionPdfsDialog(page);
    await expect(dialog).toBeVisible();
    const list = dialog.getByRole('list', { name: /문제 pdf 목록|question pdfs/i });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText(PAPER.file.replace(/\.pdf$/, ''));
    await expect(list).not.toContainText(/book-ko|물의 순환과 정수 처리/);
    await expect(list.getByText(/^(책|문제지)$/)).toHaveCount(0);
    await expect(dialog.getByText(/문제 pdf를 여기에 끌어다 놓으세요|drop/i)).toBeVisible();
    await importButton(dialog).click();
    await expect(page).toHaveURL((url) => url.pathname === importPath(ws.id));

    // No question PDF yet: the empty text; a PDF picked in the Dropzone starts the import page.
    await page.goto(homePath(empty.id, 'panel=question-pdfs'));
    const emptyDialog = homeUi.questionPdfsDialog(page);
    await expect(emptyDialog.getByText('등록된 문제 pdf가 없습니다.')).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await emptyDialog.getByRole('button', { name: /pdf 선택|choose/i }).click();
    await (await chooser).setFiles(PAPER.path);
    await expect(page).toHaveURL((url) => url.pathname === importPath(empty.id));
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length, {
      timeout: JOB_TIMEOUT_MS,
    });
    expect((await listImports(owner, empty.id)).length).toBe(1);
  },
);
