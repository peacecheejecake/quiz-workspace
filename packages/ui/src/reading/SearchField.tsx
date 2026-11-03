'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { cx } from '../internal/cx';
import { ownEscapeProps } from '../internal/own-escape';
import { IconButton } from '../primitives/IconButton';
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from '../primitives/icons';

/** Typing waits this long before searching (CHNOTE-02 "검색 줄"). */
export const SEARCH_DEBOUNCE_MS = 150;

export const SEARCH_FIELD_TEXT = {
  previous: '이전 결과',
  next: '다음 결과',
  none: '결과 없음',
  wrappedToFirst: '처음부터 다시',
  wrappedToLast: '마지막부터 다시',
} as const;

export interface SearchFieldProps {
  /** Accessible name and default placeholder, e.g. "노트에서 찾기". */
  label: string;
  placeholder?: string;
  /** The typed text (controlled). */
  value: string;
  onValueChange: (value: string) => void;
  /** The query to search for: `value` after the debounce, at once on Enter and when cleared. */
  onSearch: (query: string) => void;
  /** Number of results of the last search (capped results: the cap). */
  total: number;
  /** 1-based position of the current result; 0 when there is none. */
  current: number;
  /** More results exist than `total` (the count reads "1000+"). */
  capped?: boolean;
  onNext: () => void;
  onPrevious: () => void;
  debounceMs?: number;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * Find-in-text row (CHNOTE-02 "검색 줄"): a `type="search"` field with a search icon, the result
 * count "k/n" (read politely as "n개 중 k번째"; "결과 없음" when nothing matches) and previous /
 * next buttons. Enter goes to the next result and Shift+Enter to the previous one, wrapping
 * around with a polite "처음부터 다시". Escape clears a non-empty field without closing the dialog
 * around it (`ownEscapeProps`); on an empty field it closes the dialog as usual.
 */
export function SearchField({
  label,
  placeholder,
  value,
  onValueChange,
  onSearch,
  total,
  current,
  capped = false,
  onNext,
  onPrevious,
  debounceMs = SEARCH_DEBOUNCE_MS,
  className,
  inputRef,
}: SearchFieldProps) {
  const statusId = useId();
  const [query, setQuery] = useState(value);
  const [wrapped, setWrapped] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const search = useRef(onSearch);
  const latest = useRef(value);
  useEffect(() => {
    search.current = onSearch;
    latest.current = value;
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function run(next: string) {
    window.clearTimeout(timer.current);
    setQuery(next);
    setWrapped('');
    search.current(next);
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    onValueChange(next);
    window.clearTimeout(timer.current);
    if (next === '') {
      run('');
      return;
    }
    timer.current = window.setTimeout(() => {
      // An outside reset (panel reopened, version changed) while waiting wins.
      if (latest.current === next) run(next);
    }, debounceMs);
  }

  function step(direction: 'next' | 'previous') {
    if (total === 0) return;
    if (direction === 'next') {
      setWrapped(current >= total ? SEARCH_FIELD_TEXT.wrappedToFirst : '');
      onNext();
    } else {
      setWrapped(current <= 1 ? SEARCH_FIELD_TEXT.wrappedToLast : '');
      onPrevious();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Pending typing is searched first; Enter then lands on its first result.
      if (value !== query || !shown) {
        run(value);
        return;
      }
      step(event.shiftKey ? 'previous' : 'next');
      return;
    }
    if (event.key === 'Escape' && value !== '') {
      event.preventDefault();
      event.stopPropagation();
      onValueChange('');
      run('');
    }
  }

  // An outside reset of `value` clears the shown query too.
  const shown = query !== '' && value !== '';
  const count = capped ? `${total}+` : String(total);

  return (
    <div className={cx('qz-search-field', className)}>
      <span className="field">
        <SearchIcon className="icon" width={16} height={16} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          aria-label={label}
          placeholder={placeholder ?? label}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          aria-describedby={shown ? statusId : undefined}
          autoComplete="off"
          spellCheck={false}
          className="input qz-focus-ring"
          {...(value === '' ? {} : ownEscapeProps)}
        />
      </span>
      <span id={statusId} className="count" aria-live="polite" aria-atomic="true">
        {!shown ? null : total === 0 ? (
          SEARCH_FIELD_TEXT.none
        ) : (
          <>
            <span aria-hidden="true">{`${current}/${count}`}</span>
            <span className="qz-visually-hidden">{`${count}개 중 ${current}번째`}</span>
          </>
        )}
      </span>
      <span className="qz-visually-hidden" aria-live="polite">
        {wrapped}
      </span>
      <IconButton
        label={SEARCH_FIELD_TEXT.previous}
        icon={<ChevronUpIcon width={16} height={16} />}
        size="sm"
        disabled={total === 0}
        onClick={() => step('previous')}
      />
      <IconButton
        label={SEARCH_FIELD_TEXT.next}
        icon={<ChevronDownIcon width={16} height={16} />}
        size="sm"
        disabled={total === 0}
        onClick={() => step('next')}
      />
    </div>
  );
}
