// AI 문제 해설 (AIEXPL-01) fixtures: the AI explanation API helpers, the APP_ENV=test fake
// explainer's markers, call log and hold barrier, the feature-off / rate-limited stacks and the
// AIEXPL-01 UI label contract. EXPL.0 keeps every assumption about EXPL-B / EXPL-W in this header
// (mirrored by tests/integration/questions/ai_explanations/test_ai_explanations_contract.py); a
// deliberate change is a one-place edit here. Import it directly (not re-exported from test.ts).
//
// Grounded in the docs (docs/screens/ai-explanations.md, docs/questions.md §13,
// docs/architecture.md §5, docs/implementation-plan.md §3 ASK): routes
// GET/POST /questions/{id}/ai-explanation, POST …/ai-explanation/regenerate,
// GET /ai-explanations/{id}/stream, GET /shared/{shareId}/questions/{questionId}/ai-explanation,
// GET/POST /mock-exam-questions/{id}/ai-explanation, POST …/regenerate,
// GET /mock-ai-explanations/{id}/stream; the gate `practice_session_id` (bank, range-run sessions
// included) / `mock_practice_session_id` (mock) of the caller with a submitted attempt (pending
// grading included), or `view: detail` (any member, no submission; DRAFT → 409
// explanation-unavailable, ASK-SYNC (b)) / `view: manage` (mock, editors of active workspaces,
// ASK-SYNC (a)); problems explanation-before-submit (409), explanation-unavailable (409),
// explanation-disabled (409), explanation-regenerate-limit (409), explanation-daily-limit (429),
// explanation-budget-exceeded (409), workspace-archived (403), insufficient-role (403), 404 for
// another user's session / another workspace; statuses queued|running|succeeded|failed, version,
// superseded_at; error code explanation_answer_mismatch; body {correct_option_ids, summary_md,
// options[{option_id, why_md}], concepts_md}; SSE `delta {seq, text}` / `reset` / `done` /
// `error {code}` (ASK-01-C05); settings WORKER_AI_EXPLANATIONS (api + worker),
// AI_EXPLANATION_RATE_LIMIT_PER_MINUTE (6), AI_EXPLANATION_DAILY_LIMIT_PER_USER (30); fake markers
// E2E-EXPL-FAIL / -MISMATCH / -HOLD-<token> / -SLOW (C08); test-only WORKER_ASK_FAKE_LOG_DIR and
// WORKER_ASK_HOLD_DIR (the env list of the plan, shared with ASK.0); activity
// `question.ai_explanation_generated` / `mock_exam.ai_explanation_generated` (ids only).
//
// NOT in the docs (EXPL.0 assumptions, to confirm or change in EXPL-B / EXPL-W):
//   E1 GET /questions/{id}/ai-explanation?practice_session_id=<uuid> | ?view=detail → 200
//      ExplanationState = {available: bool, can_create: bool, can_regenerate: bool,
//      explanation: Explanation | null}; `available` = this environment can create (feature on
//      and an LLM, the fake under APP_ENV=test); `can_create` = available, active workspace and
//      no live (queued/running/succeeded) explanation for the key; `can_regenerate` = editor of an
//      active workspace and a succeeded explanation. `explanation` = the newest non-superseded
//      row of the current revision's key (any status; EXPL-B: a current success wins over a later
//      failed regeneration), or null.
//      Explanation = {id, job_id, status, version, question_revision_id (mock:
//      mock_exam_question_revision_id), error_code: string|null, created_at, finished_at,
//      body: {correct_option_ids, summary_md, options: [{option_id, why_md}], concepts_md,
//      points_md (EXPL-B: short answer / essay, else null)} | null (succeeded only),
//      sources: [{n, document_id, document_title, chapter_title, page, block_id, outdated}],
//      truncated: bool}. Never in any body: prompts, raw LLM output, usage.
//   E2 POST /questions/{id}/ai-explanation {practice_session_id} | {view: "detail"} → 202
//      ExplanationState with a queued/running explanation (a new one, or the one already in
//      flight for the key: concurrent POSTs get the same id), or 200 with the succeeded one
//      (cache hit: no job, outside the limits). POST …/regenerate (same body) → 202 with the new
//      version (editors). Mock: the same with `mock_practice_session_id` | `view: "manage"`.
//   E3 Stream: GET /ai-explanations/{id}/stream?practice_session_id=… | ?view=detail (mock:
//      /mock-ai-explanations/{id}/stream?mock_practice_session_id=… | ?view=manage), Bearer,
//      `text/event-stream`; events `delta` data {seq, text} (seq from 0, contiguous), `done` data
//      {explanation: Explanation}, `error` data {code} (EXPL-B: also `reset` {} before the one
//      coverage re-request, after which seq starts at 0 again; the SSE `id` is the event number
//      for `Last-Event-ID`). A running explanation replays from seq 0
//      to every connection; a finished one answers one `done`/`error` from Postgres.
//   E4 Shared: GET /shared/{shareId}/questions/{qid}/ai-explanation (share cookie) → 200
//      {body, sources, created_at} — no id/status/version/error_code/usage keys — or the share
//      API's one 404 body.
//   E5 Fake explainer (APP_ENV=test only, never in production): answers from the request's
//      question block: correct_option_ids = the question's, summary_md "정답은 <정답 보기 글>입니다.
//      <S1 첫 문장> [S1]", one why_md per option "<보기 글>: 맞습니다|틀립니다. …", concepts_md =
//      S1's first sentence; streamed in at least 3 chunks. Markers in the question stem:
//      E2E-EXPL-SLOW (≈ 0.5 s between chunks, ≥ 6 chunks), E2E-EXPL-HOLD-<token> (hold barrier,
//      E7), E2E-EXPL-FAIL (provider error → error_code llm_unavailable) and E2E-EXPL-MISMATCH
//      (answers with a wrong option as correct_option_ids and the sentinel FAKE_RAW_SENTINEL in
//      its summary) — FAIL and MISMATCH hit only the FIRST call of each question revision (an
//      earlier call in the call log), so 다시 시도 succeeds (AIEXPL-01-AC05). Contract-only:
//      E2E-EXPL-MISSING-OPTION (leaves the last option out of `options` on every call → one
//      re-request → failed, C04).
//   E6 Call log: the fake writes one file per LLM call to
//      `<WORKER_ASK_FAKE_LOG_DIR>/ai_explanation/<target id>/<call id>.json` (target = the bank
//      question id or the mock exam question id; content {target_kind, revision_id, markers} plus
//      (EXPL-B) explanation_id and attempt, never question text). Default dir
//      `<system temp dir>/quiz-e2e-ask-fake-log` (same for Node and Python processes of one
//      machine, as e2e:log-audit starts them). ASK.0 uses the same
//      variable for `ask` calls (its own subdirectory).
//   E7 Hold barrier: E2E-EXPL-HOLD-<token> makes the fake create `<hold dir>/<token>.held` when
//      it is called, then wait (≤ 120 s) until `<token>.release` exists. Hold dir =
//      WORKER_ASK_HOLD_DIR, default `<system temp dir>/quiz-e2e-ask-hold`. The explanation is
//      `running` with no delta while held. Contract-only mid-stream barrier
//      E2E-EXPL-HOLDMID-<token>: the fake publishes its first chunk (the delta seq 0 is in the
//      Redis Stream), then creates `<token>.mid` and waits (≤ 120 s) for `<token>.resume` before
//      the rest (C05 replay from seq 0 to a reader that connects mid-stream).
//   E8 Stacks: the main E2E stack runs with WORKER_AI_EXPLANATIONS=true (API and worker; export
//      it before `pnpm e2e:log-audit`, EXPL-W adds the default to playwright.config.ts / CI).
//      AC05 starts two more through summary.ts startSummaryOffStack: feature off
//      ({WORKER_AI_EXPLANATIONS: 'false'}) and "테스트 stack의 분당 한도 2"
//      ({WORKER_AI_EXPLANATIONS: 'true', AI_EXPLANATION_RATE_LIMIT_PER_MINUTE: '2'}) — the main
//      stack keeps the default 6, which AC04's 다시 만들기 run needs.
//   E9 Rate limit: 429 problem `urn:quiz-workspace:problem:rate-limited` + `Retry-After`.
//   E10 The Heatmap practice panel practises through Server Actions, so the spec reads the
//      session id a panel or run opened from Postgres (latestSessionId / latestMockQuestionId,
//      fixtures/db.ts rules) and explanation ids through the API, never from browser responses.
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   The area is a `region` named by its h3 "AI 해설" inside the QuestionViewer result (practice
//   panel "n번 문제", range/mock run modal, "문제 상세" dialog, `manage(mock)` "문제 k", share
//   panel), after the result/explanation and before the footer. Never before a submission in
//   practice/sequence. States: button "AI 해설" + text "문제와 정답, 관련 교재 구절이 AI
//   서비스로 전송됩니다."; cached: disclosure button "AI 해설 보기" (aria-expanded, collapsed);
//   running: text "AI 해설을 만드는 중" with [aria-busy="true"]; one status announcement "AI 해설을
//   만드는 중입니다" at the start and one "AI 해설이 준비되었습니다" at the end; done: badge text "AI
//   생성", notice "AI가 만든 해설입니다. 정답과 기존 해설이 기준이며, 틀릴 수 있습니다.", the body
//   (each option's text with its why line), footnote button "[1]" (name "[1]" or "출처 1"), list
//   "출처" with rows "[1] <문서> · <장> · p.<n>" (each a button opening the "본문 발췌" panel with
//   "PDF에서 보기" → DOC-02 at that page), meta "<시각> · 버전 k" (k ≥ 2), button "다시 만들기"
//   (editors of active workspaces), button "AI 질문하기" (ASK on); failure: role=alert with
//   the reason + button "다시 시도"; reasons: llm_unavailable → "AI 서비스에 연결하지 못했습니다.
//   잠시 후 다시 시도하세요.", explanation_answer_mismatch → "정답과 맞지 않는 해설이 나와 보여 주지
//   않았습니다. 다시 시도하세요.", 429 → "잠시 후 다시 시도하세요 (n초)", regenerate cap → "오늘은 이
//   문제의 해설을 더 다시 만들 수 없습니다." (wording assumed), feature off → "이 환경에서는 AI 해설을
//   사용할 수 없습니다.", archived → "보관된 Workspace에서는 새 AI 해설을 만들 수 없습니다.".
//   Share panel: disclosure "AI 해설" only when one exists; no create/regenerate/status/version.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { API_PREFIX, isMissingRoute, routeOf, type ApiResponse } from './api.ts';
import { JOB_TIMEOUT_MS } from './documents.ts';
import { localDbAdminUrl, localEndpoints } from './local-env.ts';
import type { Question, QuestionInput } from './questions.ts';
import { startSummaryOffStack, type SummaryOffStack } from './summary.ts';
import type { Member } from './workspaces.ts';

export const EXPL_TIMEOUT_MS = JOB_TIMEOUT_MS;
const PROBLEM = 'urn:quiz-workspace:problem:';
export const EXPL_PROBLEMS = {
  beforeSubmit: `${PROBLEM}explanation-before-submit`,
  unavailable: `${PROBLEM}explanation-unavailable`,
  disabled: `${PROBLEM}explanation-disabled`,
  regenerateLimit: `${PROBLEM}explanation-regenerate-limit`,
  dailyLimit: `${PROBLEM}explanation-daily-limit`,
  rateLimited: `${PROBLEM}rate-limited`,
  archived: `${PROBLEM}workspace-archived`,
  insufficientRole: `${PROBLEM}insufficient-role`,
} as const;

// ---------------------------------------------------------------------------------------------
// Fake explainer (E5–E7)
// ---------------------------------------------------------------------------------------------

export const EXPL_MARKERS = {
  fail: 'E2E-EXPL-FAIL',
  mismatch: 'E2E-EXPL-MISMATCH',
  slow: 'E2E-EXPL-SLOW',
} as const;

/** E5: in the MISMATCH answer's raw output only; must never reach a screen, body or log. */
export const FAKE_RAW_SENTINEL = 'E2E-EXPL-RAW-OUTPUT';

export function fakeLogDir(): string {
  return process.env.WORKER_ASK_FAKE_LOG_DIR?.trim() || join(tmpdir(), 'quiz-e2e-ask-fake-log');
}

export function holdDir(): string {
  return process.env.WORKER_ASK_HOLD_DIR?.trim() || join(tmpdir(), 'quiz-e2e-ask-hold');
}

/** E6: LLM calls the fake explainer answered for a bank question or a mock exam question. */
export function explainCalls(targetId: string): number {
  const dir = join(fakeLogDir(), 'ai_explanation', targetId);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

/** E7 hold barrier: one token per test. */
export class ExplHold {
  readonly token = randomUUID().replace(/-/g, '').slice(0, 16);
  readonly marker = `E2E-EXPL-HOLD-${this.token}`;

  async held(): Promise<void> {
    const file = join(holdDir(), `${this.token}.held`);
    await expect
      .poll(() => existsSync(file), {
        message: 'the AI explanation reaches the hold barrier',
        timeout: EXPL_TIMEOUT_MS,
      })
      .toBe(true);
  }

  release(): void {
    mkdirSync(holdDir(), { recursive: true });
    writeFileSync(join(holdDir(), `${this.token}.release`), '');
  }
}

// ---------------------------------------------------------------------------------------------
// Seed questions: a four-option MCQ with a human explanation and a book source in 1장 (book-ko,
// "1.1 증발과 응결" on page 2)
// ---------------------------------------------------------------------------------------------

export const SOURCE_PAGE = 2;
export const EVAPORATION_OPTIONS = ['증발', '응결', '강수', '유출'] as const;

/**
 * CONFIRMED MCQ about evaporation whose stem carries `label` and `markers` (` [<marker>]`), the
 * human explanation `<label> 사람이 쓴 해설`, chapter `chapterId` and the book source page 2.
 * Option texts are `<label>-<i> <용어>` so each appears once on screen; option 1 is correct.
 */
export function explMcq(
  label: string,
  n: number,
  documentId: string,
  chapterId: string | null,
  markers: readonly string[] = [],
): QuestionInput {
  const options = EVAPORATION_OPTIONS.map((term, i) => ({
    id: `opt-${i + 1}`,
    text: `${label}-${n} ${term}`,
  }));
  const tail = markers.map((m) => ` [${m}]`).join('');
  return {
    question_type: 'MCQ',
    stem: `${label}-${n} 햇빛이 물 표면을 데워 물 분자가 수증기가 되는 과정은?${tail}`,
    options,
    correct_option_ids: ['opt-1'],
    is_multi_answer: false,
    explanation: `${label}-${n} 사람이 쓴 해설: 액체가 기체로 변하는 현상이다.`,
    chapter_id: chapterId,
    question_number: n,
    sources: [{ document_id: documentId, page_start: SOURCE_PAGE, page_end: SOURCE_PAGE }],
  };
}

export function correctText(question: Question): string {
  const ids = question.revision.correct_option_ids ?? [];
  return question.revision.options.find((o) => ids.includes(o.id))?.text ?? '';
}

export function wrongText(question: Question): string {
  const ids = question.revision.correct_option_ids ?? [];
  return question.revision.options.find((o) => !ids.includes(o.id))?.text ?? '';
}

// ---------------------------------------------------------------------------------------------
// API (E1–E4)
// ---------------------------------------------------------------------------------------------

export type ExplanationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ExplanationSource {
  readonly n: number;
  readonly document_id: string;
  readonly chapter_title: string | null;
  readonly page: number | null;
  readonly outdated: boolean;
}

export interface Explanation {
  readonly id: string;
  readonly job_id: string | null;
  readonly status: ExplanationStatus;
  readonly version: number;
  readonly error_code: string | null;
  readonly body: {
    readonly correct_option_ids: readonly string[];
    readonly summary_md: string;
    readonly options: readonly { readonly option_id: string; readonly why_md: string }[];
    readonly concepts_md: string;
  } | null;
  readonly sources: readonly ExplanationSource[];
}

export interface ExplanationState {
  readonly available: boolean;
  readonly can_create: boolean;
  readonly can_regenerate: boolean;
  readonly explanation: Explanation | null;
}

/** The gate of a request (E1/E2). */
export type Gate =
  | { readonly practice_session_id: string }
  | { readonly mock_practice_session_id: string }
  | { readonly view: 'detail' | 'manage' }
  | Record<string, never>;

export interface Target {
  readonly kind: 'question' | 'mock';
  readonly id: string;
}

export const bank = (id: string): Target => ({ kind: 'question', id });
export const mock = (id: string): Target => ({ kind: 'mock', id });

function base(target: Target): string {
  return target.kind === 'question'
    ? `/questions/${target.id}/ai-explanation`
    : `/mock-exam-questions/${target.id}/ai-explanation`;
}

function query(gate: Gate): string {
  const entries = Object.entries(gate);
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

export function getExplanation(
  member: Member,
  target: Target,
  gate: Gate,
): Promise<ApiResponse<ExplanationState>> {
  return member.api.request<ExplanationState>('GET', `${base(target)}${query(gate)}`);
}

export function postExplanation(
  member: Member,
  target: Target,
  gate: Gate,
): Promise<ApiResponse<ExplanationState>> {
  return member.api.request<ExplanationState>('POST', base(target), gate);
}

export function postRegenerate(
  member: Member,
  target: Target,
  gate: Gate,
): Promise<ApiResponse<ExplanationState>> {
  return member.api.request<ExplanationState>('POST', `${base(target)}/regenerate`, gate);
}

/** Polls GET (no sleeps) until the explanation of `target` is terminal; returns it. */
export async function waitForExplanation(
  member: Member,
  target: Target,
  gate: Gate,
): Promise<Explanation> {
  let found: Explanation | null | undefined;
  await expect
    .poll(
      async () => {
        const res = await getExplanation(member, target, gate);
        if (res.status !== 200) return `HTTP ${res.status}`;
        found = res.body?.explanation;
        return found?.status ?? 'none';
      },
      { message: 'the AI explanation finishes', timeout: EXPL_TIMEOUT_MS },
    )
    .toMatch(/^(succeeded|failed)$/);
  if (!found) throw new Error('no explanation');
  return found;
}

/** Creates the explanation of `target` from the detail/manage view and waits until it is done. */
export async function seedExplanation(
  member: Member,
  target: Target,
  view: 'detail' | 'manage' = target.kind === 'question' ? 'detail' : 'manage',
): Promise<Explanation> {
  const res = await postExplanation(member, target, { view });
  if (![200, 202].includes(res.status)) {
    const route = `POST ${API_PREFIX}${routeOf(base(target))}`;
    throw new Error(
      `${route} → HTTP ${res.status}${isMissingRoute(res) ? ' (not implemented)' : ''}`,
    );
  }
  const done = await waitForExplanation(member, target, { view });
  expect(done.status, 'seeded AI explanation').toBe('succeeded');
  return done;
}

export interface StreamRead {
  readonly deltas: number;
  readonly seqs: readonly number[];
  readonly text: string;
  readonly terminal: 'done' | 'error' | null;
  readonly status: number;
}

/** E3: reads an explanation stream until `done`/`error` (or the timeout). */
export async function readStream(
  member: Member,
  explanationId: string,
  gate: Gate,
  kind: Target['kind'] = 'question',
  apiUrl = localEndpoints().apiUrl,
): Promise<StreamRead> {
  const path =
    kind === 'question'
      ? `/ai-explanations/${explanationId}/stream`
      : `/mock-ai-explanations/${explanationId}/stream`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPL_TIMEOUT_MS);
  const seqs: number[] = [];
  let text = '';
  let terminal: StreamRead['terminal'] = null;
  try {
    const res = await fetch(`${apiUrl}${API_PREFIX}${path}${query(gate)}`, {
      headers: {
        authorization: `Bearer ${member.session.accessToken}`,
        accept: 'text/event-stream',
      },
      signal: controller.signal,
    });
    if (res.status !== 200 || !res.body)
      return { deltas: 0, seqs, text, terminal, status: res.status };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (terminal === null) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: *(.+)$/m.exec(raw)?.[1]?.trim() ?? 'message';
        const data = raw
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (event === 'delta') {
          const parsed = JSON.parse(data) as { seq: number; text: string };
          seqs.push(parsed.seq);
          text += parsed.text;
        } else if (event === 'done' || event === 'error') {
          terminal = event;
        }
        cut = buffer.indexOf('\n\n');
      }
    }
    await reader.cancel().catch(() => undefined);
    return { deltas: seqs.length, seqs, text, terminal, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// DB reads (fixtures/db.ts rules): the practice session a panel opened — the Heatmap panel
// practises through Server Actions, so no browser response carries the session id
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function psqlOne(sql: string): string {
  try {
    return execFileSync('psql', [localDbAdminUrl(), '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? '';
    throw new Error(`ai-explanations fixture: psql failed${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    });
  }
}

function uuid(value: string): string {
  if (!UUID.test(value)) throw new Error('ai-explanations fixture: invalid uuid');
  return `'${value}'`;
}

/**
 * The newest practice session of `userId` on a bank question (`question`) or a mock exam question
 * (`mock`), waited for until one exists.
 */
export async function latestSessionId(userId: string, target: Target): Promise<string> {
  const sql =
    target.kind === 'question'
      ? `select id from public.practice_sessions where user_id = ${uuid(userId)} ` +
        `and question_id = ${uuid(target.id)} order by created_at desc limit 1`
      : `select id from public.mock_exam_practice_sessions where user_id = ${uuid(userId)} ` +
        `and mock_exam_question_id = ${uuid(target.id)} order by created_at desc limit 1`;
  let found = '';
  await expect
    .poll(() => (found = psqlOne(sql)), { message: 'the panel opened a practice session' })
    .not.toBe('');
  return found;
}

/** The mock exam question of the newest mock practice session `userId` opened in `mockExamId`. */
export async function latestMockQuestionId(userId: string, mockExamId: string): Promise<string> {
  const sql =
    `select s.mock_exam_question_id from public.mock_exam_practice_sessions s ` +
    `join public.mock_exam_questions q on q.id = s.mock_exam_question_id ` +
    `where s.user_id = ${uuid(userId)} and q.mock_exam_id = ${uuid(mockExamId)} ` +
    `order by s.created_at desc limit 1`;
  let found = '';
  await expect
    .poll(() => (found = psqlOne(sql)), { message: 'the mock run opened a practice session' })
    .not.toBe('');
  return found;
}

// ---------------------------------------------------------------------------------------------
// Stacks (E8)
// ---------------------------------------------------------------------------------------------

/** API + worker + web with WORKER_AI_EXPLANATIONS=false (AIEXPL-01-AC05). */
export function startExplanationsOffStack(): Promise<SummaryOffStack> {
  return startSummaryOffStack({ WORKER_AI_EXPLANATIONS: 'false' });
}

/** API + worker + web with the feature on and a per-minute limit of 2 (AIEXPL-01-AC05). */
export function startRateLimitedStack(): Promise<SummaryOffStack> {
  return startSummaryOffStack({
    WORKER_AI_EXPLANATIONS: 'true',
    AI_EXPLANATION_RATE_LIMIT_PER_MINUTE: '2',
  });
}

/** A JSON call to another stack's API as `member` (the off stack's `request` sends no body). */
export async function stackRequest<T = unknown>(
  stack: SummaryOffStack,
  member: Member,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${stack.apiUrl}${API_PREFIX}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${member.session.accessToken}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: T | undefined;
  try {
    parsed = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    parsed = undefined;
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body: parsed,
    text,
  };
}

// ---------------------------------------------------------------------------------------------
// UI contract
// ---------------------------------------------------------------------------------------------

export const EXPL_TEXT = {
  sendNotice: /문제와 정답, 관련 교재 구절이 AI 서비스로 전송됩니다|sent to an AI service/i,
  working: /AI 해설을 만드는 중|making the AI explanation/i,
  started: /AI 해설을 만드는 중입니다|making the AI explanation/i,
  ready: /AI 해설이 준비되었습니다|AI explanation is ready/i,
  aiNotice:
    /AI가 만든 해설입니다\. 정답과 기존 해설이 기준이며, 틀릴 수 있습니다|written by AI.*may be wrong/i,
  unavailable:
    /AI 서비스에 연결하지 못했습니다\. 잠시 후 다시 시도하세요|could not reach the AI service/i,
  mismatch:
    /정답과 맞지 않는 해설이 나와 보여 주지 않았습니다\. 다시 시도하세요|did not match the answer/i,
  rateLimited: /잠시 후 다시 시도하세요 \(\d+초\)|try again in \d+ ?s/i,
  regenerateLimit: /더 다시 만들 수 없습니다|regenerate limit|no more regenerations/i,
  disabled: /이 환경에서는 AI 해설을 사용할 수 없습니다|AI explanations are not available here/i,
  archived:
    /보관된 Workspace에서는 새 AI 해설을 만들 수 없습니다|cannot make new AI explanations in an archived/i,
} as const;

export function versionText(k: number): RegExp {
  return new RegExp(`버전 ${k}(?!\\d)|version ${k}(?!\\d)`, 'i');
}

export const explUi = {
  // The group holds the toolbar (AI 해설 / AI 질문하기) and, once there is content, the region.
  area: (scope: Locator) => scope.getByRole('group', { name: /^(AI 해설|AI explanation)$/i }),
  /** The shared (guest) view is a region only, no toolbar group. */
  sharedArea: (scope: Locator) =>
    scope.getByRole('region', { name: /^(AI 해설|AI explanation)$/i }),
  /** The content region: absent while no explanation exists. */
  region: (scope: Locator) => scope.getByRole('region', { name: /^(AI 해설|AI explanation)$/i }),
  heading: (scope: Locator) =>
    scope.getByRole('heading', { name: /^(AI 해설|AI explanation)$/i, level: 3 }),
  create: (scope: Locator) =>
    scope.getByRole('button', { name: /^(AI 해설|make (an )?AI explanation)$/i }),
  show: (scope: Locator) =>
    scope.getByRole('button', { name: /^(AI 해설 보기|show (the )?AI explanation)$/i }),
  /** The share panel's read-only disclosure. */
  sharedToggle: (scope: Locator) =>
    scope.getByRole('button', { name: /^(AI 해설( 보기)?|AI explanation)$/i }),
  busy: (area: Locator) => area.locator('[aria-busy="true"]').or(area.getByText(EXPL_TEXT.working)),
  badge: (area: Locator) => area.getByText(/^(AI 생성|AI generated)$/i),
  notice: (area: Locator) => area.getByText(EXPL_TEXT.aiNotice),
  footnote: (area: Locator, n: number) =>
    area.getByRole('button', { name: new RegExp(`^(\\[${n}\\]|출처 ${n}|source ${n})$`, 'i') }),
  sources: (area: Locator) =>
    area.getByRole('list', { name: /^(출처|sources)$/i }).getByRole('listitem'),
  regenerate: (area: Locator) => area.getByRole('button', { name: /^(다시 만들기|regenerate)$/i }),
  askAbout: (area: Locator) => area.getByRole('button', { name: /^(AI 질문하기|ask (the )?AI)$/i }),
  alert: (area: Locator) => area.getByRole('alert'),
  retry: (area: Locator) => area.getByRole('button', { name: /^(다시 시도|try again)$/i }),
};

/**
 * Records every text the page's status regions (role=status) show about the AI explanation,
 * deduplicating consecutive repeats; `read()` returns them in order.
 */
export async function recordAnnouncements(page: Page): Promise<{ read: () => Promise<string[]> }> {
  await page.evaluate(() => {
    const w = window as unknown as { __explAnnouncements?: string[] };
    w.__explAnnouncements = [];
    const seen = w.__explAnnouncements;
    const scan = () => {
      for (const el of document.querySelectorAll('[role="status"]')) {
        const text = (el.textContent ?? '').trim();
        if (!/AI 해설|AI explanation/i.test(text)) continue;
        if (seen.at(-1) !== text) seen.push(text);
      }
    };
    new MutationObserver(scan).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  return {
    read: () =>
      page.evaluate(
        () => (window as unknown as { __explAnnouncements?: string[] }).__explAnnouncements ?? [],
      ),
  };
}

/** Waits until the area shows a finished explanation (badge + notice, not busy). */
export async function expectDone(area: Locator): Promise<void> {
  await expect(explUi.badge(area)).toBeVisible({ timeout: EXPL_TIMEOUT_MS });
  await expect(explUi.notice(area)).toBeVisible();
  await expect(area.locator('[aria-busy="true"]')).toHaveCount(0);
}
