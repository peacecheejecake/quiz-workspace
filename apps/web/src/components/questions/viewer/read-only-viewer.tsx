'use client';

// QuestionViewer `read-only` mode (QVIEW-01 call site 6: a share-link guest's question preview,
// WS-VIEW-01-AC01/AC03, CHNOTE-01-AC04): a published question with its options, correct answer
// and explanation in a non-modal Floating Side Panel next to the list that opened it. No answer
// input, favourite, retry, history or edit control, and showing it records nothing.
import { Badge, FloatingSidePanel } from '@quiz/ui';
import type { ReactNode } from 'react';
import type { QuestionRevision } from '@/lib/questions/actions';
import { QUESTION_TYPE_LABELS } from '@/lib/questions/form';
import { QuestionBody, type QuestionType } from './question-body';
import styles from './question-viewer.module.css';

export interface ReadOnlyQuestion {
  readonly questionType: QuestionType;
  readonly revision: QuestionRevision;
}

export interface ReadOnlyViewerProps {
  /** The shown question; null = closed. */
  readonly question: ReadOnlyQuestion | null;
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  /** Below the body: the caller's source links (they point into its own document viewer). */
  readonly sources?: ReactNode;
  readonly className?: string;
}

export function ReadOnlyViewer({
  question,
  title,
  description,
  onClose,
  sources,
  className,
}: ReadOnlyViewerProps) {
  return (
    <FloatingSidePanel
      modal={false}
      open={question !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={description}
      closeLabel="패널 닫기"
      mobileLayout="full"
    >
      {question ? (
        <div className={className ?? styles.body}>
          <div className={styles.badges}>
            <Badge>{QUESTION_TYPE_LABELS[question.questionType]}</Badge>
          </div>
          <QuestionBody
            kind="revision"
            revision={question.revision}
            type={question.questionType}
            heading="문제"
          />
          {sources}
        </div>
      ) : null}
    </FloatingSidePanel>
  );
}
