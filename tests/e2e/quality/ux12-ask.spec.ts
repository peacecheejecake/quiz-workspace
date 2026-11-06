// UX12-ASK — the AI 질문 conversation list and conversation screen (D-10, user design change
// 2026-11-06). The rules are in docs/screens/ux12-ask.md; the draft and focus races the browser
// cannot force are in apps/web/test/ask-panel.test.tsx.
import type { Locator, Page } from '@playwright/test';
import {
  ASK_MARKERS,
  ASK_TEXT,
  ASK_TIMEOUT_MS,
  ask,
  askPath,
  askThroughApi,
  askUi,
  deleteConversation,
  getConversation,
  messageAction,
  openAskPanel,
  openComposer,
  seedAskBook,
  waitDone,
  waitForAnswer,
  type AskBook,
  type Conversation,
} from '../fixtures/ask.ts';
import {
  expect,
  homePath,
  homeUi,
  JOB_TIMEOUT_MS,
  signInAs,
  test,
  type Member,
} from '../fixtures/test.ts';
import { chooseFilter } from '../fixtures/workspace-ui.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 2 * JOB_TIMEOUT_MS + 2 * ASK_TIMEOUT_MS });

const QUESTION = '가나다 원리를 설명해 줘';
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: '375px', width: 375, height: 667 },
] as const;

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

async function openHome(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(homePath(workspaceId));
  await expect(homeUi.questionMenuButton(page)).toBeVisible();
}

async function box(target: Locator) {
  const value = await target.boundingBox();
  if (!value) throw new Error('the element has no box');
  return value;
}

const scrollBody = (panel: Locator, to: 'top' | 'end') =>
  panel.locator('.body').evaluate(
    (el, where) =>
      el.scrollTo({
        top: where === 'top' ? 0 : el.scrollHeight,
        behavior: 'instant',
      }),
    to,
  );

const titlePattern = (title: string) =>
  new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** The FAB sits at the panel's bottom end corner, whatever the list's length. */
async function expectFabAtCorner(panel: Locator): Promise<void> {
  const fab = askUi.newButton(panel);
  await expect(fab).toBeVisible();
  const [button, frame] = [await box(fab), await box(panel)];
  expect(Math.round(button.width)).toBe(56);
  expect(Math.round(button.height)).toBe(56);
  const right = frame.x + frame.width - (button.x + button.width);
  const bottom = frame.y + frame.height - (button.y + button.height);
  expect(right).toBeGreaterThanOrEqual(0);
  expect(right).toBeLessThanOrEqual(32);
  expect(bottom).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeLessThanOrEqual(32);
}

test(
  'UX12-ASK-AC01 the list has no composer and a round FAB at the bottom end, clear of the last row',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-ask-01');
    const ws = await workspaceFactory.create(owner);
    await openHome(page, owner, ws.id);

    for (const viewport of VIEWPORTS) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize(viewport);
        const panel = await openAskPanel(page);
        await expect(panel.getByText(ASK_TEXT.empty)).toBeVisible();
        await expect(askUi.input(panel)).toHaveCount(0);
        await expect(askUi.send(panel)).toHaveCount(0);
        await expect(askUi.scopeButton(panel)).toHaveCount(0);
        await expect(askUi.listButton(panel)).toHaveCount(0);
        await expectFabAtCorner(panel);
        const fab = askUi.newButton(panel);
        await expect(fab).toHaveAttribute('data-variant', 'primary');
        expect(
          await fab.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)),
        ).toBeGreaterThanOrEqual(28);
        await askUi.close(panel).click();
        await expect(panel).toBeHidden();
      });
    }

    // Rows taller than the panel: the last row's menu is reachable below the floating button.
    await page.setViewportSize(VIEWPORTS[1]);
    const rows = Array.from({ length: 16 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      title: `대화 ${i + 1}`,
      last_message_at: '2026-11-06T00:00:00Z',
      created_at: '2026-11-06T00:00:00Z',
    }));
    await page.route(/\/ask\/conversations(\?.*)?$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { items: rows, next_cursor: null } })
        : route.continue(),
    );
    const panel = await openAskPanel(page);
    await expect(askUi.rows(panel)).toHaveCount(16);
    await expectFabAtCorner(panel);
    await scrollBody(panel, 'end');
    const menu = askUi.rowMenu(askUi.row(panel, '대화 16'), '대화 16');
    const [menuBox, fabBox] = [await box(menu), await box(askUi.newButton(panel))];
    expect(menuBox.y + menuBox.height, 'the last menu is above the FAB').toBeLessThanOrEqual(
      fabBox.y,
    );
    await menu.click();
    await expect(askUi.deleteItem(page)).toBeVisible();
  },
);

test(
  'UX12-ASK-AC02 a refused delete and the archived notice show on the list, the live region stays mounted',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ux12-ask-02');
    const { conversation } = await askThroughApi(s.owner, s.workspaceId, QUESTION);
    const title = ((await getConversation(s.owner, conversation)).body as Conversation).title ?? '';
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openAskPanel(page);
    const row = askUi.row(panel, title);
    await expect(row).toBeVisible();
    await expect(panel.getByRole('status')).toHaveCount(1);

    const one = `**/ask/conversations/${conversation}`;
    await page.route(one, (route) =>
      route.request().method() === 'DELETE' ? route.abort('failed') : route.continue(),
    );
    await askUi.rowMenu(row, title).click();
    await askUi.deleteItem(page).click();
    await askUi
      .deleteConfirm(page)
      .getByRole('button', { name: /^(삭제|delete)$/i })
      .click();
    await expect(askUi.deleteConfirm(page)).toBeHidden();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: title, exact: true }).click();
    await expect(askUi.input(panel)).toBeVisible();
    await expect(panel.getByRole('status')).toHaveCount(1);

    await page.unroute(one);
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await page.goto(askPath(s.workspaceId));
    const archived = askUi.panel(page);
    await expect(archived.getByText(ASK_TEXT.archived)).toBeVisible();
    await expect(askUi.newButton(archived)).toHaveCount(0);
    await expect(archived.getByRole('status')).toHaveCount(1);
  },
);

test(
  'UX12-ASK-AC03 a draft and its scope survive the list, a lost question stays recoverable and sends once',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ux12-ask-03');
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openAskPanel(page);
    const input = await openComposer(panel);
    await input.fill('작성 중인 질문');
    await askUi.scopeButton(panel).click();
    const popover = askUi.scopePopover(page);
    await chooseFilter(
      page,
      popover.getByRole('combobox', { name: /^(문서|document)$/i }),
      titlePattern(s.book.title),
    );
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    await askUi.listButton(panel).click();
    await expect(input).toHaveCount(0);
    await askUi.newButton(panel).click();
    await expect(input).toHaveValue('작성 중인 질문');
    await expect(input).toBeFocused();
    await expect(askUi.scopeText(panel)).toContainText(s.book.title);

    // The accepted turn's response is lost: the question is in the recovery area on the list, and
    // the kept draft goes out again with the same key.
    const keys: string[] = [];
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (keys.length === 1) {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await input.press('Enter');
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(input).toHaveValue('작성 중인 질문');
    await askUi.listButton(panel).click();
    await expect(panel.getByRole('group', { name: '보내지 못한 질문' })).toContainText(
      '작성 중인 질문',
    );
    await askUi.newButton(panel).click();
    await expect(input).toHaveValue('작성 중인 질문');
    await input.press('Enter');
    await expect.poll(() => keys.length).toBe(2);
    expect(keys[1]).toBe(keys[0]);
    await expect(askUi.userMessages(panel)).toHaveCount(1);
    await waitDone(askUi.answers(panel).last());
  },
);

test(
  'UX12-ASK-AC04 the conversation header has the back arrow, no 새 대화, and focus follows the screens',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ux12-ask-04');
    const { conversation } = await askThroughApi(s.owner, s.workspaceId, QUESTION);
    await openHome(page, s.owner, s.workspaceId);
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto(askPath(s.workspaceId, conversation));
    const panel = askUi.panel(page);
    await expect(askUi.answers(panel).last()).toBeVisible();
    const back = askUi.listButton(panel);
    await expect(back).toBeVisible();
    await expect(back.locator('svg')).toBeVisible();
    await expect(askUi.newButton(panel)).toHaveCount(0);
    await expect(panel).toHaveAccessibleName(/^AI 질문$/);

    const top = (await box(back)).y;
    await scrollBody(panel, 'end');
    expect((await box(back)).y).toBe(top);

    await back.click();
    await expect(askUi.newButton(panel)).toBeFocused();

    await deleteConversation(s.owner, conversation);
    await page.goto(askPath(s.workspaceId, conversation));
    await expect(panel.getByText(ASK_TEXT.notFound)).toBeVisible();
    await expect(askUi.input(panel)).toHaveCount(0);
    await askUi.newButton(panel).click();
    await expect(askUi.input(panel)).toBeFocused();
  },
);

test(
  'UX12-ASK-AC05 the composer floats at the bottom with submit then scope inside, clear of the last message',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ux12-ask-05');
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openAskPanel(page);
    await waitDone(await ask(panel, QUESTION));

    for (const viewport of VIEWPORTS) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize({ ...viewport, height: 480 });
        const input = askUi.input(panel);
        await scrollBody(panel, 'end');
        const [frame, field, send, scope, copy] = [
          await box(panel),
          await box(input),
          await box(askUi.send(panel)),
          await box(askUi.scopeButton(panel)),
          await box(askUi.copy(askUi.answers(panel).last())),
        ];
        expect(frame.y + frame.height - (scope.y + scope.height)).toBeLessThanOrEqual(48);
        expect(field.x + field.width).toBeLessThanOrEqual(send.x + 1);
        expect(send.x + send.width).toBeLessThanOrEqual(scope.x + 1);
        expect(copy.y + copy.height, 'the last message clears the composer').toBeLessThanOrEqual(
          field.y,
        );

        await scrollBody(panel, 'top');
        await expect(input).toBeInViewport();
        expect(Math.round((await box(input)).y)).toBe(Math.round(field.y));
      });
    }
  },
);

test(
  'UX12-ASK-AC06 질문 범위 is a filter icon with an indicator, opens upward without radios and fills a phone',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ux12-ask-06');
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openAskPanel(page);
    await openComposer(panel);
    const button = askUi.scopeButton(panel);
    await expect(button.locator('svg')).toBeVisible();
    await expect(button).not.toHaveAttribute('data-narrowed');
    await expect(askUi.scopeText(panel)).toHaveCount(0);

    await button.click();
    const popover = askUi.scopePopover(page);
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('radio')).toHaveCount(0);
    const opened = await box(popover);
    expect(opened.y + opened.height).toBeLessThanOrEqual((await box(button)).y);
    const documents = popover.getByRole('combobox', { name: /^(문서|document)$/i });
    await chooseFilter(page, documents, titlePattern(s.book.title));
    await expect(button).toHaveAttribute('data-narrowed', 'true');
    await expect(askUi.scopeText(panel)).toContainText(s.book.title);
    await chooseFilter(page, documents, /^전체 교재$/);
    await expect(button).not.toHaveAttribute('data-narrowed');
    await expect(askUi.scopeText(panel)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    await page.setViewportSize(VIEWPORTS[1]);
    await button.click();
    await expect(popover).toBeVisible();
    const phone = await box(popover);
    expect(Math.round(phone.x)).toBe(16);
    expect(Math.round(phone.width)).toBe(375 - 32);
    const select = await box(documents);
    expect(select.x).toBeGreaterThanOrEqual(phone.x);
    expect(select.width).toBeGreaterThanOrEqual(phone.width - 2 * 48);
    await page.keyboard.press('Escape');

    const { conversation } = await askThroughApi(s.owner, s.workspaceId, QUESTION);
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await page.goto(askPath(s.workspaceId, conversation));
    await expect(askUi.input(panel)).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveCount(0);
  },
);

test(
  'UX12-ASK-AC07 the submit button becomes the stop button while an answer is awaited',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ux12-ask-07');
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openAskPanel(page);
    await openComposer(panel);
    const at = await box(askUi.send(panel));
    const answer = await ask(panel, `${ASK_MARKERS.slow} ${QUESTION}`);
    const stop = askUi.stop(panel);
    await expect(stop).toBeVisible();
    await expect(askUi.send(panel)).toHaveCount(0);
    await expect(stop.locator('svg')).toBeVisible();
    expect(Math.round((await box(stop)).x)).toBe(Math.round(at.x));
    await stop.click();
    await expect(answer).toContainText(ASK_TEXT.stopped, { timeout: ASK_TIMEOUT_MS });
    await expect(askUi.send(panel)).toBeVisible();
    await expect(stop).toHaveCount(0);
  },
);

test(
  'UX12-ASK-AC08 answers drop AI 생성 and 다시 생성; failed and stopped keep 다시 시도, old versions read',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await askWorkspace(workspaceFactory, 'ux12-ask-08');
    await openHome(page, s.owner, s.workspaceId);
    const panel = await openAskPanel(page);
    const done = await ask(panel, QUESTION);
    await waitDone(done);
    await expect(askUi.aiBadge(done)).toHaveCount(0);
    await expect(askUi.regenerate(done)).toHaveCount(0);
    await expect(done.getByText(ASK_TEXT.notice)).toBeVisible();

    const failed = await ask(panel, `${ASK_MARKERS.fail} ${QUESTION}`);
    await waitDone(failed);
    await expect(askUi.retry(failed)).toBeVisible();
    await expect(askUi.regenerate(failed)).toHaveCount(0);

    const stopped = await ask(panel, `${ASK_MARKERS.slow} ${QUESTION}`);
    await expect(askUi.stop(panel)).toBeVisible();
    await askUi.stop(panel).click();
    await expect(stopped).toContainText(ASK_TEXT.stopped, { timeout: ASK_TIMEOUT_MS });
    await expect(askUi.retry(stopped)).toBeVisible();
    await expect(askUi.regenerate(stopped)).toHaveCount(0);

    const { conversation, answer } = await askThroughApi(s.owner, s.workspaceId, QUESTION);
    const again = await messageAction(s.owner, answer.id, 'regenerate');
    expect(again.status).toBeLessThan(300);
    await waitForAnswer(s.owner, (again.body as { answer: { id: string } }).answer.id);
    await page.goto(askPath(s.workspaceId, conversation));
    const latest = askUi.answers(askUi.panel(page)).last();
    await expect(askUi.version(latest, 2, 2)).toBeVisible();
    await expect(askUi.regenerate(latest)).toHaveCount(0);
    await askUi.previousVersion(latest).click();
    await expect(askUi.version(latest, 1, 2)).toBeVisible();
  },
);
