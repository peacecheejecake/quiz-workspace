// QVIEW-01 `QuestionBody` (docs/screens/question-viewer.md "문제 본문 부품"): what every
// QuestionViewer mode shows of one question.
//   kind `answer` (practice, sequence): the stem, the numbered options as the answer input (or the
//     answer box), the result status (role=status; 채점 대기 and non-MCQ wording visible, an MCQ
//     grade for assistive tech only, UX12-OPTIONS) and, only once a submission revealed them, the
//     accepted answers, rubric and explanation. Graded MCQ rows get the UX7-QDISPLAY result border
//     with a check/X icon and the 정답 / 내 선택 text as their description (QPLAY-01-AC12).
//   kind `revision` (manage, read-only): a revision with its correct options marked ("정답" text +
//     check icon), accepted answers, rubric and explanation; no answer input at all.
// The stem always goes through `displayStem` (QPLAY-01-AC13) and `stemItems` (QPLAY-01-AC14, the
// 제시 항목 box) and the 보기 label stays hidden, the options' accessible name only. Options printed
// as a table line up in columns (`optionGrid`, QTABLE-01).
import { CheckIcon, Checkbox, CloseIcon, RadioGroup, Textarea } from '@quiz/ui';
import { useId, type ReactNode, type Ref } from 'react';
import type { QuestionRevision } from '@/lib/questions/actions';
import { OptionCells, OptionGridHead } from '@/components/questions/stem/option-grid';
import { StemBlocks } from '@/components/questions/stem/stem-text';
import type { Question } from '@/lib/questions/form';
import { optionGrid, type OptionGrid } from '@/lib/questions/stem-table';
import type { StemTables } from '@/lib/questions/stem-table-edit';
import { ExplanationText, type ExplanationHighlighting } from './explanation-text';
import {
  ANSWER_TEXT_MAX,
  finalResult,
  optionMark,
  optionTone,
  resultIsVisuallyHidden,
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
 * paragraphs is a spacing token rather than a full empty line; labelled stem items go in the
 * 제시 항목 box between the question sentence and the options (STEM-ITEMS, QPLAY-01-AC14).
 */
export function QuestionStem({
  stem,
  stemTables,
}: {
  readonly stem: string;
  readonly stemTables?: StemTables;
}) {
  return (
    <div className={styles.stem}>
      <StemBlocks stem={stem} stemTables={stemTables} />
    </div>
  );
}

interface AnswerBodyProps {
  readonly stem: string;
  readonly stemTables?: StemTables;
  readonly question: AnswerQuestion;
  readonly answer: PracticeAnswer;
  /** The answer cannot change (submitted, submitting, or read-only). */
  readonly disabled: boolean;
  readonly onAnswerChange: (answer: PracticeAnswer) => void;
  /** The submission's revealed answers; null before one. */
  readonly outcome: RevealedAnswers | null;
  readonly selfGrade: GradeResult | null;
  readonly error?: string | null;
  /** The element a submission moves focus to: the visible result (UX12-OPTIONS-AC07). */
  readonly resultRef?: Ref<HTMLElement>;
  /** The revealed explanation takes the reader's highlights (HILITE-01; bank questions only). */
  readonly highlighting?: ExplanationHighlighting | null;
  /** Between the stem and the options: the question's images (UX12-REEXTRACT-AC04). */
  readonly figures?: ReactNode;
}

function AnswerBody({
  stem,
  stemTables,
  question,
  answer,
  disabled,
  onAnswerChange,
  outcome,
  selfGrade,
  error = null,
  resultRef,
  highlighting = null,
  figures = null,
}: AnswerBodyProps) {
  const resultId = useId();
  // A hidden sentence cannot show a focus ring, so an MCQ grade focuses the options, named by it.
  const hiddenResult =
    outcome !== null && resultIsVisuallyHidden(question.question_type, outcome.result);
  // Either element takes the viewer's ref, which only calls focus().
  const focusRef = resultRef as Ref<HTMLDivElement & HTMLParagraphElement> | undefined;
  const grid = question.question_type === 'MCQ' ? optionGrid(stem, question.options) : null;
  return (
    <>
      <QuestionStem stem={grid?.stem ?? stem} stemTables={stemTables} />
      {figures}
      <div
        ref={hiddenResult ? focusRef : undefined}
        className={styles.answerField}
        {...(hiddenResult ? { role: 'group', 'aria-labelledby': resultId, tabIndex: -1 } : {})}
      >
        <AnswerField
          question={question}
          grid={grid}
          answer={answer}
          disabled={disabled}
          correct={outcome?.correct_option_ids ?? null}
          graded={outcome?.result ?? null}
          onChange={onAnswerChange}
        />
      </div>
      <p
        ref={hiddenResult ? undefined : focusRef}
        id={resultId}
        role="status"
        tabIndex={-1}
        className={hiddenResult ? `${styles.result} qz-visually-hidden` : styles.result}
        data-result={outcome ? finalResult(outcome.result, selfGrade) : undefined}
      >
        {outcome ? resultMessage(outcome.result, selfGrade) : ''}
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {outcome ? <Reveal outcome={outcome} highlighting={highlighting} /> : null}
    </>
  );
}

function AnswerField({
  question,
  grid,
  answer,
  disabled,
  correct,
  graded,
  onChange,
}: {
  readonly question: AnswerQuestion;
  readonly grid: OptionGrid | null;
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
  // only colors it; the row-end icon and the hidden text linked as the description are the meaning.
  const toneOf = (id: string) =>
    graded ? optionTone(id, correct, answer.selected, graded) : undefined;
  const mark = (id: string) => {
    const text = graded ? optionMark(id, correct, answer.selected) : undefined;
    if (!text) return undefined;
    const tone = toneOf(id);
    return (
      <span className={styles.mark} data-option-mark={tone ? TONE_MARK[tone] : undefined}>
        {tone === 'chosen' ? (
          <CloseIcon width={16} height={16} strokeWidth={3} />
        ) : tone ? (
          <CheckIcon width={16} height={16} strokeWidth={3} />
        ) : null}
        <span className="qz-visually-hidden">{text}</span>
      </span>
    );
  };
  const rowClass = (id: string) => {
    const tone = toneOf(id);
    const row = grid ? `${styles.option} ${styles.gridOption}` : styles.option;
    return tone ? `${row} ${TONE_CLASS[tone]}` : row;
  };
  const head = grid ? (
    <OptionGridHead grid={grid} numbered className={styles.optionGridHead} />
  ) : null;
  if (!question.is_multi_answer) {
    return (
      <>
        {head}
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
              label: <OptionLabel index={index} text={o.text} grid={grid} />,
              className: rowClass(o.id),
              ...(description ? { description } : {}),
            };
          })}
        />
      </>
    );
  }
  return (
    <fieldset className={styles.choices}>
      <legend className={styles.legend}>
        <span className="qz-visually-hidden">보기 —</span> 정답을 모두 고르세요
      </legend>
      {head}
      {question.options.map((o, index) => (
        <Checkbox
          key={o.id}
          className={rowClass(o.id)}
          label={<OptionLabel index={index} text={o.text} grid={grid} />}
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

const TONE_MARK: Readonly<Record<OptionTone, 'correct' | 'wrong'>> = {
  correct: 'correct',
  chosen: 'wrong',
  answer: 'correct',
};

/**
 * An option's display number (`1.`, by displayed position, so a shuffled session numbers its own
 * order) and text. The number is decorative: grading uses the option ID, and the radio/checkbox
 * keeps the option text as its name while its position is announced by the group.
 */
function OptionLabel({
  index,
  text,
  grid,
}: {
  readonly index: number;
  readonly text: string;
  readonly grid: OptionGrid | null;
}) {
  const number = `${index + 1}.`;
  if (grid) {
    return (
      <OptionCells
        grid={grid}
        index={index}
        number={number}
        numberClassName={styles.optionNumber}
      />
    );
  }
  return (
    <span>
      <span className={styles.optionNumber} aria-hidden="true">
        {number}
      </span>{' '}
      {text}
    </span>
  );
}

/** Answers revealed by the submit result (never before submission). */
function Reveal({
  outcome,
  highlighting,
}: {
  readonly outcome: RevealedAnswers;
  readonly highlighting: ExplanationHighlighting | null;
}) {
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
          <ExplanationText
            text={outcome.explanation}
            className={styles.revealText}
            highlighting={highlighting}
          />
        </section>
      ) : null}
    </div>
  );
}

interface RevisionBodyProps {
  readonly revision: QuestionRevision;
  readonly type: QuestionType;
  readonly heading: string;
  /** The explanation takes the reader's highlights (문제 상세 of a bank question, HILITE-01). */
  readonly highlighting?: ExplanationHighlighting | null;
  /** Between the stem and the options: the question's images (UX12-REEXTRACT-AC04). */
  readonly figures?: ReactNode;
}

/** A revision with its answers (manage, read-only): not a grading result, so no result border. */
function RevisionBody({
  revision,
  type,
  heading,
  highlighting = null,
  figures = null,
}: RevisionBodyProps) {
  const correct = new Set(revision.correct_option_ids ?? []);
  const grid = type === 'MCQ' ? optionGrid(revision.stem, revision.options) : null;
  return (
    <>
      <section className={styles.detailSection}>
        <h3 className={styles.detailHeading}>{heading}</h3>
        <QuestionStem stem={grid?.stem ?? revision.stem} stemTables={revision.stem_tables} />
        {figures}
      </section>
      {type === 'MCQ' ? (
        <section className={styles.detailSection}>
          {/* UX7-QDISPLAY: no visible 보기 heading; the list keeps it as its name. */}
          {revision.is_multi_answer ? <p className={styles.detailText}>복수 정답</p> : null}
          {grid ? (
            <OptionGridHead grid={grid} numbered trailing className={styles.revisionGridHead} />
          ) : null}
          <ol className={styles.optionList} aria-label="보기">
            {revision.options.map((option, i) => {
              const isCorrect = correct.has(option.id);
              const mark = isCorrect ? (
                <span className={styles.correctMark}>
                  <CheckIcon width={16} height={16} />
                  정답
                </span>
              ) : null;
              return (
                <li key={option.id} className={styles.optionRow} data-correct={isCorrect}>
                  {grid ? (
                    <OptionCells
                      grid={grid}
                      index={i}
                      number={`${i + 1}.`}
                      numberClassName={styles.optionLabel}
                      trailing={mark}
                      reserveTrailing
                    />
                  ) : (
                    <>
                      <span className={styles.optionLabel}>{i + 1}.</span>
                      <span className={styles.optionText}>{option.text}</span>
                      {mark}
                    </>
                  )}
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
          <ExplanationText
            text={revision.explanation}
            className={styles.detailText}
            highlighting={highlighting}
          />
        </section>
      ) : null}
    </>
  );
}
