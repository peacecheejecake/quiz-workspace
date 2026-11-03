// ASK-01 AI 질문 panel: pure view-model helpers (docs/screens/ask-llm.md "레이아웃 및 컴포넌트",
// "화면 상태", "오류 이유 문구"). No I/O here; the panel (components/ask) renders what these return.
import type {
  AskAttachment,
  AskFailureKind,
  AskMessage,
  AskScope,
  AskSource,
  AskState,
  FeedbackReason,
} from './client';

export const ASK_TEXT = {
  title: 'AI 질문',
  empty: 'Workspace 문서에 대해 물어보세요.',
  disabled: '이 환경에서는 AI 질문을 사용할 수 없습니다.',
  archived: '보관된 Workspace에서는 새 질문을 할 수 없습니다.',
  notice: 'AI가 문서를 근거로 만든 답입니다. 틀릴 수 있으니 출처를 확인하세요.',
  searching: '근거를 찾는 중',
  writing: '답을 쓰는 중',
  liveWriting: '답을 쓰는 중입니다',
  copied: '복사했습니다',
  stopped: '답변을 중지했습니다.',
  notFound: '대화를 찾을 수 없습니다.',
  uncited: '출처를 확인하지 못한 답입니다.',
  truncated: '(답이 길어 잘렸습니다)',
  attachmentOnly: '문서에서 근거를 찾지 못해 문제 내용으로만 설명합니다.',
  denseUnavailable: '의미 검색을 사용할 수 없어 키워드로 찾은 근거로 답했습니다.',
  outdated: '이 출처는 이전 발행본입니다. 현재 문서와 다를 수 있습니다.',
  gone: '더 이상 볼 수 없는 문제',
  placeholder: '문서에 대해 질문하세요',
} as const;

export const liveDoneText = (sources: number) => `답변이 끝났습니다. 출처 ${sources}개`;

/** Answer failure codes (ASK-01 "오류 이유 문구"); never the provider's own text. */
export function answerErrorText(code: string | null | undefined): string {
  switch (code) {
    case 'llm_unavailable':
    case 'llm_timeout':
      return 'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.';
    case 'llm_refused':
      return '이 질문에는 답할 수 없습니다.';
    case 'sources_unavailable':
      return '근거 문서가 바뀌었습니다. 다시 질문하세요.';
    case 'workspace_unavailable':
      return 'Workspace를 사용할 수 없습니다.';
    default:
      return '답을 만들지 못했습니다. 다시 시도하세요.';
  }
}

export function rateLimitText(seconds: number | undefined): string {
  return `잠시 후 다시 질문하세요 (${Math.max(1, Math.ceil(seconds ?? 60))}초)`;
}

/** Why a question, `다시 시도` or `다시 생성` was refused (the request's problem). */
export function askFailureText(
  kind: AskFailureKind,
  state: AskState | null,
  retryAfterSeconds?: number,
): string {
  const limits = state?.limits;
  switch (kind) {
    case 'rateLimited':
      return rateLimitText(retryAfterSeconds);
    case 'dailyLimit':
      return '오늘 질문 한도를 모두 썼습니다.';
    case 'budget':
      return '이번 달 AI 질문 사용량을 모두 썼습니다.';
    case 'tooLong':
      return `질문은 ${formatCount(limits?.max_question_chars ?? 1000)}자까지 쓸 수 있습니다.`;
    case 'turnLimit':
      return turnLimitText(limits?.max_turns ?? 20);
    case 'running':
      return '답을 만드는 중입니다. 끝난 뒤에 다시 질문하세요.';
    case 'regenerateLimit':
      return regenerateLimitText(limits?.max_regenerations ?? 5);
    case 'notLast':
      return '마지막 질문의 답만 다시 만들 수 있습니다.';
    case 'disabled':
      return ASK_TEXT.disabled;
    case 'archived':
      return ASK_TEXT.archived;
    case 'notFound':
      return ASK_TEXT.notFound;
    case 'unauthenticated':
      return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
    case 'network':
      return '네트워크 연결을 확인한 뒤 다시 시도하세요.';
    default:
      return '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
  }
}

export const turnLimitText = (max: number) =>
  `이 대화는 질문 ${max}개까지입니다. 새 대화를 시작하세요.`;
export const regenerateLimitText = (max: number) => `이 질문의 답은 ${max}개까지 만들 수 있습니다.`;

/** Why new questions are off here (null: they are not): the environment, then the archive. */
export function unavailableReason(
  state: AskState | null,
  archived: boolean,
): 'disabled' | 'archived' | null {
  if (state) return state.available ? null : (state.reason ?? (archived ? 'archived' : 'disabled'));
  return archived ? 'archived' : null;
}

export function unavailableText(reason: 'disabled' | 'archived'): string {
  return reason === 'disabled' ? ASK_TEXT.disabled : ASK_TEXT.archived;
}

const NUMBER = new Intl.NumberFormat('ko-KR');
export const formatCount = (n: number) => NUMBER.format(n);

/** The counter "1,024/1,000", shown from 80% of the limit (null below). */
export function counterText(length: number, max: number): string | null {
  if (length < Math.ceil(max * 0.8)) return null;
  return `${formatCount(length)}/${formatCount(max)}`;
}

// --- messages ------------------------------------------------------------------------------------

const TERMINAL = new Set<AskMessage['status']>(['succeeded', 'no_sources', 'stopped', 'failed']);
export const isTerminal = (message: Pick<AskMessage, 'status'>) => TERMINAL.has(message.status);

export interface Turn {
  readonly question: AskMessage;
  /** Every answer version of the question, oldest first (retries and regenerations). */
  readonly answers: readonly AskMessage[];
}

/** The conversation as questions with their answer versions, in order. */
export function conversationTurns(messages: readonly AskMessage[]): Turn[] {
  // Questions first: a question and its answer are written in one transaction and may come back
  // in either order; answers are placed by their question id (else after the latest question).
  const turns = messages
    .filter((m) => m.role === 'user')
    .map((question) => ({ question, answers: [] as AskMessage[] }));
  const byQuestion = new Map(turns.map((t) => [t.question.id, t]));
  for (const message of messages) {
    if (message.role === 'user') continue;
    const turn =
      (message.question_message_id ? byQuestion.get(message.question_message_id) : undefined) ??
      turns.at(-1);
    turn?.answers.push(message);
  }
  return turns;
}

/** The answer still being made (one per user at most), if any. */
export function runningAnswer(messages: readonly AskMessage[]): AskMessage | null {
  return messages.find((m) => m.role === 'assistant' && !isTerminal(m)) ?? null;
}

// --- footnotes ---------------------------------------------------------------------------------

export type TextPart =
  | { readonly kind: 'text'; readonly text: string }
  /** A validated footnote `[n]` of a finished answer (a button to the source). */
  | { readonly kind: 'cite'; readonly number: number }
  /** A model tag `[Sn]` while streaming (a number chip; validated when the answer is done). */
  | { readonly kind: 'tag'; readonly number: number };

const CITE = /\[S?(\d{1,3})\]/g;

/**
 * Splits answer text into text and footnotes. A finished answer's `[n]` is a footnote when `n`
 * is one of its sources; while streaming the model's `[Sn]` tags show as number chips.
 */
export function splitFootnotes(text: string, sources: ReadonlySet<number> | null): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CITE)) {
    const token = match[0];
    const number = Number(match[1]);
    const tag = token.startsWith('[S');
    const keep = sources === null ? tag : !tag && sources.has(number);
    if (!keep) continue;
    const at = match.index;
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) });
    parts.push({ kind: sources === null ? 'tag' : 'cite', number });
    last = at + token.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

export function pagesText(source: Pick<AskSource, 'page_from' | 'page_to'>): string {
  return source.page_to > source.page_from
    ? `p.${source.page_from}–${source.page_to}`
    : `p.${source.page_from}`;
}

/** Accessible name of a footnote: "출처 1: <문서 제목> p.12". */
export const footnoteLabel = (source: AskSource) =>
  `출처 ${source.number}: ${source.document_title} ${pagesText(source)}`;

/** A `출처` line: "[1] <문서 제목> · <장> · p.12–13". */
export function sourceLine(source: AskSource): string {
  return [`[${source.number}] ${source.document_title}`, source.chapter_title, pagesText(source)]
    .filter(Boolean)
    .join(' · ');
}

/** A "검색한 구절" line: "<문서 제목> · <장> · 12쪽". */
export function searchedLine(source: AskSource): string {
  const pages =
    source.page_to > source.page_from
      ? `${source.page_from}–${source.page_to}쪽`
      : `${source.page_from}쪽`;
  return [source.document_title, source.chapter_title, pages].filter(Boolean).join(' · ');
}

/** What `복사` writes: the answer's Markdown and its source lines. */
export function copyText(message: Pick<AskMessage, 'text' | 'sources'>): string {
  const lines = message.sources.map((s) => `[${s.number}] ${s.document_title} ${pagesText(s)}`);
  return lines.length ? `${message.text.trim()}\n\n${lines.join('\n')}` : message.text.trim();
}

export const FEEDBACK_REASONS: readonly { value: FeedbackReason; label: string }[] = [
  { value: 'source_mismatch', label: '출처와 다름' },
  { value: 'made_up', label: '지어낸 내용' },
  { value: 'revealed_answer', label: '정답을 알려 줌' },
  { value: 'other', label: '기타' },
];

// --- attachment and scope ------------------------------------------------------------------------

/** The chip's disclosure text (always words, never colour alone). */
export function disclosureText(attachment: AskAttachment): string {
  if (!attachment.available) return ASK_TEXT.gone;
  if (attachment.view !== 'practice') return '정답·해설 포함';
  return attachment.disclosure === 'hint'
    ? '제출 전 — 정답 없이 힌트만'
    : '제출 후 — 정답·해설 포함';
}

export const EMPTY_SCOPE: AskScope = { document_ids: [], chapter_ids: [] };

export function isEmptyScope(scope: AskScope | null | undefined): boolean {
  return !scope || (scope.document_ids.length === 0 && scope.chapter_ids.length === 0);
}

export function sameScope(a: AskScope, b: AskScope): boolean {
  const key = (s: AskScope) => `${s.document_ids.join(',')}|${s.chapter_ids.join(',')}`;
  return key(a) === key(b);
}

/** "범위: <문서 제목>[ · <장>]" (null for the whole library). */
export function scopeText(
  scope: AskScope,
  documentTitle: string | null,
  chapterTitle: string | null,
): string | null {
  if (isEmptyScope(scope)) return null;
  const doc = documentTitle ?? '선택한 문서';
  return chapterTitle ? `범위: ${doc} · ${chapterTitle}` : `범위: ${doc}`;
}

const DATE = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
export const conversationTime = (iso: string) => DATE.format(new Date(iso));
