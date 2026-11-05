// ASK-01 — AI 질문 (문서 기반 답변) Floating Side Panel (`/workspaces/:id?panel=ask`),
// docs/screens/ask-llm.md; answer-disclosure rules docs/questions.md §13, sharing
// docs/workspace-sharing.md §10.
//
// Each test seeds its own workspace through the public API: book-ko.pdf whose chapter 1 says
// "가나다 원리" (a published correction), and where needed questions-ko.pdf as a 문제지 saying
// "라마바 정답표" and as 교재+문제 (`mixed`) saying "사아자 해설" only in its question part,
// MCQs whose explanation and correct option carry the synthetic SECRETS strings, and a `보기 섞기`
// mock exam of two of them (practice-runs.ts createShuffleMockExam). Viewer memberships come from
// the documented db seed (fixtures/db.ts). Answers come from the APP_ENV=test deterministic
// streaming fake (markers E2E-ASK-*, its call record WORKER_ASK_FAKE_LOG_DIR and the
// feature-off / small-limit stacks): every assumption about ASK-B / ASK-W / ASK-Q is in the
// tests/e2e/fixtures/ask.ts header (Q1–Q9 and the UI contract).
//
// Phases: AC01–AC03 and AC06–AC11 turn GREEN with ASK-W, AC04 · AC05 · AC12 with ASK-Q, which
// adds ASK.0 to CI `E2E_PHASES`. The main E2E stack must run with WORKER_ASK_LLM=true (API and
// worker). QOV-01-AC11's menu list is changed by ASK-W, not here.
//
// The panel shows answers, explanations and book text: traces, screenshots, videos and the page
// text on failure are off; shown content is checked with role/text assertions on synthetic
// strings only.
import { randomUUID } from 'node:crypto';
import { devices, type Locator, type Page } from '@playwright/test';
import {
  ANSWER_FIELDS,
  ask,
  askParams,
  askPath,
  askState,
  askThroughApi,
  ASK_JOB_TYPE,
  ASK_MARKERS,
  ASK_PROBLEMS,
  ASK_TEXT,
  ASK_TIMEOUT_MS,
  askUi,
  chipLabel,
  CH1,
  conversationOf,
  createConversation,
  createSecretQuestion,
  deleteConversation,
  fakeCalls,
  getConversation,
  getMessage,
  listConversations,
  NOT_FOUND_TEXT,
  openAskPanel,
  PASSAGES,
  probeSelected,
  readStream,
  recordedMessageIds,
  requestConversation,
  requestMessage,
  SECRETS,
  seedAskBook,
  seedAskMixed,
  seedAskPaper,
  seedSecretMockExam,
  sendMessage,
  stackRequest,
  startAskLimitStack,
  startAskOffStack,
  waitDone,
  waitForAnswer,
  type AskBook,
  type AskState,
  type Conversation,
  type Message,
} from '../fixtures/ask.ts';
import { expectAccessible } from '../fixtures/a11y.ts';
import { apiError } from '../fixtures/api.ts';
import {
  mockAttemptCount,
  openRangePicker,
  progressText,
  questionAttemptCount,
  runUi,
} from '../fixtures/practice-runs.ts';
import { mockExamsPath, mockUi, questionRow } from '../fixtures/mock-exams.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharePath,
  ShareSession,
  test,
} from '../fixtures/sharing.ts';
import {
  answerKeysIn,
  chooseFilter,
  choosePanelMenu,
  closeSearchOptions,
  detailUi,
  historyPath,
  historyUi,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  listActivities,
  listAttempts,
  listWorkspaceJobs,
  openContentSearch,
  openSearchOptions,
  overviewItem,
  overviewPath,
  overviewUi,
  pageLabel,
  panelUi,
  runSearch,
  searchUi,
  seedMembership,
  signInAs,
  submitPractice,
  startPractice,
  uploadReadyBook,
  type Member,
  type Question,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: 3 * JOB_TIMEOUT_MS + 2 * ASK_TIMEOUT_MS });

const QUESTION = '가나다 원리를 설명해 줘';
const PROBE = `${ASK_MARKERS.leakProbe} 이 문제 설명`;

function unique(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function viewerOf(factory: WorkspaceFactory, s: AskWorkspace, label: string) {
  const viewer = await factory.member(label);
  seedMembership(s.workspaceId, viewer.user.id, 'viewer');
  return viewer;
}

async function openHome(
  page: Page,
  member: Member,
  workspaceId: string,
  origin = '',
): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(`${origin}${homePath(workspaceId)}`);
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

async function switchUser(page: Page, member: Member): Promise<void> {
  await page.context().clearCookies();
  await signInAs(page, member.user);
}

/** Stubs the async clipboard: what the page writes lands in window.__copied (any browser). */
async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    const clipboard = {
      writeText: async (text: string) => {
        w.__copied.push(text);
      },
      write: async (items: { getType(type: string): Promise<Blob> }[]) => {
        for (const item of items) w.__copied.push(await (await item.getType('text/plain')).text());
      },
      readText: async () => w.__copied.at(-1) ?? '',
    };
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  });
}

async function copied(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '');
}

interface Watch {
  searching: boolean;
  writing: boolean;
  busySeen: boolean;
  lengths: number[];
  statuses: string[];
}

/**
 * Records, from now on, what the page shows while an answer streams: the progress texts, the
 * growing text lengths of the busy answer and every distinct live-region (role=status) text.
 */
async function watchAnswers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __askWatch: Watch & { last: Record<number, string> } };
    w.__askWatch = {
      searching: false,
      writing: false,
      busySeen: false,
      lengths: [],
      statuses: [],
      last: {},
    };
    const state = w.__askWatch;
    const record = () => {
      const text = document.body.textContent ?? '';
      if (/근거를 찾는 중|finding sources/i.test(text)) state.searching = true;
      if (/답을 쓰는 중|writing the answer/i.test(text)) state.writing = true;
      const busy = document.querySelector('[role="log"] [aria-busy="true"]');
      if (busy) {
        state.busySeen = true;
        const len = (busy.textContent ?? '').length;
        if (state.lengths.at(-1) !== len) state.lengths.push(len);
      }
      document.querySelectorAll('[role="dialog"] [role="status"]').forEach((el, i) => {
        const t = (el.textContent ?? '').trim();
        if (t && state.last[i] !== t) {
          state.last[i] = t;
          state.statuses.push(t);
        }
      });
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    record();
  });
}

async function watched(page: Page): Promise<Watch> {
  return page.evaluate(() => {
    const { searching, writing, busySeen, lengths, statuses } = (
      window as unknown as { __askWatch: Watch }
    ).__askWatch;
    return { searching, writing, busySeen, lengths, statuses };
  });
}

/** The last assistant message of a conversation (API). */
async function lastAnswer(member: Member, conversationId: string): Promise<Message> {
  const res = await getConversation(member, conversationId);
  expect(res.status, 'GET /ask/conversations/{id}').toBe(200);
  const answers = (res.body as Conversation).messages.filter((m) => m.role === 'assistant');
  const last = answers.at(-1);
  if (!last) throw new Error('the conversation has no answer');
  return last;
}

/** No `<field>:` echo line of an answer-identifying field in a probe answer (C03). */
function expectNoAnswerFields(text: string, where: string): void {
  for (const field of ANSWER_FIELDS) {
    expect(text, `${where}: no ${field} line`).not.toMatch(new RegExp(`(^|\\n)\\s*${field}\\s*:`));
  }
}

test(
  'ASK-01-AC01 the header AI 질문 panel answers from the book with streamed text, footnotes to the excerpt and PDF, copy and a saved conversation',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ask01-ac01');
    await stubClipboard(page);
    await openHome(page, s.owner, s.workspaceId);

    // Hold the ask reads: the panel must open at once, before any data arrives.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const isAsk = (url: URL) => url.pathname.includes('/ask');
    const held: Promise<void>[] = [];
    await page.route(isAsk, (route) => {
      const continued = gate.then(() => route.continue());
      held.push(continued);
      return continued;
    });
    const panel = await openAskPanel(page);
    expect(askParams(page)).toEqual({ panels: ['ask'], conversation: null });
    release();
    await Promise.all(held);
    await page.unroute(isAsk);
    await expect(panel.getByText(ASK_TEXT.empty)).toBeVisible();
    await expect(askUi.input(panel)).toBeEditable();

    // Two quick Enters send one question (Idempotency-Key / a disabled send).
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/ask\/conversations\/[^/]+\/messages$/.test(r.url())) {
        posts.push(r.headers()['idempotency-key'] ?? '');
      }
    });
    const stream = page.waitForResponse((r) =>
      /\/api\/ask\/messages\/[^/]+\/stream$/.test(new URL(r.url()).pathname),
    );
    await watchAnswers(page);
    await askUi.input(panel).fill(QUESTION);
    await askUi.input(panel).press('Enter');
    await askUi.input(panel).press('Enter');
    await expect(page).toHaveURL((url) =>
      /^[0-9a-f-]{36}$/.test(url.searchParams.get('conversation') ?? ''),
    );
    const conversationId = conversationOf(page);
    const answer = askUi.answers(panel).last();
    await waitDone(answer);
    await expect(askUi.userMessages(panel)).toHaveCount(1);
    await expect(askUi.answers(panel)).toHaveCount(1);
    expect(new Set(posts).size, 'retried sends carry one Idempotency-Key').toBeLessThanOrEqual(1);
    const saved = (await getConversation(s.owner, conversationId)).body as Conversation;
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // Streamed in several deltas, through the progress texts. The browser read the relay's
    // event stream; Chromium keeps no body of a text/event-stream response for the test to read,
    // so the deltas are counted by the fake's call record and the growing text below.
    const relayed = await stream;
    expect(relayed.status()).toBe(200);
    expect(relayed.headers()['content-type'] ?? '').toContain('text/event-stream');
    const answerId = saved.messages.find((m) => m.role === 'assistant')?.id ?? '';
    expect(fakeCalls(answerId).at(-1)?.deltas_sent ?? 0, 'SSE delta events').toBeGreaterThanOrEqual(
      2,
    );
    const seen = await watched(page);
    expect(seen.searching, '"근거를 찾는 중" was shown').toBe(true);
    expect(seen.writing, '"답을 쓰는 중" was shown').toBe(true);
    // Streamed: the fake sent several deltas (above) and the answer showed part of its text while
    // it was still being written. How many renders the deltas took depends on timing (two
    // deltas may land in one frame), so the count of distinct lengths is not asserted.
    expect(seen.lengths.length, 'the busy answer changed while streaming').toBeGreaterThanOrEqual(
      2,
    );
    expect(
      Math.max(...seen.lengths),
      'text appeared while the answer was still being written',
    ).toBeGreaterThan(seen.lengths[0] ?? 0);

    // The finished answer: badge, notice, footnote [1] → chapter 1's "가나다 원리" passage.
    await expect(askUi.aiBadge(answer)).toBeVisible();
    await expect(answer.getByText(ASK_TEXT.notice)).toBeVisible();
    const message = await lastAnswer(s.owner, conversationId);
    expect(message.status).toBe('succeeded');
    const first = message.sources.find((x) => x.number === 1);
    expect(first?.document_id).toBe(s.book.documentId);
    expect(first?.chapter_title).toBe(CH1);
    expect(first?.page_from).toBe(2);
    const footnote = askUi.footnote(answer, 1);
    await expect(footnote).toBeVisible();
    await expect(footnote).toHaveAccessibleName(
      new RegExp(`^(출처|source) 1: ${escapeRegExp(s.book.title)} p\\.2`),
    );
    await expect(askUi.sourceItems(answer).first()).toHaveText(
      new RegExp(`\\[1\\]\\s*${escapeRegExp(s.book.title)}\\s*·\\s*${CH1}\\s*·\\s*p\\.2`),
    );
    await footnote.click();
    const excerpt = searchUi.excerptPanel(page);
    await expect(excerpt).toBeVisible();
    await expect(excerpt).toContainText(PASSAGES.book);
    await expect(excerpt).toContainText(pageLabel(2));
    await searchUi.openInPdf(excerpt).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname.endsWith(`/documents/${s.book.documentId}`) &&
        url.searchParams.get('page') === '2',
    );
    await page.goBack();
    const back = askUi.panel(page);
    await expect(back).toBeVisible();

    // 복사: the Markdown answer and the source lines; announced.
    await askUi.copy(askUi.answers(back).last()).click();
    await expect(askUi.live(back).filter({ hasText: ASK_TEXT.copied })).toBeVisible();
    const clip = await copied(page);
    expect(clip).toContain(message.text.split('\n')[0] ?? '');
    expect(clip).toMatch(new RegExp(`\\[1\\]\\s*${escapeRegExp(s.book.title)}.*p\\.2`));

    // Saved: a reload shows the same conversation and answer.
    await page.reload();
    const reloaded = askUi.panel(page);
    await expect(reloaded).toBeVisible();
    expect(conversationOf(page)).toBe(conversationId);
    await expect(askUi.answers(reloaded)).toHaveCount(1);
    await expect(askUi.footnote(askUi.answers(reloaded).last(), 1)).toBeVisible();
  },
);

test(
  'ASK-01-AC02 question papers, the question part of a mixed document and unknown words find nothing, and the question scope narrows the search',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ask01-ac02');
    const paperId = await seedAskPaper(s.owner, s.workspaceId);
    const mixedId = await seedAskMixed(s.owner, s.workspaceId);
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openAskPanel(page);

    for (const word of [PASSAGES.paper, PASSAGES.mixed, PASSAGES.nowhere]) {
      if (askParams(page).conversation) await askUi.newButton(panel).click();
      const answer = await ask(panel, `${word}을 설명해 줘`);
      await waitDone(answer);
      await expect(answer).toContainText(NOT_FOUND_TEXT);
      await expect(askUi.sourceItems(answer)).toHaveCount(0);
      const message = await lastAnswer(s.owner, conversationOf(page));
      expect(message.sources, `${word}: no sources`).toEqual([]);
      for (const source of [...message.sources, ...(message.searched_sources ?? [])]) {
        expect(source.document_id).not.toBe(paperId);
        expect(source.document_type).not.toBe('question_paper');
        if (word === PASSAGES.mixed) expect(source.document_id).not.toBe(mixedId);
      }
      if (word === PASSAGES.nowhere) {
        // Nothing to ground on and no attachment: the fake is never called (usage 0).
        expect(message.status).toBe('no_sources');
        expect(fakeCalls(message.id), 'fake calls for 차카타파').toEqual([]);
      }
    }

    // Scope = chapter 2 of the book: chapter 1's passage is no evidence any more.
    await askUi.newButton(panel).click();
    await askUi.scopeButton(panel).click();
    const popover = askUi.scopePopover(page);
    await expect(popover).toBeVisible();
    await chooseFilter(
      page,
      popover.getByRole('combobox', { name: /^(문서|document)$/i }),
      new RegExp(escapeRegExp(s.book.title)),
    );
    await chooseFilter(
      page,
      popover.getByRole('combobox', { name: /^(장|section)$/i }),
      /2장 정수 처리/,
    );
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(askUi.scopeText(panel)).toContainText(s.book.title);
    const scoped = await ask(panel, QUESTION);
    await waitDone(scoped);
    await expect(scoped).toContainText(NOT_FOUND_TEXT);
    const message = await lastAnswer(s.owner, conversationOf(page));
    expect(message.sources).toEqual([]);
    const conversation = (await getConversation(s.owner, conversationOf(page)))
      .body as Conversation;
    expect(conversation.scope.chapter_ids).toEqual([s.book.ch2]);
  },
);

test(
  'ASK-01-AC03 unknown footnotes are dropped from the final answer and a [NO_ANSWER] reply becomes the not-found text with the searched passages',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ask01-ac03');
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openAskPanel(page);

    const bad = await ask(panel, `${ASK_MARKERS.badCite} ${QUESTION}`);
    await waitDone(bad);
    await expect(askUi.footnotes(bad)).toHaveCount(1);
    await expect(askUi.footnote(bad, 1)).toBeVisible();
    await expect(bad).not.toContainText(/S9|\[9\]/);
    await expect(askUi.sourceItems(bad)).toHaveCount(1);
    const badMessage = await lastAnswer(s.owner, conversationOf(page));
    const api = await getMessage(s.owner, badMessage.id);
    expect(api.text).not.toMatch(/S9|\[9\]/);
    const numbers = [...badMessage.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    expect(new Set(numbers)).toEqual(new Set([1]));
    expect(badMessage.sources.map((x) => x.number)).toEqual([1]);
    expect(badMessage.sources.every((x) => x.document_id === s.book.documentId)).toBe(true);

    await askUi.newButton(panel).click();
    const none = await ask(panel, `${ASK_MARKERS.noAnswer} ${QUESTION}`);
    await waitDone(none);
    await expect(none).toContainText(NOT_FOUND_TEXT);
    await expect(none).not.toContainText('NO_ANSWER');
    await expect(askUi.aiBadge(none)).toBeVisible();
    const searched = none.getByRole('list', { name: ASK_TEXT.searched });
    await expect(searched).toBeVisible();
    await expect(searched.getByRole('listitem').first()).toContainText(s.book.title);
    await expect(searched.getByRole('listitem').first()).toContainText(pageLabel(2));
    const noneMessage = await lastAnswer(s.owner, conversationOf(page));
    expect(noneMessage.text).not.toContain('[NO_ANSWER]');
    expect(noneMessage.searched_sources?.length ?? 0).toBeGreaterThan(0);
  },
);

test(
  'ASK-01-AC04 문제 상세 질문하기 opens a full-disclosure conversation above the dialog for a viewer and leaves the practice session untouched',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('ask01-ac04');
    const s = await askWorkspace(workspaceFactory, 'ask01-ac04');
    const q = await createSecretQuestion(s.owner, s.workspaceId, s.book, 3, label);
    const viewer = await viewerOf(workspaceFactory, s, 'ask01-ac04-viewer');

    await signInAs(page, viewer.user);
    await page.goto(overviewPath(s.workspaceId));
    await overviewUi.dot(page, 3).click();
    const practice = panelUi.numbered(page, 3);
    await expect(practice).toBeVisible();
    await panelUi.option(practice, '보기 가 증산').check();
    await expect(askUi.questionButton(practice), 'no 질문하기 in the practice header').toHaveCount(
      0,
    );
    const stateBefore = (await overviewItem(viewer, s.workspaceId, q.id)).status;

    await choosePanelMenu(page, practice, 'answers');
    const detail = detailUi.dialog(page);
    await expect(detail).toBeVisible();
    const opener = askUi.questionButton(detail);
    await expect(opener, 'the 문제 상세 footer has 질문하기').toBeVisible();
    await opener.click();
    const panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    // A new conversation on top of the modal layers, holding focus.
    await expect(askUi.answers(panel)).toHaveCount(0);
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    const chip = askUi.chip(panel);
    await expect(chip).toContainText(chipLabel(1, 3, label));
    await expect(chip.getByText(ASK_TEXT.full)).toBeVisible();

    const full = await ask(panel, PROBE);
    await waitDone(full);
    for (const text of [label, SECRETS.correctOption, SECRETS.explanation]) {
      await expect(full).toContainText(text);
    }
    const conversationId = conversationOf(page);
    expect((await lastAnswer(viewer, conversationId)).disclosure).toBe('full');

    await askUi.chipRemove(panel).click();
    await expect(askUi.chip(panel)).toHaveCount(0);
    const bare = await ask(panel, PROBE);
    await waitDone(bare);
    await expect(bare).toContainText('attachment: none');
    await expect(bare).not.toContainText(SECRETS.explanation);
    expect((await lastAnswer(viewer, conversationId)).disclosure).toBe('none');

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(opener).toBeFocused();
    await detailUi.close(detail).click();
    await expect(detail).toBeHidden();
    await expect(panelUi.info(practice)).toBeFocused();
    // Asking is no attempt and no view: same Heatmap state, no attempt; the choice is kept.
    expect((await overviewItem(viewer, s.workspaceId, q.id)).status).toBe(stateBefore);
    expect(await listAttempts(viewer, q.id)).toEqual([]);
    await expect(panelUi.option(practice, '보기 가 증산')).toBeChecked();
    await panelUi.submit(practice).click();
    await expect(panelUi.result(practice).first()).toContainText(/오답|incorrect/i);
  },
);

test(
  'ASK-01-AC05 a practice attachment made through the API is hint-only before submitting, full after, refuses foreign sessions and ignores client disclosure',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('ask01-ac05');
    const s = await askWorkspace(workspaceFactory, 'ask01-ac05');
    const q = await createSecretQuestion(s.owner, s.workspaceId, s.book, 3, label);
    const viewer = await viewerOf(workspaceFactory, s, 'ask01-ac05-viewer');
    const session = await startPractice(viewer, q.id);
    const chosen = 'opt-1';
    const attachment = {
      kind: 'question' as const,
      view: 'practice' as const,
      question_id: q.id,
      practice_session_id: session.id,
      selected_option_ids: [chosen],
    };

    // Before submitting: hint. Nothing that tells the answer reaches the LLM or any response.
    const created = await requestConversation(viewer, s.workspaceId, { attachment });
    if (created.status !== 201) {
      throw apiError('POST', `/workspaces/${s.workspaceId}/ask/conversations`, created);
    }
    const conversation = created.body as Conversation;
    expect(conversation.attachment?.disclosure).toBe('hint');
    const posted = await requestMessage(viewer, conversation.id, { question: PROBE });
    expect(posted.status).toBe(202);
    const hintId = (posted.body as { answer: Message }).answer.id;
    const streamed = await readStream(viewer, hintId);
    const hint = await waitForAnswer(viewer, hintId);
    expect(hint.disclosure).toBe('hint');
    expect(hint.text).toContain(label);
    expect(hint.text).toContain(SECRETS.correctOption); // an ordinary option, no mark
    expect(probeSelected(hint.text)).toEqual(['보기 가 증산']);
    expect(hint.text).not.toContain(SECRETS.explanation);
    expectNoAnswerFields(hint.text, 'hint probe');
    const fetched = await getMessage(viewer, hintId);
    for (const [where, text] of [
      ['POST', created.text + posted.text],
      ['SSE', streamed.events.map((e) => e.data).join('\n')],
      ['GET', fetched.text],
    ] as const) {
      expect(text, `${where}: no explanation`).not.toContain(SECRETS.explanation);
    }
    expect(answerKeysIn(created.body)).toEqual([]);
    expect(answerKeysIn(posted.body)).toEqual([]);
    expect(answerKeysIn(fetched.body)).toEqual([]);
    for (const e of streamed.events) {
      if (e.data.startsWith('{'))
        expect(answerKeysIn(JSON.parse(e.data)), `SSE ${e.event}`).toEqual([]);
    }

    await signInAs(page, viewer.user);
    await page.goto(askPath(s.workspaceId, conversation.id));
    const panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    await expect(askUi.chip(panel).getByText(ASK_TEXT.hint)).toBeVisible();
    await expect(askUi.answers(panel).last()).not.toContainText(SECRETS.explanation);

    // The 풀이 panel's submit (the same endpoint, on this session): the next message is full.
    await submitPractice(viewer, session.id, { selected_option_ids: [chosen] });
    await page.reload();
    await expect(askUi.chip(panel).getByText(ASK_TEXT.afterSubmit)).toBeVisible();
    const after = await ask(panel, PROBE);
    await waitDone(after);
    for (const text of [SECRETS.explanation, SECRETS.correctOption]) {
      await expect(after).toContainText(text);
    }
    const full = await lastAnswer(viewer, conversation.id);
    expect(full.disclosure).toBe('full');
    expect(full.text).toMatch(new RegExp(`correct_answer\\s*:.*${SECRETS.correctOption}`));
    expect(full.text).toMatch(/submitted_answer\s*:\s*(\d+\.\s*)?보기 가 증산/);
    expect(full.text).toMatch(/result\s*:\s*(incorrect|오답)/);

    // Someone else's session: 404. A client `disclosure` is ignored.
    const ownerSession = await startPractice(s.owner, q.id);
    const foreign = await requestConversation(viewer, s.workspaceId, {
      attachment: { ...attachment, practice_session_id: ownerSession.id },
    });
    expect(foreign.status).toBe(404);
    const fresh = await startPractice(viewer, q.id);
    const forged = await createConversation(viewer, s.workspaceId, {
      attachment: { ...attachment, practice_session_id: fresh.id },
      disclosure: 'full',
    });
    expect(forged.attachment?.disclosure).toBe('hint');
    const forgedAnswer = await waitForAnswer(
      viewer,
      (await sendMessage(viewer, forged.id, PROBE)).answer.id,
    );
    expect(forgedAnswer.disclosure).toBe('hint');
    expect(forgedAnswer.text).not.toContain(SECRETS.explanation);

    // Feature off and archived: the 문제 상세 dialog has no 질문하기.
    const off = await startAskOffStack();
    try {
      await page.goto(`${off.webUrl}${overviewPath(s.workspaceId, q.id)}`);
      const offPractice = panelUi.panel(page);
      await expect(offPractice).toBeVisible();
      await choosePanelMenu(page, offPractice, 'answers');
      await expect(detailUi.dialog(page)).toBeVisible();
      await expect(askUi.questionButton(detailUi.dialog(page))).toHaveCount(0);
    } finally {
      await off.stop();
    }
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await page.goto(overviewPath(s.workspaceId, q.id));
    const archivedPractice = panelUi.panel(page);
    await expect(archivedPractice).toBeVisible();
    await choosePanelMenu(page, archivedPractice, 'answers');
    await expect(detailUi.dialog(page)).toBeVisible();
    await expect(askUi.questionButton(detailUi.dialog(page))).toHaveCount(0);
  },
);

test(
  'ASK-01-AC06 a conversation keeps its turns, reopens from the list, deletes after a confirmation and stays private to its owner',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ask01-ac06');
    const viewer = await viewerOf(workspaceFactory, s, 'ask01-ac06-viewer');
    await openHome(page, s.owner, s.workspaceId);
    let panel = await openAskPanel(page);

    // Every question names the passage: evidence comes from the last question only, and without
    // any the fake is never called (ASK-01 "찾지 못함"), so it could not count the turns.
    const questions = [
      QUESTION,
      '가나다 원리, 앞의 답을 더 짧게',
      '가나다 원리의 순서를 다시 알려 줘',
    ];
    for (const [i, question] of questions.entries()) {
      const answer = await ask(panel, question);
      await waitDone(answer);
      await expect(answer).toContainText(ASK_TEXT.turns(i));
    }
    await expect(askUi.userMessages(panel)).toHaveText(
      questions.map((x) => new RegExp(escapeRegExp(x))),
    );
    const firstId = conversationOf(page);
    const firstTitle = QUESTION.slice(0, 40);

    await askUi.close(panel).click();
    await expect(panel).toBeHidden();
    panel = await openAskPanel(page);
    await expect(askUi.list(panel)).toBeVisible();
    await askUi
      .row(panel, firstTitle)
      .getByRole('button', { name: firstTitle, exact: true })
      .click();
    await expect(page).toHaveURL((url) => url.searchParams.get('conversation') === firstId);
    await expect(askUi.answers(panel)).toHaveCount(3);

    await askUi.newButton(panel).click();
    const secondQuestion = '두 번째 대화: 가나다 원리';
    await waitDone(await ask(panel, secondQuestion));
    const secondId = conversationOf(page);
    await askUi.listButton(panel).click();
    await expect(askUi.rows(panel)).toHaveCount(2);
    await expect(askUi.rows(panel).nth(0)).toContainText(secondQuestion.slice(0, 40));
    await expect(askUi.rows(panel).nth(1)).toContainText(firstTitle);

    const row = askUi.row(panel, firstTitle);
    const menu = askUi.rowMenu(row, firstTitle);
    await menu.click();
    await askUi.deleteItem(page).click();
    let confirm = askUi.deleteConfirm(page);
    await expect(confirm).toContainText(
      /질문과 답이 모두 지워지고 되돌릴 수 없습니다|cannot be undone/i,
    );
    await confirm.getByRole('button', { name: /^(취소|cancel)$/i }).click();
    await expect(confirm).toBeHidden();
    await expect(menu).toBeFocused();
    await expect(askUi.rows(panel)).toHaveCount(2);
    await menu.click();
    await askUi.deleteItem(page).click();
    confirm = askUi.deleteConfirm(page);
    await confirm.getByRole('button', { name: /^(삭제|delete)$/i }).click();
    await expect(askUi.rows(panel)).toHaveCount(1);
    await page.goto(askPath(s.workspaceId, firstId));
    await expect(askUi.panel(page).getByText(ASK_TEXT.notFound)).toBeVisible();
    expect((await getConversation(s.owner, firstId)).status).toBe(404);

    // The viewer: the owner's conversation is 404 on every path and not listed.
    for (const res of [
      await getConversation(viewer, secondId),
      await deleteConversation(viewer, secondId),
    ]) {
      expect(res.status).toBe(404);
    }
    const ownerAnswer = await lastAnswer(s.owner, secondId);
    expect((await readStream(viewer, ownerAnswer.id, { timeoutMs: 10_000 })).status).toBe(404);
    expect((await getMessage(viewer, ownerAnswer.id)).status).toBe(404);
    const listed = await listConversations(viewer, s.workspaceId);
    expect(listed.status).toBe(200);
    expect(listed.body?.items.map((c) => c.id)).not.toContain(secondId);
    await switchUser(page, viewer);
    await page.goto(askPath(s.workspaceId, secondId));
    await expect(askUi.panel(page).getByText(ASK_TEXT.notFound)).toBeVisible();

    // History has no question, answer or ask.answer job.
    expect((await listWorkspaceJobs(s.owner, s.workspaceId)).map((j) => j.job_type)).not.toContain(
      ASK_JOB_TYPE,
    );
    expect(
      (await listActivities(s.owner, s.workspaceId))
        .map((a) => a.event_type)
        .filter((t) => /ask/i.test(t)),
    ).toEqual([]);
    await switchUser(page, s.owner);
    await page.goto(historyPath(s.workspaceId));
    await expect(historyUi.dialog(page)).toBeVisible();
    await expect(historyUi.dialog(page)).not.toContainText(secondQuestion);
    await expect(historyUi.dialog(page)).not.toContainText(/AI 질문|ask\.answer/i);
  },
);

test(
  'ASK-01-AC07 archived workspaces read past conversations but refuse new questions, other users and foreign scopes see nothing, guests get no panel',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ask01-ac07');
    const { conversation } = await askThroughApi(s.owner, s.workspaceId, QUESTION);
    const link = await createShareLink(s.owner, s.workspaceId);
    await workspaceFactory.archive(s.owner, s.workspaceId);

    await openHome(page, s.owner, s.workspaceId);
    await page.goto(askPath(s.workspaceId, conversation));
    const panel = askUi.panel(page);
    await expect(askUi.answers(panel)).toHaveCount(1);
    await expect(askUi.footnote(askUi.answers(panel).last(), 1)).toBeVisible();
    await expect(askUi.input(panel)).toHaveAttribute('aria-disabled', 'true');
    await expect(askUi.input(panel)).toHaveAccessibleDescription(ASK_TEXT.archived);
    const refused = await requestMessage(s.owner, conversation, { question: QUESTION });
    expect(refused.status).toBe(403);
    expect((refused.body as { type?: string } | undefined)?.type).toBe(ASK_PROBLEMS.archived);

    // Another user: the workspace is unknown; a foreign scope in their own workspace finds nothing.
    const outsider = await workspaceFactory.member('ask01-ac07-outsider');
    const own = await workspaceFactory.create(outsider);
    await uploadReadyBook(outsider, own.id, 'book-ko');
    const unknown = await askState(outsider, s.workspaceId);
    expect(unknown.status).toBe(404);
    const foreign = await requestConversation(outsider, s.workspaceId, {});
    expect(foreign.status).toBe(404);
    const scoped = await createConversation(outsider, own.id, {
      scope: { document_ids: [s.book.documentId], chapter_ids: [s.book.ch1] },
    });
    const answer = await waitForAnswer(
      outsider,
      (await sendMessage(outsider, scoped.id, QUESTION)).answer.id,
    );
    expect(answer.sources.map((x) => x.document_id)).not.toContain(s.book.documentId);
    expect(answer.text).not.toContain(PASSAGES.book);

    // A guest of the share link: no button, `?panel=ask` opens nothing, the ask API refuses.
    await page.context().clearCookies();
    await openShareWithSecret(page, link.id, link.secret);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(AI 질문|ask ai)$/i })).toHaveCount(0);
    await page.goto(`${sharePath(link.id)}?panel=ask`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(askUi.panel(page)).toHaveCount(0);
    const guest = await ShareSession.open(link.id, link.secret);
    for (const [method, path] of [
      ['GET', `/workspaces/${s.workspaceId}/ask`],
      ['GET', `/ask/conversations/${conversation}`],
      ['POST', `/workspaces/${s.workspaceId}/ask/conversations`],
    ] as const) {
      const res = await guest.call(method, path, method === 'POST' ? { body: {} } : {});
      expect([401, 404], `${method} ${path} with a share session`).toContain(res.status);
    }
  },
);

test(
  'ASK-01-AC08 with the feature off the panel still reads saved conversations but the input is disabled and the API refuses new questions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ask01-ac08');
    const { conversation } = await askThroughApi(s.owner, s.workspaceId, QUESTION);
    const before = (await getConversation(s.owner, conversation)).body as Conversation;
    const off = await startAskOffStack();
    try {
      const recordsBefore = new Set(recordedMessageIds());
      await openHome(page, s.owner, s.workspaceId, off.webUrl);
      await page.goto(`${off.webUrl}${askPath(s.workspaceId, conversation)}`);
      const panel = askUi.panel(page);
      await expect(askUi.input(panel)).toHaveAttribute('aria-disabled', 'true');
      await expect(askUi.input(panel)).toHaveAccessibleDescription(ASK_TEXT.disabled);
      await expect(askUi.send(panel)).toHaveCount(0);
      const answer = askUi.answers(panel).last();
      await expect(answer).toBeVisible();
      await askUi.footnote(answer, 1).click();
      await expect(searchUi.excerptPanel(page)).toContainText(PASSAGES.book);

      const state = await stackRequest<AskState>(
        off.apiUrl,
        s.owner,
        'GET',
        `/workspaces/${s.workspaceId}/ask`,
      );
      expect(state.status).toBe(200);
      expect(state.body?.available).toBe(false);
      const refused = await stackRequest(
        off.apiUrl,
        s.owner,
        'POST',
        `/ask/conversations/${conversation}/messages`,
        {
          question: QUESTION,
        },
      );
      expect(refused.status).toBe(409);
      expect((refused.body as { type?: string } | undefined)?.type).toBe(ASK_PROBLEMS.disabled);
      const after = (await getConversation(s.owner, conversation)).body as Conversation;
      expect(after.messages.length, 'no message was created').toBe(before.messages.length);
      // Parallel tests share the record directory: only this conversation's answers count.
      const ids = new Set(after.messages.map((m) => m.id));
      expect(
        recordedMessageIds().filter((id) => !recordsBefore.has(id) && ids.has(id)),
        'no LLM call',
      ).toEqual([]);
    } finally {
      await off.stop();
    }
  },
);

test(
  'ASK-01-AC09 provider errors retry, a stop keeps the partial answer, limits explain themselves, a reload resumes the stream and regenerated answers keep their versions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(3 * JOB_TIMEOUT_MS + 6 * ASK_TIMEOUT_MS);
    const s = await askWorkspace(workspaceFactory, 'ask01-ac09');
    const members: Member[] = [];
    for (const name of ['fail', 'slow', 'length', 'rate', 'regen']) {
      const m = await workspaceFactory.member(`ask01-ac09-${name}`);
      seedMembership(s.workspaceId, m.user.id, 'editor');
      members.push(m);
    }
    const [failing, slow, length, rate, regen] = members as [
      Member,
      Member,
      Member,
      Member,
      Member,
    ];
    const stack = await startAskLimitStack();
    const home = `${stack.webUrl}${homePath(s.workspaceId)}`;
    const open = async (member: Member): Promise<Locator> => {
      await switchUser(page, member);
      await page.goto(home);
      return openAskPanel(page);
    };
    try {
      // Provider error → alert + 다시 시도 → a new, successful answer; the failed one stays.
      let panel = await open(failing);
      const failed = await ask(panel, `${ASK_MARKERS.fail} ${QUESTION}`);
      await waitDone(failed);
      await expect(askUi.alert(failed)).toHaveText(ASK_TEXT.llmUnavailable);
      await askUi.retry(failed).click();
      const retried = askUi.answers(panel).last();
      await waitDone(retried);
      await expect(askUi.footnote(retried, 1)).toBeVisible();
      const failedConversation = conversationOf(page);
      const res = await stackRequest<Conversation>(
        stack.apiUrl,
        failing,
        'GET',
        `/ask/conversations/${failedConversation}`,
      );
      const answers = (res.body as Conversation).messages.filter((m) => m.role === 'assistant');
      expect(answers.map((m) => m.status)).toEqual(['failed', 'succeeded']);
      expect(answers[1]?.retry_of_message_id).toBe(answers[0]?.id);
      expect(answers[0]?.error_code).toBe('llm_unavailable');
      expect(res.text, 'no prompt or provider text').not.toMatch(/prompt|provider|traceback/i);

      // 답변 중지 keeps what arrived, stops the worker; a reload mid-stream resumes to the end.
      panel = await open(slow);
      const stopped = await ask(panel, `${ASK_MARKERS.slow} ${QUESTION}`);
      // The fake's first delta starts with the chapter 1 passage (Korean text has short words).
      await expect(stopped).toContainText(PASSAGES.book, { timeout: ASK_TIMEOUT_MS });
      await askUi.stop(panel).click();
      await expect(stopped).toContainText(ASK_TEXT.stopped);
      const slowConversation = conversationOf(page);
      const stoppedMessage = (
        await stackRequest<Conversation>(
          stack.apiUrl,
          slow,
          'GET',
          `/ask/conversations/${slowConversation}`,
        )
      ).body?.messages.at(-1);
      expect(stoppedMessage?.status).toBe('stopped');
      // The fake writes its call record when the call ends (Q8): the worker closed the stream a
      // few deltas after the stop, far before the SLOW answer's 40, and nothing follows.
      const stoppedId = stoppedMessage?.id ?? '';
      await expect
        .poll(() => fakeCalls(stoppedId).length, { message: 'the stopped call ended' })
        .toBeGreaterThan(0);
      const sentAtStop = fakeCalls(stoppedId).at(-1)?.deltas_sent ?? 0;
      expect(sentAtStop, 'the stream closed early').toBeLessThan(40);
      await page.waitForTimeout(3_000); // several of the fake's 500 ms delta intervals
      expect(
        fakeCalls(stoppedId).map((c) => c.deltas_sent),
        'no delta after stop',
      ).toEqual([sentAtStop]);
      await expect(askUi.retry(stopped)).toBeVisible();

      const flowing = await ask(panel, `${ASK_MARKERS.slow} 다시 ${QUESTION}`);
      await expect(flowing).toHaveAttribute('aria-busy', 'true');
      await expect(flowing).toContainText(PASSAGES.book, { timeout: ASK_TIMEOUT_MS });
      await page.reload();
      panel = askUi.panel(page);
      const resumed = askUi.answers(panel).last();
      await waitDone(resumed);
      const done = (
        await stackRequest<Conversation>(
          stack.apiUrl,
          slow,
          'GET',
          `/ask/conversations/${slowConversation}`,
        )
      ).body?.messages.at(-1);
      expect(done?.status).toBe('succeeded');
      const lead = (done?.text ?? '')
        .replace(/\[\d+\]/g, '')
        .trim()
        .slice(0, 20);
      const shown = await resumed.innerText();
      expect(shown.split(lead).length - 1, 'the resumed text has no duplicate').toBe(1);

      // 1,001 characters: counter, disabled send, 422.
      panel = await open(length);
      await askUi.input(panel).fill('가'.repeat(1_001));
      await expect(askUi.counter(panel, '1,001/1,000')).toBeVisible();
      await expect(askUi.send(panel)).toHaveAttribute('aria-disabled', 'true');
      const conv = await stackRequest<Conversation>(
        stack.apiUrl,
        length,
        'POST',
        `/workspaces/${s.workspaceId}/ask/conversations`,
        {},
      );
      expect(conv.status).toBe(201);
      const long = await stackRequest(
        stack.apiUrl,
        length,
        'POST',
        `/ask/conversations/${conv.body?.id}/messages`,
        {
          question: '가'.repeat(1_001),
        },
      );
      expect(long.status).toBe(422);
      expect((long.body as { type?: string } | undefined)?.type).toBe(ASK_PROBLEMS.tooLong);

      // Per-minute limit 2: the third question is refused with the wait, the text stays.
      panel = await open(rate);
      await waitDone(await ask(panel, `${QUESTION} 1`));
      await waitDone(await ask(panel, `${QUESTION} 2`));
      const third = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          /\/api\/ask\/conversations\/[^/]+\/messages$/.test(r.url()),
      );
      await askUi.input(panel).fill(`${QUESTION} 3`);
      await askUi.input(panel).press('Enter');
      expect((await third).status()).toBe(429);
      await expect(panel.getByText(ASK_TEXT.rateLimited)).toBeVisible();
      await expect(askUi.input(panel)).toHaveValue(`${QUESTION} 3`);

      // 다시 생성: a second version "답 2/2"; 이전 답 shows version 1 unchanged; the limit (2).
      panel = await open(regen);
      const original = await ask(panel, QUESTION);
      await waitDone(original);
      const regenConversation = conversationOf(page);
      const v1 = (
        await stackRequest<Conversation>(
          stack.apiUrl,
          regen,
          'GET',
          `/ask/conversations/${regenConversation}`,
        )
      ).body?.messages.at(-1);
      await askUi.regenerate(original).click();
      const latest = askUi.answers(panel).last();
      await expect(askUi.version(latest, 2, 2)).toBeVisible({ timeout: ASK_TIMEOUT_MS });
      await waitDone(latest);
      await askUi.previousVersion(latest).click();
      const older = askUi.answers(panel).last();
      await expect(askUi.version(older, 1, 2)).toBeVisible();
      await expect(older).toContainText(
        (v1?.text ?? '')
          .replace(/\[\d+\]/g, '')
          .trim()
          .slice(0, 20),
      );
      await expect(askUi.footnote(older, 1)).toBeVisible();
      await askUi.nextVersion(older).click();
      const limited = askUi.regenerate(askUi.answers(panel).last());
      await expect(limited).toHaveAttribute('aria-disabled', 'true');
      await expect(panel.getByText(ASK_TEXT.regenerateLimit)).toBeVisible();
      // The regeneration counted for the per-minute limit (question + regeneration = 2).
      await askUi.input(panel).fill('세 번째 요청');
      await askUi.input(panel).press('Enter');
      await expect(panel.getByText(ASK_TEXT.rateLimited)).toBeVisible();
      const all = (
        await stackRequest<Conversation>(
          stack.apiUrl,
          regen,
          'GET',
          `/ask/conversations/${regenConversation}`,
        )
      ).body as Conversation;
      const newest = all.messages.at(-1);
      expect(newest?.regenerated_from_message_id).toBe(v1?.id);
      // Past the per-minute window the version limit is what refuses.
      await expect
        .poll(
          async () => {
            const r = await stackRequest(
              stack.apiUrl,
              regen,
              'POST',
              `/ask/messages/${newest?.id}/regenerate`,
              {},
            );
            return `${r.status} ${(r.body as { type?: string } | undefined)?.type ?? ''}`;
          },
          { timeout: 90_000, intervals: [5_000] },
        )
        .toBe(`409 ${ASK_PROBLEMS.regenerateLimit}`);
    } finally {
      await stack.stop();
    }
  },
);

test(
  'ASK-01-AC10 keyboard users get IME-safe Enter, one live announcement per answer, header-to-input tab order and Escape that unwinds panel by panel',
  { tag: '@infra' },
  async ({ page, workspaceFactory, browserName }) => {
    const s = await askWorkspace(workspaceFactory, 'ask01-ac10');
    await askThroughApi(s.owner, s.workspaceId, QUESTION);
    await openHome(page, s.owner, s.workspaceId);
    const header = askUi.headerButton(page);
    await expect(header).toBeVisible();
    await header.focus();
    await page.keyboard.press('Enter');
    const panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    await askUi.newButton(panel).click();
    const input = askUi.input(panel);
    await input.focus();

    // Enter while composing Hangul does not send; after the composition Shift+Enter breaks the
    // line and Enter sends.
    await input.evaluate((el: HTMLTextAreaElement, text: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      setter?.call(el, text);
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: text,
          isComposing: true,
          inputType: 'insertCompositionText',
        }),
      );
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          keyCode: 229,
          isComposing: true,
        }),
      );
    }, '가나다 원리');
    await expect(askUi.userMessages(panel)).toHaveCount(0);
    await input.evaluate((el: HTMLTextAreaElement) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '리' }));
    });
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('를 설명해 줘');
    await expect(input).toHaveValue('가나다 원리\n를 설명해 줘');
    await expect(askUi.userMessages(panel)).toHaveCount(0);
    await watchAnswers(page);
    await page.keyboard.press('Enter');
    await expect(askUi.userMessages(panel)).toHaveCount(1);
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    const answer = askUi.answers(panel).last();
    await waitDone(answer);
    const seen = await watched(page);
    expect(seen.busySeen, 'aria-busy="true" while streaming').toBe(true);
    const sources = await askUi.sourceItems(answer).count();
    expect(seen.statuses.filter((t) => ASK_TEXT.liveWriting.test(t))).toHaveLength(1);
    expect(seen.statuses.filter((t) => ASK_TEXT.liveDone(sources).test(t))).toHaveLength(1);
    expect(seen.statuses.length, 'no per-character announcements').toBeLessThanOrEqual(4);

    // Tab order: header → the answer's footnote, sources, actions → input → send.
    await askUi.newButton(panel).focus();
    const order: string[] = [];
    // WebKit (like Safari) reaches buttons with Option+Tab (sharing-owner.spec.ts).
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press(tab);
      const name = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return '';
        const labelledBy = el.getAttribute('aria-labelledby');
        const byId = labelledBy ? document.getElementById(labelledBy)?.textContent : null;
        const label = (el as HTMLTextAreaElement).labels?.[0]?.textContent;
        return (
          el.getAttribute('aria-label') ||
          byId?.trim() ||
          label?.trim() ||
          el.textContent?.trim() ||
          el.tagName
        );
      });
      order.push(name);
      if (/^(보내기|send)$/i.test(name)) break;
    }
    const at = (re: RegExp) => order.findIndex((n) => re.test(n));
    expect(at(/^(출처|source) 1: /i)).toBeGreaterThan(-1);
    expect(at(/^(출처|source) 1: /i)).toBeLessThan(at(/^(복사|copy)$/i));
    expect(at(/^(복사|copy)$/i)).toBeLessThan(at(/^(질문|question)$|문서에 대해 질문하세요/i));
    expect(at(/^(보내기|send)$/i)).toBe(order.length - 1);

    await askUi.footnote(answer, 1).focus();
    await page.keyboard.press('Enter');
    const excerpt = searchUi.excerptPanel(page);
    await expect(excerpt).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(excerpt).toBeHidden();
    await expect(askUi.footnote(answer, 1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(header).toBeFocused();

    await header.click();
    await expect(panel).toBeVisible();
    await expectAccessible(page, `AI 질문 panel with an answer (${browserName})`, {
      include: ['[role="dialog"]'],
    });
  },
);

test.describe('ASK-01-AC10 touch', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  test.use(iphone);

  test(
    'ASK-01-AC10 on a phone the panel is a full-height sheet whose input and send stay visible without horizontal scrolling',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const s = await askWorkspace(workspaceFactory, 'ask01-ac10-touch');
      await askThroughApi(s.owner, s.workspaceId, QUESTION);
      await openHome(page, s.owner, s.workspaceId);
      const header = askUi.headerButton(page);
      await expect(header).toBeVisible();
      await header.tap();
      const panel = askUi.panel(page);
      await expect(panel).toBeVisible();
      const viewport = page.viewportSize();
      if (!viewport) throw new Error('no viewport');
      await expect
        .poll(async () => {
          const box = await panel.boundingBox();
          return box
            ? Math.round(box.height) >= viewport.height - 2 &&
                Math.round(box.width) >= viewport.width - 2
            : false;
        })
        .toBe(true);
      await askUi.input(panel).tap();
      await expect(askUi.input(panel)).toBeFocused();
      await expect(askUi.input(panel)).toBeInViewport();
      await expect(askUi.send(panel)).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        'no horizontal scroll',
      ).toBe(true);
      for (const button of await panel.getByRole('button').all()) {
        if (!(await button.isVisible())) continue;
        const box = await button.boundingBox();
        expect(
          Math.min(box?.width ?? 0, box?.height ?? 0),
          'touch target ≥ 24px',
        ).toBeGreaterThanOrEqual(24);
      }
    },
  );
});

/** The search AI action is absent when new questions are unavailable. */
async function expectSearchButtonHidden(page: Page): Promise<void> {
  await openContentSearch(page);
  await expect(askUi.searchButton(page)).toHaveCount(0);
  await page.goBack();
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

test(
  'ASK-01-AC11 the header and search open AI 질문 when available; new actions are hidden when archived or off',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ask01-ac11');
    const viewer = await viewerOf(workspaceFactory, s, 'ask01-ac11-viewer');
    await openHome(page, viewer, s.workspaceId);

    const { conversation } = await askThroughApi(viewer, s.workspaceId, QUESTION);
    await openAskPanel(page);
    expect(askParams(page).panels).toEqual(['ask']);
    await page.goBack();
    await expect(askUi.panel(page)).toHaveCount(0);
    await page.goForward();
    await expect(askUi.panel(page)).toHaveCount(0);

    // AI에게 묻기: a new conversation prefilled with the search text and the document scope.
    await runSearch(page, PASSAGES.book, 'keyword');
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    await openSearchOptions(page);
    // Reopening the options focuses the checked mode radio, whose description tooltip covers the
    // filter; moving focus (and the pointer) to the filter closes it.
    await page.mouse.move(0, 0);
    await searchUi.documentFilter(page).focus();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await chooseFilter(page, searchUi.documentFilter(page), new RegExp(escapeRegExp(s.book.title)));
    await closeSearchOptions(page);
    const textParam = new URL(page.url()).searchParams.get('text');
    await askUi.searchButton(page).click();
    const panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    await expect(askUi.input(panel)).toHaveValue(PASSAGES.book);
    await expect(askUi.userMessages(panel)).toHaveCount(0);
    await expect(askUi.scopeText(panel)).toContainText(s.book.title);
    expect(
      (await listConversations(viewer, s.workspaceId)).body?.items.map((item) => item.id),
    ).toEqual([conversation]);
    expect(new URL(page.url()).searchParams.get('text')).toBe(textParam);
    await askUi.close(panel).click();
    // The modal panel hides the page from assistive technology: the search is checked once closed.
    await expect(panel).toHaveCount(0);
    await expect(searchUi.box(page)).toHaveValue(PASSAGES.book);
    await expect(searchUi.resultItems(page).first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get('text')).toBe(textParam);

    // Feature off: new entry points are absent; the stored conversation remains readable.
    const off = await startAskOffStack();
    try {
      await page.goto(`${off.webUrl}${homePath(s.workspaceId)}`);
      await expect(homeUi.questionMenuButton(page)).toBeVisible();
      await expect(askUi.headerButton(page)).toHaveCount(0);
      await homeUi.questionMenuButton(page).click();
      await expect(askUi.menuItem(page)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expectSearchButtonHidden(page);
      await page.goto(`${off.webUrl}${askPath(s.workspaceId, conversation)}`);
      await expect(askUi.answers(askUi.panel(page))).toHaveCount(1);
      await expect(askUi.send(askUi.panel(page))).toHaveCount(0);
      const refused = await stackRequest(
        off.apiUrl,
        viewer,
        'POST',
        `/ask/conversations/${conversation}/messages`,
        { question: QUESTION },
      );
      expect(refused.status).toBe(409);
      expect((refused.body as { type?: string } | undefined)?.type).toBe(ASK_PROBLEMS.disabled);
    } finally {
      await off.stop();
    }

    // Archived: stored content remains readable, but no new question entry point is offered.
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await page.goto(homePath(s.workspaceId));
    await expect(homeUi.questionMenuButton(page)).toBeVisible();
    await expect(askUi.headerButton(page)).toHaveCount(0);
    await homeUi.questionMenuButton(page).click();
    await expect(askUi.menuItem(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectSearchButtonHidden(page);
    await page.goto(askPath(s.workspaceId, conversation));
    await expect(askUi.answers(askUi.panel(page))).toHaveCount(1);
    await expect(askUi.send(askUi.panel(page))).toHaveCount(0);
    const refused = await requestMessage(viewer, conversation, { question: QUESTION });
    expect(refused.status).toBe(403);
    expect((refused.body as { type?: string } | undefined)?.type).toBe(ASK_PROBLEMS.archived);
  },
);

test(
  'ASK-01-AC12 mock exam questions attach hint-only before submitting and full after, above the run panel, and lose their context once the mock exam is deleted',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const label = unique('ask01-ac12');
    const s = await askWorkspace(workspaceFactory, 'ask01-ac12');
    const { exam, sources } = await seedSecretMockExam(s.owner, s.workspaceId, s.book, label);
    const source = sources[0] as Question;
    const viewer = await viewerOf(workspaceFactory, s, 'ask01-ac12-viewer');
    const stateBefore = (await overviewItem(viewer, s.workspaceId, source.id)).status;
    const bankAttempts = questionAttemptCount(s.workspaceId);

    // Viewer: 풀기 → 시작, pick a wrong option, 질문하기 before submitting.
    await signInAs(page, viewer.user);
    await page.goto(mockExamsPath(s.workspaceId));
    const list = mockUi.dialog(page);
    await expect(list).toBeVisible();
    await mockUi.practise(list.getByRole('listitem').filter({ hasText: exam.title })).click();
    let run = runUi.panel(page);
    await runUi.start(run).click();
    await expect(page).toHaveURL(/[?&]practice=[0-9a-f-]{36}(&|$)/);
    run = runUi.panel(page);
    await expect(runUi.mockTitle(run, 1)).toBeVisible();
    const wrong = run.getByRole('radio', { name: /^보기 가 \d$/ });
    await wrong.check();
    const opener = askUi.questionButton(run);
    await expect(opener, 'the mock exam run header has 질문하기').toBeVisible();
    await opener.click();
    let panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expect(askUi.chip(panel)).toContainText(/문제 1 · /);
    await expect(askUi.chip(panel).getByText(ASK_TEXT.hint)).toBeVisible();
    const hint = await ask(panel, PROBE);
    await waitDone(hint);
    await expect(hint).toContainText(label);
    await expect(hint).toContainText(SECRETS.mockCorrectOption);
    await expect(hint).not.toContainText(SECRETS.mockExplanation);
    const firstConversation = conversationOf(page);
    const hintMessage = await lastAnswer(viewer, firstConversation);
    const picked = probeSelected(hintMessage.text);
    expect(picked, 'the chosen option, by its display number').toHaveLength(1);
    expect(picked[0]).toMatch(/^보기 가 \d$/);
    expect(hintMessage.disclosure).toBe('hint');
    expectNoAnswerFields(hintMessage.text, 'mock hint probe');

    // Back once closes only the AI panel; the run keeps its position and choice.
    await page.goBack();
    await expect(panel).toBeHidden();
    const url = new URL(page.url());
    expect(url.searchParams.getAll('panel')).not.toContain('ask');
    expect(url.searchParams.get('practice')).toMatch(/^[0-9a-f-]{36}$/);
    expect(url.searchParams.get('i')).toBe('1');
    await expect(opener).toBeFocused();
    await expect(wrong).toBeChecked();
    await expect(runUi.progress(run)).toHaveAttribute('aria-valuetext', progressText(1, 2));

    // After submitting: a new conversation with the answer, explanation and chapter 1's source.
    await runUi.submit(run).click();
    await expect(runUi.result(run)).toContainText(/오답|incorrect/i);
    await opener.click();
    panel = askUi.panel(page);
    await expect(askUi.chip(panel).getByText(ASK_TEXT.afterSubmit)).toBeVisible();
    const full = await ask(panel, PROBE);
    await waitDone(full);
    expect(conversationOf(page)).not.toBe(firstConversation);
    for (const text of [SECRETS.mockExplanation, SECRETS.mockCorrectOption, PASSAGES.book]) {
      await expect(full).toContainText(text);
    }
    const fullMessage = await lastAnswer(viewer, conversationOf(page));
    expect(fullMessage.disclosure).toBe('full');
    expect(fullMessage.text).toMatch(/submitted_answer\s*:/);
    expect(fullMessage.text).toMatch(/result\s*:\s*(incorrect|오답)/);
    expect(fullMessage.text).toMatch(new RegExp(`question_sources\\s*:.*${PASSAGES.book}`, 's'));
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    expect(mockAttemptCount(exam.id), 'only the submit wrote a mock attempt').toBe(1);
    expect(questionAttemptCount(s.workspaceId)).toBe(bankAttempts);
    expect((await overviewItem(viewer, s.workspaceId, source.id)).status).toBe(stateBefore);

    // Editor: manage(mock) 질문하기 → "정답·해설 포함".
    await switchUser(page, s.owner);
    await page.goto(mockExamsPath(s.workspaceId, exam.id));
    const detail = mockUi.dialog(page);
    await expect(detail).toBeVisible();
    await questionRow(detail, 1).getByRole('button').first().click();
    const manage = mockUi.viewer(page, 1);
    await expect(manage).toBeVisible();
    await askUi.questionButton(manage).click();
    panel = askUi.panel(page);
    await expect(askUi.chip(panel).getByText(ASK_TEXT.full)).toBeVisible();
    const managed = await ask(panel, PROBE);
    await waitDone(managed);
    await expect(managed).toContainText(SECRETS.mockExplanation);
    await page.keyboard.press('Escape');

    // The mock exam is deleted: the first conversation's chip says so and context is gone.
    await s.owner.api.ok('DELETE', `/mock-exams/${exam.id}`, undefined, [204]);
    await switchUser(page, viewer);
    await page.goto(askPath(s.workspaceId, firstConversation));
    panel = askUi.panel(page);
    await expect(askUi.chip(panel)).toContainText(ASK_TEXT.gone);
    const gone = await ask(panel, PROBE);
    await waitDone(gone);
    await expect(gone).toContainText('attachment: none');
    await askUi.close(panel).click();

    // The bank's range run (문제 풀기) has no 질문하기.
    await page.goto(homePath(s.workspaceId));
    const picker = await openRangePicker(page);
    await runUi.selectAll(picker).check();
    await runUi.start(picker).click();
    const bankRun = runUi.panel(page);
    await expect(bankRun.getByRole('radio').first()).toBeVisible();
    await expect(askUi.questionButton(bankRun)).toHaveCount(0);
  },
);
