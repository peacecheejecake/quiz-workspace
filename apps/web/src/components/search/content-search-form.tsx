'use client';

// SEARCH-01-AC09 the 본문 search form (docs/screens/search.md, UX7-SEARCH) at the top of the 본문
// search page (SEARCH-02, UX9): the box with an icon-only submit (the search API runs on Enter or
// the button, not live) and the "본문 설정" popover. Without a published document the
// submit is disabled and a visible status message, linked by aria-describedby, says why (a
// disabled button gets neither hover nor focus, so a tooltip alone would not reach anyone).
import { IconButton, Input, SearchIcon } from '@quiz/ui';
import { useId, type FormEvent, type ReactNode, type Ref } from 'react';
import { MAX_QUERY_CHARS } from '@/lib/search/state';
import { SearchSettings } from './search-settings';
import styles from './search-forms.module.css';

export const CONTENT_SEARCH_BLOCKED = '검색할 본문이 없습니다. 문서를 먼저 등록하고 발행하세요.';

export interface ContentSearchFormProps {
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  /** Called only when the search is not blocked. */
  readonly onSearch: () => void;
  /** False when there is no published document to search. */
  readonly searchable: boolean;
  /** The content-search options, shown in the "본문 설정" popover. */
  readonly settings: ReactNode;
  readonly inputRef?: Ref<HTMLInputElement>;
  /** Extra action after the search button (the home's `AI에게 묻기`, ASK-01). */
  readonly extraAction?: ReactNode;
}

export function ContentSearchForm({
  draft,
  onDraftChange,
  onSearch,
  searchable,
  settings,
  inputRef,
  extraAction,
}: ContentSearchFormProps) {
  const messageId = useId();
  const message = searchable ? null : CONTENT_SEARCH_BLOCKED;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searchable) onSearch();
  }

  return (
    <form role="search" aria-label="본문 검색" className={styles.form} onSubmit={submit}>
      <div className={styles.row}>
        <Input
          ref={inputRef}
          type="search"
          label="본문 검색어"
          hideLabel
          placeholder="책 본문 검색"
          value={draft}
          maxLength={MAX_QUERY_CHARS}
          autoComplete="off"
          enterKeyHint="search"
          fieldClassName={styles.field}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <IconButton
          type="submit"
          variant="primary"
          label="검색"
          icon={<SearchIcon />}
          disabled={!searchable}
          aria-describedby={message ? messageId : undefined}
        />
        {extraAction}
        <SearchSettings label="본문">{settings}</SearchSettings>
      </div>
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
