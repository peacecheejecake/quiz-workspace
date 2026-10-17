'use client';

// ACCOUNT-01 `/settings/security`: the signed-in email, a password change form and sign-out.
// Rendered inside the AppShell, which owns the page's <main>. The email comes from the verified
// JWT claims (page.tsx). Validation mirrors AUTH-06: mismatches and policy violations are caught
// before any request, and the server action re-validates.
import { Button, Input, PageHeader, Surface } from '@quiz/ui';
import { useActionState, useEffect, type FormEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { SignOutButton } from '@/components/app-shell/user-menu';
import { FormNotice } from '@/components/auth/form-notice';
import { useFormErrors } from '@/components/auth/use-form-errors';
import {
  changePasswordAction,
  reauthenticateAction,
  type ChangePasswordState,
} from '@/lib/auth/account-actions';
import { hasErrors, PASSWORD_HINT, validatePasswordReset } from '@/lib/auth/validation';
import type { ScreenId } from '@/screens';
import styles from './account-security.module.css';

function ChangePasswordButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" loading={pending}>
      비밀번호 변경
    </Button>
  );
}

function ReauthenticateButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" loading={pending}>
      다시 로그인
    </Button>
  );
}

export interface AccountSecurityScreenProps {
  screenId: ScreenId;
  /** Verified JWT `email` claim. */
  email: string | undefined;
}

export function AccountSecurityScreen({ screenId, email }: AccountSecurityScreenProps) {
  const [state, formAction] = useActionState<ChangePasswordState, FormData>(changePasswordAction, {
    status: 'idle',
  });
  const { formRef, errors, show, clear } = useFormErrors<'password' | 'confirm'>();

  useEffect(() => {
    if (state.fieldErrors) show(state.fieldErrors);
    // Never keep a password in the DOM after the change went through.
    if (state.status === 'done') formRef.current?.reset();
  }, [state, show, formRef]);

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
    <div className={styles.page} data-screen-id={screenId}>
      <PageHeader title="계정 보안" description="로그인 정보와 비밀번호, 세션을 관리합니다." />

      <Surface asChild padding="lg">
        <section aria-labelledby="account-email-title" className={styles.section}>
          <h2 id="account-email-title" className={styles.sectionTitle}>
            계정 정보
          </h2>
          <dl className={styles.facts}>
            <dt>이메일</dt>
            <dd className={styles.email}>{email ?? '이메일 정보를 불러올 수 없습니다.'}</dd>
          </dl>
        </section>
      </Surface>

      <Surface asChild padding="lg">
        <section aria-labelledby="account-password-title" className={styles.section}>
          <h2 id="account-password-title" className={styles.sectionTitle}>
            비밀번호
          </h2>
          <p className={styles.text}>
            비밀번호를 바꾸면 다른 기기의 로그인은 종료되고, 이 브라우저는 로그인 상태를 유지합니다.
          </p>
          {state.status === 'done' ? (
            <FormNotice tone="success" focusKey={state}>
              <p>비밀번호가 변경되었습니다. 다음 로그인부터 새 비밀번호를 사용하세요.</p>
            </FormNotice>
          ) : null}
          {state.status === 'reauthenticate' ? (
            <FormNotice tone="danger" focusKey={state}>
              <p>{state.error}</p>
              <form action={reauthenticateAction}>
                <ReauthenticateButton />
              </form>
            </FormNotice>
          ) : null}
          {state.status === 'error' && state.error ? (
            <FormNotice tone="danger" focusKey={state}>
              <p>{state.error}</p>
            </FormNotice>
          ) : null}
          <form
            ref={formRef}
            action={formAction}
            onSubmit={onSubmit}
            noValidate
            className={styles.form}
          >
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
            <div className={styles.actions}>
              <ChangePasswordButton />
            </div>
          </form>
        </section>
      </Surface>

      <Surface asChild padding="lg">
        <section aria-labelledby="account-session-title" className={styles.section}>
          <h2 id="account-session-title" className={styles.sectionTitle}>
            세션
          </h2>
          <p className={styles.text}>이 브라우저에서 로그아웃합니다.</p>
          <div className={styles.actions}>
            <SignOutButton />
          </div>
        </section>
      </Surface>
    </div>
  );
}
