'use client';

// QVIEW-01 `QuestionRangePicker` (docs/screens/question-viewer.md "범위 고르기 단계", shared with
// MOCK-01's 출제 범위): chapter group → question checkboxes over the questions a range can hold,
// `전체 선택` on top (tri-state over what the filters show: aria-checked="mixed" when partly
// selected), one checkbox per chapter (title + count, mixed when partly selected) with its own
// expand button (aria-expanded; groups start collapsed and only an expanded group renders its
// rows — a long one virtualized), the home's status filter chips (its colour swatches, next to
// the label) always shown in a "상태 필터" group, a "유형" checkbox group (none = every type), and
// "선택 n문제". Controlled: the caller loads the questions for the filters and owns
// the selection. Native Tab order (chapter checkbox → expand → question checkboxes), Space toggles;
// the list's controls carry an explicit tabIndex so WebKit (Safari's default: Tab skips buttons)
// stops on them too.
import {
  Badge,
  Button,
  Checkbox,
  ChevronDownIcon,
  ChevronUpIcon,
  questionTypeLabels,
  Skeleton,
  type QuestionDotStatus,
} from '@quiz/ui';
import { useId, useState, type ReactNode, type UIEvent } from 'react';
import type { QuestionType } from './question-body';
import {
  allIds,
  EMPTY_RANGE_FILTERS,
  isRangeFiltered,
  RANGE_STEM_CHARS,
  toggleIds,
  triState,
  type RangeFilterState,
  type RangeGroup,
  type RangeQuestion,
} from './range-model';
import overviewStyles from '../overview/questions-overview.module.css';
import styles from './question-viewer.module.css';

export interface QuestionRangePickerProps {
  /** The visible questions by chapter (null: the first read is loading). */
  readonly groups: readonly RangeGroup[] | null;
  /** A re-read for new filters is in flight (the last groups stay shown). */
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly selected: ReadonlySet<string>;
  readonly onSelectedChange: (selected: Set<string>) => void;
  /** The filters; omitted, the picker has none (a mock exam's own questions). */
  readonly filters?: RangeFilterState;
  readonly onFiltersChange?: (filters: RangeFilterState) => void;
  /** Shown when there is no question at all (without filters). */
  readonly emptyText?: string;
  /**
   * The selection count's text (default "선택 n문제"); MOCK-01 says how many questions the
   * selection makes ("선택 n문제 중 m문항을 만듭니다") in the same live line.
   */
  readonly countText?: (count: number) => ReactNode;
}

const STATUS_CHIPS: readonly { readonly status: QuestionDotStatus; readonly label: string }[] = [
  { status: 'unseen', label: '안 푼 문제' },
  { status: 'viewed', label: '본 문제' },
  { status: 'incorrect', label: '틀린 문제' },
  { status: 'correct', label: '맞힌 문제' },
  { status: 'retry', label: '다시 풀기' },
];
const TYPES: readonly QuestionType[] = ['MCQ', 'SHORT_ANSWER', 'ESSAY'];

export function QuestionRangePicker({
  groups,
  busy = false,
  error = null,
  onRetry,
  selected,
  onSelectedChange,
  filters,
  onFiltersChange,
  emptyText = '아직 확정된 문제가 없습니다.',
  countText = (n) => `선택 ${n}문제`,
}: QuestionRangePickerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const visible = groups ? allIds(groups) : [];
  const count = visible.filter((id) => selected.has(id)).length;
  const filtered = filters ? isRangeFiltered(filters) : false;
  const empty = groups !== null && visible.length === 0;
  const reset = () => onFiltersChange?.(EMPTY_RANGE_FILTERS);

  return (
    <div className={styles.picker} aria-busy={groups === null || busy || undefined}>
      {filters && onFiltersChange ? (
        <>
          <div className={styles.filterGroup} role="group" aria-label="상태 필터">
            {STATUS_CHIPS.map(({ status, label }) => (
              <Button
                key={status}
                size="sm"
                aria-pressed={filters.status.includes(status)}
                onClick={() =>
                  onFiltersChange({
                    ...filters,
                    status: filters.status.includes(status)
                      ? filters.status.filter((s) => s !== status)
                      : STATUS_CHIPS.map((c) => c.status).filter(
                          (s) => s === status || filters.status.includes(s),
                        ),
                  })
                }
              >
                <span className={overviewStyles.swatch} data-status={status} aria-hidden="true" />
                {label}
              </Button>
            ))}
            <Button
              size="sm"
              aria-pressed={filters.favorite}
              onClick={() => onFiltersChange({ ...filters, favorite: !filters.favorite })}
            >
              즐겨찾기만
            </Button>
            <Button
              size="sm"
              aria-pressed={filters.retry}
              onClick={() => onFiltersChange({ ...filters, retry: !filters.retry })}
            >
              다시 풀기만
            </Button>
            {filtered && !empty ? (
              <Button size="sm" variant="ghost" onClick={reset}>
                필터 초기화
              </Button>
            ) : null}
          </div>
          <fieldset className={styles.typeGroup}>
            <legend className={styles.typeLegend}>유형</legend>
            {TYPES.map((type) => (
              <Checkbox
                key={type}
                label={questionTypeLabels[type]}
                checked={filters.types.includes(type)}
                onCheckedChange={(checked) =>
                  onFiltersChange({
                    ...filters,
                    types: TYPES.filter((t) =>
                      t === type ? checked === true : filters.types.includes(t),
                    ),
                  })
                }
              />
            ))}
            <p className={styles.hint}>고르지 않으면 모든 유형을 보여 줍니다.</p>
          </fieldset>
        </>
      ) : null}

      {error ? (
        <div role="alert" className={styles.error}>
          <p>{error}</p>
          {onRetry ? <Button onClick={onRetry}>다시 시도</Button> : null}
        </div>
      ) : groups === null ? (
        <div aria-busy="true" className={styles.picker}>
          <p className={styles.loading}>불러오는 중…</p>
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      ) : empty ? (
        filtered ? (
          <div className={styles.alert}>
            <p>조건에 맞는 문제가 없습니다.</p>
            <Button size="sm" onClick={reset}>
              필터 초기화
            </Button>
          </div>
        ) : (
          <p className={styles.text}>{emptyText}</p>
        )
      ) : (
        <>
          <Checkbox
            label="전체 선택"
            tabIndex={0}
            checked={triState(visible, selected)}
            onCheckedChange={() => onSelectedChange(toggleIds(selected, visible))}
          />
          <ul className={styles.groups} aria-label="범위">
            {groups.map((group) => (
              <ChapterGroup
                key={group.key}
                group={group}
                expanded={expanded.has(group.key)}
                onExpandedChange={(open) =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (open) next.add(group.key);
                    else next.delete(group.key);
                    return next;
                  })
                }
                selected={selected}
                onSelectedChange={onSelectedChange}
              />
            ))}
          </ul>
        </>
      )}
      <p className={styles.selectedCount} aria-live="polite">
        {countText(count)}
      </p>
    </div>
  );
}

/** Rows an expanded chapter renders at once before it is virtualized. */
export const VIRTUALIZE_AT = 80;
/** The fixed row height of a virtualized chapter list (px). */
const ROW_PX = 44;
/** Rows rendered beyond the visible ones on either side. */
const OVERSCAN = 8;

function ChapterGroup({
  group,
  expanded,
  onExpandedChange,
  selected,
  onSelectedChange,
}: {
  readonly group: RangeGroup;
  readonly expanded: boolean;
  readonly onExpandedChange: (open: boolean) => void;
  readonly selected: ReadonlySet<string>;
  readonly onSelectedChange: (selected: Set<string>) => void;
}) {
  const listId = useId();
  const ids = group.questions.map((q) => q.id);
  const row = (q: RangeQuestion) => {
    const box = (
      <Checkbox
        label={questionLabel(q)}
        tabIndex={0}
        checked={selected.has(q.id)}
        onCheckedChange={(checked) => {
          const next = new Set(selected);
          if (checked === true) next.add(q.id);
          else next.delete(q.id);
          onSelectedChange(next);
        }}
      />
    );
    return q.badge ? (
      <div className={styles.badgedRow}>
        {box}
        <Badge>{q.badge}</Badge>
      </div>
    ) : (
      box
    );
  };
  return (
    <li className={styles.group}>
      <div className={styles.groupHeader}>
        <Checkbox
          label={`${group.title} · ${group.questions.length}문제`}
          tabIndex={0}
          checked={triState(ids, selected)}
          onCheckedChange={() => onSelectedChange(toggleIds(selected, ids))}
        />
        <Button
          size="sm"
          variant="ghost"
          borderless
          aria-label={`${group.title} 펼치기`}
          tabIndex={0}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? (
            <ChevronUpIcon width={16} height={16} aria-hidden="true" />
          ) : (
            <ChevronDownIcon width={16} height={16} aria-hidden="true" />
          )}
        </Button>
      </div>
      {expanded ? (
        group.questions.length > VIRTUALIZE_AT ? (
          <VirtualRows id={listId} items={group.questions} row={row} />
        ) : (
          <ul id={listId} className={styles.questionList}>
            {group.questions.map((q) => (
              <li key={q.id} className={styles.questionRow}>
                {row(q)}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

/** "1번 · <발문 앞 40자> · <유형>": a question's checkbox name. */
export function questionLabel(q: RangeQuestion): string {
  const stem =
    q.preview.length > RANGE_STEM_CHARS ? `${q.preview.slice(0, RANGE_STEM_CHARS)}…` : q.preview;
  return `${q.number} · ${stem} · ${questionTypeLabels[q.type]}`;
}

/**
 * A long list: only the rows in view (and a few around them) are in the DOM, each at a fixed
 * height (`rowPx`) inside a scrolling box of the list's max-block-size (24rem). Used by a long
 * chapter here and by the CHREDIST-01 recommendation list.
 */
export function VirtualRows<T extends { readonly id: string }>({
  id,
  items,
  row,
  rowPx = ROW_PX,
  label,
  listClassName = styles.questionList,
  rowClassName = styles.questionRow,
}: {
  readonly id?: string;
  readonly items: readonly T[];
  readonly row: (item: T) => ReactNode;
  readonly rowPx?: number;
  /** The list's accessible name (`aria-label`). */
  readonly label?: string;
  readonly listClassName?: string;
  readonly rowClassName?: string;
}) {
  const [top, setTop] = useState(0);
  const viewport = 24 * 16; // the list's max-block-size (24rem)
  const first = Math.max(0, Math.floor(top / rowPx) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((top + viewport) / rowPx) + OVERSCAN);
  return (
    <div
      className={styles.virtualList}
      onScroll={(event: UIEvent<HTMLDivElement>) => setTop(event.currentTarget.scrollTop)}
    >
      <ul
        id={id}
        aria-label={label}
        className={listClassName}
        style={{ blockSize: items.length * rowPx }}
      >
        {items.slice(first, last).map((item, i) => (
          <li
            key={item.id}
            className={`${rowClassName} ${styles.virtualRow}`}
            style={{ insetBlockStart: (first + i) * rowPx, blockSize: rowPx }}
          >
            {row(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}
