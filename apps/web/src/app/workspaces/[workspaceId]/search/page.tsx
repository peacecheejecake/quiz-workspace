// Pre-UX3c SEARCH-01 route: the 본문 search lives on the workspace home now. Redirects to the same
// search there (its query as `text`, its chapter filter as `section`; UX7-SEARCH).
import { redirect } from 'next/navigation';
import { legacySearchRedirect } from '@/lib/workspaces/home';

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  redirect(legacySearchRedirect(workspaceId, query));
}
