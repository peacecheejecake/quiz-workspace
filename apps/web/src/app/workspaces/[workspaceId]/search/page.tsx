// Pre-UX3c SEARCH-01 route: the content search is part of the workspace home's unified search now.
// Redirects to the same search there (`scope=content`, its chapter filter as `section`).
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
