// UX12-REEXTRACT (docs/screens/ux12-reextract.md): `다시 추출` in 문제 검토 reads the PDF again as a
// new run with fresh drafts, shows what changed and leaves registered questions as they were.
// The server guarantees live in tests/integration/questions/test_question_reextract.py.
import type { Locator, Page } from '@playwright/test';
import {
  addImportFigure,
  figureUi,
  ratio,
  seedQuestionSource,
  sourceUi,
  watchRegionTraffic,
} from '../fixtures/question-source.ts';
import { draftFor, questionPaper, truthQuestion } from '../fixtures/questions.ts';
import {
  expect,
  getQuestion,
  importPaperDrafts,
  importPath,
  importUi,
  listDrafts,
  overviewPath,
  publishDrafts,
  seedMembership,
  signInAs,
  test,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const paper = questionPaper();
const main = (page: Page) => page.getByRole('main');
const reextractButton = (page: Page) =>
  main(page).getByRole('button', { name: /^(다시 추출|extract again)$/i });
const confirmDialog = (page: Page) =>
  page.getByRole('alertdialog', { name: /다시 추출할까요|extract again/i });
const archiveButton = (scope: Locator) =>
  scope.getByRole('button', { name: /이전 문제 보관|archive the earlier question/i });
const registeredCount = (page: Page) =>
  main(page)
    .getByText(/미등록 \d+개 · 등록 0개/)
    .first();
const changedMark = (draft: Locator) => draft.getByText(/^(변경됨|changed)$/i);

/** Imports the paper and registers questions 1 and 5. */
async function registered(owner: Member, workspaceId: string) {
  const { run, drafts } = await importPaperDrafts(owner, workspaceId, paper);
  const q = (n: number) => draftFor(drafts, truthQuestion(paper, n)).id;
  await publishDrafts(owner, run.id, [q(1), q(5)]);
  const published = await listDrafts(owner, run.id);
  const id = (n: number) =>
    draftFor(published, truthQuestion(paper, n)).published_question_id ?? '';
  return { run, first: await getQuestion(owner, id(1)), fifth: await getQuestion(owner, id(5)) };
}

async function editStem(owner: Member, question: Question, stem: string): Promise<Question> {
  await owner.api.ok(
    'PATCH',
    `/questions/${question.id}`,
    { base_revision_id: question.revision.id, stem },
    [200],
  );
  return getQuestion(owner, question.id);
}

async function runReextract(page: Page): Promise<void> {
  await reextractButton(page).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText(/등록된 문제는 바뀌지 않|registered questions/i);
  await expect(dialog).toContainText(/옮겨지지 않|not carried/i);
  await dialog.getByRole('button', { name: /^(다시 추출|extract again)$/i }).click();
  await expect(main(page).getByText(/다시 추출 결과|extraction result/i)).toBeVisible({
    timeout: 60_000,
  });
}

test(
  'UX12-REEXTRACT-AC01 an editor extracts again and registered questions stay as they were',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('reextract-ac01');
    const ws = await workspaceFactory.create(owner);
    const { run, first } = await registered(owner, ws.id);
    const viewer = await workspaceFactory.member('reextract-ac01-viewer');
    seedMembership(ws.id, viewer.user.id, 'viewer');
    const review = `${importPath(ws.id)}?document=${run.source_document_id ?? ''}`;

    await signInAs(page, viewer.user);
    await page.goto(review);
    await expect(importUi.draftsHeading(page)).toBeVisible();
    await expect(reextractButton(page)).toHaveCount(0);

    await page.context().clearCookies();
    await signInAs(page, owner.user);
    await page.goto(review);
    await runReextract(page);

    await expect(registeredCount(page)).toBeVisible();
    await expect(importUi.select(importUi.draft(page, truthQuestion(paper, 1).stem))).toBeVisible();
    expect(await getQuestion(owner, first.id)).toEqual(first);
    await page.reload();
    await expect(registeredCount(page)).toBeVisible();
  },
);

test(
  'UX12-REEXTRACT-AC02 the review says what changed against the earlier questions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('reextract-ac02');
    const ws = await workspaceFactory.create(owner);
    const { run, fifth } = await registered(owner, ws.id);
    const edited = await editStem(owner, fifth, '등록한 뒤 고친 발문입니다');

    await signInAs(page, owner.user);
    await page.goto(`${importPath(ws.id)}?document=${run.source_document_id ?? ''}`);
    await runReextract(page);

    await expect(main(page).getByText(/변경 1개/)).toBeVisible();
    const changed = importUi.draft(page, truthQuestion(paper, 5).stem);
    await expect(changedMark(changed)).toBeVisible();
    await expect(changed).toContainText(/이전 문제 5번.*발문/);
    await expect(importUi.duplicate(changed)).toHaveCount(0);
    const same = importUi.draft(page, truthQuestion(paper, 1).stem);
    await expect(changedMark(same)).toHaveCount(0);
    await expect(importUi.duplicate(same)).toBeVisible();

    await changed.getByRole('link', { name: /이전 문제 보기|view the earlier question/i }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${ws.id}.*question=${edited.id}`));
  },
);

test(
  'UX12-REEXTRACT-AC03 the earlier question is archived on request and nothing else moves',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('reextract-ac03');
    const ws = await workspaceFactory.create(owner);
    const { run, first, fifth } = await registered(owner, ws.id);
    const edited = await editStem(owner, fifth, '등록한 뒤 고친 발문입니다');

    await signInAs(page, owner.user);
    await page.goto(`${importPath(ws.id)}?document=${run.source_document_id ?? ''}`);
    await runReextract(page);

    const changed = importUi.draft(page, truthQuestion(paper, 5).stem);
    await archiveButton(changed).click();
    const dialog = page.getByRole('alertdialog', { name: /이전 문제 5번을 보관할까요|archive/i });
    await dialog.getByRole('button', { name: /^(보관|archive)$/i }).click();
    await expect(archiveButton(changed)).toHaveCount(0);

    await expect(importUi.select(changed)).not.toBeChecked();
    const archived = await getQuestion(owner, edited.id);
    expect(archived.publication_status).toBe('ARCHIVED');
    expect(archived.revision.correct_option_ids).toEqual(edited.revision.correct_option_ids);
    expect(await getQuestion(owner, first.id)).toEqual(first);
  },
);

/** A figure inside question `n`'s own region of the paper (no block of the paper is an image). */
function figureBox(n: number) {
  const q = truthQuestion(paper, n) as unknown as {
    bbox: { x0: number; y0: number; x1: number; y1: number };
  };
  const { x0, y0, x1, y1 } = q.bbox;
  return { x0, y0, x1, y1: y0 + (y1 - y0) * 0.6 };
}

test(
  'UX12-REEXTRACT-AC04 a figure shows between the stem and the options before submitting',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, `fig-ac04-${Date.now()}`);
    const box = figureBox(1);
    addImportFigure(s.single.id, truthQuestion(paper, 1).page, box);

    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId, s.single.id));
    const panel = page.getByRole('dialog').first();
    const figures = figureUi.images(panel);
    await expect(figures).toHaveCount(1);
    await expect(panel.getByRole('figure')).toHaveCount(1);
    await expect(panel.getByRole('figure')).toHaveText('');

    const shown = await figures.boundingBox();
    if (!shown) throw new Error('no figure box');
    expect(shown.width / shown.height).toBeCloseTo(ratio(box), 1);
    const option = await panel.getByRole('radio').first().boundingBox();
    if (!option) throw new Error('no option box');
    expect(shown.y + shown.height).toBeLessThanOrEqual(option.y);
    await expect(sourceUi.button(panel)).toBeVisible();
  },
);

test(
  'UX12-REEXTRACT-AC05 the PDF is fetched when a figure scrolls into view and not without one',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedQuestionSource(workspaceFactory, `fig-ac05-${Date.now()}`);
    addImportFigure(s.single.id, truthQuestion(paper, 1).page, figureBox(1));
    const long = Array.from({ length: 60 }, (_, i) => `${i + 1}째 줄의 긴 발문입니다.`).join(
      '\n\n',
    );
    await editStem(s.owner, s.single, long);

    await page.setViewportSize({ width: 1280, height: 480 });
    const traffic = watchRegionTraffic(page);
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId, s.twoPage.id));
    await expect(sourceUi.button(page.getByRole('dialog').first())).toBeVisible();
    expect(traffic.pdfRequests(), 'a question without a figure').toBe(0);

    await page.goto(overviewPath(s.workspaceId, s.single.id));
    const panel = page.getByRole('dialog').first();
    await expect(sourceUi.button(panel)).toBeVisible();
    const group = figureUi.group(panel);
    await expect(group).toBeAttached();
    expect(traffic.pdfRequests(), 'the figure is below the fold').toBe(0);

    await group.scrollIntoViewIfNeeded();
    await expect(figureUi.images(panel)).toHaveCount(1);
    await expect.poll(() => traffic.pdfRequests()).toBe(1);
  },
);
