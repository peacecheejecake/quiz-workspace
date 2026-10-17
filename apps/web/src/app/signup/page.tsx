import Link from 'next/link';
import { AuthLayout } from '@/components/auth/auth-layout';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { stubMetadata } from '@/components/stub-screen';

export const metadata = stubMetadata('AUTH-02');

export default function Page() {
  return (
    <AuthLayout
      screenId="AUTH-02"
      title="회원가입"
      description="이메일로 계정을 만든 뒤, 받은 인증 메일의 링크를 열면 가입이 완료됩니다."
      footer={
        <>
          <span>
            계정이 있으신가요? <Link href="/login">로그인</Link>
          </span>
        </>
      }
    >
      <SignUpForm />
    </AuthLayout>
  );
}
