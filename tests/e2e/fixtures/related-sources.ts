// Related passages (RELSRC-01, "관련 본문") fixtures: the related-sources API helpers, the seeded
// book (two chapters with the answer concept and a related passage), the APP_ENV=test hold barrier,
// fault and search-call record, DB reads, and the RELSRC-01 UI label contract. RELSRC.0 keeps every
// assumption about RELSRC-B / RELSRC-W in this header (mirrored by
// tests/integration/questions/related_sources/test_related_sources_contract.py); a deliberate change
// is a one-place edit here. Import it directly (not re-exported from fixtures/test.ts).
//
// Grounded in the docs (docs/screens/related-sources.md, docs/questions.md §13,
// docs/workspace-sharing.md §10, docs/architecture.md §5–§6): routes
// GET /questions/{id}/related-sources, GET /shared/{shareId}/questions/{questionId}/related-sources,
// GET /mock-exam-questions/{id}/related-sources; submission proof `practice_session_id` /
// `mock_practice_session_id`, or `view: detail` (registered question, `GET /questions/{id}` right)
// / `view: manage` (mock exam question, edit right, active workspace — ASK-SYNC (a)); problems
// 409 related-before-submit, 409 related-draft-unavailable (DRAFT question with `view: detail`,
// ASK-SYNC (b)), 503 related-unavailable; `degraded: ["dense_unavailable"]` is returned and not
// stored; tables `question_related_sources` / `mock_exam_question_related_sources` keyed by
// (…revision_id, corpus_fingerprint, retrieval_version) with `superseded_at`; at most
// RELATED_SOURCES_LIMIT (5) rows, question-source blocks first; method A (search only, no LLM).
//
// NOT in the docs (RELSRC.0 assumptions, to confirm or change in RELSRC-B / RELSRC-W):
//   R1 Member API: GET /questions/{id}/related-sources?practice_session_id=<uuid> | ?view=detail
//      (query parameters; a GET has no body) → 200 RelatedSources =
//        {id: string|null, question_revision_id, stored: boolean, degraded: string[],
//         items: RelatedSource[]}
//      `id` = the stored list row (the same id for every reader of the key — "같은 행 id"); null
//      and `stored: false` when the list was computed but not stored (archived workspace,
//      degraded search). RelatedSource = {rank (1-based), document_id, document_title,
//      revision_id, chapter_id: string|null, chapter_title: string|null, block_id, page_start,
//      page_end, excerpt (≤ 300 chars), highlights: [{start, end}] (offsets into `excerpt` of the
//      query terms), from_question_source: boolean, stale: boolean (revision no longer the
//      published one), score?: number}. Never a passage body beyond `excerpt`, never the query.
//      Problems are RFC 9457 `urn:quiz-workspace:problem:<slug>`; 404 is the API's one
//      "not found" body (no ids, no passages).
//   R2 Shared API (share cookie): GET /shared/{shareId}/questions/{questionId}/related-sources →
//      200 {items: SharedRelatedSource[]} only when a list is stored for the question's active
//      revision and the current corpus fingerprint; SharedRelatedSource = RelatedSource without
//      score, revision_id, stale and the row id (C01 "점수·키·버전 없음"); else the share API's
//      404. A guest request never computes (no row, no search call).
//   R3 Mock API: GET /mock-exam-questions/{id}/related-sources?mock_practice_session_id=<uuid> |
//      ?view=manage → 200 RelatedSources with `mock_exam_question_revision_id` in place of
//      `question_revision_id`; the same problems.
//   R4 Storage: one row per key (the list; its items are references in a jsonb column) in
//      `question_related_sources (id, question_revision_id, corpus_fingerprint,
//      retrieval_version, superseded_at, created_at, …)` and `mock_exam_question_related_sources
//      (id, mock_exam_question_revision_id, …)`. The fixture counts rows through the revision
//      tables (`question_revisions.question_id`, `mock_exam_question_revisions.
//      mock_exam_question_id`), so a different own column set is fine. RELSRC-B: the rows also
//      carry `question_id` / `mock_exam_question_id` and `items` (references only); exactly one
//      row per question is current. A corpus that comes back (a book added, then deleted) has
//      its earlier key again: that stored row is current again, nothing is recomputed.
//   R5 Hold barrier (APP_ENV=test): `E2E-RELSRC-HOLD-<token>` in a stem makes the computation for
//      that revision — inside the advisory lock, after the "no row yet" re-check, before the
//      search — create `<hold dir>/<token>.held` and wait (≤ 60 s) until `<token>.release` exists
//      (immediately when it already does). Hold dir = RELATED_SOURCES_HOLD_DIR, default
//      `<system temp dir>/quiz-e2e-related-sources-hold` (Python tempfile.gettempdir() and Node
//      os.tmpdir() agree for the processes e2e:log-audit starts).
//   R6 Fault (APP_ENV=test): `E2E-RELSRC-FAIL` in a stem makes the FIRST computation of each
//      (question or mock question) revision fail like a Qdrant outage — 503 related-unavailable,
//      no row — and writes `<fault dir>/<revision id>.failed`; later computations of that
//      revision run normally ("두 번째는 성공"). Fault dir = RELATED_SOURCES_FAULT_DIR, default
//      `<system temp dir>/quiz-e2e-related-sources-faults`.
//   R7 Dense unavailable: SEARCH-01-AC06's `E2E-FAIL-EMBEDDING` in a stem reaches the query (stem +
//      answer), so the query embedder fails as in search: BM25 results, `degraded:
//      ["dense_unavailable"]`, nothing stored. "정상 상태" is the same question after an edit that
//      drops the marker (a new revision; spec ambiguity reported by RELSRC.0).
//   R8 Search-call record (APP_ENV=test): every search the computation runs (one per
//      computation, registered or mock) appends one line to `<call dir>/<revision id>.calls`
//      (question revision id, or mock exam question revision id). Call dir =
//      RELATED_SOURCES_CALL_LOG_DIR, default `<system temp dir>/quiz-e2e-related-sources-calls`.
//      The line holds no text (a timestamp at most).
//   R9 Question sources: the manual question API takes pages only, so the fixture stamps the
//      source row's `block_ids` (the passage the question cites) as the superuser, the way an
//      import or a generation stores them (fixtures/db.ts use 2: state no public API creates).
//      The imported question-PDF source of RELSRC-01-AC06 is a second `question_sources` row with
//      the import run of a real question PDF import (`import_run_id` = imported).
//   R10 Book: book-ko with three blocks corrected through DOC-02 (PATCH /documents/{id}/blocks/
//      {blockId}, POST /documents/{id}/publish): ch1-s1-p1 (p.2) = the answer concept "가나다
//      원리" (the question's source), ch1-s1-p2 (p.2, same page) also names it, ch2-s1-p1 (p.4) =
//      "가나다 응용". The page dedup keeps one row for p.2 (the source row), so the 2장 row follows.
//   R11 The viewer reads the list with a browser GET whose path ends with
//      `/questions/{id}/related-sources` (or `/mock-exam-questions/{id}/related-sources`) and whose
//      body is R1's JSON — the API directly or a Next route handler `/api/…` like the mock exam
//      practice client — not a server action, so a test can read the row id it showed
//      (relatedResponse). The practice panel's own session/submit calls are server actions; the
//      fixture finds the panel's open session in the DB (openSessionId).
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   In the QuestionViewer result area (practice, sequence(bank|mock), manage, read-only), after the
//   result, explanation and AI 해설: disclosure button "관련 본문" (aria-expanded, aria-controls →
//   the body, expanded by default). Body: while loading 3 skeleton lines + role=status
//   "관련 본문을 찾는 중입니다"; then list (ol) named "관련 본문" with one listitem per passage: a
//   button (the row: document title · chapter · `p.12–13` + excerpt with <mark> on the query terms,
//   bold + underline) opening SEARCH-01's excerpt panel (dialog named "본문 발췌" with
//   "PDF에서 보기"), the badge text "문제 출처" on question-source rows, "이전 발행본" on stale rows,
//   and a link "PDF" to DOC-02 at the page (`/workspaces/{ws}/documents/{doc}?page=n`); status
//   "관련 본문 n개" once; empty: status "관련 본문을 찾지 못했습니다."; degraded: the notice
//   "의미 검색을 일시적으로 사용할 수 없어 키워드 결과만 표시합니다" next to the rows; error: alert
//   "관련 본문을 불러오지 못했습니다." + button "다시 시도". Not on drafts; guests only stored lists.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import type { ApiResponse, Problem } from './api.ts';
import {
  block,
  book,
  listDocuments,
  outlineNodeId,
  uploadReadyBook,
  waitForJob,
} from './documents.ts';
import { localDbAdminUrl } from './local-env.ts';
import { createQuestion, mcqInput, type Question, type QuestionInput } from './questions.ts';
import type { Member } from './workspaces.ts';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const PROBLEM = 'urn:quiz-workspace:problem:';
export const RELATED_PROBLEMS = {
  beforeSubmit: `${PROBLEM}related-before-submit`,
  draft: `${PROBLEM}related-draft-unavailable`,
  unavailable: `${PROBLEM}related-unavailable`,
} as const;
export const RELATED_LIMIT = 5;
export const HOLD_MARKER = 'E2E-RELSRC-HOLD';
export const FAIL_MARKER = 'E2E-RELSRC-FAIL';
/** SEARCH-01-AC06's query-embedder fault (R7). */
export const DENSE_MARKER = 'E2E-FAIL-EMBEDDING';
export const HOLD_TIMEOUT_MS = 60_000;

export const KO = book('book-ko');
export const CH1 = '1장 물의 순환';
export const CH2 = '2장 정수 처리';
/** R10: the blocks the book fixture corrects, by truth id (page 2, page 2, page 4). */
export const ANSWER_BLOCK = block(KO, 'ch1-s1-p1');
export const SAME_PAGE_BLOCK = block(KO, 'ch1-s1-p2');
export const APPLIED_BLOCK = block(KO, 'ch2-s1-p1');
export const ANSWER_PAGE = 2;
export const APPLIED_PAGE = 4;

export const ANSWER = '가나다 원리';
export const APPLIED = '가나다 응용';
export const TEXT = {
  answer:
    '가나다 원리: 햇빛의 에너지를 얻은 물 분자가 수증기가 되는 과정을 설명하는 합성 개념이다. ' +
    '가나다 원리는 이 장의 증발 설명 전체에 쓰인다.',
  samePage:
    '가나다 원리 보충: 같은 쪽의 두 번째 구절이며 수증기가 다시 물방울이 되는 과정을 다룬다.',
  applied:
    '가나다 응용: 정수장은 가나다 원리를 응집 공정에 적용해 작은 입자를 플록으로 모은다. ' +
    '가나다 응용은 합성 사례이다.',
  /** AC03: the corrected 2장 passage without the related concept. */
  appliedRemoved: '원수에 응집제를 넣고 천천히 저으면 작은 입자들이 서로 달라붙어 덩어리가 된다.',
  /** AC04: the passage only the question paper prints. */
  paperOnly: '라마바 정답표',
  /** AC04: the passage only the `mixed` book's question segment prints. */
  mixedQuestionOnly: '사아자 해설',
  /** AC04: words no document has. */
  nowhere: 'zqxjv 차카타파 0000',
} as const;

export const WRONG_OPTIONS = ['하늘 법칙', '바람 규칙', '구름 이론'] as const;

export const UI_TEXT = {
  loading: /관련 본문을 찾는 중입니다|finding related passages/i,
  empty: /관련 본문을 찾지 못했습니다|no related passages found/i,
  failed: /관련 본문을 불러오지 못했습니다|could not load related passages/i,
  degraded:
    /의미 검색을 일시적으로 사용할 수 없어 키워드 결과만|semantic search is temporarily unavailable/i,
  sourceBadge: /^(문제 출처|question source)$/i,
  stale: /이전 발행본|earlier published version/i,
} as const;

export function countText(n: number): RegExp {
  return new RegExp(`관련 본문 ${n}개|${n} related passages?`, 'i');
}

// ---------------------------------------------------------------------------------------------
// API (R1–R3)
// ---------------------------------------------------------------------------------------------

export interface RelatedSource {
  readonly rank: number;
  readonly document_id: string;
  readonly document_title: string;
  readonly revision_id?: string;
  readonly chapter_id: string | null;
  readonly chapter_title: string | null;
  readonly block_id: string;
  readonly page_start: number;
  readonly page_end: number;
  readonly excerpt: string;
  readonly highlights?: readonly { readonly start: number; readonly end: number }[];
  readonly from_question_source: boolean;
  readonly stale?: boolean;
}

export interface RelatedSources {
  readonly id: string | null;
  readonly question_revision_id?: string;
  readonly mock_exam_question_revision_id?: string;
  readonly stored: boolean;
  readonly degraded: readonly string[];
  readonly items: readonly RelatedSource[];
}

export type RelatedQuery =
  { readonly practice_session_id: string } | { readonly view: 'detail' } | Record<string, never>;
export type MockRelatedQuery =
  | { readonly mock_practice_session_id: string }
  | { readonly view: 'manage' }
  | Record<string, never>;

function withQuery(path: string, query: Record<string, string>): string {
  const params = new URLSearchParams(query).toString();
  return params ? `${path}?${params}` : path;
}

export function relatedPath(questionId: string, query: RelatedQuery = {}): string {
  return withQuery(`/questions/${questionId}/related-sources`, query as Record<string, string>);
}

export function mockRelatedPath(mockQuestionId: string, query: MockRelatedQuery = {}): string {
  return withQuery(
    `/mock-exam-questions/${mockQuestionId}/related-sources`,
    query as Record<string, string>,
  );
}

export function sharedRelatedPath(shareId: string, questionId: string): string {
  return `/shared/${shareId}/questions/${questionId}/related-sources`;
}

export function requestRelated(
  member: Member,
  questionId: string,
  query: RelatedQuery = {},
): Promise<ApiResponse<RelatedSources>> {
  return member.api.request<RelatedSources>('GET', relatedPath(questionId, query));
}

export function getRelated(
  member: Member,
  questionId: string,
  query: RelatedQuery,
): Promise<RelatedSources> {
  return member.api.ok<RelatedSources>('GET', relatedPath(questionId, query), undefined, [200]);
}

export function requestMockRelated(
  member: Member,
  mockQuestionId: string,
  query: MockRelatedQuery = {},
): Promise<ApiResponse<RelatedSources>> {
  return member.api.request<RelatedSources>('GET', mockRelatedPath(mockQuestionId, query));
}

export function getMockRelated(
  member: Member,
  mockQuestionId: string,
  query: MockRelatedQuery,
): Promise<RelatedSources> {
  return member.api.ok<RelatedSources>(
    'GET',
    mockRelatedPath(mockQuestionId, query),
    undefined,
    [200],
  );
}

/** Asserts an RFC 9457 problem (status + type) and returns its body. */
export function expectProblem(res: ApiResponse, status: number, type?: string): Problem {
  expect(res.status, `HTTP status (${res.text.slice(0, 160)})`).toBe(status);
  const problem = (res.body ?? {}) as Problem;
  if (type) expect(problem.type, 'problem type').toBe(type);
  return problem;
}

/** Keys of a JSON value, recursively (for "no related field in practice responses"). */
export function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysIn(v)]);
  }
  return [];
}

/** Opens a practice session (no run link) and submits `optionIds`; returns the session id. */
export async function submitOnce(
  member: Member,
  questionId: string,
  optionIds: readonly string[],
): Promise<string> {
  const session = await member.api.ok<{ id: string }>(
    'POST',
    `/questions/${questionId}/practice-sessions`,
    {},
    [201],
  );
  await member.api.ok(
    'POST',
    `/practice-sessions/${session.id}/submit`,
    { selected_option_ids: optionIds },
    [200],
  );
  return session.id;
}

/** Submits once and reads the list with that session (computes and stores it the first time). */
export async function submitAndRead(member: Member, question: Question): Promise<RelatedSources> {
  const sessionId = await submitOnce(
    member,
    question.id,
    question.revision.correct_option_ids ?? [],
  );
  return getRelated(member, question.id, { practice_session_id: sessionId });
}

// ---------------------------------------------------------------------------------------------
// Seed: the corrected book (R10), questions with stamped source blocks (R9)
// ---------------------------------------------------------------------------------------------

interface ContentBlock {
  readonly block_id: string;
  readonly text: string;
  readonly page: number;
  readonly chapter_id: string | null;
}

interface BlockList {
  readonly revision: { readonly id: string } | null;
  readonly items: readonly ContentBlock[];
}

export async function listBlocks(member: Member, documentId: string): Promise<BlockList> {
  return member.api.ok<BlockList>(
    'GET',
    `/documents/${documentId}/blocks?limit=500`,
    undefined,
    [200],
  );
}

/** The server block id of the block whose text starts like `text` (a truth block or a stem). */
export async function blockIdOf(
  member: Member,
  documentId: string,
  match: (text: string) => boolean,
): Promise<string> {
  const found = (await listBlocks(member, documentId)).items.find((b) => match(b.text));
  if (!found) throw new Error('related-sources fixture: block not found in the document');
  return found.block_id;
}

/**
 * Corrects blocks through DOC-02 (PATCH /documents/{id}/blocks/{blockId}) and publishes the draft;
 * waits for the indexing job and returns the new active revision id.
 */
export async function correctAndPublish(
  member: Member,
  documentId: string,
  edits: readonly { readonly blockId: string; readonly text: string }[],
): Promise<string> {
  for (const edit of edits) {
    await member.api.ok(
      'PATCH',
      `/documents/${documentId}/blocks/${edit.blockId}`,
      { text: edit.text },
      [200],
    );
  }
  const accepted = await member.api.ok<{ job_id: string; revision_id: string }>(
    'POST',
    `/documents/${documentId}/publish`,
    {},
    [202],
  );
  await waitForJob(member, accepted.job_id);
  await expect
    .poll(async () => (await listBlocks(member, documentId)).revision?.id, {
      message: 'the corrected revision is published',
      timeout: 60_000,
    })
    .toBe(accepted.revision_id);
  return accepted.revision_id;
}

export interface RelsrcBook {
  readonly documentId: string;
  readonly title: string;
  readonly ch1: string;
  readonly ch2: string;
  readonly answerBlockId: string;
  readonly samePageBlockId: string;
  readonly appliedBlockId: string;
  readonly revisionId: string;
}

function startsLike(truth: string): (text: string) => boolean {
  const head = truth.slice(0, 24);
  return (text) => text.startsWith(head);
}

/** book-ko uploaded, then the three R10 passages corrected and published. */
export async function seedRelsrcBook(owner: Member, workspaceId: string): Promise<RelsrcBook> {
  const documentId = await uploadReadyBook(owner, workspaceId, 'book-ko');
  const answerBlockId = await blockIdOf(owner, documentId, startsLike(ANSWER_BLOCK.text));
  const samePageBlockId = await blockIdOf(owner, documentId, startsLike(SAME_PAGE_BLOCK.text));
  const appliedBlockId = await blockIdOf(owner, documentId, startsLike(APPLIED_BLOCK.text));
  const revisionId = await correctAndPublish(owner, documentId, [
    { blockId: answerBlockId, text: TEXT.answer },
    { blockId: samePageBlockId, text: TEXT.samePage },
    { blockId: appliedBlockId, text: TEXT.applied },
  ]);
  // The API names the document by its title (the upload's file name), not the PDF's metadata title.
  const title = (await listDocuments(owner, workspaceId)).find((d) => d.id === documentId)?.title;
  return {
    documentId,
    title: title ?? KO.title,
    ch1: await outlineNodeId(owner, documentId, CH1),
    ch2: await outlineNodeId(owner, documentId, CH2),
    answerBlockId,
    samePageBlockId,
    appliedBlockId,
    revisionId,
  };
}

/** A unique stem; `markers` are appended in brackets (R5–R7). */
export function relsrcStem(label: string, ...markers: string[]): string {
  const tail = markers.map((m) => ` [${m}]`).join('');
  // Short on purpose: the test scorer is the share of query words found in a passage, so a long
  // stem would push the 2장 passage under RELATED_SOURCES_MIN_RELEVANCE; "문제" is in the stem so the
  // 보관·초안 list's row button (named after its stem, /문제|question/) matches the inactiveUi locator.
  return `RELSRC ${label}: 어떤 문제입니까?${tail}`;
}

/** MCQ whose correct option (opt-1) is `answer` (the query's answer text, R1). */
export function relsrcInput(
  label: string,
  s: RelsrcBook,
  extra: Partial<QuestionInput> & { readonly answer?: string; readonly markers?: string[] } = {},
): QuestionInput {
  const { answer = ANSWER, markers = [], ...rest } = extra;
  return {
    ...mcqInput(relsrcStem(label, ...markers), [answer, ...WRONG_OPTIONS], 0),
    explanation: `RELSRC ${label} 해설: 정답은 첫 보기다.`,
    chapter_id: s.ch1,
    sources: [{ document_id: s.documentId, page_start: ANSWER_PAGE, page_end: ANSWER_PAGE }],
    ...rest,
  };
}

/** Creates the question and stamps its book source row with the answer block (R9). */
export async function createSourcedQuestion(
  owner: Member,
  workspaceId: string,
  s: RelsrcBook,
  input: QuestionInput,
): Promise<Question> {
  const question = await createQuestion(owner, workspaceId, input);
  if (input.sources?.length) stampSourceBlocks(question.id, s.documentId, [s.answerBlockId]);
  return question;
}

/** PATCH /questions/{id}: a new revision with `stem` (A1). */
export async function editStem(
  member: Member,
  question: Question,
  stem: string,
): Promise<Question> {
  return member.api.ok<Question>(
    'PATCH',
    `/questions/${question.id}`,
    { base_revision_id: question.revision.id, stem },
    [200],
  );
}

export function correctText(question: Question): string {
  const ids = question.revision.correct_option_ids ?? [];
  return question.revision.options.find((o) => ids.includes(o.id))?.text ?? '';
}

// ---------------------------------------------------------------------------------------------
// Hold barrier (R5), fault dir (R6), search-call record (R8)
// ---------------------------------------------------------------------------------------------

function dirOf(env: string, name: string): string {
  return process.env[env]?.trim() || join(tmpdir(), name);
}

export function holdDir(): string {
  return dirOf('RELATED_SOURCES_HOLD_DIR', 'quiz-e2e-related-sources-hold');
}

export function faultDir(): string {
  return dirOf('RELATED_SOURCES_FAULT_DIR', 'quiz-e2e-related-sources-faults');
}

export function callDir(): string {
  return dirOf('RELATED_SOURCES_CALL_LOG_DIR', 'quiz-e2e-related-sources-calls');
}

/** A per-test hold token: put `marker` in a stem, wait for `held`, then `release`. */
export class RelsrcHold {
  readonly token = randomUUID().replace(/-/g, '').slice(0, 16);
  readonly marker = `${HOLD_MARKER}-${this.token}`;

  #file(ext: string): string {
    return join(holdDir(), `${this.token}.${ext}`);
  }

  async held(timeout = HOLD_TIMEOUT_MS): Promise<void> {
    await expect
      .poll(() => existsSync(this.#file('held')), {
        message: 'the related-sources computation reaches the hold barrier (R5)',
        timeout,
      })
      .toBe(true);
  }

  release(): void {
    mkdirSync(holdDir(), { recursive: true });
    writeFileSync(this.#file('release'), '');
  }

  cleanup(): void {
    for (const ext of ['held', 'release']) rmSync(this.#file(ext), { force: true });
  }
}

/** Searches the computation ran for a (question or mock question) revision (R8). */
export function searchCalls(revisionId: string): number {
  const file = join(callDir(), `${revisionId}.calls`);
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim()).length;
}

export function clearFaults(revisionId: string): void {
  rmSync(join(faultDir(), `${revisionId}.failed`), { force: true });
}

// ---------------------------------------------------------------------------------------------
// DB superuser (R4, R9; fixtures/db.ts rules)
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCK_ID = /^[\w.:-]{1,200}$/;

function id(value: string): string {
  if (!UUID.test(value)) throw new Error('related-sources fixture: invalid uuid');
  return `'${value}'`;
}

function blockIds(ids: readonly string[]): string {
  for (const b of ids) if (!BLOCK_ID.test(b)) throw new Error('related-sources fixture: block id');
  return `array[${ids.map((b) => `'${b}'`).join(',')}]::text[]`;
}

function psql(sql: string): string {
  try {
    return execFileSync('psql', [localDbAdminUrl(), '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? '';
    throw new Error(`related-sources fixture: psql failed${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    });
  }
}

/** R9: the question's source row of `documentId` cites `ids`. */
export function stampSourceBlocks(questionId: string, documentId: string, ids: readonly string[]) {
  const n = psql(
    `with u as (update public.question_sources set block_ids = ${blockIds(ids)} ` +
      `where question_id = ${id(questionId)} and document_id = ${id(documentId)} returning 1) ` +
      `select count(*) from u`,
  );
  if (n !== '1') throw new Error('related-sources fixture: question source row not found');
}

/** R9: adds an imported question-PDF source (the paper's `page`, `ids`) to the question. */
export function addImportedSource(
  questionId: string,
  paperDocumentId: string,
  importRunId: string,
  page: number,
  ids: readonly string[],
): void {
  if (!Number.isInteger(page) || page < 1) throw new Error('related-sources fixture: page');
  psql(
    `insert into public.question_sources (workspace_id, question_id, document_id, ` +
      `document_revision_id, page_start, page_end, block_ids, import_run_id) ` +
      `select q.workspace_id, q.id, d.id, d.active_revision_id, ${page}, ${page}, ` +
      `${blockIds(ids)}, ${id(importRunId)} from public.questions q ` +
      `join public.documents d on d.id = ${id(paperDocumentId)} where q.id = ${id(questionId)}`,
  );
}

function tableMissing(table: string): boolean {
  return psql(`select to_regclass('public.${table}') is null`) === 't';
}

function requireTable(table: string): void {
  if (tableMissing(table)) {
    throw new Error(`table public.${table} does not exist (RELSRC-B migration not applied)`);
  }
}

/** Stored lists of every revision of the question (R4). */
export function relatedRowCount(questionId: string): number {
  requireTable('question_related_sources');
  return Number(
    psql(
      `select count(*) from public.question_related_sources s join public.question_revisions r ` +
        `on r.id = s.question_revision_id where r.question_id = ${id(questionId)}`,
    ),
  );
}

/** Rows (oldest first) of the question's stored lists: id, revision, superseded or not (R4). */
export function relatedRows(
  questionId: string,
): { readonly id: string; readonly revisionId: string; readonly superseded: boolean }[] {
  requireTable('question_related_sources');
  const out = psql(
    `select s.id || '|' || s.question_revision_id || '|' || (s.superseded_at is not null) ` +
      `from public.question_related_sources s join public.question_revisions r ` +
      `on r.id = s.question_revision_id where r.question_id = ${id(questionId)} ` +
      `order by s.created_at, s.id`,
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [rowId = '', revisionId = '', superseded = ''] = line.split('|');
      return { id: rowId, revisionId, superseded: superseded === 'true' };
    });
}

/** Stored lists of every revision of the mock exam question (R4). */
export function mockRelatedRowCount(mockQuestionId: string): number {
  requireTable('mock_exam_question_related_sources');
  return Number(
    psql(
      `select count(*) from public.mock_exam_question_related_sources s ` +
        `join public.mock_exam_question_revisions r on r.id = s.mock_exam_question_revision_id ` +
        `where r.mock_exam_question_id = ${id(mockQuestionId)}`,
    ),
  );
}

/** The user's newest unsubmitted practice session of the question (the panel's, R11). */
export async function openSessionId(userId: string, questionId: string): Promise<string> {
  let found = '';
  await expect
    .poll(
      () =>
        (found = psql(
          `select id from public.practice_sessions where user_id = ${id(userId)} and ` +
            `question_id = ${id(questionId)} and submitted_at is null ` +
            `order by opened_at desc, id limit 1`,
        )),
      { message: 'the practice panel opened a session', timeout: 15_000 },
    )
    .not.toBe('');
  return found;
}

/** Practice sessions and attempts of a user on a question (unchanged by related reads). */
export function practiceFootprint(userId: string, questionId: string): string {
  return psql(
    `select (select count(*) from public.practice_sessions where user_id = ${id(userId)} ` +
      `and question_id = ${id(questionId)}) || '/' || (select count(*) from ` +
      `public.question_attempts where user_id = ${id(userId)} and question_id = ${id(questionId)})`,
  );
}

// ---------------------------------------------------------------------------------------------
// UI (RELSRC-01)
// ---------------------------------------------------------------------------------------------

const NAME = /^(관련 본문|related passages)$/i;

export const relatedUi = {
  toggle: (scope: Locator) => scope.getByRole('button', { name: NAME }),
  list: (scope: Locator) => scope.getByRole('list', { name: NAME }),
  rows: (scope: Locator) => relatedUi.list(scope).getByRole('listitem'),
  row: (scope: Locator, k: number) => relatedUi.rows(scope).nth(k),
  open: (row: Locator) => row.getByRole('button').first(),
  pdf: (row: Locator) => row.getByRole('link', { name: /^PDF$/i }),
  badge: (row: Locator) => row.getByText(UI_TEXT.sourceBadge),
  marks: (row: Locator) => row.locator('mark'),
  status: (scope: Locator, text: RegExp) => scope.getByRole('status').filter({ hasText: text }),
  alert: (scope: Locator) => scope.getByRole('alert').filter({ hasText: UI_TEXT.failed }),
  retry: (scope: Locator) => scope.getByRole('button', { name: /^(다시 시도|try again)$/i }),
  degraded: (scope: Locator) => scope.getByText(UI_TEXT.degraded),
  excerptPanel: (page: Page) =>
    page.getByRole('dialog', { name: /본문 발췌|발췌|excerpt/i }).last(),
  openInPdf: (panel: Locator) =>
    panel
      .getByRole('button', { name: /pdf에서 (보기|열기)|open in pdf/i })
      .or(panel.getByRole('link', { name: /pdf에서 (보기|열기)|open in pdf/i })),
};

/** The disclosure's body (`aria-controls`), where the states and the list live. */
export async function relatedBody(scope: Locator): Promise<Locator> {
  const toggle = relatedUi.toggle(scope);
  await expect(toggle, 'the "관련 본문" disclosure is shown').toBeVisible();
  const controls = await toggle.getAttribute('aria-controls');
  expect(controls, '"관련 본문" names its body with aria-controls').toBeTruthy();
  return scope.page().locator(`[id="${controls}"]`);
}

/** `p.4`, `p.4–5` for a row, as the UI prints a page range. */
export function pageText(page: number): RegExp {
  return new RegExp(`p\\.\\s*${page}(?!\\d)|(?<!\\d)${page}\\s*쪽|page\\s*${page}(?!\\d)`, 'i');
}

/** The page numbers each row prints (first number after `p.`). */
export async function rowPages(scope: Locator): Promise<number[]> {
  const texts = await relatedUi.rows(scope).allInnerTexts();
  return texts.map((t) => Number(/p\.\s*(\d+)/i.exec(t)?.[1] ?? /(\d+)\s*쪽/.exec(t)?.[1] ?? NaN));
}

/**
 * Waits for the related-sources response the page reads for `questionId` (R1/R3, R11) and returns
 * its body. The returned promise is already marked handled, so a test that fails before awaiting
 * it reports its own assertion, not this wait.
 */
export function relatedResponse(
  page: Page,
  kind: 'questions' | 'mock-exam-questions',
  questionId: string,
): Promise<RelatedSources> {
  const read = page
    .waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        new URL(r.url()).pathname.endsWith(`/${kind}/${questionId}/related-sources`) &&
        r.status() === 200,
      { timeout: 60_000 },
    )
    .then((r) => r.json() as Promise<RelatedSources>);
  read.catch(() => undefined);
  return read;
}
