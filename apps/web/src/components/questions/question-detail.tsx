// A question revision's content (stem, options with correct markers, accepted answers, rubric,
// explanation) for readers allowed to see answers: the shared workspace view (WS-VIEW-01) and the
// home's 문제 상세 dialog (UX7-BANK-2, detail/question-detail-dialog.tsx), which brought back the
// retired QBANK-01 detail panel's read view.
import { CheckIcon } from '@quiz/ui';
import type { QuestionRevision } from '@/lib/questions/actions';
import type { Question } from '@/lib/questions/form';
import styles from './question-bank.module.css';

export function RevisionView({
  revision,
  type,
  heading,
}: {
  revision: QuestionRevision;
  type: Question['question_type'];
  heading: string;
}) {
  const correct = new Set(revision.correct_option_ids ?? []);
  return (
    <>
      <section className={styles.detailSection}>
        <h3 className={styles.detailHeading}>{heading}</h3>
        <p className={styles.detailText}>{revision.stem}</p>
      </section>
      {type === 'MCQ' ? (
        <section className={styles.detailSection}>
          <h3 className={styles.detailHeading}>
            보기{revision.is_multi_answer ? ' (복수 정답)' : ''}
          </h3>
          <ol className={styles.optionList}>
            {revision.options.map((option, i) => {
              const isCorrect = correct.has(option.id);
              return (
                <li key={option.id} className={styles.optionRow} data-correct={isCorrect}>
                  <span className={styles.optionLabel}>{i + 1}.</span>
                  <span className={styles.optionText}>{option.text}</span>
                  {isCorrect ? (
                    <span className={styles.correctMark}>
                      <CheckIcon width={16} height={16} />
                      정답
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {revision.correct_option_ids === null ? (
            <p className={styles.detailText}>정답이 지정되지 않았습니다.</p>
          ) : null}
        </section>
      ) : null}
      {type === 'SHORT_ANSWER' ? (
        <section className={styles.detailSection}>
          <h3 className={styles.detailHeading}>허용 답안</h3>
          <p className={styles.detailText}>
            {revision.accepted_answers?.length
              ? revision.accepted_answers.join(', ')
              : '등록된 허용 답안이 없어 직접 채점합니다.'}
          </p>
        </section>
      ) : null}
      {type === 'ESSAY' ? (
        <section className={styles.detailSection}>
          <h3 className={styles.detailHeading}>채점 기준</h3>
          <p className={styles.detailText}>{revision.rubric || '등록된 채점 기준이 없습니다.'}</p>
        </section>
      ) : null}
      {revision.explanation ? (
        <section className={styles.detailSection}>
          <h3 className={styles.detailHeading}>해설</h3>
          <p className={styles.detailText}>{revision.explanation}</p>
        </section>
      ) : null}
    </>
  );
}
