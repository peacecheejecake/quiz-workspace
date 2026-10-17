'use client';

// QBANK-01 question editor ("문제 등록" / "문제 편집"). The dialog stays mounted across sessions:
// each opening is a session (`session` prop), and a response that arrives after its dialog was
// closed or reopened reports itself with a toast instead of touching the form on screen.
// Creation sends one Idempotency-Key per creation attempt: retries of the same content reuse it,
// a content change, a success or an `idempotency-key-reused` conflict mint a new one.
import {
  AlertIcon,
  Button,
  Checkbox,
  CloseIcon,
  DialogClose,
  IconButton,
  Input,
  ModalDialog,
  RadioGroup,
  Select,
  Textarea,
  useToast,
} from '@quiz/ui';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { FormNotice } from '@/components/auth/form-notice';
import {
  createQuestionAction,
  getQuestionAction,
  updateQuestionAction,
  type ActionResult,
} from '@/lib/questions/actions';
import {
  addOption,
  addSource,
  createBody,
  emptyForm,
  errorSummary,
  FORM_KEY,
  formFromQuestion,
  moveOption,
  optionKey,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  removeOption,
  removeSource,
  setMultiAnswer,
  setOptionCorrect,
  setOptionText,
  sourceKey,
  sourceSnapshot,
  updateSource,
  validateQuestionForm,
  type FieldErrors,
  type Question,
  type QuestionFormValues,
  type QuestionType,
  type SourceSnapshot,
} from '@/lib/questions/form';
import { QUESTION_FAILURE_MESSAGES } from '@/lib/questions/problems';
import type { ChapterOption, DocumentOption } from '@/lib/questions/server';
import { newIdempotencyKey } from '@/lib/workspaces/idempotency';
import { chapterLabel } from './labels';
import styles from './question-bank.module.css';

export type EditorTarget =
  { readonly mode: 'create' } | { readonly mode: 'edit'; question: Question };

export interface QuestionEditorProps {
  readonly workspaceId: string;
  /** Null while closed. */
  readonly target: EditorTarget | null;
  /** Incremented by the opener on every opening. */
  readonly session: number;
  readonly onClose: () => void;
  readonly chapters: readonly ChapterOption[];
  readonly documents: readonly DocumentOption[];
  /** A save succeeded (also for a session that is no longer on screen). */
  readonly onSaved: (question: Question, mode: 'create' | 'edit') => void;
}

const NO_CHAPTER = '__none__';

/** What an edit is based on: the revision and the sources the form was loaded with. */
interface EditBase {
  readonly questionId: string;
  readonly baseRevisionId: string;
  readonly baseSources: SourceSnapshot;
}

export function QuestionEditor({
  workspaceId,
  target,
  session,
  onClose,
  chapters,
  documents,
  onSaved,
}: QuestionEditorProps) {
  const { toast } = useToast();
  const sessionRef = useRef(session);
  const openRef = useRef(target !== null);
  const pendingCreate = useRef<{ key: string; fingerprint: string } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const stemId = useId();

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    openRef.current = target !== null;
    if (target !== null) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  }, [target]);

  /** Runs one save for `forSession`; returns the result for the form when it is still current. */
  async function save(
    forSession: number,
    values: QuestionFormValues,
    edit: EditBase | null,
  ): Promise<ActionResult<Question>> {
    let result: ActionResult<Question>;
    if (edit) {
      result = await updateQuestionAction(
        workspaceId,
        edit.questionId,
        edit.baseRevisionId,
        values,
        edit.baseSources,
      );
    } else {
      const fingerprint = JSON.stringify(createBody(values));
      if (pendingCreate.current?.fingerprint !== fingerprint) {
        pendingCreate.current = { key: newIdempotencyKey(), fingerprint };
      }
      const sentKey = pendingCreate.current.key;
      result = await createQuestionAction(workspaceId, values, sentKey);
      const reusable = !result.ok && result.kind !== 'idempotencyKeyReused';
      if (!reusable && pendingCreate.current?.key === sentKey) pendingCreate.current = null;
    }
    const current = forSession === sessionRef.current && openRef.current;
    if (result.ok) {
      onSaved(result.data, edit ? 'edit' : 'create');
      toast({ tone: 'success', title: edit ? '문제를 수정했습니다.' : '문제를 등록했습니다.' });
      if (current) onClose();
    } else if (!current) {
      toast({ tone: 'error', title: result.message });
    }
    return result;
  }

  const title = target?.mode === 'edit' ? '문제 편집' : '문제 등록';
  return (
    <ModalDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={
        target?.mode === 'edit'
          ? '내용을 바꾸면 새 버전이 만들어지고, 이전 풀이 기록은 원래 버전을 그대로 가리킵니다.'
          : '저장하면 확정 문제로 문제은행에 등록됩니다.'
      }
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById(stemId)?.focus();
      }}
      onCloseAutoFocus={(event) => {
        const back = opener.current;
        if (!back?.isConnected) return;
        event.preventDefault();
        back.focus();
      }}
    >
      {target ? (
        <EditorForm
          key={session}
          workspaceId={workspaceId}
          target={target}
          stemId={stemId}
          chapters={chapters}
          documents={documents}
          save={(values, edit) => save(session, values, edit)}
        />
      ) : null}
    </ModalDialog>
  );
}

interface EditorFormProps {
  readonly workspaceId: string;
  readonly target: EditorTarget;
  readonly stemId: string;
  readonly chapters: readonly ChapterOption[];
  readonly documents: readonly DocumentOption[];
  readonly save: (
    values: QuestionFormValues,
    edit: EditBase | null,
  ) => Promise<ActionResult<Question>>;
}

function EditorForm({ workspaceId, target, stemId, chapters, documents, save }: EditorFormProps) {
  const editing = target.mode === 'edit' ? target.question : null;
  const [values, setValues] = useState<QuestionFormValues>(() =>
    editing ? formFromQuestion(editing) : emptyForm(),
  );
  const [baseRevisionId, setBaseRevisionId] = useState(editing?.revision.id ?? null);
  const [baseSources, setBaseSources] = useState(() => (editing ? sourceSnapshot(editing) : []));
  const [currentChapter, setCurrentChapter] = useState(editing?.chapter ?? null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<{ text: string; stale: boolean; attempt: number } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [reloading, setReloading] = useState(false);
  const attempts = useRef(0);

  function update(next: QuestionFormValues, clearKeys: readonly string[] = []) {
    setValues(next);
    if (clearKeys.some((key) => errors[key])) {
      setErrors((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([key]) => !clearKeys.includes(key))),
      );
    }
  }

  function showErrors(next: FieldErrors, text?: string) {
    attempts.current += 1;
    setErrors(next);
    const summary = errorSummary(next, values);
    setNotice({
      text: text ?? (summary.length > 0 ? summary.join(' ') : QUESTION_FAILURE_MESSAGES.invalid),
      stale: false,
      attempt: attempts.current,
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = validateQuestionForm(values);
    if (Object.keys(found).length > 0) {
      showErrors(found);
      return;
    }
    setPending(true);
    try {
      const result = await save(
        values,
        editing && baseRevisionId ? { questionId: editing.id, baseRevisionId, baseSources } : null,
      );
      if (result.ok) return;
      attempts.current += 1;
      if (result.kind === 'invalid' && result.fieldErrors) {
        showErrors(result.fieldErrors);
        return;
      }
      setErrors({});
      setNotice({
        text: result.message,
        stale: result.kind === 'staleRevision',
        attempt: attempts.current,
      });
    } finally {
      setPending(false);
    }
  }

  async function reloadLatest() {
    if (!editing) return;
    setReloading(true);
    try {
      const result = await getQuestionAction(workspaceId, editing.id);
      attempts.current += 1;
      if (!result.ok) {
        setNotice({ text: result.message, stale: false, attempt: attempts.current });
        return;
      }
      setValues(formFromQuestion(result.data));
      setBaseRevisionId(result.data.revision.id);
      setBaseSources(sourceSnapshot(result.data));
      setCurrentChapter(result.data.chapter);
      setErrors({});
      setNotice(null);
      document.getElementById(stemId)?.focus();
    } finally {
      setReloading(false);
    }
  }

  const isMcq = values.type === 'MCQ';
  const multiDocs = new Set(chapters.map((c) => c.documentId)).size > 1;
  const chapterOptions = [
    { value: NO_CHAPTER, label: '챕터 없음' },
    ...chapters.map((c) => ({ value: c.id, label: chapterLabel(c, multiDocs) })),
  ];
  if (values.chapterId && !chapters.some((c) => c.id === values.chapterId)) {
    chapterOptions.push({ value: values.chapterId, label: currentChapter?.title ?? '현재 챕터' });
  }
  const documentOptions = documents.map((d) => ({ value: d.id, label: d.title }));
  for (const s of values.sources) {
    if (s.documentId && !documents.some((d) => d.id === s.documentId)) {
      documentOptions.push({ value: s.documentId, label: '현재 출처 문서' });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className={styles.form} aria-busy={pending || undefined}>
      {notice ? (
        <FormNotice tone="danger" focusKey={notice.attempt}>
          <p>{notice.text}</p>
          {notice.stale ? (
            <div className={styles.noticeActions}>
              <p>최신 내용을 불러오면 지금 입력한 내용은 사라집니다.</p>
              <Button size="sm" onClick={reloadLatest} loading={reloading}>
                최신 내용 불러오기
              </Button>
            </div>
          ) : null}
        </FormNotice>
      ) : null}

      <RadioGroup
        label="문제 유형"
        options={QUESTION_TYPES.map((type) => ({ value: type, label: QUESTION_TYPE_LABELS[type] }))}
        value={values.type}
        onValueChange={(type) => update({ ...values, type: type as QuestionType })}
        disabled={editing !== null}
        {...(editing ? { description: '등록된 문제의 유형은 바꿀 수 없습니다.' } : {})}
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

      <Textarea
        label="해설"
        rows={3}
        value={values.explanation}
        onChange={(e) => update({ ...values, explanation: e.target.value }, ['explanation'])}
        error={errors.explanation}
      />

      <div className={styles.row}>
        <Select
          label="챕터"
          options={chapterOptions}
          value={values.chapterId || NO_CHAPTER}
          onValueChange={(value) =>
            update({ ...values, chapterId: value === NO_CHAPTER ? '' : value }, ['chapterId'])
          }
          error={errors.chapterId}
          {...(chapters.length === 0
            ? { description: '목차가 준비된 문서가 없으면 챕터 없이 등록됩니다.' }
            : {})}
        />
        <Input
          label="문제 번호"
          inputMode="numeric"
          autoComplete="off"
          value={values.questionNumber}
          onChange={(e) =>
            update({ ...values, questionNumber: e.target.value }, ['questionNumber'])
          }
          error={errors.questionNumber}
          description="선택 사항입니다. 예: 12"
        />
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>출처</legend>
        {values.sources.map((source, index) => {
          const n = index + 1;
          return (
            <div key={source.key} className={styles.sourceRow}>
              <Select
                label={`출처 ${n} 문서`}
                options={documentOptions}
                value={source.documentId}
                placeholder="문서 선택"
                onValueChange={(documentId) =>
                  update(updateSource(values, source.key, { documentId }), [sourceKey(source.key)])
                }
                error={errors[sourceKey(source.key)]}
              />
              <Input
                label={`출처 ${n} 시작 쪽`}
                inputMode="numeric"
                autoComplete="off"
                value={source.pageStart}
                onChange={(e) =>
                  update(updateSource(values, source.key, { pageStart: e.target.value }), [
                    sourceKey(source.key),
                  ])
                }
              />
              <Input
                label={`출처 ${n} 끝 쪽`}
                inputMode="numeric"
                autoComplete="off"
                value={source.pageEnd}
                onChange={(e) =>
                  update(updateSource(values, source.key, { pageEnd: e.target.value }), [
                    sourceKey(source.key),
                  ])
                }
              />
              <IconButton
                label={`출처 ${n} 삭제`}
                icon={<CloseIcon width={16} height={16} />}
                onClick={() => update(removeSource(values, source.key), [sourceKey(source.key)])}
              />
            </div>
          );
        })}
        <FieldMessage>{errors.sources}</FieldMessage>
        <div>
          <Button
            onClick={() => update(addSource(values, documents[0]?.id ?? ''), ['sources'])}
            disabled={documents.length === 0}
          >
            출처 추가
          </Button>
        </div>
        {documents.length === 0 ? (
          <p className="qz-field__description">
            준비 완료된 문서가 있으면 출처로 연결할 수 있습니다.
          </p>
        ) : null}
      </fieldset>

      <FieldMessage>{errors[FORM_KEY]}</FieldMessage>
      <div className={styles.formActions}>
        <DialogClose asChild>
          <Button disabled={pending}>취소</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={pending}>
          저장
        </Button>
      </div>
    </form>
  );
}

function FieldMessage({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className={styles.fieldError}>
      <AlertIcon width={16} height={16} />
      <span>{children}</span>
    </p>
  );
}
