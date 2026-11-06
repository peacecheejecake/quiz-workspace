// UX12-OPEN — one call opens a question (docs/screens/ux12-question-open.md).
import type { Locator, Page, Response } from '@playwright/test';
import {
  createQuestion,
  expect,
  numberedMcq,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  signInAs,
  submitPractice,
  test,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const AGAIN = /^다시 풀기$|^solve again$/i;
const NEXT = /^다음 문제$|^next question$/i;
const ANSWER_FIELDS = /"(correct_option_ids|accepted_answers|explanation|rubric|outcome)"/;

interface Traffic {
  /** Every POST of the page, as paths; a server action is a POST to the page itself. */
  readonly posts: string[];
  /** The `practice-open` responses. */
  readonly opens: Response[];
}

function watch(page: Page): Traffic {
  const traffic: Traffic = { posts: [], opens: [] };
  page.on('request', (request) => {
    if (request.method() === 'POST') traffic.posts.push(new URL(request.url()).pathname);
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('/practice-open')) traffic.opens.push(response);
  });
  return traffic;
}

function openPost(question: Question): string {
  return `/api/questions/${question.id}/practice-open`;
}

async function openPanel(page: Page): Promise<Locator> {
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await expect(panel).toBeVisible();
  return panel;
}

async function closePanel(page: Page, panel: Locator): Promise<void> {
  await panelUi.close(panel).click();
  await expect(panel).toBeHidden();
}

async function seeded(
  page: Page,
  member: Member,
  workspaceId: string,
  label: string,
): Promise<{ question: Question; traffic: Traffic }> {
  const question = await createQuestion(member, workspaceId, numberedMcq(label, 1, 0));
  await signInAs(page, member.user);
  await page.goto(overviewPath(workspaceId));
  return { question, traffic: watch(page) };
}

test(
  'UX12-OPEN-AC01 a new question opens with one call and no server action',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-open-first');
    const ws = await workspaceFactory.create(owner);
    const { question, traffic } = await seeded(page, owner, ws.id, `open-${Date.now()}`);

    const panel = await openPanel(page);
    await expect(panelUi.submit(panel)).toBeVisible();
    for (const [index, option] of question.revision.options.entries()) {
      await expect(panelUi.options(panel).nth(index)).toHaveAccessibleName(option.text);
    }
    await expect.poll(() => traffic.opens.length).toBe(1);
    expect(traffic.posts).toEqual([openPost(question)]);

    const opened = traffic.opens[0];
    if (!opened) throw new Error('no practice-open response');
    expect(await opened.text()).not.toMatch(ANSWER_FIELDS);
    expect(opened.headers()['server-timing']).toMatch(/^db;dur=.*, app;dur=.*, bff;dur=[\d.]+$/);
    await closePanel(page, panel);
    await expect(overviewUi.dot(page, 1)).toHaveAttribute('data-status', 'viewed');
  },
);

test(
  'UX12-OPEN-AC02 a submitted question opens in one call, and its result takes one more',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-open-result');
    const ws = await workspaceFactory.create(owner);
    const { question, traffic } = await seeded(page, owner, ws.id, `result-${Date.now()}`);
    const text = question.revision.options[0]?.text;
    if (!text) throw new Error('no option');

    const first = await openPanel(page);
    await panelUi.option(first, text).check();
    await panelUi.submit(first).click();
    await expect(panelUi.result(first)).toContainText(RESULT_TEXT.correct);
    await closePanel(page, first);
    traffic.posts.length = 0;

    const again = await openPanel(page);
    await expect(panelUi.reveal(again)).toBeVisible();
    await expect(panelUi.result(again)).toHaveCount(0);
    expect(traffic.posts).toEqual([openPost(question)]);

    traffic.posts.length = 0;
    await panelUi.reveal(again).click();
    await expect(panelUi.result(again)).toContainText(RESULT_TEXT.correct);
    expect(traffic.posts).toEqual([`/api/questions/${question.id}/practice-reveal`]);

    traffic.posts.length = 0;
    await again.getByRole('button', { name: AGAIN }).click();
    await expect(panelUi.submit(again)).toBeVisible();
    await expect(panelUi.option(again, text)).not.toBeChecked();
    expect(traffic.posts).toEqual([openPost(question)]);
  },
);

test(
  'UX12-OPEN-AC03 reopening reuses the session unless a result arrived elsewhere',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-open-reuse');
    const ws = await workspaceFactory.create(owner);
    const { question, traffic } = await seeded(page, owner, ws.id, `reuse-${Date.now()}`);

    const first = await openPanel(page);
    await expect(panelUi.submit(first)).toBeVisible();
    await expect.poll(() => traffic.opens.length).toBe(1);
    const session = (await traffic.opens[0]?.json()) as { session: { id: string } };
    await closePanel(page, first);
    traffic.posts.length = 0;

    const second = await openPanel(page);
    await expect(panelUi.submit(second)).toBeVisible();
    await expect.poll(() => traffic.opens.length).toBe(2);
    expect(traffic.posts).toEqual([openPost(question)]);
    expect(await traffic.opens[1]?.json()).toMatchObject({
      reused: true,
      session: { id: session.session.id },
    });
    await closePanel(page, second);

    // Another tab or device finished that session: a new session, with its result on request.
    const optionId = question.revision.options[0]?.id;
    if (!optionId) throw new Error('no option');
    await submitPractice(owner, session.session.id, { selected_option_ids: [optionId] });
    const third = await openPanel(page);
    await panelUi.reveal(third).click();
    await expect(panelUi.result(third)).toContainText(RESULT_TEXT.correct);
    await expect(panelUi.submit(third)).toHaveCount(0);
  },
);

test(
  'UX12-OPEN-AC08 rapid next opens only the question it stops on',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-open-rapid');
    const ws = await workspaceFactory.create(owner);
    const label = `rapid-${Date.now()}`;
    const first = await createQuestion(owner, ws.id, numberedMcq(label, 1, 0));
    await createQuestion(owner, ws.id, numberedMcq(label, 2, 0));
    const third = await createQuestion(owner, ws.id, numberedMcq(label, 3, 0));
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    const traffic = watch(page);

    const opened = await openPanel(page);
    await expect(panelUi.submit(opened)).toBeVisible();
    // In the page, so the two clicks fall inside the pause however busy the machine is. The second
    // waits for question 2 on screen: until that commit, 다음 문제 still points at question 2.
    await opened.getByRole('button', { name: NEXT }).evaluate(async (button: HTMLElement) => {
      const title = () => {
        const id = button.closest('[role="dialog"]')?.getAttribute('aria-labelledby');
        return id ? document.getElementById(id)?.textContent : null;
      };
      button.click();
      while (!title()?.includes('2번')) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      button.click();
    });

    const last = panelUi.numbered(page, 3);
    await expect(panelUi.submit(last)).toBeVisible();
    await expect.poll(() => traffic.opens.length).toBe(2);
    expect(traffic.posts).toEqual([openPost(first), openPost(third)]);

    await closePanel(page, last);
    await expect(overviewUi.dot(page, 3)).toHaveAttribute('data-status', 'viewed');
    await expect(overviewUi.dot(page, 2)).not.toHaveAttribute('data-status', 'viewed');
  },
);
