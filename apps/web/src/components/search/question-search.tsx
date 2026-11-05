'use client';

// SEARCH-01-AC09/AC12 the workspace home's 문제 search (docs/screens/search.md, UX7-SEARCH): a
// search box without a button that filters the heatmap as you type (useLiveQuery), and the "문제
// 설정" popover with the heatmap's chapter/type filters. Without any question to search the box is
// disabled and a visible status message, linked by aria-describedby, says why. The page owns the
// state; this renders it.
import { Input, IconButton, ChevronDownIcon, ChevronUpIcon } from '@quiz/ui';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { LiveQuery } from './use-live-query';
import styles from './search-forms.module.css';

export const QUESTION_SEARCH_BLOCKED = '검색할 문제가 없습니다. 문제를 먼저 등록하세요.';

export interface QuestionSearchProps {
  readonly query: LiveQuery;
  readonly max: number;
  /** False when the workspace has no question to search. */
  readonly searchable: boolean;
  /** The heatmap filters, shown in the "문제 설정" popover. */
  readonly settings: ReactNode;
  readonly screenId?: string;
}

export function QuestionSearch({
  query,
  max,
  searchable,
  settings,
  screenId,
}: QuestionSearchProps) {
  const messageId = useId();
  const settingsId = useId();
  const [settingsOpen, setSettingsOpen] = useState(true);
  const message = searchable ? null : QUESTION_SEARCH_BLOCKED;

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
      <div className={styles.row}>
        <Input
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
        <IconButton
          label="검색 설정"
          icon={settingsOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}
          aria-expanded={settingsOpen}
          aria-controls={settingsId}
          onClick={() => setSettingsOpen(!settingsOpen)}
        />
      </div>
      <div id={settingsId} hidden={!settingsOpen}>
        {settings}
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
