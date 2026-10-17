import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { SignInForm } from '@/components/auth/sign-in-form';
import { stubMetadata } from '@/components/stub-screen';
import { safeNextPath } from '@/lib/auth/safe-next';

export const metadata = stubMetadata('AUTH-01');

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ searchParams }: LoginPageProps) {
  const raw = (await searchParams).next;
  // Only a validated internal path is carried into the form (the action re-validates it).
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw, '') || undefined;

  return (
    <AuthCard
      screenId="AUTH-01"
      title="로그인"
      description="이메일과 비밀번호로 Quiz Workspace에 로그인하세요."
      footer={
        <>
          <Link href="/signup">계정 만들기</Link>
          <Link href="/forgot-password">비밀번호를 잊으셨나요?</Link>
        </>
      }
    >
      <SignInForm next={next} />
    </AuthCard>
  );
}
