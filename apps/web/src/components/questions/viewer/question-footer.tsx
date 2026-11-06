'use client';

import { ArrowLeftIcon, Button, IconButton, Tooltip, useToast } from '@quiz/ui';
import { useId, useRef, useState } from 'react';
import styles from './question-viewer.module.css';

// Footer controls of the two answering viewers, so a question opened from the Heatmap and a
// position of a run have the same buttons (UX12-RUNBAR).

const ANOTHER_TRY_REASON = '답안을 제출하고 채점이 끝나면 다시 풀 수 있습니다.';

/**
 * Previous/next arrow, as tall as `제출` (UX10-QVIEW-AC02, UX12-VIEW-AC01). While it cannot move the
 * button stays focusable (`aria-disabled`), so focus does not drop out of the panel at the ends.
 */
function NavButton({
  direction,
  label,
  unavailable,
  onClick,
}: {
  readonly direction: 'previous' | 'next';
  readonly label: string;
  readonly unavailable: boolean;
  readonly onClick: () => void;
}) {
  return (
    <IconButton
      label={label}
      variant="ghost"
      icon={
        <ArrowLeftIcon
          width={20}
          height={20}
          style={direction === 'next' ? { transform: 'rotate(180deg)' } : undefined}
        />
      }
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (!unavailable) onClick();
      }}
    />
  );
}

/** `이전 문제` · `다음 문제` at the end of the footer. */
export function QuestionNav({
  previousUnavailable,
  nextUnavailable,
  onPrevious,
  onNext,
}: {
  readonly previousUnavailable: boolean;
  readonly nextUnavailable: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  return (
    <nav className={styles.nav} aria-label="문제 이동">
      <NavButton
        direction="previous"
        label="이전 문제"
        unavailable={previousUnavailable}
        onClick={onPrevious}
      />
      <NavButton
        direction="next"
        label="다음 문제"
        unavailable={nextUnavailable}
        onClick={onNext}
      />
    </nav>
  );
}

/**
 * `다시 풀기`: visible while answering, inert until the result is settled (UX12-VIEW-AC04,
 * UX12-RUNBAR-AC04). The reason is an accessible description and a tooltip; a press says it in a
 * toast, because touch has no tooltip.
 */
export function AnotherTryButton({
  available,
  onTry,
}: {
  readonly available: boolean;
  readonly onTry: () => void;
}) {
  const reasonId = useId();
  const [hinted, setHinted] = useState(false);
  const { toast, dismiss } = useToast();
  const reasonToast = useRef<number | null>(null);
  return (
    <>
      <Tooltip open={hinted && !available} onOpenChange={setHinted} content={ANOTHER_TRY_REASON}>
        <Button
          aria-disabled={!available || undefined}
          aria-describedby={available ? undefined : reasonId}
          onClick={() => {
            if (available) {
              onTry();
              return;
            }
            if (reasonToast.current !== null) dismiss(reasonToast.current);
            reasonToast.current = toast({ title: ANOTHER_TRY_REASON });
          }}
        >
          다시 풀기
        </Button>
      </Tooltip>
      {available ? null : (
        <span id={reasonId} className="qz-visually-hidden">
          {ANOTHER_TRY_REASON}
        </span>
      )}
    </>
  );
}
