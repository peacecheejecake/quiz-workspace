'use client';

// SEARCH-01-AC07 the workspace home's unified search form (docs/screens/search.md, UX6): the box
// with an icon-only submit, then the two scope checkboxes 문제 · 본문, each with a small "설정"
// text button that opens that scope's settings in a Radix popover (click, tap and keyboard; not a
// hover tooltip). When the scopes leave nothing to search the submit button is disabled and a
// visible status message under the checkboxes, linked to the button by aria-describedby, says
// why (a disabled button gets neither hover nor focus, so a tooltip alone would not reach anyone).
// The page owns the state; this renders it.
import {
  Checkbox,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchIcon,
} from '@quiz/ui';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { MAX_QUERY_CHARS } from '@/lib/search/state';
import {
  SEARCH_BLOCK_MESSAGES,
  SEARCH_NOTICE_MESSAGES,
  type SearchReadiness,
} from '@/lib/search/scope';
import styles from './unified-search.module.css';

export interface SearchScopeControl {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  /** The scope's detailed settings, shown in its "설정" popover. */
  readonly settings: ReactNode;
}

export interface UnifiedSearchFormProps {
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  /** Called only when the search is not blocked. */
  readonly onSearch: () => void;
  readonly readiness: SearchReadiness;
  readonly questions: SearchScopeControl;
  readonly body: SearchScopeControl;
  readonly screenId?: string;
}

export function UnifiedSearchForm({
  draft,
  onDraftChange,
  onSearch,
  readiness,
  questions,
  body,
  screenId,
}: UnifiedSearchFormProps) {
  const messageId = useId();
  const blocked = readiness.blocked !== null;
  const message = readiness.blocked
    ? SEARCH_BLOCK_MESSAGES[readiness.blocked]
    : readiness.notice
      ? SEARCH_NOTICE_MESSAGES[readiness.notice]
      : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!blocked) onSearch();
  }

  return (
    <form
      role="search"
      aria-label="통합 검색"
      className={styles.form}
      onSubmit={submit}
      data-screen-id={screenId}
    >
      <div className={styles.row}>
        <Input
          type="search"
          label="검색어"
          hideLabel
          placeholder="문제와 본문 검색"
          value={draft}
          maxLength={MAX_QUERY_CHARS}
          autoComplete="off"
          fieldClassName={styles.field}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <IconButton
          type="submit"
          variant="primary"
          label="검색"
          icon={<SearchIcon />}
          disabled={blocked}
          aria-describedby={message ? messageId : undefined}
        />
      </div>
      <fieldset className={styles.scopes}>
        <legend className="qz-visually-hidden">검색 범위</legend>
        <ScopeToggle label="문제" control={questions} />
        <ScopeToggle label="본문" control={body} />
      </fieldset>
      {/* Always mounted so a change is announced; empty while there is nothing to say. */}
      <p
        id={messageId}
        role="status"
        className={styles.message}
        data-blocked={blocked || undefined}
      >
        {message}
      </p>
    </form>
  );
}

function ScopeToggle({
  label,
  control,
}: {
  readonly label: string;
  readonly control: SearchScopeControl;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <div className={styles.scope}>
      <Checkbox
        label={label}
        checked={control.checked}
        onCheckedChange={(checked) => control.onCheckedChange(checked === true)}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* Visible "설정"; the name "<scope> 설정" contains it (label in name). */}
          <button
            type="button"
            aria-label={`${label} 설정`}
            className={`${styles.settingsToggle} qz-focus-ring`}
          >
            설정
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-labelledby={titleId}
          closeLabel={`${label} 검색 설정 닫기`}
          className={styles.settings}
        >
          <p id={titleId} className={styles.settingsTitle}>
            {label} 검색 설정
          </p>
          {control.settings}
        </PopoverContent>
      </Popover>
    </div>
  );
}
