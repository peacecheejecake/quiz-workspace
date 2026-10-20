// Content fields of a question (type, stem, options and answers, explanation), shared by the
// QBANK-01 question editor and the draft editor of QuestionDraftReview (QIMPORT-01, QGEN-01) so
// both edit questions the same way: stable option ids, single/multi answer, one accepted answer
// per line for short answers, a rubric for essays.
import {
  AlertIcon,
  Button,
  Checkbox,
  CloseIcon,
  IconButton,
  Input,
  RadioGroup,
  Textarea,
} from '@quiz/ui';
import type { ReactNode } from 'react';
import {
  addOption,
  moveOption,
  optionKey,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  removeOption,
  setMultiAnswer,
  setOptionCorrect,
  setOptionText,
  type FieldErrors,
  type QuestionFormValues,
  type QuestionType,
} from '@/lib/questions/form';
import styles from './question-bank.module.css';

export interface QuestionContentFieldsProps {
  readonly values: QuestionFormValues;
  readonly errors: FieldErrors;
  /** New values; `clearKeys` are error keys the change resolves. */
  readonly update: (next: QuestionFormValues, clearKeys?: readonly string[]) => void;
  /** Id of the stem field (focused when the editor opens). */
  readonly stemId: string;
  readonly typeLocked?: boolean;
  readonly typeDescription?: string;
  /** Shown under the answer fields (e.g. that an answer may stay empty in a draft). */
  readonly answerHint?: string;
}

export function QuestionContentFields({
  values,
  errors,
  update,
  stemId,
  typeLocked = false,
  typeDescription,
  answerHint,
}: QuestionContentFieldsProps) {
  const isMcq = values.type === 'MCQ';
  return (
    <>
      <RadioGroup
        label="문제 유형"
        options={QUESTION_TYPES.map((type) => ({ value: type, label: QUESTION_TYPE_LABELS[type] }))}
        value={values.type}
        onValueChange={(type) => update({ ...values, type: type as QuestionType })}
        disabled={typeLocked}
        {...(typeDescription ? { description: typeDescription } : {})}
      />

      <Textarea
        id={stemId}
        label="문제 내용"
        rows={4}
        value={values.stem}
        onChange={(e) => update({ ...values, stem: e.target.value }, ['stem'])}
        error={errors.stem}
        required
      />

      {isMcq ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>보기와 정답</legend>
          <Checkbox
            label="복수 정답 허용"
            description={
              values.multiAnswer ? '정답을 여러 개 선택할 수 있습니다.' : '정답은 1개입니다.'
            }
            checked={values.multiAnswer}
            onCheckedChange={(checked) =>
              update(setMultiAnswer(values, checked === true), ['correct'])
            }
          />
          {values.options.map((option, index) => {
            const n = index + 1;
            return (
              <div key={option.id} className={styles.optionEditor} data-option-id={option.id}>
                <Input
                  label={`보기 ${n}`}
                  value={option.text}
                  onChange={(e) =>
                    update(setOptionText(values, option.id, e.target.value), [optionKey(option.id)])
                  }
                  error={errors[optionKey(option.id)]}
                  autoComplete="off"
                />
                <div className={styles.optionControls}>
                  <Checkbox
                    label="정답"
                    aria-label={`보기 ${n} 정답`}
                    checked={option.correct}
                    onCheckedChange={(checked) =>
                      update(setOptionCorrect(values, option.id, checked === true), ['correct'])
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`보기 ${n} 위로 이동`}
                    disabled={index === 0}
                    onClick={() => update(moveOption(values, option.id, -1))}
                  >
                    위로
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`보기 ${n} 아래로 이동`}
                    disabled={index === values.options.length - 1}
                    onClick={() => update(moveOption(values, option.id, 1))}
                  >
                    아래로
                  </Button>
                  <IconButton
                    size="sm"
                    label={`보기 ${n} 삭제`}
                    icon={<CloseIcon width={16} height={16} />}
                    onClick={() =>
                      update(removeOption(values, option.id), [optionKey(option.id), 'options'])
                    }
                  />
                </div>
              </div>
            );
          })}
          <FieldMessage>{errors.options}</FieldMessage>
          <FieldMessage>{errors.correct}</FieldMessage>
          <div>
            <Button onClick={() => update(addOption(values), ['options'])}>보기 추가</Button>
          </div>
        </fieldset>
      ) : null}

      {values.type === 'SHORT_ANSWER' ? (
        <Textarea
          label="허용 답안"
          rows={3}
          description="한 줄에 하나씩 입력합니다. 비워 두면 자동 채점하지 않고 직접 채점합니다."
          value={values.acceptedAnswers}
          onChange={(e) =>
            update({ ...values, acceptedAnswers: e.target.value }, ['acceptedAnswers'])
          }
          error={errors.acceptedAnswers}
        />
      ) : null}

      {values.type === 'ESSAY' ? (
        <Textarea
          label="채점 기준"
          rows={4}
          description="모범 답안이나 채점할 때 확인할 내용을 적습니다."
          value={values.rubric}
          onChange={(e) => update({ ...values, rubric: e.target.value }, ['rubric'])}
          error={errors.rubric}
        />
      ) : null}
      {answerHint ? <p className={styles.fieldHint}>{answerHint}</p> : null}

      <Textarea
        label="해설"
        rows={3}
        value={values.explanation}
        onChange={(e) => update({ ...values, explanation: e.target.value }, ['explanation'])}
        error={errors.explanation}
      />
    </>
  );
}

export function FieldMessage({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className={styles.fieldError}>
      <AlertIcon width={16} height={16} />
      <span>{children}</span>
    </p>
  );
}
