import type { HTMLAttributes } from 'react';
import { cx } from '../internal/cx';
import { MarkerShape } from './QuestionMarker';
import { QUESTION_DOT_STATUSES, questionStatusLabels, type QuestionStatusCounts } from './status';

export interface StatusSummaryProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** From `summarizeStatuses`: mutually exclusive status counts + overlapping favorite count. */
  counts: QuestionStatusCounts;
  /** Accessible name of the summary region. */
  label?: string;
}

/**
 * Count chips: 전체, the five statuses, 즐겨찾기. Wraps on wide screens and becomes one
 * horizontally scrollable row on mobile (the region is focusable so keyboard users can scroll).
 */
export function StatusSummary({
  counts,
  label = '문제 상태 요약',
  className,
  ...rest
}: StatusSummaryProps) {
  return (
    <section
      aria-label={label}
      // Focusable so the horizontally scrolling mobile row is keyboard-scrollable.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={cx('qz-status-summary', className)}
      {...rest}
    >
      <ul className="list">
        <li className="chip">
          <span>전체</span>
          <span className="count">{counts.total}</span>
        </li>
        {QUESTION_DOT_STATUSES.map((status) => (
          <li key={status} className="chip" data-status={status}>
            <MarkerShape status={status} />
            <span>{questionStatusLabels[status]}</span>
            <span className="count">{counts[status]}</span>
          </li>
        ))}
        <li className="chip" data-status="favorite">
          <MarkerShape favorite />
          <span>즐겨찾기</span>
          <span className="count">{counts.favorite}</span>
        </li>
      </ul>
    </section>
  );
}
