'use client';

// `SearchResultList` (SEARCH-01): one list item per hit with its document, section path, page and
// excerpt. SEARCH-01-AC11 (UX7-SEARCH): a click or tap anywhere on the item opens the hit in the
// non-modal DocumentExcerptPanel (its text around the keyword, and the jump into the DOC-02
// viewer); the title button is the same action for the keyboard and assistive technology.
import type { MouseEvent } from 'react';
import type { SearchItem } from '@/lib/search/client';
import { pageLabel } from '@/lib/search/state';
import { SearchExcerpt } from './search-excerpt';
import styles from './search.module.css';

export const hitKey = (item: SearchItem) => `${item.document_id}:${item.chunk_id}:${item.rank}`;

export interface SearchResultListProps {
  readonly items: readonly SearchItem[];
  readonly selectedKey: string | null;
  readonly onOpen: (item: SearchItem) => void;
  readonly busy?: boolean;
}

/** A click that ends a text selection inside the item is a selection, not an "open". */
function selectsText(event: MouseEvent<HTMLElement>): boolean {
  const selection = window.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    selection.anchorNode !== null &&
    event.currentTarget.contains(selection.anchorNode)
  );
}

export function SearchResultList({ items, selectedKey, onOpen, busy }: SearchResultListProps) {
  return (
    <ol className={styles.results} aria-label="검색 결과" aria-busy={busy || undefined}>
      {items.map((item) => {
        const key = hitKey(item);
        const selected = key === selectedKey;
        const sections = item.breadcrumb.slice(1);
        return (
          // The whole item is a pointer target (mouse and touch); the keyboard and screen readers
          // use the title button below, which does the same, so no key handler is needed here.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
          <li
            key={key}
            className={styles.hit}
            data-selected={selected || undefined}
            onClick={(event) => {
              const onTitle = event.target instanceof Element && event.target.closest('button');
              if (onTitle || !selectsText(event)) onOpen(item);
            }}
          >
            <div className={styles.hitHeader}>
              <button
                type="button"
                className={styles.hitTitle}
                aria-haspopup="dialog"
                aria-current={selected || undefined}
              >
                {item.document_title}
              </button>
              <span className={styles.hitPage}>{pageLabel(item.page)}</span>
            </div>
            {sections.length > 0 ? (
              <p className={styles.breadcrumb}>{sections.join(' › ')}</p>
            ) : null}
            <SearchExcerpt
              text={item.text}
              highlights={item.highlights}
              termHighlights={item.term_highlights}
              language={item.language}
              truncatedStart={item.truncated_start}
              truncatedEnd={item.truncated_end}
              variant="compact"
            />
          </li>
        );
      })}
    </ol>
  );
}
