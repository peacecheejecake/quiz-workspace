// UX12-SOLVEDOPEN-AC10: placeholders for a question or a list of questions still loading, in the
// style of workspaces/route-skeletons.tsx: decorative blocks inside an `aria-busy` region with a
// hidden status, so the announcement stays while nothing is written on screen.
import { Skeleton } from '@quiz/ui';
import type { ReactNode } from 'react';
import styles from './question-skeleton.module.css';

const LOADING = '문제를 불러오는 중입니다.';
const OPTION_ROWS = [0, 1, 2, 3] as const;

function Status() {
  return (
    <p role="status" className="qz-visually-hidden">
      {LOADING}
    </p>
  );
}

/** One question: its stem (or lines for it) above option rows, or an answer box without options. */
export function QuestionSkeleton({
  stem,
  questionType = 'MCQ',
}: {
  /** The stem when it is already known (a preview, a run position). */
  readonly stem?: ReactNode;
  readonly questionType?: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
}) {
  return (
    <div aria-busy="true" className={styles.question}>
      <Status />
      {stem ?? (
        <div className={styles.stem}>
          <Skeleton width="100%" />
          <Skeleton width="70%" />
        </div>
      )}
      {questionType === 'MCQ' ? (
        <div className={styles.options}>
          {OPTION_ROWS.map((row) => (
            <Skeleton key={row} shape="rect" width="100%" className={styles.option} />
          ))}
        </div>
      ) : (
        <Skeleton shape="rect" width="100%" className={styles.answer} />
      )}
    </div>
  );
}

/** Rows of a question list, which have no stem or options of their own to match. */
export function QuestionListSkeleton({ rows = 3 }: { readonly rows?: number }) {
  return (
    <div aria-busy="true" className={styles.list}>
      <Status />
      {Array.from({ length: rows }, (_, row) => (
        <Skeleton key={row} shape="rect" width="100%" className={styles.row} />
      ))}
    </div>
  );
}

/** The home's status line: the heatmap stays on screen, dimmed, so one line stands in for it. */
export function QuestionLineSkeleton() {
  return (
    <>
      <span className="qz-visually-hidden">{LOADING}</span>
      <Skeleton width="10rem" />
    </>
  );
}
