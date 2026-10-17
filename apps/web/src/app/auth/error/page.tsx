import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { stubMetadata } from '@/components/stub-screen';
import {
  parseAuthErrorFlow,
  parseAuthErrorReason,
  type AuthErrorFlow,
  type AuthErrorReason,
} from '@/lib/auth/callback';
import styles from './page.module.css';

export const metadata = stubMetadata('AUTH-07');

type SearchParams = Record<string, string | string[] | undefined>;

interface ErrorPageProps {
  searchParams: Promise<SearchParams>;
}

const COPY: Record<AuthErrorReason | 'unknown', { title: string; body: string }> = {
  expired: {
    title: '링크가 만료되었습니다',
    body: '인증 링크가 만료되었거나 유효하지 않습니다. 새 링크를 요청하거나 다시 로그인해 주세요.',
  },
  invalid: {
    title: '유효하지 않은 링크입니다',
    body: '링크가 유효하지 않거나 이미 사용되었습니다. 새 링크를 요청하거나 다시 로그인해 주세요.',
  },
  missing: {
    title: '잘못된 링크입니다',
    body: '인증 정보가 없는 잘못된 링크입니다. 메일의 링크를 다시 열거나 로그인해 주세요.',
  },
  unavailable: {
    title: '인증을 처리하지 못했습니다',
    body: '네트워크 또는 서버 문제로 인증을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  },
  unknown: {
    title: '인증 오류가 발생했습니다',
    body: '링크가 만료되었거나 유효하지 않습니다. 다시 로그인하거나 새 링크를 요청해 주세요.',
  },
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Retry path for the failed flow; every target is a fixed internal route (AUTH-07-AC02). */
function retryLink(flow: AuthErrorFlow | undefined): { href: string; label: string } {
  if (flow === 'recovery') return { href: '/forgot-password', label: '재설정 링크 새로 요청하기' };
  return { href: '/auth/verify', label: '인증 메일 다시 보내기' };
}

export default async function Page({ searchParams }: ErrorPageProps) {
  const params = await searchParams;
  // `reason` from /auth/callback; `error` tolerated for provider-style redirects. Any `next` /
  // `returnUrl` is ignored on purpose: this screen only links to fixed internal routes.
  const reason = parseAuthErrorReason(first(params.reason) ?? first(params.error));
  const flow = parseAuthErrorFlow(first(params.flow));
  const copy = COPY[reason ?? 'unknown'];
  const retry = retryLink(flow);

  return (
    <AuthCard screenId="AUTH-07" title={copy.title}>
      <p className={styles.body}>{copy.body}</p>
      <ul className={styles.actions}>
        <li>
          <Link href="/login" className="qz-button qz-focus-ring" data-variant="primary">
            로그인으로 돌아가기
          </Link>
        </li>
        {reason === 'unavailable' ? null : (
          <li>
            <Link href={retry.href} className="qz-button qz-focus-ring" data-variant="secondary">
              {retry.label}
            </Link>
          </li>
        )}
      </ul>
    </AuthCard>
  );
}
