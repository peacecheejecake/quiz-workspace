import { cookies } from 'next/headers';
import Link from 'next/link';
import { AuthLayout } from '@/components/auth/auth-layout';
import styles from '@/components/auth/auth-form.module.css';
import { VerificationNotice } from '@/components/auth/verification-notice';
import { stubMetadata } from '@/components/stub-screen';
import { parsePendingEmail, PENDING_EMAIL_COOKIE } from '@/lib/auth/pending-email';

export const metadata = stubMetadata('AUTH-03');
export const dynamic = 'force-dynamic';

// `VerificationNotice` (AUTH-03): confirmation pending. Protected routes stay closed until the
// mailed link is opened (no session exists before that), so this screen only explains what to do
// next: open the mail, resend it, or start over with a different address.
export default async function Page() {
  const email = parsePendingEmail((await cookies()).get(PENDING_EMAIL_COOKIE)?.value);

  return (
    <AuthLayout
      screenId="AUTH-03"
      title="이메일을 확인해 주세요"
      footer={
        <>
          <Link href="/login">로그인으로 돌아가기</Link>
          <Link href="/signup">다른 이메일로 가입하기</Link>
        </>
      }
    >
      <VerificationNotice email={email} />
      <p className={styles.fine}>
        메일이 보이지 않으면 스팸함을 확인해 주세요. 이메일 주소를 잘못 입력했다면 &lsquo;다른
        이메일로 가입하기&rsquo;에서 올바른 주소로 다시 가입해 주세요.
      </p>
    </AuthLayout>
  );
}
