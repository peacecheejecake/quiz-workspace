// Pre-UX3c QOV-01 route: the heatmap is the workspace home now. Redirects with the same query
// (filters, `?question=`), so old links and deep links keep working. Access is checked by the
// workspace layout (and again by the home).
import { redirect } from 'next/navigation';
import { legacyQuestionsRedirect } from '@/lib/workspaces/home';

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  redirect(legacyQuestionsRedirect(workspaceId, query));
}
