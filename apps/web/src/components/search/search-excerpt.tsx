// `SearchExcerpt` (docs/design-system.md): the hit's canonical source text in a <blockquote> in
// the book's language, the matched passage and the query terms marked. Marks carry a visible
// non-colour cue (passage: underline bar; term: bold) so emphasis never relies on colour alone.
import { segmentHighlights, type TextRange } from '@/lib/search/highlight';
import styles from './search.module.css';

export interface SearchExcerptProps {
  readonly text: string;
  readonly highlights: readonly TextRange[];
  readonly termHighlights: readonly TextRange[];
  readonly language?: string | null;
  readonly truncatedStart?: boolean;
  readonly truncatedEnd?: boolean;
  /** `compact` clamps the excerpt to a few lines (result list); `full` shows all of it. */
  readonly variant?: 'compact' | 'full';
}

export function SearchExcerpt({
  text,
  highlights,
  termHighlights,
  language,
  truncatedStart,
  truncatedEnd,
  variant = 'full',
}: SearchExcerptProps) {
  const segments = segmentHighlights(text, highlights, termHighlights);
  return (
    <blockquote className={styles.excerpt} data-variant={variant} lang={language ?? undefined}>
      {truncatedStart ? <span aria-hidden="true">… </span> : null}
      {segments.map((segment, index) => {
        if (!segment.passage && !segment.term) return <span key={index}>{segment.text}</span>;
        return (
          <mark
            key={index}
            className={styles.mark}
            data-passage={segment.passage || undefined}
            data-term={segment.term || undefined}
          >
            {segment.text}
          </mark>
        );
      })}
      {truncatedEnd ? <span aria-hidden="true"> …</span> : null}
    </blockquote>
  );
}
