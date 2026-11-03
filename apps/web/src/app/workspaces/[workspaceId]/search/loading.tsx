// QOV-01-AC09 (SEARCH-02, UX9): the 본문 search page's skeleton while the server reads its
// documents. The workspace layout above it still answers an unknown workspace with HTTP 404.
import { SubPageSkeleton } from '@/components/workspaces/route-skeletons';

export default function Loading() {
  return <SubPageSkeleton label="본문 검색을 불러오는 중입니다." />;
}
