// QOV-01-AC09 (UX3c): 문제은행 skeleton while the bank loads.
import { SubPageSkeleton } from '@/components/workspaces/route-skeletons';

export default function Loading() {
  return <SubPageSkeleton label="문제은행을 불러오는 중입니다." />;
}
