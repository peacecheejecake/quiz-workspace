// QGEN-01 — 문제 변형 출제 (`/workspaces/:workspaceId/questions/generate`),
// docs/screens/questions-generation.md; variation rules docs/questions.md §5 (OPTION_SHUFFLE never
// creates a question or a dot; LLM variants are isolated drafts with diff + source + validation
// until a human approves them; the LLM's declared answer is never trusted), §8 (dot counts).
//
// Each test signs in its own owner with a fresh workspace. LLM variants start from a source MCQ
// built from tests/fixtures/llm/generation-scenarios.json whose stem carries the scenario marker
// that the APP_ENV=test worker's ScenarioLLMClient answers (fixtures/generation.ts G1); it cites
// page 4 of the synthetic book-ko.pdf uploaded through the public flow. Server state (bank,
// overview dots, attempts, lineage) is checked through the public API. Every endpoint/label
// assumption is in the fixtures/generation.ts header (G1–G6).
import type { Locator, Page } from '@playwright/test';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';
import {
  chooseQuestionMenu,
  createQuestion,
  expect,
  GENERATE_TASK,
  generatePath,
  generateUi,
  generationSourceInput,
  getGeneratedQuestion,
  getOverview,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  listAttempts,
  listGenerationDrafts,
  listGenerations,
  listQuestions,
  numberedMcq,
  pageLabel,
  panelUi,
  RESULT_TEXT,
  scenarioCandidate,
  signInAs,
  test,
  uploadReadyBook,
  waitForLatestGeneration,
  type Question,
  type SourceName,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 60_000 });

/** Owner + workspace + book-ko.pdf + the scenario source question (number 1, cites p.4). */
async function seedSource(workspaceFactory: WorkspaceFactory, label: string, name: SourceName) {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  const source = await createQuestion(owner, ws.id, generationSourceInput(name, documentId));
  return { owner, workspaceId: ws.id, documentId, source };
}

/** Opens the generate screen for `source` and checks it shows the original. */
async function openGenerate(page: Page, workspaceId: string, source: Question): Promise<void> {
  await page.goto(generatePath(workspaceId, source.id));
  await expect(generateUi.heading(page)).toHaveText(/문제 변형 출제|변형 출제|generate/i);
  await expect(generateUi.source(page)).toContainText(source.revision.stem);
}

/** Option texts of the panel in on-screen (top-to-bottom) order. */
async function displayedOrder(panel: Locator, texts: readonly string[]): Promise<string[]> {
  const placed = await Promise.all(
    texts.map(async (text) => ({ text, y: (await panelUi.option(panel, text).boundingBox())?.y })),
  );
  for (const p of placed) expect(p.y, `option "${p.text}" is shown`).toBeDefined();
  return placed.sort((a, b) => (a.y ?? 0) - (b.y ?? 0)).map((p) => p.text);
}

async function joined(locator: Locator): Promise<string> {
  return (await locator.allInnerTexts()).join('');
}

test(
  'QGEN-01-AC01 shuffling a confirmed MCQ stores only the displayed order on a practice session of the original',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qgen01-ac01');
    const ws = await workspaceFactory.create(owner);
    const source = await createQuestion(owner, ws.id, numberedMcq('qgen01-ac01', 1, 2));
    const texts = source.revision.options.map((o) => o.text);
    expect((await getOverview(owner, ws.id)).counts.total).toBe(1);

    await signInAs(page, owner.user);
    await openGenerate(page, ws.id, source);
    await generateUi.variation(page, 'OPTION_SHUFFLE').check();
    await generateUi.generate(page).click();

    // The original question opens for practice in a shuffled order (no run, no draft).
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    await expect(panelUi.options(panel)).toHaveCount(4);
    const order = await displayedOrder(panel, texts);
    await panelUi.option(panel, texts[2] ?? '').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);

    // The order lives on the original question's attempt; nothing new was created.
    const [attempt, ...older] = await listAttempts(owner, source.id);
    expect(older).toEqual([]);
    expect(attempt?.question_revision_id).toBe(source.revision.id);
    expect(attempt?.displayed_option_ids).toEqual(
      order.map((t) => source.revision.options.find((o) => o.text === t)?.id),
    );
    expect(await listQuestions(owner, ws.id)).toHaveLength(1);
    expect((await getOverview(owner, ws.id)).counts.total).toBe(1);
    expect(await listGenerations(owner, ws.id)).toEqual([]);
  },
);

test(
  'QGEN-01-AC02 a paraphrase draft shows its diff against the original, source evidence and validation status',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedSource(workspaceFactory, 'qgen01-ac02', 'disinfection');
    const candidate = scenarioCandidate('E2E-LLM-OK', GENERATE_TASK.PARAPHRASE);

    await signInAs(page, s.owner.user);
    await openGenerate(page, s.workspaceId, s.source);
    await generateUi.variation(page, 'PARAPHRASE').check();
    await generateUi.generate(page).click();
    await expect(generateUi.draftItems(page)).toHaveCount(1, { timeout: JOB_TIMEOUT_MS });

    const draft = generateUi.draftItems(page).first();
    await expect(draft).toContainText(candidate.stem.slice(0, 20));
    // Diff against the original: words only the variant has / only the original had.
    expect(await joined(generateUi.insertions(draft))).toContain('투입');
    expect(await joined(generateUi.deletions(draft))).toContain('넣');
    await expect(draft).toContainText(candidate.justification);
    await expect(generateUi.evidence(draft, pageLabel(4)).first()).toBeVisible();
    await expect(generateUi.validationOk(draft)).toBeVisible();

    // Still a draft: no new bank question, no new dot (questions.md §8).
    const run = await waitForLatestGeneration(s.owner, s.workspaceId);
    expect(run).toMatchObject({ status: 'succeeded', source_question_id: s.source.id });
    const [stored] = await listGenerationDrafts(s.owner, run.id);
    expect(stored).toMatchObject({ review_status: 'pending', published_question_id: null });
    expect(await listQuestions(s.owner, s.workspaceId)).toHaveLength(1);
    expect((await getOverview(s.owner, s.workspaceId)).counts.total).toBe(1);
  },
);

test(
  'QGEN-01-AC03 inverting "옳지 않은 것" into "옳은 것" with several correct options warns and blocks approval',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedSource(workspaceFactory, 'qgen01-ac03', 'not-correct');

    await signInAs(page, s.owner.user);
    await openGenerate(page, s.workspaceId, s.source);
    await generateUi.variation(page, 'INVERT_POLARITY').check();
    await generateUi.generate(page).click();
    await expect(generateUi.draftItems(page)).toHaveCount(1, { timeout: JOB_TIMEOUT_MS });

    const draft = generateUi.draftItems(page).first();
    await expect(generateUi.multipleAnswers(draft)).toBeVisible();
    await expect(generateUi.validationOk(draft)).toHaveCount(0);
    await expect(generateUi.approve(draft)).toBeDisabled();

    // The server agrees: the draft is not publishable and nothing was registered.
    const run = await waitForLatestGeneration(s.owner, s.workspaceId);
    const [stored] = await listGenerationDrafts(s.owner, run.id);
    expect(stored?.publishable).toBe(false);
    expect(stored?.validations.some((v) => v.severity === 'error')).toBe(true);
    expect(await listQuestions(s.owner, s.workspaceId)).toHaveLength(1);
    expect((await getOverview(s.owner, s.workspaceId)).counts.total).toBe(1);
  },
);

test(
  'QGEN-01-AC04 approving an analogous-concept draft registers a new confirmed question with lineage and document evidence',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedSource(workspaceFactory, 'qgen01-ac04', 'disinfection');
    const candidate = scenarioCandidate('E2E-LLM-OK', GENERATE_TASK.ANALOGOUS_CONCEPT);

    await signInAs(page, s.owner.user);
    await openGenerate(page, s.workspaceId, s.source);
    await generateUi.variation(page, 'ANALOGOUS_CONCEPT').check();
    await generateUi.generate(page).click();
    await expect(generateUi.draftItems(page)).toHaveCount(1, { timeout: JOB_TIMEOUT_MS });

    const draft = generateUi.draftItems(page).first();
    await expect(draft).toContainText(candidate.stem.slice(0, 20));
    await expect(generateUi.evidence(draft, pageLabel(4)).first()).toBeVisible();
    await expect(generateUi.validationOk(draft)).toBeVisible();
    await generateUi.approve(draft).check();
    await generateUi.publish(page).click();
    await expect(generateUi.published(draft)).toBeVisible();

    // A new CONFIRMED question (one more dot) with lineage to the original and book evidence.
    const run = await waitForLatestGeneration(s.owner, s.workspaceId);
    const [stored] = await listGenerationDrafts(s.owner, run.id);
    expect(stored?.published_question_id).toBeTruthy();
    const created = await getGeneratedQuestion(s.owner, stored?.published_question_id ?? '');
    expect(created).toMatchObject({
      publication_status: 'CONFIRMED',
      origin: 'generation',
      lineage: {
        parent_question_id: s.source.id,
        source_question_revision_id: s.source.revision.id,
        variation_type: 'ANALOGOUS_CONCEPT',
        generation_run_id: run.id,
      },
    });
    expect(created.revision.stem).toBe(candidate.stem);
    expect(created.sources).toContainEqual(
      expect.objectContaining({ document_id: s.documentId, page_start: 4 }),
    );
    const bank = await listQuestions(s.owner, s.workspaceId);
    expect(bank.map((q) => q.id).sort()).toEqual([s.source.id, created.id].sort());
    expect((await getOverview(s.owner, s.workspaceId)).counts.total).toBe(2);
    // The original is untouched.
    expect((await getGeneratedQuestion(s.owner, s.source.id)).revision.id).toBe(
      s.source.revision.id,
    );
  },
);

test(
  'QGEN-01-AC05 문제 › 변형 출제 opens a dialog to pick the source and submit the form, then the review page follows the run',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedSource(workspaceFactory, 'qgen01-ac05', 'disinfection');
    const candidate = scenarioCandidate('E2E-LLM-OK', GENERATE_TASK.PARAPHRASE);

    await signInAs(page, s.owner.user);
    await page.goto(homePath(s.workspaceId));
    await chooseQuestionMenu(page, 'generate');
    await expect(page).toHaveURL(/[?&]panel=generate(&|$)/);
    const dialog = homeUi.generateDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
    const sources = dialog.getByRole('list', { name: /원본으로 쓸 문제|source question/i });
    await sources.getByRole('button').filter({ hasText: s.source.revision.stem }).click();
    await expect(dialog.getByRole('region', { name: /원본 문제|source/i })).toContainText(
      s.source.revision.stem,
    );
    await generateUi.variation(page, 'PARAPHRASE').check();
    await dialog.getByRole('button', { name: /^(생성|generate)$/i }).click();

    // The review page takes over the run (source + run in the URL).
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === generatePath(s.workspaceId) &&
        url.searchParams.get('source') === s.source.id &&
        !!url.searchParams.get('run'),
    );
    await expect(generateUi.heading(page)).toHaveText(/문제 변형 출제|변형 출제|generate/i);
    await expect(generateUi.draftItems(page)).toHaveCount(1, { timeout: JOB_TIMEOUT_MS });
    await expect(generateUi.draftItems(page).first()).toContainText(candidate.stem.slice(0, 20));
    expect(await listGenerations(s.owner, s.workspaceId)).toHaveLength(1);

    // 보기 섞기 from the dialog starts no run: the original opens for practice on the home.
    await page.goto(homePath(s.workspaceId, 'panel=generate'));
    await homeUi
      .generateDialog(page)
      .getByRole('list', { name: /원본으로 쓸 문제|source question/i })
      .getByRole('button')
      .filter({ hasText: s.source.revision.stem })
      .click();
    await generateUi.variation(page, 'OPTION_SHUFFLE').check();
    await homeUi
      .generateDialog(page)
      .getByRole('button', { name: /^(생성|generate)$/i })
      .click();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('question') === s.source.id && !url.searchParams.has('panel'),
    );
    await expect(panelUi.panel(page)).toBeVisible();
    await expect(homeUi.generateDialog(page)).toHaveCount(0);
    expect(await listGenerations(s.owner, s.workspaceId)).toHaveLength(1);
  },
);
