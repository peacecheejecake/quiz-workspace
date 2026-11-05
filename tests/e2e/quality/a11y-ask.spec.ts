// M7.2 accessibility of the AI surfaces (ASK-X): axe in the light and dark theme
// (fixtures/a11y.ts) on
//   A11Y-17  the ASK-01 AI 질문 panel — empty, flowing (aria-busy), completed with footnotes and
//            sources, the conversation list, the question scope popover, failed, over the rate
//            limit, with the feature off, the phone sheet, and stacked above a mock exam run (an
//            attached question) and on the 본문 검색 page — plus a keyboard-only ask;
//   A11Y-18  the AIEXPL-01 AI 해설 area (make, working, done, failed) and the RELSRC-01 관련 본문
//            area (loading, list, empty, error) in a practice panel, a mock exam run
//            (`sequence(mock)`) and the 문제 상세 / mock question manage views (`manage`).
//
// Every state here shows (synthetic) book text, and the practice, run and detail states show
// answers and explanations: no trace/screenshot/video and no page text on failure; axe reports only
// rule ids, CSS targets and axe's own summaries. Answers and explanations come from the
// APP_ENV=test fakes (fixtures/ask.ts Q7, fixtures/ai-explanations.ts E5–E7).
import { randomUUID } from 'node:crypto';
import { devices, type Locator, type Page, type Route } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import {
  ask,
  ASK_MARKERS,
  ASK_TEXT,
  ASK_TIMEOUT_MS,
  askPath,
  askThroughApi,
  askUi,
  createSecretQuestion,
  openAskPanel,
  PASSAGES,
  seedAskBook,
  seedSecretMockExam,
  startAskLimitStack,
  startAskOffStack,
  waitDone,
  type AskBook,
} from '../fixtures/ask.ts';
import {
  EXPL_MARKERS,
  EXPL_TEXT,
  EXPL_TIMEOUT_MS,
  ExplHold,
  explUi,
  expectDone,
} from '../fixtures/ai-explanations.ts';
import {
  ANSWER,
  FAIL_MARKER,
  expandRelated,
  relatedUi,
  relsrcInput,
  seedRelsrcBook,
  createSourcedQuestion,
  TEXT as RELATED_TEXT,
  UI_TEXT,
  type RelsrcBook,
} from '../fixtures/related-sources.ts';
import { mockExamsPath, mockUi, questionRow } from '../fixtures/mock-exams.ts';
import { createShuffleMockExam, runUi } from '../fixtures/practice-runs.ts';
import { expect, NO_VISUAL_ARTIFACTS, test } from '../fixtures/sharing.ts';
import {
  choosePanelMenu,
  createQuestion,
  detailUi,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  mcqInput,
  openContentSearch,
  overviewPath,
  overviewUi,
  panelUi,
  RESULT_TEXT,
  runSearch,
  searchUi,
  signInAs,
  type Member,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({ ...NO_VISUAL_ARTIFACTS, attachPageTextOnFailure: false });
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 4 * ASK_TIMEOUT_MS });

const QUESTION = '가나다 원리를 설명해 줘';

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

async function openHome(page: Page, member: Member, workspaceId: string, origin = '') {
  await signInAs(page, member.user);
  await page.goto(`${origin}${homePath(workspaceId)}`);
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

/** Presses `key` (Tab by default) until `target` has focus; fails after `max` presses. */
async function keyTo(page: Page, target: Locator, key = 'Tab', max = 60): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(key);
  }
  await expect(target, `reached by ${key} alone`).toBeFocused();
}

interface AskWorkspace {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly book: AskBook;
}

async function askWorkspace(factory: WorkspaceFactory, label: string): Promise<AskWorkspace> {
  const owner = await factory.member(label);
  const ws = await factory.create(owner);
  return { owner, workspaceId: ws.id, book: await seedAskBook(owner, ws.id) };
}

// ---------------------------------------------------------------------------------------------
// A11Y-17: the AI 질문 panel
// ---------------------------------------------------------------------------------------------

test(
  'A11Y-17 AI 질문 panel: empty, flowing, completed with footnotes, conversation list, scope, attached question and a failed answer',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `a11y17-${randomUUID().slice(0, 8)}`;
    const s = await askWorkspace(workspaceFactory, 'a11y17');
    await createSecretQuestion(s.owner, s.workspaceId, s.book, 1, label);
    await openHome(page, s.owner, s.workspaceId);

    let panel = await openAskPanel(page);
    await expect(panel.getByText(ASK_TEXT.empty)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'AI 질문 panel, empty');

    // Flowing: the answer is aria-busy while its text grows (the SLOW fake writes ~20 s).
    const flowing = await ask(panel, `${ASK_MARKERS.slow} ${QUESTION}`);
    await expect(flowing).toHaveAttribute('aria-busy', 'true');
    await expect(flowing).toContainText(PASSAGES.book, { timeout: ASK_TIMEOUT_MS });
    await expectAccessible(page, 'AI 질문 panel, an answer flowing in');
    await waitDone(flowing);
    await expect(askUi.footnote(flowing, 1)).toBeVisible();
    await expect(askUi.sourceItems(flowing).first()).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'AI 질문 panel, completed answer with footnotes and sources');

    // A second answer fails (provider error) and offers 다시 시도.
    const failed = await ask(panel, `${ASK_MARKERS.fail} ${QUESTION}`);
    await waitDone(failed);
    await expect(askUi.alert(failed)).toHaveText(ASK_TEXT.llmUnavailable);
    await expect(askUi.retry(failed)).toBeVisible();
    await expectAccessible(page, 'AI 질문 panel, a failed answer with 다시 시도');

    // The question scope popover and the conversation list.
    await askUi.scopeButton(panel).click();
    await expect(askUi.scopePopover(page)).toBeVisible();
    await expectAccessible(page, 'AI 질문 panel, the question scope popover');
    await page.keyboard.press('Escape');
    await expect(askUi.scopePopover(page)).toHaveCount(0);
    await askUi.listButton(panel).click();
    await expect(askUi.rows(panel).first()).toBeVisible();
    await expectAccessible(page, 'AI 질문 panel, the conversation list');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // An attached question (문제 상세 › 질문하기) with the full-disclosure chip.
    await page.goto(overviewPath(s.workspaceId));
    await overviewUi.dot(page, 1).click();
    const practice = panelUi.numbered(page, 1);
    await expect(practice).toBeVisible();
    await choosePanelMenu(page, practice, 'answers');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await askUi.questionButton(detail).click();
    panel = askUi.panel(page);
    await expect(askUi.chip(panel).getByText(ASK_TEXT.full)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'AI 질문 panel above 문제 상세, with the attached question chip');
  },
);

test(
  'A11Y-17 AI 질문 panel over the per-minute limit and with the feature off',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'a11y17-stacks');
    const limited = await startAskLimitStack();
    try {
      await openHome(page, s.owner, s.workspaceId, limited.webUrl);
      const panel = await openAskPanel(page);
      await waitDone(await ask(panel, `${QUESTION} 1`));
      await waitDone(await ask(panel, `${QUESTION} 2`));
      await askUi.input(panel).fill(`${QUESTION} 3`);
      await askUi.input(panel).press('Enter');
      await expect(panel.getByText(ASK_TEXT.rateLimited)).toBeVisible();
      await expectAccessible(page, 'AI 질문 panel, the per-minute limit explained');
    } finally {
      await limited.stop();
    }
    const off = await startAskOffStack();
    try {
      await page.goto(`${off.webUrl}${homePath(s.workspaceId)}`);
      await expect(homeUi.questionMenuButton(page)).toBeVisible();
      const panel = await openAskPanel(page);
      await expect(askUi.input(panel)).toHaveAttribute('aria-disabled', 'true');
      await expect(askUi.input(panel)).toHaveAccessibleDescription(ASK_TEXT.disabled);
      await expectAccessible(page, 'AI 질문 panel, feature off (saved conversations only)');
    } finally {
      await off.stop();
    }
  },
);

test.describe('A11Y-17 phone', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'A11Y-17 AI 질문 panel as a phone sheet, with a completed answer',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const s = await askWorkspace(workspaceFactory, 'a11y17-phone');
      const { conversation } = await askThroughApi(s.owner, s.workspaceId, QUESTION);
      await signInAs(page, s.owner.user);
      await page.goto(askPath(s.workspaceId, conversation));
      const panel = askUi.panel(page);
      await expect(panel).toBeVisible();
      const answer = askUi.answers(panel).last();
      await waitDone(answer);
      await expect(askUi.footnote(answer, 1)).toBeVisible();
      await settle(page);
      await expectAccessible(page, 'AI 질문 phone sheet, completed answer');
      await askUi.input(panel).tap();
      await expect(askUi.input(panel)).toBeInViewport();
      await expectAccessible(page, 'AI 질문 phone sheet, the input focused');
    },
  );
});

test(
  'A11Y-17 AI 질문 panel above a mock exam run and on the 본문 검색 page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `a11y17-run-${randomUUID().slice(0, 8)}`;
    const s = await askWorkspace(workspaceFactory, 'a11y17-run');
    const { exam } = await seedSecretMockExam(s.owner, s.workspaceId, s.book, label);
    await signInAs(page, s.owner.user);
    await page.goto(mockExamsPath(s.workspaceId));
    const list = mockUi.dialog(page);
    await expect(list).toBeVisible();
    await mockUi.practise(list.getByRole('listitem').filter({ hasText: exam.title })).click();
    let run = runUi.panel(page);
    await runUi.start(run).click();
    run = runUi.panel(page);
    await expect(runUi.mockTitle(run, 1)).toBeVisible();
    await run.getByRole('radio', { name: /^보기 가 \d$/ }).check();
    const opener = askUi.questionButton(run);
    await opener.click();
    const panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    await expect(askUi.chip(panel).getByText(ASK_TEXT.hint)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'AI 질문 panel above the mock exam run, hint-only chip');
    const hint = await ask(panel, `${QUESTION} 힌트만`);
    await waitDone(hint);
    await expectAccessible(page, 'AI 질문 panel above the mock exam run, answered');
    // Escape unwinds only the AI panel; focus goes back to 질문하기.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(opener).toBeFocused();

    // The 본문 검색 page: AI에게 묻기 opens the panel as a modal without changing the URL.
    await page.goto(homePath(s.workspaceId));
    await expect(homeUi.questionMenuButton(page)).toBeVisible();
    await openContentSearch(page);
    await runSearch(page, PASSAGES.book, 'keyword');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    const before = page.url();
    await askUi.searchButton(page).click();
    const searchPanel = askUi.panel(page);
    await expect(searchPanel).toBeVisible();
    await expect(askUi.input(searchPanel)).toHaveValue(PASSAGES.book);
    expect(page.url(), 'the URL does not change').toBe(before);
    await settle(page);
    await expectAccessible(page, 'AI 질문 modal on the 본문 검색 page, prefilled');
    await askUi.close(searchPanel).click();
    await expect(searchPanel).toHaveCount(0);
  },
);

test(
  'A11Y-17 keyboard only: header AI 질문, type, Enter, the answer is announced, Escape back to the button',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'a11y17-keys');
    await openHome(page, s.owner, s.workspaceId);
    await page.locator('body').focus();
    const header = askUi.headerButton(page);
    await keyTo(page, header);
    await page.keyboard.press('Enter');
    const panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await keyTo(page, askUi.input(panel));
    await page.keyboard.type(QUESTION);
    await page.keyboard.press('Enter');
    const answer = askUi.answers(panel).last();
    await expect(answer).toBeVisible({ timeout: ASK_TIMEOUT_MS });
    await waitDone(answer);
    await expect(askUi.live(panel).filter({ hasText: ASK_TEXT.liveDone(1) })).toHaveCount(1);
    await keyTo(page, askUi.footnote(answer, 1));
    await page.keyboard.press('Enter');
    await expect(searchUi.excerptPanel(page)).toContainText(PASSAGES.book);
    await expectAccessible(page, 'footnote excerpt over the AI 질문 panel, by keyboard');
    await page.keyboard.press('Escape');
    await expect(searchUi.excerptPanel(page)).toHaveCount(0);
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(header).toBeFocused();
  },
);

// ---------------------------------------------------------------------------------------------
// A11Y-18: the AI 해설 area and the 관련 본문 area
// ---------------------------------------------------------------------------------------------

interface RelatedWorkspace {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly book: RelsrcBook;
}

async function relatedWorkspace(factory: WorkspaceFactory, label: string) {
  const owner = await factory.member(label);
  const ws = await factory.create(owner);
  const book = await seedRelsrcBook(owner, ws.id);
  return { owner, workspaceId: ws.id, book } satisfies RelatedWorkspace;
}

/** Holds the page's related-sources requests until `release()` (to see the loading state). */
async function holdRelatedRequests(page: Page): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held: Promise<void>[] = [];
  const matches = (url: URL) => url.pathname.endsWith('/related-sources');
  await page.route(matches, (route: Route) => {
    const continued = gate.then(() => route.continue());
    held.push(continued);
    return continued;
  });
  return {
    release: async () => {
      release();
      await Promise.all(held);
      await page.unroute(matches);
    },
  };
}

async function answerInPanel(page: Page, n: number, answer: string): Promise<Locator> {
  await overviewUi.dot(page, n).click();
  const panel = panelUi.numbered(page, n);
  await expect(panel).toBeVisible();
  await panelUi.option(panel, answer).check();
  await panelUi.submit(panel).click();
  await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
  return panel;
}

test(
  'A11Y-18 practice panel: 관련 본문 (loading, list, empty, error) and AI 해설 (make, working, done, failed)',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `a11y18-${randomUUID().slice(0, 8)}`;
    const s = await relatedWorkspace(workspaceFactory, 'a11y18');
    const hold = new ExplHold();
    const sourced = (n: number, markers: string[] = [], answer = ANSWER) =>
      createSourcedQuestion(s.owner, s.workspaceId, s.book, {
        ...relsrcInput(`${label}-${n}`, s.book, { answer, markers }),
        question_number: n,
      });
    await sourced(1, [hold.marker]);
    await sourced(2, [EXPL_MARKERS.fail, FAIL_MARKER]);
    await createQuestion(s.owner, s.workspaceId, {
      ...mcqInput(`RELSRC ${label}-3: ${RELATED_TEXT.nowhere}?`, [
        'zqxjv-보기-1',
        'zqxjv-보기-2',
        'zqxjv-보기-3',
      ]),
      chapter_id: s.book.ch1,
      question_number: 3,
    });
    await signInAs(page, s.owner.user);
    await page.goto(overviewPath(s.workspaceId));
    await expect(overviewUi.dots(page)).toHaveCount(3);

    // 1: 관련 본문 loading → list; AI 해설 make → working (held) → done.
    await overviewUi.dot(page, 1).click();
    let panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    const gate = await holdRelatedRequests(page);
    await panelUi.option(panel, ANSWER).check();
    await panelUi.submit(panel).click();
    await expect(panel.getByRole('status').filter({ hasText: RESULT_TEXT.correct })).toBeVisible();
    // Collapsed after the submission: nothing is requested until the expand.
    await expect(relatedUi.toggle(panel)).toHaveAttribute('aria-expanded', 'false');
    await expectAccessible(page, '관련 본문 collapsed (practice panel)');
    let body = await expandRelated(panel);
    await expect(relatedUi.status(body, UI_TEXT.loading)).toBeVisible();
    await expectAccessible(page, '관련 본문 loading (practice panel)');
    await gate.release();
    await expect(relatedUi.rows(body).first()).toBeVisible();
    const area = explUi.area(panel);
    await expect(explUi.create(area)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'AI 해설 make button and 관련 본문 list (practice panel)');
    await explUi.create(area).click();
    await hold.held();
    await expect(area.getByText(EXPL_TEXT.working).first()).toBeVisible();
    await expect(area.locator('[aria-busy="true"]')).not.toHaveCount(0);
    await expectAccessible(page, 'AI 해설 working (practice panel)');
    hold.release();
    await expectDone(area);
    await expect(explUi.footnote(area, 1).first()).toBeVisible();
    await expectAccessible(page, 'AI 해설 done with footnotes and sources (practice panel)');
    // The 문제 상세 (`manage`): both areas without a submission, AI 해설 already shared.
    await choosePanelMenu(page, panel, 'answers');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    await expect(relatedUi.rows(await expandRelated(detail)).first()).toBeVisible();
    // The shared explanation is cached: 문제 상세 offers `AI 해설 보기`.
    await expect(explUi.show(explUi.area(detail))).toHaveAttribute('aria-expanded', 'true');
    await expectDone(explUi.area(detail));
    await settle(page);
    await expectAccessible(page, 'AI 해설 and 관련 본문 in 문제 상세 (manage)');
    await detailUi.close(detail).click();
    await panelUi.close(panel).click();

    // 2: both areas fail; 다시 시도 on each.
    panel = await answerInPanel(page, 2, ANSWER);
    body = await expandRelated(panel);
    await expect(relatedUi.alert(body)).toBeVisible();
    const failing = explUi.area(panel);
    await explUi.create(failing).click();
    await expect(explUi.alert(failing)).toContainText(EXPL_TEXT.unavailable, {
      timeout: EXPL_TIMEOUT_MS,
    });
    await expect(explUi.retry(failing)).toBeVisible();
    await expect(relatedUi.retry(body)).toBeVisible();
    await settle(page);
    await expectAccessible(
      page,
      'AI 해설 failed and 관련 본문 error with 다시 시도 (practice panel)',
    );
    await panelUi.close(panel).click();

    // 3: nothing related anywhere.
    panel = await answerInPanel(page, 3, 'zqxjv-보기-1');
    await expect(relatedUi.status(await expandRelated(panel), UI_TEXT.empty)).toBeVisible();
    await settle(page);
    await expectAccessible(page, '관련 본문 empty (practice panel)');
  },
);

test(
  'A11Y-18 mock exam run and mock question manage view, and AI 해설 made by keyboard',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = `a11y18-mock-${randomUUID().slice(0, 8)}`;
    const s = await relatedWorkspace(workspaceFactory, 'a11y18-mock');
    const source = await createSourcedQuestion(s.owner, s.workspaceId, s.book, {
      ...relsrcInput(label, s.book),
      question_number: 1,
    });
    const examName = `모의 ${label}`;
    const exam = await createShuffleMockExam(s.owner, s.workspaceId, examName, [source.id], 1);

    // sequence(mock): result with both areas.
    await signInAs(page, s.owner.user);
    await page.goto(mockExamsPath(s.workspaceId));
    const list = mockUi.dialog(page);
    await expect(list).toBeVisible();
    await mockUi.practise(list.getByRole('listitem').filter({ hasText: examName })).click();
    let run = mockUi.practicePanel(page);
    await runUi.start(run).click();
    run = runUi.panel(page);
    await expect(runUi.mockTitle(run, 1)).toBeVisible();
    await runUi.option(run, ANSWER).check();
    await runUi.submit(run).click();
    await expect(runUi.result(run)).toContainText(RESULT_TEXT.correct);
    const body = await expandRelated(run);
    await expect(relatedUi.rows(body).first()).toBeVisible();
    const area = explUi.area(run);
    await expect(explUi.create(area)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'AI 해설 make button and 관련 본문 list (mock exam run)');
    await keyTo(page, explUi.create(area));
    await page.keyboard.press('Enter');
    await expectDone(area);
    await settle(page);
    await expectAccessible(page, 'AI 해설 done and 관련 본문 list (mock exam run)');
    await page.keyboard.press('Escape');

    // manage(mock): the cached explanation opens without another generation.
    await page.goto(mockExamsPath(s.workspaceId, exam.id));
    const detail = mockUi.dialog(page);
    await expect(mockUi.heading(detail, examName)).toBeVisible();
    await questionRow(detail, 1).click();
    const manage = mockUi.viewer(page, 1);
    await expect(manage).toBeVisible();
    await expect(relatedUi.rows(await expandRelated(manage)).first()).toBeVisible();
    const manageArea = explUi.area(manage);
    await expect(explUi.show(manageArea)).toHaveAttribute('aria-expanded', 'true');
    await expectDone(manageArea);
    await settle(page);
    await expectAccessible(page, 'AI 해설 and 관련 본문 in the mock question manage view');
  },
);
