// SEARCH-01 address-bar state and Korean copy (pure, unit-tested). The submitted search lives in
// the URL (`?q=&mode=&document=&chapter=&papers=1`) so returning from the PDF viewer with the
// browser's back button restores the same results.
import {
  DEFAULT_MODE,
  SEARCH_MODES,
  type SearchMode,
  type SearchQuery,
  type SearchFailureKind,
} from './client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The API truncates longer queries (with a warning); the URL never carries more than this. */
export const MAX_QUERY_CHARS = 1000;

type RawParams = Readonly<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export function isSearchMode(value: unknown): value is SearchMode {
  return typeof value === 'string' && (SEARCH_MODES as readonly string[]).includes(value);
}

/** Search state from the page's query string; invalid values fall back to defaults. */
export function parseSearchParams(params: RawParams): SearchQuery {
  const query = (first(params.q) ?? '').trim().slice(0, MAX_QUERY_CHARS);
  const mode = first(params.mode);
  const documentId = first(params.document);
  const chapterId = first(params.chapter);
  const validDocument = documentId && UUID.test(documentId) ? documentId : null;
  return {
    query,
    mode: isSearchMode(mode) ? mode : DEFAULT_MODE,
    documentId: validDocument,
    // A chapter filter only makes sense inside its document.
    chapterId: validDocument && chapterId && UUID.test(chapterId) ? chapterId : null,
    includeQuestionPapers: first(params.papers) === '1',
  };
}

/** Query string (without `?`) for a submitted search. */
export function searchParamsFor(q: SearchQuery): string {
  const out = new URLSearchParams();
  if (q.query) out.set('q', q.query.slice(0, MAX_QUERY_CHARS));
  if (q.mode !== DEFAULT_MODE) out.set('mode', q.mode);
  if (q.documentId) out.set('document', q.documentId);
  if (q.documentId && q.chapterId) out.set('chapter', q.chapterId);
  if (q.includeQuestionPapers) out.set('papers', '1');
  return out.toString();
}

/** DOC-02 deep link of a hit: its document at the hit's page, with the block selected. */
export function pdfLinkFor(
  workspaceId: string,
  hit: { readonly document_id: string; readonly page: number; readonly block_id: string },
): string {
  const params = new URLSearchParams({ page: String(hit.page), block: hit.block_id });
  return `/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(
    hit.document_id,
  )}?${params.toString()}`;
}

export const pageLabel = (page: number) => `${page}쪽`;

export const MODE_LABELS: Readonly<Record<SearchMode, { label: string; description: string }>> = {
  keyword: { label: '키워드', description: '입력한 단어가 그대로 들어 있는 문단 (BM25)' },
  semantic: { label: '의미', description: '뜻이 비슷한 문단, 다른 언어로 쓴 원문 포함' },
  hybrid: { label: '하이브리드', description: '키워드와 의미 검색을 함께 사용 (RRF)' },
};

const WARNING_MESSAGES: readonly [RegExp, string][] = [
  [
    /^no published documents in the search scope/i,
    '검색할 수 있는 발행된 문서가 없습니다. 문서 업로드와 처리가 끝났는지, 필터가 맞는지 확인해 주세요.',
  ],
  [/^query truncated/i, `검색어가 너무 길어 앞 ${MAX_QUERY_CHARS}자만 검색했습니다.`],
  [
    /^some selected chapters no longer exist/i,
    '선택한 장 중 일부가 현재 발행본에 없습니다. 장 필터를 다시 선택해 주세요.',
  ],
  [/^filters exclude every chunk/i, '필터 조건에 맞는 원문이 없습니다. 필터를 줄여 보세요.'],
  [
    /^no keyword matches/i,
    '입력한 단어가 그대로 들어 있는 문단이 없습니다. 의미 검색이나 하이브리드 검색으로 바꿔 보세요.',
  ],
  [/capped at/i, '요청한 결과 수가 많아 일부만 표시합니다.'],
  [/^reranker failed/i, '결과 순서 보정을 건너뛰고 기본 순서로 표시합니다.'],
];

/** Korean guidance for the API's warnings (unknown warnings are dropped, duplicates merged). */
export function warningMessages(warnings: readonly string[]): string[] {
  const out: string[] = [];
  for (const warning of warnings) {
    const match = WARNING_MESSAGES.find(([pattern]) => pattern.test(warning));
    if (match && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

export const SEARCH_FAILURE_MESSAGES: Readonly<Record<SearchFailureKind, string>> = {
  network: '네트워크 연결이 끊겨 검색하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  notFound: 'Workspace를 찾을 수 없습니다. 삭제되었거나 접근 권한이 없습니다.',
  filterNotFound: '선택한 문서나 장을 찾을 수 없습니다. 필터를 다시 선택해 주세요.',
  invalid: '검색어를 확인해 주세요. 빈 검색어나 너무 긴 검색어는 검색할 수 없습니다.',
  rateLimited: '검색 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  unavailable: '검색 서비스에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
};

export function rateLimitMessage(seconds: number | undefined): string {
  return seconds && seconds > 0
    ? `검색 요청이 너무 많습니다. ${seconds}초 후에 다시 시도해 주세요.`
    : SEARCH_FAILURE_MESSAGES.rateLimited;
}
