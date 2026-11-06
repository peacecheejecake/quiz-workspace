'use client';

// The framed area under a QuestionViewer result, headed by an h3 that collapses it: 관련 본문
// (RELSRC-01) and AI 해설 (AIEXPL-01, UX12-EXPL).
import { ChevronDownIcon, ChevronUpIcon } from '@quiz/ui';
import { useId, type ReactNode, type Ref } from 'react';
import styles from './section-disclosure.module.css';

export function SectionDisclosure({
  title,
  expanded,
  onToggle,
  busy = false,
  headingRef,
  children,
  after,
}: {
  readonly title: string;
  readonly expanded: boolean;
  /** Null: nothing to collapse yet, a plain heading over a body that always shows. */
  readonly onToggle: (() => void) | null;
  readonly busy?: boolean;
  /** Makes the heading a focus target (it keeps focus when `onToggle` comes and goes). */
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly children: ReactNode;
  /** Kept outside the collapsible body. */
  readonly after?: ReactNode;
}) {
  const headingId = useId();
  const bodyId = useId();
  return (
    <section className={styles.area} aria-labelledby={headingId}>
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        className={styles.heading}
      >
        {onToggle ? (
          <button
            type="button"
            className={`${styles.toggle} qz-focus-ring`}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            {title}
            {expanded ? (
              <ChevronUpIcon width={16} height={16} aria-hidden="true" />
            ) : (
              <ChevronDownIcon width={16} height={16} aria-hidden="true" />
            )}
          </button>
        ) : (
          title
        )}
      </h3>
      <div
        id={bodyId}
        className={styles.body}
        hidden={onToggle !== null && !expanded}
        aria-busy={busy || undefined}
      >
        {children}
      </div>
      {after}
    </section>
  );
}
