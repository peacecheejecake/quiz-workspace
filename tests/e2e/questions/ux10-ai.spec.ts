import { listDocuments, outlineNodeId, uploadReadyBook } from '../fixtures/documents.ts';
import {
  bank,
  correctText,
  explainCalls,
  EXPL_PROBLEMS,
  EXPL_TEXT,
  explMcq,
  explUi,
  getExplanation,
  seedExplanation,
  startExplanationsOffStack,
} from '../fixtures/ai-explanations.ts';
import {
  noteQuestion,
  notePanelPath,
  noteUi,
  startChapterNotesOffStack,
  startNote,
  waitForNote,
} from '../fixtures/chapter-notes.ts';
import {
  disableAutoSummary,
  startSummary,
  startSummaryOffStack,
  summaryPanelPath,
  summaryUi,
  waitForSummaryRun,
} from '../fixtures/summary.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';
import {
  createQuestion,
  expect,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  signInAs,
  startPractice,
  submitPractice,
  test,
} from '../fixtures/test.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  trace: 'off',
  screenshot: 'off',
  video: 'off',
});

async function setup(workspaceFactory: WorkspaceFactory) {
  const owner = await workspaceFactory.member('ux10-ai');
  const workspace = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, workspace.id, 'book-ko');
  const chapter = await outlineNodeId(owner, documentId, '1장 물의 순환');
  const question = await createQuestion(
    owner,
    workspace.id,
    explMcq('ux10-ai', 1, documentId, chapter, []),
  );
  return { owner, workspace, question, documentId, chapter };
}

test('UX10-AI-AC01 feature off hides the new explanation action', async ({
  page,
  workspaceFactory,
}) => {
  const { owner, workspace, question } = await setup(workspaceFactory);
  await signInAs(page, owner.user);
  const off = await startExplanationsOffStack();
  try {
    await page.goto(`${off.webUrl}${overviewPath(workspace.id)}`);
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await panelUi.option(panel, correctText(question)).check();
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    await expect(explUi.create(explUi.area(panel))).toHaveCount(0);
  } finally {
    await off.stop();
  }
});

test('UX10-AI-AC02 cached explanation opens and absent explanation makes no request', async ({
  page,
  workspaceFactory,
}) => {
  const { owner, workspace, question, documentId, chapter } = await setup(workspaceFactory);
  const absent = await createQuestion(
    owner,
    workspace.id,
    explMcq('ux10-ai-absent', 2, documentId, chapter, []),
  );
  await seedExplanation(owner, bank(question.id));
  const before = explainCalls(question.id);
  await signInAs(page, owner.user);
  await page.goto(overviewPath(workspace.id));
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await panelUi.option(panel, correctText(question)).check();
  await panelUi.submit(panel).click();
  await expect(explUi.show(explUi.area(panel))).toHaveAttribute('aria-expanded', 'true');
  expect(explainCalls(question.id)).toBe(before);
  await panelUi.close(panel).click();
  await overviewUi.dot(page, 2).click();
  const emptyPanel = panelUi.numbered(page, 2);
  await panelUi.option(emptyPanel, correctText(absent)).check();
  await panelUi.submit(emptyPanel).click();
  await expect(explUi.create(explUi.area(emptyPanel))).toBeVisible();
  await expect(
    emptyPanel.getByText('문제와 정답, 관련 교재 구절이 AI 서비스로 전송됩니다.'),
  ).toHaveCount(0);
  expect(explainCalls(absent.id)).toBe(0);
});

test('UX10-AI-AC03 before submission no explanation is disclosed', async ({ workspaceFactory }) => {
  const { owner, question } = await setup(workspaceFactory);
  const session = await startPractice(owner, question.id);
  const result = await getExplanation(owner, bank(question.id), {
    practice_session_id: session.id,
  });
  expect(result.status).toBe(409);
  expect(explainCalls(question.id)).toBe(0);
});

test('UX10-AI-AC04 off API rejects generation and retains cached reads', async ({
  workspaceFactory,
}) => {
  const { owner, question } = await setup(workspaceFactory);
  await seedExplanation(owner, bank(question.id));
  const session = await startPractice(owner, question.id);
  const option = question.revision.options.find((item) => item.text === correctText(question));
  if (!option) throw new Error('Correct option missing');
  await submitPractice(owner, session.id, { selected_option_ids: [option.id] });
  const off = await startExplanationsOffStack();
  try {
    const read = await off.request<{ explanation: { id: string } | null }>(
      owner,
      'GET',
      `/questions/${question.id}/ai-explanation?practice_session_id=${session.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.body?.explanation).not.toBeNull();
    const create = await off.request<{ type: string }>(
      owner,
      'POST',
      `/questions/${question.id}/ai-explanation/regenerate`,
      {
        practice_session_id: session.id,
      },
    );
    expect(create.status).toBe(409);
    expect(create.body?.type).toBe(EXPL_PROBLEMS.disabled);
  } finally {
    await off.stop();
  }
});

/** A book with a stored summary and one without (UX12-AIOFF), with their listed titles. */
async function summaryBooks(workspaceFactory: WorkspaceFactory) {
  const owner = await workspaceFactory.member('ux12-aioff');
  const workspace = await workspaceFactory.create(owner);
  const summarized = await uploadReadyBook(owner, workspace.id, 'book-ko');
  const plain = await uploadReadyBook(owner, workspace.id, 'book-en');
  await startSummary(owner, summarized);
  await waitForSummaryRun(owner, summarized, 'succeeded');
  const listed = await listDocuments(owner, workspace.id);
  const title = (id: string) => listed.find((d) => d.id === id)?.title ?? '';
  return { owner, workspace, summarized, plain, title };
}

test(
  'UX12-AIOFF-AC01 only a stored summary keeps the summary entry points with the LLM off',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace, summarized, plain, title } = await summaryBooks(workspaceFactory);
    await signInAs(page, owner.user);
    const off = await startSummaryOffStack();
    try {
      await page.goto(`${off.webUrl}/workspaces/${workspace.id}?panel=documents`);
      const stored = summaryUi.rowButton(page, title(summarized));
      await expect(stored).toBeVisible();
      await expect(summaryUi.rowButton(page, title(plain))).toHaveCount(0);
      await stored.click();
      await expect(summaryUi.overallHeading(summaryUi.panel(page))).toBeVisible();

      await page.goto(`${off.webUrl}/workspaces/${workspace.id}/documents/${summarized}`);
      await expect(summaryUi.editorLink(page)).toBeVisible();
      await page.goto(`${off.webUrl}/workspaces/${workspace.id}/documents/${plain}`);
      await expect(page.getByRole('heading', { name: title(plain) })).toBeVisible();
      await expect(summaryUi.editorLink(page)).toHaveCount(0);
    } finally {
      await off.stop();
    }
  },
);

test(
  'UX12-AIOFF-AC02 the summary panel has no create action, notice or reason with the LLM off',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { owner, workspace, summarized, plain } = await summaryBooks(workspaceFactory);
    await disableAutoSummary(owner, summarized);
    await signInAs(page, owner.user);
    const off = await startSummaryOffStack();
    try {
      await page.goto(`${off.webUrl}${summaryPanelPath(workspace.id, plain)}`);
      let panel = summaryUi.panel(page);
      await expect(summaryUi.empty(panel)).toBeVisible();
      await expect(summaryUi.createButton(panel)).toHaveCount(0);
      await expect(summaryUi.sendNotice(panel)).toHaveCount(0);
      await expect(panel.getByText(summaryUi.unavailableReason)).toHaveCount(0);

      await page.goto(`${off.webUrl}${summaryPanelPath(workspace.id, summarized)}`);
      panel = summaryUi.panel(page);
      await expect(summaryUi.overallHeading(panel)).toBeVisible();
      await expect(summaryUi.autoOff(panel)).toBeVisible();
      await expect(summaryUi.createButton(panel)).toHaveCount(0);
      await expect(panel.getByText(/다시 켜면|turning it back on/i)).toHaveCount(0);
      await expect(panel.getByText(summaryUi.unavailableReason)).toHaveCount(0);
    } finally {
      await off.stop();
    }
  },
);

test(
  'UX12-AIOFF-AC03 the note panel has no create action, notice or reason with the LLM off',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-aioff-note');
    const workspace = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, workspace.id, 'book-ko');
    const noted = await outlineNodeId(owner, documentId, '1장 물의 순환');
    const empty = await outlineNodeId(owner, documentId, '2장 정수 처리');
    const sources = [{ document_id: documentId, page_start: 2, page_end: 3 }];
    await createQuestion(owner, workspace.id, noteQuestion('aioff', 1, noted, 'ok', { sources }));
    await createQuestion(owner, workspace.id, noteQuestion('aioff', 2, empty, 'ok', { sources }));
    await startNote(owner, noted);
    await waitForNote(owner, noted, 'succeeded');
    await signInAs(page, owner.user);
    const off = await startChapterNotesOffStack();
    try {
      await page.goto(`${off.webUrl}${notePanelPath(workspace.id, empty)}`);
      let panel = noteUi.panel(page);
      await expect(noteUi.empty(panel)).toBeVisible();
      await expect(noteUi.create(panel)).toHaveCount(0);
      await expect(noteUi.sendNotice(panel)).toHaveCount(0);
      await expect(panel.getByText(noteUi.unavailableReason)).toHaveCount(0);

      await page.goto(`${off.webUrl}${notePanelPath(workspace.id, noted)}`);
      panel = noteUi.panel(page);
      await expect(noteUi.aiBadge(panel)).toBeVisible();
      await expect(noteUi.regenerate(panel)).toHaveCount(0);
      await expect(panel.getByText(noteUi.unavailableReason)).toHaveCount(0);
    } finally {
      await off.stop();
    }
  },
);

test('UX12-AIOFF-AC04 no explanation means no button and no reason with the LLM off', async ({
  page,
  workspaceFactory,
}) => {
  const { owner, workspace, question, documentId, chapter } = await setup(workspaceFactory);
  const stored = await createQuestion(
    owner,
    workspace.id,
    explMcq('ux12-aioff-stored', 2, documentId, chapter, []),
  );
  await seedExplanation(owner, bank(stored.id));
  await signInAs(page, owner.user);
  const off = await startExplanationsOffStack();
  try {
    await page.goto(`${off.webUrl}${overviewPath(workspace.id)}`);
    await overviewUi.dot(page, 1).click();
    const panel = panelUi.numbered(page, 1);
    await panelUi.option(panel, correctText(question)).check();
    const state = page.waitForResponse(
      (r) => r.request().method() === 'GET' && r.url().includes('/ai-explanation'),
    );
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    await state;
    await expect(explUi.busy(explUi.area(panel))).toHaveCount(0);
    await expect(explUi.create(panel)).toHaveCount(0);
    await expect(panel.getByText(EXPL_TEXT.disabled)).toHaveCount(0);
    await panelUi.close(panel).click();

    await overviewUi.dot(page, 2).click();
    const readable = panelUi.numbered(page, 2);
    await panelUi.option(readable, correctText(stored)).check();
    await panelUi.submit(readable).click();
    await expect(explUi.heading(readable)).toBeVisible();
    await expect(readable.getByText(EXPL_TEXT.disabled)).toHaveCount(0);
  } finally {
    await off.stop();
  }
});
