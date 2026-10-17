import { SignOutButton } from '@/components/app-shell/user-menu';
import { StubScreen, stubMetadata } from '@/components/stub-screen';

export const metadata = stubMetadata('ACCOUNT-01');

// ACCOUNT-01 is built in A2.3; A2.1 only provides the sign-out control (AUTH-01-AC04).
export default function Page() {
  return (
    <>
      <StubScreen screenId="ACCOUNT-01" />
      <SignOutButton />
    </>
  );
}
