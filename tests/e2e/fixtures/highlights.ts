// Highlight (HILITE-01) and chapter note tool (CHNOTE-02) fixtures: the my-highlights and question
// preview API helpers, browser selection helpers, and the UI label contract of the shared
// highlight tool, `내 하이라이트`, the note search and the footnote preview. UX9.0 keeps every
// assumption about UX9-HL-B / UX9-HL-UI / UX9-HL-W / UX9-NOTE-B / UX9-NOTE-W in this header
// (mirrored by tests/integration/questions/highlights/ and
// tests/integration/questions/chapter_notes/test_chapter_note_previews_contract.py).
//
// Grounded in the docs (docs/screens/highlights.md, docs/screens/chapter-note-tools.md,
// docs/questions.md §15, docs/design-system.md §5.2–§5.4, docs/workspace-sharing.md §11): routes
// GET /chapters/{chapterId}/my-highlights, GET /workspaces/{id}/my-highlights?chapter=none,
// GET /questions/{id}/my-highlights, POST /my-highlights, PATCH|DELETE /my-highlights/{id},
// POST /my-highlights/{id}/restore, GET /questions/{id}/preview,
// GET /shared/{shareId}/questions/{questionId}/preview; targets note | explanation |
// ai_explanation; anchor {block, start, end} + server-cut quote/prefix/suffix (32 chars);
// colors yellow | blue | pink; anchor_current exact | relocated | missing; problems
// highlight-target-unavailable, highlight-anchor-invalid, highlight-limit, highlight-changed,
// highlight-not-restorable, highlight-overlap; writes allowed in archived workspaces (highlights
// only); restore within 10 minutes; no activity events.
//
// NOT in the docs (UX9.0 assumptions, to confirm or change in UX9-HL-B / UX9-NOTE-B):
//   H1 Highlight = {id, color: "yellow"|"blue"|"pink", version: int, target: {kind: "note",
//      chapter_note_id, note_version: int} | {kind: "explanation", question_id,
//      question_revision_id} | {kind: "ai_explanation", ai_explanation_id, question_id},
//      anchor: {block, start, end}, quote, anchor_status: "exact"|"relocated"|"missing",
//      anchor_current: {block, start, end} | null, question: {question_id, number_label,
//      stem_preview} | null (explanation targets: "12번" + the stem's first 40 chars, no
//      answers/options/explanation text), created_at, updated_at}. `prefix`/`suffix` are stored
//      but never returned (they are explanation text around the quote the user did not pick).
//   H2 `block` is a string: a note item is "s<i>.i<j>" (body.sections[i].items[j], rendered text
//      without footnote tags), an explanation paragraph is "p<i>" (blank-line separated, 0-based).
//      `start`/`end` are UTF-16 offsets into that block's text (JS string indices), end exclusive.
//   H3 POST /my-highlights {target: {kind: "note", chapter_note_id} | {kind: "explanation",
//      question_id}, anchor, color, replace_ids?: string[]} (optional `Idempotency-Key`) → 201
//      Highlight. PATCH /my-highlights/{id} {color, version} → 200 Highlight; DELETE → 204
//      (idempotent); POST /my-highlights/{id}/restore → 200 Highlight.
//   H4 GET /chapters/{chapterId}/my-highlights | /workspaces/{id}/my-highlights?chapter=none |
//      /questions/{id}/my-highlights → 200 {items: Highlight[]} in display order (C06): note
//      highlights of the chapter's versions (newest version first, body order), then
//      explanation highlights in Heatmap order.
//   H5 DB (UX9-HL-B migration): table public.user_highlights(id, user_id, workspace_id, ...,
//      deleted_at). E2E reads it with the superuser only to count a fork target's rows (C02).
//   P1 GET /questions/{id}/preview → 200 {question_id, number_label, chapter_title, question_type,
//      stem, options: [{id, text}]}; the shared variant has the same DTO (CHNOTE-02-C01/C02).
//   N-SEARCH The APP_ENV=test chapter note LLM answers the marker E2E-NOTE-SEARCH
//      (tests/fixtures/llm/chapter-note-scenarios.json, added by UX9.0) with three items: Q1
//      "주의" ×2 (NOTE-SEARCH-A), Q2 "주의" ×2 (NOTE-SEARCH-B) and Q2 "ＡＴＴＥＮＴＩＯＮ" +
//      "attention" (NOTE-SEARCH-C); headings without "주의".
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   HighlightableText: a Tab-reachable `role="group"` named "정리 노트 본문" (note body: h3
//     sections, one listitem per item) or "해설" (QuestionViewer explanation after submit and in
//     "문제 상세"); ArrowUp/ArrowDown move a roving paragraph focus inside it. A highlight is a
//     <mark data-highlight-color="yellow|blue|pink"> holding visually hidden text
//     "하이라이트 시작(<색>)" / "하이라이트 끝"; a search result is a <mark data-search-result>
//     (data-current="true" + hidden text "현재 결과" on the current one). These two data
//     attributes are the only non-ARIA hooks (state, like the heatmap's data-status).
//   HighlightMenu: role=menu "하이라이트" with items "노랑" · "파랑" · "분홍" (menuitemcheckbox or
//     menuitemradio, aria-checked on the exact current color), "하이라이트 지우기" (only when the
//     selection overlaps a highlight), "복사" (closes the menu, toast "복사했습니다."); reason text
//     "한 문단 안에서 고르세요" (color items aria-disabled) for a selection across blocks.
//   MyHighlightsSection: region named "내 하이라이트" with h3 "내 하이라이트 (n)", text
//     "나에게만 보입니다."; groups "출처" (전체·노트·해설) and "색" (전체·노랑·파랑·분홍) of toggle
//     buttons (aria-pressed); list "내 하이라이트 목록" with one listitem per highlight whose text
//     reads "<색> · 노트 · 버전 k" or "<색> · 해설 · <n>장 <번호>번" + the quote, an explanation
//     row's footnote line "[^hk] <n>장 <번호>번 — <발문 앞부분>" (a link opening the question),
//     badges "해설이 바뀌어 위치를 찾을 수 없습니다" / "이전 AI 해설의 하이라이트", and a menu
//     button "하이라이트 메뉴" → menuitems "위치로 이동", "색 바꾸기" (submenu: 3 colors), "삭제".
//     Empty: "아직 하이라이트가 없습니다…"; filtered empty: "고른 조건의 하이라이트가 없습니다.".
//   Toast region "알림 (F8)" (landmark); toast text "하이라이트를 지웠습니다" with button
//     "되돌리기"; refusal "같은 자리에 다른 하이라이트가 있어 되돌리지 못했습니다".
//   Explanation toast "정리 노트의 내 하이라이트에 모았습니다 · <장 제목>".
//   "챕터 없음" Heatmap group header: button "내 하이라이트" (`?panel=chapter-note&chapter=none`).
//   CHNOTE-02 note search: searchbox "노트에서 찾기"; result text "k/n" (or "결과 없음"); icon
//     buttons "이전 결과" / "다음 결과". Notice "이 노트에는 문제의 정답과 해설 내용이 들어
//     있습니다." above the always-open body (no disclosure).
//   Footnote preview: role=tooltip (hover / focus-visible) or role=dialog "문제 미리보기" with
//     button "문제 열기" (touch); text "<n>장 <번호>번 · 객관식", the stem, numbered options.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import type { ApiResponse } from './api.ts';
import { generateNote, noteQuestion, type ChapterNoteState } from './chapter-notes.ts';
import { outlineNodeId, uploadReadyBook } from './documents.ts';
import { localDbAdminUrl } from './local-env.ts';
import { createQuestion, type Question, type QuestionInput } from './questions.ts';
import type { Member, WorkspaceFactory } from './workspaces.ts';

export const CH1 = '1장 물의 순환';
export const CH2 = '2장 정수 처리';

export interface NoteSetup {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly ch1: string;
  readonly ch2: string;
  readonly label: string;
  /** Chapter 1's confirmed questions, numbers 1..n. */
  readonly questions: Question[];
  /** The chapter 1 note state after the generations (null when `versions` is 0). */
  readonly note: ChapterNoteState | null;
}

/**
 * book-ko uploaded, `count` confirmed MCQs of note scenario `marker` in chapter 1 (each with an
 * explanation; `input(n)` overrides fields) and `versions` succeeded note versions of chapter 1.
 */
export async function noteSetup(
  workspaceFactory: WorkspaceFactory,
  label: string,
  options: {
    readonly scenario?: 'ok' | 'mixed';
    readonly marker?: string;
    readonly count?: number;
    readonly versions?: number;
    readonly input?: (n: number) => Partial<QuestionInput>;
  } = {},
): Promise<NoteSetup> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
  const ch1 = await outlineNodeId(owner, documentId, CH1);
  const ch2 = await outlineNodeId(owner, documentId, CH2);
  const tag = `${label}-${randomUUID().slice(0, 4)}`;
  const questions: Question[] = [];
  for (let n = 1; n <= (options.count ?? 2); n++) {
    const base = noteQuestion(tag, n, ch1, options.scenario ?? 'ok', options.input?.(n) ?? {});
    const stem = options.marker
      ? base.stem.replace(/\[E2E-NOTE-[A-Z]+\]/, `[${options.marker}]`)
      : base.stem;
    questions.push(await createQuestion(owner, ws.id, { ...base, stem }));
  }
  let note: ChapterNoteState | null = null;
  for (let v = 0; v < (options.versions ?? 1); v++) note = await generateNote(owner, ch1);
  return { owner, workspaceId: ws.id, documentId, ch1, ch2, label: tag, questions, note };
}

/** Item text of the note at body.sections[s].items[i]. */
export function itemText(state: ChapterNoteState | null, s: number, i: number): string {
  const text = state?.note?.sections[s]?.items[i]?.text;
  if (!text) throw new Error(`the note has no item ${s}.${i}`);
  return text;
}

/** A note highlight of `quote` in item s.i of `state`'s shown version, through the API (H3). */
export function highlightNote(
  member: Member,
  state: ChapterNoteState | null,
  s: number,
  i: number,
  quote: string,
  color: HighlightColor,
): Promise<Highlight> {
  const id = state?.note?.id;
  if (!id) throw new Error('no note version to highlight');
  return createHighlight(member, {
    target: { kind: 'note', chapter_note_id: id },
    anchor: anchorOf(noteBlock(s, i), itemText(state, s, i), quote),
    color,
  });
}

/** An explanation highlight of `quote` in paragraph `p` of `question`'s explanation (H3). */
export function highlightExplanation(
  member: Member,
  question: Question,
  quote: string,
  color: HighlightColor,
  p = 0,
): Promise<Highlight> {
  const text = (question.revision.explanation ?? '').split(/\n\s*\n/)[p] ?? '';
  return createHighlight(member, {
    target: { kind: 'explanation', question_id: question.id },
    anchor: anchorOf(explanationBlock(p), text, quote),
    color,
  });
}

export type HighlightColor = 'yellow' | 'blue' | 'pink';

export const COLOR_NAME: Readonly<Record<HighlightColor, RegExp>> = {
  yellow: /^(노랑|yellow)$/i,
  blue: /^(파랑|blue)$/i,
  pink: /^(분홍|pink)$/i,
};
export const COLOR_LABEL: Readonly<Record<HighlightColor, string>> = {
  yellow: '노랑',
  blue: '파랑',
  pink: '분홍',
};
/** Underline style per color (design-system §5.2: never color alone). */
export const COLOR_UNDERLINE: Readonly<Record<HighlightColor, string>> = {
  yellow: 'solid',
  blue: 'double',
  pink: 'dotted',
};

export const HIGHLIGHT_PROBLEMS = {
  targetUnavailable: 'urn:quiz-workspace:problem:highlight-target-unavailable',
  anchorInvalid: 'urn:quiz-workspace:problem:highlight-anchor-invalid',
  limit: 'urn:quiz-workspace:problem:highlight-limit',
  changed: 'urn:quiz-workspace:problem:highlight-changed',
  notRestorable: 'urn:quiz-workspace:problem:highlight-not-restorable',
  overlap: 'urn:quiz-workspace:problem:highlight-overlap',
} as const;

export const SEARCH_MARKER = 'E2E-NOTE-SEARCH';

export interface Anchor {
  readonly block: string;
  readonly start: number;
  readonly end: number;
}

export type HighlightTarget =
  | { readonly kind: 'note'; readonly chapter_note_id: string }
  | { readonly kind: 'explanation'; readonly question_id: string };

export interface Highlight {
  readonly id: string;
  readonly color: HighlightColor;
  readonly version: number;
  readonly target: {
    readonly kind: 'note' | 'explanation' | 'ai_explanation';
    readonly chapter_note_id?: string;
    readonly note_version?: number;
    readonly question_id?: string;
  };
  readonly anchor: Anchor;
  readonly quote: string;
  readonly anchor_status: 'exact' | 'relocated' | 'missing';
  readonly anchor_current: Anchor | null;
}

/** H2: a note item block / an explanation paragraph block. */
export const noteBlock = (section: number, item: number): string => `s${section}.i${item}`;
export const explanationBlock = (paragraph: number): string => `p${paragraph}`;

/** H2 anchor of the first occurrence of `quote` in `text` (UTF-16 offsets). */
export function anchorOf(block: string, text: string, quote: string): Anchor {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error('the quote is not in the block text');
  return { block, start, end: start + quote.length };
}

export function createHighlight(
  member: Member,
  body: {
    readonly target: HighlightTarget;
    readonly anchor: Anchor;
    readonly color: HighlightColor;
    readonly replace_ids?: readonly string[];
  },
): Promise<Highlight> {
  return member.api.ok<Highlight>('POST', '/my-highlights', body, [201]);
}

export function highlightRequest(
  member: Member,
  method: 'GET' | 'PATCH' | 'DELETE' | 'POST',
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  return member.api.request(method, path, body);
}

export async function chapterHighlights(member: Member, chapterId: string): Promise<Highlight[]> {
  const res = await member.api.ok<{ items: Highlight[] }>(
    'GET',
    `/chapters/${chapterId}/my-highlights`,
    undefined,
    [200],
  );
  return res.items;
}

export async function noChapterHighlights(
  member: Member,
  workspaceId: string,
): Promise<Highlight[]> {
  const res = await member.api.ok<{ items: Highlight[] }>(
    'GET',
    `/workspaces/${workspaceId}/my-highlights?chapter=none`,
    undefined,
    [200],
  );
  return res.items;
}

export async function questionHighlights(member: Member, questionId: string): Promise<Highlight[]> {
  const res = await member.api.ok<{ items: Highlight[] }>(
    'GET',
    `/questions/${questionId}/my-highlights`,
    undefined,
    [200],
  );
  return res.items;
}

/** H5: rows of user_highlights in a workspace (fork isolation, superuser read). */
export function highlightRowCount(workspaceId: string): number {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('highlights fixture: invalid uuid');
  try {
    const out = execFileSync(
      'psql',
      [
        localDbAdminUrl(),
        '-v',
        'ON_ERROR_STOP=1',
        '-qAt',
        '-c',
        `select count(*) from public.user_highlights where workspace_id = '${workspaceId}'`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
    return Number(out.trim());
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? '';
    throw new Error(`highlights fixture: psql failed${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    });
  }
}

/** P1 */
export interface QuestionPreview {
  readonly question_id: string;
  readonly number_label: string;
  readonly chapter_title: string | null;
  readonly question_type: string;
  readonly stem: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
}

export function questionPreview(member: Member, questionId: string): Promise<ApiResponse> {
  return member.api.request('GET', `/questions/${questionId}/preview`);
}

/** Keys a preview must never carry (CHNOTE-02-C01), checked anywhere in the JSON. */
export const PREVIEW_FORBIDDEN_KEYS: readonly string[] = [
  'correct_option_ids',
  'correct',
  'is_correct',
  'answer',
  'answers',
  'accepted_answers',
  'rubric',
  'explanation',
  'ai_explanation',
  'highlights',
];

export function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keysIn(v));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => [key, ...keysIn(v)]);
}

/** Keys mentioning highlights anywhere in a parsed JSON value (practice / shared responses). */
export function highlightKeysIn(value: unknown): string[] {
  return keysIn(value).filter((k) => /highlight/i.test(k));
}

// ---------------------------------------------------------------------------------------------
// Browser selection helpers
// ---------------------------------------------------------------------------------------------

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Viewport box of the first occurrence of `text` inside `scope` (one text node, outside hidden
 * highlight labels), or of the range from `text` to `until` when given (may span blocks).
 */
async function textBox(scope: Locator, text: string, until?: string): Promise<Box> {
  const box = await scope.evaluate(
    (root, [needle, end]) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const find = (s: string): { node: Text; offset: number } | null => {
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = (n.nodeValue ?? '').indexOf(s);
          if (i >= 0) return { node: n as Text, offset: i };
        }
        return null;
      };
      const a = find(needle as string);
      if (!a) return null;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      if (end) {
        const b = find(end);
        if (!b) return null;
        range.setEnd(b.node, b.offset + end.length);
      } else {
        range.setEnd(a.node, a.offset + (needle as string).length);
      }
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const first = rects[0];
      const last = rects[rects.length - 1];
      if (!first || !last) return null;
      return {
        left: first.left,
        top: first.top,
        right: last.right,
        bottom: last.bottom,
        firstMid: (first.top + first.bottom) / 2,
        lastMid: (last.top + last.bottom) / 2,
      };
    },
    [text, until ?? ''] as const,
  );
  if (!box) throw new Error('selection helper: the text is not in the area');
  return box;
}

/** Selects `text` (or `text` … `until`) inside `scope` with a real mouse drag. */
export async function dragSelect(scope: Locator, text: string, until?: string): Promise<void> {
  const page = scope.page();
  await scope.scrollIntoViewIfNeeded();
  const box = (await textBox(scope, text, until)) as Box & {
    readonly firstMid: number;
    readonly lastMid: number;
  };
  await page.mouse.move(box.left + 1, box.firstMid);
  await page.mouse.down();
  await page.mouse.move((box.left + box.right) / 2, box.lastMid, { steps: 4 });
  await page.mouse.move(box.right - 1, box.lastMid, { steps: 4 });
  await page.mouse.up();
}

/** Text the document selection holds now. */
export function selectionText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/** Top and bottom edges of the current selection (viewport px). */
export function selectionRect(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { top: -1, bottom: -1 };
    const rects = [...sel.getRangeAt(0).getClientRects()];
    return {
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  });
}

/** Text of the chosen option of a `버전` select (native select or a combobox button). */
export function chosenText(select: Locator): Promise<string> {
  return select.evaluate((el) =>
    el.tagName === 'SELECT'
      ? ((el as HTMLSelectElement).selectedOptions[0]?.text ?? '')
      : (el.textContent ?? ''),
  );
}

/**
 * Touch long-press selection (iPhone WebKit): a touch pointer down/up around a programmatic
 * selection of `text` — the OS selection UI cannot be driven, the app sees the same events.
 */
export async function touchSelect(scope: Locator, text: string): Promise<void> {
  const page = scope.page();
  await scope.scrollIntoViewIfNeeded();
  const box = await textBox(scope, text);
  const x = box.left + 2;
  const y = (box.top + box.bottom) / 2;
  await scope.evaluate(
    (root, [needle, px, py]) => {
      const fire = (type: string) =>
        root.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: 'touch',
            clientX: px as number,
            clientY: py as number,
            isPrimary: true,
          }),
        );
      fire('pointerdown');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.nodeValue ?? '').indexOf(needle as string);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + (needle as string).length);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        break;
      }
      fire('pointerup');
    },
    [text, x, y] as const,
  );
  await page.waitForTimeout(400); // the menu waits for the selection to rest 300 ms
}

/** Whether `target` is what the pointer would hit at its center (nothing covers it). */
export function isOnTop(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && (el.contains(hit) || hit.contains(el));
  });
}

/** Records clipboard writes in the page (no OS clipboard). Call before navigating. */
export async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    const record = async (text: string) => {
      w.__copied.push(text);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText = record;
    } else {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: record } });
    }
  });
}

export function copiedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []);
}

// ---------------------------------------------------------------------------------------------
// UI (HILITE-01, CHNOTE-02)
// ---------------------------------------------------------------------------------------------

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const highlightUi = {
  /** The note body (HighlightableText group inside the note panel). */
  noteBody: (panel: Locator) =>
    panel.getByRole('group', { name: /^(정리 노트 본문|chapter note body|note body)$/i }),
  /** The explanation area (QuestionViewer result or "문제 상세"). */
  explanation: (scope: Locator) => scope.getByRole('group', { name: /^(해설|explanation)$/i }),
  marks: (scope: Locator) => scope.locator('mark[data-highlight-color]'),
  marksOf: (scope: Locator, color: HighlightColor) =>
    scope.locator(`mark[data-highlight-color="${color}"]`),
  markWith: (scope: Locator, text: string) =>
    scope.locator('mark[data-highlight-color]').filter({ hasText: text }),
  startLabel: (color: HighlightColor) =>
    new RegExp(`하이라이트 시작\\(${COLOR_LABEL[color]}\\)|highlight start \\(${color}\\)`, 'i'),
  menu: (page: Page) => page.getByRole('menu', { name: /^(하이라이트|highlight)$/i }),
  colorItem: (menu: Locator, color: HighlightColor) =>
    menu
      .getByRole('menuitemcheckbox', { name: COLOR_NAME[color] })
      .or(menu.getByRole('menuitemradio', { name: COLOR_NAME[color] }))
      .or(menu.getByRole('menuitem', { name: COLOR_NAME[color] })),
  removeItem: (menu: Locator) =>
    menu.getByRole('menuitem', { name: /^(하이라이트 지우기|remove highlight)$/i }),
  copyItem: (menu: Locator) => menu.getByRole('menuitem', { name: /^(복사|copy)$/i }),
  oneBlockReason: (scope: Page | Locator) =>
    scope.getByText(/한 문단 안에서 고르세요|select within one paragraph/i),

  section: (panel: Locator) =>
    panel.getByRole('region', { name: /^(내 하이라이트|my highlights)/i }),
  heading: (section: Locator, n: number) =>
    section.getByRole('heading', {
      level: 3,
      name: new RegExp(`^(내 하이라이트|my highlights) \\(${n}\\)$`, 'i'),
    }),
  anyHeading: (section: Locator) =>
    section.getByRole('heading', { level: 3, name: /^(내 하이라이트|my highlights)/i }),
  onlyMine: (section: Locator) => section.getByText(/나에게만 보입니다|only you can see/i),
  sourceChip: (section: Locator, name: '전체' | '노트' | '해설') =>
    section
      .getByRole('group', { name: /^(출처|source)$/i })
      .getByRole('button', { name: CHIP[name] }),
  colorChip: (section: Locator, name: '전체' | HighlightColor) =>
    section
      .getByRole('group', { name: /^(색|colou?r)$/i })
      .getByRole('button', { name: name === '전체' ? CHIP['전체'] : COLOR_NAME[name] }),
  rows: (section: Locator) =>
    section
      .getByRole('list', { name: /^(내 하이라이트 목록|my highlights list)$/i })
      .getByRole('listitem'),
  row: (section: Locator, text: string | RegExp) =>
    highlightUi.rows(section).filter({ hasText: text }),
  rowMeta: (color: HighlightColor, source: 'note' | 'explanation', detail: string) =>
    new RegExp(
      `${COLOR_LABEL[color]}\\s*·\\s*${source === 'note' ? '노트' : '해설'}\\s*·\\s*${escape(detail)}`,
    ),
  missingBadge: (row: Locator) =>
    row.getByText(/해설이 바뀌어 위치를 찾을 수 없습니다|explanation changed/i),
  rowMenuButton: (row: Locator) =>
    row.getByRole('button', { name: /^(하이라이트 메뉴|highlight menu)$/i }),
  rowMenuItem: (page: Page, name: 'goto' | 'recolor' | 'delete') =>
    page.getByRole('menuitem', { name: ROW_ITEMS[name] }),
  empty: (section: Locator) => section.getByText(/아직 하이라이트가 없습니다|no highlights yet/i),
  filteredEmpty: (section: Locator) =>
    section.getByText(/고른 조건의 하이라이트가 없습니다|no highlights match/i),
  toastRegion: (page: Page) => page.getByRole('region', { name: /알림 \(F8\)|notifications/i }),
  deletedToast: (page: Page) =>
    page
      .getByRole('status')
      .filter({ hasText: /하이라이트를 지웠습니다|highlight (deleted|removed)/i }),
  /** The toast of a successful `복사`. */
  copiedToast: (page: Page) =>
    highlightUi.toastRegion(page).getByText(/^(복사했습니다|copied)\.?$/i),
  /** The toast of a new explanation highlight. */
  collectedToast: (page: Page) =>
    highlightUi
      .toastRegion(page)
      .getByText(/정리 노트의 내 하이라이트에 모았습니다|added to my highlights/i),
  undo: (scope: Page | Locator) => scope.getByRole('button', { name: /^(되돌리기|undo)$/i }),
  noChapterButton: (group: Locator) =>
    group.getByRole('button', { name: /^(내 하이라이트|my highlights)$/i }),
};

const CHIP: Readonly<Record<'전체' | '노트' | '해설', RegExp>> = {
  전체: /^(전체|all)$/i,
  노트: /^(노트|note)$/i,
  해설: /^(해설|explanation)$/i,
};
const ROW_ITEMS: Readonly<Record<'goto' | 'recolor' | 'delete', RegExp>> = {
  goto: /^(위치로 이동|go to (location|highlight))$/i,
  recolor: /^(색 바꾸기|change colou?r)/i,
  delete: /^(삭제|delete)$/i,
};

export const noteToolsUi = {
  answersNotice: (panel: Locator) =>
    panel.getByText(/이 노트에는 문제의 정답과 해설 내용이 들어 있습니다|contains the answers/i),
  oldDisclosure: (panel: Locator) =>
    panel.getByRole('button', { name: /정답·해설 포함|펼쳐서 보기|contains answers/i }),
  search: (panel: Locator) =>
    panel.getByRole('searchbox', { name: /^(노트에서 찾기|find in note)$/i }),
  count: (panel: Locator, k: number, n: number) =>
    panel.getByText(new RegExp(`^${k}\\s*/\\s*${n}$`)),
  noResults: (panel: Locator) => panel.getByText(/^(결과 없음|no results)$/i),
  previous: (panel: Locator) =>
    panel.getByRole('button', { name: /^(이전 결과|previous (result|match))$/i }),
  next: (panel: Locator) =>
    panel.getByRole('button', { name: /^(다음 결과|next (result|match))$/i }),
  results: (panel: Locator) => panel.locator('mark[data-search-result]'),
  current: (panel: Locator) => panel.locator('mark[data-search-result][data-current="true"]'),
  currentLabel: /현재 결과|current (result|match)/i,
  preview: (page: Page) => page.getByRole('tooltip').filter({ hasText: /\d+번\s*·/ }),
  touchPreview: (page: Page) =>
    page.getByRole('dialog', { name: /문제 미리보기|question preview/i }),
  openQuestion: (scope: Locator) =>
    scope.getByRole('button', { name: /^(문제 열기|open question)$/i }),
  previewHeading: (n: number, type = '객관식') =>
    new RegExp(`(?<!\\d)${n}번\\s*·\\s*${escape(type)}`),
};

/** Computed highlight style of a mark (background + underline shape). */
export async function markStyle(
  mark: Locator,
): Promise<{ background: string; line: string; style: string }> {
  return mark.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      line: s.textDecorationLine,
      style: s.textDecorationStyle,
    };
  });
}

/** Chooses a color in the open highlight menu and waits for it to close. */
export async function chooseColor(page: Page, color: HighlightColor): Promise<void> {
  const menu = highlightUi.menu(page);
  await expect(menu).toBeVisible();
  await highlightUi.colorItem(menu, color).click();
  await expect(menu).toBeHidden();
}

/**
 * Presses `key` until `target` has focus (at most `max` presses). Radix menus move focus a task
 * after the key, so each press waits for focus to settle before the next one — pressing again
 * while a move is pending would move from the old item twice and stop short.
 */
export async function pressUntilFocused(
  page: Page,
  target: Locator,
  key = 'ArrowDown',
  max = 4,
): Promise<void> {
  const active = () => page.evaluate(() => document.activeElement?.outerHTML ?? '');
  for (let i = 0; i < max && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    const before = await active();
    await page.keyboard.press(key);
    await expect
      .poll(active, { timeout: 1000 })
      .not.toBe(before)
      .catch(() => undefined);
  }
  await expect(target).toBeFocused();
}

/** Opens a `내 하이라이트` row's menu and chooses `item` (keyboard: Enter on the button). */
export async function chooseRowItem(
  page: Page,
  row: Locator,
  item: 'goto' | 'recolor' | 'delete',
  keyboard = false,
): Promise<void> {
  const button = highlightUi.rowMenuButton(row);
  if (keyboard) {
    await button.focus();
    await page.keyboard.press('Enter');
    const target = highlightUi.rowMenuItem(page, item);
    await expect(target).toBeVisible();
    // The menu focuses its first item once it opens.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role') ?? ''))
      .toMatch(/^menuitem/);
    await pressUntilFocused(page, target);
    await page.keyboard.press(item === 'recolor' ? 'ArrowRight' : 'Enter');
  } else {
    await button.click();
    await highlightUi.rowMenuItem(page, item).click();
  }
}

export const NO_CHAPTER_PANEL = 'chapter=none';
