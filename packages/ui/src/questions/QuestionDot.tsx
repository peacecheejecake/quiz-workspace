'use client';

import type { ButtonHTMLAttributes, MouseEvent, Ref } from 'react';
import { cx } from '../internal/cx';
import { QuestionMarker } from './QuestionMarker';
import { QuestionPreviewPopover } from './QuestionPreviewPopover';
import {
  questionDotLabel,
  type LastGradedResult,
  type QuestionDotStatus,
  type QuestionType,
} from './status';

/** docs/design-system.md §6 contract, plus optional label details (§3.2 aria-label example). */
export interface QuestionDotProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children' | 'onClick' | 'type'
> {
  questionId: string;
  status: QuestionDotStatus;
  isFavorite: boolean;
  questionNumber: string;
  questionType: QuestionType;
  chapterTitle: string;
  /** Stem shown in the hover/focus preview. Never the answer. */
  preview: string;
  /** The question currently open in the practice panel: outlined, color unchanged. */
  isSelected?: boolean;
  /** Click, Enter or Space (also the first touch tap): open the practice panel. */
  onOpen: (questionId: string) => void;
  /** Chapter number for the label (`3장 12번 문제`); falls back to `chapterTitle`. */
  chapterNumber?: number | string;
  lastGradedResult?: LastGradedResult;
  needsRetry?: boolean;
  isPendingGrading?: boolean;
  /**
   * The hover/focus preview opened. Informational only: it must never mark the question
   * viewed (docs/questions.md §2.1, QOV-01-AC02).
   */
  onPreview?: (questionId: string) => void;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * One CONFIRMED question in the heatmap: a fixed-size `<button>` cell centering a marker drawn at the cell size.
 * Only the marker scales on hover / `:focus-visible`, so the grid never shifts.
 */
export function QuestionDot({
  questionId,
  status,
  isFavorite,
  questionNumber,
  questionType,
  chapterTitle,
  preview,
  isSelected = false,
  onOpen,
  chapterNumber,
  lastGradedResult,
  needsRetry,
  isPendingGrading,
  onPreview,
  className,
  ref,
  ...rest
}: QuestionDotProps) {
  const labelInput = {
    questionNumber,
    questionType,
    status,
    isFavorite,
    chapterNumber,
    chapterTitle,
    lastGradedResult,
    needsRetry,
    isPendingGrading,
  };
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Safari does not focus buttons on click; focus the dot so the panel can return focus here.
    event.currentTarget.focus({ preventScroll: true });
    onOpen(questionId);
  };
  return (
    <QuestionPreviewPopover
      {...labelInput}
      preview={preview}
      onOpenChange={(open) => {
        if (open) onPreview?.(questionId);
      }}
    >
      <button
        ref={ref}
        type="button"
        className={cx('qz-question-dot', className)}
        aria-label={questionDotLabel(labelInput)}
        aria-current={isSelected ? 'true' : undefined}
        data-question-id={questionId}
        data-status={status}
        data-favorite={isFavorite ? '' : undefined}
        data-selected={isSelected ? '' : undefined}
        onClick={handleClick}
        {...rest}
      >
        <QuestionMarker status={status} favorite={isFavorite} />
      </button>
    </QuestionPreviewPopover>
  );
}
