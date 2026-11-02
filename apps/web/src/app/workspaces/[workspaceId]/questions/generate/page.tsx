// Retired QGEN-01 변형 출제 review and batch pages (QGEN-RM, docs/screens/questions-generation.md):
// old links and bookmarks (`?source=&run=`, `?batch=`) land on the workspace home with the 모의고사
// dialog that replaced them. Access is checked by the workspace layout (and again by the home).
import { redirect } from 'next/navigation';
import { legacyGenerateRedirect } from '@/lib/workspaces/home';

export default async function Page({
  params,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
}>) {
  const { workspaceId } = await params;
  redirect(legacyGenerateRedirect(workspaceId));
}
