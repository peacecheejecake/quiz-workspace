import { outlineNodeId, uploadReadyBook } from '../fixtures/documents.ts';
import {
  bank,
  correctText,
  explainCalls,
  explMcq,
  explUi,
  getExplanation,
  seedExplanation,
  startExplanationsOffStack,
} from '../fixtures/ai-explanations.ts';
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
    const create = await off.request(
      owner,
      'POST',
      `/questions/${question.id}/ai-explanation/regenerate`,
      {
        practice_session_id: session.id,
      },
    );
    expect(create.status).toBe(409);
  } finally {
    await off.stop();
  }
});
