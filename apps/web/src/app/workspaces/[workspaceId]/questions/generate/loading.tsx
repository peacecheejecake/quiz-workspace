// QOV-01-AC09 (UX3c): 문제 변형 출제 skeleton while the source and its runs load.
import { SubPageSkeleton } from '@/components/workspaces/route-skeletons';

export default function Loading() {
  return <SubPageSkeleton label="문제 변형 출제를 불러오는 중입니다." />;
}
