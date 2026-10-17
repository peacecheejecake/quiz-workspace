'use client';

// SEARCH-01 다국어 원문 검색 (docs/screens/search.md). Mode switch, document/chapter filters and
// the query run through the same-origin relay; FastAPI enforces the workspace and the
// published-revision scope. The submitted search is mirrored into the address bar so the back
// button from the PDF viewer restores it. A newer request always wins: older ones are aborted
// and their late answers ignored.
import { Button, Checkbox, EmptyState, Input, PageHeader, RadioGroup, Select } from '@quiz/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  isSearchMode,
  MAX_QUERY_CHARS,
  MODE_LABELS,
  rateLimitMessage,
  SEARCH_FAILURE_MESSAGES,
  searchParamsFor,
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

export interface SearchScreenProps {
  readonly workspaceId: string;
  readonly documents: readonly SearchDocumentOption[];
  readonly documentsLoadFailed?: boolean;
  readonly initial: SearchQuery;
  /** Injected in unit tests. */
  readonly client?: SearchClient;
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

export function SearchScreen({
  workspaceId,
  documents,
  documentsLoadFailed,
  initial,
  client: injectedClient,
}: SearchScreenProps) {
  const router = useRouter();
  const client = useMemo(() => injectedClient ?? createSearchClient(), [injectedClient]);

  const [draft, setDraft] = useState(initial.query);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>(initial.mode);
  const [documentId, setDocumentId] = useState<string | null>(initial.documentId);
  const [chapterId, setChapterId] = useState<string | null>(initial.chapterId);
  const [includeQuestionPapers, setIncludeQuestionPapers] = useState(initial.includeQuestionPapers);
  const [submitted, setSubmitted] = useState<SearchQuery | null>(null);
  const [results, setResults] = useState<Results>({ status: 'idle' });
  const [loadedChapters, setLoadedChapters] = useState<LoadedChapters | null>(null);
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const run = useCallback(
    async (q: SearchQuery) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const generation = ++generationRef.current;
      setSubmitted(q);
      setPanelOpen(false);
      setResults((current) => ({
        status: 'loading',
        previous: current.status === 'done' ? current.response : null,
      }));
      const search = searchParamsFor(q);
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${search ? `?${search}` : ''}`,
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

  // A search in the address bar (back from the PDF viewer, a shared link) runs on arrival.
  const initialRef = useRef(initial);
  useEffect(() => {
    if (initialRef.current.query) void run(initialRef.current);
    return () => controllerRef.current?.abort();
  }, [run]);

  // Chapters of the selected document's published revision.
  useEffect(() => {
    if (!documentId) return;
    const controller = new AbortController();
    client.chapters(documentId, controller.signal).then(
      (items) => {
        if (!controller.signal.aborted) setLoadedChapters({ documentId, items });
      },
      () => {
        if (!controller.signal.aborted) setLoadedChapters({ documentId, failed: true });
      },
    );
    return () => controller.abort();
  }, [client, documentId]);
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

  const current = (overrides: Partial<SearchQuery> = {}): SearchQuery => ({
    query: draft.trim().slice(0, MAX_QUERY_CHARS),
    mode,
    documentId,
    chapterId: documentId ? chapterId : null,
    includeQuestionPapers,
    ...overrides,
  });

  /** Filters and mode apply to the last submitted query right away. */
  const rerun = (overrides: Partial<SearchQuery>) => {
    if (submitted) void run({ ...current(), query: submitted.query, ...overrides });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = current();
    if (!q.query) {
      setFieldError('검색어를 입력해 주세요.');
      return;
    }
    setFieldError(null);
    void run(q);
  };

  const onModeChange = (value: string) => {
    if (!isSearchMode(value)) return;
    setMode(value);
    rerun({ mode: value });
  };

  const onDocumentChange = (value: string) => {
    const next = value === ALL ? null : value;
    setDocumentId(next);
    setChapterId(null);
    rerun({ documentId: next, chapterId: null });
  };

  const onChapterChange = (value: string) => {
    const next = value === ALL ? null : value;
    setChapterId(next);
    rerun({ chapterId: next });
  };

  const onQuestionPapersChange = (checked: boolean) => {
    setIncludeQuestionPapers(checked);
    rerun({ includeQuestionPapers: checked });
  };

  const openHit = (item: SearchItem) => {
    setSelected(item);
    setPanelOpen(true);
  };

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
  // Keep a chapter from the address bar only once it is known to belong to the document.
  const chapterValue =
    chapters.status === 'ready' && chapterId && chapters.items.some((c) => c.id === chapterId)
      ? chapterId
      : chapters.status === 'ready'
        ? ALL
        : undefined;

  const response =
    results.status === 'done'
      ? results.response
      : results.status === 'loading'
        ? results.previous
        : null;
  const loading = results.status === 'loading';
  const guidance = response ? warningMessages(response.warnings) : [];

  return (
    <div className={styles.screen} data-panel-open={panelOpen || undefined}>
      <PageHeader
        title="원문 검색"
        description="질문이나 키워드로 이 Workspace에 발행된 문서의 원문을 찾습니다. 한국어로 물어도 영어 원문을 찾을 수 있습니다."
      />

      <form role="search" aria-label="원문 검색" className={styles.form} onSubmit={onSubmit}>
        <div className={styles.queryRow}>
          <Input
            type="search"
            label="검색어"
            hideLabel
            placeholder="예: 정수장에서 염소를 넣는 이유"
            value={draft}
            maxLength={4000}
            error={fieldError}
            fieldClassName={styles.queryField}
            onChange={(event) => {
              setDraft(event.target.value);
              if (fieldError) setFieldError(null);
            }}
          />
          <Button type="submit" variant="primary" loading={loading}>
            검색
          </Button>
        </div>

        <RadioGroup
          label="검색 방식"
          options={SEARCH_MODES.map((value) => ({
            value,
            label: MODE_LABELS[value].label,
            description: MODE_LABELS[value].description,
          }))}
          value={mode}
          onValueChange={onModeChange}
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
            value={documentId ?? ALL}
            onValueChange={onDocumentChange}
            description={
              documentsLoadFailed
                ? '문서 목록을 불러오지 못해 전체 문서에서 검색합니다.'
                : undefined
            }
          />
          <Select
            label="장"
            options={chapterOptions}
            value={chapterValue ?? ''}
            placeholder={chapterPlaceholder}
            disabled={chapters.status !== 'ready'}
            onValueChange={onChapterChange}
          />
          <Checkbox
            label="문제지 PDF도 검색"
            checked={includeQuestionPapers}
            onCheckedChange={(checked) => onQuestionPapersChange(checked === true)}
          />
        </div>
      </form>

      <section aria-labelledby="search-results-heading" className={styles.resultsSection}>
        <h2 id="search-results-heading" className="qz-visually-hidden">
          검색 결과
        </h2>
        <p role="status" className={styles.status}>
          {loading
            ? '검색 중…'
            : results.status === 'done' && response && response.items.length > 0
              ? `${response.items.length}개 결과`
              : null}
        </p>

        {results.status === 'error' ? (
          <SearchFailure
            error={results.error}
            retryAt={results.retryAt}
            now={now}
            onRetry={() => submitted && void run(submitted)}
          />
        ) : null}

        {guidance.length > 0 && response && response.items.length > 0 ? (
          <ul className={styles.guidance}>
            {guidance.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}

        {results.status === 'idle' ? (
          <p className={styles.hint}>
            검색어를 입력하고 Enter를 누르세요. 문서·장 필터로 범위를 좁힐 수 있습니다.
          </p>
        ) : null}

        {response && response.items.length === 0 && results.status === 'done' ? (
          <EmptyState
            title="검색 결과가 없습니다"
            description="다른 검색어를 입력하거나 필터를 줄여 보세요. 정확한 단어가 기억나지 않으면 의미 검색으로 바꿔 보세요."
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
            selectedKey={panelOpen && selected ? hitKey(selected) : null}
            onOpen={openHit}
            busy={loading}
          />
        ) : null}
      </section>

      <DocumentExcerptPanel
        workspaceId={workspaceId}
        client={client}
        item={selected}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
      />
    </div>
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
