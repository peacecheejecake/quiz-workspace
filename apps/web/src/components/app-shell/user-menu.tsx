'use client';

// Account menu in the app shell header: signed-in email, link to the security settings and the
// sign-out action (server-side signOut; the refresh token is revoked at the Auth server).
import { Button, Popover, PopoverContent, PopoverTrigger } from '@quiz/ui';
import Link from 'next/link';
import { useFormStatus } from 'react-dom';
import { signOutAction } from '@/lib/auth/actions';
import styles from './user-menu.module.css';

export function SignOutButton({
  variant = 'secondary',
}: {
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  return (
    <form action={signOutAction}>
      <SignOutSubmit variant={variant} />
    </form>
  );
}

function SignOutSubmit({ variant }: { variant: 'primary' | 'secondary' | 'ghost' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} loading={pending}>
      로그아웃
    </Button>
  );
}

export function UserMenu({ email }: { email: string | undefined }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={styles.trigger}>
          계정
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="계정 메뉴" align="end" className={styles.content}>
        {email ? <p className={styles.email}>{email}</p> : null}
        <Link href="/settings/security" className="qz-button qz-focus-ring" data-variant="ghost">
          계정 보안 설정
        </Link>
        <SignOutButton variant="ghost" />
      </PopoverContent>
    </Popover>
  );
}
