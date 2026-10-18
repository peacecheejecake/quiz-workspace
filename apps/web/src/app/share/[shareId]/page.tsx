// WS-VIEW-01 공유 Workspace 조회 (docs/screens/workspace-shared-view.md). Public route: the guest
// has no account session. Everything shared is read in the browser through the same-origin relay
// (`/api/shared/{id}/…`), because the share session cookie is HttpOnly and scoped to that relay
// path, so this server component cannot (and must not) read it. It only decides whether the
// viewer is signed in (where the Fork entry leads) and passes the address-bar state.
// `?panel=fork` (WS-FORK-01) opens `ForkWorkspaceDialog` for signed-in viewers of a Fork-ON link.
import type { Metadata } from 'next';
import { SharedWorkspaceView } from '@/components/shared/shared-workspace-view';
import { loginRedirectPath } from '@/lib/auth/routes';
import { isShareId } from '@/lib/shared/client';
import { parseSharedViewParams } from '@/lib/shared/view-state';
import { getVerifiedUser } from '@/lib/supabase/server';
import { getScreen } from '@/screens';

export const metadata: Metadata = {
  title: getScreen('WS-VIEW-01').name,
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default async function Page({ params, searchParams }: PageProps<'/share/[shareId]'>) {
  const { shareId } = await params;
  const view = parseSharedViewParams(await searchParams);
  const valid = isShareId(shareId);
  const signedIn = valid ? (await getVerifiedUser()) !== null : false;

  return (
    <SharedWorkspaceView
      key={shareId}
      screenId="WS-VIEW-01"
      forkScreenId="WS-FORK-01"
      shareId={valid ? shareId : null}
      view={view}
      signedIn={signedIn}
      forkLoginHref={valid ? loginRedirectPath(`/share/${shareId}?panel=fork`) : '/login'}
    />
  );
}
