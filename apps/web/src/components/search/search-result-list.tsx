'use client';

// `SearchResultList` (SEARCH-01): one list item per hit with its document, section path, page and
// excerpt. The title button opens the hit in the non-modal DocumentExcerptPanel, which holds the
// jump into the DOC-02 viewer.
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

export function SearchResultList({ items, selectedKey, onOpen, busy }: SearchResultListProps) {
  return (
    <ol className={styles.results} aria-label="검색 결과" aria-busy={busy || undefined}>
      {items.map((item) => {
        const key = hitKey(item);
        const selected = key === selectedKey;
        const sections = item.breadcrumb.slice(1);
        return (
          <li key={key} className={styles.hit} data-selected={selected || undefined}>
            <div className={styles.hitHeader}>
              <button
                type="button"
                className={styles.hitTitle}
                aria-haspopup="dialog"
                aria-current={selected || undefined}
                onClick={() => onOpen(item)}
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
