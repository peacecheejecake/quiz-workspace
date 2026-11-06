// UX12-SPANS (docs/screens/ux12-spans.md): merged table cells in the document view.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';
import { seedDraftTable } from '../fixtures/db';
import { uploadReadyBook } from '../fixtures/documents';
import { editorUi, signInAs } from '../fixtures/workspace-ui';
import type { Member } from '../fixtures/workspaces';

const MERGED_HEADER = '공정 안내';
const MERGED_BODY = '응집과 침전';
const SEEDED = {
  rows: [
    [MERGED_HEADER, MERGED_HEADER, '예시 체류 시간'],
    [MERGED_BODY, '미세 입자 결합', '약 30분'],
    [MERGED_BODY, '플록 가라앉힘', '약 3시간'],
    ['여과', '남은 입자 제거', '약 1시간'],
    ['소독', '미생물 억제', '약 30분'],
  ],
  spans: [
    { row: 0, col: 0, row_span: 1, col_span: 2 },
    { row: 1, col: 0, row_span: 2, col_span: 1 },
  ],
};

interface TableBlock {
  readonly block_id: string;
  readonly type: string;
  readonly text: string;
  readonly table: {
    readonly rows: readonly (readonly string[])[];
    readonly spans?: readonly object[] | null;
  } | null;
}

async function tableBlock(owner: Member, documentId: string): Promise<TableBlock> {
  const { items } = await owner.api.ok<{ items: TableBlock[] }>(
    'GET',
    `/documents/${documentId}/blocks?revision=latest&limit=500`,
  );
  const found = items.find((block) => block.type === 'table');
  if (!found) throw new Error('book-ko has a table');
  return found;
}

const patchBlock = (owner: Member, documentId: string, blockId: string, text: string) =>
  owner.api.ok('PATCH', `/documents/${documentId}/blocks/${encodeURIComponent(blockId)}`, { text });

/** A draft whose table block has merged cells: a text edit opens the draft, the seed sets them. */
async function seedMergedTable(owner: Member, documentId: string): Promise<TableBlock> {
  const block = await tableBlock(owner, documentId);
  await patchBlock(owner, documentId, block.block_id, block.text.replace('약 30분', '30분'));
  seedDraftTable(documentId, block.block_id, SEEDED);
  return tableBlock(owner, documentId);
}

const openDocument = (page: Page, workspaceId: string, documentId: string) =>
  page.goto(`/workspaces/${workspaceId}/documents/${documentId}`);

const shownTable = (page: Page, text: string) => editorUi.block(page, text).getByRole('table');

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('quiz.documentViewer.v1', JSON.stringify({ mode: 'both' })),
  );
});

test(
  'UX12-SPANS-AC01 a merged cell is one cell with colSpan or rowSpan and its text once',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-spans-ac01');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const block = await seedMergedTable(owner, documentId);
    expect(block.table?.spans).toEqual(SEEDED.spans);
    expect(block.table?.rows).toEqual(SEEDED.rows);

    await signInAs(page, owner.user);
    await openDocument(page, ws.id, documentId);

    const table = shownTable(page, MERGED_BODY);
    const header = table.getByRole('columnheader', { name: MERGED_HEADER });
    await expect(header).toHaveCount(1);
    await expect(header).toHaveAttribute('colspan', '2');
    const body = table.getByRole('cell', { name: MERGED_BODY });
    await expect(body).toHaveCount(1);
    await expect(body).toHaveAttribute('rowspan', '2');

    const rows = table.getByRole('row');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0).getByRole('columnheader')).toHaveCount(2);
    await expect(rows.nth(1).getByRole('cell')).toHaveCount(3);
    await expect(rows.nth(2).getByRole('cell')).toHaveCount(2);
    await expect(rows.nth(3).getByRole('cell')).toHaveCount(3);
  },
);

test(
  'UX12-SPANS-AC02 a table without spans keeps its plain grid',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-spans-ac02');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const block = await tableBlock(owner, documentId);
    expect(block.table?.spans ?? null).toBeNull();

    await signInAs(page, owner.user);
    await openDocument(page, ws.id, documentId);

    const table = shownTable(page, '플록 가라앉힘');
    await expect(table.getByRole('columnheader')).toHaveCount(3);
    await expect(table.getByRole('cell')).toHaveCount(12);
    await expect(table.locator('[colspan], [rowspan]')).toHaveCount(0);
  },
);

test(
  'UX12-SPANS-AC03 editing the table drops the spans and an unchanged save keeps them',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-spans-ac03');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const block = await seedMergedTable(owner, documentId);

    await patchBlock(owner, documentId, block.block_id, block.text);
    expect((await tableBlock(owner, documentId)).table?.spans).toEqual(SEEDED.spans);

    await signInAs(page, owner.user);
    await openDocument(page, ws.id, documentId);
    const article = editorUi.block(page, MERGED_BODY).filter({ has: page.getByRole('table') });
    await editorUi.editButton(article).click();
    await editorUi.blockTextbox(page).fill(block.text.replace('약 1시간', '약 2시간'));
    await editorUi.saveButton(page).click();

    const table = shownTable(page, '약 2시간');
    await expect(table.locator('[colspan], [rowspan]')).toHaveCount(0);
    await expect(table.getByRole('columnheader', { name: MERGED_HEADER })).toHaveCount(2);
    await expect(table.getByRole('cell', { name: MERGED_BODY })).toHaveCount(2);
    expect((await tableBlock(owner, documentId)).table?.spans ?? null).toBeNull();
  },
);
