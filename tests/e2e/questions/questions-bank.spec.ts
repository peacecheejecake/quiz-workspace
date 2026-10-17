// QBANK-01 — 문제은행 목록·편집 (`/workspaces/:workspaceId/questions/bank`),
// docs/screens/questions-bank.md; domain rules docs/questions.md §1, §2, §4.
//
// Each test signs in its own owner and works in its own workspace (public API). Questions are
// created through the UI form or the public question API (fixtures/questions.ts, whose header
// lists every endpoint/label assumption). Chapters are outline nodes of the synthetic book-ko.pdf
// uploaded through the public flow. Server outcomes follow implementation-plan §7: foreign or
// unknown question → 404 with one body; viewer write → 403 insufficient-role; archived write →
// 403 workspace-archived. The one superuser seed is a graded attempt for AC03 (practice API: M5).
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  attemptRevision,
  bankPath,
  bankUi,
  book,
  chooseFilter,
  createQuestion,
  expect,
  fillMcq,
  getQuestion,
  JOB_TIMEOUT_MS,
  listQuestions,
  mcqInput,
  notFoundHeading,
  outlineNodeId,
  pageLabel,
  PROBLEM_TYPES,
  questionFormUi,
  section,
  seedGradedAttempt,
  seedMembership,
  signInAs,
  test,
  uploadReadyBook,
  type ApiResponse,
  type Member,
  type Problem,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const BOOK = book('book-ko');
const CH1 = section(BOOK, 'ch1'); // "1장 물의 순환"
const CH2 = section(BOOK, 'ch2'); // "2장 정수 처리"
const RANDOM_ID = '00000000-0000-4000-8000-000000000000';

function stable(res: ApiResponse): Partial<Problem> {
  const { type, title, status, detail } = (res.body ?? {}) as Problem;
  return { type, title, status, detail };
}

async function openBank(page: Page, member: Member, workspaceId: string): Promise<void> {
  await signInAs(page, member.user);
  await page.goto(bankPath(workspaceId));
}

/** Unique, searchable stem so parallel tests never match each other's questions. */
function stem(text: string): string {
  return `${text} [${randomUUID().slice(0, 8)}]`;
}

test(
  'QBANK-01-AC01 an empty bank shows the empty state with direct-create and PDF-import actions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qbank01-ac01');
    const ws = await workspaceFactory.create(owner);
    expect(await listQuestions(owner, ws.id)).toEqual([]);

    await openBank(page, owner, ws.id);
    await expect(bankUi.heading(page)).toHaveText(/문제\s?은행|question bank/i);
    await expect(bankUi.emptyState(page)).toBeVisible();
    await expect(bankUi.items(page)).toHaveCount(0);
    await expect(bankUi.createButton(page)).toBeEnabled();
    await expect(bankUi.importLink(page)).toBeVisible();

    await bankUi.createButton(page).click();
    await expect(questionFormUi.form(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(questionFormUi.form(page)).toBeHidden();

    await bankUi.importLink(page).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${ws.id}/questions/import$`));
  },
);

test(
  'QBANK-01-AC02 saving a valid MCQ confirms it and lists it under its chapter',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 60_000);
    const owner = await workspaceFactory.member('qbank01-ac02');
    const ws = await workspaceFactory.create(owner);
    expect(await listQuestions(owner, ws.id)).toEqual([]);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const chapterId = await outlineNodeId(owner, documentId, CH1.title);

    await openBank(page, owner, ws.id);
    const text = stem('물이 액체에서 기체로 변하는 과정은?');
    const options = ['응결', '증발', '강수', '침전'];

    // Invalid first: an MCQ without a correct option is refused and nothing is saved.
    await bankUi.createButton(page).click();
    const form = await fillMcq(page, text, options, 0);
    await questionFormUi.save(form).click();
    await expect(questionFormUi.alert(form)).toContainText(/정답|correct/i);
    expect(await listQuestions(owner, ws.id)).toEqual([]);

    await questionFormUi.correct(form, 2).check();
    await chooseFilter(page, questionFormUi.chapter(form), new RegExp(CH1.title));
    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();

    const group = bankUi.chapterGroup(page, new RegExp(CH1.title));
    await expect(group.getByRole('listitem').filter({ hasText: text })).toBeVisible();
    await expect(bankUi.emptyState(page)).toHaveCount(0);

    // Server: one CONFIRMED MCQ in that chapter, answer recorded as the stable id of "증발".
    const [saved, ...rest] = await listQuestions(owner, ws.id);
    expect(rest).toEqual([]);
    expect(saved).toMatchObject({
      question_type: 'MCQ',
      publication_status: 'CONFIRMED',
      chapter_id: chapterId,
    });
    const rev = saved?.revision;
    expect(rev?.stem).toBe(text);
    expect(rev?.options.map((o) => o.text)).toEqual(options);
    expect(new Set(rev?.options.map((o) => o.id)).size).toBe(options.length);
    const evaporation = rev?.options.find((o) => o.text === '증발');
    expect(evaporation).toBeDefined();
    expect(rev?.correct_option_ids).toEqual([evaporation?.id]);

    await page.reload();
    await expect(group.getByRole('listitem').filter({ hasText: text })).toBeVisible();
  },
);

test(
  'QBANK-01-AC02 short-answer and essay questions are listed by chapter, searchable, filterable and linked to their source page',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 60_000);
    const owner = await workspaceFactory.member('qbank01-ac02-types');
    const ws = await workspaceFactory.create(owner);
    expect(await listQuestions(owner, ws.id)).toEqual([]);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    const ch1 = await outlineNodeId(owner, documentId, CH1.title);
    const ch2 = await outlineNodeId(owner, documentId, CH2.title);

    const mcq = await createQuestion(owner, ws.id, {
      ...mcqInput(stem('증발에 해당하는 것은?'), ['응결', '증발', '강수', '침전'], 1),
      chapter_id: ch1,
    });
    const short = await createQuestion(owner, ws.id, {
      question_type: 'SHORT_ANSWER',
      stem: stem('모래와 자갈로 입자를 걸러 내는 단계는?'),
      accepted_answers: ['여과'],
      chapter_id: ch2,
      sources: [{ document_id: documentId, page_start: 4, page_end: 4 }],
    });
    const essay = await createQuestion(owner, ws.id, {
      question_type: 'ESSAY',
      stem: stem('도시화가 유출량에 미치는 영향을 서술하시오.'),
      rubric: '침투 감소와 유출 증가를 함께 설명한다.',
    });
    expect([mcq, short, essay].map((q) => q.publication_status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
      'CONFIRMED',
    ]);

    await openBank(page, owner, ws.id);
    await expect(bankUi.items(page)).toHaveCount(3);
    const g1 = bankUi.chapterGroup(page, new RegExp(CH1.title));
    const g2 = bankUi.chapterGroup(page, new RegExp(CH2.title));
    await expect(g1.getByRole('listitem').filter({ hasText: mcq.revision.stem })).toBeVisible();
    await expect(g2.getByRole('listitem').filter({ hasText: short.revision.stem })).toBeVisible();
    await expect(
      bankUi.noChapterGroup(page).getByRole('listitem').filter({ hasText: essay.revision.stem }),
    ).toBeVisible();

    // Source: the short-answer question links to page 4 of the book in the document viewer.
    const source = bankUi.item(page, short.revision.stem).getByRole('link', { name: pageLabel(4) });
    await expect(source).toHaveAttribute(
      'href',
      new RegExp(`/workspaces/${ws.id}/documents/${documentId}`),
    );

    // Search, type filter and chapter filter narrow the list (and agree with the API).
    await bankUi.search(page).fill('자갈');
    await bankUi.search(page).press('Enter');
    await expect(bankUi.items(page)).toHaveCount(1);
    await expect(bankUi.item(page, short.revision.stem)).toBeVisible();
    await bankUi.search(page).fill('');
    await bankUi.search(page).press('Enter');
    await expect(bankUi.items(page)).toHaveCount(3);

    await chooseFilter(page, bankUi.typeFilter(page), /서술형|essay/i);
    await expect(bankUi.items(page)).toHaveCount(1);
    await expect(bankUi.item(page, essay.revision.stem)).toBeVisible();
    await chooseFilter(page, bankUi.typeFilter(page), /전체|모든|all/i);

    await chooseFilter(page, bankUi.chapterFilter(page), new RegExp(CH2.title));
    await expect(bankUi.items(page)).toHaveCount(1);
    await expect(bankUi.item(page, short.revision.stem)).toBeVisible();

    expect((await listQuestions(owner, ws.id, 'q=자갈')).map((q) => q.id)).toEqual([short.id]);
    expect((await listQuestions(owner, ws.id, 'question_type=ESSAY')).map((q) => q.id)).toEqual([
      essay.id,
    ]);
    expect((await listQuestions(owner, ws.id, `chapter_id=${ch1}`)).map((q) => q.id)).toEqual([
      mcq.id,
    ]);
  },
);

test(
  'QBANK-01-AC03 editing creates a new revision, keeps option ids and leaves past attempts on the old revision',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qbank01-ac03');
    const ws = await workspaceFactory.create(owner);
    const original = stem('염소 소독의 주된 목적은?');
    const created = await createQuestion(
      owner,
      ws.id,
      mcqInput(
        original,
        ['색을 진하게 한다', '미생물을 줄인다', '온도를 높인다', '침전을 늘린다'],
        1,
      ),
    );
    const v1 = created.revision;
    expect(v1.version).toBe(1);
    // A graded attempt that already exists on revision 1 (practice API arrives in M5).
    const attemptId = seedGradedAttempt(ws.id, created.id, v1.id, owner.user.id);

    await openBank(page, owner, ws.id);
    await bankUi.editButton(bankUi.item(page, original)).click();
    const form = questionFormUi.form(page);
    await expect(questionFormUi.stem(form)).toHaveValue(original);
    const edited = stem('염소 소독을 하는 가장 중요한 이유는?');
    await questionFormUi.stem(form).fill(edited);
    await questionFormUi.option(form, 3).fill('물의 온도를 높인다');
    await questionFormUi.save(form).click();
    await expect(form).toBeHidden();
    await expect(bankUi.item(page, edited)).toBeVisible();
    await expect(bankUi.item(page, original)).toHaveCount(0);

    const after = await getQuestion(owner, created.id);
    expect(after.revision.version).toBe(2);
    expect(after.revision.id).not.toBe(v1.id);
    expect(after.revision.stem).toBe(edited);
    // Option ids are stable across the edit; only the text of option 3 changed.
    expect(after.revision.options.map((o) => o.id)).toEqual(v1.options.map((o) => o.id));
    expect(after.revision.options[2]?.text).toBe('물의 온도를 높인다');
    expect(after.revision.correct_option_ids).toEqual(v1.correct_option_ids);
    // The earlier attempt still points at revision 1 with its original text.
    expect(attemptRevision(attemptId)).toEqual({ revisionId: v1.id, version: 1, stem: original });
  },
);

test(
  "QBANK-01-AC04 the server blocks reading or editing another user's question by id",
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const alice = await workspaceFactory.member('qbank01-ac04-alice');
    const mallory = await workspaceFactory.member('qbank01-ac04-mallory');
    const aliceWs = await workspaceFactory.create(alice);
    const malloryWs = await workspaceFactory.create(mallory);
    const secret = stem('앨리스만 볼 수 있는 문제');
    const question = await createQuestion(
      alice,
      aliceWs.id,
      mcqInput(secret, ['가', '나', '다', '라'], 0),
    );

    const missing = await mallory.api.request('GET', `/questions/${RANDOM_ID}`);
    expect(missing.status).toBe(404);
    for (const [method, path, body] of [
      ['GET', `/questions/${question.id}`, undefined],
      [
        'PATCH',
        `/questions/${question.id}`,
        { base_revision_id: question.revision.id, stem: 'mallory edit' },
      ],
      ['GET', `/workspaces/${aliceWs.id}/questions`, undefined],
      ['POST', `/workspaces/${aliceWs.id}/questions`, mcqInput('mallory', ['a', 'b'], 0)],
    ] as const) {
      const res = await mallory.api.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(stable(res), `${method} ${path}`).toEqual(stable(missing));
      expect(res.text).not.toContain(secret);
    }
    // Mallory's own workspace does not leak it either.
    expect(await listQuestions(mallory, malloryWs.id)).toEqual([]);

    const unchanged = await getQuestion(alice, question.id);
    expect(unchanged.revision).toEqual(question.revision);

    await signInAs(page, mallory.user);
    await page.goto(bankPath(aliceWs.id));
    await expect(notFoundHeading(page)).toBeVisible();
    await expect(page.getByText(secret)).toHaveCount(0);
  },
);

test(
  'QBANK-01-AC04 viewers and archived workspaces see a read-only bank and the server refuses their edits',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('qbank01-ac04-owner');
    const viewer = await workspaceFactory.member('qbank01-ac04-viewer');
    const ws = await workspaceFactory.create(owner);
    const text = stem('보관 전 등록한 문제');
    const question = await createQuestion(owner, ws.id, mcqInput(text, ['가', '나', '다'], 2));
    // No membership API before S1/S2: the viewer role is seeded (fixtures/db.ts use 2).
    seedMembership(ws.id, viewer.user.id, 'viewer');

    expect((await listQuestions(viewer, ws.id)).map((q) => q.id)).toEqual([question.id]);
    const edit = { base_revision_id: question.revision.id, stem: 'viewer edit' };
    for (const [method, path, body] of [
      ['PATCH', `/questions/${question.id}`, edit],
      ['POST', `/workspaces/${ws.id}/questions`, mcqInput('viewer', ['a', 'b'], 0)],
    ] as const) {
      const res = await viewer.api.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((res.body as Problem).type).toBe(PROBLEM_TYPES.insufficientRole);
    }

    await openBank(page, viewer, ws.id);
    await expect(bankUi.item(page, text)).toBeVisible();
    await expect(bankUi.createButton(page)).toHaveCount(0);
    await expect(bankUi.editButton(bankUi.item(page, text))).toHaveCount(0);

    await workspaceFactory.archive(owner, ws.id);
    for (const [method, path, body] of [
      ['PATCH', `/questions/${question.id}`, { ...edit, stem: 'archived edit' }],
      ['POST', `/workspaces/${ws.id}/questions`, mcqInput('archived', ['a', 'b'], 0)],
    ] as const) {
      const res = await owner.api.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((res.body as Problem).type).toBe(PROBLEM_TYPES.workspaceArchived);
    }
    expect((await getQuestion(owner, question.id)).revision).toEqual(question.revision);

    await page.context().clearCookies();
    await openBank(page, owner, ws.id);
    await expect(bankUi.item(page, text)).toBeVisible();
    await expect(bankUi.readOnlyNotice(page)).toBeVisible();
    await expect(bankUi.createButton(page)).toHaveCount(0);
    await expect(bankUi.editButton(bankUi.item(page, text))).toHaveCount(0);
  },
);
