'use client';

// The 본문 search's `AI에게 묻기` (ASK-01 "본문 검색의 AI에게 묻기"): opens the AI 질문 panel on a new
// conversation with the search text in its input (never sent) and the search's document/chapter
// filter as its 질문 범위. A button, not a menu item: when new questions are off it stays focusable
// with aria-disabled and its reason as text (aria-describedby).
import { Button } from '@quiz/ui';
import { useId } from 'react';
import styles from './ask.module.css';

export function AskSearchButton({
  unavailable,
  onAsk,
}: {
  /** Why new questions are off here (null: they are not). */
  readonly unavailable: string | null;
  readonly onAsk: () => void;
}) {
  const reasonId = useId();
  return (
    <span className={styles.searchAsk}>
      <Button
        size="sm"
        variant="ghost"
        aria-label="본문 검색어로 AI에게 묻기"
        aria-disabled={unavailable ? true : undefined}
        aria-describedby={unavailable ? reasonId : undefined}
        onClick={() => {
          if (!unavailable) onAsk();
        }}
      >
        AI에게 묻기
      </Button>
      {unavailable ? (
        <span id={reasonId} className={styles.hint}>
          {unavailable}
        </span>
      ) : null}
    </span>
  );
}
