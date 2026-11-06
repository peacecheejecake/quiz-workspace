// QTABLE-01 (docs/screens/question-tables.md): tables printed in a stem are shown as tables and
// option tables as aligned columns, on the synthetic questions-tables-ko paper and on registered
// questions. Parsing and the Python/TS parity live in Vitest and pytest.
import type { Locator, Page } from '@playwright/test';
import { draftFor, questionPaper, truthQuestion } from '../fixtures/questions.ts';
import {
  choosePanelManage,
  createQuestion,
  detailUi,
  expect,
  importPaperDrafts,
  importPath,
  importUi,
  listDrafts,
  mcqInput,
  overviewPath,
  overviewUi,
  panelUi,
  publishDrafts,
  RESULT_TEXT,
  signInAs,
  test,
  type Member,
} from '../fixtures/test.ts';
import { editorUi } from '../fixtures/workspace-ui.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const paper = () => questionPaper('questions-tables-ko');

/** Questions made through the API have no printed number. */
const questionPanel = (page: Page): Locator =>
  page.getByRole('dialog', { name: /번 문제|번호 없음|question \d|no number/i });

async function openPanel(
  page: Page,
  member: Member,
  workspaceId: string,
  questionId: string,
): Promise<Locator> {
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId, questionId));
  const panel = questionPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function left(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box');
  return box.x;
}

/** Imports the paper and registers questions 1 and 2 (question 3 has no answer). */
async function registeredPaper(owner: Member, workspaceId: string) {
  const { run, drafts } = await importPaperDrafts(owner, workspaceId, paper());
  const ids = [1, 2].map((n) => draftFor(drafts, truthQuestion(paper(), n)).id);
  await publishDrafts(owner, run.id, ids);
  const published = await listDrafts(owner, run.id);
  const questionId = (n: number) =>
    draftFor(published, truthQuestion(paper(), n)).published_question_id ?? '';
  return { run, questionId };
}

test(
  'QTABLE-01-AC01 a table printed in a stem stays in place and the draft stays in 전체 선택',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qtable-ac01');
    const ws = await workspaceFactory.create(owner);
    const { run, drafts } = await importPaperDrafts(owner, ws.id, paper());
    const q1 = truthQuestion(paper(), 1);
    const stem = draftFor(drafts, q1).payload.stem;
    const at = (text: string) => stem.indexOf(text);
    expect(at('| 단계 | 주요 작용 | 예시 체류 시간 |')).toBeGreaterThan(at(q1.stem));
    expect(at('위 표에서')).toBeGreaterThan(at('| 침전 | 플록 가라앉힘 | 약 3시간 |'));
    expect(draftFor(drafts, q1).validations.map((v) => v.code)).toContain('table_in_stem');

    await signInAs(page, owner.user);
    await page.goto(`${importPath(ws.id)}?document=${run.source_document_id ?? ''}`);
    const draft = importUi.draft(page, q1.stem);
    const table = draft.getByRole('table');
    await expect(table.getByRole('columnheader', { name: '주요 작용' })).toBeVisible();
    await expect(table.getByRole('cell', { name: '플록 가라앉힘' })).toBeVisible();
    await expect(draft).toContainText(/참고:\s*표를/);
    const columns = importUi.draft(page, truthQuestion(paper(), 2).stem);
    await expect(columns.getByText('미세 입자 결합', { exact: true })).toBeVisible();
    await expect(columns.getByText('주요 작용', { exact: true }).first()).toBeVisible();

    await importUi.selectAll(page).click();
    await expect(importUi.select(draft)).toBeChecked();
  },
);

test(
  'QTABLE-01-AC02 a wide table scrolls inside its region at 375px',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qtable-ac02');
    const ws = await workspaceFactory.create(owner);
    const cells = Array.from({ length: 8 }, (_, i) => `열${i + 1}번째머리글`);
    const stem = [
      '다음 표를 보시오.',
      '',
      `| ${cells.join(' | ')} |`,
      `|${' --- |'.repeat(cells.length)}`,
      `| ${cells.join(' | ')} |`,
    ].join('\n');
    const question = await createQuestion(owner, ws.id, mcqInput(stem, ['가', '나', '다', '라']));

    await page.setViewportSize({ width: 375, height: 800 });
    const panel = await openPanel(page, owner, ws.id, question.id);
    const region = panel.getByRole('region', { name: /^(표|table)$/i });
    await expect(region.getByRole('table')).toBeVisible();
    await expect
      .poll(() => region.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeGreaterThan(0);
    await region.focus();
    await expect(region).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
  },
);

test(
  'QTABLE-01-AC03 an option table lines up in the radio rows under its header and grades by id',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qtable-ac03');
    const ws = await workspaceFactory.create(owner);
    const { questionId } = await registeredPaper(owner, ws.id);

    const panel = await openPanel(page, owner, ws.id, questionId(2));
    await expect(panel.getByText(truthQuestion(paper(), 2).stem, { exact: true })).toBeVisible();
    const first = panel.getByText('미세 입자 결합', { exact: true });
    const second = panel.getByText('플록 가라앉힘', { exact: true });
    const header = panel.getByText('주요 작용', { exact: true }).first();
    await expect(header).toBeVisible();
    expect(await left(first)).toBeCloseTo(await left(second), 0);
    expect(await left(header)).toBeCloseTo(await left(first), 0);

    const option = panel.getByRole('radio', { name: /단계:\s*응집 주요 작용:\s*미세 입자 결합/ });
    await option.check({ force: true });
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
  },
);

test(
  'QTABLE-01-AC04 registered questions line up without a new import and uneven options stay text',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qtable-ac04');
    const ws = await workspaceFactory.create(owner);
    const even = await createQuestion(
      owner,
      ws.id,
      mcqInput('다음 중 옳은 것은? ( ) 구분 | 내용', [
        '가 | 하나',
        '나 | 둘',
        '다 | 셋',
        '라 | 넷',
      ]),
    );
    const uneven = await createQuestion(
      owner,
      ws.id,
      mcqInput('다음 중 맞는 것은? 구분 | 내용', ['가 | 하나', '나', '다 | 셋', '라 | 넷']),
    );

    let panel = await openPanel(page, owner, ws.id, even.id);
    await expect(panel.getByRole('radio', { name: /구분:\s*가 내용:\s*하나/ })).toBeVisible();
    await expect(panel.getByText('다음 중 옳은 것은?', { exact: true })).toBeVisible();

    await page.goto(overviewPath(ws.id, uneven.id));
    panel = questionPanel(page);
    await expect(panelUi.option(panel, '가 | 하나')).toBeVisible();
    await expect(panel.getByText('다음 중 맞는 것은? 구분 | 내용', { exact: true })).toBeVisible();
  },
);

test(
  'QTABLE-01-AC05 a malformed table stays text and a one-line preview stays one line',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qtable-ac05');
    const ws = await workspaceFactory.create(owner);
    const malformed = await createQuestion(
      owner,
      ws.id,
      mcqInput('표를 보시오.\n\n| 단계 | 작용 |\n| --- | --- |\n| 응집 | 결합 | 여분 |', [
        '가',
        '나',
      ]),
    );
    const wellFormed = await createQuestion(
      owner,
      ws.id,
      mcqInput('표를 보시오.\n\n| 단계 | 작용 |\n| --- | --- |\n| 응집 | 결합 |', ['가', '나']),
    );

    let panel = await openPanel(page, owner, ws.id, malformed.id);
    await expect(panel.getByRole('table')).toHaveCount(0);
    await expect(panel.getByText(/응집 \| 결합 \| 여분/)).toBeVisible();

    await page.goto(overviewPath(ws.id, wellFormed.id));
    panel = questionPanel(page);
    await expect(panel.getByRole('table')).toBeVisible();
    await panelUi.close(panel).click();

    await overviewUi
      .heatmap(page)
      .getByRole('button', { name: /객관식/ })
      .nth(1)
      .hover();
    const preview = overviewUi.tooltip(page);
    await expect(preview).toContainText('표를 보시오. | 단계 | 작용 |');
    await expect(preview.getByRole('table')).toHaveCount(0);
  },
);

test(
  'QTABLE-01-AC06 question details and the document card use the same table and columns',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qtable-ac06');
    const ws = await workspaceFactory.create(owner);
    const { run, questionId } = await registeredPaper(owner, ws.id);

    const panel = await openPanel(page, owner, ws.id, questionId(2));
    await choosePanelManage(page, panel, 'answers');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    const row = detailUi.correctOptions(detail);
    await expect(row).toHaveCount(1);
    await expect(row.getByText('미세 입자 결합', { exact: true })).toBeVisible();
    await expect(detail.getByText('주요 작용', { exact: true }).first()).toBeVisible();
    await detailUi.close(detail).click();

    await page.addInitScript(() =>
      localStorage.setItem('quiz.documentViewer.v1', JSON.stringify({ mode: 'both' })),
    );
    await page.goto(`/workspaces/${ws.id}/documents/${run.source_document_id ?? ''}`);
    const first = editorUi.questionCard(page, 1);
    await expect(first.getByRole('columnheader', { name: '주요 작용' })).toBeVisible();
    const second = editorUi.questionCard(page, 2);
    await expect(second.getByText('미세 입자 결합', { exact: true })).toBeVisible();
    await expect(second.getByText('단계와 주요 작용이 옳은 것은?', { exact: true })).toBeVisible();
  },
);
