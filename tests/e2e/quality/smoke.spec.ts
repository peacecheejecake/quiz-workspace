// M7.2 WebKit + mobile smoke (docs/e2e-strategy.md §3: WebKit/iPad main flows + Mobile Chrome
// smoke): the key flows on `smoke-ipad-webkit`, `smoke-iphone-webkit` and `smoke-mobile-chrome`
// with touch input — sign-in, workspace creation, opening it from the list, PDF upload to READY in
// the 문서 관리 dialog, the header's unified search with the excerpt panel, heatmap tap → practice panel → graded answer, and the guest shared view.
// Every state also gets a light-theme axe scan at the device's viewport (fixtures/a11y.ts).
// Desktop WebKit runs every AC spec already (authenticated-webkit / unauthenticated-webkit).
import { expectAccessible } from '../fixtures/a11y.ts';
import {
  authUi,
  block,
  book,
  createNumberedQuestions,
  docUi,
  homeUi,
  JOB_TIMEOUT_MS,
  overviewPath,
  overviewUi,
  panelUi,
  PDF_DIR,
  RESULT_TEXT,
  runSearch,
  searchUi,
  signInAs,
  snippet,
  wsUi,
} from '../fixtures/test.ts';
import {
  createShareLink,
  expect,
  expectFragmentRemoved,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  seedSharedContent,
  sharedUi,
  test,
} from '../fixtures/sharing.ts';

test.use(NO_VISUAL_ARTIFACTS);
test.describe.configure({ timeout: JOB_TIMEOUT_MS + 90_000 });

const LIGHT = { schemes: ['light'] } as const;
const BOOK = book('book-ko');

test(
  'SMOKE-01 sign in, create a workspace, upload a PDF to READY and search it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('smoke01');
    await signInAs(page, owner.user);
    await expect(wsUi.emptyState(page)).toBeVisible();
    await expectAccessible(page, 'workspaces empty', LIGHT);

    await wsUi.createButton(page).tap();
    const dialog = wsUi.createDialog(page);
    await wsUi.nameField(dialog).fill('모바일 스모크');
    await wsUi.submitCreate(dialog).tap();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await workspaceFactory.list(owner)).length).toBe(1);
    const [created] = await workspaceFactory.list(owner);
    const workspaceId = created?.id ?? '';
    expect(created?.name).toBe('모바일 스모크');

    // The workspace opens from the list on its home (no workspace sidebar since UX3c).
    await wsUi
      .item(wsUi.tabPanel(page), '모바일 스모크')
      .getByRole('link', { name: '모바일 스모크' })
      .tap();
    await expect(page).toHaveURL((url) => url.pathname === `/workspaces/${workspaceId}`);
    await expect(homeUi.header(page)).toBeVisible();
    await expectAccessible(page, 'workspace home', LIGHT);

    await homeUi.documentsButton(page).tap();
    const documents = homeUi.documentsDialog(page);
    await expect(documents).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await docUi.uploadButton(page).tap();
    await (await chooser).setFiles(`${PDF_DIR}/${BOOK.file}`);
    const row = docUi.item(page, /book-ko|물의 순환과 정수 처리/);
    await expect(docUi.ready(row)).toBeVisible({ timeout: JOB_TIMEOUT_MS });
    await expectAccessible(page, 'documents ready', LIGHT);
    await documents.getByRole('button', { name: /문서 관리 닫기|close/i }).tap();
    await expect(documents).toHaveCount(0);

    await expect(searchUi.box(page)).toBeVisible();
    const target = block(BOOK, 'ch1-s2-p1');
    await runSearch(page, snippet(target.text, 10), 'keyword');
    const hit = searchUi.resultItems(page).first();
    await expect(hit).toBeVisible();
    await hit.getByRole('button').first().tap();
    const panel = searchUi.excerptPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(snippet(target.text, 10));
    await expectAccessible(page, 'search excerpt panel', LIGHT);
  },
);

test(
  'SMOKE-02 tap a heatmap dot, answer in the practice panel and close it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('smoke02');
    const ws = await workspaceFactory.create(owner);
    const [first] = await createNumberedQuestions(owner, ws.id, 'smoke02', 6);
    if (!first) throw new Error('no question');
    await signInAs(page, owner.user);
    await page.goto(overviewPath(ws.id));
    await expect(overviewUi.dots(page)).toHaveCount(6);
    const dot = overviewUi.dot(page, 1);
    // Touch targets: 32px cells on touch/mobile, markers ≤ 1/3 of their width apart (design-system.md §6).
    expect(await dot.boundingBox()).toMatchObject({ width: 32, height: 32 });
    const [a, b] = await Promise.all(
      [1, 2].map((n) =>
        overviewUi.marker(overviewUi.dot(page, n)).locator('rect, path').boundingBox(),
      ),
    );
    expect(a && b && b.x - (a.x + a.width) <= a.width / 3).toBe(true);
    // A long workspace name truncates in the mobile header: it neither overlaps the account
    // button nor widens the page (mobile browsers then zoom out and fixed panels overflow).
    const switcher = await page.getByRole('button', { name: /workspace 전환/i }).boundingBox();
    const account = await authUi.accountButton(page).boundingBox();
    expect(switcher && account && switcher.x + switcher.width <= account.x).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectAccessible(page, 'questions overview', LIGHT);

    await dot.tap();
    const panel = panelUi.numbered(page, 1);
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width + 1).toBe(true);
    await expectAccessible(page, 'practice panel', LIGHT);
    const correct = first.revision.options.find((o) =>
      first.revision.correct_option_ids?.includes(o.id),
    );
    await panelUi.option(panel, correct?.text ?? '').tap();
    await panelUi.submit(panel).tap();
    await expect(panelUi.result(panel)).toContainText(RESULT_TEXT.correct);
    await panelUi.close(panel).tap();
    await expect(panel).toHaveCount(0);
    await expect(dot).toBeFocused();
    await expect(overviewUi.marker(dot)).toHaveAttribute('data-status', 'correct');
  },
);

test(
  'SMOKE-03 a guest opens a share link and reads a document and a question',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('smoke03');
    const ws = await workspaceFactory.create(owner, '모바일 공유');
    const link = await createShareLink(owner, ws.id);
    const content = await seedSharedContent(owner, ws.id);

    await openShareWithSecret(page, link.id, link.secret);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    await expectFragmentRemoved(page, link.id);
    await expectAccessible(page, 'shared view', LIGHT);

    const stem = content.questions[0]?.revision.stem ?? '?';
    await sharedUi.question(page, stem).tap();
    const panel = sharedUi.questionPanel(page);
    await expect(panel).toBeVisible();
    await expect(sharedUi.forbiddenControls(page)).toHaveCount(0);
    await expectAccessible(page, 'shared question panel', LIGHT);
  },
);
