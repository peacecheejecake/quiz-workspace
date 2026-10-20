// QOV-01-AC09 (UX3c): the workspace home's skeleton, shown at once on navigation while the server
// reads the heatmap and documents. Inside the `(home)` route group so no Suspense boundary sits
// above the other workspace pages (DOC-02 still answers an unknown document with HTTP 404).
import { HomeSkeleton } from '@/components/workspaces/route-skeletons';

export default function Loading() {
  return <HomeSkeleton />;
}
