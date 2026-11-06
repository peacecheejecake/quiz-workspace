'use client';

// UX12-FILTER (docs/screens/ux12-home-filter.md) the workspace home's search and filter line under
// the sticky line: a 검색 button that opens the 문제 search box between itself and the 필터 button,
// whose popover holds the heatmap's chapter/type filters. The box filters as you type
// (SEARCH-01-AC12, useLiveQuery) and closing it clears the query (D-7). Without any question to
// search the button is disabled and a visible status message, linked by aria-describedby, says why.
// The page owns the state; this renders it.
import {
  ChevronLeftIcon,
  FilterIcon,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchIcon,
} from '@quiz/ui';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { LiveQuery } from './use-live-query';
import styles from './search-forms.module.css';

export const QUESTION_SEARCH_BLOCKED = '검색할 문제가 없습니다. 문제를 먼저 등록하세요.';

export interface QuestionSearchProps {
  readonly query: LiveQuery;
  readonly max: number;
  /** False when the workspace has no question to search. */
  readonly searchable: boolean;
  /** The heatmap filters, shown in the 필터 popover. */
  readonly filters: ReactNode;
  /** A filter in the popover is set: nothing else on the page shows it. */
  readonly filterActive: boolean;
  readonly screenId?: string;
}

export function QuestionSearch({
  query,
  max,
  searchable,
  filters,
  filterActive,
  screenId,
}: QuestionSearchProps) {
  const messageId = useId();
  const slotId = useId();
  const filterStateId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(query.value !== '');
  const [filterOpen, setFilterOpen] = useState(false);
  // A query from the URL (Back, Forward) is never left in a closed box.
  if (!open && query.value !== '') setOpen(true);
  const message = searchable ? null : QUESTION_SEARCH_BLOCKED;

  function toggle() {
    if (open) {
      query.clear();
      setOpen(false);
      buttonRef.current?.focus(); // Safari does not focus a clicked button
    } else {
      // In the same gesture, or iOS Safari opens no keyboard; the box is inert until this commits.
      flushSync(() => setOpen(true));
      inputRef.current?.focus();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); // Enter is not needed, but commits at once
    if (searchable) query.flush();
  }

  return (
    <form
      role="search"
      aria-label="문제 검색"
      className={styles.form}
      onSubmit={submit}
      data-screen-id={screenId}
    >
      <div className={styles.searchLine} data-open={open || undefined}>
        <IconButton
          ref={buttonRef}
          label={open ? '검색 닫기' : '검색'}
          icon={open ? <ChevronLeftIcon /> : <SearchIcon />}
          variant={open ? 'ghost' : 'secondary'}
          aria-expanded={open}
          aria-controls={slotId}
          aria-describedby={message ? messageId : undefined}
          disabled={!searchable && !open}
          onClick={toggle}
        />
        <div id={slotId} className={styles.searchSlot} inert={!open || undefined}>
          <Input
            ref={inputRef}
            type="search"
            label="문제 검색"
            hideLabel
            placeholder="문제 검색"
            maxLength={max}
            autoComplete="off"
            enterKeyHint="search"
            disabled={!searchable}
            aria-describedby={message ? messageId : undefined}
            fieldClassName={styles.field}
            {...query.inputProps}
          />
        </div>
        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger asChild>
            <IconButton
              label="필터"
              icon={<FilterIcon />}
              variant="secondary"
              className={styles.filterButton}
              data-active={filterActive || undefined}
              aria-describedby={filterActive ? filterStateId : undefined}
            />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={16}
            aria-label="필터"
            className={styles.filterPopover}
          >
            {filters}
          </PopoverContent>
        </Popover>
        <span id={filterStateId} className="qz-visually-hidden">
          {filterActive ? '필터 적용 중' : ''}
        </span>
      </div>
      {/* Always mounted so a change is announced; empty while there is nothing to say. */}
      <p
        id={messageId}
        role="status"
        className={styles.message}
        data-blocked={!searchable || undefined}
      >
        {message}
      </p>
    </form>
  );
}
