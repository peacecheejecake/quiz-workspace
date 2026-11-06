// Content fields of a question (type, stem, options and answers, explanation), shared by the
// home question editor and the draft editor of QuestionDraftReview (QIMPORT-01, QGEN-01) so
// both edit questions the same way: stable option ids, single/multi answer, one accepted answer
// per line for short answers, a rubric for essays.
import {
  closestCenter,
  defaultDropAnimation,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  AlertIcon,
  Button,
  Checkbox,
  CloseIcon,
  GripIcon,
  IconButton,
  RadioGroup,
  Textarea,
} from '@quiz/ui';
import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  addOption,
  moveOption,
  optionKey,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  removeOption,
  reorderOption,
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
          <OptionList values={values} errors={errors} update={update} />
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

type OptionListProps = Pick<QuestionContentFieldsProps, 'values' | 'errors' | 'update'>;

const DRAG_SENSOR = { activationConstraint: { distance: 4 } };
// Rows are tall, so the default 20% edge zone would scroll the dialog on almost any drag.
const EDGE_SCROLL = { threshold: { x: 0, y: 0.1 } };
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

// The handle is pointer-only and hidden from assistive technology: 위로/아래로 are the keyboard
// and screen reader path (WCAG 2.5.7), so the drag has nothing to announce.
const SILENT: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};
const NO_INSTRUCTIONS = { draggable: '' };

const subscribeNever = () => () => undefined;
const documentBody = () => document.body;
const noBody = () => null;

function OptionList({ values, errors, update }: OptionListProps) {
  const contextId = useId();
  const sensors = useSensors(useSensor(PointerSensor, DRAG_SENSOR));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropAnimation, setDropAnimation] = useState<DropAnimation | null>(defaultDropAnimation);
  // Dialogs have a transform, which would offset a fixed overlay rendered inside them.
  const portalTarget = useSyncExternalStore(subscribeNever, documentBody, noBody);

  const activeIndex = values.options.findIndex((o) => o.id === activeId);
  const active = values.options[activeIndex];

  function onDragStart(event: DragStartEvent) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;
    setDropAnimation(reduce ? null : defaultDropAnimation);
    setActiveId(String(event.active.id));
  }

  function onDragEnd({ active: dragged, over }: DragEndEvent) {
    setActiveId(null);
    if (over) update(reorderOption(values, String(dragged.id), String(over.id)));
  }

  return (
    <DndContext
      id={contextId}
      sensors={sensors}
      collisionDetection={closestCenter}
      autoScroll={EDGE_SCROLL}
      modifiers={[verticalOnly]}
      accessibility={{ announcements: SILENT, screenReaderInstructions: NO_INSTRUCTIONS }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext
        items={values.options.map((o) => o.id)}
        strategy={verticalListSortingStrategy}
      >
        {values.options.map((option, index) => (
          <OptionRow
            key={option.id}
            option={option}
            index={index}
            values={values}
            errors={errors}
            update={update}
          />
        ))}
      </SortableContext>
      {portalTarget
        ? createPortal(
            <DragOverlay dropAnimation={dropAnimation}>
              {active ? (
                <div className={styles.optionDragPreview} data-option-drag-preview="" aria-hidden>
                  <GripIcon width={20} height={20} />
                  <div>
                    <p className={styles.optionDragLabel}>보기 {activeIndex + 1}</p>
                    <p className={styles.optionDragText}>{active.text}</p>
                  </div>
                </div>
              ) : null}
            </DragOverlay>,
            portalTarget,
          )
        : null}
    </DndContext>
  );
}

function OptionRow({
  option,
  index,
  values,
  errors,
  update,
}: OptionListProps & {
  readonly option: QuestionFormValues['options'][number];
  readonly index: number;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: option.id });
  const n = index + 1;
  return (
    <div
      ref={setNodeRef}
      className={styles.optionEditor}
      data-option-id={option.id}
      data-dragging={isDragging ? '' : undefined}
      style={{
        transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      <span
        ref={setActivatorNodeRef}
        className={styles.optionHandle}
        data-option-handle=""
        aria-hidden="true"
        {...listeners}
      >
        <GripIcon width={20} height={20} />
      </span>
      <Textarea
        label={`보기 ${n}`}
        rows={2}
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
          onClick={() => update(removeOption(values, option.id), [optionKey(option.id), 'options'])}
        />
      </div>
    </div>
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
