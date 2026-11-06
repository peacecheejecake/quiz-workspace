// UX12-CHAPTERRUN (docs/screens/ux12-chapter-run.md): a Heatmap chapter's 풀기 starts a bank run of
// the whole chapter after two options, with no range step and no saved mock exam. Contract half:
// tests/integration/questions/practice_runs (UX12-CHAPTERRUN-C03).
import type { Locator, Page, Request } from '@playwright/test';
import {
  CH1,
  CH2,
  getPracticeRun,
  goToResults,
  practiceParam,
  practiceRunCount,
  questionAttemptCount,
  rangeStem,
  runOrder,
  runUi,
  seedRangeWorkspace,
  type PracticeRun,
  type RangeWorkspace,
} from '../fixtures/practice-runs.ts';
import {
  createQuestion,
  expect,
  main,
  numberedMcq,
  overviewPath,
  overviewUi,
  RESULT_TEXT,
  signInAs,
  test,
  type Member,
  type Question,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

/** Option order of positions 1 and 2 under PRACTICE_RUN_TEST_SEED, four options each. */
const SEEDED_OPTIONS = {
  1: [2, 0, 1, 3],
  2: [3, 0, 2, 1],
} as const;
/** Positions of a three-question chapter under PRACTICE_RUN_TEST_SEED. */
const SEEDED_ORDER_3 = [2, 1, 3] as const;

const chapterPlay = (page: Page, title: string) =>
  main(page).getByRole('button', { name: new RegExp(`^${title} (풀기|practi[sc]e)$`, 'i') });
const dialogOf = (page: Page, title: string) =>
  page.getByRole('dialog', { name: new RegExp(`^${title} (풀기|practi[sc]e)$`, 'i') });
const shuffle = (dialog: Locator) =>
  dialog.getByRole('checkbox', { name: /^(보기 섞기|shuffle options)$/i });
const random = (dialog: Locator) =>
  dialog.getByRole('checkbox', { name: /^(문제 순서 무작위|random order)$/i });
const cancel = (dialog: Locator) => dialog.getByRole('button', { name: /^(취소|cancel)$/i });
const start = (dialog: Locator) => dialog.getByRole('button', { name: /^(시작|start)$/i });

const isRunRequest = (request: Request) =>
  request.method() === 'POST' && /\/practice-runs$/.test(new URL(request.url()).pathname);

async function home(page: Page, member: Member, workspaceId: string, query = ''): Promise<void> {
  await page.context().clearCookies();
  await signInAs(page, member.user);
  await page.goto(`${overviewPath(workspaceId)}${query}`);
}

async function readRun(member: Member, page: Page): Promise<PracticeRun> {
  const res = await getPracticeRun(member, practiceParam(page) ?? '');
  if (!res.body) throw new Error('no run');
  return res.body;
}

/** Starts a chapter run; returns the request's body and the run. */
async function startRun(
  page: Page,
  member: Member,
  title: string,
  options: { shuffle?: boolean; random?: boolean } = {},
): Promise<{ body: Record<string, unknown>; run: PracticeRun; panel: Locator }> {
  await chapterPlay(page, title).click();
  const dialog = dialogOf(page, title);
  await expect(dialog).toBeVisible();
  if (options.shuffle) await shuffle(dialog).check();
  if (options.random) await random(dialog).check();
  const request = page.waitForRequest(isRunRequest);
  await start(dialog).click();
  const body = (await request).postDataJSON() as Record<string, unknown>;
  const panel = runUi.panel(page);
  await expect(panel).toBeVisible();
  await expect.poll(() => practiceParam(page)).not.toBeNull();
  return { body, run: await readRun(member, page), panel };
}

/** The option texts in their on-screen order, top to bottom. */
async function shownOrder(panel: Locator, question: Question): Promise<string[]> {
  const texts = question.revision.options.map((o) => o.text);
  const rows = await Promise.all(
    texts.map(async (text) => {
      const box = await runUi.option(panel, text).boundingBox();
      if (!box) throw new Error(`no option ${text}`);
      return { text, y: box.y };
    }),
  );
  return rows.sort((a, b) => a.y - b.y).map((row) => row.text);
}

function seededTexts(question: Question, position: 1 | 2): string[] {
  const texts = question.revision.options.map((o) => o.text);
  return SEEDED_OPTIONS[position].map((i) => texts[i] ?? '');
}

function nth(s: RangeWorkspace, index: number): Question {
  const question = s.confirmed[index];
  if (!question) throw new Error(`no question ${index}`);
  return question;
}

test(
  'UX12-CHAPTERRUN-AC01 every chapter on the Heatmap has its own 풀기, 챕터 없음 too',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-01', { studyState: false });
    await createQuestion(s.owner, s.workspaceId, numberedMcq('ux12-chrun-none', 9));
    await home(page, s.owner, s.workspaceId);
    for (const title of [CH1, CH2, '챕터 없음']) {
      await expect(chapterPlay(page, title)).toHaveText(/^\s*풀기\s*$/);
    }
    await expect(main(page).getByRole('button', { name: /^(.+ )?풀기$/ })).toHaveCount(3);
    await chapterPlay(page, '챕터 없음').click();
    const dialog = dialogOf(page, '챕터 없음');
    const request = page.waitForRequest(isRunRequest);
    await start(dialog).click();
    expect((await request).postDataJSON().range).toEqual({ chapter_ids: ['none'] });
  },
);

test.describe('375px', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test(
    'UX12-CHAPTERRUN-AC01 the button fits at 375px beside 정리 노트 with the dots in place',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-01m', { studyState: false });
      await home(page, s.owner, s.workspaceId);
      const play = await chapterPlay(page, CH1).boundingBox();
      const note = await main(page)
        .getByRole('button', { name: new RegExp(`^${CH1} 정리 노트$`) })
        .boundingBox();
      const heading = await main(page).getByRole('heading', { name: CH1 }).boundingBox();
      const dot = await overviewUi.markers(page).first().boundingBox();
      if (!play || !note || !heading || !dot) throw new Error('no header');
      expect(Math.abs(play.y - note.y)).toBeLessThan(1);
      expect(Math.abs(play.y + play.height / 2 - (heading.y + heading.height / 2))).toBeLessThan(2);
      expect(play.y + play.height).toBeLessThanOrEqual(dot.y);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    },
  );
});

test(
  'UX12-CHAPTERRUN-AC02 only two options, off; close, 취소 and Escape create nothing',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-02', { studyState: false });
    await home(page, s.owner, s.workspaceId);
    const before = practiceRunCount(s.owner.user.id);
    const opener = chapterPlay(page, CH1);
    await opener.click();
    const dialog = dialogOf(page, CH1);
    await expect(shuffle(dialog)).not.toBeChecked();
    await expect(random(dialog)).not.toBeChecked();
    await expect(dialog.getByRole('checkbox')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: /모의고사 목록|mock exam list/i })).toHaveCount(
      0,
    );
    await expect(dialog.getByRole('checkbox', { name: /전체 선택|select all/i })).toHaveCount(0);

    await shuffle(dialog).check();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await expect(shuffle(dialog)).not.toBeChecked();
    await cancel(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await dialog.getByRole('button', { name: /^(닫기|close)$/i }).click();
    await expect(dialog).toBeHidden();

    expect(practiceRunCount(s.owner.user.id)).toBe(before);
    expect(practiceParam(page)).toBeNull();
  },
);

test(
  'UX12-CHAPTERRUN-AC03 the run covers the whole chapter whatever the home filters show',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-03');
    // The viewer's 틀림 filter keeps 1장 2번 and 2장 2번: one dot of the three in 1장.
    await home(page, s.viewer, s.workspaceId, '?status=incorrect');
    await expect(overviewUi.markers(page)).toHaveCount(2);
    const { body, run } = await startRun(page, s.viewer, CH1);
    expect(body.range).toEqual({ chapter_ids: [s.ch1] });
    expect(body.source).toBe('bank');
    expect(run.total).toBe(3);
    expect(run.source).toBe('bank');
    expect(await runOrder(s.viewer, run.id, 3)).toEqual([0, 1, 2].map((i) => nth(s, i).id));
    const mocks = await s.owner.api.ok<{ items: unknown[] }>(
      'GET',
      `/workspaces/${s.workspaceId}/mock-exams`,
      undefined,
      [200],
    );
    expect(mocks.items).toHaveLength(0);
  },
);

test(
  'UX12-CHAPTERRUN-AC04 a viewer solves in the usual panel; close and Back return to the button',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-04', { studyState: false });
    await home(page, s.viewer, s.workspaceId);
    const attempts = questionAttemptCount(s.workspaceId);
    const { panel, run } = await startRun(page, s.viewer, CH2);
    expect(run.shuffle_options).toBe(false);
    expect(run.random_order).toBe(false);
    await expect(page).toHaveURL(new RegExp(`practice=${run.id}&i=1`));
    await expect(runUi.title(panel, 1)).toBeFocused();
    await runUi.option(panel, nth(s, 3).revision.options[0]?.text ?? '').check();
    await runUi.submit(panel).click();
    await expect(runUi.result(panel)).toContainText(RESULT_TEXT.correct);
    expect(questionAttemptCount(s.workspaceId)).toBe(attempts + 1);

    await runUi.close(panel).click();
    await expect(panel).toBeHidden();
    await expect(chapterPlay(page, CH2)).toBeFocused();

    await startRun(page, s.viewer, CH1);
    await page.goBack();
    await expect(runUi.panel(page)).toBeHidden();
    await expect(chapterPlay(page, CH1)).toBeFocused();
  },
);

test(
  'UX12-CHAPTERRUN-AC04 an archived workspace starts the run without a submit',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-04a', { studyState: false });
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await home(page, s.owner, s.workspaceId);
    const { panel } = await startRun(page, s.owner, CH1, { shuffle: true });
    await expect(runUi.title(panel, 1)).toBeVisible();
    await expect(runUi.archivedNotice(panel)).toBeVisible();
    await expect(runUi.submit(panel)).toHaveCount(0);
    expect(await shownOrder(panel, nth(s, 0))).toEqual(seededTexts(nth(s, 0), 1));
  },
);

test(
  'UX12-CHAPTERRUN-AC05 문제 순서 무작위 uses the seeded order',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-05', { studyState: false });
    await home(page, s.owner, s.workspaceId);
    const { body, run, panel } = await startRun(page, s.owner, CH1, { random: true });
    expect(body.random_order).toBe(true);
    expect(body.shuffle_options).toBeUndefined();
    expect(await runOrder(s.owner, run.id, 3)).toEqual(SEEDED_ORDER_3.map((n) => nth(s, n - 1).id));
    await expect(panel).toContainText(rangeStem(s.label, 1, SEEDED_ORDER_3[0]).slice(0, 30));
  },
);

test(
  'UX12-CHAPTERRUN-AC06 보기 섞기 keeps one order per position and grades by option id',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-06', { studyState: false });
    await home(page, s.viewer, s.workspaceId);
    const first = nth(s, 0);
    const second = nth(s, 1);
    const { body, run, panel } = await startRun(page, s.viewer, CH1, { shuffle: true });
    expect(body.shuffle_options).toBe(true);
    expect(run.shuffle_options).toBe(true);

    const expected = seededTexts(first, 1);
    expect(expected).not.toEqual(first.revision.options.map((o) => o.text));
    await expect(runUi.title(panel, 1)).toBeVisible();
    expect(await shownOrder(panel, first)).toEqual(expected);

    await page.reload();
    await expect(runUi.title(runUi.panel(page), 1)).toBeVisible();
    expect(await shownOrder(runUi.panel(page), first)).toEqual(expected);

    await runUi.next(runUi.panel(page)).click();
    await expect(runUi.title(runUi.panel(page), 2)).toBeVisible();
    expect(await shownOrder(runUi.panel(page), second)).toEqual(seededTexts(second, 2));
    await runUi.previous(runUi.panel(page)).click();
    await expect(runUi.title(runUi.panel(page), 1)).toBeVisible();
    expect(await shownOrder(runUi.panel(page), first)).toEqual(expected);

    // Option 1 of the stored question is the answer, wherever it is shown now.
    const answer = first.revision.options[0]?.text ?? '';
    await runUi.option(runUi.panel(page), answer).check();
    await runUi.submit(runUi.panel(page)).click();
    await expect(runUi.result(runUi.panel(page))).toContainText(RESULT_TEXT.correct);
    expect(await shownOrder(runUi.panel(page), first)).toEqual(expected);
  },
);

test(
  'UX12-CHAPTERRUN-AC07 처음부터 다시 keeps both settings',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await seedRangeWorkspace(workspaceFactory, 'ux12-chrun-07', { studyState: false });
    await home(page, s.owner, s.workspaceId);
    const { run, panel } = await startRun(page, s.owner, CH2, { shuffle: true, random: true });
    await goToResults(panel, run.total);
    const request = page.waitForRequest(isRunRequest);
    await runUi.restart(panel).click();
    const body = (await request).postDataJSON() as Record<string, unknown>;
    expect(body.shuffle_options).toBe(true);
    expect(body.random_order).toBe(true);
    await expect.poll(() => practiceParam(page)).not.toBe(run.id);
    const again = await readRun(s.owner, page);
    expect(again.shuffle_options).toBe(true);
    expect(again.random_order).toBe(true);
  },
);
