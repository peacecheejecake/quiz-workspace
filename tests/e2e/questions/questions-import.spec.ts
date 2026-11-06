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
  createQuestion,
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
  overviewUi,
  overviewPath,
  main,
  mcqInput,
  pageLabel,
  progressStepsUi,
  questionFormUi,
  questionPaper,
  seedBookChapters,
  seedImportDraftCopies,
  setDocumentKind,
  signInAs,
  stampDraftValidation,
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
import { isBlocked, reviewListUi } from '../fixtures/ux9-pages.ts';

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

    // Compare view: the draft next to its source page. UX9 (HOMEDLG-01, user decision 2026-11-02):
    // a modal panel — the draft list behind it is inert — showing the draft's extracted content
    // read-only, moving along the page's drafts with 이전 초안 / 다음 초안.
    const q5 = Q(5);
    const q6 = Q(6);
    const compare5 = importUi.compare(importUi.draft(page, q5.stem));
    await compare5.click();
    const source = page.getByRole('dialog', { name: /^(원본|원문|source)/i });
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('aria-modal', 'true');
    await expect(source).toContainText(pageLabel(q5.page));
    await expect(source).toContainText(q5.stem);
    const list = page.locator('main').getByRole('list', {
      name: /가져온 (초안|문제)|초안|drafts?|imported questions/i,
      includeHidden: true,
    });
    expect(await isBlocked(list), 'the draft list is inert').toBe(true);
    // Read-only: no field of the draft and nothing to save in the panel.
    await expect(source.getByRole('button', { name: /저장|save/i })).toHaveCount(0);
    await source.getByRole('button', { name: /^(다음 초안|next draft)$/i }).click();
    await expect(source).toContainText(q6.stem);
    await expect(source).toContainText(pageLabel(q6.page));
    await source.getByRole('button', { name: /^(이전 초안|previous draft)$/i }).click();
    await expect(source).toContainText(q5.stem);
    // To edit, close it: focus returns to the compare button of the draft last shown.
    await page.keyboard.press('Escape');
    await expect(source).toHaveCount(0);
    await expect(compare5).toBeFocused();

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

    // Drafts are isolated: nothing is confirmed yet, so the home heatmap is empty.
    expect(await listQuestions(owner, workspaceId)).toEqual([]);
    await page.goto(overviewPath(workspaceId));
    await expect(overviewUi.empty(page)).toBeVisible();
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

    // One heatmap marker per registered question (the unselected drafts have none).
    await page.goto(overviewPath(workspaceId));
    await expect(overviewUi.dots(page)).toHaveCount(approved.length);
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

    await page.goto(overviewPath(workspaceId));
    await expect(overviewUi.dots(page)).toHaveCount(registrable.length);
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
    await page.goto(overviewPath(workspaceId));
    await expect(overviewUi.dots(page)).toHaveCount(approved.length);
  },
);

test(
  'QIMPORT-01-AC05 문서 관리 rows give the PDFs with questions their review actions; the import page has no upload and points at 문서 관리',
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
    // Neither the home nor 문서 관리 has a "PDF 가져오기" button (UX4).
    const importButton = (scope: Locator) =>
      scope
        .getByRole('link', { name: /^pdf 가져오기$|^import pdf$/i })
        .or(scope.getByRole('button', { name: /^pdf 가져오기$|^import pdf$/i }));
    await expect(importButton(main(page))).toHaveCount(0);
    // UX7-DOCS: the PDFs with questions are reviewed from 문서 관리 (DOC-01-AC09).
    await homeUi.openDocuments(page);
    const dialog = homeUi.documentsDialog(page);
    await expect(dialog).toBeVisible();
    const list = dialog.getByRole('list', { name: /문서 목록|documents/i });
    const paperRow = list.getByRole('listitem').filter({ hasText: /questions-ko/ });
    const mixedRow = list.getByRole('listitem').filter({ hasText: /book-en/ });
    const bookRow = list.getByRole('listitem').filter({ hasText: /book-ko/ });
    await expect(docUi.kindBadge(paperRow, '문제지')).toBeVisible();
    await expect(docUi.kindBadge(mixedRow, '교재+문제')).toBeVisible();
    await expect(docUi.reviewLink(paperRow)).toBeVisible();
    await expect(docUi.extractButton(mixedRow)).toBeVisible();
    await expect(docUi.reviewLink(bookRow)).toHaveCount(0);
    await expect(docUi.extractButton(bookRow)).toHaveCount(0);
    await expect(importButton(dialog)).toHaveCount(0);

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
    await expect(homeUi.documentsDialog(page)).toBeVisible();

    // Two extracted PDFs: the `검토할 PDF` list switches between their reviews (one per PDF; UX9:
    // the list replaced the combobox, QIMPORT-02-AC01·AC02).
    const mixedRun = await startImport(owner, ws.id, mixed);
    await waitForImportStatus(owner, mixedRun.id, 'succeeded');
    await page.goto(importPath(ws.id));
    const pdfList = reviewListUi.nav(page);
    const pdfLink = (title: RegExp) =>
      reviewListUi.rows(pdfList).getByRole('link', { name: title });
    await expect(importUi.pdfSwitcher(page)).toHaveCount(0);
    // The newest extraction is chosen; the plain 교재 is not listed.
    await expect(pdfLink(/book-en/)).toHaveAttribute('aria-current', 'page');
    await expect(reviewListUi.rows(pdfList)).toHaveCount(2);
    await expect(reviewListUi.rows(pdfList).filter({ hasText: /book-ko/ })).toHaveCount(0);
    await expect(
      main(page).getByRole('button', { name: /pdf (업로드|선택)|upload|choose/i }),
    ).toHaveCount(0);
    await expect(
      reviewListUi.rows(pdfList).filter({ has: page.getByRole('link', { name: /book-en/ }) }),
    ).toContainText('교재+문제');
    await pdfLink(/questions-ko/).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === importPath(ws.id) &&
        url.searchParams.get('document') === uploaded.documentId,
    );
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length);
    await expect(pdfLink(/questions-ko/)).toHaveAttribute('aria-current', 'page');
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
    await page.goto(homePath(ws.id, 'panel=documents'));
    const row = homeUi
      .documentsDialog(page)
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
  'QIMPORT-01-AC06 a processed question PDF without an extraction offers 문제 추출 in 문서 관리',
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
    await page.goto(homePath(ws.id, 'panel=documents'));
    const dialog = homeUi.documentsDialog(page);
    const list = dialog.getByRole('list', { name: /문서 목록|documents/i });
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
    await page.goto(homePath(ws.id, 'panel=documents'));
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

    // The home heatmap shows each under its chapter (UX7-BANK: was the 전체 문제 page).
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(2);
    for (const title of [moved?.title, suggested?.title]) {
      const group = overviewUi.heatmap(page).getByRole('region', { name: title ?? '' });
      await expect(group.getByRole('button', { name: /\d+번 문제|question \d+/i })).toHaveCount(1);
    }
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
 * QIMP-PAGING (QIMPORT-01-AC09): the first response carries every draft's summary but only the
 * first page's content; another page's content is read when it is shown (a loading state until
 * then), while 전체 선택 and the registration cover drafts whose page was never read.
 */
const PAGING_COPIES = 31; // 8 × 32 = 256 drafts, 3 pages

test(
  'QIMPORT-01-AC09 draft content is read page by page; selections on several pages are registered together',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac09-paging');
    const ws = await workspaceFactory.create(owner);
    const { run } = await importPaperDrafts(owner, ws.id);
    const total = seedImportDraftCopies(run.id, PAGING_COPIES);
    expect(total).toBe(PAPER.questions.length * (PAGING_COPIES + 1));
    const copyOf = (k: number) => Q(((k - 1) % PAPER.questions.length) + 1);
    /** Draft k's stem (a copy's stem ends with " #<copy>", tests/e2e/fixtures/db.ts). */
    const stemOf = (k: number) => {
      const copy = Math.floor((k - 1) / PAPER.questions.length);
      return copy === 0 ? copyOf(k).stem : `${copyOf(k).stem} #${copy}`;
    };
    const registrableFrom = (from: number) => {
      for (let k = from; ; k++) if (copyOf(k).answer !== null) return k;
    };
    // Copies 11 and 26: no other copy's stem contains theirs (" #11" is not " #1").
    const first = registrableFrom(89);
    const last = registrableFrom(2 * REVIEW_PAGE_SIZE + 9);

    // The page reads after the first response, by offset; page 3's is held until released.
    const reads: number[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/question-imports\/[^/]+\/drafts\?/, async (route) => {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
      reads.push(offset);
      if (offset === 2 * REVIEW_PAGE_SIZE) await held;
      await route.continue();
    });

    await signInAs(page, owner.user);
    const response = await page.goto(importPath(ws.id));
    const html = (await response?.text()) ?? '';
    // Page 1's content is in the first response, page 3's is not (its summary is).
    expect(html).toContain(stemOf(first));
    expect(html).not.toContain(stemOf(last));
    await expect(importUi.draftsHeading(page)).toContainText(`${total}개`, { timeout: 30_000 });
    await expect(importUi.selectAll(page)).toHaveAccessibleName(
      new RegExp(`\\(${registrableIn(1, total)}개\\)`),
    );
    // The next page is read ahead.
    await expect.poll(() => reads).toEqual([REVIEW_PAGE_SIZE]);

    const pick = (k: number) => main(page).getByRole('checkbox', { name: `${k}번 문제 선택` });
    await pick(first).check();
    const pager = importUi.pager(page);
    await importUi.pagerPage(pager, 3).click();
    // Not read yet: a loading state, then the page's drafts.
    const section = main(page).getByRole('region', { name: /가져온 (초안|문제)|imported/i });
    await expect(section).toHaveAttribute('aria-busy', 'true');
    await expect(main(page).getByText(/불러오는 중|loading/i)).toBeVisible();
    await expect(importUi.draftItems(page)).toHaveCount(0);
    release();
    await expect(importUi.draftItems(page)).toHaveCount(total - 2 * REVIEW_PAGE_SIZE);
    await expect(section).not.toHaveAttribute('aria-busy', 'true');
    await pick(last).check();
    await expect(importUi.publish(page)).toContainText('(2)');
    // Page 2 was read ahead once; nothing is read twice.
    expect([...reads].sort((a, b) => a - b)).toEqual([REVIEW_PAGE_SIZE, 2 * REVIEW_PAGE_SIZE]);

    // Both selections are registered, whichever page shows.
    const submitted = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/registrations'),
    );
    await importUi.publish(page).click();
    const body = (await submitted).postDataJSON() as { drafts: { draft_id: string }[] };
    const byNumber = new Map((await listDrafts(owner, run.id)).map((d) => [d.position + 1, d.id]));
    expect(body.drafts.map((d) => d.draft_id)).toEqual([byNumber.get(first), byNumber.get(last)]);
    await expect(page.getByRole('status').first()).toContainText(/2\s*개 문제를 문제은행에 등록/, {
      timeout: JOB_TIMEOUT_MS,
    });
    // The list was read again: page 3 still shows, with the draft registered.
    await expect(importUi.draft(page, stemOf(last))).toContainText(/등록됨|registered/i);
    const registered = (await listDrafts(owner, run.id)).filter((d) => d.published_question_id);
    expect(registered.map((d) => d.position + 1).sort((a, b) => a - b)).toEqual([first, last]);
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

/**
 * QIMP-SELECT-FIX (production, 750 drafts): every draft of a run whose LLM assist failed carries
 * `llm_unavailable`, a note about the extraction rather than the draft. It kept every draft out of
 * `전체 선택 (0개)` and read as the generic "확인이 필요한 항목이 있습니다". The note no longer
 * counts as something to check; a draft-level warning still keeps its draft out of the bulk scope
 * while it stays selectable one by one. The validations are stamped in the DB (the APP_ENV=test
 * extraction never calls an LLM).
 */
const ASSIST_COPIES = 93; // 8 × 94 = 752 drafts, like the reported paper

test(
  'QIMPORT-01-AC03 drafts with only an AI assist note are in 전체 선택; a draft warning is selected one by one',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 120_000);
    const owner = await workspaceFactory.member('qimport01-ac03-assist');
    const ws = await workspaceFactory.create(owner);
    const { run } = await importPaperDrafts(owner, ws.id);
    const total = seedImportDraftCopies(run.id, ASSIST_COPIES);
    expect(total).toBe(PAPER.questions.length * (ASSIST_COPIES + 1));
    expect(stampDraftValidation(run.id, 'llm_unavailable')).toBe(total);
    // Every copy of question 2 (answered) also has a draft-level warning.
    const warned = stampDraftValidation(run.id, 'option_sequence_gap', {
      every: PAPER.questions.length,
      offset: 1,
    });
    expect(warned).toBe(ASSIST_COPIES + 1);
    expect(Q(2).answer).not.toBeNull();
    const drafts = await listDrafts(owner, run.id);
    // The server still confirms them as they are (warnings never block).
    expect(drafts.filter((d) => d.publishable).length).toBeGreaterThan(warned);
    expect(drafts.filter((d) => !d.publishable).every((d) => d.answer_missing)).toBe(true);
    const inScope = registrableIn(1, total) - warned;

    await signInAs(page, owner.user);
    await page.goto(importPath(ws.id));
    await expect(importUi.draftsHeading(page)).toContainText(`${total}개`, { timeout: 30_000 });
    const all = importUi.selectAll(page);
    await expect(all).toHaveAccessibleName(new RegExp(`\\(${inScope}개\\)`));
    await expect(all).toBeEnabled();

    // The assist note is a plain Korean note, not something to check.
    const q1 = importUi.draft(page, Q(1).stem).first();
    await expect(q1).toContainText(/참고:\s*AI 보조 정리를 사용할 수 없어/);
    await expect(importUi.drafts(page)).not.toContainText('확인이 필요한 항목이 있습니다');
    const q2 = importUi.draft(page, Q(2).stem).first();
    await expect(q2).toContainText(/확인:\s*보기 번호가 중간에 빠져/);

    await all.click();
    await expect(importUi.publish(page)).toContainText(`(${inScope})`);
    await expect(importUi.select(q1)).toBeChecked();
    // The draft warning keeps question 2 out of the bulk scope, but it can be selected.
    await expect(importUi.select(q2)).toBeEnabled();
    await expect(importUi.select(q2)).not.toBeChecked();
    await importUi.select(q2).click();
    await expect(importUi.select(q2)).toBeChecked();
    await expect(importUi.publish(page)).toContainText(`(${inScope + 1})`);
    await expect(all).toHaveAttribute('aria-checked', 'true');
  },
);

test(
  'QIMPORT-01-AC10 a draft that duplicates a confirmed question is flagged with the reason, left out of the default selection and 전체 선택, and can still be registered on purpose',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qimport01-ac10');
    const ws = await workspaceFactory.create(owner);
    // Question 1 typed by hand before the import: another option order and labels, extra
    // spacing and an empty answer mark (a stem number would make it another question,
    // UX7-DEDUP-2).
    const q1 = Q(1);
    const texts = [...q1.options].reverse().map((o, i) => `(${'ABCD'[i]}) ${o.text}`);
    const answer = truthOptionTexts(q1, q1.answer?.correct_option_labels ?? [])[0] ?? '';
    const existing = await createQuestion(owner, ws.id, {
      ...mcqInput(
        `${q1.stem.replace(/ /g, '  ')} ( )`,
        texts,
        texts.findIndex((t) => t.endsWith(answer)),
      ),
      question_number: 7,
    });

    await signInAs(page, owner.user);
    await uploadQuestionPaper(page, ws.id, PAPER);
    await expect(importUi.draftItems(page)).toHaveCount(PAPER.questions.length, {
      timeout: JOB_TIMEOUT_MS,
    });
    const run = await waitForLatestImport(owner, ws.id);

    // The flag: text, not color, on that draft only.
    const flagged = importUi.draft(page, q1.stem);
    await expect(importUi.duplicate(flagged)).toBeVisible();
    await expect(flagged).toContainText(/이미 등록된 7번 문제와 같습니다|same as question 7/i);
    for (const t of PAPER.questions.filter((q) => q.number !== 1)) {
      await expect(importUi.duplicate(importUi.draft(page, t.stem))).toHaveCount(0);
    }
    const summaries = await owner.api.ok<{
      items: { id: string; duplicate_of: Record<string, unknown> | null }[];
    }>('GET', `/question-imports/${run.id}/draft-summaries`, undefined, [200]);
    const target = draftFor(await listDrafts(owner, run.id), q1);
    expect(
      summaries.items.filter((s) => s.duplicate_of).map((s) => [s.id, s.duplicate_of]),
    ).toEqual([
      [target.id, { kind: 'question', question_id: existing.id, draft_id: null, number: 7 }],
    ]);

    // Not selected by default, not in 전체 선택, selectable on purpose.
    const registrable = PAPER.questions.filter((q) => q.answer !== null);
    const box = importUi.select(flagged);
    await expect(box).not.toBeChecked();
    await expect(box).toBeEnabled();
    const all = importUi.selectAll(page);
    await expect(all).toHaveAccessibleName(new RegExp(`\\(${registrable.length - 1}개\\)`));
    await all.check();
    await expect(box).not.toBeChecked();
    await expect(importUi.publish(page)).toContainText(`(${registrable.length - 1})`);
    await box.check();
    await expect(box).toBeChecked();
    await expect(importUi.publish(page)).toContainText(`(${registrable.length})`);
    await importUi.publish(page).click();
    await expect(importUi.alert(page).or(page.getByRole('status')).first()).toContainText(
      new RegExp(`${registrable.length}\\s*개.*등록`),
    );
    const registered = draftFor(await listDrafts(owner, run.id), q1);
    expect(registered.published_question_id).not.toBeNull();
    expect(await listQuestions(owner, ws.id)).toHaveLength(registrable.length + 1);
  },
);
