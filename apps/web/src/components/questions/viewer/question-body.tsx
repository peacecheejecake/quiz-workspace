// QVIEW-01 `QuestionBody` (docs/screens/question-viewer.md "문제 본문 부품"): what every
// QuestionViewer mode shows of one question.
//   kind `answer` (practice, sequence): the stem, the numbered options as the answer input (or the
//     answer box), the result status (정답/오답/채점 대기 in text, role=status) and, only once a
//     submission revealed them, the accepted answers, rubric and explanation. Graded MCQ rows get
//     the UX7-QDISPLAY result border with the 정답 / 내 선택 text mark (QPLAY-01-AC12).
//   kind `revision` (manage, read-only): a revision with its correct options marked ("정답" text +
//     check icon), accepted answers, rubric and explanation; no answer input at all.
// The stem always goes through `displayStem` (QPLAY-01-AC13) and the 보기 label stays hidden, the
// options' accessible name only.
import { CheckIcon, Checkbox, RadioGroup, Textarea } from '@quiz/ui';
import type { Ref } from 'react';
import type { QuestionRevision } from '@/lib/questions/actions';
import { displayStem, stemParagraphs } from '@/lib/questions/display-stem';
import type { Question } from '@/lib/questions/form';
import {
  ANSWER_TEXT_MAX,
  finalResult,
  optionMark,
  optionTone,
  resultMessage,
  toggleOption,
  type AttemptResult,
  type GradeResult,
  type OptionTone,
  type PracticeAnswer,
} from './practice-model';
import styles from './question-viewer.module.css';

export type QuestionType = Question['question_type'];

/** The answer-free question an answer is given to (a practice session, a run position). */
export interface AnswerQuestion {
  readonly question_type: QuestionType;
  readonly is_multi_answer: boolean;
  /** Options in displayed order. */
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly displayed_option_ids: readonly string[];
}

/** What a submission revealed (never present before one). */
export interface RevealedAnswers {
  readonly result: AttemptResult;
  readonly correct_option_ids: readonly string[] | null;
  readonly accepted_answers: readonly string[] | null;
  readonly explanation: string | null;
  readonly rubric: string | null;
}

export type QuestionBodyProps =
  | ({ readonly kind: 'answer' } & AnswerBodyProps)
  | ({ readonly kind: 'revision' } & RevisionBodyProps);

export function QuestionBody(props: QuestionBodyProps) {
  return props.kind === 'answer' ? <AnswerBody {...props} /> : <RevisionBody {...props} />;
}

/**
 * The displayed stem (UX9-QTYPE): one paragraph per blank-line-separated block, so the gap between
 * paragraphs is a spacing token rather than a full empty line.
 */
export function QuestionStem({ stem }: { readonly stem: string }) {
  return (
    <div className={styles.stem}>
      {stemParagraphs(displayStem(stem)).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
    </div>
  );
}

interface AnswerBodyProps {
  readonly stem: string;
  readonly question: AnswerQuestion;
  readonly answer: PracticeAnswer;
  /** The answer cannot change (submitted, submitting, or read-only). */
  readonly disabled: boolean;
  readonly onAnswerChange: (answer: PracticeAnswer) => void;
  /** The submission's revealed answers; null before one. */
  readonly outcome: RevealedAnswers | null;
  readonly selfGrade: GradeResult | null;
  readonly error?: string | null;
  readonly resultRef?: Ref<HTMLParagraphElement>;
}

function AnswerBody({
  stem,
  question,
  answer,
  disabled,
  onAnswerChange,
  outcome,
  selfGrade,
  error = null,
  resultRef,
}: AnswerBodyProps) {
  return (
    <>
      <QuestionStem stem={stem} />
      <AnswerField
        question={question}
        answer={answer}
        disabled={disabled}
        correct={outcome?.correct_option_ids ?? null}
        graded={outcome?.result ?? null}
        onChange={onAnswerChange}
      />
      <p
        ref={resultRef}
        role="status"
        tabIndex={-1}
        className={styles.result}
        data-result={outcome ? finalResult(outcome.result, selfGrade) : undefined}
      >
        {outcome ? resultMessage(outcome.result, selfGrade) : ''}
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {outcome ? <Reveal outcome={outcome} /> : null}
    </>
  );
}

function AnswerField({
  question,
  answer,
  disabled,
  correct,
  graded,
  onChange,
}: {
  readonly question: AnswerQuestion;
  readonly answer: PracticeAnswer;
  readonly disabled: boolean;
  readonly correct: readonly string[] | null;
  /** The submit result; null until the answers are revealed. */
  readonly graded: AttemptResult | null;
  readonly onChange: (answer: PracticeAnswer) => void;
}) {
  if (question.question_type !== 'MCQ') {
    return (
      <Textarea
        label="답안"
        value={answer.text}
        rows={question.question_type === 'ESSAY' ? 8 : 3}
        maxLength={ANSWER_TEXT_MAX}
        disabled={disabled}
        onChange={(e) => onChange({ ...answer, text: e.target.value })}
      />
    );
  }
  // UX7-QDISPLAY (QPLAY-01-AC12): every row keeps the same (transparent) border, and grading
  // only colors it; the text mark below the label is the meaning, linked as the description.
  const mark = (id: string) => {
    const text = graded ? optionMark(id, correct, answer.selected) : undefined;
    return text ? <span className={styles.mark}>{text}</span> : undefined;
  };
  const rowClass = (id: string) => {
    const tone = graded ? optionTone(id, correct, answer.selected, graded) : undefined;
    return tone ? `${styles.option} ${TONE_CLASS[tone]}` : styles.option;
  };
  if (!question.is_multi_answer) {
    return (
      <RadioGroup
        // UX7-QDISPLAY: no visible 보기 label; the group keeps it as its accessible name.
        label="보기"
        hideLabel
        className={styles.optionGroup}
        orientation="vertical"
        disabled={disabled}
        value={answer.selected[0] ?? ''}
        onValueChange={(id) =>
          onChange({ ...answer, selected: toggleOption(question, answer.selected, id, true) })
        }
        options={question.options.map((o, index) => {
          const description = mark(o.id);
          return {
            value: o.id,
            label: <OptionLabel index={index} text={o.text} />,
            className: rowClass(o.id),
            ...(description ? { description } : {}),
          };
        })}
      />
    );
  }
  return (
    <fieldset className={styles.choices}>
      <legend className={styles.legend}>
        <span className="qz-visually-hidden">보기 —</span> 정답을 모두 고르세요
      </legend>
      {question.options.map((o, index) => (
        <Checkbox
          key={o.id}
          className={rowClass(o.id)}
          label={<OptionLabel index={index} text={o.text} />}
          description={mark(o.id)}
          disabled={disabled}
          checked={answer.selected.includes(o.id)}
          onCheckedChange={(checked) =>
            onChange({
              ...answer,
              selected: toggleOption(question, answer.selected, o.id, checked === true),
            })
          }
        />
      ))}
    </fieldset>
  );
}

const TONE_CLASS: Readonly<Record<OptionTone, string | undefined>> = {
  correct: styles.toneCorrect,
  chosen: styles.toneChosen,
  answer: styles.toneAnswer,
};

/**
 * An option's display number (`1.`, by displayed position, so a shuffled session numbers its own
 * order) and text. The number is decorative: grading uses the option ID, and the radio/checkbox
 * keeps the option text as its name while its position is announced by the group.
 */
function OptionLabel({ index, text }: { readonly index: number; readonly text: string }) {
  return (
    <>
      <span className={styles.optionNumber} aria-hidden="true">
        {index + 1}.
      </span>{' '}
      {text}
    </>
  );
}

/** Answers revealed by the submit result (never before submission). */
function Reveal({ outcome }: { readonly outcome: RevealedAnswers }) {
  const accepted = outcome.accepted_answers ?? [];
  return (
    <div className={styles.reveal}>
      {accepted.length > 0 ? (
        <section aria-label="허용 답안">
          <h3 className={styles.revealTitle}>허용 답안</h3>
          <p className={styles.revealText}>{accepted.join(', ')}</p>
        </section>
      ) : null}
      {outcome.rubric ? (
        <section aria-label="채점 기준">
          <h3 className={styles.revealTitle}>채점 기준</h3>
          <p className={styles.revealText}>{outcome.rubric}</p>
        </section>
      ) : null}
      {outcome.explanation ? (
        <section aria-label="해설">
          <h3 className={styles.revealTitle}>해설</h3>
          <p className={styles.revealText}>{outcome.explanation}</p>
        </section>
      ) : null}
    </div>
  );
}

interface RevisionBodyProps {
  readonly revision: QuestionRevision;
  readonly type: QuestionType;
  readonly heading: string;
}

/** A revision with its answers (manage, read-only): not a grading result, so no result border. */
function RevisionBody({ revision, type, heading }: RevisionBodyProps) {
  const correct = new Set(revision.correct_option_ids ?? []);
  return (
    <>
      <section className={styles.detailSection}>
        <h3 className={styles.detailHeading}>{heading}</h3>
        <QuestionStem stem={revision.stem} />
      </section>
      {type === 'MCQ' ? (
        <section className={styles.detailSection}>
          {/* UX7-QDISPLAY: no visible 보기 heading; the list keeps it as its name. */}
          {revision.is_multi_answer ? <p className={styles.detailText}>복수 정답</p> : null}
          <ol className={styles.optionList} aria-label="보기">
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
