'use client';

// UX12-HOMEFILTER (docs/screens/ux12-home-status-filter.md): the home's status chips and
// 즐겨찾기만, shown in the 필터 popover. The selection is the page's. A favorite was set from an
// opened question, so 즐겨찾기만 turns 미열람 off: the chip shows off and aria-disabled, with its
// reason, while `status` is left alone, so 미열람 comes back as it was and an address that says
// favorite=true reads the same.
import {
  Button,
  CheckIcon,
  QUESTION_DOT_STATUSES,
  questionStatusLabels,
  type QuestionDotStatus,
} from '@quiz/ui';
import { useId } from 'react';
import type { OverviewFilters } from '@/lib/questions/overview-filters';
import styles from './questions-overview.module.css';

const UNSEEN_OFF_REASON = '즐겨찾기한 문제는 이미 열어 본 문제라 미열람이 꺼집니다.';

export interface StatusFilterProps {
  readonly status: OverviewFilters['status'];
  readonly favorite: OverviewFilters['favorite'];
  readonly onFiltersChange: (patch: Partial<OverviewFilters>) => void;
}

export function StatusFilter({ status, favorite, onFiltersChange }: StatusFilterProps) {
  const reasonId = useId();
  const favoriteOnly = favorite === true;

  function toggle(target: QuestionDotStatus) {
    const wanted = new Set(status);
    if (wanted.has(target)) wanted.delete(target);
    else wanted.add(target);
    onFiltersChange({ status: QUESTION_DOT_STATUSES.filter((s) => wanted.has(s)) });
  }

  return (
    <div className={styles.statusFilter}>
      <div className={styles.stateFilters} role="group" aria-label="상태 필터">
        {QUESTION_DOT_STATUSES.map((item) => {
          const off = favoriteOnly && item === 'unseen';
          return (
            <Button
              key={item}
              size="sm"
              className={off ? styles.chipOff : undefined}
              aria-pressed={!off && status.includes(item)}
              aria-disabled={off || undefined}
              aria-describedby={off ? reasonId : undefined}
              data-status={item}
              onClick={() => {
                if (!off) toggle(item);
              }}
            >
              <span className={styles.swatch} data-status={item} aria-hidden="true" />
              {questionStatusLabels[item]}
            </Button>
          );
        })}
        <Button
          size="sm"
          className={styles.favoriteChip}
          aria-pressed={favoriteOnly}
          onClick={() => onFiltersChange({ favorite: favoriteOnly ? null : true })}
        >
          {favoriteOnly ? <CheckIcon width={14} height={14} aria-hidden="true" /> : null}
          즐겨찾기만
        </Button>
      </div>
      {/* Always mounted so the reason is announced when it appears. */}
      <p id={reasonId} role="status" className={styles.statusFilterNote}>
        {favoriteOnly ? UNSEEN_OFF_REASON : null}
      </p>
    </div>
  );
}
