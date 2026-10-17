import { redirect } from 'next/navigation';
import { AccountSecurityScreen } from '@/components/account/account-security-screen';
import { stubMetadata } from '@/components/stub-screen';
import { ACCOUNT_SECURITY_PATH, loginRedirectPath } from '@/lib/auth/routes';
import { getVerifiedUser } from '@/lib/supabase/server';

export const metadata = stubMetadata('ACCOUNT-01');
export const dynamic = 'force-dynamic';

// ACCOUNT-01. The email shown is the verified JWT `email` claim (getClaims), never the cookie's
// unverified session user.
export default async function Page() {
  const user = await getVerifiedUser();
  if (!user) redirect(loginRedirectPath(ACCOUNT_SECURITY_PATH));
  return <AccountSecurityScreen screenId="ACCOUNT-01" email={user.email} />;
}
