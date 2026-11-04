'use client';

// RELSRC-01 for a share-link guest (QuestionViewer `read-only`, WS-VIEW-01): the 관련 본문 list a
// member's read already stored for this published question. Collapsed to start like the member
// version, and read on the first expand only (RELSRC-COLLAPSE); with no stored list (or when it
// cannot be read) the expanded area says nothing was found. A guest never computes a list and has
// no `다시 시도`; rows are plain text with a "PDF" link into the shared document view (no excerpt
// panel).
import { Badge } from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import {
  createRelatedClient,
  type RelatedClient,
  type SharedRelatedSource,
} from '@/lib/related-sources/client';
import { RELATED_TEXT, rowLocation } from '@/lib/related-sources/model';
import { sharedDocumentHref } from '@/lib/shared/view-state';
import { RelatedExcerpt, RelatedShell } from './related-sources';
import styles from './related-sources.module.css';

export interface SharedRelatedSourcesProps {
  readonly shareId: string;
  readonly questionId: string;
  readonly client?: RelatedClient;
}

export function SharedRelatedSources(props: SharedRelatedSourcesProps) {
  return <SharedArea key={`${props.shareId}:${props.questionId}`} {...props} />;
}

function SharedArea({ shareId, questionId, client: givenClient }: SharedRelatedSourcesProps) {
  const [defaultClient] = useState(() => createRelatedClient());
  const client = givenClient ?? defaultClient;
  const [expanded, setExpanded] = useState(false);
  const [requested, setRequested] = useState(false);
  // undefined: not answered yet; null: none stored or unreadable.
  const [items, setItems] = useState<readonly SharedRelatedSource[] | null | undefined>(undefined);

  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    client.shared(shareId, questionId, controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) setItems(found);
      },
      () => {
        if (!controller.signal.aborted) setItems(null); // an optional extra: nothing found
      },
    );
    return () => controller.abort();
  }, [client, shareId, questionId, requested]);

  let content: ReactNode;
  if (!requested) {
    content = null;
  } else if (items === undefined) {
    content = (
      <p role="status" className={styles.hint}>
        {RELATED_TEXT.loading}
      </p>
    );
  } else if (!items || items.length === 0) {
    content = (
      <p role="status" className={styles.hint}>
        {RELATED_TEXT.empty}
      </p>
    );
  } else {
    content = (
      <ol className={styles.list} aria-label={RELATED_TEXT.title}>
        {items.map((source) => (
          <li
            key={`${source.rank}:${source.document_id}:${source.block_id}`}
            className={styles.item}
          >
            <span className={styles.location}>{rowLocation(source)}</span>
            <RelatedExcerpt text={source.excerpt} highlights={source.highlights} />
            <div className={styles.meta}>
              {source.from_question_source ? (
                <Badge tone="accent">{RELATED_TEXT.sourceBadge}</Badge>
              ) : null}
              <Link
                href={sharedDocumentHref(shareId, source.document_id, {
                  page: source.page_start,
                  blockId: source.block_id,
                })}
                className={`${styles.link} qz-focus-ring`}
              >
                {RELATED_TEXT.pdf}
              </Link>
            </div>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <RelatedShell
      expanded={expanded}
      onToggle={() => {
        setExpanded((open) => !open);
        setRequested(true);
      }}
      busy={requested && items === undefined}
    >
      {content}
    </RelatedShell>
  );
}
