'use client';

// Account menu in the app shell header: the trigger is the signed-in email; the theme control, links
// to the settings and help pages, and the sign-out action (server-side signOut; the refresh token
// is revoked at the Auth server).
import {
  AccountIcon,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  useTheme,
  type ThemePreference,
} from '@quiz/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { signOutAction } from '@/lib/auth/actions';
import styles from './user-menu.module.css';

export function SignOutButton({
  variant = 'secondary',
  borderless = false,
}: {
  variant?: 'primary' | 'secondary' | 'ghost';
  borderless?: boolean;
}) {
  return (
    <form action={signOutAction}>
      <SignOutSubmit variant={variant} borderless={borderless} />
    </form>
  );
}

function SignOutSubmit({
  variant,
  borderless,
}: {
  variant: 'primary' | 'secondary' | 'ghost';
  borderless: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} borderless={borderless} loading={pending}>
      로그아웃
    </Button>
  );
}

const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '시스템' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
];

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  return (
    <RadioGroup
      label="화면 테마"
      options={THEME_OPTIONS}
      value={theme}
      onValueChange={(value) => setTheme(value as ThemePreference)}
    />
  );
}

// The trigger shows the signed-in email in full where the header has room; below 768px it is a
// compact account icon button (the email stays in its accessible name "계정 <email>" and title).
// The menu always shows the full email, wrapped instead of truncated.
export function UserMenu({ email }: { email: string | undefined }) {
  const [open, setOpen] = useState(false);
  // The header survives moves inside one layout, so a link has to close the menu itself.
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          borderless
          size="sm"
          className={styles.trigger}
          aria-label={email ? `계정 ${email}` : '계정'}
          {...(email ? { title: email } : {})}
        >
          <span className={styles.triggerIcon} aria-hidden="true">
            <AccountIcon />
          </span>
          <span className={styles.triggerLabel}>{email ?? '계정'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="계정 메뉴" align="end" className={styles.content}>
        {email ? <p className={styles.email}>{email}</p> : null}
        <ThemeControl />
        <Link
          href="/settings/preferences"
          className="qz-button qz-focus-ring"
          data-variant="ghost"
          data-borderless
          onClick={close}
        >
          설정
        </Link>
        <Link
          href="/settings/security"
          className="qz-button qz-focus-ring"
          data-variant="ghost"
          data-borderless
          onClick={close}
        >
          계정 보안 설정
        </Link>
        <Link
          href="/help"
          className="qz-button qz-focus-ring"
          data-variant="ghost"
          data-borderless
          onClick={close}
        >
          도움말
        </Link>
        <SignOutButton variant="ghost" borderless />
      </PopoverContent>
    </Popover>
  );
}
