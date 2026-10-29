// CHNOTE-01 — 챕터 정리 노트 Floating Side Panel (`/workspaces/:id?panel=chapter-note&chapter=`),
// docs/screens/chapter-notes.md; rules docs/questions.md §9, shared reads docs/workspace-sharing.md
// §8. Contract half (C01–C08): tests/integration/questions/chapter_notes/.
//
// Each test uploads the synthetic book-ko.pdf (chapters "1장 물의 순환" / "2장 정수 처리") into its
// own workspace and creates CONFIRMED MCQs with explanations in a chapter through the public
// question API (numbers 1..n, the outline node id as `chapter_id`). Notes come from the APP_ENV=test
// scenario LLM (tests/fixtures/llm/chapter-note-scenarios.json): every question of a chapter under
// test ends its stem with the scenario marker, and the fake's hold barrier makes "만드는 중" and the
// running 409 deterministic. Every assumption about CHNOTE-B / CHNOTE-W (API shapes N1–N5, the fake
// N6–N8, the feature-off stack N9, UI labels) is in the tests/e2e/fixtures/chapter-notes.ts header.
//
// Notes, footnotes and the practice panel carry answers and explanations: traces, screenshots and
// videos are off, no page text is attached on failure, and shown text is only checked with boolean
// polls or by ASCII item tokens (NOTE-…), so a failure message never quotes note content.
// The bank's edit/delete (QBANK-01) are driven through the same public API they call; this file
// asserts how the note reacts to them.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  FOOTNOTE_GONE,
  FOOTNOTE_LINE,
  generateNote,
  getNote,
  listChapterNotes,
  NOTE_PROBLEMS,
  NOTE_TIMEOUT_MS,
  NOTE_TOKENS,
  noteBody,
  NoteHold,
  notePanelPath,
  noteQuestion,
  noteUi,
  requestNote,
  sharedNotePanelPath,
  startChapterNotesOffStack,
  startNote,
  waitForNote,
  expectText,
  type ChapterNoteState,
  type NoteScenario,
} from '../fixtures/chapter-notes.ts';
import {
  createShareLink,
  expect,
  NO_VISUAL_ARTIFACTS,
  openShareWithSecret,
  sharedUi,
  ShareSession,
  stableProblem,
  test,
} from '../fixtures/sharing.ts';
import {
  createQuestion,
  importPaperDrafts,
  JOB_TIMEOUT_MS,
  outlineNodeId,
  overviewPath,
  panelUi,
  PROBLEM_TYPES,
  questionNumberName,
  seedMembership,
  signInAs,
  uploadReadyBook,
  type Member,
  type Problem,
  type Question,
} from '../fixtures/test.ts';
import type { WorkspaceFactory } from '../fixtures/workspaces.ts';

test.use({
  storageState: { cookies: [], origins: [] },
  ...NO_VISUAL_ARTIFACTS,
  attachPageTextOnFailure: false,
});
test.describe.configure({ timeout: 4 * JOB_TIMEOUT_MS + 2 * NOTE_TIMEOUT_MS });

const CH1 = '1장 물의 순환';
const CH2 = '2장 정수 처리';
const RANDOM_ID = '00000000-0000-4000-8000-000000000000';

interface NoteWorkspace {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly ch1: string;
  readonly ch2: string;
  readonly label: string;
  /** Chapter 1's confirmed questions, numbers 1..n in order. */
  readonly questions: Question[];
}

/** book-ko uploaded and `count` confirmed questions of `scenario` in chapter 1 (Q1 may hold). */
async function noteWorkspace(
  workspaceFactory: WorkspaceFactory,
  label: string,
  scenario: NoteScenario,
  count: number,
  hold?: NoteHold,
): Promise<NoteWorkspace> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  const ch1 = await outlineNodeId(owner, documentId, CH1);
  const ch2 = await outlineNodeId(owner, documentId, CH2);
  const tag = `${label}-${randomUUID().slice(0, 4)}`;
  const questions: Question[] = [];
  for (let n = 1; n <= count; n += 1) {
    questions.push(
      await createQuestion(
        owner,
        ws.id,
        noteQuestion(tag, n, ch1, scenario, {
          hold: n === 1 ? hold : undefined,
          sources: [{ document_id: documentId, page_start: 2, page_end: 3 }],
        }),
      ),
    );
  }
  return { owner, workspaceId: ws.id, documentId, ch1, ch2, label: tag, questions };
}

function q(s: NoteWorkspace, n: number): Question {
  const found = s.questions[n - 1];
  if (!found) throw new Error(`no question ${n}`);
  return found;
}

async function openPanel(page: Page, workspaceId: string, chapterId: string): Promise<Locator> {
  await page.goto(notePanelPath(workspaceId, chapterId));
  const panel = noteUi.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function switchUser(page: Page, user: Member): Promise<void> {
  await page.context().clearCookies();
  await signInAs(page, user.user);
}

/** Opens the "정답·해설 포함" disclosure and returns the shown body. */
async function expand(panel: Locator): Promise<Locator> {
  const disclosure = noteUi.disclosure(panel);
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const body = await noteBody(panel);
  await expect(body).toBeVisible();
  return body;
}

/** Picks version `k` in the `버전` select (native select or a Radix listbox). */
async function chooseVersion(page: Page, panel: Locator, k: number): Promise<void> {
  const select = noteUi.version(panel);
  await expect(select).toBeVisible();
  const name = new RegExp(`^(버전|version)\\s*${k}(?!\\d)`, 'i');
  if ((await select.evaluate((el) => el.tagName)) === 'SELECT') {
    const label = await select.evaluate(
      (el, n) =>
        [...(el as HTMLSelectElement).options].find((o) =>
          new RegExp(`^(버전|version)\\s*${n}(?!\\d)`, 'i').test(o.text),
        )?.text ?? '',
      k,
    );
    await select.selectOption({ label });
  } else {
    await select.click();
    await page.getByRole('option', { name }).click();
  }
}

/** Every key of a parsed JSON value whose name mentions a note, as `$.path.key`. */
function noteKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => noteKeysIn(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => [
    ...(/note|footnote/i.test(key) ? [`${path}.${key}`] : []),
    ...noteKeysIn(v, `${path}.${key}`),
  ]);
}

function refIds(state: ChapterNoteState): Set<string> {
  return new Set((state.note?.question_refs ?? []).map((r) => r.question_id));
}

/** Parsed footnote lines of `list`: question numbers, or null for a line that is not the format. */
async function footnoteNumbers(list: Locator): Promise<(number | null)[]> {
  const lines = await list.getByRole('listitem').allInnerTexts();
  return lines.map((line) => {
    const m = FOOTNOTE_LINE.exec(line);
    return m ? Number(m[2]) : null;
  });
}

test(
  'CHNOTE-01-AC01 an editor opens a chapter from the Heatmap and creates one note from its confirmed questions only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const hold = new NoteHold();
    try {
      const s = await noteWorkspace(workspaceFactory, 'chnote01-ac01', 'mixed', 3, hold);
      const other = await createQuestion(
        s.owner,
        s.workspaceId,
        noteQuestion(s.label, 4, s.ch2, 'ok'),
      );
      // An unregistered import draft in the same chapter is not an input.
      const { drafts } = await importPaperDrafts(s.owner, s.workspaceId);
      const draft = drafts[0];
      if (!draft) throw new Error('the question paper yields drafts');
      await s.owner.api.ok(
        'PATCH',
        `/question-drafts/${draft.id}`,
        { base_version: draft.version, chapter_id: s.ch1 },
        [200],
      );

      await signInAs(page, s.owner.user);
      await page.goto(overviewPath(s.workspaceId));
      const group = noteUi.group(page, CH1);
      await expect(group).toBeVisible();
      const opener = noteUi.opener(group, CH1);
      await opener.click();
      const panel = noteUi.panel(page);
      await expect(panel).toBeVisible();
      await expect(page).toHaveURL(
        (url) =>
          url.searchParams.getAll('panel').includes('chapter-note') &&
          url.searchParams.get('chapter') === s.ch1,
      );
      await expect(panel).not.toHaveAttribute('aria-modal', 'true');
      await expect(noteUi.empty(panel)).toBeVisible();
      await expect(noteUi.sendNotice(panel)).toBeVisible();
      await expect(panel).toContainText(noteUi.sendCount(3));

      // Two quick presses: one generation, held by the fake while the panel says so.
      await noteUi.create(panel).dblclick();
      await hold.held();
      await expect(noteUi.generating(panel)).toBeVisible();
      expect((await getNote(s.owner, s.ch1)).generation?.status).toBe('running');
      hold.release();

      await expect(noteUi.aiBadge(panel)).toBeVisible({ timeout: NOTE_TIMEOUT_MS });
      await expect(noteUi.meta(panel)).toContainText(noteUi.metaCount(3));
      await expect(noteUi.generating(panel)).toHaveCount(0);
      await expect(noteUi.disclosure(panel)).toHaveAttribute('aria-expanded', 'false');
      await expect(noteUi.disclosure(panel)).toHaveAccessibleName(/펼쳐서 보기|show/i);
      await expect(noteUi.disclosureNote(panel)).toBeVisible();
      await expect(await noteBody(panel)).toBeHidden();

      const state = await getNote(s.owner, s.ch1);
      expect(state.versions).toHaveLength(1);
      expect(state.confirmed_question_count).toBe(3);
      expect(state.note?.question_count).toBe(3);
      expect(refIds(state)).toEqual(new Set(s.questions.map((x) => x.id)));
      expect(refIds(state).has(other.id)).toBe(false);
      const cited = (state.note?.footnotes ?? []).map((f) => f.question_id);
      expect(cited.length).toBeGreaterThan(0);
      expect(cited.every((id) => id !== null && refIds(state).has(id))).toBe(true);
    } finally {
      hold.release();
    }
  },
);

test(
  'CHNOTE-01-AC02 every shown item has a footnote to an input question; fabricated or uncited items never appear; footnotes open the question',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteWorkspace(workspaceFactory, 'chnote01-ac02', 'mixed', 3);
    await generateNote(s.owner, s.ch1);
    const raw = await s.owner.api.request('GET', `/chapters/${s.ch1}/note`);
    expect(raw.status).toBe(200);
    for (const token of NOTE_TOKENS.mixedValid) {
      expect(raw.text.includes(token), `${token} is stored`).toBe(true);
    }
    for (const token of NOTE_TOKENS.mixedInvalid) {
      expect(raw.text.includes(token), `${token} is never stored`).toBe(false);
    }

    await signInAs(page, s.owner.user);
    const panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(noteUi.aiBadge(panel)).toBeVisible();
    const disclosure = noteUi.disclosure(panel);
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const body = await noteBody(panel);
    await expect(body).toBeVisible();
    await expect(noteUi.sectionHeadings(body).first()).toBeVisible();
    for (const token of NOTE_TOKENS.mixedValid) {
      await expectText(body, token, true, `${token} is shown`);
    }
    for (const token of NOTE_TOKENS.mixedInvalid) {
      await expectText(panel, token, false, `${token} is never shown`);
    }

    // Items end in "각주 k" links; the only listitems without one are the footnote lines.
    const refLink = page.getByRole('link', { name: /^(각주|footnote)\s*\d+$/i });
    const footnotes = noteUi.footnoteList(body);
    await expect(footnotes).toBeVisible();
    const lines = footnotes.getByRole('listitem');
    await expect(lines).toHaveCount(3);
    await expect(body.getByRole('listitem').filter({ has: refLink })).toHaveCount(4);
    await expect(body.getByRole('listitem').filter({ hasNot: refLink })).toHaveCount(3);
    const numbers = await footnoteNumbers(footnotes);
    expect(numbers.includes(null), 'every footnote reads "[^k] <장> <번호>번 — <발문>"').toBe(
      false,
    );
    expect(new Set(numbers)).toEqual(new Set([1, 2, 3]));
    await expect(footnotes.getByRole('link')).toHaveCount(3);

    // Keyboard: an item's footnote number moves to its footnote line in the same panel.
    const ref = noteUi.footnoteRefs(body).first();
    const href = (await ref.getAttribute('href')) ?? '';
    expect(href.startsWith('#'), 'the footnote number links inside the panel').toBe(true);
    const targetId = decodeURIComponent(href.slice(1));
    expect(
      await footnotes.evaluate(
        (el, id) => el.querySelector(`[id="${CSS.escape(id)}"]`) !== null,
        targetId,
      ),
    ).toBe(true);
    await ref.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`[id="${targetId}"]`)).toBeInViewport();

    // A footnote line opens that question's practice panel; the note body folds at once.
    const line2 = footnotes.getByRole('link').filter({ hasText: /\d+장\s*2번/ });
    await line2.focus();
    await page.keyboard.press('Enter');
    const play = panelUi.numbered(page, 2);
    await expect(play).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get('question') === q(s, 2).id);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();

    // Closing it leaves the note folded and returns focus to the disclosure button.
    await page.keyboard.press('Escape');
    await expect(play).toBeHidden();
    await expect(disclosure).toBeFocused();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  },
);

test(
  'CHNOTE-01-AC03 changed questions make the note stale; regenerating adds version 2 and version 1 stays readable',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteWorkspace(workspaceFactory, 'chnote01-ac03', 'mixed', 3);
    const v1 = await generateNote(s.owner, s.ch1);
    expect(v1.stale).toBe(false);

    // The bank's 편집 (explanation → new revision) and 삭제, through their public API.
    const edited = await s.owner.api.ok<Question>(
      'PATCH',
      `/questions/${q(s, 1).id}`,
      { base_revision_id: q(s, 1).revision.id, explanation: `${s.label}-1 고친 해설.` },
      [200],
    );
    expect(edited.revision.id).not.toBe(q(s, 1).revision.id);
    await s.owner.api.ok('DELETE', `/questions/${q(s, 3).id}`, undefined, [204]);

    await signInAs(page, s.owner.user);
    let panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(noteUi.stale(panel)).toBeVisible();
    await expect(noteUi.meta(panel)).toContainText(noteUi.metaCount(3));
    let body = await expand(panel);
    const footnotes = noteUi.footnoteList(body);
    const gone = footnotes.getByRole('listitem').filter({ hasText: FOOTNOTE_GONE });
    await expect(gone).toHaveCount(1);
    await expect(gone.getByRole('link')).toHaveCount(0);
    await expect(gone).toContainText(/\d+장\s*3번/);
    await expect(footnotes.getByRole('link')).toHaveCount(2);

    // 다시 만들기 → version 2 from the two remaining questions, no badge.
    const before = (await getNote(s.owner, s.ch1)).generation?.id;
    await noteUi.regenerate(panel).click();
    const v2 = await waitForNote(s.owner, s.ch1, 'succeeded', before);
    expect(v2.note?.version).toBe(2);
    expect(v2.stale).toBe(false);
    expect(refIds(v2)).toEqual(new Set([q(s, 1).id, q(s, 2).id]));
    expect(
      v2.note?.question_refs.find((r) => r.question_id === q(s, 1).id)?.question_revision_id,
    ).toBe(edited.revision.id);
    await expect(noteUi.meta(panel)).toContainText(noteUi.metaCount(2), {
      timeout: NOTE_TIMEOUT_MS,
    });
    await expect(noteUi.stale(panel)).toHaveCount(0);
    body = await noteBody(panel);
    if ((await noteUi.disclosure(panel).getAttribute('aria-expanded')) !== 'true') {
      body = await expand(panel);
    }
    await expectText(body, 'NOTE-MIX-A', true, 'version 2 shows the Q1 item');
    await expectText(body, NOTE_TOKENS.mixedNeedsQ3, false, 'version 2 has no Q3 item');

    // 버전 1 is still there, unchanged, marked as an older version.
    await chooseVersion(page, panel, 1);
    panel = noteUi.panel(page);
    await expect(noteUi.previousNotice(panel)).toBeVisible();
    await expect(noteUi.meta(panel)).toContainText(noteUi.metaCount(3));
    body = await noteBody(panel);
    if ((await noteUi.disclosure(panel).getAttribute('aria-expanded')) !== 'true') {
      body = await expand(panel);
    }
    await expectText(body, NOTE_TOKENS.mixedNeedsQ3, true, 'version 1 keeps its Q3 item');
    const old = await getNote(s.owner, s.ch1, 1);
    expect(old.note?.id).toBe(v1.note?.id);
    expect(old.versions.map((v) => v.version)).toEqual([2, 1]);
  },
);

test(
  'CHNOTE-01-AC04 viewers read but cannot create; share guests read only source-matched notes; archived workspaces are read-only',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteWorkspace(workspaceFactory, 'chnote01-ac04', 'mixed', 3);
    const viewer = await workspaceFactory.member('chnote01-ac04-viewer');
    seedMembership(s.workspaceId, viewer.user.id, 'viewer');
    await generateNote(s.owner, s.ch1);
    await generateNote(s.owner, s.ch1); // two versions: the viewer can pick one
    for (const n of [4, 5]) {
      await createQuestion(s.owner, s.workspaceId, noteQuestion(s.label, n, s.ch2, 'ok'));
    }
    // A note in another workspace of the same owner (its chapter must stay 404 for the guest).
    const foreign = await noteWorkspace(workspaceFactory, 'chnote01-ac04-foreign', 'ok', 2);
    await generateNote(foreign.owner, foreign.ch1);

    // Viewer: reads, picks a version, no create/regenerate; POST is 403.
    await signInAs(page, viewer.user);
    let panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(noteUi.aiBadge(panel)).toBeVisible();
    await chooseVersion(page, panel, 1);
    await expect(noteUi.previousNotice(noteUi.panel(page))).toBeVisible();
    await expect(noteUi.regenerate(panel)).toHaveCount(0);
    await expect(noteUi.create(panel)).toHaveCount(0);
    panel = await openPanel(page, s.workspaceId, s.ch2);
    await expect(noteUi.empty(panel)).toBeVisible();
    await expect(noteUi.create(panel)).toHaveCount(0);
    for (const chapter of [s.ch1, s.ch2]) {
      const res = await requestNote(viewer, chapter);
      expect(res.status).toBe(403);
      expect((res.body as Problem | undefined)?.type).toBe(PROBLEM_TYPES.insufficientRole);
    }

    // Guest: the 정리 노트 card lists the chapter with a note only; read-only panel.
    const link = await createShareLink(s.owner, s.workspaceId);
    const session = await ShareSession.open(link.id, link.secret);
    await page.context().clearCookies();
    await openShareWithSecret(page, link.id, link.secret);
    await expect(sharedUi.readOnlyNotice(page)).toBeVisible();
    const card = noteUi.sharedCard(page);
    await expect(noteUi.sharedChapter(card, CH1)).toBeVisible();
    await expect(noteUi.sharedChapter(card, CH2)).toHaveCount(0);
    await noteUi.sharedChapter(card, CH1).click();
    panel = noteUi.panel(page);
    await expect(noteUi.aiBadge(panel)).toBeVisible();
    await expect(noteUi.version(panel)).toHaveCount(0);
    await expect(noteUi.create(panel)).toHaveCount(0);
    await expect(noteUi.regenerate(panel)).toHaveCount(0);
    await expect(noteUi.retry(panel)).toHaveCount(0);
    await expect(noteUi.generating(panel)).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    const body = await expand(panel);
    await expectText(body, 'NOTE-MIX-A', true, 'the guest reads the latest note');
    await noteUi.footnoteList(body).getByRole('link').first().click();
    await expect(sharedUi.questionPanel(page)).toBeVisible();
    await expect(sharedUi.forbiddenControls(page)).toHaveCount(0);

    const own = await session.get(`/chapters/${s.ch1}/note`);
    expect(own.status).toBe(200);
    for (const key of ['versions', 'generation', 'usage', 'input_fingerprint', 'question_refs']) {
      expect(
        Object.keys((own.body as object | undefined) ?? {}),
        'no member-only data',
      ).not.toContain(key);
    }
    expect(own.text.includes('question_revision_id')).toBe(false);
    const unknown = await session.get(`/chapters/${RANDOM_ID}/note`);
    const foreignRes = await session.get(`/chapters/${foreign.ch1}/note`);
    expect(foreignRes.status).toBe(404);
    expect(stableProblem(foreignRes)).toEqual(stableProblem(unknown));

    // A cited question is deleted: the guest loses the note (card, panel, API); members keep it.
    await s.owner.api.ok('DELETE', `/questions/${q(s, 2).id}`, undefined, [204]);
    expect((await session.get(`/chapters/${s.ch1}/note`)).status).toBe(404);
    const listed = await session.get<{ items: { chapter_id: string }[] }>('/chapter-notes');
    expect(listed.status).toBe(200);
    expect((listed.body?.items ?? []).some((i) => i.chapter_id === s.ch1)).toBe(false);
    await page.goto(sharedNotePanelPath(link.id, s.ch1));
    panel = noteUi.panel(page);
    await expect(noteUi.sharedMissing(panel)).toBeVisible();
    for (const token of NOTE_TOKENS.mixedValid) {
      await expectText(panel, token, false, `${token} is withheld from the guest`);
    }
    await expect(noteUi.sharedChapter(noteUi.sharedCard(page), CH1)).toHaveCount(0);
    const member = await getNote(viewer, s.ch1);
    expect(member.note).not.toBeNull();
    expect(member.stale).toBe(true);

    // Archived: the owner reads but cannot create or regenerate.
    await workspaceFactory.archive(s.owner, s.workspaceId);
    await switchUser(page, s.owner);
    panel = await openPanel(page, s.workspaceId, s.ch1);
    await expect(noteUi.aiBadge(panel)).toBeVisible();
    await expect(noteUi.regenerate(panel)).toHaveCount(0);
    await expect(noteUi.create(panel)).toHaveCount(0);
    for (const chapter of [s.ch1, s.ch2]) {
      const res = await requestNote(s.owner, chapter);
      expect(res.status).toBe(403);
      expect((res.body as Problem | undefined)?.type).toBe(PROBLEM_TYPES.workspaceArchived);
    }
  },
);

test(
  'CHNOTE-01-AC05 opening a question folds the note; the practice panel and API never carry note content',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const s = await noteWorkspace(workspaceFactory, 'chnote01-ac05', 'mixed', 3);
    await generateNote(s.owner, s.ch1);
    const tokens = [...NOTE_TOKENS.mixedValid];

    await signInAs(page, s.owner.user);
    let panel = await openPanel(page, s.workspaceId, s.ch1);
    const disclosure = noteUi.disclosure(panel);
    const body = await expand(panel);
    await expectText(body, 'NOTE-MIX-A', true, 'the note body is open');

    // The Heatmap marker of the unsolved question 1 opens the practice panel; the note folds.
    const dot = noteUi.group(page, CH1).getByRole('button', { name: questionNumberName(1) });
    await dot.click();
    const play = panelUi.numbered(page, 1);
    await expect(play).toBeVisible();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();
    const optionText = `${s.label}-1 보기 가`;
    await expect(panelUi.option(play, optionText)).toBeVisible();
    const noNote = async (when: string) => {
      await expect(
        play.getByRole('link', { name: /정리 노트|각주|chapter note|footnote/i }),
      ).toHaveCount(0);
      await expect(play.getByRole('button', { name: /정리 노트|chapter note/i })).toHaveCount(0);
      for (const token of tokens) {
        await expectText(play, token, false, `${token} is not in the practice panel ${when}`);
      }
    };
    await noNote('before submitting');

    // The practice API (session and submit) has no note field or content.
    const started = await s.owner.api.request<{ id: string }>(
      'POST',
      `/questions/${q(s, 1).id}/practice-sessions`,
      {},
    );
    expect(started.status).toBe(201);
    expect(noteKeysIn(started.body)).toEqual([]);
    expect(tokens.some((t) => started.text.includes(t))).toBe(false);
    const graded = await s.owner.api.request(
      'POST',
      `/practice-sessions/${started.body?.id ?? ''}/submit`,
      { selected_option_ids: ['opt-1'] },
    );
    expect(graded.status).toBe(200);
    expect(noteKeysIn(graded.body)).toEqual([]);
    expect(tokens.some((t) => graded.text.includes(t))).toBe(false);

    await panelUi.option(play, optionText).click();
    await panelUi.submit(play).click();
    await expect(panelUi.result(play)).toBeVisible();
    await noNote('after submitting');
    await panelUi.close(play).click();
    await expect(play).toBeHidden();

    // Reopening the note panel starts folded again.
    await noteUi.close(panel).click();
    await expect(panel).toBeHidden();
    await noteUi.opener(noteUi.group(page, CH1), CH1).click();
    panel = noteUi.panel(page);
    await expect(noteUi.aiBadge(panel)).toBeVisible();
    await expect(noteUi.disclosure(panel)).toHaveAttribute('aria-expanded', 'false');
    await expect(await noteBody(panel)).toBeHidden();
  },
);

test(
  'CHNOTE-01-AC06 no button for 챕터 없음; empty, failed, running and feature-off chapters',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const hold = new NoteHold();
    try {
      const s = await noteWorkspace(workspaceFactory, 'chnote01-ac06', 'ok', 2, hold);
      const viewer = await workspaceFactory.member('chnote01-ac06-viewer');
      seedMembership(s.workspaceId, viewer.user.id, 'viewer');
      for (const n of [3, 4]) {
        await createQuestion(s.owner, s.workspaceId, noteQuestion(s.label, n, s.ch2, 'fail'));
      }
      await createQuestion(s.owner, s.workspaceId, noteQuestion(s.label, 5, null, 'ok'));
      const en = await uploadReadyBook(s.owner, s.workspaceId, 'book-en');
      const enCh1 = await outlineNodeId(s.owner, en, 'Chapter 1. The Water Cycle');
      const enCh2 = await outlineNodeId(s.owner, en, 'Chapter 2. Water Treatment');
      await createQuestion(s.owner, s.workspaceId, noteQuestion(s.label, 6, enCh1, 'ok'));
      // Chapter 2 of book-en has an import draft only (no confirmed question).
      const { drafts } = await importPaperDrafts(s.owner, s.workspaceId);
      const draft = drafts[0];
      if (!draft) throw new Error('the question paper yields drafts');
      await s.owner.api.ok(
        'PATCH',
        `/question-drafts/${draft.id}`,
        { base_version: draft.version, chapter_id: enCh2 },
        [200],
      );

      // Group headers: every chapter group has the button, 챕터 없음 has none.
      await signInAs(page, s.owner.user);
      await page.goto(overviewPath(s.workspaceId));
      const none = noteUi.group(page, /^(챕터 없음|no chapter)$/i);
      await expect(none).toBeVisible();
      await expect(noteUi.anyOpener(none)).toHaveCount(0);
      for (const title of [CH1, CH2, 'Chapter 1. The Water Cycle']) {
        await expect(noteUi.opener(noteUi.group(page, title), title)).toBeVisible();
      }

      // A chapter with drafts only: no confirmed questions, no button, 409.
      let panel = await openPanel(page, s.workspaceId, enCh2);
      await expect(noteUi.noQuestions(panel)).toBeVisible();
      await expect(noteUi.create(panel)).toHaveCount(0);
      const empty = await requestNote(s.owner, enCh2);
      expect(empty.status).toBe(409);
      expect((empty.body as Problem | undefined)?.type).toBe(NOTE_PROBLEMS.noQuestions);

      // The failing scenario: alert with the reason; 다시 시도 for editors only.
      panel = await openPanel(page, s.workspaceId, s.ch2);
      await noteUi.create(panel).click();
      const failure = noteUi.failure(panel);
      await expect(failure).toBeVisible({ timeout: NOTE_TIMEOUT_MS });
      await expect(failure).toContainText(noteUi.genericReason);
      await expect(noteUi.retry(panel)).toBeVisible();
      expect((await getNote(s.owner, s.ch2)).generation).toMatchObject({
        status: 'failed',
        error_code: 'llm_invalid_output',
      });
      await switchUser(page, viewer);
      panel = await openPanel(page, s.workspaceId, s.ch2);
      await expect(noteUi.failure(panel)).toBeVisible();
      await expect(noteUi.retry(panel)).toHaveCount(0);

      // A running generation (held by the fake): "만드는 중" in the header, a second POST is 409.
      await switchUser(page, s.owner);
      await startNote(s.owner, s.ch1);
      await hold.held();
      await page.goto(overviewPath(s.workspaceId));
      await expect(noteUi.groupBusy(noteUi.group(page, CH1))).toBeVisible();
      expect(
        (await listChapterNotes(s.owner, s.workspaceId)).items.find((i) => i.chapter_id === s.ch1)
          ?.generating,
      ).toBe(true);
      const running = await requestNote(s.owner, s.ch1);
      expect(running.status).toBe(409);
      expect((running.body as Problem | undefined)?.type).toBe(NOTE_PROBLEMS.running);
      hold.release();
      await waitForNote(s.owner, s.ch1, 'succeeded');

      // Feature off: create is disabled with the reason, POST is 409, stored notes still read.
      const off = await startChapterNotesOffStack();
      try {
        await page.goto(`${off.webUrl}${notePanelPath(s.workspaceId, enCh1)}`);
        panel = noteUi.panel(page);
        await expect(panel).toBeVisible();
        const create = noteUi.create(panel);
        await expect(create).toHaveAttribute('aria-disabled', 'true');
        await expect(create).toHaveAccessibleDescription(noteUi.unavailableReason);
        const state = await off.request<ChapterNoteState>(
          s.owner,
          'GET',
          `/chapters/${enCh1}/note`,
        );
        expect(state.status).toBe(200);
        expect(state.body?.available).toBe(false);
        const refused = await off.request<Problem>(s.owner, 'POST', `/chapters/${enCh1}/note`);
        expect(refused.status).toBe(409);
        expect(refused.body?.type).toBe(NOTE_PROBLEMS.disabled);

        await page.goto(`${off.webUrl}${notePanelPath(s.workspaceId, s.ch1)}`);
        panel = noteUi.panel(page);
        await expect(noteUi.aiBadge(panel)).toBeVisible();
        await expect(noteUi.meta(panel)).toContainText(noteUi.metaCount(2));
      } finally {
        await off.stop();
      }
    } finally {
      hold.release();
    }
  },
);
