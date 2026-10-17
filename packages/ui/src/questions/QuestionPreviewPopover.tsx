'use client';

import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactElement } from 'react';
import { useLayerStyle } from '../internal/layer';
import { MarkerShape } from './QuestionMarker';
import {
  questionStatusPhrases,
  questionTitle,
  questionTypeLabels,
  type QuestionLabelInput,
} from './status';

/** Default hover delay before the preview opens (docs/questions.md §3.2: "about 200ms"). */
const QUESTION_PREVIEW_DELAY_MS = 200;

export interface QuestionPreviewPopoverProps extends QuestionLabelInput {
  /** Stem text; the preview shows its first 1–3 lines. Never pass the answer or explanation. */
  preview: string;
  /** The dot (a single focusable element). */
  children: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  /**
   * Fires when the preview opens/closes. A preview is not a study view: never record
   * `firstViewedAt` from here (docs/questions.md §2.1).
   */
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Quick question preview on hover (after ~200ms) and keyboard focus, built on Radix Tooltip:
 * role `tooltip`, Escape closes it while focus stays on the dot, touch taps never open it (a tap
 * opens the practice panel instead). Content is non-interactive by design.
 */
export function QuestionPreviewPopover({
  preview,
  children,
  open,
  defaultOpen,
  onOpenChange,
  delayDuration = QUESTION_PREVIEW_DELAY_MS,
  side = 'top',
  ...question
}: QuestionPreviewPopoverProps) {
  const layerStyle = useLayerStyle();
  const title = questionTitle(question);
  const type = questionTypeLabels[question.questionType];
  const phrases = questionStatusPhrases(question);
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="qz-popover glass-surface qz-question-preview"
            style={layerStyle}
            // The trigger's accessible name already carries title/type/status; the description
            // adds the stem.
            aria-label={preview}
          >
            <p className="qz-question-preview__meta">
              <span>{type}</span>
              <span aria-hidden="true"> · </span>
              <span>{title}</span>
            </p>
            {question.chapterNumber !== undefined && question.chapterNumber !== '' ? (
              <p className="qz-question-preview__chapter">{question.chapterTitle}</p>
            ) : null}
            <p className="qz-question-preview__status">
              <MarkerShape
                status={question.status}
                favorite={question.isFavorite}
                className="qz-question-preview__marker"
              />
              <span>{phrases.join(' · ')}</span>
            </p>
            <p className="qz-question-preview__stem">{preview}</p>
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
