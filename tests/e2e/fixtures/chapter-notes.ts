// Chapter note (CHNOTE-01) fixtures: the note API helpers, the APP_ENV=test scenario LLM markers
// and hold barrier, the feature-off stack, and the CHNOTE-01 UI label contract. CHNOTE.0 keeps every
// assumption about CHNOTE-B / CHNOTE-W in this header (mirrored by
// tests/integration/questions/chapter_notes/test_chapter_notes_contract.py).
//
// Grounded in the docs (docs/screens/chapter-notes.md, docs/questions.md §9,
// docs/workspace-sharing.md §8, docs/architecture.md §5–§6): routes
// GET /workspaces/{id}/chapter-notes, GET/POST /chapters/{chapterId}/note (`version=`),
// GET /shared/{shareId}/chapter-notes, GET /shared/{shareId}/chapters/{chapterId}/note; job
// `chapter_note.generate {note_id}`; error codes llm_unavailable | llm_timeout |
// note_citation_invalid (+ others → the generic reason); problems no-chapter-questions,
// note-generation-running, note-generation-disabled; worker setting `WORKER_CHAPTER_NOTES`;
// `question_refs` {tag, question_id, question_revision_id, 번호 표시} and `input_fingerprint` fixed
// on the note row; activity `chapter_note.generated` (ids only); a chapter is a Heatmap group =
// one `chapter_id` (an outline node id of a book, docs/screens/questions-overview.md §5), and a
// note follows `(document_id, section_key)` across revisions.
//
// NOT in the docs (CHNOTE.0 assumptions, to confirm or change in CHNOTE-B / CHNOTE-W):
//   N1 GET /chapters/{chapterId}/note[?version=k] → 200 ChapterNoteState for any member (archived
//      workspace too); 404 (one body) for a chapter of another workspace, a deleted document or an
//      unknown id. `chapterId` is the `chapter_id` of the questions (outline node id).
//      ChapterNoteState = {chapter_id, chapter_title, available: bool,
//                          confirmed_question_count: int, generation: NoteGeneration|null,
//                          note: ChapterNote|null, versions: NoteVersion[], stale: bool}
//      `available` = this environment can create notes (WORKER_CHAPTER_NOTES on and an LLM, the
//      scenario fake under APP_ENV=test); `generation` = the chapter's newest generation (any
//      status); `note` = the newest succeeded version, or version k with `version=k`; `versions`
//      newest first; `stale` = the shown note's input fingerprint differs from the chapter's
//      current confirmed questions (computed on read).
//      NoteGeneration = {id, status: queued|running|succeeded|failed, job_id,
//                        error_code: string|null, progress: {batches_done, batches_total}|null}
//      ChapterNote = {id, version, created_at, question_count, input_fingerprint,
//                     question_refs: [{tag, question_id, question_revision_id, label}],
//                     sections: [{heading, items: [{text, footnotes: number[]}]}],
//                     footnotes: [{number, question_id: string|null, label,
//                                  stem_preview: string|null}],
//                     usage: {llm_calls, batches, items, dropped_items, input_tokens?,
//                             output_tokens?, cost_usd?}}
//      `label` = "<n>장 <번호>번" (the Heatmap's chapter number and question number); a footnote
//      whose question is no longer a confirmed question of the chapter has question_id null and
//      stem_preview null (UI: "삭제되었거나 옮긴 문제", no link). Item footnote numbers point
//      into `footnotes`. Never in any response: prompts, raw LLM output, provider messages.
//      NoteVersion = {version, note_id, created_at, question_count}
//   N2 POST /chapters/{chapterId}/note (optional `Idempotency-Key`) → 202 ChapterNoteState with a
//      queued generation; the same key → the same generation. Errors (RFC 9457,
//      urn:quiz-workspace:problem:<slug>): 403 insufficient-role (viewer) / workspace-archived,
//      404 as N1, 409 no-chapter-questions, note-generation-running (a queued/running generation
//      of the chapter exists, different or no key), note-generation-disabled (feature off).
//   N3 GET /workspaces/{id}/chapter-notes → 200 {available, items: [{chapter_id, chapter_title,
//      latest_version: int|null, stale: bool, generating: bool}]} for any member (the Heatmap
//      header's "만드는 중" and the panel list).
//   N4 Shared (share cookie): GET /shared/{shareId}/chapter-notes → 200 {items: [{chapter_id,
//      chapter_title}]} only for chapters whose newest succeeded version is source-matched
//      (every question_refs question alive, CONFIRMED, active revision = the pinned revision);
//      GET /shared/{shareId}/chapters/{chapterId}/note → 200 SharedChapterNote = {chapter_id,
//      chapter_title, created_at, question_count, stale, sections, footnotes} for such a chapter,
//      else the share API's one 404 body. No versions, generation, error_code, usage, job id,
//      input_fingerprint or question_revision_id; footnote question_id only for published
//      confirmed questions.
//   N5 practice-sessions / submit responses never carry a key matching /note/i.
//   N6 Fake LLM (APP_ENV=test only): the worker builds `ScenarioLLMClient.from_file(
//      tests/fixtures/llm/chapter-note-scenarios.json)`; every confirmed question of a chapter
//      under test ends its stem with ` [<marker>]` (NOTE_MARKERS), so the chapter's prompt carries
//      the marker. Task `chapter_notes.generate`; one response per request, the same for the one
//      re-request after a rejection (C02).
//   N7 LLM output schema: {sections: [{heading, items: [{text, tags: ["Q1", ...],
//      quote: string|null}]}]}; tags Q1..Qn in question-number order of the request's questions.
//   N8 Hold barrier of the fake (APP_ENV=test only): NOTE_HOLD_MARKER followed by a token
//      (`E2E-HOLD-NOTE-<token>`) in a question stem makes the fake, when asked for that chapter,
//      create `<hold dir>/<token>.held` and wait (at most 120 s) until `<token>.release` exists
//      (immediately when it already does). The generation is `running` while held. Hold dir =
//      WORKER_CHAPTER_NOTE_HOLD_DIR, default `<system temp dir>/quiz-e2e-chapter-note-hold`
//      (Python tempfile.gettempdir() and Node os.tmpdir() agree for processes of one environment,
//      as e2e:log-audit starts them). This makes "정리 노트를 만드는 중" and the running 409
//      deterministic with a fake that otherwise answers in milliseconds.
//   N9 Feature-off stack (CHNOTE-01-AC06): summary.ts startSummaryOffStack (D8: free ports, a
//      claimed reserved Redis DB, log audit) with WORKER_CHAPTER_NOTES=false for its API, worker
//      and web. The main E2E stack runs with WORKER_CHAPTER_NOTES=true (API and worker).
//   N10 Large-chapter batching (C04, agreed rule): the chapter's questions, in question-number
//      order, are split into contiguous batches, each at most 120 questions and 60,000 input
//      characters, with the fewest batches (greedy fill or balanced sizes are both conforming).
//      Tags are per batch in the request (Q1..Qk) and renumbered chapter-wide (Q1..Qn) when the
//      batches are merged by section heading. C04 seeds 240 questions (two batches of 120 under
//      either partition) and 10 questions of ~7,000 characters (two batches of at least two
//      questions), so no batch is a singleton the OK scenario's Q2 items cannot cite.
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   QOV-01 Heatmap: each chapter group is a region named by the chapter title (QuestionHeatmap
//     `section aria-labelledby`); its header has a text button "<장 제목> 정리 노트" (none in the
//     "챕터 없음" group) and the text "만드는 중" while a generation is queued/running.
//   Panel (FloatingSidePanel, non-modal role=dialog) named "정리 노트": subtitle = chapter title,
//     badge text "AI 생성", meta "문제 n개 기준 · <생성 시각>", stale badge text "문제가 바뀌어
//     최신이 아닙니다", close button "정리 노트 닫기"; combobox "버전" (options "버전 k · <시각>",
//     newest "(최신)") with two or more versions, notice "이전 버전" when an older one is shown;
//     disclosure button "정답·해설 포함 — 펼쳐서 보기" (aria-expanded, aria-controls → the body)
//     with the text "이 노트에는 문제의 정답과 해설 내용이 들어 있습니다."; body: h3 per section,
//     one listitem per item ending in links "각주 k" (href "#<footnote id>"), then list "각주"
//     (ol) whose items read "[^k] <n>장 <번호>번 — <발문 앞 40자>" and are links opening the
//     question (`?question=<id>`; the share page's read-only question panel for guests), or read
//     "… 삭제되었거나 옮긴 문제" without a link. States as text: "아직 정리 노트가 없습니다." +
//     "이 장의 확정 문제 n개와 해설로 정리합니다. 문제와 해설이 AI 서비스로 전송됩니다." + button
//     "정리 노트 만들기" (aria-disabled + description "이 환경에서는 AI 정리 노트를 사용할 수
//     없습니다." when unavailable); "정리 노트를 만드는 중"; alert "정리 노트를 만들지 못했습니다" +
//     reason + "다시 시도"; button "다시 만들기"; "이 장에는 확정된 문제가 없습니다."; "장을 찾을
//     수 없습니다.".
//   Share page (WS-VIEW-01): region "정리 노트" with one button per listed chapter (named by the
//     chapter title) opening the same panel read-only; a chapter without a source-matched note
//     shows only "정리 노트가 갱신 중이거나 없습니다.".
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { apiError, type ApiResponse } from './api.ts';
import { JOB_TIMEOUT_MS } from './documents.ts';
import type { QuestionInput } from './questions.ts';
import { startSummaryOffStack, type SummaryOffStack } from './summary.ts';
import type { Member } from './workspaces.ts';

export const NOTE_MARKERS = {
  ok: 'E2E-NOTE-OK',
  mixed: 'E2E-NOTE-MIXED',
  invalid: 'E2E-NOTE-INVALID',
  fail: 'E2E-NOTE-FAIL',
} as const;
export type NoteScenario = keyof typeof NOTE_MARKERS;

/** Item tokens of tests/fixtures/llm/chapter-note-scenarios.json (never prose). */
export const NOTE_TOKENS = {
  ok: ['NOTE-OK-A', 'NOTE-OK-B', 'NOTE-OK-C'],
  /** E2E-NOTE-MIXED items that survive validation with three questions (C needs Q3). */
  mixedValid: ['NOTE-MIX-A', 'NOTE-MIX-B', 'NOTE-MIX-C', 'NOTE-MIX-D'],
  /** Q99 citation, no footnote, quote not in the book: never stored or shown. */
  mixedInvalid: ['NOTE-MIX-Q99', 'NOTE-MIX-NOTAG', 'NOTE-MIX-BADQUOTE'],
  /** The E2E-NOTE-MIXED item that cites Q3 (dropped once Q3 is gone). */
  mixedNeedsQ3: 'NOTE-MIX-C',
} as const;

export const NOTE_HOLD_MARKER = 'E2E-HOLD-NOTE';
export const NOTE_JOB_TYPE = 'chapter_note.generate';
export const NOTE_TIMEOUT_MS = JOB_TIMEOUT_MS;

export const NOTE_PROBLEMS = {
  noQuestions: 'urn:quiz-workspace:problem:no-chapter-questions',
  running: 'urn:quiz-workspace:problem:note-generation-running',
  disabled: 'urn:quiz-workspace:problem:note-generation-disabled',
} as const;

export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface NoteQuestionRef {
  readonly tag: string;
  readonly question_id: string;
  readonly question_revision_id: string;
  readonly label: string;
}

export interface NoteFootnote {
  readonly number: number;
  readonly question_id: string | null;
  readonly label: string;
  readonly stem_preview: string | null;
}

export interface NoteSection {
  readonly heading: string;
  readonly items: readonly { readonly text: string; readonly footnotes: readonly number[] }[];
}

export interface NoteUsage {
  readonly llm_calls: number;
  readonly batches: number;
  readonly items: number;
  readonly dropped_items: number;
  readonly cost_usd?: number;
}

export interface ChapterNote {
  readonly id: string;
  readonly version: number;
  readonly created_at: string;
  readonly question_count: number;
  readonly input_fingerprint: string;
  readonly question_refs: readonly NoteQuestionRef[];
  readonly sections: readonly NoteSection[];
  readonly footnotes: readonly NoteFootnote[];
  readonly usage: NoteUsage | null;
}

export interface NoteGeneration {
  readonly id: string;
  readonly status: GenerationStatus;
  readonly job_id: string;
  readonly error_code: string | null;
}

export interface NoteVersion {
  readonly version: number;
  readonly note_id: string;
  readonly created_at: string;
  readonly question_count: number;
}

export interface ChapterNoteState {
  readonly chapter_id: string;
  readonly chapter_title: string;
  readonly available: boolean;
  readonly confirmed_question_count: number;
  readonly generation: NoteGeneration | null;
  readonly note: ChapterNote | null;
  readonly versions: readonly NoteVersion[];
  readonly stale: boolean;
}

export function notePath(chapterId: string, version?: number): string {
  return `/chapters/${chapterId}/note${version ? `?version=${version}` : ''}`;
}

export async function getNote(
  member: Member,
  chapterId: string,
  version?: number,
): Promise<ChapterNoteState> {
  return member.api.ok<ChapterNoteState>('GET', notePath(chapterId, version), undefined, [200]);
}

/** `정리 노트 만들기` / `다시 만들기` through the API (N2); raw response, any status. */
export function requestNote(
  member: Member,
  chapterId: string,
  idempotencyKey?: string,
): Promise<ApiResponse<ChapterNoteState>> {
  return member.api.request<ChapterNoteState>(
    'POST',
    notePath(chapterId),
    {},
    idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  );
}

export async function startNote(member: Member, chapterId: string): Promise<ChapterNoteState> {
  const res = await requestNote(member, chapterId);
  if (res.status !== 202) throw apiError('POST', notePath(chapterId), res);
  return res.body as ChapterNoteState;
}

/**
 * Polls GET …/note (no sleeps) until the chapter's newest generation (other than `previousId`)
 * is terminal with `status`; returns that state.
 */
export async function waitForNote(
  member: Member,
  chapterId: string,
  status: 'succeeded' | 'failed',
  previousId?: string,
): Promise<ChapterNoteState> {
  let state: ChapterNoteState | undefined;
  await expect
    .poll(
      async () => {
        state = await getNote(member, chapterId);
        const gen = state.generation;
        if (!gen || gen.id === previousId) return 'no generation yet';
        return gen.status === 'succeeded' || gen.status === 'failed' ? gen.status : 'running';
      },
      { message: `chapter note generation reaches ${status}`, timeout: NOTE_TIMEOUT_MS },
    )
    .toBe(status);
  if (!state) throw new Error('no note state');
  return state;
}

/** Starts a generation and waits until it succeeded; returns the state. */
export async function generateNote(member: Member, chapterId: string): Promise<ChapterNoteState> {
  const before = (await getNote(member, chapterId)).generation?.id;
  await startNote(member, chapterId);
  return waitForNote(member, chapterId, 'succeeded', before);
}

export function listChapterNotes(member: Member, workspaceId: string) {
  return member.api.ok<{
    available: boolean;
    items: {
      chapter_id: string;
      chapter_title: string;
      latest_version: number | null;
      stale: boolean;
      generating: boolean;
    }[];
  }>('GET', `/workspaces/${workspaceId}/chapter-notes`, undefined, [200]);
}

/**
 * Confirmed MCQ numbered `n` in `chapterId` whose stem starts with `label` and ends with the
 * scenario marker (N6) and, when given, a hold token (N8); it has an explanation.
 */
export function noteQuestion(
  label: string,
  n: number,
  chapterId: string | null,
  scenario: NoteScenario,
  extra: Partial<QuestionInput> & { readonly hold?: NoteHold } = {},
): QuestionInput {
  const { hold, ...rest } = extra;
  const options = ['가', '나', '다', '라'].map((x, i) => ({
    id: `opt-${i + 1}`,
    text: `${label}-${n} 보기 ${x}`,
  }));
  const suffix = [` [${NOTE_MARKERS[scenario]}]`, hold ? ` [${hold.marker}]` : ''].join('');
  return {
    question_type: 'MCQ',
    stem: `${label}-${n} 문제: 알맞은 것을 고르시오.${suffix}`,
    options,
    correct_option_ids: ['opt-1'],
    is_multi_answer: false,
    explanation: `${label}-${n} 해설: 첫 번째 보기가 맞다.`,
    chapter_id: chapterId,
    question_number: n,
    ...rest,
  };
}

// ---------------------------------------------------------------------------------------------
// Hold barrier (N8)
// ---------------------------------------------------------------------------------------------

export function noteHoldDir(): string {
  return (
    process.env.WORKER_CHAPTER_NOTE_HOLD_DIR?.trim() || join(tmpdir(), 'quiz-e2e-chapter-note-hold')
  );
}

export class NoteHold {
  readonly token = randomUUID().replace(/-/g, '').slice(0, 16);
  readonly marker = `${NOTE_HOLD_MARKER}-${this.token}`;

  /** Waits until the fake reports this token held (the generation is running). */
  async held(): Promise<void> {
    const file = join(noteHoldDir(), `${this.token}.held`);
    await expect
      .poll(() => existsSync(file), {
        message: 'the chapter note generation reaches the hold barrier',
        timeout: NOTE_TIMEOUT_MS,
      })
      .toBe(true);
  }

  /** Lets the held generation (and any later one of the same token) answer. */
  release(): void {
    mkdirSync(noteHoldDir(), { recursive: true });
    writeFileSync(join(noteHoldDir(), `${this.token}.release`), '');
  }
}

/** The feature-off stack of CHNOTE-01-AC06 (N9). */
export function startChapterNotesOffStack(): Promise<SummaryOffStack> {
  return startSummaryOffStack({ WORKER_CHAPTER_NOTES: 'false' });
}

// ---------------------------------------------------------------------------------------------
// UI (CHNOTE-01)
// ---------------------------------------------------------------------------------------------

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function notePanelPath(workspaceId: string, chapterId: string): string {
  return `/workspaces/${workspaceId}?panel=chapter-note&chapter=${chapterId}`;
}

export function sharedNotePanelPath(shareId: string, chapterId: string): string {
  return `/share/${shareId}?panel=chapter-note&chapter=${chapterId}`;
}

/** Footnote line: "[^k] <n>장 <번호>번 — <발문 앞부분>" (the "[^k]" prefix may be the list number). */
export const FOOTNOTE_LINE = /^\s*(?:\[\^?\d+\]\s*)?(\d+)장\s*(\d+)번\s*[—–-]\s*\S/;
export const FOOTNOTE_GONE = /삭제되었거나 옮긴 문제|deleted or moved/i;

export const noteUi = {
  /** The Heatmap chapter group (region named by the chapter title). */
  group: (page: Page, title: string | RegExp) =>
    page
      .getByRole('main')
      .getByRole('group', { name: /문제 heatmap|heatmap/i })
      .getByRole('region', { name: title }),
  /** Any "… 정리 노트" opener inside `scope`. */
  anyOpener: (scope: Locator) => scope.getByRole('button', { name: /(정리 노트|chapter note)$/i }),
  opener: (scope: Page | Locator, title: string) =>
    scope.getByRole('button', {
      name: new RegExp(`^${escape(title)} (정리 노트|chapter note)$`, 'i'),
    }),
  groupBusy: (group: Locator) => group.getByText(/^(만드는 중|generating)$/i),
  panel: (page: Page) => page.getByRole('dialog', { name: /^(정리 노트|chapter notes?)$/i }),
  close: (panel: Locator) =>
    panel.getByRole('button', { name: /정리 노트 닫기|close( chapter note)?$/i }),
  aiBadge: (panel: Locator) => panel.getByText(/^(AI 생성|AI generated)$/i),
  meta: (panel: Locator) => panel.getByText(/문제\s*\d+개 기준|based on \d+ questions?/i),
  metaCount: (n: number) => new RegExp(`문제\\s*${n}개 기준|based on ${n} questions?`, 'i'),
  stale: (panel: Locator) =>
    panel.getByText(/문제가 바뀌어 최신이 아닙니다|questions changed|out of date/i),
  version: (panel: Locator) => panel.getByRole('combobox', { name: /^(버전|version)/i }),
  previousNotice: (panel: Locator) => panel.getByText(/^(이전 버전|previous version)/i),
  disclosure: (panel: Locator) =>
    panel.getByRole('button', { name: /^(정답·해설 포함|contains answers)/i }),
  disclosureNote: (panel: Locator) =>
    panel.getByText(/이 노트에는 문제의 정답과 해설 내용이 들어 있습니다|contains the answers/i),
  sectionHeadings: (body: Locator) => body.getByRole('heading', { level: 3 }),
  footnoteRefs: (scope: Locator) => scope.getByRole('link', { name: /^(각주|footnote)\s*\d+$/i }),
  footnoteList: (body: Locator) => body.getByRole('list', { name: /^(각주|footnotes)$/i }),
  empty: (panel: Locator) => panel.getByText(/아직 정리 노트가 없습니다|no chapter note yet/i),
  sendNotice: (panel: Locator) =>
    panel.getByText(/문제와 해설이 AI 서비스로 전송됩니다|sent to an AI service/i),
  sendCount: (n: number) => new RegExp(`확정 문제\\s*${n}개|${n} confirmed questions?`, 'i'),
  create: (panel: Locator) =>
    panel.getByRole('button', { name: /^(정리 노트 만들기|create (chapter )?note)$/i }),
  regenerate: (panel: Locator) =>
    panel.getByRole('button', { name: /^(다시 만들기|regenerate)$/i }),
  generating: (panel: Locator) =>
    panel.getByText(/정리 노트를 만드는 중|generating (the )?chapter note/i),
  failure: (panel: Locator) =>
    panel.getByRole('alert').filter({ hasText: /정리 노트를 만들지 못했습니다|note failed/i }),
  genericReason: /정리 노트를 만들지 못했습니다\. 다시 시도하세요|try again/i,
  retry: (panel: Locator) => panel.getByRole('button', { name: /^(다시 시도|retry)$/i }),
  noQuestions: (panel: Locator) =>
    panel.getByText(/이 장에는 확정된 문제가 없습니다|no confirmed questions/i),
  notFound: (panel: Locator) => panel.getByText(/장을 찾을 수 없습니다|chapter not found/i),
  unavailableReason:
    /이 환경에서는 AI 정리 노트를 사용할 수 없습니다|not available in this environment/i,
  sharedCard: (page: Page) => page.getByRole('region', { name: /^(정리 노트|chapter notes)$/i }),
  sharedChapter: (card: Locator, title: string) =>
    card.getByRole('button', { name: new RegExp(`^${escape(title)}$`) }),
  sharedMissing: (panel: Locator) =>
    panel.getByText(/정리 노트가 갱신 중이거나 없습니다|no chapter note is available/i),
};

/** The element the disclosure button controls (the collapsible note body). */
export async function noteBody(panel: Locator): Promise<Locator> {
  const id = await noteUi.disclosure(panel).getAttribute('aria-controls');
  expect(id, 'the disclosure names the body it controls').toBeTruthy();
  return panel.page().locator(`[id="${id}"]`);
}

/**
 * Polls whether `scope`'s text includes `text`. Only `message` is printed on failure, never the
 * page text (it holds answers and explanations: no note content in artifacts).
 */
export async function expectText(
  scope: Locator,
  text: string,
  present: boolean,
  message: string,
): Promise<void> {
  await expect
    .poll(async () => (await scope.innerText().catch(() => '')).includes(text), { message })
    .toBe(present);
}
