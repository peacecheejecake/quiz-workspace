// AI question (ASK-01) fixtures: the ask API helpers (conversations, messages, SSE stream, cancel,
// retry, regenerate, attachment, feedback), the APP_ENV=test streaming fake answerer's markers, its
// call record (WORKER_ASK_FAKE_LOG_DIR) and hold barrier, the feature-off / small-limit stacks,
// the ASK seed workspace (book, question paper, `mixed` document, answer-marker questions, a
// `보기 섞기` mock exam) and the ASK-01 UI label contract. ASK.0 keeps every assumption about
// ASK-B / ASK-W / ASK-Q in this header (mirrored by tests/integration/ask/test_ask_contract.py);
// a deliberate change is a one-place edit here.
//
// Grounded in the docs (docs/screens/ask-llm.md, docs/questions.md §13, docs/architecture.md
// §4–§6): routes GET /workspaces/{id}/ask, GET/POST /workspaces/{id}/ask/conversations,
// GET/DELETE /ask/conversations/{id}, DELETE /ask/conversations/{id}/attachment,
// POST /ask/conversations/{id}/messages, GET /ask/messages/{id}, GET /ask/messages/{id}/stream
// (SSE; the browser uses the Next.js relay /api/ask/messages/{id}/stream), POST
// /ask/messages/{id}/cancel | retry | regenerate, PUT /ask/messages/{id}/feedback; job
// `ask.answer {message_id}` on queue `interactive`; message statuses incl. `no_sources` and
// `stopped`; `disclosure` none | hint | full computed per message from the attachment's session;
// SSE events delta {seq, text} · reset · done {message} · error {code}; error codes llm_unavailable
// · llm_timeout · llm_refused · sources_unavailable · workspace_unavailable · ask_failed; problems
// question-too-long (422), ask-turn-limit · ask-answer-running · ask-disabled ·
// ask-budget-exceeded · ask-regenerate-limit · ask-not-last-answer (409), ask-daily-limit and the
// per-minute limit (429 + Retry-After), workspace-archived (403); settings WORKER_ASK_LLM (api ·
// worker), ASK_* (implementation-plan "새 env 변수"), test-only WORKER_ASK_FAKE_LOG_DIR ·
// WORKER_ASK_HOLD_DIR; fake markers E2E-ASK-FAIL · -SLOW · -BADCITE · -NOANSWER · -LEAK-PROBE ·
// -HOLD-<token> (ASK-01-C11).
//
// NOT in the docs (ASK.0 assumptions, to confirm or change in ASK-B / ASK-W / ASK-Q):
//   Q1 GET /workspaces/{id}/ask → 200 AskState for any member (archived too) =
//      {available: bool, reason: "disabled" | "archived" | null, limits: {max_question_chars,
//       max_turns, max_regenerations}}. `available` = new questions can be asked here (feature on
//      AND workspace active); `reason` says why not. Non-members: the one 404 body.
//   Q2 Conversation = {id, workspace_id, title: string | null, scope: Scope, attachment:
//      Attachment | null, messages: Message[] (oldest first, every answer version included),
//      created_at, last_message_at}. Scope = {document_ids: string[], chapter_ids: string[]}
//      (empty = 전체 교재). Attachment = {kind: "question" | "mock_exam_question", view:
//      "practice" | "detail" | "manage", label: "<n>장 <m>번 · <발문 앞 40자>" (mock: "문제 k ·
//      …"), disclosure: "hint" | "full" (what the NEXT message will use, from the DB),
//      available: bool (false once the question/mock exam is gone: chip "더 이상 볼 수 없는
//      문제")}. No question body, answer or explanation in any of it.
//      GET /workspaces/{id}/ask/conversations[?cursor=] → 200 {items: [{id, title,
//      last_message_at, attachment}], next_cursor: string | null}, the caller's own only, newest
//      first, 30 per page.
//   Q3 POST /workspaces/{id}/ask/conversations {scope?, attachment?: AttachmentInput} → 201
//      Conversation. AttachmentInput = {kind: "question", view: "detail", question_id} |
//      {kind: "question", view: "practice", question_id, practice_session_id,
//       selected_option_ids?} | {kind: "mock_exam_question", view: "practice",
//       mock_exam_question_id, mock_practice_session_id, selected_option_ids?} |
//      {kind: "mock_exam_question", view: "manage", mock_exam_question_id}. Extra client fields
//      (e.g. `disclosure`) are ignored.
//   Q4 POST /ask/conversations/{id}/messages {question, scope?, selected_option_ids?} (optional
//      `Idempotency-Key`; the same key → the same two messages) → 202 {user_message: Message,
//      answer: Message, stream_url: "/api/v1/ask/messages/<id>/stream", job_id} (the
//      `ask.answer` job: its owner may read GET /jobs/{id}, nobody else; it is in no job list;
//      it runs on the Celery queue `interactive`, which follows the job type — ASK-B:
//      quiz_api.jobs.queue_for / quiz_worker.celery_app.queue_for, no queue column on jobs).
//      Message = {id, conversation_id, role: "user" | "assistant", status: "queued" |
//      "retrieving" | "streaming" | "succeeded" | "no_sources" | "stopped" | "failed", text
//      (Markdown; the finished, validated answer, or the text so far while streaming), sources:
//      Source[], searched_sources: Source[] (the "검색한 구절" list of a no-answer reply),
//      disclosure: "none" | "hint" | "full", error_code: string | null, uncited: bool,
//      truncated: bool, retry_of_message_id: string | null, regenerated_from_message_id:
//      string | null, created_at}. Footnotes in `text` are `[1]`…`[n]` = Source.number.
//      Source = {number, document_id, document_title, revision_id, chapter_id: string | null,
//      chapter_title: string | null, block_ids: string[], page_from, page_to, document_type,
//      outdated: bool}. Never in any message: the LLM's question context, prompts, provider text.
//   Q5 SSE: `id:` of a delta = its seq; `Last-Event-ID: <seq>` resumes after it. A finished
//      message (or a missing stream key) is one `done` / `error` event from Postgres.
//   Q6 POST …/cancel → 200 Message (stopped, idempotent); POST …/retry (a failed/stopped answer)
//      and POST …/regenerate (the last answer, any status) → 202 like Q4 with the new answer
//      (`retry_of_message_id` / `regenerated_from_message_id`); PUT …/feedback {reason:
//      "source_mismatch" | "made_up" | "revealed_answer" | "other"} → 200; DELETE conversation →
//      204; DELETE …/attachment → 200 Conversation (attachment null).
//   Q7 Fake answerer (APP_ENV=test only, ASK-01-C11). Evidence under APP_ENV=test (ASK-B): a
//      passage counts only when the deterministic relevance (share of the question's word and
//      bigram features found in it, E2E-* markers ignored) is at least ASK_MIN_RELEVANCE (0.3),
//      so a question needs words of the passage to get sources (e.g. "가나다 원리를 설명해 줘"). Normal answer: the first sentence of each
//      of the top two sources as "<sentence> [S1]" / "<sentence> [S2]" in at least three deltas
//      ~150 ms apart, then a last line "이전 턴 <n>개" (the history turns it received; AC06).
//      Markers in the user's question:
//      - ASK_MARKERS.fail: a provider error (error_code llm_unavailable) for every call of an
//        answer whose retry_of_message_id is null; the user's `다시 시도` answer (a retry)
//        succeeds — "두 번째는 marker 없는 같은 fixture로 성공" (AC09).
//      - ASK_MARKERS.slow: 40 deltas 500 ms apart (~20 s).
//      - ASK_MARKERS.badCite: a valid "[S1]" and an unknown "[S9]" footnote.
//      - ASK_MARKERS.noAnswer: the answer starts with "[NO_ANSWER]".
//      - ASK_MARKERS.leakProbe: echoes the question context it received, one "<field>: <value>"
//        line per field of the attachment DTO (hint: number, chapter, question_type, stem,
//        options — "<k>. <text>" in display order joined by " | " —, selected — the chosen
//        options' display numbers "<k>, …" (ASK-Q: ASK-B's DTO keeps numbers, read them with
//        probeSelected) —; full adds correct_answer (the correct options as "<k>. <text>"),
//        explanation, accepted_answers, rubric, submitted_answer ("<k>. <text>" of the submitted
//        options), result, question_sources (the cited passages' text)), then "이전 턴 <n>개".
//        Without an attachment it echoes "attachment: none".
//      - ASK_MARKERS.uncited: an answer without any footnote (C04 `uncited`).
//      - `${ASK_MARKERS.hold}-<token>`: before the first delta, creates `<hold dir>/<token>.held`
//        and waits (≤ 120 s) until `<token>.release` exists. Hold dir = WORKER_ASK_HOLD_DIR,
//        default `<system temp dir>/quiz-e2e-ask-hold`.
//   Q8 Fake call record: every call of the fake appends one JSON line to
//      `<WORKER_ASK_FAKE_LOG_DIR>/ask-<answer message id>.jsonl` (default `<system temp
//      dir>/quiz-e2e-ask-fake-log`; the `ask-` prefix keeps EXPL/RELSRC records apart in the same
//      directory) = {message_id, markers: string[], history_turns, source_tags: string[],
//      context_chars, max_output_tokens, effort, disclosure, attachment_fields: string[],
//      deltas_sent}. No question, passage or answer text. No file = the fake was never called.
//   Q9 Feature-off stack (AC05/AC08/AC11): summary.ts startSummaryOffStack({WORKER_ASK_LLM:
//      'false'}) — API, worker and web on free ports with a claimed Redis DB (D8). A small-limit
//      stack (AC09) is the same helper with WORKER_ASK_LLM=true and ASK_RATE_LIMIT_PER_MINUTE=2,
//      ASK_MAX_REGENERATIONS=2. The main E2E stack runs with WORKER_ASK_LLM=true (API and
//      worker; export it before `pnpm e2e:log-audit` — ASK-W adds it to playwright.config.ts / CI).
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   Entry points: header button "AI 질문" and 본문 search button "본문 검색어로 AI에게 묻기";
//   both are hidden when new questions are unavailable. The `문제` menu has no AI item.
//   question-side button "이 문제로 AI에게 질문하기" (text "질문하기") in the 문제 상세 footer and the
//   mock exam viewer headers.
//   Panel: FloatingSidePanel role=dialog named "AI 질문" (`?panel=ask[&conversation=<id>]`),
//   close button "AI 질문 닫기", buttons "대화 목록" · "새 대화" · "질문 범위" (popover dialog
//   "질문 범위" with radio "전체 교재" and comboboxes "문서" / "장"), text "범위: <문서 제목>".
//   List view: list "대화 목록" of rows (button named by the title; menu button "<title> 메뉴" →
//   menuitem "삭제"); empty text "Workspace 문서에 대해 물어보세요.". Conversation view: role=log
//   "대화" holding one `article` per message — user messages named "내 질문", answers named "AI
//   답변" (aria-busy while streaming); an answer has the text "AI 생성", the notice "AI가 문서를
//   근거로 만든 답입니다. 틀릴 수 있으니 출처를 확인하세요.", footnote buttons "출처 n: <문서 제목>
//   p.<쪽>", list "출처" (buttons "[n] <문서 제목> · <장> · p.<쪽>"), buttons "복사" · "도움이 안 됨"
//   (popover with radios 출처와 다름 · 지어낸 내용 · 정답을 알려 줌 · 기타) · "다시 생성" / "다시 시도"
//   · "이전 답 보기" / "다음 답 보기" with the text "답 k/n", and progress text "근거를 찾는 중" /
//   "답을 쓰는 중". Input: textbox "질문" (placeholder "문서에 대해 질문하세요"), counter "n/1,000",
//   button "보내기" (while streaming "답변 중지"). Attachment chip: group "첨부한 문제" with the
//   label, the disclosure text and the button "첨부한 문제 빼기". Live region: a role=status in the
//   panel ("답을 쓰는 중입니다", "답변이 끝났습니다. 출처 n개", "복사했습니다"). Delete confirm:
//   alertdialog "대화를 삭제할까요?" with "삭제" / "취소". The footnote / source buttons open the
//   SEARCH-01 DocumentExcerptPanel (workspace-ui.ts searchUi.excerptPanel / openInPdf).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { API_PREFIX, apiError, type ApiResponse } from './api.ts';
import {
  JOB_TIMEOUT_MS,
  listDocuments,
  outlineNodeId,
  setDocumentKind,
  uploadPdf,
  uploadReadyBook,
  waitForJob,
} from './documents.ts';
import { publishDocument, waitForJobStatus } from './history.ts';
import { localEndpoints } from './local-env.ts';
import { createShuffleMockExam, type MockExam } from './practice-runs.ts';
import { createQuestion, questionPaper, type Question, type QuestionInput } from './questions.ts';
import { startSummaryOffStack, type SummaryOffStack } from './summary.ts';
import { homeUi, main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

export const ASK_TIMEOUT_MS = JOB_TIMEOUT_MS;
export const ASK_JOB_TYPE = 'ask.answer';

export const ASK_MARKERS = {
  fail: 'E2E-ASK-FAIL',
  slow: 'E2E-ASK-SLOW',
  badCite: 'E2E-ASK-BADCITE',
  noAnswer: 'E2E-ASK-NOANSWER',
  leakProbe: 'E2E-ASK-LEAK-PROBE',
  uncited: 'E2E-ASK-UNCITED',
  hold: 'E2E-ASK-HOLD',
} as const;

/** Synthetic answer-marker strings of the seeded questions (AC04/AC05/AC12, C03). */
export const SECRETS = {
  explanation: 'E2E-EXPLANATION-SECRET',
  correctOption: 'E2E-CORRECT-OPTION',
  sourcePassage: 'E2E-SOURCE-PASSAGE-SECRET',
  mockExplanation: 'E2E-MOCK-EXPLANATION-SECRET',
  mockCorrectOption: 'E2E-MOCK-CORRECT-OPTION',
} as const;

/** Unique passages of the seed documents (AC01/AC02). */
export const PASSAGES = {
  /** Chapter 1 of the book (page 2). */
  book: '가나다 원리',
  /** Only in the question paper. */
  paper: '라마바 정답표',
  /** Only in the question part of the `mixed` document. */
  mixed: '사아자 해설',
  /** In no document. */
  nowhere: '차카타파',
} as const;

/** Fields that tell which option is correct or carry private answer content (C03). */
export const ANSWER_FIELDS = [
  'correct_answer',
  'correct_option_ids',
  'is_correct',
  'explanation',
  'accepted_answers',
  'rubric',
  'question_sources',
  'evidence',
] as const;

export const NOT_FOUND_TEXT =
  /올린 문서에서 관련 내용을 찾지 못했습니다\. 질문을 바꾸거나 질문 범위를 넓혀 보세요\.|nothing relevant was found in your documents/i;

export const ASK_PROBLEMS = {
  archived: 'urn:quiz-workspace:problem:workspace-archived',
  disabled: 'urn:quiz-workspace:problem:ask-disabled',
  tooLong: 'urn:quiz-workspace:problem:question-too-long',
  turnLimit: 'urn:quiz-workspace:problem:ask-turn-limit',
  running: 'urn:quiz-workspace:problem:ask-answer-running',
  dailyLimit: 'urn:quiz-workspace:problem:ask-daily-limit',
  budget: 'urn:quiz-workspace:problem:ask-budget-exceeded',
  regenerateLimit: 'urn:quiz-workspace:problem:ask-regenerate-limit',
  notLast: 'urn:quiz-workspace:problem:ask-not-last-answer',
} as const;

// ---------------------------------------------------------------------------------------------
// API shapes (Q1–Q6)
// ---------------------------------------------------------------------------------------------

export type Disclosure = 'none' | 'hint' | 'full';
export type MessageStatus =
  'queued' | 'retrieving' | 'streaming' | 'succeeded' | 'no_sources' | 'stopped' | 'failed';
export const TERMINAL_STATUSES: readonly MessageStatus[] = [
  'succeeded',
  'no_sources',
  'stopped',
  'failed',
];

export interface AskState {
  readonly available: boolean;
  readonly reason: 'disabled' | 'archived' | null;
  readonly limits?: {
    readonly max_question_chars: number;
    readonly max_turns: number;
    readonly max_regenerations: number;
  };
}

export interface Scope {
  readonly document_ids: readonly string[];
  readonly chapter_ids: readonly string[];
}

export interface Attachment {
  readonly kind: 'question' | 'mock_exam_question';
  readonly view: 'practice' | 'detail' | 'manage';
  readonly label: string;
  readonly disclosure: 'hint' | 'full';
  readonly available: boolean;
}

export type AttachmentInput =
  | { readonly kind: 'question'; readonly view: 'detail'; readonly question_id: string }
  | {
      readonly kind: 'question';
      readonly view: 'practice';
      readonly question_id: string;
      readonly practice_session_id: string;
      readonly selected_option_ids?: readonly string[];
    }
  | {
      readonly kind: 'mock_exam_question';
      readonly view: 'practice';
      readonly mock_exam_question_id: string;
      readonly mock_practice_session_id: string;
      readonly selected_option_ids?: readonly string[];
    }
  | {
      readonly kind: 'mock_exam_question';
      readonly view: 'manage';
      readonly mock_exam_question_id: string;
    };

export interface Source {
  readonly number: number;
  readonly document_id: string;
  readonly document_title: string;
  readonly document_type?: string;
  readonly revision_id: string;
  readonly chapter_id: string | null;
  readonly chapter_title: string | null;
  readonly block_ids: readonly string[];
  readonly page_from: number;
  readonly page_to: number;
  readonly outdated: boolean;
}

export interface Message {
  readonly id: string;
  readonly conversation_id: string;
  readonly role: 'user' | 'assistant';
  readonly status: MessageStatus;
  readonly text: string;
  readonly sources: readonly Source[];
  readonly searched_sources?: readonly Source[];
  readonly disclosure: Disclosure;
  readonly error_code: string | null;
  readonly uncited?: boolean;
  readonly truncated?: boolean;
  readonly retry_of_message_id: string | null;
  readonly regenerated_from_message_id: string | null;
}

export interface Conversation {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string | null;
  readonly scope: Scope;
  readonly attachment: Attachment | null;
  readonly messages: readonly Message[];
}

export interface ConversationRow {
  readonly id: string;
  readonly title: string | null;
  readonly last_message_at: string | null;
}

export interface SendResult {
  readonly user_message: Message;
  readonly answer: Message;
  readonly stream_url: string;
  readonly job_id: string;
}

function headers(key?: string): Record<string, string> {
  return key ? { 'idempotency-key': key } : {};
}

export function askState(member: Member, workspaceId: string): Promise<ApiResponse<AskState>> {
  return member.api.request<AskState>('GET', `/workspaces/${workspaceId}/ask`);
}

export function listConversations(
  member: Member,
  workspaceId: string,
): Promise<ApiResponse<{ items: ConversationRow[]; next_cursor: string | null }>> {
  return member.api.request('GET', `/workspaces/${workspaceId}/ask/conversations`);
}

export function requestConversation(
  member: Member,
  workspaceId: string,
  body: { scope?: Scope; attachment?: AttachmentInput; [extra: string]: unknown } = {},
): Promise<ApiResponse<Conversation>> {
  return member.api.request<Conversation>(
    'POST',
    `/workspaces/${workspaceId}/ask/conversations`,
    body,
  );
}

export async function createConversation(
  member: Member,
  workspaceId: string,
  body: { scope?: Scope; attachment?: AttachmentInput; [extra: string]: unknown } = {},
): Promise<Conversation> {
  const res = await requestConversation(member, workspaceId, body);
  if (res.status !== 201) {
    throw apiError('POST', `/workspaces/${workspaceId}/ask/conversations`, res);
  }
  return res.body as Conversation;
}

export function getConversation(
  member: Member,
  conversationId: string,
): Promise<ApiResponse<Conversation>> {
  return member.api.request<Conversation>('GET', `/ask/conversations/${conversationId}`);
}

export function deleteConversation(member: Member, conversationId: string): Promise<ApiResponse> {
  return member.api.request('DELETE', `/ask/conversations/${conversationId}`);
}

export function removeAttachment(
  member: Member,
  conversationId: string,
): Promise<ApiResponse<Conversation>> {
  return member.api.request('DELETE', `/ask/conversations/${conversationId}/attachment`);
}

export function requestMessage(
  member: Member,
  conversationId: string,
  body: { question: string; scope?: Scope; selected_option_ids?: readonly string[] },
  key?: string,
): Promise<ApiResponse<SendResult>> {
  return member.api.request<SendResult>(
    'POST',
    `/ask/conversations/${conversationId}/messages`,
    body,
    headers(key),
  );
}

export async function sendMessage(
  member: Member,
  conversationId: string,
  question: string,
  extra: { scope?: Scope; selected_option_ids?: readonly string[] } = {},
): Promise<SendResult> {
  const res = await requestMessage(member, conversationId, { question, ...extra });
  if (res.status !== 202) {
    throw apiError('POST', `/ask/conversations/${conversationId}/messages`, res);
  }
  return res.body as SendResult;
}

export function getMessage(member: Member, messageId: string): Promise<ApiResponse<Message>> {
  return member.api.request<Message>('GET', `/ask/messages/${messageId}`);
}

export function messageAction(
  member: Member,
  messageId: string,
  action: 'cancel' | 'retry' | 'regenerate',
  key?: string,
): Promise<ApiResponse<SendResult & Message>> {
  return member.api.request('POST', `/ask/messages/${messageId}/${action}`, {}, headers(key));
}

export function putFeedback(
  member: Member,
  messageId: string,
  reason: 'source_mismatch' | 'made_up' | 'revealed_answer' | 'other',
): Promise<ApiResponse> {
  return member.api.request('PUT', `/ask/messages/${messageId}/feedback`, { reason });
}

/** Polls GET /ask/messages/{id} (no sleeps) until the answer is terminal; returns it. */
export async function waitForAnswer(member: Member, messageId: string): Promise<Message> {
  let message: Message | undefined;
  await expect
    .poll(
      async () => {
        const res = await getMessage(member, messageId);
        if (res.status !== 200) throw apiError('GET', `/ask/messages/${messageId}`, res);
        message = res.body as Message;
        return TERMINAL_STATUSES.includes(message.status);
      },
      { message: 'the answer reaches a terminal status', timeout: ASK_TIMEOUT_MS },
    )
    .toBe(true);
  if (!message) throw new Error('no answer');
  return message;
}

/** One question through the API: a new conversation (or `conversationId`), sent, finished. */
export async function askThroughApi(
  member: Member,
  workspaceId: string,
  question: string,
  conversationId?: string,
): Promise<{ conversation: string; answer: Message }> {
  const id = conversationId ?? (await createConversation(member, workspaceId)).id;
  const sent = await sendMessage(member, id, question);
  return { conversation: id, answer: await waitForAnswer(member, sent.answer.id) };
}

export interface SseEvent {
  readonly event: string;
  readonly id: string | null;
  readonly data: string;
}

/** Parses an SSE body into events (comments and blank keep-alives dropped). */
export function parseSse(text: string): SseEvent[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((chunk) => {
      let event = 'message';
      let id: string | null = null;
      const data: string[] = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      return { event, id, data: data.join('\n') };
    })
    .filter((e) => e.data !== '' || e.event !== 'message');
}

/**
 * Reads GET /ask/messages/{id}/stream as `member` (Bearer, never a query token) until the server
 * closes it after `done` / `error` or `timeoutMs` passes; returns the status and the events.
 */
export async function readStream(
  member: Member,
  messageId: string,
  options: { lastEventId?: string; timeoutMs?: number; apiUrl?: string } = {},
): Promise<{ status: number; events: SseEvent[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ASK_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${options.apiUrl ?? localEndpoints().apiUrl}${API_PREFIX}/ask/messages/${messageId}/stream`,
      {
        headers: {
          authorization: `Bearer ${member.session.accessToken}`,
          accept: 'text/event-stream',
          ...(options.lastEventId ? { 'last-event-id': options.lastEventId } : {}),
        },
        signal: controller.signal,
      },
    );
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return { status: res.status, events: [] };
    }
    let text = '';
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (/event:\s*(done|error)/.test(text) && /\n\n$/.test(text)) break;
      }
    } catch {
      // aborted by the timeout: return what arrived
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return { status: res.status, events: parseSse(text) };
  } finally {
    clearTimeout(timer);
  }
}

export function deltas(events: readonly SseEvent[]): { seq: number; text: string }[] {
  return events
    .filter((e) => e.event === 'delta')
    .map((e) => JSON.parse(e.data) as { seq: number; text: string });
}

// ---------------------------------------------------------------------------------------------
// Fake record (Q8), hold barrier (Q7)
// ---------------------------------------------------------------------------------------------

export interface FakeCall {
  readonly message_id: string;
  readonly markers: readonly string[];
  readonly history_turns: number;
  readonly source_tags: readonly string[];
  readonly context_chars: number;
  readonly max_output_tokens: number;
  readonly effort: string;
  readonly disclosure: Disclosure;
  readonly attachment_fields: readonly string[];
  readonly deltas_sent: number;
}

export function askFakeLogDir(): string {
  const dir =
    process.env.WORKER_ASK_FAKE_LOG_DIR?.trim() || join(tmpdir(), 'quiz-e2e-ask-fake-log');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Calls the fake answered for one answer message (Q8); [] when it was never called. */
export function fakeCalls(messageId: string): FakeCall[] {
  const file = join(askFakeLogDir(), `ask-${messageId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FakeCall);
}

/** Every recorded answer message id (for "no call happened" checks over a time window). */
export function recordedMessageIds(): string[] {
  return readdirSync(askFakeLogDir())
    .filter((f) => /^ask-.+\.jsonl$/.test(f))
    .map((f) => f.slice(4, -6));
}

export function askHoldDir(): string {
  const dir = process.env.WORKER_ASK_HOLD_DIR?.trim() || join(tmpdir(), 'quiz-e2e-ask-hold');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `E2E-ASK-HOLD-<token>` barrier (Q7). */
export class AskHold {
  readonly token = `ask${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  readonly marker = `${ASK_MARKERS.hold}-${this.token}`;

  held(): boolean {
    return existsSync(join(askHoldDir(), `${this.token}.held`));
  }

  async waitHeld(): Promise<void> {
    await expect
      .poll(() => this.held(), { message: 'the fake answerer holds', timeout: ASK_TIMEOUT_MS })
      .toBe(true);
  }

  release(): void {
    writeFileSync(join(askHoldDir(), `${this.token}.release`), '');
  }

  cleanup(): void {
    for (const ext of ['held', 'release']) {
      rmSync(join(askHoldDir(), `${this.token}.${ext}`), { force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stacks (Q9)
// ---------------------------------------------------------------------------------------------

/** API + worker + web with the AI question feature off. */
export function startAskOffStack(): Promise<SummaryOffStack> {
  return startSummaryOffStack({ WORKER_ASK_LLM: 'false' });
}

/** API + worker + web with the feature on and the AC09 test limits (2 per minute, 2 versions). */
export function startAskLimitStack(): Promise<SummaryOffStack> {
  return startSummaryOffStack({
    WORKER_DOCUMENT_SUMMARY: process.env.WORKER_DOCUMENT_SUMMARY ?? 'true',
    WORKER_ASK_LLM: 'true',
    ASK_RATE_LIMIT_PER_MINUTE: '2',
    ASK_MAX_REGENERATIONS: '2',
  });
}

/** Calls another stack's API (`apiUrl`) as `member` with a JSON body (Q9 stacks). */
export async function stackRequest<T = unknown>(
  apiUrl: string,
  member: Member,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${apiUrl}${API_PREFIX}${path}`, {
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
// Seed (ASK.0 fixtures)
// ---------------------------------------------------------------------------------------------

export const CH1 = '1장 물의 순환';
export const CH2 = '2장 정수 처리';
/** First sentence of the chapter 1 paragraph the book seed rewrites (page 2, block ch1-s1-p1). */
const CH1_SNIPPET = '햇빛이 바다와 호수의 표면을 데우면';
const BOOK_PASSAGE =
  `${PASSAGES.book}는 증발한 수증기가 식으며 구름이 되는 순서를 정리한 합성 개념이다. ` +
  '햇빛이 바다와 호수의 표면을 데우면 물 분자의 일부가 에너지를 얻어 수증기가 된다.';
/** Question 1 stem of questions-ko.pdf (page 1). */
const PAPER_SNIPPET = '물이 액체에서 기체로 변하는 과정을 무엇이라 하는가?';

interface Block {
  readonly block_id: string;
  readonly text: string;
  readonly version: string;
}

/** Rewrites the page-`page` block containing `snippet` with `edit(text)` (a correction draft). */
async function editBlock(
  owner: Member,
  documentId: string,
  page: number,
  snippet: string,
  edit: (text: string) => string,
): Promise<void> {
  const blocks = await owner.api.ok<{ items: Block[] }>(
    'GET',
    `/documents/${documentId}/blocks?revision=latest&page=${page}&limit=200`,
    undefined,
    [200],
  );
  const target = blocks.items.find((b) => b.text.includes(snippet));
  if (!target) throw new Error(`ask seed: no block on page ${page} holds the snippet`);
  await owner.api.ok(
    'PATCH',
    `/documents/${documentId}/blocks/${encodeURIComponent(target.block_id)}`,
    { text: edit(target.text), base_version: target.version },
    [200],
  );
}

async function publishAndWait(owner: Member, documentId: string): Promise<void> {
  await waitForJobStatus(owner, await publishDocument(owner, documentId), 'succeeded');
}

async function titleOf(member: Member, workspaceId: string, documentId: string): Promise<string> {
  const doc = (await listDocuments(member, workspaceId)).find((d) => d.id === documentId);
  if (!doc?.title) throw new Error('ask seed: the document is not listed with a title');
  return doc.title;
}

export interface AskBook {
  readonly documentId: string;
  readonly title: string;
  readonly ch1: string;
  readonly ch2: string;
}

/** book-ko with PASSAGES.book in chapter 1 (page 2), published. */
export async function seedAskBook(owner: Member, workspaceId: string): Promise<AskBook> {
  const documentId = await uploadReadyBook(owner, workspaceId, 'book-ko');
  await editBlock(owner, documentId, 2, CH1_SNIPPET, () => BOOK_PASSAGE);
  await publishAndWait(owner, documentId);
  return {
    documentId,
    title: await titleOf(owner, workspaceId, documentId),
    ch1: await outlineNodeId(owner, documentId, CH1),
    ch2: await outlineNodeId(owner, documentId, CH2),
  };
}

/** questions-ko.pdf as a 문제지 whose question 1 also says PASSAGES.paper, published. */
export async function seedAskPaper(owner: Member, workspaceId: string): Promise<string> {
  const { documentId, jobId } = await uploadPdf(
    owner,
    workspaceId,
    questionPaper(),
    'question_paper',
  );
  await waitForJob(owner, jobId);
  await editBlock(owner, documentId, 1, PAPER_SNIPPET, (t) =>
    t.replace(PAPER_SNIPPET, `${PAPER_SNIPPET} (${PASSAGES.paper})`),
  );
  await publishAndWait(owner, documentId);
  return documentId;
}

/**
 * questions-ko.pdf as 교재+문제 (`mixed`) whose question 1 stem also says PASSAGES.mixed: the
 * passage is only in the question part the question extractor reads (DOCSUM-01 "대상 아님").
 */
export async function seedAskMixed(owner: Member, workspaceId: string): Promise<string> {
  const { documentId, jobId } = await uploadPdf(owner, workspaceId, questionPaper(), 'book');
  await waitForJob(owner, jobId);
  const detail = await setDocumentKind(owner, documentId, 'mixed', false);
  expect(detail.kind, 'the seed document is 교재+문제').toBe('mixed');
  await editBlock(owner, documentId, 1, PAPER_SNIPPET, (t) =>
    t.replace(PAPER_SNIPPET, `${PAPER_SNIPPET} (${PASSAGES.mixed})`),
  );
  await publishAndWait(owner, documentId);
  return documentId;
}

/** Chapter-1 MCQ number `n` whose explanation / correct option carry SECRETS (option 2 correct). */
export function secretMcq(book: AskBook, n: number, label: string): QuestionInput {
  const texts = ['보기 가 증산', SECRETS.correctOption, '보기 다 침전', '보기 라 강수'];
  const options = texts.map((text, i) => ({ id: `opt-${i + 1}`, text }));
  return {
    question_type: 'MCQ',
    stem: `${label} 물이 액체에서 기체로 변하는 과정은 무엇인가?`,
    options,
    correct_option_ids: ['opt-2'],
    is_multi_answer: false,
    explanation: `${SECRETS.explanation} 증발은 액체가 기체로 바뀌는 과정이다.`,
    chapter_id: book.ch1,
    question_number: n,
    sources: [{ document_id: book.documentId, page_start: 2, page_end: 2 }],
  };
}

/** Mock-source MCQ `k` (MOCK SECRETS, option 3 correct, chapter 1 page 2 as its source). */
export function secretMockSource(book: AskBook, k: number, label: string): QuestionInput {
  const texts = [`보기 가 ${k}`, `보기 나 ${k}`, SECRETS.mockCorrectOption, `보기 라 ${k}`];
  const options = texts.map((text, i) => ({ id: `opt-${i + 1}`, text }));
  return {
    question_type: 'MCQ',
    stem: `${label}-${k} 수증기가 물방울로 바뀌는 과정은 무엇인가?`,
    options,
    correct_option_ids: ['opt-3'],
    is_multi_answer: false,
    explanation: `${SECRETS.mockExplanation} 응결은 수증기가 물방울로 바뀌는 과정이다.`,
    chapter_id: book.ch1,
    question_number: 10 + k,
    sources: [{ document_id: book.documentId, page_start: 2, page_end: 2 }],
  };
}

export async function createSecretQuestion(
  owner: Member,
  workspaceId: string,
  book: AskBook,
  n: number,
  label: string,
): Promise<Question> {
  return createQuestion(owner, workspaceId, secretMcq(book, n, label));
}

/** A `보기 섞기` mock exam of two MOCK-secret questions (practice-runs.ts helper, MOCK-01). */
export async function seedSecretMockExam(
  owner: Member,
  workspaceId: string,
  book: AskBook,
  label: string,
): Promise<{ exam: MockExam; sources: Question[] }> {
  const sources = [
    await createQuestion(owner, workspaceId, secretMockSource(book, 1, label)),
    await createQuestion(owner, workspaceId, secretMockSource(book, 2, label)),
  ];
  const exam = await createShuffleMockExam(
    owner,
    workspaceId,
    `모의 ${label}`,
    sources.map((q) => q.id),
    2,
  );
  return { exam, sources };
}

// ---------------------------------------------------------------------------------------------
// UI (ASK-01)
// ---------------------------------------------------------------------------------------------

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function askPath(workspaceId: string, conversationId?: string): string {
  const base = `/workspaces/${workspaceId}?panel=ask`;
  return conversationId ? `${base}&conversation=${conversationId}` : base;
}

/** The ?panel / conversation values of the page URL. */
export function askParams(page: Page): { panels: string[]; conversation: string | null } {
  const url = new URL(page.url());
  return {
    panels: url.searchParams.getAll('panel'),
    conversation: url.searchParams.get('conversation'),
  };
}

export const ASK_TEXT = {
  empty: /Workspace 문서에 대해 물어보세요|ask about your workspace documents/i,
  disabled:
    /이 환경에서는 AI 질문을 사용할 수 없습니다|AI questions are not available in this environment/i,
  archived:
    /보관된 Workspace에서는 새 질문을 할 수 없습니다|archived workspaces cannot take new questions/i,
  notice:
    /AI가 문서를 근거로 만든 답입니다\. 틀릴 수 있으니 출처를 확인하세요|AI answer based on your documents/i,
  searching: /근거를 찾는 중|finding sources/i,
  writing: /답을 쓰는 중|writing the answer/i,
  liveWriting: /답을 쓰는 중입니다|writing the answer/i,
  liveDone: (n: number) =>
    new RegExp(`답변이 끝났습니다\\. 출처 ${n}개|answer finished\\. ${n} sources?`, 'i'),
  copied: /복사했습니다|copied/i,
  stopped: /답변을 중지했습니다|answer stopped/i,
  llmUnavailable:
    /AI 서비스에 연결하지 못했습니다\. 잠시 후 다시 시도하세요|could not reach the AI service/i,
  rateLimited: /잠시 후 다시 질문하세요 \((\d+)초\)|try again in (\d+) ?s/i,
  regenerateLimit: /이 질문의 답은 \d+개까지 만들 수 있습니다|up to \d+ answers/i,
  notFound: /대화를 찾을 수 없습니다|conversation not found/i,
  searched: /검색한 구절|searched passages/i,
  hint: /제출 전 — 정답 없이 힌트만|before submitting — hints only/i,
  afterSubmit: /제출 후 — 정답·해설 포함|after submitting — with answer and explanation/i,
  full: /^(정답·해설 포함|with answer and explanation)$/i,
  gone: /더 이상 볼 수 없는 문제|question no longer available/i,
  turns: (n: number) => new RegExp(`이전 턴 ${n}개`),
};

export const askUi = {
  headerButton: (page: Page) => main(page).getByRole('button', { name: /^(AI 질문|ask ai)$/i }),
  menuItem: (page: Page) =>
    homeUi.questionMenu(page).getByRole('menuitem', { name: /^(AI 질문|ask ai)$/i }),
  searchButton: (page: Page) =>
    main(page).getByRole('button', {
      name: /^(본문 검색어로 AI에게 묻기|ask ai about the search text)$/i,
    }),
  questionButton: (scope: Locator) =>
    scope.getByRole('button', {
      name: /^(이 문제로 AI에게 질문하기|ask ai about this question)$/i,
    }),
  panel: (page: Page) => page.getByRole('dialog', { name: /^(AI 질문|ask ai)$/i }),
  close: (panel: Locator) =>
    panel.getByRole('button', { name: /^(AI 질문 닫기|close ask ai|닫기|close)$/i }).first(),
  listButton: (panel: Locator) =>
    panel.getByRole('button', { name: /^(대화 목록|conversations)$/i }),
  newButton: (panel: Locator) =>
    panel.getByRole('button', { name: /^(새 대화|new conversation)$/i }),
  scopeButton: (panel: Locator) =>
    panel.getByRole('button', { name: /^(질문 범위|question scope)$/i }),
  scopePopover: (page: Page) => page.getByRole('dialog', { name: /^(질문 범위|question scope)$/i }),
  scopeText: (panel: Locator) => panel.getByText(/^(범위|scope): /i),
  list: (panel: Locator) => panel.getByRole('list', { name: /^(대화 목록|conversations)$/i }),
  rows: (panel: Locator) => askUi.list(panel).getByRole('listitem'),
  row: (panel: Locator, title: string) =>
    // `has` is evaluated inside each row, so the inner locator must not start at the panel.
    askUi
      .rows(panel)
      .filter({ has: panel.page().getByRole('button', { name: title, exact: true }) }),
  rowMenu: (row: Locator, title: string) =>
    row.getByRole('button', { name: new RegExp(`^${escape(title)} (메뉴|menu)$`, 'i') }),
  deleteItem: (page: Page) =>
    page.getByRole('menu').getByRole('menuitem', { name: /^(삭제|delete)$/i }),
  deleteConfirm: (page: Page) =>
    page.getByRole('alertdialog', { name: /대화를 삭제할까요|delete (this )?conversation/i }),
  log: (panel: Locator) => panel.getByRole('log', { name: /^(대화|conversation)$/i }),
  userMessages: (panel: Locator) =>
    askUi.log(panel).getByRole('article', { name: /^(내 질문|your question)/i }),
  answers: (panel: Locator) =>
    askUi.log(panel).getByRole('article', { name: /^(AI 답변|AI answer)/i }),
  aiBadge: (answer: Locator) => answer.getByText(/^(AI 생성|AI generated)$/i),
  footnotes: (answer: Locator) => answer.getByRole('button', { name: /^(출처|source) \d+: /i }),
  footnote: (answer: Locator, n: number) =>
    answer.getByRole('button', { name: new RegExp(`^(출처|source) ${n}: `, 'i') }),
  sourceList: (answer: Locator) => answer.getByRole('list', { name: /^(출처|sources)$/i }),
  sourceItems: (answer: Locator) => askUi.sourceList(answer).getByRole('listitem'),
  copy: (answer: Locator) => answer.getByRole('button', { name: /^(복사|copy)$/i }),
  notHelpful: (answer: Locator) =>
    answer.getByRole('button', { name: /^(도움이 안 됨|not helpful)$/i }),
  regenerate: (answer: Locator) =>
    answer.getByRole('button', { name: /^(다시 생성|regenerate)$/i }),
  retry: (answer: Locator) =>
    answer.getByRole('button', { name: /^(다시 시도|retry|try again)$/i }),
  previousVersion: (answer: Locator) =>
    answer.getByRole('button', { name: /^(이전 답 보기|previous answer)$/i }),
  nextVersion: (answer: Locator) =>
    answer.getByRole('button', { name: /^(다음 답 보기|next answer)$/i }),
  version: (answer: Locator, k: number, n: number) =>
    answer.getByText(new RegExp(`^(답 ${k}/${n}|answer ${k}/${n})$`, 'i')),
  input: (panel: Locator) => panel.getByRole('textbox', { name: /^(질문|question)$/i }),
  send: (panel: Locator) => panel.getByRole('button', { name: /^(보내기|send)$/i }),
  stop: (panel: Locator) => panel.getByRole('button', { name: /^(답변 중지|stop)$/i }),
  counter: (panel: Locator, text: string) => panel.getByText(text, { exact: true }),
  chip: (panel: Locator) =>
    panel.getByRole('group', { name: /^(첨부한 문제|attached question)$/i }),
  chipRemove: (panel: Locator) =>
    panel.getByRole('button', { name: /^(첨부한 문제 빼기|remove attached question)$/i }),
  live: (panel: Locator) => panel.getByRole('status'),
  alert: (scope: Locator) => scope.getByRole('alert'),
};

/** Opens the AI question panel from the header button and waits for it. */
export async function openAskPanel(page: Page): Promise<Locator> {
  const button = askUi.headerButton(page);
  await expect(button, 'the workspace header has an `AI 질문` button').toBeVisible();
  await button.click();
  const panel = askUi.panel(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** Types `question` into the panel and presses Enter; returns the newest answer article. */
export async function ask(panel: Locator, question: string): Promise<Locator> {
  const before = await askUi.answers(panel).count();
  await askUi.input(panel).fill(question);
  await askUi.input(panel).press('Enter');
  await expect(askUi.answers(panel)).toHaveCount(before + 1, { timeout: ASK_TIMEOUT_MS });
  return askUi.answers(panel).last();
}

/** Waits until an answer article stops streaming (aria-busy false). */
export async function waitDone(answer: Locator): Promise<void> {
  await expect(answer).toHaveAttribute('aria-busy', 'false', { timeout: ASK_TIMEOUT_MS });
}

/** The conversation id in the URL (fails when the panel has none). */
export function conversationOf(page: Page): string {
  const id = askParams(page).conversation;
  if (!id) throw new Error('the URL names no conversation');
  return id;
}

/**
 * The option texts a LEAK-PROBE echo names as chosen: its `selected: <k>, …` line holds display
 * numbers, its `options: 1. <text> | 2. <text>` line maps them to texts (Q7).
 */
export function probeSelected(probe: string): string[] {
  const options = new Map<string, string>();
  for (const option of (/^options\s*:\s*(.*)$/m.exec(probe)?.[1] ?? '').split(' | ')) {
    const m = /^(\d+)\.\s*(.*)$/.exec(option.trim());
    if (m?.[1]) options.set(m[1], (m[2] ?? '').trim());
  }
  const picked = /^selected\s*:\s*(.*)$/m.exec(probe)?.[1] ?? '';
  return picked
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => options.get(n) ?? `<unknown option ${n}>`);
}

/** "3장 12번 · <발문 앞부분>" for a chip label check. */
export function chipLabel(chapter: number, n: number, stem: string): RegExp {
  return new RegExp(`${chapter}장 ${n}번 · ${escape(stem.slice(0, 20))}`);
}
