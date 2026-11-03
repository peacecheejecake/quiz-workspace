'use client';

// A mock exam question opened from the detail's 문제 목록 (MOCK-01-AC05; QuestionViewer `manage`
// for a mock exam question): a modal dialog "문제 k". Editors (owner/editor of an active
// workspace) read it with its answers and explanation — the same QuestionBody revision view as
// the 문제 상세 dialog — and get `편집` (the home 문제 편집 dialog's content fields; saving makes a
// new revision, PATCH /mock-exam-questions/{id}) and `이 모의고사에서 빼기` (ConfirmDialog). Viewers,
// and editors of an archived workspace, get an answer-free preview: the list they read carries no
// answers (MOCK-01-C05), so nothing here can show one before a submission. Editors also get
// `질문하기` at the top (ASK-01 `manage(mock)`: the question attached as `manage`, with its
// answers — only where the home's AI 질문 is available).
import { Badge, Button, ConfirmDialog, ModalDialog } from '@quiz/ui';
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { AskQuestionButton, useAskLauncher } from '@/components/ask/ask-launcher';
import { FormNotice } from '@/components/auth/form-notice';
import { displayStem } from '@/lib/questions/display-stem';
import {
  contentBody,
  errorSummary,
  QUESTION_TYPE_LABELS,
  validateQuestionForm,
  type FieldErrors,
  type QuestionFormValues,
} from '@/lib/questions/form';
import { QuestionContentFields } from '../question-content-fields';
import { QuestionBody } from '../viewer/question-body';
import type { MockExamApi } from './mock-exam-client';
import { needsReview, VARIATION_LABELS, type MockExamQuestion } from './mock-exam-model';
import styles from './mock-exams.module.css';

export interface MockQuestionTarget {
  readonly question: MockExamQuestion;
  /** Its number in the list ("문제 k"). */
  readonly number: number;
}

export interface MockQuestionDialogProps {
  readonly target: MockQuestionTarget | null;
  /** Editors of an active workspace: answers, 편집 and 빼기. */
  readonly manage: boolean;
  readonly api: MockExamApi;
  readonly onClose: () => void;
  /** A saved edit: the question's new revision. */
  readonly onEdited: (question: MockExamQuestion) => void;
  /** The question was taken out of the mock exam. */
  readonly onRemoved: (question: MockExamQuestion) => void;
  /** Where focus goes back on close (the row's button). */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}

function warningCodes(question: MockExamQuestion): string {
  return (question.validation_issues ?? [])
    .filter((i) => i.severity === 'warning')
    .map((i) => i.code)
    .join(', ');
}

export function MockQuestionDialog({
  target,
  manage,
  api,
  onClose,
  onEdited,
  onRemoved,
  returnFocusRef,
}: MockQuestionDialogProps) {
  // The last target keeps rendering while the dialog animates closed.
  const [shown, setShown] = useState(target);
  if (target && target !== shown) setShown(target);
  const view = target ?? shown;
  const question = view?.question ?? null;
  const asks = useAskLauncher() !== null;

  const [editing, setEditing] = useState<{ session: number; open: boolean }>({
    session: 0,
    open: false,
  });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);

  async function remove() {
    if (!question || removing) return;
    setRemoving(true);
    setRemoveError(null);
    const result = await api.removeQuestion(question.id);
    setRemoving(false);
    if (!result.ok) {
      setRemoveError(result.message);
      return;
    }
    setConfirmRemove(false);
    onRemoved(question);
  }

  const title = view ? `문제 ${view.number}` : '문제';
  const description = question
    ? `${VARIATION_LABELS[question.variation_type]} · ${QUESTION_TYPE_LABELS[question.question_type]} · 출처 ${question.source.label}`
    : undefined;
  return (
    <>
      <ModalDialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title={title}
        description={description}
        onCloseAutoFocus={(event) => {
          const back = returnFocusRef?.current;
          if (back?.isConnected) {
            event.preventDefault();
            back.focus();
          }
        }}
        footer={
          question && manage ? (
            <div className={styles.footer}>
              <Button onClick={() => setConfirmRemove(true)}>이 모의고사에서 빼기</Button>
              <Button
                ref={editButton}
                variant="primary"
                onClick={() => setEditing((e) => ({ session: e.session + 1, open: true }))}
              >
                편집
              </Button>
            </div>
          ) : undefined
        }
      >
        {question ? (
          <div className={styles.preview}>
            {manage ? (
              <>
                {asks ? (
                  <div className={styles.askRow}>
                    <AskQuestionButton
                      attachment={{
                        kind: 'mock_exam_question',
                        view: 'manage',
                        mock_exam_question_id: question.id,
                      }}
                    />
                  </div>
                ) : null}
                {question.edited || needsReview(question) ? (
                  <div className={styles.badges}>
                    {question.edited ? <Badge>편집됨</Badge> : null}
                    {needsReview(question) ? <Badge tone="warning">확인 필요</Badge> : null}
                  </div>
                ) : null}
                {needsReview(question) ? (
                  <p className={styles.notice}>
                    확인 필요: 자동 검증이 경고를 남겼습니다({warningCodes(question)}). 내용을
                    확인하고 필요하면 편집하세요. 풀이 화면에는 이 안내가 보이지 않습니다.
                  </p>
                ) : null}
                <QuestionBody
                  kind="revision"
                  type={question.question_type}
                  heading="문제"
                  revision={{
                    id: question.revision.id,
                    version: question.revision.version,
                    stem: question.stem,
                    options: question.options,
                    correct_option_ids: question.correct_option_ids ?? null,
                    accepted_answers: question.accepted_answers ?? null,
                    is_multi_answer: question.is_multi_answer,
                    explanation: question.explanation ?? null,
                    rubric: question.rubric ?? null,
                    created_at: '',
                  }}
                />
              </>
            ) : (
              <>
                <p className={styles.previewStem}>{displayStem(question.stem)}</p>
                {question.question_type === 'MCQ' ? (
                  <ol className={styles.previewOptions} aria-label="보기">
                    {question.options.map((o) => (
                      <li key={o.id}>{o.text}</li>
                    ))}
                  </ol>
                ) : null}
                <p className={styles.muted}>정답과 해설은 풀기에서 답을 제출한 뒤에 보입니다.</p>
              </>
            )}
          </div>
        ) : null}
      </ModalDialog>

      {manage && question ? (
        <MockQuestionEditor
          key={editing.session}
          open={editing.open && target !== null}
          question={question}
          api={api}
          onClose={() => setEditing((e) => ({ ...e, open: false }))}
          onSaved={(saved) => {
            setEditing((e) => ({ ...e, open: false }));
            onEdited(saved);
          }}
          returnFocus={editButton}
        />
      ) : null}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!open && !removing) {
            setConfirmRemove(false);
            setRemoveError(null);
          }
        }}
        title={`${title}을 이 모의고사에서 뺄까요?`}
        description={
          <>
            빼면 이 모의고사의 문제 목록과 이후 풀기에서 사라집니다. 이미 푼 기록은 남습니다.
            {removeError ? (
              <span role="alert" className={styles.error}>
                {' '}
                {removeError}
              </span>
            ) : null}
          </>
        }
        confirmLabel="빼기"
        loading={removing}
        onConfirm={() => void remove()}
      />
    </>
  );
}

function formOf(question: MockExamQuestion): QuestionFormValues {
  const correct = new Set(question.correct_option_ids ?? []);
  return {
    type: question.question_type,
    stem: question.stem,
    options: question.options.map((o) => ({ id: o.id, text: o.text, correct: correct.has(o.id) })),
    multiAnswer: question.is_multi_answer,
    acceptedAnswers: (question.accepted_answers ?? []).join('\n'),
    explanation: question.explanation ?? '',
    rubric: question.rubric ?? '',
    chapterId: '',
    questionNumber: '',
    sources: [],
  };
}

/** The 문제 편집 dialog of a mock exam question: the bank editor's content fields. */
function MockQuestionEditor({
  open,
  question,
  api,
  onClose,
  onSaved,
  returnFocus,
}: {
  readonly open: boolean;
  readonly question: MockExamQuestion;
  readonly api: MockExamApi;
  readonly onClose: () => void;
  readonly onSaved: (question: MockExamQuestion) => void;
  readonly returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const stemId = useId();
  const [values, setValues] = useState(() => formOf(question));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<{ text: string; attempt: number } | null>(null);
  const [pending, setPending] = useState(false);
  const attempts = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  function update(next: QuestionFormValues, clearKeys: readonly string[] = []) {
    setValues(next);
    if (clearKeys.some((key) => errors[key])) {
      setErrors((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([key]) => !clearKeys.includes(key))),
      );
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = validateQuestionForm(values);
    attempts.current += 1;
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setNotice({ text: errorSummary(found, values).join(' '), attempt: attempts.current });
      return;
    }
    setPending(true);
    const body = contentBody(values);
    const result = await api.editQuestion(question.id, {
      base_revision_id: question.revision.id,
      stem: body.stem,
      options: body.options,
      correct_option_ids: body.correct_option_ids,
      is_multi_answer: body.is_multi_answer,
      accepted_answers: body.accepted_answers,
      explanation: body.explanation,
      rubric: body.rubric,
    });
    if (!live.current) return;
    setPending(false);
    if (result.ok) {
      onSaved(result.data);
      return;
    }
    attempts.current += 1;
    setNotice({ text: result.message, attempt: attempts.current });
  }

  return (
    <ModalDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="문제 편집"
      description="저장하면 새 버전이 만들어지고, 이미 한 풀이 기록은 원래 버전을 그대로 가리킵니다."
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById(stemId)?.focus();
      }}
      onCloseAutoFocus={(event) => {
        if (returnFocus.current?.isConnected) {
          event.preventDefault();
          returnFocus.current.focus();
        }
      }}
    >
      <form onSubmit={save} noValidate className={styles.form} aria-busy={pending || undefined}>
        {notice ? (
          <FormNotice tone="danger" focusKey={notice.attempt}>
            <p>{notice.text}</p>
          </FormNotice>
        ) : null}
        <QuestionContentFields
          values={values}
          errors={errors}
          update={update}
          stemId={stemId}
          typeLocked
          typeDescription="모의고사 문제의 유형은 바꿀 수 없습니다."
        />
        <div className={styles.footer}>
          <Button type="button" onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            저장
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
