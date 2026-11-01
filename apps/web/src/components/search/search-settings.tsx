'use client';

// The small "설정" text button next to a search box (SEARCH-01-AC09, UX6 → UX7-SEARCH): opens that
// search's detailed settings in a Radix popover (click, tap and keyboard; not a hover tooltip).
// Escape and an outside click close it and focus returns to the button.
import { Popover, PopoverContent, PopoverTrigger } from '@quiz/ui';
import { useId, useState, type ReactNode } from 'react';
import styles from './search-forms.module.css';

export function SearchSettings({
  label,
  children,
}: {
  /** "문제" / "본문": the button is "<label> 설정", the popover "<label> 검색 설정". */
  readonly label: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Visible "설정"; the name "<label> 설정" contains it (label in name). */}
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
        {children}
      </PopoverContent>
    </Popover>
  );
}
