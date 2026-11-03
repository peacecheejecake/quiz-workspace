// Question source preview (QSRC-01, "문제 원문 보기") fixtures: the source-region API helpers, the
// seeded workspace (a question paper imported through the real import flow, a two-page region, a
// manual question, a book-source-only question, `보기 섞기` mock exams), the traffic watcher and the
// QSRC-01 UI label contract. QSRC.0 keeps every assumption about QSRC-API / QSRC-UI in this header
// (mirrored by tests/integration/questions/source_region/test_source_region_contract.py); a
// deliberate change is a one-place edit here. Import it directly (not re-exported from
// fixtures/test.ts).
//
// Grounded in the docs (docs/screens/question-source-preview.md, docs/questions.md §16,
// docs/design-system.md §5.6, docs/architecture.md §6): routes GET /questions/{id}/source-region and
// GET /mock-exam-questions/{id}/source-region (any member; 404 without import provenance); the PDF
// itself comes from the existing GET /documents/{id}/source-url relay.
//
// NOT in the docs (QSRC.0 assumptions, to confirm or change in QSRC-API / QSRC-UI):
//   S1 Member API: GET /questions/{id}/source-region → 200
//        {question_id: string, regions: [{document_id, document_revision_id, page (1-based),
//         bbox: {x0, y0, x1, y1}}]}
//      one region per (document, page), ascending by page; bbox in PDF points with the origin at
//      the page's top left (the convention of the import drafts' `bbox`, tests/fixtures/pdfs/
//      questions-ko.truth.json). Nothing else: no text, options, answers, explanations, block ids.
//      A 404 is the API's one "not found" body (no ids, no detail about why).
//   S2 Mock API: GET /mock-exam-questions/{id}/source-region → 200 {mock_exam_question_id,
//      regions: [...]} (same region shape) when the mock question's ORIGIN question has import
//      provenance; 404 otherwise.
//   S3 Imported questions come from the real import flow (questions-ko.pdf as `question_paper`,
//      approve + publish drafts of questions 1 and 5): the publish copies the drafts' evidence
//      `locations` ({page, bbox}) to `question_sources` rows with `import_run_id`. The fake
//      extractor (APP_ENV=test) fills each draft's bbox; the fixture reads the stored locations
//      through the superuser only to build the two-page case.
//   S4 Two-page region: no API creates a source that crosses pages and the synthetic paper has no
//      such question, so the fixture appends a second location (page 1, the bbox of question 4) to
//      question 5's import source row as the superuser, the way an import of a question that
//      continues from the previous page stores it. Question 5 then has regions on p.1 and p.2.
//   S5 Evidence-only question: the manual question API stores `question_sources` rows without an
//      import run (document + pages only); the fixture points one at book-ko page 2.
//   S8 AI-varied mock question: `mock_exam_questions.variation_type` other than OPTION_SHUFFLE has
//      no region (404) and no button, even when its origin question is imported; the fixture
//      turns a shuffle mock into one as the superuser (setMockVariation).
//   S9 Deleted source PDF: `DELETE /documents/{id}` on the question paper makes its questions'
//      regions 404 (button hidden); the questions themselves stay.
//   S6 UI contract (Korean first, English accepted; AGENTS.md §5):
//      - button "문제 원문 보기" in the question body header of the QuestionViewer (practice,
//        sequence(bank|mock), manage, manage(mock)); hidden (not disabled) without a region.
//      - hover / :focus-visible / touch long-press (500 ms) on it opens role=tooltip containing the
//        region as role=img named "문제 원문 p.<n>" (one per page, stacked); the button points at
//        the tooltip with aria-describedby; Escape or a tap outside (inside the panel) closes only
//        the tooltip; a long-press does not click.
//      - click / Enter / tap opens role=dialog named "문제 원문" with the same figures (the
//        displayed box has the bbox's aspect ratio), a header button "닫기", no page or zoom
//        controls. >= 768px: to the left of the question panel; < 768px: a full-screen sheet.
//        The dialog adds no URL change; narrow Back closes it.
//   S7 Traffic: the viewer's region request is a browser GET whose path ends with
//      `/questions/{id}/source-region` or `/mock-exam-questions/{id}/source-region` (the API
//      directly or a Next route handler `/api/...`, not a server action) so a test can read it; the
//      PDF comes from a request whose path contains `/source-url`.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Locator, Page, Response } from '@playwright/test';
import type { ApiResponse } from './api.ts';
import { uploadReadyBook } from './documents.ts';
import { localDbAdminUrl } from './local-env.ts';
import {
  answerKeysIn,
  createQuestion,
  draftFor,
  getQuestion,
  importPaperDrafts,
  listDrafts,
  mcqInput,
  publishDrafts,
  questionPaper,
  truthQuestion,
  type Question,
  type TruthQuestion,
} from './questions.ts';
import { createShuffleMockExam } from './practice-runs.ts';
import type { Member, WorkspaceFactory } from './workspaces.ts';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const PAPER = questionPaper();
/** Imported question 1: one region on page 1. */
export const SINGLE_NUMBER = 1;
/** Imported question 5 (paper page 2); its source also gets a page-1 location (S4). */
export const TWO_PAGE_NUMBER = 5;
/** The page-1 question whose bbox S4 adds to question 5. */
export const CONTINUED_FROM_NUMBER = 4;
/** The answer-key page of the paper (tests/fixtures/pdfs/questions-ko.truth.json). */
export const ANSWER_KEY_PAGE = 3;
export const PAGE_HEIGHT_PT = 841.89;
/** Visible-text patterns of the answer-key page and the running footer that must never show. */
export const ANSWER_KEY_TEXT =
  /1\.\s*②|2\.\s*A,\s*C,\s*D|4\.\s*응결|5\.\s*②|8\.\s*B,\s*D|-\s*3\s*-/;
/** Region of an AI-free `보기 섞기` mock exam is the origin question's. */
export const MANUAL_NUMBER = 101;
export const BOOK_ONLY_NUMBER = 102;

export const BUTTON_NAME = /^(문제 원문 보기|view (the )?question source)$/i;
export const LONG_PRESS_MS = 500;

export function truth(n: number): TruthQuestion {
  return truthQuestion(PAPER, n);
}

/** The option text that is correct for imported question `n` (single-answer MCQ). */
export function correctText(n: number): string {
  const q = truth(n);
  const label = q.answer?.correct_option_labels?.[0];
  const option = q.options.find((o) => o.label === label);
  if (!option) throw new Error(`questions-ko question ${n} has no single correct option`);
  return option.text;
}

// ---------------------------------------------------------------------------------------------
// API (S1, S2)
// ---------------------------------------------------------------------------------------------

export interface BBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface SourceRegion {
  readonly document_id: string;
  readonly document_revision_id: string;
  readonly page: number;
  readonly bbox: BBox;
}

export interface SourceRegions {
  readonly question_id?: string;
  readonly mock_exam_question_id?: string;
  readonly regions: readonly SourceRegion[];
}

export function sourceRegionPath(questionId: string): string {
  return `/questions/${questionId}/source-region`;
}

export function mockSourceRegionPath(mockQuestionId: string): string {
  return `/mock-exam-questions/${mockQuestionId}/source-region`;
}

export function requestSourceRegion(
  member: Member,
  questionId: string,
): Promise<ApiResponse<SourceRegions>> {
  return member.api.request<SourceRegions>('GET', sourceRegionPath(questionId));
}

export function requestMockSourceRegion(
  member: Member,
  mockQuestionId: string,
): Promise<ApiResponse<SourceRegions>> {
  return member.api.request<SourceRegions>('GET', mockSourceRegionPath(mockQuestionId));
}

export function ratio(b: BBox): number {
  return (b.x1 - b.x0) / (b.y1 - b.y0);
}

/** Keys a region response may carry (S1); anything else is a leak (C01). */
export const REGION_KEYS: ReadonlySet<string> = new Set([
  'question_id',
  'mock_exam_question_id',
  'regions',
  'document_id',
  'document_revision_id',
  'page',
  'bbox',
  'x0',
  'y0',
  'x1',
  'y1',
]);

export function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => [key, ...keysIn(v)]);
}

/** Every key of the response outside the documented shape, plus any answer key. */
export function unexpectedKeys(body: unknown): string[] {
  return [
    ...keysIn(body).filter((k) => !REGION_KEYS.has(k)),
    ...answerKeysIn(body).map((path) => `answer key ${path}`),
  ];
}

// ---------------------------------------------------------------------------------------------
// DB (superuser; docs/implementation-plan.md §7: no test-only seed endpoints)
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(value: string): string {
  if (!UUID.test(value)) throw new Error('question-source fixture: invalid uuid');
  return `'${value}'`;
}

function psql(sql: string): string {
  try {
    return execFileSync('psql', [localDbAdminUrl(), '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? '';
    throw new Error(`question-source fixture: psql failed${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    });
  }
}

/** The stored import-provenance locations of a question (S3), for building S4 and for checks. */
export function importLocations(questionId: string): { page: number; bbox?: BBox }[] {
  const out = psql(
    `select coalesce(jsonb_agg(l), '[]'::jsonb) from public.question_sources s, ` +
      `jsonb_array_elements(s.locations) l where s.question_id = ${id(questionId)} ` +
      `and s.import_run_id is not null`,
  ).trim();
  return JSON.parse(out || '[]') as { page: number; bbox?: BBox }[];
}

/** The document an imported question's source row cites (the question paper). */
export function importDocumentId(questionId: string): string {
  const out = psql(
    `select document_id from public.question_sources where question_id = ${id(questionId)} ` +
      `and import_run_id is not null order by created_at, id limit 1`,
  ).trim();
  if (!out) throw new Error('question-source fixture: question has no import source row');
  return out;
}

/**
 * S8: marks a mock question as AI-varied. No LLM runs in E2E and `variation_type` is append-only
 * for the API, so the superuser sets it (past the trigger) on a `보기 섞기` question.
 */
export function setMockVariation(mockQuestionId: string, type: string): void {
  if (!/^[A-Z_]+$/.test(type)) throw new Error('question-source fixture: variation type');
  psql(
    `begin; set local session_replication_role = replica; ` +
      `update public.mock_exam_questions set variation_type = '${type}' ` +
      `where id = ${id(mockQuestionId)}; commit;`,
  );
  const now = psql(
    `select variation_type from public.mock_exam_questions where id = ${id(mockQuestionId)}`,
  ).trim();
  if (now !== type) throw new Error('question-source fixture: variation was not set');
}

/** S4: adds a location on `page` to the question's import source row. */
export function addImportLocation(questionId: string, page: number, bbox: BBox): void {
  if (!Number.isInteger(page) || page < 1) throw new Error('question-source fixture: page');
  const box = `jsonb_build_object('x0', ${bbox.x0}, 'y0', ${bbox.y0}, 'x1', ${bbox.x1}, 'y1', ${bbox.y1})`;
  const updated = psql(
    `update public.question_sources set ` +
      `locations = locations || jsonb_build_array(jsonb_build_object('page', ${page}, 'bbox', ${box})), ` +
      `page_start = least(coalesce(page_start, ${page}), ${page}), ` +
      `page_end = greatest(coalesce(page_end, ${page}), ${page}) ` +
      `where id = (select id from public.question_sources where question_id = ${id(questionId)} ` +
      `and import_run_id is not null order by created_at, id limit 1) returning id`,
  ).trim();
  if (!updated) throw new Error('question-source fixture: no import source row to extend');
}

// ---------------------------------------------------------------------------------------------
// Seeded workspace (S3, S4, S5)
// ---------------------------------------------------------------------------------------------

export interface MockQuestion {
  readonly id: string;
  readonly revision: { readonly id: string };
}

export interface MockOf {
  readonly examId: string;
  readonly title: string;
  readonly question: MockQuestion;
}

export interface SourceSeed {
  readonly owner: Member;
  readonly workspaceId: string;
  readonly paperDocumentId: string;
  /** Imported question 1: one page-1 region. */
  readonly single: Question;
  /** Imported question 5: regions on p.1 and p.2 (S4). */
  readonly twoPage: Question;
  /** A manual question: no sources at all. */
  readonly manual: Question;
  /** A manual question whose source is a book page (S5): no import provenance. */
  readonly bookOnly: Question | undefined;
  /** `보기 섞기` mock exam of the imported question 1 / of the manual question. */
  readonly mockImported: MockOf | undefined;
  readonly mockManual: MockOf | undefined;
  /** A `보기 섞기` mock of question 1 turned into an AI-varied one (PARAPHRASE) by the DB (S8). */
  readonly mockVaried: MockOf | undefined;
}

export interface SeedOptions {
  readonly book?: boolean;
  readonly mocks?: boolean;
}

export function stemOf(q: Question): string {
  return q.revision.stem;
}

async function mockOf(
  owner: Member,
  workspaceId: string,
  title: string,
  question: Question,
): Promise<MockOf> {
  const exam = await createShuffleMockExam(owner, workspaceId, title, [question.id], 1);
  const items = await owner.api.ok<{ items: MockQuestion[] }>(
    'GET',
    `/mock-exams/${exam.id}/questions?include=answers`,
    undefined,
    [200],
  );
  const first = items.items[0];
  if (!first) throw new Error('question-source fixture: mock exam has no question');
  return { examId: exam.id, title, question: first };
}

/**
 * A workspace with questions-ko.pdf imported and questions 1 and 5 registered through the import
 * flow (S3), question 5 extended to two pages (S4), a manual question, optionally a book-source
 * question (S5) and `보기 섞기` mock exams of the imported question 1 and of the manual question.
 */
export async function seedQuestionSource(
  workspaceFactory: WorkspaceFactory,
  label: string,
  options: SeedOptions = {},
): Promise<SourceSeed> {
  const owner = await workspaceFactory.member(label);
  const ws = await workspaceFactory.create(owner);
  const { run, drafts } = await importPaperDrafts(owner, ws.id);
  const d1 = draftFor(drafts, truth(SINGLE_NUMBER));
  const d5 = draftFor(drafts, truth(TWO_PAGE_NUMBER));
  await publishDrafts(owner, run.id, [d1.id, d5.id]);
  const published = new Map(
    (await listDrafts(owner, run.id)).map((d) => [d.id, d.published_question_id]),
  );
  const q1id = published.get(d1.id);
  const q5id = published.get(d5.id);
  if (!q1id || !q5id) throw new Error('question-source fixture: drafts were not registered');
  const paperDocumentId = importDocumentId(q1id);

  const prior = truth(CONTINUED_FROM_NUMBER);
  const priorBox = (prior as unknown as { bbox: BBox }).bbox;
  addImportLocation(q5id, prior.page, priorBox);

  const tag = randomUUID().slice(0, 6);
  const manual = await owner.api.ok<Question>(
    'POST',
    `/workspaces/${ws.id}/questions`,
    {
      ...mcqInput(`QSRC 직접 만든 문제 ${tag}: 물이 수증기가 되는 과정은?`, [
        '증발',
        '응결',
        '강수',
        '침전',
      ]),
      question_number: MANUAL_NUMBER,
    },
    [201],
  );
  let bookOnly: Question | undefined;
  if (options.book) {
    const bookDoc = await uploadReadyBook(owner, ws.id, 'book-ko');
    bookOnly = await createQuestion(owner, ws.id, {
      ...mcqInput(`QSRC 교재 근거 문제 ${tag}: 교재 2쪽이 출처인 문제는?`, [
        '맞는 보기',
        '틀린 보기 1',
        '틀린 보기 2',
        '틀린 보기 3',
      ]),
      question_number: BOOK_ONLY_NUMBER,
      sources: [{ document_id: bookDoc, page_start: 2, page_end: 2 }],
    });
  }
  const single = await getQuestion(owner, q1id);
  const twoPage = await getQuestion(owner, q5id);
  const mockImported = options.mocks
    ? await mockOf(owner, ws.id, `원문 모의 ${tag}`, single)
    : undefined;
  const mockManual = options.mocks
    ? await mockOf(owner, ws.id, `직접 모의 ${tag}`, manual)
    : undefined;
  const mockVaried = options.mocks
    ? await mockOf(owner, ws.id, `변형 모의 ${tag}`, single)
    : undefined;
  if (mockVaried) setMockVariation(mockVaried.question.id, 'PARAPHRASE');
  return {
    owner,
    workspaceId: ws.id,
    paperDocumentId,
    single,
    twoPage,
    manual,
    bookOnly,
    mockImported,
    mockManual,
    mockVaried,
  };
}

// ---------------------------------------------------------------------------------------------
// Traffic watcher (S7)
// ---------------------------------------------------------------------------------------------

const REGION_PATH = /\/(?:questions|mock-exam-questions)\/([0-9a-f-]{36})\/source-region$/;

export interface RegionTraffic {
  /** Final status of each region request, by question / mock question id. */
  readonly statuses: Map<string, number>;
  /** Parsed JSON body of each 200 region response. */
  readonly bodies: ReadonlyMap<string, unknown>;
  /** Number of requests for the PDF relay (`/source-url`). */
  pdfRequests(): number;
  /** Number of region requests of any id. */
  regionRequests(): number;
}

/** Records the viewer's region and PDF-relay traffic until the page closes. */
export function watchRegionTraffic(page: Page): RegionTraffic {
  const statuses = new Map<string, number>();
  const bodies = new Map<string, unknown>();
  let pdf = 0;
  let regions = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/source-url')) pdf += 1;
    if (REGION_PATH.test(path)) regions += 1;
  });
  page.on('response', (response: Response) => {
    const match = REGION_PATH.exec(new URL(response.url()).pathname);
    if (!match?.[1]) return;
    statuses.set(match[1], response.status());
    if (response.status() === 200) {
      void response
        .json()
        .then((json: unknown) => bodies.set(match[1] as string, json))
        .catch(() => undefined);
    }
  });
  return { statuses, bodies, pdfRequests: () => pdf, regionRequests: () => regions };
}

// ---------------------------------------------------------------------------------------------
// UI contract (S6)
// ---------------------------------------------------------------------------------------------

export const sourceUi = {
  button: (scope: Locator | Page) => scope.getByRole('button', { name: BUTTON_NAME }),
  tooltip: (page: Page) => page.getByRole('tooltip'),
  dialog: (page: Page) => page.getByRole('dialog', { name: /^(문제 원문|question source)$/i }),
  close: (dialog: Locator) => dialog.getByRole('button', { name: /^(닫기|close)$/i }),
  retry: (dialog: Locator) => dialog.getByRole('button', { name: /^(다시 시도|try again)$/i }),
  figures: (scope: Locator) =>
    scope.getByRole('img', { name: /^(문제 원문|question source) p\.\d+/i }),
  figure: (scope: Locator, pageNumber: number) =>
    scope.getByRole('img', {
      name: new RegExp(`^(문제 원문|question source) p\\.${pageNumber}(?!\\d)`, 'i'),
    }),
  /** Controls a region view must not have: page moves, zoom, scrolling aids, downloads. */
  forbiddenControls: (dialog: Locator) =>
    dialog.getByRole('button', {
      name: /쪽|페이지|확대|축소|zoom|page|next|previous|download|다운로드/i,
    }),
};

/** The question panel by its stem, found even while it is `inert` and outside the a11y tree. */
export function panelByStem(page: Page, stem: string): Locator {
  return page.locator('[role="dialog"]').filter({ hasText: stem }).first();
}

/** Whether the element is (inside) an `inert` subtree. */
export function isInert(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.matches(':is([inert], [inert] *)'));
}

/** Displayed width / height of an element. */
export async function displayedRatio(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box || box.height === 0) throw new Error('element has no box');
  return box.width / box.height;
}

export async function boxOf(locator: Locator): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box');
  return box;
}

/** Touch long-press (Chromium DevTools touch events; needs a `hasTouch` context). */
export async function longPress(page: Page, target: Locator, ms: number): Promise<void> {
  const box = await boxOf(target);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

/** True when the page has no horizontal scroll. */
export function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}
