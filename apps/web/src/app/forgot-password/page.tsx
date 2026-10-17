import Link from 'next/link';
import { AuthLayout } from '@/components/auth/auth-layout';
import { PasswordResetRequestForm } from '@/components/auth/password-reset-request-form';
import { stubMetadata } from '@/components/stub-screen';

export const metadata = stubMetadata('AUTH-05');

export default function Page() {
  return (
    <AuthLayout
      screenId="AUTH-05"
      title="비밀번호 재설정"
      description="가입한 이메일 주소를 입력하면 새 비밀번호를 설정할 수 있는 링크를 보내 드립니다."
      footer={
        <>
          <Link href="/login">로그인으로 돌아가기</Link>
          <Link href="/signup">계정 만들기</Link>
        </>
      }
    >
      <PasswordResetRequestForm />
    </AuthLayout>
  );
}
