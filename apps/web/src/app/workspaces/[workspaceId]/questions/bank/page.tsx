// Retired QBANK-01 전체 문제 route (UX7-BANK, docs/screens/questions-bank.md): old links and
// bookmarks land on the workspace home, keeping only `?question=` (the practice panel). Access is
// checked by the workspace layout (and again by the home).
import { redirect } from 'next/navigation';
import { legacyBankRedirect } from '@/lib/workspaces/home';

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  redirect(legacyBankRedirect(workspaceId, query));
}
