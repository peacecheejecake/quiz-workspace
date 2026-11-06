'use client';

// RELSRC-01 `관련 본문` (docs/screens/related-sources.md "레이아웃 및 컴포넌트"): the area under a
// QuestionViewer result and its AI 해설 — `practice` / `sequence(bank|mock)` once the position was
// submitted (the caller mounts it only then: nothing is requested before a submission), `manage`
// (문제 상세, `view: detail`) and `manage(mock)` (`view: manage`) without one. A disclosure that is
// collapsed by default (RELSRC-COLLAPSE): nothing is requested until the first expand, which reads
// the list (and makes the server store it); collapsing and expanding again reuses what was loaded.
//   loading   3 skeleton lines and role=status "관련 본문을 찾는 중입니다"
//   list      an ol of passages (location, excerpt with the query words in <mark>, `문제 출처`
//             badge, "PDF" link; a row opens SEARCH-01's excerpt panel) and one status "관련 본문 n개"
//   none      role=status "관련 본문을 찾지 못했습니다."
//   degraded  the list plus the keyword-only notice
//   error     role=alert + `다시 시도`
// The expanded state is not remembered (a new question or session starts collapsed again). The
// shared guest version is SharedRelatedSources.
import { Badge, Button, Skeleton } from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DocumentExcerptPanel } from '@/components/search/document-excerpt-panel';
import { SectionDisclosure } from '../section-disclosure/section-disclosure';
import type { ExplanationGate, ExplanationTarget } from '@/lib/ai-explanations/client';
import {
  createRelatedClient,
  type RelatedClient,
  type RelatedList,
  type RelatedSource,
} from '@/lib/related-sources/client';
import { RELATED_TEXT, relatedCount, rowLocation, termRangesIn } from '@/lib/related-sources/model';
import { createSearchClient, type SearchClient, type SearchItem } from '@/lib/search/client';
import { segmentHighlights, type TextRange } from '@/lib/search/highlight';
import { pdfLinkFor } from '@/lib/search/state';
import styles from './related-sources.module.css';

export interface RelatedSourcesProps {
  readonly workspaceId: string;
  readonly target: ExplanationTarget;
  readonly gate: ExplanationGate;
  /** The revision shown (manage views): an edit starts the area over. */
  readonly revisionId?: string;
  readonly client?: RelatedClient;
  readonly searchClient?: Pick<SearchClient, 'block'>;
}

/** The area for one question and gate (a new question or session starts over, collapsed again). */
export function RelatedSources(props: RelatedSourcesProps) {
  const key = `${props.target.kind}:${props.target.id}:${props.revisionId ?? ''}:${JSON.stringify(props.gate)}`;
  return <RelatedSourcesArea key={key} {...props} />;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly list: RelatedList };

function RelatedSourcesArea({
  workspaceId,
  target,
  gate,
  revisionId: _revisionId,
  client: givenClient,
  searchClient: givenSearch,
}: RelatedSourcesProps) {
  const [defaultClient] = useState(() => createRelatedClient());
  const client = givenClient ?? defaultClient;
  const [defaultSearch] = useState(() => createSearchClient());
  const search = givenSearch ?? defaultSearch;
  const [expanded, setExpanded] = useState(false);
  // Set by the first expand and never cleared: the list is read once, not on every expand.
  const [requested, setRequested] = useState(false);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const targetRef = useRef(target);
  const gateRef = useRef(gate);

  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    client.list(targetRef.current, gateRef.current, controller.signal).then(
      (list) => {
        if (!controller.signal.aborted) setLoad({ status: 'ready', list });
      },
      () => {
        if (!controller.signal.aborted) setLoad({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [client, attempt, requested]);

  // --- excerpt panel ---------------------------------------------------------------------------
  const [excerpt, setExcerpt] = useState<{ item: SearchItem; stale: boolean } | null>(null);
  const [excerptOpen, setExcerptOpen] = useState(false);
  const excerptRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const openSource = (source: RelatedSource) => {
    const requestId = ++excerptRequest.current;
    // The listed excerpt first; the whole passage (all its blocks of the pinned revision, in
    // reading order) after.
    setExcerpt({
      item: sourceItem(source, source.excerpt, source.highlights),
      stale: source.stale,
    });
    setExcerptOpen(true);
    const ids = [...new Set(source.block_ids.length > 0 ? source.block_ids : [source.block_id])];
    fetchInOrder(ids, (id) => search.block(source.document_id, id, source.revision_id)).then(
      (blocks) => {
        if (requestId !== excerptRequest.current || !mounted.current) return;
        const text = blocks.map((b) => b.text).join('\n\n');
        const terms = termRangesIn(text, source.excerpt, source.highlights);
        setExcerpt({ item: sourceItem(source, text, terms), stale: source.stale });
      },
      () => undefined, // the listed excerpt stays; "PDF에서 보기" still works
    );
  };

  let content: ReactNode;
  if (!requested) {
    content = null;
  } else if (load.status === 'loading') {
    content = (
      <>
        <p role="status" className={styles.hint}>
          {RELATED_TEXT.loading}
        </p>
        <div className={styles.skeletons} aria-hidden="true">
          <Skeleton width="100%" />
          <Skeleton width="85%" />
          <Skeleton width="60%" />
        </div>
      </>
    );
  } else if (load.status === 'error') {
    content = (
      <div role="alert" className={styles.alert}>
        <p>{RELATED_TEXT.failed}</p>
        <Button
          size="sm"
          onClick={() => {
            setLoad({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          {RELATED_TEXT.retry}
        </Button>
      </div>
    );
  } else if (load.list.items.length === 0) {
    content = (
      <p role="status" className={styles.hint}>
        {RELATED_TEXT.empty}
      </p>
    );
  } else {
    const { items, degraded } = load.list;
    content = (
      <>
        {degraded.includes('dense_unavailable') ? (
          <p className={styles.hint}>{RELATED_TEXT.degraded}</p>
        ) : null}
        <ol className={styles.list} aria-label={RELATED_TEXT.title}>
          {items.map((source) => (
            <RelatedRow
              key={`${source.rank}:${source.document_id}:${source.block_id}`}
              source={source}
              onOpen={() => openSource(source)}
              pdfHref={pdfLinkFor(workspaceId, {
                document_id: source.document_id,
                revision_id: source.revision_id,
                page: source.page_start,
                block_id: source.block_id,
              })}
            />
          ))}
        </ol>
        <p role="status" className={styles.hint}>
          {relatedCount(items.length)}
        </p>
      </>
    );
  }

  return (
    <RelatedShell
      expanded={expanded}
      onToggle={() => {
        setExpanded((open) => !open);
        setRequested(true);
      }}
      busy={requested && load.status === 'loading'}
      after={
        // Inside the area, so over a modal panel or dialog it is that layer's own child layer.
        excerpt ? (
          <DocumentExcerptPanel
            workspaceId={workspaceId}
            client={search}
            item={excerpt.item}
            open={excerptOpen}
            onClose={() => setExcerptOpen(false)}
            notice={excerpt.stale ? RELATED_TEXT.stale : null}
          />
        ) : null
      }
    >
      {content}
    </RelatedShell>
  );
}

/** The disclosure frame: heading with the toggle, and the body it controls (collapsed to start). */
export function RelatedShell({
  expanded,
  onToggle,
  busy = false,
  children,
  after,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly busy?: boolean;
  readonly children: ReactNode;
  /** Kept outside the collapsible body (the excerpt panel). */
  readonly after?: ReactNode;
}) {
  return (
    <SectionDisclosure
      title={RELATED_TEXT.title}
      expanded={expanded}
      onToggle={onToggle}
      busy={busy}
      after={after}
    >
      {children}
    </SectionDisclosure>
  );
}

/** One passage: the row button (location + excerpt), the badge, and the PDF link. */
function RelatedRow({
  source,
  onOpen,
  pdfHref,
}: {
  readonly source: RelatedSource;
  readonly onOpen: () => void;
  readonly pdfHref: string;
}) {
  const locationId = useId();
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={`${styles.rowButton} qz-focus-ring`}
        data-hit-key={hitKeyOf(sourceItem(source, '', []))}
        onClick={onOpen}
      >
        <span id={locationId} className={styles.location}>
          {rowLocation(source)}
        </span>
        <RelatedExcerpt text={source.excerpt} highlights={source.highlights} />
      </button>
      <div className={styles.meta}>
        {source.from_question_source ? (
          <Badge tone="accent">{RELATED_TEXT.sourceBadge}</Badge>
        ) : null}
        {source.stale ? <span className={styles.hint}>{RELATED_TEXT.stale}</span> : null}
        <Link
          href={pdfHref}
          className={`${styles.link} qz-focus-ring`}
          aria-describedby={locationId}
        >
          {RELATED_TEXT.pdf}
        </Link>
      </div>
    </li>
  );
}

/** The excerpt with the query words in <mark> (bold + underline, never colour alone). */
export function RelatedExcerpt({
  text,
  highlights,
}: {
  readonly text: string;
  readonly highlights: readonly TextRange[];
}) {
  const segments = segmentHighlights(text, [], highlights);
  return (
    <span className={styles.excerpt}>
      {segments.map((segment, index) =>
        segment.term ? (
          <mark key={index} className={styles.mark}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

const BLOCK_CONCURRENCY = 6;

/** Every id's result, in the ids' order, with at most BLOCK_CONCURRENCY requests in flight. */
async function fetchInOrder<T>(ids: readonly string[], load: (id: string) => Promise<T>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += BLOCK_CONCURRENCY) {
    out.push(...(await Promise.all(ids.slice(i, i + BLOCK_CONCURRENCY).map(load))));
  }
  return out;
}

/** Mirrors `hitKey` of the search results, so the excerpt panel returns focus to this row. */
const hitKeyOf = (item: SearchItem) => `${item.document_id}:${item.chunk_id}:${item.rank}`;

/** The excerpt panel's hit for a listed passage. */
function sourceItem(
  source: RelatedSource,
  text: string,
  termHighlights: readonly TextRange[],
): SearchItem {
  return {
    document_id: source.document_id,
    document_title: source.document_title,
    document_type: 'book',
    revision_id: source.revision_id,
    chunk_id: `related:${source.rank}:${source.block_id}`,
    chapter_id: source.chapter_id,
    section_id: null,
    breadcrumb: [source.document_title, ...(source.chapter_title ? [source.chapter_title] : [])],
    block_id: source.block_id,
    block_ids: [...source.block_ids],
    context_block_ids: [...source.block_ids],
    page: source.page_start,
    bbox: null,
    locations: [],
    text,
    highlights: [],
    term_highlights: [...termHighlights],
    truncated_start: false,
    truncated_end: false,
    language: null,
    rank: source.rank,
    score: source.score ?? 0,
    score_type: 'rerank',
  };
}
