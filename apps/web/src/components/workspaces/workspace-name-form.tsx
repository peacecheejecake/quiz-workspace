'use client';

// Name form shared by the create and rename dialogs: client-side validation identical to the
// API's, server action submit, field/form errors (FormNotice, role="alert") and a busy submit.
import { Button, DialogClose, Input } from '@quiz/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { FormNotice } from '@/components/auth/form-notice';
import { useFormErrors } from '@/components/auth/use-form-errors';
import { validateWorkspaceName } from '@/lib/workspaces/validation';
import type { NameSubmit } from './use-name-submit';
import styles from './workspaces.module.css';

export interface WorkspaceNameFormProps {
  /** Submission state owned by a component that outlives this form (see use-name-submit.ts). */
  submission: NameSubmit;
  submitLabel: string;
  initialName?: string;
  /** Extra form fields (e.g. the workspace id), set right before the action runs. */
  prepare?: (formData: FormData, name: string) => void;
  /** Id for the name input, so the dialog can focus it on open. */
  inputId: string;
}

export function WorkspaceNameForm({
  submission,
  submitLabel,
  initialName = '',
  prepare,
  inputId,
}: WorkspaceNameFormProps) {
  const { state, pending, submit } = submission;
  const { formRef, errors, show, clear } = useFormErrors<'name'>();
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (state.fieldErrors) show(state.fieldErrors);
  }, [state, show]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    const checked = validateWorkspaceName(formData.get('name'));
    if (!checked.ok) {
      show({ name: checked.error });
      return;
    }
    show({});
    prepare?.(formData, checked.name);
    submit(formData);
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className={styles.form}>
      {state.status === 'error' && state.error ? (
        <FormNotice tone="danger" focusKey={state.attempt}>
          <p>{state.error}</p>
        </FormNotice>
      ) : null}
      <Input
        id={inputId}
        label="Workspace 이름"
        name="name"
        autoComplete="off"
        required
        description="1–200자, 줄바꿈 없이 입력합니다."
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          clear('name');
        }}
        error={errors.name}
      />
      <div className={styles.formActions}>
        <DialogClose asChild>
          <Button disabled={pending}>취소</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
