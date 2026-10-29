'use client';

import {
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cx } from '../internal/cx';
import { QuestionDot } from './QuestionDot';
import type { LastGradedResult, QuestionDotStatus, QuestionType } from './status';

export interface HeatmapQuestion {
  id: string;
  number: string;
  type: QuestionType;
  status: QuestionDotStatus;
  isFavorite: boolean;
  /** Stem for the preview (first 1–3 lines are shown). Never the answer. */
  preview: string;
  lastGradedResult?: LastGradedResult;
  needsRetry?: boolean;
  isPendingGrading?: boolean;
}

export interface HeatmapChapter {
  id: string;
  title: string;
  /** Used in dot labels (`3장 12번 문제`). */
  number?: number | string;
  /** CONFIRMED questions only, in display order (chapter sort order, then number). */
  questions: HeatmapQuestion[];
}

export interface QuestionHeatmapProps {
  chapters: HeatmapChapter[];
  onOpen: (questionId: string) => void;
  /** Preview opened (hover/focus). Never use it to mark a question viewed. */
  onPreview?: (questionId: string) => void;
  /** Question open in the practice panel; it is also the default roving tab stop. */
  selectedQuestionId?: string | null;
  /** Accessible name of the whole heatmap. */
  label?: string;
  /** Heading level of the chapter titles. */
  headingLevel?: 2 | 3 | 4;
  /**
   * Controls at the end of a chapter header (e.g. the chapter's 정리 노트 button). Every header
   * keeps the same height with or without them, so the dot grids never shift.
   */
  renderChapterActions?: (chapter: HeatmapChapter) => ReactNode;
  className?: string;
}

const DOT_SELECTOR = '[data-question-id]';

function dotsIn(root: ParentNode | null | undefined): HTMLButtonElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLButtonElement>(DOT_SELECTOR)) : [];
}

/**
 * The dot visually below/above `current`: the nearest row in that direction (across chapter
 * boundaries), then the dot whose horizontal center is closest. Uses layout, so it follows the
 * responsive column count.
 */
function verticalNeighbour(
  dots: HTMLButtonElement[],
  current: HTMLButtonElement,
  direction: 1 | -1,
): HTMLButtonElement | undefined {
  const from = current.getBoundingClientRect();
  const centerX = from.left + from.width / 2;
  const candidates = dots
    .map((dot) => ({ dot, rect: dot.getBoundingClientRect() }))
    .filter(({ rect }) => (direction === 1 ? rect.top > from.top + 1 : rect.top < from.top - 1));
  if (candidates.length === 0) return undefined;
  const rowTop =
    direction === 1
      ? Math.min(...candidates.map(({ rect }) => rect.top))
      : Math.max(...candidates.map(({ rect }) => rect.top));
  const row = candidates.filter(({ rect }) => Math.abs(rect.top - rowTop) <= 1);
  row.sort(
    (a, b) =>
      Math.abs(a.rect.left + a.rect.width / 2 - centerX) -
      Math.abs(b.rect.left + b.rect.width / 2 - centerX),
  );
  return row[0]?.dot;
}

/**
 * Chapter-grouped question heatmap (docs/questions.md §3, design-system.md §6). One roving tab
 * stop: Tab enters/leaves the heatmap, Arrow keys move between dots (Up/Down by visual row),
 * Home/End jump to the first/last dot of the chapter, Ctrl+Home/End of the whole heatmap.
 * Enter/Space/click open a question (`onOpen`); hover/focus shows the preview after ~200ms.
 *
 * Not virtualized: fine for hundreds of dots; consider windowing beyond ~2,000 questions.
 */
export function QuestionHeatmap({
  chapters,
  onOpen,
  onPreview,
  selectedQuestionId,
  label = '문제 heatmap',
  headingLevel = 3,
  renderChapterActions,
  className,
}: QuestionHeatmapProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);

  const ids = chapters.flatMap((chapter) => chapter.questions.map((q) => q.id));
  const known = new Set(ids);
  const tabStop =
    (activeId && known.has(activeId) && activeId) ||
    (selectedQuestionId && known.has(selectedQuestionId) && selectedQuestionId) ||
    ids[0];

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>(DOT_SELECTOR)?.dataset[
      'questionId'
    ];
    if (id) setActiveId(id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.shiftKey) return;
    const current = (event.target as HTMLElement).closest<HTMLButtonElement>(DOT_SELECTOR);
    if (!current) return;
    const all = dotsIn(rootRef.current);
    const index = all.indexOf(current);
    if (index === -1) return;
    const chapterDots = dotsIn(current.closest('ul'));
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case 'ArrowRight':
        next = all[index + 1];
        break;
      case 'ArrowLeft':
        next = all[index - 1];
        break;
      case 'ArrowDown':
        next = verticalNeighbour(all, current, 1);
        break;
      case 'ArrowUp':
        next = verticalNeighbour(all, current, -1);
        break;
      case 'Home':
        next = event.ctrlKey ? all[0] : chapterDots[0];
        break;
      case 'End':
        next = event.ctrlKey ? all.at(-1) : chapterDots.at(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (!next || next === current) return;
    const id = next.dataset['questionId'];
    if (id) setActiveId(id);
    next.focus();
  };

  const Heading = `h${headingLevel}` as const;

  return (
    // The group only delegates keyboard/focus events of its dot buttons.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={rootRef}
      role="group"
      aria-label={label}
      aria-describedby={`${baseId}-hint`}
      className={cx('qz-heatmap', className)}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
    >
      <p id={`${baseId}-hint`} className="qz-visually-hidden">
        화살표 키로 문제 사이를 이동하고 Enter 또는 Space로 문제를 엽니다.
      </p>
      {chapters.map((chapter) => {
        const headingId = `${baseId}-${chapter.id}`;
        const actions = renderChapterActions?.(chapter);
        return (
          <section key={chapter.id} className="chapter" aria-labelledby={headingId}>
            <div className="header">
              <Heading id={headingId} className="title">
                {chapter.title}
              </Heading>
              <span className="count">{chapter.questions.length}문제</span>
              {actions ? <div className="actions">{actions}</div> : null}
            </div>
            {chapter.questions.length > 0 ? (
              <ul className="grid">
                {chapter.questions.map((q) => (
                  <li key={q.id} className="cell">
                    <QuestionDot
                      questionId={q.id}
                      status={q.status}
                      isFavorite={q.isFavorite}
                      questionNumber={q.number}
                      questionType={q.type}
                      chapterTitle={chapter.title}
                      chapterNumber={chapter.number}
                      preview={q.preview}
                      lastGradedResult={q.lastGradedResult}
                      needsRetry={q.needsRetry}
                      isPendingGrading={q.isPendingGrading}
                      isSelected={q.id === selectedQuestionId}
                      tabIndex={q.id === tabStop ? 0 : -1}
                      onOpen={onOpen}
                      onPreview={onPreview}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
