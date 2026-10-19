'use client';

// SEARCH-01 content (원문) search of the workspace home's unified search (docs/screens/search.md,
// UX3c). `useContentSearch` holds the options (mode, document/chapter filters, question papers),
// runs the query through the same-origin relay — FastAPI enforces the workspace and the
// published-revision scope — and mirrors the submitted search into the home URL next to its other
// keys, so the back button from the PDF viewer restores it. A newer request always wins: older
// ones are aborted and their late answers ignored. `ContentSearchOptions` renders the options
// inside the "검색 옵션" popover; `ContentSearchResults` the results under the home header.
import { Badge, Button, Checkbox, EmptyState, RadioGroup, Select } from '@quiz/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loginRedirectPath } from '@/lib/auth/routes';
import {
  createSearchClient,
  SEARCH_MODES,
  SearchApiError,
  type OutlineItem,
  type SearchClient,
  type SearchItem,
  type SearchMode,
  type SearchQuery,
  type SearchResponse,
} from '@/lib/search/client';
import {
  degradedMessages,
  isSearchMode,
  MAX_QUERY_CHARS,
  mergeContentSearch,
  MODE_LABELS,
  rateLimitMessage,
  reconcileChapter,
  SEARCH_FAILURE_MESSAGES,
  warningMessages,
} from '@/lib/search/state';
import { DocumentExcerptPanel } from './document-excerpt-panel';
import { hitKey, SearchResultList } from './search-result-list';
import styles from './search.module.css';

export interface SearchDocumentOption {
  readonly id: string;
  readonly title: string;
  readonly isQuestionPaper: boolean;
}

const ALL = '__all__';

type Results =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly previous: SearchResponse | null }
  | { readonly status: 'done'; readonly response: SearchResponse }
  | {
      readonly status: 'error';
      readonly error: SearchApiError;
      /** Epoch ms before which a retry is pointless (429 `Retry-After`). */
      readonly retryAt: number | null;
    };

type Chapters =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly OutlineItem[] }
  | { readonly status: 'error' };

/** Outline answer for one document (a different document means "still loading"). */
type LoadedChapters =
  | { readonly documentId: string; readonly items: readonly OutlineItem[] }
  | { readonly documentId: string; readonly failed: true };

export interface UseContentSearchOptions {
  readonly workspaceId: string;
  /** The search in the address bar on arrival (run once when `runInitial`). */
  readonly initial: SearchQuery;
  /** Whether the arrival's search includes content (the unified search's scope). */
  readonly runInitial: boolean;
  /** Injected in unit tests. */
  readonly client?: SearchClient;
}

export interface ContentSearch {
  readonly client: SearchClient;
  readonly mode: SearchMode;
  readonly documentId: string | null;
  readonly chapterId: string | null;
  readonly includeQuestionPapers: boolean;
  readonly chapters: Chapters;
  readonly chapterNotice: string | null;
  /** The last search that ran (null = none, or cleared). */
  readonly submitted: SearchQuery | null;
  readonly results: Results;
  readonly now: number;
  readonly selected: SearchItem | null;
  readonly panelOpen: boolean;
  /** Runs `query` with the current options. */
  readonly search: (query: string) => void;
  /** Re-runs the last search (after a failure). */
  readonly retry: () => void;
  /** Forgets the results (the home's "검색 결과 닫기"). */
  readonly clear: () => void;
  /**
   * Follows the address bar (browser Back/Forward): runs `q` with its options when it differs from
   * the last search, or clears the results for null. No-op when they already match.
   */
  readonly sync: (q: SearchQuery | null) => void;
  readonly setMode: (value: string) => void;
  readonly setDocument: (value: string) => void;
  readonly setChapter: (value: string) => void;
  readonly setIncludeQuestionPapers: (checked: boolean) => void;
  readonly openHit: (item: SearchItem) => void;
  readonly closeHit: () => void;
}

export function useContentSearch({
  workspaceId,
  initial,
  runInitial,
  client: injectedClient,
}: UseContentSearchOptions): ContentSearch {
  const router = useRouter();
  const client = useMemo(() => injectedClient ?? createSearchClient(), [injectedClient]);

  const [mode, setModeState] = useState<SearchMode>(initial.mode);
  const [documentId, setDocumentId] = useState<string | null>(initial.documentId);
  const [chapterId, setChapterId] = useState<string | null>(initial.chapterId);
  const [includeQuestionPapers, setPapers] = useState(initial.includeQuestionPapers);
  const [submitted, setSubmitted] = useState<SearchQuery | null>(null);
  const [results, setResults] = useState<Results>({ status: 'idle' });
  const [loadedChapters, setLoadedChapters] = useState<LoadedChapters | null>(null);
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [chapterNotice, setChapterNotice] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  /**
   * The address-bar search waiting for its chapter check. Dropped by any newer search and by any
   * user interaction with the options, so it can never replace what the user did meanwhile.
   */
  const pendingInitialRef = useRef<{ documentId: string; generation: number } | null>(null);

  /** The last search run (or null once cleared), updated synchronously, unlike `submitted`. */
  const latestRef = useRef<SearchQuery | null>(null);

  const run = useCallback(
    async (q: SearchQuery) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const generation = ++generationRef.current;
      pendingInitialRef.current = null; // any search supersedes a deferred one
      latestRef.current = q;
      setSubmitted(q);
      setPanelOpen(false);
      setResults((current) => ({
        status: 'loading',
        previous: current.status === 'done' ? current.response : null,
      }));
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${mergeContentSearch(window.location.search, q)}`,
      );
      try {
        const response = await client.search(workspaceId, q, controller.signal);
        if (generation !== generationRef.current) return;
        setResults({ status: 'done', response });
      } catch (error) {
        if (generation !== generationRef.current || controller.signal.aborted) return;
        const failure = error instanceof SearchApiError ? error : new SearchApiError('network');
        if (failure.kind === 'unauthenticated') {
          router.push(loginRedirectPath(`${window.location.pathname}${window.location.search}`));
          return;
        }
        const retryAt =
          failure.retryAfterSeconds !== undefined
            ? Date.now() + failure.retryAfterSeconds * 1000
            : null;
        setNow(Date.now());
        setResults({ status: 'error', error: failure, retryAt });
      }
    },
    [client, router, workspaceId],
  );

  // Latest values for the async chapter reconciliation below.
  const chapterIdRef = useRef(chapterId);
  const submittedRef = useRef(submitted);
  useEffect(() => {
    chapterIdRef.current = chapterId;
    submittedRef.current = submitted;
  });

  // A search in the address bar (back from the PDF viewer, a shared link) runs on arrival. With
  // a chapter filter it waits until the chapter is known to exist (see below), so the scope
  // that is searched is always the scope on screen.
  const initialRef = useRef(initial);
  const runInitialRef = useRef(runInitial);
  useEffect(() => {
    const q = initialRef.current;
    if (!runInitialRef.current || !q.query) return;
    if (q.documentId && q.chapterId) {
      pendingInitialRef.current = { documentId: q.documentId, generation: generationRef.current };
    } else void run(q);
    return () => controllerRef.current?.abort();
  }, [run]);

  // Chapters of the selected document's published revision. A selected chapter that is not one
  // of them (a bookmark from an older revision) is cleared, in the URL and in a running search.
  useEffect(() => {
    if (!documentId) return;
    const controller = new AbortController();
    const settle = (items: readonly OutlineItem[] | null) => {
      if (controller.signal.aborted) return;
      setLoadedChapters(items ? { documentId, items } : { documentId, failed: true });
      const selectedChapter = chapterIdRef.current;
      const kept = reconcileChapter(selectedChapter, items);
      const stale = kept !== selectedChapter;
      if (stale) {
        chapterIdRef.current = null;
        setChapterId(null);
        setChapterNotice(
          items
            ? '선택했던 장이 현재 발행본에 없어 장 필터를 해제했습니다.'
            : '장 목록을 불러오지 못해 장 필터를 해제했습니다.',
        );
      }
      const pending = pendingInitialRef.current;
      if (
        pending &&
        pending.documentId === documentId &&
        pending.generation === generationRef.current
      ) {
        void run({ ...initialRef.current, chapterId: kept });
      } else if (stale) {
        // Only the latest search, and only if it used exactly this chapter, is narrowed.
        const last = submittedRef.current;
        if (last && last.documentId === documentId && last.chapterId === selectedChapter) {
          void run({ ...last, chapterId: null });
        } else {
          const url = new URL(window.location.href);
          url.searchParams.delete('section');
          window.history.replaceState(window.history.state, '', url);
        }
      }
    };
    client.chapters(documentId, controller.signal).then(settle, () => settle(null));
    return () => controller.abort();
  }, [client, documentId, run]);
  const chapters: Chapters = !documentId
    ? { status: 'none' }
    : loadedChapters?.documentId !== documentId
      ? { status: 'loading' }
      : 'items' in loadedChapters
        ? { status: 'ready', items: loadedChapters.items }
        : { status: 'error' };

  // 429: re-enable "다시 시도" once Retry-After has passed.
  const retryAt = results.status === 'error' ? results.retryAt : null;
  useEffect(() => {
    if (retryAt === null || retryAt <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), retryAt - now);
    return () => window.clearTimeout(timer);
  }, [now, retryAt]);

  const options = (overrides: Partial<SearchQuery> = {}): Omit<SearchQuery, 'query'> => ({
    mode,
    documentId,
    chapterId: documentId ? chapterId : null,
    includeQuestionPapers,
    ...overrides,
  });

  /** Options apply to the last submitted query right away. */
  const rerun = (overrides: Partial<SearchQuery>) => {
    pendingInitialRef.current = null; // the user took over: never run the deferred search
    if (submitted) void run({ ...options(overrides), query: submitted.query });
  };

  return {
    client,
    mode,
    documentId,
    chapterId,
    includeQuestionPapers,
    chapters,
    chapterNotice,
    submitted,
    results,
    now,
    selected,
    panelOpen,
    search: (query) => {
      pendingInitialRef.current = null;
      void run({ ...options(), query: query.trim().slice(0, MAX_QUERY_CHARS) });
    },
    retry: () => {
      if (submitted) void run(submitted);
    },
    clear: () => {
      controllerRef.current?.abort();
      generationRef.current += 1;
      pendingInitialRef.current = null;
      latestRef.current = null;
      setSubmitted(null);
      setResults({ status: 'idle' });
      setPanelOpen(false);
    },
    sync: (q) => {
      const last = latestRef.current;
      if (q === null) {
        if (!last) return;
        controllerRef.current?.abort();
        generationRef.current += 1;
        pendingInitialRef.current = null;
        latestRef.current = null;
        setSubmitted(null);
        setResults({ status: 'idle' });
        setPanelOpen(false);
        return;
      }
      if (last && sameSearch(last, q)) return;
      setModeState(q.mode);
      setDocumentId(q.documentId);
      chapterIdRef.current = q.chapterId;
      setChapterId(q.chapterId);
      setPapers(q.includeQuestionPapers);
      setChapterNotice(null);
      void run(q);
    },
    setMode: (value) => {
      if (!isSearchMode(value)) return;
      setModeState(value);
      rerun({ mode: value });
    },
    setDocument: (value) => {
      if (!value) return; // Radix reports '' when its hidden select loses the value
      const next = value === ALL ? null : value;
      setDocumentId(next);
      setChapterId(null);
      setChapterNotice(null);
      rerun({ documentId: next, chapterId: null });
    },
    setChapter: (value) => {
      if (!value) return; // Radix reports '' when its hidden select loses the value
      const next = value === ALL ? null : value;
      setChapterId(next);
      setChapterNotice(null);
      rerun({ chapterId: next });
    },
    setIncludeQuestionPapers: (checked) => {
      setPapers(checked);
      rerun({ includeQuestionPapers: checked });
    },
    openHit: (item) => {
      setSelected(item);
      setPanelOpen(true);
    },
    closeHit: () => setPanelOpen(false),
  };
}

function sameSearch(a: SearchQuery, b: SearchQuery): boolean {
  return (
    a.query === b.query &&
    a.mode === b.mode &&
    a.documentId === b.documentId &&
    (a.documentId ? a.chapterId : null) === (b.documentId ? b.chapterId : null) &&
    a.includeQuestionPapers === b.includeQuestionPapers
  );
}

/** The content-search options of the "검색 옵션" popover. */
export function ContentSearchOptions({
  search,
  documents,
  documentsLoadFailed,
}: {
  readonly search: ContentSearch;
  readonly documents: readonly SearchDocumentOption[];
  readonly documentsLoadFailed?: boolean;
}) {
  const { chapters } = search;
  const chapterOptions =
    chapters.status === 'ready'
      ? [
          { value: ALL, label: '전체 장' },
          ...chapters.items.map((c) => ({ value: c.id, label: c.title, textValue: c.title })),
        ]
      : [{ value: ALL, label: '전체 장' }];
  const chapterPlaceholder =
    chapters.status === 'loading'
      ? '장 목록을 불러오는 중…'
      : chapters.status === 'error'
        ? '장 목록을 불러오지 못했습니다'
        : '문서를 먼저 선택하세요';
  // Unknown chapters are cleared as soon as the list arrives (reconcileChapter).
  const chapterValue = chapters.status === 'ready' ? (search.chapterId ?? ALL) : '';

  return (
    <div className={styles.options}>
      <RadioGroup
        label="검색 방식"
        options={SEARCH_MODES.map((value) => ({
          value,
          label: MODE_LABELS[value].label,
          description: MODE_LABELS[value].description,
        }))}
        value={search.mode}
        onValueChange={search.setMode}
        optionDescriptions="tooltip"
      />
      <div className={styles.filters}>
        <Select
          label="문서"
          options={[
            { value: ALL, label: '전체 문서' },
            ...documents.map((d) => {
              const label = d.isQuestionPaper ? `${d.title} (문제지)` : d.title;
              return { value: d.id, label, textValue: label };
            }),
          ]}
          value={search.documentId ?? ALL}
          onValueChange={search.setDocument}
          description={
            documentsLoadFailed ? '문서 목록을 불러오지 못해 전체 문서에서 검색합니다.' : undefined
          }
        />
        <Select
          label="장"
          options={chapterOptions}
          value={chapterValue}
          placeholder={chapterPlaceholder}
          disabled={chapters.status !== 'ready'}
          onValueChange={search.setChapter}
        />
      </div>
      <Checkbox
        label="문제지 PDF도 검색"
        checked={search.includeQuestionPapers}
        onCheckedChange={(checked) => search.setIncludeQuestionPapers(checked === true)}
      />
      {search.chapterNotice ? (
        <p role="status" className={styles.hint}>
          {search.chapterNotice}
        </p>
      ) : null}
    </div>
  );
}

/** "원문 검색 결과" under the home header, with the excerpt panel; hidden without a search. */
export function ContentSearchResults({
  workspaceId,
  search,
  onClose,
}: {
  readonly workspaceId: string;
  readonly search: ContentSearch;
  /** "검색 결과 닫기": clears the search. */
  readonly onClose: () => void;
}) {
  const { results, now } = search;
  const response =
    results.status === 'done'
      ? results.response
      : results.status === 'loading'
        ? results.previous
        : null;
  const loading = results.status === 'loading';
  const guidance = response ? warningMessages(response.warnings) : [];
  const degraded = response ? degradedMessages(response.degraded) : [];

  return (
    <>
      {search.submitted ? (
        <section
          aria-labelledby="search-results-heading"
          className={styles.resultsSection}
          data-panel-open={search.panelOpen || undefined}
        >
          <div className={styles.resultsHeader}>
            <h2 id="search-results-heading" className={styles.resultsTitle}>
              원문 검색 결과
            </h2>
            <p role="status" className={styles.status}>
              {loading
                ? '검색 중…'
                : results.status === 'done' && response && response.items.length > 0
                  ? `${response.items.length}개 결과`
                  : null}
            </p>
            <Button size="sm" variant="ghost" onClick={onClose}>
              검색 결과 닫기
            </Button>
          </div>

          {results.status === 'error' ? (
            <SearchFailure
              error={results.error}
              retryAt={results.retryAt}
              now={now}
              onRetry={search.retry}
            />
          ) : null}

          {/* SEARCH-01-AC06: the dense side failed; keyword results stay usable below. */}
          {degraded.length > 0 ? (
            <p role="status" className={styles.degraded}>
              <Badge tone="warning">키워드 결과</Badge>
              <span>{degraded.join(' ')}</span>
            </p>
          ) : null}

          {guidance.length > 0 && response && response.items.length > 0 ? (
            <ul className={styles.guidance}>
              {guidance.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}

          {response && response.items.length === 0 && results.status === 'done' ? (
            <EmptyState
              headingLevel={3}
              title="검색 결과가 없습니다"
              description="다른 검색어를 입력하거나 필터를 줄여 보세요. 정확한 단어가 기억나지 않으면 '검색 옵션'에서 의미 검색으로 바꿔 보세요."
              action={
                guidance.length > 0 ? (
                  <ul className={styles.guidance}>
                    {guidance.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : undefined
              }
            />
          ) : null}

          {response && response.items.length > 0 ? (
            <SearchResultList
              items={response.items}
              selectedKey={search.panelOpen && search.selected ? hitKey(search.selected) : null}
              onOpen={search.openHit}
              busy={loading}
            />
          ) : null}
        </section>
      ) : null}

      <DocumentExcerptPanel
        workspaceId={workspaceId}
        client={search.client}
        item={search.selected}
        open={search.panelOpen}
        onClose={search.closeHit}
      />
    </>
  );
}

function SearchFailure({
  error,
  retryAt,
  now,
  onRetry,
}: Readonly<{ error: SearchApiError; retryAt: number | null; now: number; onRetry: () => void }>) {
  const waiting = retryAt !== null && retryAt > now;
  const message =
    error.kind === 'rateLimited'
      ? rateLimitMessage(waiting ? Math.ceil((retryAt - now) / 1000) : undefined)
      : SEARCH_FAILURE_MESSAGES[error.kind];
  const retryable =
    error.kind === 'network' || error.kind === 'unavailable' || error.kind === 'rateLimited';
  return (
    <div role="alert" className={styles.alert}>
      <p>{message}</p>
      {retryable ? (
        <Button size="sm" disabled={waiting} onClick={onRetry}>
          다시 시도
        </Button>
      ) : null}
    </div>
  );
}
