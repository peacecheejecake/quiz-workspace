'use client';

// Pager of the draft review (QIMP-REVIEW-SCALE, docs/screens/questions-import.md): `이전`/`다음`
// and page buttons (`aria-current="page"` + filled style on the current one, never color alone)
// with the range on screen ("초안 101–200 / 752개"). Shown above and below the list; the screen
// moves focus to the list heading when the pager below the list changes the page, so keyboard and
// screen-reader users continue at the top of the new page. 이전/다음 at the ends stay focusable
// (`aria-disabled`) so focus is never dropped on a button that just became disabled.
import { Button } from '@quiz/ui';
import { pagerItems } from '@/lib/questions/draft-pages';
import styles from './question-draft-review.module.css';

export interface DraftPagerProps {
  /** Accessible name of the navigation landmark (two pagers need different names). */
  readonly label: string;
  /** 0-based. */
  readonly page: number;
  readonly pageCount: number;
  /** 0-based index of the first draft on the page, and one past the last. */
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly onPageChange: (page: number) => void;
}

export function DraftPager({
  label,
  page,
  pageCount,
  start,
  end,
  total,
  onPageChange,
}: DraftPagerProps) {
  const first = page === 0;
  const last = page >= pageCount - 1;
  return (
    <nav aria-label={label} className={styles.pager}>
      <p className={styles.pagerRange}>
        초안 {start + 1}–{end} / {total}개
      </p>
      <div className={styles.pagerButtons}>
        <Button
          size="sm"
          aria-disabled={first || undefined}
          onClick={() => {
            if (!first) onPageChange(page - 1);
          }}
        >
          이전
        </Button>
        {pagerItems(page, pageCount).map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className={styles.pagerGap} aria-hidden="true">
              …
            </span>
          ) : (
            <Button
              key={item}
              size="sm"
              variant={item === page ? 'primary' : 'secondary'}
              aria-current={item === page ? 'page' : undefined}
              aria-label={`${item + 1}페이지`}
              onClick={() => onPageChange(item)}
            >
              {item + 1}
            </Button>
          ),
        )}
        <Button
          size="sm"
          aria-disabled={last || undefined}
          onClick={() => {
            if (!last) onPageChange(page + 1);
          }}
        >
          다음
        </Button>
      </div>
    </nav>
  );
}
