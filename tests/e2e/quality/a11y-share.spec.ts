// M7.2 accessibility of the sharing surfaces (WS-SHARE-01, WS-VIEW-01, WS-FORK-01): axe in the
// light and dark theme (fixtures/a11y.ts). Share secrets appear on screen and in URLs, so this
// spec follows the sharing artifact rules: no trace/screenshot/video, secrets registered for
// `pnpm e2e:artifact-audit` (fixtures/sharing.ts header).
import type { Page } from '@playwright/test';
import { expectAccessible } from '../fixtures/a11y.ts';
import {
  createQuestion,
  JOB_TIMEOUT_MS,
  mcqInput,
  signInAs,
  snippet,
  uniqueWorkspaceName,
} from '../fixtures/test.ts';
import {
  createShareLink,
  expect,
  expectFragmentRemoved,
  FORK_FAILURE_MARKER,
  FORK_TIMEOUT_MS,
  forkUi,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  PUBLISHED_BLOCK,
  revokeShareLink,
  seedSharedContent,
  sharedUi,
  sharingSettingsPath,
  sharingUi,
  ShareSession,
  test,
} from '../fixtures/sharing.ts';

test.use(NO_VISUAL_ARTIFACTS);
test.describe.configure({ timeout: JOB_TIMEOUT_MS + 2 * FORK_TIMEOUT_MS + 60_000 });

async function openShare(page: Page, id: string, secret: string): Promise<void> {
  await openShareWithSecret(page, id, secret);
  await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
  await expectFragmentRemoved(page, id);
}

test(
  'A11Y-07 owner sharing settings: off, one-time link, confirmation dialog',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y07');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('a11y07'));
    await signInAs(page, owner.user);
    await page.goto(sharingSettingsPath(ws.id));
    await expect(sharingUi.offStatus(page)).toBeVisible();
    await expectAccessible(page, 'sharing off');

    await sharingUi.createButton(page).click();
    await expect(sharingUi.linkField(page)).toBeVisible();
    await expect(sharingUi.onceNotice(page)).toBeVisible();
    await expectAccessible(page, 'one-time link shown');

    await sharingUi.revokeButton(page).click();
    await expect(sharingUi.confirmDialog(page)).toBeVisible();
    await expectAccessible(page, 'revoke confirmation');
    await sharingUi.confirmButton(sharingUi.confirmDialog(page)).click();
    await expect(sharingUi.revokedStatus(page).or(sharingUi.offStatus(page)).first()).toBeVisible();
    await expectAccessible(page, 'link revoked');
  },
);

test(
  'A11Y-08 guest shared view: outline, document, search, question panel, unavailable link',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y08');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('a11y08'));
    const link = await createShareLink(owner, ws.id, { allow_fork: true });
    await seedSharedContent(owner, ws.id);
    const q = await createQuestion(owner, ws.id, {
      ...mcqInput('E2E 접근성 공유 문제', ['가', '나', '다', '라'], 1),
      explanation: 'E2E 접근성 해설',
    });

    await openShare(page, link.id, link.secret);
    await expect(sharedUi.questions(page)).toBeVisible();
    await expectAccessible(page, 'shared view');

    await sharedUi.question(page, q.revision.stem).click();
    await expect(sharedUi.questionPanel(page)).toBeVisible();
    await expectAccessible(page, 'shared question panel');
    await sharedUi
      .questionPanel(page)
      .getByRole('button', { name: /패널 닫기|^닫기$|^close/i })
      .click();
    await expect(sharedUi.questionPanel(page)).toHaveCount(0);

    const session = await ShareSession.open(link.id, link.secret);
    const [doc] = (await session.workspace()).documents;
    await sharedUi.documentLink(page, doc?.title ?? '?').click();
    await expect(sharedUi.pdfViewer(page)).toBeVisible();
    await expect(page.getByText(snippet(PUBLISHED_BLOCK.text)).first()).toBeVisible();
    await expectAccessible(page, 'shared document');

    await sharedUi.searchBox(page).fill(snippet(PUBLISHED_BLOCK.text, 12));
    await sharedUi.searchBox(page).press('Enter');
    await expect(sharedUi.results(page).getByRole('listitem').first()).toBeVisible();
    await expectAccessible(page, 'shared search results');

    await revokeShareLink(owner, ws.id, link.id);
    await page.reload();
    await expect(sharedUi.unavailable(page)).toBeVisible();
    await expectAccessible(page, 'revoked link');
  },
);

test(
  'A11Y-09 fork dialog for a signed-in recipient: form, progress/done, failure',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('a11y09');
    const recipient = await workspaceFactory.member('a11y09-recipient');
    const ws = await workspaceFactory.create(owner, uniqueWorkspaceName('a11y09'));
    const link = await createShareLink(owner, ws.id, { allow_fork: true });

    await signInAs(page, recipient.user);
    await openShare(page, link.id, link.secret);
    await sharedUi.forkButton(page).click();
    let dialog = forkUi.dialog(page);
    await expect(dialog).toBeVisible();
    await expectAccessible(page, 'fork dialog');
    await forkUi.nameField(dialog).fill('');
    await forkUi
      .submit(dialog)
      .click()
      .catch(() => undefined);
    await expectAccessible(page, 'fork dialog without a name');

    await forkUi.nameField(dialog).fill('E2E a11y fork');
    await forkUi.submit(dialog).click();
    await expect(forkUi.done(page)).toBeVisible({ timeout: FORK_TIMEOUT_MS });
    await expectAccessible(page, 'fork completed');

    await openShare(page, link.id, link.secret);
    await sharedUi.forkButton(page).click();
    dialog = forkUi.dialog(page);
    await forkUi.nameField(dialog).fill(`E2E ${FORK_FAILURE_MARKER}`);
    await forkUi.submit(dialog).click();
    await expect(forkUi.alert(page)).toBeVisible({ timeout: FORK_TIMEOUT_MS });
    await expectAccessible(page, 'fork failed with retry');
  },
);
