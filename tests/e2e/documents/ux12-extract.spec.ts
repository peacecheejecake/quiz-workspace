// UX12-EXTRACT (docs/screens/ux12-extract.md): a draft question's source blocks are highlighted
// as the whole question in the document viewer, from ids only.
import {
  draftFor,
  editorUi,
  expect,
  importPaperDrafts,
  questionPaper,
  signInAs,
  test,
  truthQuestion,
} from '../fixtures/test.ts';

const documentPath = (workspaceId: string, documentId: string) =>
  `/workspaces/${workspaceId}/documents/${documentId}`;

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('quiz.documentViewer.v1', JSON.stringify({ mode: 'both' })),
  );
});

interface Region {
  readonly page: number;
  readonly bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

test(
  'UX12-EXTRACT-AC01 selecting a block of a draft question highlights the whole question',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-extract-ac01');
    const ws = await workspaceFactory.create(owner);
    const { run, drafts } = await importPaperDrafts(owner, ws.id);
    // Question 3 prints a figure: its caption is a block of its own in the fixture's parse, so
    // the block's box and the question's box differ.
    const q3 = truthQuestion(questionPaper(), 3);
    if (!q3?.figure) throw new Error('questions-ko truth');
    const evidence = draftFor(drafts, q3).payload.evidence[0];
    const locations = (evidence?.locations ?? []) as readonly Region[];
    const region = locations.find((l) => l.page === q3.page)?.bbox;
    if (!region) throw new Error('draft region');

    await signInAs(page, owner.user);
    await page.goto(documentPath(ws.id, run.source_document_id ?? ''));

    await editorUi
      .block(page, q3.figure.caption)
      .getByRole('button', { name: /원문 위치 보기|show source location/i })
      .click();

    const highlight = editorUi.highlight(page);
    await expect(highlight).toBeVisible();
    await expect(async () => {
      const box = await highlight.boundingBox();
      if (!box) throw new Error('no highlight box');
      const expected = (region.x1 - region.x0) / (region.y1 - region.y0);
      expect(Math.abs(box.width / box.height - expected) / expected).toBeLessThan(0.05);
    }).toPass();
    // Still a draft: raw blocks, no question card.
    await expect(editorUi.questionCard(page, 3)).toHaveCount(0);
  },
);

test(
  'UX12-EXTRACT-AC02 the viewer reads block ids only, and only members can',
  { tag: '@infra' },
  async ({ workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-extract-ac02');
    const outsider = await workspaceFactory.member('ux12-extract-ac02-out');
    const ws = await workspaceFactory.create(owner);
    const { run } = await importPaperDrafts(owner, ws.id);
    const path = `/question-imports/${run.id}/draft-summaries`;

    const plain = await owner.api.ok<{ items: { block_ids: string[] }[] }>('GET', path);
    expect(plain.items.every((d) => d.block_ids.length === 0)).toBe(true);

    const withBlocks = await owner.api.ok<{ items: Record<string, unknown>[] }>(
      'GET',
      `${path}?include_blocks=true`,
    );
    expect(withBlocks.items.length).toBeGreaterThan(0);
    for (const item of withBlocks.items) {
      expect((item.block_ids as string[]).length).toBeGreaterThan(0);
      for (const field of ['stem', 'options', 'correct_option_ids', 'explanation', 'payload']) {
        expect(item).not.toHaveProperty(field);
      }
    }

    await outsider.api.ok('GET', `${path}?include_blocks=true`, undefined, [404]);
  },
);
