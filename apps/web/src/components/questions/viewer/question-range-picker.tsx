'use client';

// QVIEW-01 `QuestionRangePicker` (docs/screens/question-viewer.md "범위 고르기 단계", shared with
// MOCK-01's 출제 범위): chapter group → question checkboxes over the questions a range can hold,
// `전체 선택` on top (tri-state over what the filters show: aria-checked="mixed" when partly
// selected), one checkbox per chapter (title + count, mixed when partly selected) with its own
// expand button (aria-expanded; groups start collapsed and only an expanded group renders its
// rows — a long one virtualized), the home's status filter chips in a collapsible "상태 필터"
// group, and "선택 n문제". Controlled: the caller loads the questions for the filters and owns
// the selection. Native Tab order (chapter checkbox → expand → question checkboxes), Space toggles;
// the list's controls carry an explicit tabIndex so WebKit (Safari's default: Tab skips buttons)
// stops on them too.
import {
  Button,
  Checkbox,
  ChevronDownIcon,
  ChevronUpIcon,
  questionTypeLabels,
  Select,
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
  /**
   * One flat list numbered "문제 k" without chapter rows (a mock exam's own questions, which keep
   * no chapter of their own: QVIEW-01-AC05).
   */
  readonly flat?: boolean;
}

const STATUS_CHIPS: readonly { readonly status: QuestionDotStatus; readonly label: string }[] = [
  { status: 'unseen', label: '안 푼 문제' },
  { status: 'viewed', label: '본 문제' },
  { status: 'incorrect', label: '틀린 문제' },
  { status: 'correct', label: '맞힌 문제' },
];
const ALL_TYPES = '__all__';
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
  flat = false,
}: QuestionRangePickerProps) {
  const filterId = useId();
  const [filtersOpen, setFiltersOpen] = useState(false);
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
          <div>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={filtersOpen}
              aria-controls={filterId}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              상태 필터
              {filtersOpen ? (
                <ChevronUpIcon width={16} height={16} aria-hidden="true" />
              ) : (
                <ChevronDownIcon width={16} height={16} aria-hidden="true" />
              )}
            </Button>
          </div>
          <div
            id={filterId}
            className={styles.filterGroup}
            role="group"
            aria-label="상태 필터"
            hidden={!filtersOpen}
          >
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
            <Select
              label="유형"
              options={[
                { value: ALL_TYPES, label: '전체 유형' },
                ...TYPES.map((type) => ({ value: type, label: questionTypeLabels[type] })),
              ]}
              value={filters.type ?? ALL_TYPES}
              onValueChange={(value) =>
                value &&
                onFiltersChange({
                  ...filters,
                  type: value === ALL_TYPES ? null : (value as QuestionType),
                })
              }
            />
            {filtered && !empty ? (
              <Button size="sm" variant="ghost" onClick={reset}>
                필터 초기화
              </Button>
            ) : null}
          </div>
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
          {flat ? (
            <ul className={styles.questionList} aria-label="범위">
              {groups
                .flatMap((g) => g.questions)
                .map((q, i) => (
                  <li key={q.id} className={styles.questionRow}>
                    <Checkbox
                      label={questionLabel({ ...q, number: `문제 ${i + 1}` })}
                      tabIndex={0}
                      checked={selected.has(q.id)}
                      onCheckedChange={(checked) => {
                        const next = new Set(selected);
                        if (checked === true) next.add(q.id);
                        else next.delete(q.id);
                        onSelectedChange(next);
                      }}
                    />
                  </li>
                ))}
            </ul>
          ) : (
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
          )}
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
  const row = (q: RangeQuestion) => (
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
          <VirtualRows id={listId} questions={group.questions} row={row} />
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

/** "1장 1번 · <발문 앞 40자> · <유형>": a question's checkbox name. */
export function questionLabel(q: RangeQuestion): string {
  const stem =
    q.preview.length > RANGE_STEM_CHARS ? `${q.preview.slice(0, RANGE_STEM_CHARS)}…` : q.preview;
  return `${q.number} · ${stem} · ${questionTypeLabels[q.type]}`;
}

/** A long chapter: only the rows in view (and a few around them) are in the DOM. */
function VirtualRows({
  id,
  questions,
  row,
}: {
  readonly id: string;
  readonly questions: readonly RangeQuestion[];
  readonly row: (q: RangeQuestion) => ReactNode;
}) {
  const [top, setTop] = useState(0);
  const viewport = 24 * 16; // the list's max-block-size (24rem)
  const first = Math.max(0, Math.floor(top / ROW_PX) - OVERSCAN);
  const last = Math.min(questions.length, Math.ceil((top + viewport) / ROW_PX) + OVERSCAN);
  return (
    <div
      className={styles.virtualList}
      onScroll={(event: UIEvent<HTMLDivElement>) => setTop(event.currentTarget.scrollTop)}
    >
      <ul id={id} className={styles.questionList} style={{ blockSize: questions.length * ROW_PX }}>
        {questions.slice(first, last).map((q, i) => (
          <li
            key={q.id}
            className={`${styles.questionRow} ${styles.virtualRow}`}
            style={{ insetBlockStart: (first + i) * ROW_PX, blockSize: ROW_PX }}
          >
            {row(q)}
          </li>
        ))}
      </ul>
    </div>
  );
}
