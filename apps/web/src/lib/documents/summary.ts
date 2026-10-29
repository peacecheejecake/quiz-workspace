// DOCSUM-01 document summary in the browser (docs/screens/documents-summary.md): the client of this
// app's same-origin relays (`/api/documents/:id/summary`, `/api/shared/:shareId/documents/:id/
// summary`, bff.ts), the panel's view model and the safe rendering of the summary's Markdown
// subset. Summary text is shown, never logged, stored or put into a URL; FastAPI decides who may
// read, create, retry or turn off auto refresh.
import type { Schemas } from '@quiz/api-client';
import { newIdempotencyKey } from '@/lib/workspaces/idempotency';

export type SummaryState = Schemas['SummaryState'];
export type Summary = Schemas['Summary'];
export type SharedSummary = Schemas['SharedSummary'];
export type SummaryRun = Schemas['SummaryRun'];
export type SummaryUnit = Schemas['SummaryUnit'];
export type ChapterSummary = Schemas['ChapterSummary'];
export type SummaryKeyPoint = Schemas['SummaryKeyPoint'];

/** What both the member panel and the guest panel render: the summary itself. */
export type SummaryContent = Pick<Summary, 'published_at' | 'document' | 'chapters'>;

export const SUMMARY_PROBLEMS = {
  notApplicable: 'urn:quiz-workspace:problem:summary-not-applicable',
  notReady: 'urn:quiz-workspace:problem:document-not-ready',
  disabled: 'urn:quiz-workspace:problem:summary-disabled',
  notFailed: 'urn:quiz-workspace:problem:summary-not-failed',
  archived: 'urn:quiz-workspace:problem:workspace-archived',
  insufficientRole: 'urn:quiz-workspace:problem:insufficient-role',
} as const;

export type SummaryFailureKind =
  | 'notFound'
  | 'forbidden'
  | 'archived'
  | 'notApplicable'
  | 'notReady'
  | 'disabled'
  | 'notFailed'
  | 'unauthenticated'
  | 'network'
  | 'failed';

export class SummaryApiError extends Error {
  constructor(readonly kind: SummaryFailureKind) {
    super(`Summary request failed: ${kind}`);
    this.name = 'SummaryApiError';
  }
}

export function classifySummaryFailure(status: number, body: unknown): SummaryFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (status === 401) return 'unauthenticated';
  if (status === 404) return 'notFound';
  if (status === 403) return type === SUMMARY_PROBLEMS.archived ? 'archived' : 'forbidden';
  if (status === 409) {
    if (type === SUMMARY_PROBLEMS.notApplicable) return 'notApplicable';
    if (type === SUMMARY_PROBLEMS.notReady) return 'notReady';
    if (type === SUMMARY_PROBLEMS.disabled) return 'disabled';
    if (type === SUMMARY_PROBLEMS.notFailed) return 'notFailed';
  }
  return 'failed';
}

/** Why an action (요약 만들기 / 다시 시도 / 자동 갱신 끄기) was refused, as panel text. */
export const SUMMARY_ACTION_MESSAGES: Readonly<Record<SummaryFailureKind, string>> = {
  notFound: '문서를 찾을 수 없습니다.',
  forbidden: '이 Workspace에서 요약을 바꿀 권한이 없습니다.',
  archived: '보관된 Workspace에서는 요약을 바꿀 수 없습니다.',
  notApplicable: '문제지는 요약하지 않습니다.',
  notReady: '문서 처리가 끝난 뒤에 요약할 수 있습니다.',
  disabled: '이 환경에서는 AI 요약을 사용할 수 없습니다.',
  notFailed: '요약 상태가 바뀌었습니다. 최신 상태를 불러왔습니다.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  network: '네트워크 연결을 확인한 뒤 다시 시도하세요.',
  failed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.',
};

export const SUMMARY_UNAVAILABLE_REASON = '이 환경에서는 AI 요약을 사용할 수 없습니다.';

/** The failed run's reason (docs/screens/documents-summary.md "오류 이유 문구"). */
export function summaryErrorReason(code: string | null | undefined): string {
  if (code === 'llm_unavailable' || code === 'llm_timeout') {
    return 'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.';
  }
  if (code === 'summary_too_large') return '문서가 너무 커서 요약할 수 없습니다.';
  return '요약을 만들지 못했습니다. 다시 시도하세요.';
}

// --- relay paths and client --------------------------------------------------------------------

export function summaryPath(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/summary`;
}

export function sharedSummaryPath(shareId: string, documentId: string): string {
  return `/api/shared/${encodeURIComponent(shareId)}/documents/${encodeURIComponent(documentId)}/summary`;
}

type FetchLike = typeof fetch;

export interface SummaryClient {
  get(documentId: string, signal?: AbortSignal): Promise<SummaryState>;
  /** `요약 만들기` (opt in / turn auto refresh back on); one key per intended request. */
  create(documentId: string, idempotencyKey: string): Promise<SummaryState>;
  retry(documentId: string, idempotencyKey: string): Promise<SummaryState>;
  /** `자동 갱신 끄기` (idempotent 204). */
  disableAuto(documentId: string): Promise<void>;
}

async function send(
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
  try {
    return await fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...init.headers },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new SummaryApiError('network');
  }
}

async function failure(response: Response): Promise<never> {
  const body: unknown = await response.json().catch(() => undefined);
  throw new SummaryApiError(classifySummaryFailure(response.status, body));
}

export function createSummaryClient(fetchImpl: FetchLike = (...a) => fetch(...a)): SummaryClient {
  async function post(path: string, key: string): Promise<SummaryState> {
    const response = await send(fetchImpl, path, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
    });
    if (!response.ok) return failure(response);
    return (await response.json()) as SummaryState;
  }
  return {
    async get(documentId, signal) {
      const response = await send(fetchImpl, summaryPath(documentId), { signal });
      if (!response.ok) return failure(response);
      return (await response.json()) as SummaryState;
    },
    create: (documentId, key) => post(summaryPath(documentId), key),
    retry: (documentId, key) => post(`${summaryPath(documentId)}/retry`, key),
    async disableAuto(documentId) {
      const response = await send(fetchImpl, `${summaryPath(documentId)}/auto`, {
        method: 'DELETE',
      });
      if (!response.ok) await failure(response);
    },
  };
}

/** The guest's read (the share session cookie rides on the same-origin relay). */
export async function fetchSharedSummary(
  shareId: string,
  documentId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): Promise<SharedSummary> {
  const response = await send(fetchImpl, sharedSummaryPath(shareId, documentId), {
    signal,
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) return failure(response);
  return (await response.json()) as SharedSummary;
}

export { newIdempotencyKey };

// --- view model ----------------------------------------------------------------------------------

export function isActiveRun(run: SummaryRun | null | undefined): boolean {
  return run?.status === 'queued' || run?.status === 'running';
}

/** What the member panel shows for `state`; pure (unit-tested). */
export interface SummaryPanelModel {
  /** Status line of a queued/running run of the current revision. */
  readonly progress: {
    readonly text: string;
    /** 0–100, or undefined while the chapter count is unknown (indeterminate bar). */
    readonly value: number | undefined;
  } | null;
  /** The failure alert of the current revision's run (reason text). */
  readonly failure: string | null;
  /** `role=status` notice above an older revision's summary. */
  readonly stale: string | null;
  /** "아직 요약이 없습니다." (no summary, nothing running or failed). */
  readonly empty: boolean;
  /** `다시 시도` (editors; the current revision's run failed). */
  readonly retry: boolean;
  /** `요약 만들기` with the AI-service notice under the empty state (editors). */
  readonly createInEmpty: boolean;
  /** The auto-refresh line (a document with a summary): on/off, and the editor's button. */
  readonly auto: { readonly on: boolean; readonly action: 'disable' | 'enable' | null } | null;
  /** `요약 만들기` is aria-disabled with {@link SUMMARY_UNAVAILABLE_REASON}. */
  readonly unavailable: boolean;
  /** Not summarizable (yet): a question paper, or no published revision. */
  readonly notice: string | null;
}

export interface SummaryPanelContext {
  /** Owner/editor of an active workspace. */
  readonly canEdit: boolean;
  /** A 문제지 (from the document list), never summarized. */
  readonly questionPaper?: boolean;
}

export function summaryPanelModel(
  state: SummaryState,
  { canEdit, questionPaper = false }: SummaryPanelContext,
): SummaryPanelModel {
  const run = state.run;
  const active = isActiveRun(run);
  const failed = run?.status === 'failed';
  const summary = state.summary;
  const notPublished = state.published_revision_id === null;
  const notice = questionPaper
    ? '문제지는 요약하지 않습니다.'
    : notPublished && !summary
      ? '문서 처리가 끝나면 요약을 만들 수 있습니다.'
      : null;
  const progress = active && run ? runProgress(run) : null;
  const staleText = summary && state.stale ? staleNotice(active, failed) : null;
  const empty = !summary && !active && !failed;
  return {
    progress,
    failure: failed ? summaryErrorReason(run?.error_code) : null,
    stale: staleText,
    empty,
    retry: canEdit && failed,
    createInEmpty: canEdit && empty && notice === null,
    auto: summary
      ? {
          on: state.enabled,
          action: canEdit ? (state.enabled ? 'disable' : 'enable') : null,
        }
      : null,
    unavailable: !state.available,
    notice,
  };
}

function staleNotice(active: boolean, failed: boolean): string {
  const base = '이전 발행본 기준 요약입니다.';
  if (active) return `${base} 새 발행본의 요약을 만드는 중입니다.`;
  if (failed) return `${base} 새 요약을 만들지 못했습니다.`;
  return base;
}

function runProgress(run: SummaryRun): NonNullable<SummaryPanelModel['progress']> {
  if (run.status === 'queued') return { text: '요약 대기 중', value: undefined };
  const p = run.progress;
  if (!p || p.chapters_total <= 0) return { text: '요약을 만드는 중', value: undefined };
  const done = Math.min(p.chapters_done, p.chapters_total);
  return {
    text: `요약을 만드는 중 · 장별 요약 ${done}/${p.chapters_total}`,
    value: Math.round((done / p.chapters_total) * 100),
  };
}

/** Polling interval of the open panel: fast while a run is queued/running, slow otherwise. */
export function summaryPollMs(state: SummaryState | null): number {
  return state && isActiveRun(state.run) ? 1500 : 5000;
}

// --- labels --------------------------------------------------------------------------------------

/** Fixed zone and locale so the server render and hydration agree. */
const PUBLISHED_AT = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Seoul',
});

/** "<발행 시각> 발행본 기준 · 장 n개". */
export function summaryMetaLine(content: SummaryContent): string {
  const at = content.published_at ? new Date(content.published_at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `${PUBLISHED_AT.format(at)} ` : '';
  return `${when}발행본 기준 · 장 ${content.chapters.length}개`;
}

export interface PageRange {
  readonly from: number;
  readonly to: number;
}

/** Visible page label: `p.12–14` / `p.4`. */
export function pageRangeText({ from, to }: PageRange): string {
  return to > from ? `p.${from}–${to}` : `p.${from}`;
}

/** Accessible name of a page link: "12–14쪽 열기" / "4쪽 열기". */
export function pageLinkLabel({ from, to }: PageRange): string {
  return to > from ? `${from}–${to}쪽 열기` : `${from}쪽 열기`;
}

// --- Markdown subset -----------------------------------------------------------------------------

export type InlineNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong' | 'em'; readonly children: readonly InlineNode[] };

export type MarkdownBlock =
  | { readonly kind: 'paragraph'; readonly content: readonly InlineNode[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly InlineNode[])[];
    };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

/**
 * The summary's Markdown subset as data: paragraphs, bullet/numbered lists and `**strong**` /
 * `*em*` emphasis. Everything else — HTML, links, images, code — stays literal text (React
 * escapes it), so model output can never inject markup or a URL. Heading markers are dropped.
 */
export function parseSummaryMarkdown(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length)
      blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(parseInline) });
    }
    list = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[1] ?? '');
      continue;
    }
    if (list) {
      // A continuation line of the last item.
      const items = list.items;
      items[items.length - 1] = `${items[items.length - 1] ?? ''} ${line.trim()}`;
      continue;
    }
    paragraph.push((HEADING.exec(line)?.[1] ?? line).trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

const EMPHASIS = /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3/;

export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let rest = text;
  while (rest) {
    const m = EMPHASIS.exec(rest);
    if (!m) {
      out.push({ kind: 'text', text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: 'text', text: rest.slice(0, m.index) });
    const strong = m[1] !== undefined;
    const inner = (strong ? m[2] : m[4]) ?? '';
    out.push({ kind: strong ? 'strong' : 'em', children: parseInline(inner) });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
