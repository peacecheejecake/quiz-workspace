'use client';

// Draft editor of QuestionDraftReview ("문제 편집"): the same content fields as the QBANK-01
// question editor, applied to a draft on top of the version the reviewer opened. Saving changes
// only the draft; an approved draft goes back to "검토 대기" and has to be approved again, and a
// draft whose source had no answer can be saved without one (it just cannot be approved yet).
import { Button, DialogClose, Input, ModalDialog } from '@quiz/ui';
import { useId, useRef, useState, type FormEvent } from 'react';
import { FormNotice } from '@/components/auth/form-notice';
import {
  draftNumber,
  formFromDraft,
  validateDraftForm,
  type ReviewDraft,
} from '@/lib/questions/drafts';
import { errorSummary, type FieldErrors, type QuestionFormValues } from '@/lib/questions/form';
import { FieldMessage, QuestionContentFields } from '../question-content-fields';
import styles from '../question-bank.module.css';

export type DraftSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly stale?: boolean };

export interface DraftEditorProps {
  /** Null while closed. */
  readonly draft: ReviewDraft | null;
  /** Incremented by the opener on every opening (resets the form). */
  readonly session: number;
  readonly onClose: () => void;
  readonly save: (values: QuestionFormValues, baseVersion: string) => Promise<DraftSaveResult>;
  /** The draft as the server has it now (after a stale-draft conflict); null if unavailable. */
  readonly reload: (draftId: string) => Promise<ReviewDraft | null>;
}

export function DraftEditor({ draft, session, onClose, save, reload }: DraftEditorProps) {
  const stemId = useId();
  const opener = useRef<HTMLElement | null>(null);
  return (
    <ModalDialog
      open={draft !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="문제 편집"
      description={
        draft
          ? `${draftNumber(draft)}번 초안을 고칩니다. 저장하면 승인이 풀리고, 다시 승인한 초안만 문제은행에 등록됩니다.`
          : undefined
      }
      onOpenAutoFocus={(event) => {
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      {draft ? (
        <DraftForm
          key={`${session}-${draft.id}`}
          draft={draft}
          stemId={stemId}
          save={save}
          reload={reload}
          onSaved={onClose}
        />
      ) : null}
    </ModalDialog>
  );
}

interface DraftFormProps {
  readonly draft: ReviewDraft;
  readonly stemId: string;
  readonly save: DraftEditorProps['save'];
  readonly reload: DraftEditorProps['reload'];
  readonly onSaved: () => void;
}

function DraftForm({ draft, stemId, save, reload, onSaved }: DraftFormProps) {
  const [values, setValues] = useState<QuestionFormValues>(() => formFromDraft(draft));
  const [baseVersion, setBaseVersion] = useState(draft.version);
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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = validateDraftForm(values);
    attempts.current += 1;
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setNotice({
        text: errorSummary(found, values).join(' '),
        stale: false,
        attempt: attempts.current,
      });
      return;
    }
    setPending(true);
    try {
      const result = await save(values, baseVersion);
      if (result.ok) {
        onSaved();
        return;
      }
      setErrors({});
      setNotice({ text: result.message, stale: result.stale ?? false, attempt: attempts.current });
    } finally {
      setPending(false);
    }
  }

  async function reloadLatest() {
    setReloading(true);
    try {
      const latest = await reload(draft.id);
      attempts.current += 1;
      if (!latest) {
        setNotice({
          text: '최신 초안을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
          stale: true,
          attempt: attempts.current,
        });
        return;
      }
      setValues(formFromDraft(latest));
      setBaseVersion(latest.version);
      setErrors({});
      setNotice(null);
      document.getElementById(stemId)?.focus();
    } finally {
      setReloading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className={styles.form} aria-busy={pending || undefined}>
      {notice ? (
        <FormNotice tone="danger" focusKey={notice.attempt}>
          <p>{notice.text}</p>
          {notice.stale ? (
            <div className={styles.noticeActions}>
              <p>최신 초안을 불러오면 지금 입력한 내용은 사라집니다.</p>
              <Button size="sm" onClick={reloadLatest} loading={reloading}>
                최신 초안 불러오기
              </Button>
            </div>
          ) : null}
        </FormNotice>
      ) : null}

      <QuestionContentFields
        values={values}
        errors={errors}
        update={update}
        stemId={stemId}
        answerHint="원본에 정답이 없으면 비워 둘 수 있습니다. 다만 객관식은 정답 보기를 지정해야 승인할 수 있습니다."
      />

      <Input
        label="문제 번호"
        inputMode="numeric"
        autoComplete="off"
        value={values.questionNumber}
        onChange={(e) => update({ ...values, questionNumber: e.target.value }, ['questionNumber'])}
        error={errors.questionNumber}
        description="원본에 인쇄된 번호입니다. 예: 12"
      />

      <FieldMessage>{errors.form}</FieldMessage>
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
