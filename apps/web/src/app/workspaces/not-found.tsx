import { ReleaseWorkspaceTarget } from '@/components/practice-return/practice-return-provider';
import NotFound from '../not-found';

export { metadata } from '../not-found';

// A thrown `notFound()` below /workspaces (the workspace layout's access check, or a page): the
// same page as everywhere, plus the release of the return target of that workspace.
export default function WorkspaceNotFound() {
  return (
    <>
      <ReleaseWorkspaceTarget />
      <NotFound />
    </>
  );
}
