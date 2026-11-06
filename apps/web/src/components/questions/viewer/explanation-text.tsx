'use client';

// HILITE-01 explanation area of QuestionViewer: the human-written explanation as a
// `HighlightableText` "해설" (one block per blank-line-separated paragraph) with the reader's own
// highlights and the shared `HighlightMenu`. It is only rendered where the explanation is already
// on screen — after a submission (`practice`, `sequence(bank)`) or in 문제 상세 (`manage`) — so the
// highlights are read then and never before (AGENTS.md §5). The text shows at once; the
// highlights are drawn when they arrive. Places without highlights (mock exam questions, share
// guests, older revisions) get the plain text.
import { HighlightableText } from '@quiz/ui';
import { useEffect, useMemo, useRef } from 'react';
import { getQuestionHighlights } from '@/lib/highlights/client';
import { explanationBlocks, explanationHighlightsOf, HIGHLIGHT_TEXT } from '@/lib/highlights/model';
import { useHighlightStore, useHighlightTool } from '../notes/highlight-tool';
import styles from './question-viewer.module.css';

export interface ExplanationHighlighting {
  readonly questionId: string;
  /** The revision whose explanation is shown (the API refuses a stale one). */
  readonly revisionId?: string | null;
  /** Focus this highlight's mark once it is drawn (`내 하이라이트` › `위치로 이동`). */
  readonly focusId?: string | null;
}

export function ExplanationText({
  text,
  className,
  highlighting,
}: {
  readonly text: string;
  readonly className?: string;
  readonly highlighting?: ExplanationHighlighting | null;
}) {
  if (!highlighting) return <p className={className}>{text}</p>;
  return <HighlightedExplanation text={text} className={className} highlighting={highlighting} />;
}

const identity = (block: string, start: number, end: number) => ({ block, start, end });

function HighlightedExplanation({
  text,
  className,
  highlighting,
}: {
  readonly text: string;
  readonly className: string | undefined;
  readonly highlighting: ExplanationHighlighting;
}) {
  const { questionId, revisionId, focusId } = highlighting;
  const store = useHighlightStore(
    (signal) => getQuestionHighlights(questionId, signal),
    questionId,
  );
  const blocks = useMemo(() => explanationBlocks(text), [text]);
  const drawn = useMemo(
    () => explanationHighlightsOf(store.items ?? [], questionId),
    [store.items, questionId],
  );
  const areaRef = useRef<HTMLDivElement>(null);
  const { onSelectRange, activeHighlightId, menu } = useHighlightTool({
    store,
    areaRef,
    drawn,
    toAnchor: identity,
    target: {
      kind: 'explanation',
      question_id: questionId,
      ...(revisionId ? { question_revision_id: revisionId } : {}),
    },
  });

  // 위치로 이동: the mark gets focus once the highlights are drawn.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || focused.current === focusId) return;
    const mark = areaRef.current?.querySelector<HTMLElement>(
      `mark[data-highlight-id="${CSS.escape(focusId)}"]`,
    );
    if (!mark) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;
    mark.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    mark.focus({ preventScroll: true });
    focused.current = focusId;
  }, [focusId, drawn]);

  // One box for the area and a refused change's message (the explanation's section is a grid).
  return (
    <div>
      <HighlightableText
        ref={areaRef}
        label={HIGHLIGHT_TEXT.explanationLabel}
        blocks={blocks}
        highlights={drawn}
        onSelectRange={onSelectRange}
        activeHighlightId={activeHighlightId}
        className={`${styles.explanation} ${className ?? ''}`}
      />
      {menu}
    </div>
  );
}
