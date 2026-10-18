'use client';

// `PasswordResetForm` (AUTH-06): new password + confirmation, only rendered for a recovery session
// (`allowed` is decided on the server, and the server action re-checks it). A confirmation
// mismatch or policy violation is caught here without any request (AUTH-06-AC03). The whole screen
// lives in this client component so the success state survives the route refresh that follows
// the action's cookie change (the refreshed page no longer has a recovery session).
import { Button, Input } from '@quiz/ui';
import Link from 'next/link';
import { useActionState, useEffect, type FormEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { updatePasswordAction, type ResetPasswordState } from '@/lib/auth/reset-actions';
import { hasErrors, PASSWORD_HINT, validatePasswordReset } from '@/lib/auth/validation';
import type { ScreenId } from '@/screens';
import styles from './auth-form.module.css';
import { AuthLayout } from './auth-layout';
import { FormNotice } from './form-notice';
import { useFormErrors } from './use-form-errors';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" loading={pending} className={styles.submit}>
      비밀번호 변경
    </Button>
  );
}

/** No (or no longer a) recovery session: no form, only the way to a new link (AUTH-06-AC02). */
function NewLinkOffer({ screenId }: { screenId: ScreenId }) {
  return (
    <AuthLayout
      screenId={screenId}
      title="재설정 링크를 사용할 수 없습니다"
      description="비밀번호 재설정 링크가 만료되었거나, 이미 사용되었거나, 올바르지 않습니다. 새 링크를 받아 다시 시도해 주세요."
    >
      <ul className={styles.actions}>
        <li>
          <Link href="/forgot-password" className="qz-button qz-focus-ring" data-variant="primary">
            재설정 링크 새로 요청하기
          </Link>
        </li>
        <li>
          <Link href="/login" className="qz-button qz-focus-ring" data-variant="secondary">
            로그인으로 돌아가기
          </Link>
        </li>
      </ul>
    </AuthLayout>
  );
}

export interface PasswordResetScreenProps {
  screenId: ScreenId;
  /** Server-side gate result (lib/auth/recovery-session.ts). */
  allowed: boolean;
}

export function PasswordResetScreen({ screenId, allowed }: PasswordResetScreenProps) {
  const [state, formAction] = useActionState<ResetPasswordState, FormData>(updatePasswordAction, {
    status: 'idle',
  });
  const { formRef, errors, show, clear } = useFormErrors<'password' | 'confirm'>();

  // Server-side field errors (policy / same password) go through the same focus handling.
  useEffect(() => {
    if (state.fieldErrors) show(state.fieldErrors);
  }, [state, show]);

  if (state.status === 'done') {
    return (
      <AuthLayout screenId={screenId} title="비밀번호 재설정 완료">
        <FormNotice tone="success" focusKey={state}>
          <p>비밀번호가 변경되었습니다. 이제 새 비밀번호로 로그인할 수 있습니다.</p>
        </FormNotice>
        <ul className={styles.actions}>
          <li>
            <Link href="/workspaces" className="qz-button qz-focus-ring" data-variant="primary">
              Workspace로 이동
            </Link>
          </li>
        </ul>
      </AuthLayout>
    );
  }
  if (!allowed || state.status === 'expired') return <NewLinkOffer screenId={screenId} />;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const found = validatePasswordReset({
      password: String(data.get('password') ?? ''),
      confirm: String(data.get('confirm') ?? ''),
    });
    show(found);
    if (hasErrors(found)) event.preventDefault();
  }

  return (
    <AuthLayout
      screenId={screenId}
      title="새 비밀번호 설정"
      description="앞으로 로그인할 때 사용할 새 비밀번호를 입력하세요."
    >
      <form
        ref={formRef}
        action={formAction}
        onSubmit={onSubmit}
        noValidate
        className={styles.form}
      >
        {state.error ? (
          <FormNotice tone="danger" focusKey={state}>
            <p>{state.error}</p>
          </FormNotice>
        ) : null}
        <Input
          label="새 비밀번호"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          description={PASSWORD_HINT}
          error={errors.password}
          onChange={() => clear('password')}
        />
        <Input
          label="새 비밀번호 확인"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          error={errors.confirm}
          onChange={() => clear('confirm')}
        />
        <SubmitButton />
      </form>
    </AuthLayout>
  );
}
