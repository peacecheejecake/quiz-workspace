import {
  askUi,
  openAskPanel,
  seedAskBook,
  createSecretQuestion,
  createConversation,
  askThroughApi,
  getConversation,
  ASK_MARKERS,
  SECRETS,
} from '../fixtures/ask.ts';
import {
  expect,
  homePath,
  homeUi,
  signInAs,
  startPractice,
  seedMembership,
  searchPath,
  test,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test(
  'UX11-AI-DIRECT-AC02 clears a valid question while its request is pending',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-clear');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    await expect(homeUi.questionMenuButton(page)).toBeVisible();
    const panel = await openAskPanel(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted!: () => void;
    const posted = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      intercepted();
      await gate;
      await route.continue();
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('가나다 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await posted;
    await expect(input).toHaveValue('');
    await expect(panel.getByText('가나다 질문')).toBeVisible();
    release();
  },
);

test(
  'UX11-AI-DIRECT-AC03 preserves a new draft after a rejected send',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-failure');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const panel = await openAskPanel(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted!: () => void;
    const posted = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    let calls = 0;
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      calls += 1;
      intercepted();
      await gate;
      await route.fulfill({ status: 503, body: '{}' });
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('첫 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await posted;
    await input.fill('새 질문');
    await input.press('Enter');
    release();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(input).toHaveValue('새 질문');
    await expect(panel.getByRole('group', { name: '보내지 못한 질문' })).toContainText('첫 질문');
    expect(calls).toBe(1);
  },
);

test(
  'UX11-AI-DIRECT-AC01 attachment remains context and does not send a question automatically',
  { tag: '@infra' },
  async ({ workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-context');
    const ws = await workspaceFactory.create(owner);
    const book = await seedAskBook(owner, ws.id);
    const question = await createSecretQuestion(owner, ws.id, book, 3, 'ux11-context');
    const conversation = await createConversation(owner, ws.id, {
      attachment: { kind: 'question', view: 'detail', question_id: question.id },
    });
    expect(conversation.messages).toHaveLength(0);
    await askThroughApi(
      owner,
      ws.id,
      `${ASK_MARKERS.leakProbe} 첫 보기 용어가 무엇인가요?`,
      conversation.id,
    );
    const saved = (await getConversation(owner, conversation.id)).body;
    expect(
      saved?.messages.filter((message) => message.role === 'user').map((message) => message.text),
    ).toEqual([`${ASK_MARKERS.leakProbe} 첫 보기 용어가 무엇인가요?`]);
  },
);

test(
  'UX11-AI-DIRECT-AC04 a pre-submission attachment stays hint-only',
  { tag: '@infra' },
  async ({ workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-hint');
    const ws = await workspaceFactory.create(owner);
    const book = await seedAskBook(owner, ws.id);
    const question = await createSecretQuestion(owner, ws.id, book, 3, 'ux11-hint');
    const session = await startPractice(owner, question.id);
    const conversation = await createConversation(owner, ws.id, {
      attachment: {
        kind: 'question',
        view: 'practice',
        question_id: question.id,
        practice_session_id: session.id,
        selected_option_ids: [],
      },
    });
    const { answer } = await askThroughApi(
      owner,
      ws.id,
      `${ASK_MARKERS.leakProbe} 전체 해설을 해 주세요`,
      conversation.id,
    );
    expect(answer.disclosure).toBe('hint');
    expect(answer.text).not.toContain(SECRETS.explanation);
  },
);

test(
  'UX11-AI-DIRECT-AC03 a rejected pending question survives closing and reopening',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-close');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    let panel = await openAskPanel(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted!: () => void;
    const posted = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      intercepted();
      await gate;
      await route.fulfill({ status: 503, body: '{}' });
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('닫힌 동안 실패한 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await posted;
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    release();
    await page.waitForResponse(
      (response) => response.status() === 503 && response.url().includes('/messages'),
    );
    panel = await openAskPanel(page);
    await expect(panel.getByRole('group', { name: '보내지 못한 질문' })).toContainText(
      '닫힌 동안 실패한 질문',
    );
  },
);

test(
  'UX11-AI-DIRECT-AC03 verifies a changed HttpOnly session before reopening recovery',
  { tag: '@infra' },
  async ({ page, context, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-owner');
    const other = await workspaceFactory.member('ux11-other');
    const ws = await workspaceFactory.create(owner);
    seedMembership(ws.id, other.user.id, 'viewer');
    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    const openSearchAsk = async () => {
      const button = page.getByRole('button', { name: '본문 검색어로 AI에게 묻기' });
      await expect(button).toBeVisible();
      await button.click();
      return askUi.panel(page);
    };
    let panel = await openSearchAsk();
    await page.route('**/api/ask/conversations/*/messages', (route) =>
      route.fulfill({ status: 503, body: '{}' }),
    );
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('사용자 A의 비공개 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await expect(input).toHaveValue('사용자 A의 비공개 질문');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    panel = await openSearchAsk();
    await expect(panel.getByRole('group', { name: '보내지 못한 질문' })).toContainText(
      '사용자 A의 비공개 질문',
    );
    await context.clearCookies();
    let captureIdentity!: (value: { status: number; body: unknown }) => void;
    const signedOutIdentity = new Promise<{ status: number; body: unknown }>((resolve) => {
      captureIdentity = resolve;
    });
    await page.route('**/api/auth/identity', async (route) => {
      const response = await route.fetch();
      captureIdentity({ status: response.status(), body: await response.json() });
      await route.fulfill({ response });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await signedOutIdentity).toEqual({ status: 200, body: { id: null } });
    await page.unroute('**/api/auth/identity');
    await expect(panel.getByText('사용자 A의 비공개 질문')).toHaveCount(0);
    const second = await context.newPage();
    await signInAs(second, other.user);
    await second.close();
    await page.bringToFront();
    await page.goto(searchPath(ws.id));
    panel = await openSearchAsk();
    await expect(panel.getByText('사용자 A의 비공개 질문')).toHaveCount(0);
    await expect(panel.getByRole('group', { name: '보내지 못한 질문' })).toHaveCount(0);
    const otherInput = askUi.input(panel);
    await expect(otherInput).toHaveValue('');
    await otherInput.fill('사용자 B의 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.unroute('**/api/ask/conversations/*/messages');
    const accepted = page.waitForResponse(
      (response) => response.status() === 202 && response.url().includes('/messages'),
    );
    await otherInput.press('Enter');
    await accepted;
  },
);

test(
  'UX11-AI-DIRECT-AC03 a late rejection cannot cross an actual session switch',
  { tag: '@infra' },
  async ({ page, context, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-late-owner');
    const other = await workspaceFactory.member('ux11-late-other');
    const ws = await workspaceFactory.create(owner);
    seedMembership(ws.id, other.user.id, 'viewer');
    await signInAs(page, owner.user);
    await page.goto(searchPath(ws.id));
    const openSearchAsk = async () => {
      const button = page.getByRole('button', { name: '본문 검색어로 AI에게 묻기' });
      await expect(button).toBeVisible();
      await button.click();
      return askUi.panel(page);
    };
    let panel = await openSearchAsk();
    let release!: () => void;
    let intercepted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      intercepted();
      await gate;
      await route.fulfill({ status: 503, body: '{}' });
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('사용자 A의 늦은 실패');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await posted;
    await page.keyboard.press('Escape');
    const second = await context.newPage();
    await context.clearCookies();
    await signInAs(second, other.user);
    await second.close();
    const response = page.waitForResponse(
      (r) => r.status() === 503 && r.url().includes('/messages'),
    );
    release();
    await response;
    panel = await openSearchAsk();
    await expect(panel.getByText('사용자 A의 늦은 실패')).toHaveCount(0);
  },
);

test(
  'UX11-AI-DIRECT-AC03 retains a rejected question through identity service failure',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-identity-outage');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const panel = await openAskPanel(page);
    let release!: () => void;
    let intercepted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      intercepted();
      await gate;
      await route.fulfill({ status: 503, body: '{}' });
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('오프라인 실패 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await posted;
    await input.fill('새 draft');
    await page.route('**/api/auth/identity', (route) => route.fulfill({ status: 503, body: '{}' }));
    release();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(input).toHaveValue('새 draft');
    await expect(panel.getByRole('group', { name: '보내지 못한 질문' })).toHaveCount(0);
    await page.unroute('**/api/auth/identity');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(panel.getByRole('group', { name: '보내지 못한 질문' })).toContainText(
      '오프라인 실패 질문',
    );
    await expect(input).toHaveValue('새 draft');
  },
);

test(
  'UX11-AI-DIRECT-AC04 reconciles an accepted message after identity service recovery',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-receipt');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const panel = await openAskPanel(page);
    let release!: () => void;
    let intercepted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    let posts = 0;
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      posts += 1;
      intercepted();
      await gate;
      await route.continue();
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('수락된 원래 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await posted;
    await page.route('**/api/auth/identity', (route) => route.fulfill({ status: 503, body: '{}' }));
    const identityFailure = page.waitForResponse(
      (r) => r.status() === 503 && r.url().includes('/api/auth/identity'),
    );
    const acceptedResponse = page.waitForResponse(
      (r) => r.status() === 202 && r.url().includes('/messages'),
    );
    release();
    await acceptedResponse;
    await identityFailure;
    await expect.poll(() => posts).toBe(1);
    await page.unroute('**/api/auth/identity');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(askUi.userMessages(panel)).toContainText(['수락된 원래 질문']);
    expect(posts).toBe(1);
  },
);

test(
  'UX11-AI-DIRECT-AC03 reuses the accepted operation after its response is lost and the panel reopens',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-lost-accepted');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    let panel = await openAskPanel(page);
    const keys: string[] = [];
    let firstAnswer = '';
    let replayAnswer = '';
    let firstJob = '';
    let replayJob = '';
    let sentConversation = '';
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      const response = await route.fetch();
      const body = (await response.json()) as {
        answer: { id: string; conversation_id: string };
        job_id: string;
      };
      if (keys.length === 1) {
        firstAnswer = body.answer.id;
        firstJob = body.job_id;
        sentConversation = body.answer.conversation_id;
        await route.abort('failed');
      } else {
        replayAnswer = body.answer.id;
        replayJob = body.job_id;
        await route.fulfill({ response });
      }
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await expect(panel.getByRole('button', { name: '보내기' })).toBeVisible();
    await input.fill('응답이 유실된 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await expect(panel.getByRole('alert')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    panel = await openAskPanel(page);
    const retry = askUi.input(panel);
    await expect(retry).toBeEditable();
    await retry.fill('응답이 유실된 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await retry.press('Enter');
    await expect.poll(() => keys.length).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    await expect.poll(() => replayAnswer).toBe(firstAnswer);
    expect(replayJob).toBe(firstJob);
    const saved = (await getConversation(owner, sentConversation)).body;
    expect(saved?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(saved?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    await expect(askUi.userMessages(panel)).toHaveCount(1);
  },
);

test(
  'UX11-AI-DIRECT-AC04 reconciles a deferred receipt in the reopened same conversation',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-same-receipt');
    const ws = await workspaceFactory.create(owner);
    const conversation = await createConversation(owner, ws.id);
    await askThroughApi(owner, ws.id, '기존 대화 질문', conversation.id);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id, `panel=ask&conversation=${conversation.id}`));
    let panel = askUi.panel(page);
    await expect(panel).toBeVisible();
    let release!: () => void;
    let intercepted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      intercepted();
      await gate;
      await route.continue();
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('늦게 수락된 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await posted;
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    panel = await openAskPanel(page);
    await panel.getByRole('button', { name: '기존 대화 질문', exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('conversation') === conversation.id);
    const draft = askUi.input(panel);
    await expect(draft).toBeEditable();
    await draft.fill('새 draft');
    const acceptedResponse = page.waitForResponse(
      (response) => response.status() === 202 && response.url().includes('/messages'),
    );
    release();
    await acceptedResponse;
    const recovery = panel.getByRole('button', { name: '답변 확인' });
    await expect(recovery).toBeVisible();
    let reads = 0;
    await page.route(`**/api/ask/conversations/${conversation.id}`, async (route) => {
      reads += 1;
      if (reads === 1) await route.fulfill({ status: 503, body: '{}' });
      else await route.continue();
    });
    await recovery.click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(recovery).toBeVisible();
    await expect(draft).toHaveValue('새 draft');
    await recovery.click();
    await expect(recovery).toHaveCount(0);
    await expect(askUi.userMessages(panel)).toContainText(['기존 대화 질문', '늦게 수락된 질문']);
    await expect(draft).toHaveValue('새 draft');
  },
);

test(
  'UX11-AI-DIRECT-AC03 an explicit new conversation does not reuse a lost first send',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux11-distinct-compose');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const panel = await openAskPanel(page);
    const conversations: string[] = [];
    const keys: string[] = [];
    await page.route('**/api/ask/conversations/*/messages', async (route) => {
      conversations.push(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (keys.length === 1) {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    const input = askUi.input(panel);
    await expect(input).toBeEditable();
    await input.fill('첫 번째 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await expect(panel.getByRole('alert')).toBeVisible();
    await panel.getByRole('button', { name: '새 대화' }).click();
    await input.fill('다른 질문');
    await expect(panel.getByRole('button', { name: '보내기' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await input.press('Enter');
    await expect.poll(() => keys.length).toBe(2);
    expect(conversations[1]).not.toBe(conversations[0]);
    expect(keys[1]).not.toBe(keys[0]);
  },
);
